// Settle a positively proved pre-append failure on its ORIGINAL attempt. This
// is bookkeeping by the existing line, never another completion invocation.
import fs from '../lib/record-observation.mjs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readCommandResult} from '../lib/command-receipt.mjs';
import {loadRecord,planTransaction} from '../lib/store.mjs';
import {ancestors,fold} from '../lib/state.mjs';
import {readOwnedRun,requireController,assertOwner} from '../lib/run-owner.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {bundleRelease,checkBundle} from '../lib/releases.mjs';
import {bindCloseoutSources,publishCloseoutEvents} from '../lib/closeout.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {serviceRecordBinding} from './record-inbox.mjs';
import {lineContext} from './cutoff.mjs';
import {readServiceJournal} from './review.mjs';
import {reviewCompletionPlan} from './phase1.mjs';
import {reviewDigest as hash,reviewPlain} from './review-resolutions.mjs';
import {parseArgs,isMain} from '../lib/cli-help.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const time=v=>Number.isFinite(Date.parse(v));
const conflict='record planning conflict: source changed; no append was made';
const root=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
export const completionAttempts=(journal,runId)=>Object.entries(journal?.actions??{}).filter(([key])=>key.startsWith(`review-complete:${runId}:`));

export function completionPlanningProof({events,state,repo,org,identity,runId,key,entry}){
  const p=reviewCompletionPlan({events,state,runId});
  if(p.closed||key!==`review-complete:${runId}:${p.token}`)throw Error('original completion token/verdict changed');
  if(!entry||entry.state!=='held'||entry.owner!=='line-service'||entry.consumer!=='line-service'||entry.subject!==key||entry.execution_subject!==p.item.id||
    !/^[-a-zA-Z0-9_]{1,80}$/.test(entry.attempt??'')||entry.error!==conflict||entry.failure?.code!=='RECORD_PLANNING_CONFLICT'||entry.failure.kind!=='unknown'||
    entry.result!=null||entry.receipt!=null||entry.history!=null&&(!Array.isArray(entry.history)||entry.history.length)||entry.queue_recovery||entry.original_outcome||entry.commands?.length!==1||
    !time(entry.at)||!time(entry.finished_at)||Date.parse(entry.finished_at)<Date.parse(entry.at))throw Error('original completion is not an unconsumed pure planning failure');
  const ref=entry.commands[0],directory=path.join(org,'line-service',hash(JSON.stringify(identity)).slice(0,20));
  if(path.dirname(ref.file??'')!==path.join(directory,'active-commands')||path.dirname(ref.receipt??'')!==path.join(directory,'command-receipts'))throw Error('foreign original completion receipt');
  const bytes=reviewPlain(ref.receipt),command=readCommandResult(ref),i=command.intent;
  const expected={status:1,signal:null,stdout:'',stderr:conflict,error:{code:'RECORD_PLANNING_CONFLICT',message:conflict}};
  if(!same(command.result,expected)||i.exe!=='line-operation'||!same(i.args,['review-complete',key])||i.project!==identity||i.org!==org||i.cwd!==repo||i.subject!==p.item.id||i.key!==key||i.consumer!=='line-service'||
    command.executor!==i.caller||!time(i.at)||Date.parse(i.at)<Date.parse(entry.at)||Date.parse(command.finished_at)>Date.parse(entry.finished_at)||Date.parse(command.finished_at)<Date.parse(i.at)||Date.parse(p.fact.at)>Date.parse(i.at))throw Error('original completion terminal intent/result is not proven');
  const claim=events.find(e=>e.seq===p.run.owner_generation),facts=events.filter(e=>e.type==='change.reviewed'&&e.review_run===runId);
  if(facts.length!==1||p.fact.item!==p.item.meta.review_source_item||p.fact.source_run!==p.item.meta.review_source_run||p.fact.base!==p.item.meta.review_target?.base||
    !claim||claim.seq>=p.run.report.seq||Date.parse(claim.at)>Date.parse(entry.at)||effectiveWorkerIdentity(p.run,state).identity_conflict)throw Error('original completion claim/verdict binding changed');
  const report=path.resolve(org,p.run.report.file??'');
  if(!report.startsWith(org+path.sep)||hash(reviewPlain(report))!==p.run.report.sha256)throw Error('immutable review completion bytes changed');
  requireController(readOwnedRun(org,runId,events),'brain');
  return{schema:'review-completion-no-append/v1',project:identity,org,item:p.item.id,run:runId,key,attempt:entry.attempt,
    original_sha256:hash(JSON.stringify(entry)),command_sha256:hash(bytes),intent_sha256:ref.sha256,
    report_sha256:p.run.report.sha256,verdict_seq:p.fact.seq,claim_generation:p.run.owner_generation,owner:p.run.owner};
}

