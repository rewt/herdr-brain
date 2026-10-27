// Existing queue-review's supervisor-bound lifecycle recovery. No launch/kill,
// journal rewrite, pin change, boundary reset or alternative review transport.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {gitProject} from '../lib/project.mjs';
import {findOrgDir,loadEvents,transact} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {roleIs} from '../lib/roles.mjs';
import {readOwnedRun,requireController,assertOwner} from '../lib/run-owner.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {identityRootAt} from '../messages/journal.mjs';
import {invokeHerdr} from '../supervisor/herdr-edge.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {claimedCommitTokens} from '../settle/review-range.mjs';
import {queueConsumer,queueReviewMutation} from './review-queue.mjs';
import {lineDirectory} from './cutoff.mjs';
import {reviewDigest as hash,reviewPlain,reviewResolution} from './review-resolutions.mjs';
const root=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:32*1024*1024}).trim();
const verdicts=new Set(['PASS','FAIL','NEEDS-WORK']);
function completedVerdict(bytes,head){
  const text=bytes.toString();let value;try{value=JSON.parse(text);}catch{}
  const visit=v=>{if(!v||typeof v!=='object')return null;
    const named=v.head??v.reviewed_head??v.commit;
    if(named===head){const verdict=v.review?.verdict??v.verdict;if(verdicts.has(verdict))return verdict;}
    for(const child of Object.values(v)){const found=visit(child);if(found)return found;}return null;};
  const structured=visit(value);if(structured)return structured;
  if(text.includes(`Reviewed commit: ${head}`)&&text.includes('<!-- lane-review-complete -->'))return /^\*\*(PASS|FAIL|NEEDS-WORK)\*\*/.exec(text)?.[1]??null;
  return null;
}
function immutable(file,bytes){
  try{const fd=fs.openSync(file,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  catch(e){if(e.code!=='EEXIST'||hash(reviewPlain(file))!==hash(bytes))throw e;}
}
export function recoverInactiveReview({repo,org,runId,head,base,resolution,decisionSeq,id,role,cwd=process.cwd(),env=process.env,call=invokeHerdr}){
  if(role!=='supervisor'||!/^[-a-zA-Z0-9_]{1,80}$/.test(id??'')||!Number.isSafeInteger(decisionSeq))throw Error('inactive review recovery needs actual supervisor mode, stable id and scoped decision sequence');
  const project=gitProject(repo);if(project.checkout!==project.canonical)throw Error('review recovery needs actual canonical supervisor checkout');repo=project.canonical;org=fs.realpathSync(org);
  if(fs.realpathSync(findOrgDir({cwd:repo,env:{...env,ORG_DIR:''}})??'')!==org)throw Error('review recovery record/project binding differs');
  const binding=nativeSender(org,{cwd,env,call});if(binding.project.checkout!==repo||binding.project.identity!==project.identity)throw Error('review recovery caller is not its actual canonical native supervisor');
  const identityRoot=identityRootAt(project.identity),inside=file=>{file=path.resolve(file);if(!identityRoot||!(file===identityRoot||file.startsWith(identityRoot+path.sep)))throw Error('review archive cannot read another identity');return file;};
  resolution=inside(resolution);const inputBytes=reviewPlain(resolution),input=JSON.parse(inputBytes);
  if(input.item===undefined||input.run!==runId||input.head!==head||input.base!==base||!Array.isArray(input.attempts)||!input.attempts.length||input.inactive?.verified_by!==binding.native.name||!['never-created','absent'].includes(input.inactive.kind))throw Error('inactive resolution tuple/native verifier differs from requested source');
  const native=()=>{const b=nativeSender(org,{cwd,env,call});if(['name','pane_id','workspace_id','terminal_id'].some(k=>b.native[k]!==binding.native[k])||b.native.agent_session.value!==binding.native.agent_session.value)throw Error('native supervisor changed before recovery');return b.native;};
  const initialEvents=loadEvents(org).events,initialState=fold(initialEvents),run=initialState.runs.get(runId),item=initialState.items.get(input.item);
  if(!run||run.item!==input.item||!run.report||!roleIs(item,'ENG')||roleIs(initialState.items.get(item.parent),'REV')||item.meta.review_fix_of)throw Error('review recovery needs an actual reported source build, not a packet or correction review chain');
  const owned=readOwnedRun(org,runId);requireController(owned,'brain');assertOwner(owned,{owner:run.owner,generation:run.owner_generation});queueConsumer({run,env});
  const sourceHead=git(repo,['rev-parse','HEAD']);
  const guard=()=>{
    native();queueConsumer({run,env});assertOwner(readOwnedRun(org,runId),{owner:run.owner,generation:run.owner_generation});
    if(gitProject(repo).identity!==project.identity||git(repo,['rev-parse','HEAD'])!==sourceHead||git(repo,['status','--porcelain=v1']))throw Error('review recovery source/head/clean CAS changed');
    for(const file of [path.join(lineDirectory(org,project.identity),'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])if(fs.existsSync(file))throw Error('STOP/HOLD prevents review recovery');
    if(hash(reviewPlain(resolution))!==hash(inputBytes))throw Error('inactive resolution evidence changed');
  };
  const verifyInactive=(state)=>{
    const raw=JSON.parse(call('herdr',['agent','list']));if(raw.error||!Array.isArray(raw.result?.agents))throw Error('native reviewer inventory is unavailable; retain attempt');
    const agents=raw.result.agents,r=input.inactive.reviewer;
    const same=a=>r&&[r.pane&&a.pane_id===r.pane,r.agent&&a.name===r.agent,r.terminal&&a.terminal_id===r.terminal,r.session&&(a.agent_session?.value??a.agent_session_id)===r.session].some(Boolean);
    if(agents.some(same))throw Error('live reviewer retained; no archival or replacement');
    for(const q of state.items.values())if(q.meta.review_source_item===item.id&&q.meta.review_target?.head===head)for(const rid of q.runs){const m=effectiveWorkerIdentity(state.runs.get(rid),state);if(agents.some(a=>m.pane&&a.pane_id===m.pane||m.agent&&a.name===m.agent||m.agent_session_id&&a.agent_session?.value===m.agent_session_id))throw Error('live reviewer retained for this exact change');}
    if(input.inactive.kind==='absent'){
      if(!r?.pane)throw Error('absent legacy reviewer needs its actual recorded pane, without invented session values');
      let result;try{result=JSON.parse(call('herdr',['pane','get',r.pane]));}catch(e){if(!/"code"\s*:\s*"pane_not_found"/.test(e.message))throw e;result={error:{code:'pane_not_found'}};}
      if(result.error?.code!=='pane_not_found')throw Error('recorded reviewer pane is not positively absent; retain attempt');
    }
  };
  const release=acquireLock(path.join(project.identity,'lane-promote.lock'));
  try{
    guard();
    try{git(repo,['merge-base','--is-ancestor',head,sourceHead]);}catch{throw Error('requested actual source is not landed; no backfill');}
    if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head??'')||head===base||!claimedCommitTokens(run.report.artifacts??[]).some(token=>head.startsWith(token)))throw Error('no positively claimed committed source tuple; admission/packet/no-code head is insufficient');
    git(repo,['merge-base','--is-ancestor',base,head]);const diff=git(repo,['diff','--no-ext-diff','--no-textconv',base,head]);if(!diff)throw Error('requested source has an empty/no-code delta');
    const evidence=path.resolve(org,run.report.file??'');if(evidence!==inside(input.evidence)||hash(reviewPlain(evidence))!==run.report.sha256)throw Error('immutable source report/evidence tuple changed');
    const start=initialEvents.find(e=>e.type==='run.started'&&e.id===runId),dispatch=start?.meta?.dispatch_journal;
    if(!dispatch?.startsWith(path.join(org,'dispatch')+path.sep))throw Error('original source dispatch attribution is missing');
    const saved=JSON.parse(reviewPlain(dispatch));if(saved.run!==runId||saved.item!==item.id||saved.common!==project.identity||saved.org!==org||saved.token!==start.meta.dispatch_attempt||saved.workspace!==run.workspace)throw Error('original source claim/project attribution changed');
    const target={head,base,reportHash:run.report.sha256,evidence,diff_sha256:hash(diff),dispatch,scope:{base,commits:git(repo,['rev-list','--reverse',`${base}..${head}`]).split('\n').filter(Boolean),claims:[head],unresolved:[],deferred:false}};
    const files=[...new Set([resolution,evidence,inside(input.inactive.evidence),...input.attempts.map(inside)])].map(file=>({original:file,bytes:reviewPlain(file)}));
    const known=initialEvents.find(e=>(e.type==='change.reviewed'&&e.item===item.id&&e.head===head)||(e.type==='review.verdict'&&e.run===runId&&(e.reviewed_head??e.head)===head));
    const verdict=known?.verdict??known?.review?.verdict??files.map(f=>completedVerdict(f.bytes,head)).find(Boolean);if(verdict)return{result:'review_preserved',item:item.id,head,verdict};
    const prior=reviewResolution({events:initialEvents,org,item:item.id,head});if(prior){if(prior.event.id!==id)throw Error('one inactive replacement budget already spent');return{result:'review_queued',review_item:prior.event.review_item,source_item:item.id,head,existing:true};}
    const decision=initialEvents.find(e=>e.seq===decisionSeq&&e.type==='note.added'&&e.decision&&e.by===binding.native.name&&[item.id,runId].includes(e.id)&&e.text.includes(item.id)&&e.text.includes(head));
    if(!decision)throw Error('recovery needs the actual native supervisor scoped decision; no authority inferred from metadata');
    verifyInactive(initialState);
    const effects=[];
    const serviceDirs=fs.existsSync(path.join(org,'line-service'))?fs.readdirSync(path.join(org,'line-service'),{withFileTypes:true}).filter(e=>e.isDirectory()):[];
    for(const dir of serviceDirs){
      const file=path.join(org,'line-service',dir.name,'effects.json');if(!fs.existsSync(file))continue;const bytes=reviewPlain(file),journal=JSON.parse(bytes);let used=false;
      for(const [key,value]of Object.entries(journal.actions??{}))if(/review/i.test(key)&&((key.includes(item.id)&&JSON.stringify(value).includes(head))||JSON.stringify(value).includes(runId))){effects.push({file,key,sha256:hash(JSON.stringify(value))});used=true;}
      if(used&&!files.some(f=>f.original===file))files.push({original:file,bytes});
    }
    const request={id,item:item.id,run:runId,target,decision_seq:decisionSeq,resolution_sha256:hash(inputBytes),files:files.map(f=>({original:f.original,sha256:hash(f.bytes)})),effects};
    const requestHash=hash(JSON.stringify(request));
    transact(org,events=>{guard();const old=events.find(e=>e.type==='review.recovery-intent'&&e.id===id);if(old&&old.request_sha256!==requestHash)throw Error('stable review recovery id has different source/evidence');return protectRecordMutation({org,events,state:fold(events),command:'queue-review recovery',mutation:{add:old?[]:[{type:'review.recovery-intent',...request,request_sha256:requestHash,project:project.identity,native_caller:native()}]}});},{actor:binding.native.name,strictTail:true,lockOptions:{recover:false}});
    const archiveDir=path.join(org,'evidence/review-recovery',id);fs.mkdirSync(archiveDir,{recursive:true});
    const archived=files.map((f,i)=>{guard();const archive=path.join(archiveDir,`${i}-${path.basename(f.original)}`);immutable(archive,f.bytes);return{original:f.original,archive,sha256:hash(f.bytes)};});
    const manifest={id,item:item.id,run:runId,target,request_sha256:requestHash,files:archived,effects},manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),manifestFile=path.join(archiveDir,'manifest.json');immutable(manifestFile,manifestBytes);const fd=fs.openSync(archiveDir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const final=transact(org,events=>{
      guard();const state=fold(events);verifyInactive(state);if(state.runs.get(runId)?.report.sha256!==run.report.sha256)throw Error('source report changed before archival completion');
      if(events.some(e=>e.type==='change.reviewed'&&e.item===item.id&&e.head===head))return{add:[],result:{result:'review_preserved',item:item.id,head}};
      for(const f of files)if(!effects.some(e=>e.file===f.original)&&hash(reviewPlain(f.original))!==hash(f.bytes))throw Error('original review evidence progressed before resolution; no replacement');
      for(const effect of effects){const current=JSON.parse(reviewPlain(effect.file));if(hash(JSON.stringify(current.actions?.[effect.key]))!==effect.sha256)throw Error('original review effect progressed before resolution; no replacement');}
      const old=events.find(e=>e.type==='review.recovery-completed'&&e.item===item.id&&e.target?.head===head);if(old)return{add:[],result:{result:'review_queued',review_item:old.review_item,existing:true}};
      const archivedItems=[...state.items.values()].filter(q=>q.meta.review_source_item===item.id&&q.meta.review_target?.head===head).map(q=>q.id);
      const event={type:'review.recovery-completed',id,item:item.id,run:runId,target,project:project.identity,org,decision_seq:decisionSeq,native_caller:native(),archive:{file:manifestFile,sha256:hash(manifestBytes)},archived_review_items:archivedItems,replacement_cap:1,prior_caps_preserved:true,seq:events.at(-1).seq+1};
      const projected=[...events,event],queued=queueReviewMutation({state:fold(projected),events:projected,org,repo,runId,head,base,env:{...env,ORG_ACTOR:binding.native.name},recoveryBinding:{...binding,native:event.native_caller}});event.review_item=queued.result.review_item;
      const retired=archivedItems.flatMap(qid=>[{type:'item.closed',id:qid,as:'dropped',note:`Inactive review attempt archived by ${id}; no verdict claimed. One exact-change replacement ${event.review_item}; original evidence/cap retained.`},
        ...state.items.get(qid).runs.filter(rid=>!state.runs.get(rid).report&&!state.runs.get(rid).abandoned).map(rid=>({type:'run.abandoned',id:rid,note:`Inactive review attempt archived by ${id}; no verdict or product completion claimed.`}))]);
      return protectRecordMutation({org,events,state,command:'queue-review recovery',mutation:{add:[event,...retired,...queued.add],result:queued.result}});
    },{actor:binding.native.name,strictTail:true,lockOptions:{recover:false}});
    return final.result;
  }finally{release();}
}
