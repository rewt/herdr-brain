// Exact owner/delegate disposition of one unstarted original request. Never
// retry it, rewrite its journal, dispatch proof work or claim an old success.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gitProject} from '../lib/project.mjs';
import {loadEvents,transact,findOrgDir} from '../lib/store.mjs';
import {fold,itemStatus} from '../lib/state.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {identityRootAt} from '../messages/journal.mjs';
import {invokeHerdr} from '../supervisor/herdr-edge.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {lineDirectory} from '../line-service/cutoff.mjs';
import {lockRequest} from './request-lock.mjs';
const root=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url))),sha=b=>createHash('sha256').update(b).digest('hex');
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const plain=file=>{const s=fs.lstatSync(file);if(!s.isFile()||fs.realpathSync(file)!==path.resolve(file))throw Error('not-started evidence is redirected');return fs.readFileSync(file);};
const effectBytes=e=>JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k])=>k!=='original_outcome')));
function immutable(file,bytes){try{const fd=fs.openSync(file,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch(e){if(e.code!=='EEXIST'||sha(plain(file))!==sha(bytes))throw e;}}
export function resolvedNotStarted({events,org,common,journal}){
  const rows=events.filter(e=>e.type==='dispatch.not-started'&&e.project===common&&e.org===org&&e.journal===journal);
  if(!rows.length)return null;if(rows.length!==1)throw Error('original request has ambiguous dispositions');const e=rows[0];
  if(!e.archive?.file?.startsWith(path.join(org,'evidence/dispatch-resolution')+path.sep)||sha(plain(e.archive.file))!==e.archive.sha256)throw Error('original not-started archive changed');
  const m=JSON.parse(plain(e.archive.file)),decision=events.find(d=>d.seq===e.decision_seq&&d.type==='note.added'&&d.decision&&d.by===e.native_caller?.name&&d.id===e.item);
  if(!decision||![e.item,e.journal,e.id,e.changed_source].every(v=>decision.text.includes(v))||!m.files?.length||m.id!==e.id||m.journal!==journal)throw Error('original not-started scoped authorization changed');
  for(const f of m.files)if(!f.archive.startsWith(path.dirname(e.archive.file)+path.sep)||sha(plain(f.archive))!==f.sha256)throw Error('original not-started archive bytes changed');
  if(sha(plain(journal))!==e.journal_sha256||events.some(x=>x.type==='run.started'&&(x.meta?.dispatch_journal===journal||x.meta?.dispatch_attempt===e.token)))throw Error('original dispatch progressed after disposition; retain both requests');
  return e;
}
export function resolvedDispatchInput({events,org,common,item,input}){
  const rows=events.filter(e=>e.type==='dispatch.not-started'&&e.project===common&&e.org===org&&e.item===item&&e.input===input);
  if(!rows.length)return input;if(rows.length!==1)throw Error('original dispatch input has ambiguous disposition');resolvedNotStarted({events,org,common,journal:rows[0].journal});return`${input}:resolved-${rows[0].seq}`;
}
export function resolveNotStarted({repo,org,journal,disposition,decisionSeq,id,changedSource,role,cwd=process.cwd(),env=process.env,call=invokeHerdr,requestLock=lockRequest}){
  if(role!=='supervisor'||!/^[-a-zA-Z0-9_]{1,80}$/.test(id??'')||!Number.isSafeInteger(decisionSeq)||!/^[a-f0-9]{40}$/.test(changedSource??''))throw Error('not-started resolution needs supervisor mode, scoped decision, stable id and exact changed source');
  const project=gitProject(repo);repo=project.canonical;org=fs.realpathSync(org);
  if(project.checkout!==repo||fs.realpathSync(findOrgDir({cwd:repo,env:{...env,ORG_DIR:''}})??'')!==org||!env.HERDR_BRAIN_ROOT||fs.realpathSync(env.HERDR_BRAIN_ROOT)!==root)throw Error('actual project/record/matching source differs');
  const binding=nativeSender(org,{cwd,env,call});if(binding.project.checkout!==repo||binding.project.identity!==project.identity)throw Error('not-started caller is not its actual canonical native supervisor');
  const tuple=b=>[b.native.name,b.native.pane_id,b.native.workspace_id,b.native.terminal_id,b.native.agent_session.value];
  const identity=identityRootAt(project.identity);disposition=path.resolve(disposition);journal=path.resolve(journal);
  if(!identity||!disposition.startsWith(identity+path.sep)||path.dirname(journal)!==path.join(org,'dispatch'))throw Error('not-started disposition cannot read another owner/project');
  const dataBytes=plain(disposition),data=JSON.parse(dataBytes),bytes=plain(journal),job=JSON.parse(bytes),sourceHead=git(root,['rev-parse','HEAD']),targetHead=git(repo,['rev-parse','HEAD']);
  if(data.original_request!==journal||!/^NOT STARTED\b/.test(data.conclusion??'')||!data.disposition)throw Error('disposition does not bind this exact NOT STARTED original request');
  if(job.repo!==repo||job.org!==org||job.common!==project.identity||path.basename(journal)!==`${job.token}.json`)throw Error('original request belongs to another project/record');
  git(root,['merge-base','--is-ancestor',changedSource,sourceHead]);
  if(job.sourceSelection?.head===changedSource||job.sourceSelection?.head===sourceHead)throw Error('unchanged source cannot release this original request');
  const effectFile=path.join(lineDirectory(org,project.identity),'effects.json'),effects=JSON.parse(plain(effectFile)),entryKey=Object.keys(effects.actions??{}).find(key=>key===`dispatch:${job.item}:${job.lineInput??''}`)||`dispatch:${job.item}:`;
  const candidates=Object.entries(effects.actions??{}).filter(([key,e])=>key.startsWith(entryKey)&&e.state==='held'&&e.receipt?.error==='ETIMEDOUT');
  if(candidates.length!==1)throw Error('exact original elapsed failure effect is missing/ambiguous');const [effectKey,effect]=candidates[0],input=effectKey.slice(`dispatch:${job.item}:`.length),effectHash=sha(effectBytes(effect));
  const current=loadEvents(org).events,done=resolvedNotStarted({events:current,org,common:project.identity,journal});if(done){if(done.id!==id)throw Error('original request disposition already spent');return{result:'not_started_archived',existing:true,id,source_input:`${input}:resolved-${done.seq}`};}
  const decision=current.find(e=>e.seq===decisionSeq&&e.type==='note.added'&&e.decision&&e.by===binding.native.name&&e.id===job.item&&[job.item,journal,id,changedSource].every(v=>e.text.includes(v)));
  if(!decision)throw Error('not-started resolution needs actual owning native supervisor scoped decision, not metadata authority');
  let lane;
  const guard=events=>{
    if(JSON.stringify(tuple(nativeSender(org,{cwd,env,call})))!==JSON.stringify(tuple(binding)))throw Error('native caller changed before not-started resolution');
    if(git(root,['rev-parse','HEAD'])!==sourceHead||git(root,['status','--porcelain=v1'])||git(repo,['rev-parse','HEAD'])!==targetHead||git(repo,['status','--porcelain=v1']))throw Error('actual committed source/clean project CAS changed');
    for(const file of [path.join(lineDirectory(org,project.identity),'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])if(fs.existsSync(file))throw Error('STOP/HOLD prevents not-started resolution');
    if(sha(plain(journal))!==sha(bytes)||sha(plain(disposition))!==sha(dataBytes))throw Error('original request/disposition changed');
    const fresh=JSON.parse(plain(effectFile));if(fresh.identity!==project.identity||fresh.org!==org||sha(effectBytes(fresh.actions?.[effectKey]??{}))!==effectHash)throw Error('original effect receipt progressed');
    const state=fold(events),item=state.items.get(job.item);
    if(!item||item.runs.length||itemStatus(state,item.id)!=='ready'||item.role==='human'||['operator_reserved','reserved','hold','held'].some(k=>item.meta[k])||['security','funds-and-chain','publish','delete-data','licensing','priorities'].includes(item.meta.category)||input!==`${item.created.seq}:ordinary`)throw Error('original proof item is no longer the unchanged ready unstarted item');
    if(job.stage!=='open'||job.run||job.worker||job.launchProcess||job.sessionBinding||job.native_launch_attempted===true||events.some(e=>e.type==='run.started'&&(e.item===job.item||e.meta?.dispatch_journal===journal||e.meta?.dispatch_attempt===job.token)))throw Error('original request has native/record progress; no replacement');
    const trees=git(repo,['worktree','list','--porcelain']).split('\n\n').filter(Boolean).map(block=>Object.fromEntries(block.split('\n').filter(Boolean).map(row=>{const p=row.indexOf(' ');return[row.slice(0,p),row.slice(p+1)];}))).filter(w=>w.branch===`refs/heads/lane/${job.lane}`);
    if(trees.length>1)throw Error('original lane registration is ambiguous');lane=trees[0]?.worktree??null;
    if(lane&&(gitProject(lane).identity!==project.identity||git(lane,['status','--porcelain=v1','--untracked-files=all'])||git(lane,['rev-parse','HEAD'])!==job.base||['.lane/HOLD','.lane/supervisor/HOLD','.lane/supervisor/STOP'].some(p=>fs.existsSync(path.join(lane,p)))))throw Error('original lane is foreign/dirty/progressed/held');
    const agents=JSON.parse(call('herdr',['agent','list']));if(agents.error||!Array.isArray(agents.result?.agents))throw Error('fresh native inventory unavailable');
    if(lane&&agents.result.agents.some(a=>a.cwd===lane||a.foreground_cwd===lane))throw Error('original lane has a native occupant; no replacement');
  };
  const held=requestLock(journal);let release;
  try{
    release=acquireLock(path.join(project.identity,'lane-promote.lock'));
    guard(loadEvents(org).events);
    const directory=path.join(org,'evidence/dispatch-resolution',id);fs.mkdirSync(directory,{recursive:true});
    const snapshots=[{original:journal,bytes},{original:disposition,bytes:dataBytes},{original:effectFile+'#'+effectKey,bytes:Buffer.from(JSON.stringify(effect,null,2)+'\n')}];
    const request={id,item:job.item,journal,journal_sha256:sha(bytes),effect_key:effectKey,effect_sha256:effectHash,input,changed_source:changedSource,decision_seq:decisionSeq,disposition_sha256:sha(dataBytes)},requestHash=sha(JSON.stringify(request));
    transact(org,events=>{guard(events);const prior=events.find(e=>e.type==='dispatch.resolution-intent'&&e.id===id);if(prior&&prior.request_sha256!==requestHash)throw Error('stable disposition id has different original evidence');return protectRecordMutation({org,events,state:fold(events),command:'dispatch not-started',mutation:{add:prior?[]:[{type:'dispatch.resolution-intent',...request,request_sha256:requestHash}]}});},{actor:binding.native.name,strictTail:true,lockOptions:{recover:false}});
    const files=snapshots.map((f,i)=>{const archive=path.join(directory,`${i}.json`);immutable(archive,f.bytes);return{original:f.original,archive,sha256:sha(f.bytes)};});
    const manifest=Buffer.from(JSON.stringify({...request,request_sha256:requestHash,files},null,2)+'\n'),manifestFile=path.join(directory,'manifest.json');immutable(manifestFile,manifest);const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const final=transact(org,events=>{guard(events);if(events.some(e=>e.type==='dispatch.not-started'&&e.journal===journal))throw Error('original disposition already recorded');return protectRecordMutation({org,events,state:fold(events),command:'dispatch not-started',mutation:{add:[{type:'dispatch.not-started',...request,token:job.token,project:project.identity,org,native_caller:binding.native,archive:{file:manifestFile,sha256:sha(manifest)},lane,disposition:'NOT_STARTED',original_success:false}]}});},{actor:binding.native.name,strictTail:true,lockOptions:{recover:false}});
    return{result:'not_started_archived',id,journal,original_success:false,source_input:`${input}:resolved-${final.added[0].seq}`,fresh_start:'Existing line only; no dispatch in this control',archive:manifestFile};
  }finally{try{release?.();}finally{held.release();}}
}
