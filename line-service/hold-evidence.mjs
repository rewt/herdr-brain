// Read-only observations for the existing finite turn. Never creates a HOLD,
// changes a ref, watches a file or grants cleanup authority.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {loadEvents} from '../lib/store.mjs';

export const evidenceHash=value=>createHash('sha256').update(value).digest('hex');
const recordHash=events=>evidenceHash(JSON.stringify(events));
const stat=s=>Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs'].map(k=>[k,String(s[k])]));
function plain(file){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const before=fs.fstatSync(fd,{bigint:true});
    if(!before.isFile()||before.size>64n*1024n*1024n||fs.realpathSync(file)!==file)throw Error('evidence file is redirected, oversized or nonregular');
    const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd,{bigint:true});
    if(JSON.stringify(stat(before))!==JSON.stringify(stat(after)))throw Error('evidence changed while reading');
    return{file,...stat(after),sha256:evidenceHash(bytes),text:bytes.toString('utf8')};
  }finally{fs.closeSync(fd);}
}
function snapshot({project,org,env=process.env,now=()=>Date.now(),command=spawnSync},before){
  const result={errors:[]};
  // Record fences enclose the filesystem observations, conservatively including
  // concurrent events. A transaction's wall clock never determines coverage.
  const record=()=>{
    const loaded=loadEvents(org),events=loaded.events;
    if(loaded.tornTail||events.some((e,i)=>e.seq!==i+1))throw Error('incomplete record fence');
    return{seq:events.at(-1)?.seq??0,sha256:recordHash(events),
      ...(before?{prefix_sha256:recordHash(events.filter(e=>e.seq<=before.record?.seq))}:{})};
  };
  if(before)result.at=new Date(now()).toISOString();
  if(!before)try{result.record=record();}catch(e){result.errors.push(e.message);}
  try{result.hold=plain(path.join(project.canonical,'.lane/supervisor/HOLD'));}
  catch(e){result.errors.push(`HOLD: ${e.code??e.message}`);}
  // With no written HOLD there is no prospective HOLD proof to collect.
  if(result.hold)try{
    const git=args=>{
      const r=command('git',['--git-dir',project.identity,...args],{env:{...env,GIT_OPTIONAL_LOCKS:'0'},encoding:'utf8',timeout:10000});
      if(r.error||r.status!==0)throw Error(r.error?.message||r.stderr||'Git evidence unavailable');
      return r.stdout.trim();
    };
    const head=git(['rev-parse','--verify','refs/heads/main']),log=plain(path.join(project.identity,'logs/refs/heads/main'));
    if(!/^[a-f0-9]{40,64}$/.test(head)||!log.text.endsWith('\n')||log.text.trim().split('\n').at(-1)?.split(' ')[1]!==head)throw Error('main reflog tail does not match main');
    // The loose ref identity also exposes an unlogged move-and-restore. Packed
    // or missing refs are conservative unknowns, never endpoint-only proof.
    const ref=plain(path.join(project.identity,'refs/heads/main'));
    if(ref.text.trim()!==head)throw Error('main ref changed while reading');
    result.main={head,ref,log};
    if(before?.main){
      const offset=Number(before.main.log.size),bytes=Buffer.from(log.text);
      result.main.prefix_sha256=evidenceHash(bytes.subarray(0,offset));
      result.main.appended=bytes.subarray(offset).toString('utf8');
    }
  }catch(e){result.errors.push(`main: ${e.message}`);}
  if(before)try{result.record=record();}catch(e){result.errors.push(e.message);}
  if(!before)result.at=new Date(now()).toISOString();
  return result;
}
export function beginHoldCloseout(options){return{id:randomUUID(),...snapshot(options)};}
export function finishHoldCloseout(options,before,{turn,subjects,completed=false}={}){
  const after=snapshot(options,before);
  // Keep only reflog fences and the appended history, not a growing copy of
  // the entire Git log in every journal frame.
  const slim=s=>{
    if(!s.main)return s;
    const {text,...log}=s.main.log;
    return{...s,main:{...s.main,log}};
  };
  return{schema:'brain.hold-closeout/v1',id:before.id,project:options.project.identity,org:options.org,
    turn,completed,code:options.code??null,before:slim(before),after:slim(after),subjects:subjects??[]};
}
