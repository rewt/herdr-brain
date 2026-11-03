import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {loadRecord,transact} from '../../lib/store.mjs';
import {sessionBindFact} from '../../test/helpers/session-bind.mjs';
import {registrationFile} from '../shared.mjs';
export const retained=fs.readFileSync(new URL('./fixtures/R-1836-usage-limit.txt',import.meta.url),'utf8');
export const localReset=new Date(2026,10,4,0,36).toISOString();

// Offline native responses, including a real nonzero refusal. Never contacts
// a host Herdr server; the calling fixture also isolates the fleet in-process.
export function usageNative(f){
  const {state}=loadRecord(f.org);
  transact(f.org,()=>({add:[sessionBindFact(state.runs.get('R-1'),state,{session:f.native.agent_session.value})]}));
  f.setNative({...f.native,agent:'codex',agent_status:'done',completion_seq:1});
  const screen=path.join(f.root,'screen'),input=path.join(f.root,'input');
  fs.writeFileSync(screen,retained);fs.writeFileSync(input,'delivered');
  const box=['\x1b[48;5;234m \x1b[0m','\x1b[48;5;234m\x1b[1m› \x1b[2mAsk Codex to do anything\x1b[0m','\x1b[48;5;234m \x1b[0m',`GPT · ${f.repo}`].join('\n');
  fs.writeFileSync(path.join(f.root,'herdr'),`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(f.calls)},JSON.stringify(args)+'\\n');
const n=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.root,'native.json'))}));
if(args[0]==='pane')process.stdout.write(fs.readFileSync(${JSON.stringify(screen)},'utf8')+'\\n\\n'+${JSON.stringify(box)});
else if(args[1]==='wait')await new Promise(r=>setTimeout(r,200));
else if(args[1]==='prompt'){
  const mode=fs.readFileSync(${JSON.stringify(input)},'utf8');
  if(mode==='refused'){process.stderr.write(JSON.stringify({error:{code:'agent_blocked',message:'blocked by native'}}));process.exitCode=1;}
  else if(mode==='uncertain'){process.stderr.write('connection lost');process.exitCode=1;}
  else process.stdout.write(JSON.stringify({result:{}}));
}else process.stdout.write(JSON.stringify({result:{agent:n}}));
`,{mode:0o755});
  return {screen:value=>fs.writeFileSync(screen,value),input:value=>fs.writeFileSync(input,value),
    prompts:()=>fs.existsSync(f.calls)?fs.readFileSync(f.calls,'utf8').split('\n').filter(line=>line&&JSON.parse(line)[1]==='prompt').length:0};
}
export async function until(predicate){
  const deadline=Date.now()+20000;
  while(!predicate()){if(Date.now()>deadline)throw Error('offline watcher observation timed out');await new Promise(r=>setTimeout(r,50));}
}
export function processWatch(t,f){
  fs.rmSync(registrationFile(f.org,'R-1'),{force:true});
  const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../watch.mjs'),'R-1','--org',f.org,'--cwd',f.repo,
    '--to','supervisor-test','--herdr',path.join(f.root,'herdr'),'--record-only','--start-grace','0'],
    {cwd:f.repo,env:{...process.env,ORG_DIR:f.org,ORG_ACTOR:'fixture'},stdio:['ignore','pipe','pipe']});
  let output='',exit;child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);
  const ended=new Promise(resolve=>child.on('exit',code=>{exit=code;resolve(code);}));
  t.after(()=>{if(exit===undefined)child.kill('SIGTERM');});
  return {stop:async()=>{
    fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.repo,'.lane/supervisor/STOP'),'stop fixture');
    await until(()=>exit!==undefined);await ended;
    fs.unlinkSync(path.join(f.repo,'.lane/supervisor/STOP'));
    if(exit!==0)throw Error(output);
  }};
}
