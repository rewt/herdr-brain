// Append-only owner reconciliation. Never edits the effect journal or queues a
// review: the existing line consumes this exact proof during its ordinary pass.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertCommandQuiescence} from '../lib/command-receipt.mjs';
import {gitProject} from '../lib/project.mjs';
import {transact,loadEvents} from '../lib/store.mjs';
import {ancestors,fold} from '../lib/state.mjs';
import {bundleRelease,checkBundle} from '../lib/releases.mjs';
import {readOwnedRun,requireController,assertOwner} from '../lib/run-owner.mjs';
import {readProjectPolicy} from '../lib/config-policy.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {identityRootAt} from '../messages/journal.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {lineContext} from './cutoff.mjs';
import {readServiceJournal,reviewAttempt} from './review.mjs';
import {terminalQueuePlanningProof,resolvedQueuePlanning} from './review-queue-proof.mjs';
import {reviewDigest as hash,reviewPlain} from './review-resolutions.mjs';
import {parseArgs,isMain} from '../lib/cli-help.mjs';

const root=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function inspectReviewQueue({repo,org,runId,attempt}){
  const c=lineContext(repo,org),journal=readServiceJournal(path.join(c.directory,'effects.json'));
  if(!attempt||journal?.identity!==c.identity||journal.org!==c.org)throw Error('inspection needs exact original attempt and own journal');
  const entries=Object.entries(journal.actions).filter(([,e])=>e.attempt===attempt);
  if(entries.length!==1)throw Error('original queue attempt missing/ambiguous');
  const [key,entry]=entries[0],state=fold(loadEvents(c.org).events),run=state.runs.get(runId);
  const proof=run&&terminalQueuePlanningProof({entry,key,repo:c.repo,org:c.org,identity:c.identity,item:run.item,run:runId});
  if(!proof)throw Error('original terminal planning receipt is not supported');
  return{item:run.item,run:runId,key,attempt,target:entry.review_target,original_sha256:proof.original_sha256,command_sha256:proof.command_sha256};
}
export function reconcileReviewQueue({repo,org,runId,resolution,decisionSeq,id,role,cwd=process.cwd(),env=process.env,call}){
  if(role!=='supervisor'||!/^[-a-zA-Z0-9_]{1,80}$/.test(id??'')||!Number.isSafeInteger(decisionSeq))throw Error('queue reconciliation requires owning supervisor mode, stable id and exact decision');
  if(!env.HERDR_BRAIN_ROOT||fs.realpathSync(env.HERDR_BRAIN_ROOT)!==root)throw Error('queue reconciliation requires matching actual source');
  const c=lineContext(repo,org),ownerRoot=identityRootAt(c.identity);
  if(typeof resolution!=='string'||resolution!==path.resolve(resolution)||!ownerRoot||!resolution.startsWith(ownerRoot+path.sep))throw Error('queue reconciliation cannot read another identity');
  const inputBytes=reviewPlain(resolution),input=JSON.parse(inputBytes),file=path.join(c.directory,'effects.json'),key=input.key;
  const bundle=bundleRelease(root),source=()=>bundle.commit?checkBundle(root,{verifyFiles:true}).commit:git(root,['rev-parse','HEAD']);
  const sourceHead=source(),mainHead=git(c.repo,['rev-parse','HEAD']);
  const policyEnv={...env};for(const k of ['LANE_CONFIG','PROMOTE_CONFIG','MONITOR_SUPERVISOR_AGENT'])delete policyEnv[k];
  const bind=()=>{
    const b=nativeSender(c.org,{cwd,env,...(call?{call}:{})}),supervisor=readProjectPolicy(c.repo,'promote',policyEnv,{canonical:c.repo}).config.to;
    if(b.project.checkout!==c.repo||b.project.identity!==c.identity||!supervisor||b.native.name!==supervisor)throw Error('queue reconciliation requires the actual owning PROJECT SUPERVISOR');
    return b.native;
  };
  const native=bind(),tuple=n=>[n.name,n.cwd,n.pane_id,n.workspace_id,n.terminal_id,n.agent_session?.value];
  let releasePass,releasePromotion;
  try{
    releasePass=noticeLock(path.join(c.directory,'pass.lock'),{recover:false});
    assertCommandQuiescence(c.directory);
    releasePromotion=acquireLock(path.join(c.identity,'lane-promote.lock'));
    const guard=()=>{
      if(!same(tuple(bind()),tuple(native)))throw Error('native supervisor identity changed');
      if(gitProject(c.repo).identity!==c.identity||source()!==sourceHead||git(c.repo,['rev-parse','HEAD'])!==mainHead||!bundle.commit&&git(root,['status','--porcelain=v1'])||git(c.repo,['status','--porcelain=v1']))throw Error('queue reconciliation source/head/clean CAS changed');
      for(const f of [path.join(c.directory,'STOP'),path.join(c.repo,'.lane/supervisor/STOP'),path.join(c.repo,'.lane/supervisor/HOLD')])if(fs.existsSync(f))throw Error('STOP/HOLD prevents queue reconciliation');
      if(hash(reviewPlain(resolution))!==hash(inputBytes))throw Error('queue reconciliation input changed');
    };
    guard();
    return transact(c.org,(events,state)=>{
      guard();
      const run=state.runs.get(runId),item=state.items.get(input.item);
      if(!run||!item||run.item!==item.id||input.run!==runId)throw Error('queue reconciliation source run/item differs');
      const owned=readOwnedRun(c.org,runId);requireController(owned,'brain');assertOwner(owned,{owner:run.owner,generation:run.owner_generation});
      if([item,...ancestors(state,item.id)].some(i=>i.meta.hold||i.meta.held||i.meta.reserved||i.meta.operator_reserved))throw Error('subject held/reserved');
      const journal=readServiceJournal(file);
      if(journal?.identity!==c.identity||journal.org!==c.org)throw Error('queue journal project/record differs');
      const entry=journal.actions[key],proof=terminalQueuePlanningProof({entry,key,repo:c.repo,org:c.org,identity:c.identity,item:item.id,run:runId});
      if(!proof||input.attempt!==entry.attempt||input.original_sha256!==proof.original_sha256||input.command_sha256!==proof.command_sha256||!same(input.target,proof.target))throw Error('exact original terminal planning receipt/target is not proven');
      const decision=events.find(d=>d.seq===decisionSeq&&d.type==='note.added'&&d.decision&&d.by===native.name&&[item.id,runId].includes(d.id));
      if(!decision||![id,item.id,runId,entry.attempt,proof.original_sha256,proof.command_sha256].every(v=>decision.text.includes(v)))throw Error('queue reconciliation needs exact native supervisor decision');
      const old=events.filter(e=>e.type==='line-service.review-queue-reconciled'&&(e.id===id||e.project===c.identity&&e.org===c.org&&e.key===key));
      if(old.length){
        if(old.length!==1||old[0].id!==id||old[0].decision_seq!==decisionSeq||!resolvedQueuePlanning({events,state,repo:c.repo,org:c.org,identity:c.identity,item:item.id,run:runId,key,entry}))throw Error('original queue reconciliation already retained; no replacement');
        return{add:[],result:{result:'review_queue_reconciled',id,seq:old[0].seq,existing:true}};
      }
      const retained=reviewAttempt(item,{events,state,repo:c.repo,org:c.org,identity:c.identity,target:entry.review_target,capturedRun:runId,effects:journal,
        ignoreService:{file,key,target:entry.review_target,operation:'record-queue'}});
      if(retained)throw Error('another review attempt retained: '+retained);
      const bytes=Buffer.from(JSON.stringify({proof,original:entry,command:JSON.parse(reviewPlain(entry.commands[0].receipt))},null,2)+'\n'),archive=path.join(c.org,'evidence/review-queue-reconciliation',`${id}.json`);
      fs.mkdirSync(path.dirname(archive),{recursive:true});
      try{const fd=fs.openSync(archive,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch(e){if(e.code!=='EEXIST'||hash(reviewPlain(archive))!==hash(bytes))throw e;}
      guard();if(!same(readServiceJournal(file)?.actions[key],entry))throw Error('original queue attempt changed');
      return protectRecordMutation({org:c.org,events,state,command:'reconcile review queue',mutation:{add:[{
        type:'line-service.review-queue-reconciled',id,project:c.identity,org:c.org,item:item.id,run:runId,key,proof,
        decision_seq:decisionSeq,native_caller:native,claim_generation:run.owner_generation,owner:run.owner,
        source:{root,head:sourceHead,canonical_head:mainHead},archive:{file:archive,sha256:hash(bytes)},
      }],result:{result:'review_queue_reconciled',id,attempt:entry.attempt,existing:false}}});
    },{actor:native.name,strictTail:true,lockOptions:{recover:false}}).result;
  }finally{releasePromotion?.();releasePass?.();}
}
if(isMain(import.meta.url))try{
  const {values,positionals}=parseArgs({usage:'Usage: node line-service/review-queue-reconcile.mjs inspect|resolve --repo REPO --org ORG --run R-n [--attempt ORIGINAL | --resolution OWN.json --decision-seq N --id STABLE --role supervisor]',allowPositionals:true,options:Object.fromEntries(['repo','org','run','attempt','resolution','decision-seq','id','role'].map(k=>[k,{type:'string'}]))});
  if(positionals.length!==1||!['inspect','resolve'].includes(positionals[0]))throw Error('choose inspect or resolve');
  const options={...values,runId:values.run,decisionSeq:Number(values['decision-seq'])};
  console.log(JSON.stringify(positionals[0]==='inspect'?inspectReviewQueue(options):reconcileReviewQueue(options),null,2));
}catch(e){console.error(`queue reconciliation: ${e.message}`);process.exitCode=1;}