function original(c,runId,key){
  const journal=readServiceJournal(path.join(c.directory,'effects.json')),entries=completionAttempts(journal,runId);
  if(journal?.identity!==c.identity||journal.org!==c.org||entries.length!==1||entries[0][0]!==key)throw Error('original completion attempt missing/ambiguous; no replacement');
  return entries[0][1];
}
function quiescent(c,runId,subject){
  const directory=path.join(c.directory,'active-commands');if(!fs.existsSync(directory))return;
  let own=0;
  for(const name of fs.readdirSync(directory)){
    const file=path.join(directory,name);let bytes;
    // Completed commands can be forgotten after the directory listing.
    try{bytes=reviewPlain(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    const intent=JSON.parse(bytes);
    if(intent.subject!==subject)continue;
    try{readCommandResult({file,receipt:path.join(c.directory,'command-receipts',name),sha256:hash(bytes)});}
    catch(error){
      const key=`review-completion-reconcile:${runId}`;
      if(intent.caller!==process.pid||intent.exe!=='line-operation'||intent.consumer!=='line-service'||intent.project!==c.identity||intent.org!==c.org||intent.cwd!==c.repo||intent.key!==key||!same(intent.args,['review-completion-reconcile',key])||++own>1)throw Error(`completion subject has an active or UNKNOWN command: ${file}; ${error.message}`);
    }
  }
}
export function inspectReviewCompletion({repo,org,runId,key}){
  const c=lineContext(repo,org),loaded=loadRecord(c.org);if(loaded.tornTail)throw Error('incomplete record tail');
  const entry=original(c,runId,key),proof=completionPlanningProof({...loaded,...c,runId,key,entry});
  return{proof,original:entry,command:readCommandResult(entry.commands[0])};
}

export function reconcileReviewCompletion({repo,org,runId,key,env=process.env}){
  // Only the installed line's actual pass/subject owner may write. A worker or
  // supervisor display name cannot borrow that authority or run a service pass.
  const c=serviceRecordBinding({repo,org,env}),bundle=bundleRelease(root),source=()=>bundle.commit?checkBundle(root,{verifyFiles:true}).commit:git(root,['rev-parse','HEAD']);
  const sourceHead=source(),head=git(c.repo,['rev-parse','HEAD']),subject=loadRecord(c.org).state.runs.get(runId)?.item;
  const guard=()=>{
    serviceRecordBinding({repo,org,env});
    for(const f of [path.join(c.directory,'STOP'),path.join(c.repo,'.lane/supervisor/STOP'),path.join(c.repo,'.lane/supervisor/HOLD')])if(fs.existsSync(f))throw Error('STOP/HOLD prevents original completion reconciliation');
    if(source()!==sourceHead||git(c.repo,['rev-parse','HEAD'])!==head||!bundle.commit&&git(root,['status','--porcelain=v1'])||git(c.repo,['status','--porcelain=v1']))throw Error('completion reconciliation source/head/clean CAS changed');
    quiescent(c,runId,subject);
  };
  const release=acquireLock(path.join(c.identity,'lane-promote.lock'));
  try{
    guard();
    const entry=original(c,runId,key),loaded=loadRecord(c.org),old=loaded.events.filter(e=>e.type==='line-service.review-completion-reconciled'&&e.project===c.identity&&e.org===c.org&&(e.key===key||e.attempt===entry.attempt));
    const before=old.length?loaded.events.filter(e=>e.seq<old[0].seq):loaded.events;
    if(old.length>1)throw Error('original completion reconciliation ambiguous');
    const proof=completionPlanningProof({events:before,state:fold(before),...c,runId,key,entry}),id=`completion-${entry.attempt}`;
    const bytes=Buffer.from(JSON.stringify({proof,original:entry,command:readCommandResult(entry.commands[0])},null,2)+'\n'),archive=path.join(c.org,'evidence/review-completion-reconciliation',`${id}.json`);
    fs.mkdirSync(path.dirname(archive),{recursive:true});
    try{const fd=fs.openSync(archive,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch(e){if(e.code!=='EEXIST'||hash(reviewPlain(archive))!==hash(bytes))throw e;}
    const result=planTransaction(c.org,(events,state)=>{
      guard();
      if(!same(original(c,runId,key),entry)||hash(reviewPlain(archive))!==hash(bytes))throw Error('original completion/archive changed');
      const run=readOwnedRun(c.org,runId,events);requireController(run,'brain');assertOwner(run,{owner:proof.owner,generation:proof.claim_generation});
      if(run.report?.sha256!==proof.report_sha256||hash(reviewPlain(path.resolve(c.org,run.report.file)))!==proof.report_sha256)throw Error('immutable review completion bytes changed');
      const item=state.items.get(proof.item);
      if([item,...ancestors(state,item.id)].some(i=>i.meta.hold||i.meta.held||i.meta.reserved||i.meta.operator_reserved||['security','funds-and-chain','publish','delete-data','licensing','priorities'].includes(i.meta.category)))throw Error('completion subject held/reserved');
      const existing=events.filter(e=>e.type==='line-service.review-completion-reconciled'&&e.project===c.identity&&e.org===c.org&&(e.key===key||e.attempt===entry.attempt));
      if(existing.length){
        const e=existing[0];
        const closed=events.find(row=>row.seq===item.closed?.seq&&row.type==='item.closed'&&row.review_completion_reconciliation===id&&row.completed_run===runId);
        if(existing.length!==1||e.id!==id||!same(e.proof,proof)||e.archive?.file!==archive||e.archive.sha256!==hash(bytes)||!closed||item.runs.at(-1)!==runId)throw Error('original completion reconciliation changed; retain original');
        return{add:[],result:{result:'review_completion_reconciled',id,attempt:entry.attempt,seq:e.seq,existing:true}};
      }
      if(!same(completionPlanningProof({events,state,...c,runId,key,entry}),proof))throw Error('original completion proof changed');
      const mutation=protectRecordMutation({org:c.org,events,state,command:'reconcile original review completion',mutation:{add:[
        {type:'line-service.review-completion-reconciled',id,project:c.identity,org:c.org,item:item.id,run:runId,key,attempt:entry.attempt,proof,
          archive:{file:archive,sha256:hash(bytes)},source:{root,head:sourceHead,canonical_head:head},owner:'line-service',original_command_replayed:false},
        {type:'item.closed',id:item.id,as:'done',completed_run:runId,review_verdict:proof.verdict_seq,review_completion_reconciliation:id,
          note:`Original pre-append completion failure reconciled against its already recorded ${events.find(e=>e.seq===proof.verdict_seq).verdict}; original attempt and terminal receipt retained. Linked corrections and guarded physical retirement remain owned.`},
      ],result:{result:'review_completion_reconciled',id,attempt:entry.attempt,existing:false}}});
      return bindCloseoutSources({cwd:c.repo,org:c.org,events,env,mutation});
    },{actor:'line-service',strictTail:true,replaySafe:true,lockOptions:{recover:false}});
    publishCloseoutEvents({cwd:c.repo,org:c.org,added:result.added,start:false,env});return result.result;
  }finally{release();}
}
if(isMain(import.meta.url))try{
  const {values}=parseArgs({usage:'Usage: node line-service/review-completion.mjs --repo REPO --org ORG --run R-n --key ORIGINAL_KEY (read only)',options:Object.fromEntries(['repo','org','run','key'].map(k=>[k,{type:'string'}]))});
  console.log(JSON.stringify(inspectReviewCompletion({...values,runId:values.run}),null,2));
}catch(e){console.error(`completion inspection: ${e.message}`);process.exitCode=1;}
