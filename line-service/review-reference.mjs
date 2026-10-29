// Supported owner disposition into the existing append-only record, no launch.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {gitProject} from '../lib/project.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {fold,ancestors} from '../lib/state.mjs';
import {bundleRelease,checkBundle} from '../lib/releases.mjs';
import {readOwnedRun,requireController,assertOwner} from '../lib/run-owner.mjs';
import {readProjectPolicy} from '../lib/config-policy.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {identityRootAt} from '../messages/journal.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {lineContext} from './cutoff.mjs';
import {discoverChanges,publishLandedReviewEvidence} from './phase1.mjs';
import {typedReviewAttempt,reviewAttempt} from './review.mjs';
import {referenceProof,resolvedReference} from './review-reference-proof.mjs';
import {reviewDigest as hash,reviewPlain} from './review-resolutions.mjs';
import {parseArgs,isMain} from '../lib/cli-help.mjs';

const root=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function referenceFiles(org,run){
  const files=new Set((run.report?.artifacts??[]).filter(a=>typeof a==='string'&&/review|settle/i.test(a)&&/\.json(?:$|[ #])/.test(a)&&path.isAbsolute(a.split(/[ #]/)[0])).map(a=>a.split(/[ #]/)[0]));
  const dir=path.join(org,'evidence',run.item,run.id);
  if(fs.existsSync(dir)){
    if(fs.realpathSync(dir)!==dir||!fs.lstatSync(dir).isDirectory())throw Error('redirected source-owner review directory');
    for(const name of fs.readdirSync(dir))if(/review|settle/i.test(name)&&name.endsWith('.json'))files.add(path.join(dir,name));
  }
  return [...files].sort();
}
function observation({repo,org,runId,head,base}){
  const c=lineContext(repo,org),{events}=loadEvents(c.org),state=fold(events),run=state.runs.get(runId);
  if(!run)throw Error('source run is missing');
  const d=discoverChanges({events,state,repo:c.repo,org:c.org,identity:c.identity}),choices=d.changes.filter(change=>change.run.id===runId&&(!head||change.target.head===head));
  if(head&&(choices.length!==1||base!==choices[0].target.base))throw Error('exact landed source target is missing/ambiguous: '+d.holds.filter(h=>h.run===runId).map(h=>h.reason).join('; '));
  const ownerRoot=identityRootAt(c.identity),files=referenceFiles(c.org,run).map(file=>{
    if(file!==path.resolve(file)||!ownerRoot||!file.startsWith(ownerRoot+path.sep))return{file,error:'foreign reference stays UNKNOWN; no cross-identity read'};
    try{const bytes=reviewPlain(file),value=JSON.parse(bytes);return{file,sha256:hash(bytes),typed:typedReviewAttempt(value),value};}catch(e){return{file,error:e.message};}
  });
  return{c,events,state,run,choices,files,holds:d.holds.filter(h=>h.run===runId)};
}
export function inspectReviewReferences(options){
  const o=observation(options);
  return{project:o.c.identity,org:o.c.org,run:o.run.id,item:o.run.item,holds:o.holds,references:o.files,targets:o.choices.map(change=>({target:change.target,retained:reviewAttempt(change.item,{repo:o.c.repo,org:o.c.org,identity:o.c.identity,events:o.events,state:o.state,target:change.target,capturedRun:o.run.id}),reviews:[...o.state.items.values()].filter(q=>q.meta.review_source_item===o.run.item&&q.meta.review_source_run===o.run.id).map(q=>({item:q.id,target:q.meta.review_target}))}))};
}
export function resolveReviewReference({repo,org,runId,resolution,decisionSeq,id,role,cwd=process.cwd(),env=process.env,call}){
  if(role!=='supervisor'||!/^[-a-zA-Z0-9_]{1,80}$/.test(id??'')||!Number.isSafeInteger(decisionSeq))throw Error('reference disposition requires owning supervisor mode, stable id and scoped decision');
  if(!env.HERDR_BRAIN_ROOT||fs.realpathSync(env.HERDR_BRAIN_ROOT)!==root)throw Error('reference disposition requires matching actual source');
  const c=lineContext(repo,org),ownerRoot=identityRootAt(c.identity);
  const inside=file=>{if(typeof file!=='string'||!path.isAbsolute(file)||file!==path.resolve(file)||!ownerRoot||!file.startsWith(ownerRoot+path.sep))throw Error('review reference cannot read another identity');return file;};
  resolution=inside(resolution);const inputBytes=reviewPlain(resolution),input=JSON.parse(inputBytes);inside(input.reference);
  if(input.run!==runId||![input.head,input.base].every(v=>/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(v??'')))throw Error('reference disposition needs the exact source run/head/base');
  const bundle=bundleRelease(root),source=()=>bundleRelease(root).commit?checkBundle(root,{verifyFiles:true}).commit:git(root,['rev-parse','HEAD']);
  const sourceHead=source(),mainHead=git(c.repo,['rev-parse','HEAD']);
  const policyEnv={...env};for(const key of ['LANE_CONFIG','PROMOTE_CONFIG','MONITOR_SUPERVISOR_AGENT'])delete policyEnv[key];
  const bind=()=>{
    const b=nativeSender(c.org,{cwd,env,...(call?{call}:{})});
    const supervisor=readProjectPolicy(c.repo,'promote',policyEnv,{canonical:c.repo}).config.to;
    if(b.project.checkout!==c.repo||b.project.identity!==c.identity||!supervisor||b.native.name!==supervisor)throw Error('reference disposition requires the actual owning PROJECT SUPERVISOR');
    return b.native;
  };
  const native=bind(),tuple=n=>[n.name,n.cwd,n.pane_id,n.workspace_id,n.terminal_id,n.agent_session?.value];
  let releasePass,releasePromotion;
  try{
    releasePass=noticeLock(path.join(c.directory,'pass.lock'),{recover:false});
    releasePromotion=acquireLock(path.join(c.identity,'lane-promote.lock'));
    const guard=()=>{
      if(!same(tuple(bind()),tuple(native)))throw Error('native supervisor identity changed');
      if(gitProject(c.repo).identity!==c.identity||source()!==sourceHead||git(c.repo,['rev-parse','HEAD'])!==mainHead||!bundle.commit&&git(root,['status','--porcelain=v1'])||git(c.repo,['status','--porcelain=v1']))throw Error('reference disposition source/head/clean CAS changed');
      for(const file of [path.join(c.directory,'STOP'),path.join(c.repo,'.lane/supervisor/STOP'),path.join(c.repo,'.lane/supervisor/HOLD')])if(fs.existsSync(file))throw Error('STOP/HOLD prevents review reference disposition');
      if(hash(reviewPlain(resolution))!==hash(inputBytes))throw Error('reference disposition input changed');
    };
    guard();
    const o=observation({repo:c.repo,org:c.org,runId,head:input.head,base:input.base});
    if(o.choices.length!==1||input.item!==o.run.item||!o.files.some(f=>f.file===input.reference&&f.typed&&f.sha256===input.reference_sha256))throw Error('reference is not a readable typed source-owner reference for this exact target');
    const target=o.choices[0].target,request={id,item:input.item,run:runId,target,reference:input.reference,reference_sha256:input.reference_sha256,disposition:input.disposition,review_item:input.review_item??null,decision_seq:decisionSeq};
    return transact(c.org,(events,state)=>{
      guard();
      const run=state.runs.get(runId),item=state.items.get(input.item),owned=readOwnedRun(c.org,runId);
      requireController(owned,'brain');assertOwner(owned,{owner:run.owner,generation:run.owner_generation});
      if(!same(run,o.run)||[item,...ancestors(state,item.id)].some(i=>i.meta.hold||i.meta.held||i.meta.reserved||i.meta.operator_reserved))throw Error('source run changed or subject held/reserved');
      const decision=events.find(d=>d.seq===decisionSeq&&d.type==='note.added'&&d.decision&&d.by===native.name&&[item.id,runId].includes(d.id));
      if(!decision||![id,item.id,runId,target.head,input.reference_sha256,input.disposition].every(v=>typeof v==='string'&&decision.text.includes(v)))throw Error('reference disposition needs actual supervisor exact-reference decision');
      const old=events.filter(e=>e.type==='review.reference-resolved'&&(e.id===id||e.project===c.identity&&e.org===c.org&&e.item===item.id&&e.run===runId&&e.target.head===target.head&&e.reference===input.reference));
      if(old.length){
        const e=old[0];if(old.length!==1||e.id!==id||e.disposition!==request.disposition||e.decision_seq!==decisionSeq||e.review_item!==request.review_item||!resolvedReference({events,state,repo:c.repo,org:c.org,identity:c.identity,item:item.id,run:runId,target,file:input.reference}))throw Error('original reference disposition already retained; no replacement');
        return{add:[],result:{result:'review_reference_resolved',id,seq:e.seq,existing:true}};
      }
      publishLandedReviewEvidence(target);
      const proof=referenceProof({events,state,repo:c.repo,org:c.org,item:item.id,run:runId,target,input:request});
      if(proof.kind==='producer-record-no-attempt'){
        const retained=reviewAttempt(item,{repo:c.repo,org:c.org,identity:c.identity,events,state,target,capturedRun:runId,ignoredReferences:[input.reference]});
        if(retained)throw Error('producer retains another review attempt/UNKNOWN: '+retained);
      }
      const original=reviewPlain(input.reference),bytes=Buffer.from(JSON.stringify({request,proof,original:original.toString('base64')},null,2)+'\n');
      const file=path.join(c.org,'evidence/review-references',`${id}.json`);fs.mkdirSync(path.dirname(file),{recursive:true});
      try{const fd=fs.openSync(file,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch(e){if(e.code!=='EEXIST'||hash(reviewPlain(file))!==hash(bytes))throw e;}
      guard();if(hash(reviewPlain(input.reference))!==request.reference_sha256)throw Error('original review reference progressed');
      const mutation={add:[{type:'review.reference-resolved',...request,project:c.identity,org:c.org,native_caller:native,source:{root,head:sourceHead,canonical_head:mainHead},proof,archive:{file,sha256:hash(bytes)}}],result:{result:'review_reference_resolved',id,head:target.head,disposition:input.disposition,existing:false}};
      return protectRecordMutation({org:c.org,events,state,command:'resolve review reference',mutation});
    },{actor:native.name,strictTail:true,lockOptions:{recover:false}}).result;
  }finally{releasePromotion?.();releasePass?.();}
}

if(isMain(import.meta.url))try{
  const {values,positionals}=parseArgs({usage:'Usage: node line-service/review-reference.mjs inspect|resolve --repo REPO --org ORG --run R-n [--resolution OWN.json --decision-seq N --id STABLE --role supervisor]',allowPositionals:true,options:Object.fromEntries(['repo','org','run','resolution','decision-seq','id','role'].map(k=>[k,{type:'string'}]))});
  const options={...values,runId:values.run,decisionSeq:Number(values['decision-seq'])};
  if(positionals.length!==1||!['inspect','resolve'].includes(positionals[0]))throw Error('choose inspect or resolve');
  console.log(JSON.stringify(positionals[0]==='inspect'?inspectReviewReferences(options):resolveReviewReference(options),null,2));
}catch(e){console.error(`review reference: ${e.message}`);process.exitCode=1;}
