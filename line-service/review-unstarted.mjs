// Owner-only archival authorization. No native mutation, launch, journal edit,
// producer invention or review-item replacement occurs here.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {gitProject} from '../lib/project.mjs';
import {findOrgDir,loadEvents,transact} from '../lib/store.mjs';
import {fold,ancestors} from '../lib/state.mjs';
import {readOwnedRun,requireController,assertOwner} from '../lib/run-owner.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {identityRootAt} from '../messages/journal.mjs';
import {invokeHerdr} from '../supervisor/herdr-edge.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {lockRequest} from '../dispatch/request-lock.mjs';
import {lineDirectory} from './cutoff.mjs';
import {isQueueReview,validateQueuedReview} from './review-queue.mjs';
import {reviewDigest as hash,reviewPlain,unstartedSubject,unstartedRun,unstartedReviewProof} from './review-resolutions.mjs';

const root=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024}).trim();
const tuple=n=>[n.name,n.cwd,n.pane_id,n.workspace_id,n.terminal_id,n.agent_session?.value];
function immutable(file,bytes){
  try{const fd=fs.openSync(file,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  catch(e){if(e.code!=='EEXIST'||hash(reviewPlain(file))!==hash(bytes))throw e;}
}
function driverFiles(journal){
  const files=[],directory=journal+'.driver';
  if(fs.existsSync(directory)){
    const s=fs.lstatSync(directory);if(!s.isDirectory()||s.isSymbolicLink())throw Error('never-started driver evidence is redirected');
    for(const name of fs.readdirSync(directory).sort())files.push(path.join(directory,name));
  }
  if(fs.existsSync(journal+'.driver.log'))files.push(journal+'.driver.log');return files;
}
export function recoverUnstartedReview({repo,org,reviewId,resolution,decisionSeq,id,role,cwd=process.cwd(),env=process.env,call=invokeHerdr}){
  if(role!=='supervisor'||!/^[-a-zA-Z0-9_]{1,80}$/.test(id??'')||!Number.isSafeInteger(decisionSeq))throw Error('never-started recovery requires owning supervisor mode, stable id and scoped decision');
  const project=gitProject(repo);repo=project.canonical;org=fs.realpathSync(org);
  if(project.checkout!==repo||fs.realpathSync(findOrgDir({cwd:repo,env:{...env,ORG_DIR:''}})??'')!==org||!env.HERDR_BRAIN_ROOT||fs.realpathSync(env.HERDR_BRAIN_ROOT)!==root)throw Error('never-started recovery needs canonical project/record and matching source');
  const binding=nativeSender(org,{cwd,env,call}),identity=identityRootAt(project.identity);
  if(binding.project.checkout!==repo||binding.project.identity!==project.identity)throw Error('never-started caller is not its actual canonical native supervisor');
  resolution=path.resolve(resolution);
  if(!identity||!resolution.startsWith(identity+path.sep))throw Error('never-started resolution cannot read another owner');
  const inputBytes=reviewPlain(resolution),input=JSON.parse(inputBytes),journal=path.resolve(input.journal??'');
  if(input.review_item!==reviewId||path.dirname(journal)!==path.join(org,'dispatch'))throw Error('never-started resolution names another subject/journal');
  const bytes=reviewPlain(journal),job=JSON.parse(bytes),sourceHead=git(root,['rev-parse','HEAD']),mainHead=git(repo,['rev-parse','HEAD']);
  if(input.journal_sha256!==hash(bytes)||job.item!==reviewId||job.repo!==repo||job.org!==org||job.common!==project.identity||path.basename(journal)!==`${job.token}.json`||job.reviewQueueProtocol!==1||job.base!==job.reviewQueue?.head)throw Error('original full request/hash/project/target differs');
  const initial=loadEvents(org).events,state=fold(initial),q=state.items.get(reviewId),run=state.runs.get(job.run);
  if(!isQueueReview(q)||q.meta.review_round_cap!==1||!run||run.item!==q.id||q.runs.length!==1||q.runs[0]!==run.id||run.meta.dispatch_journal!==journal||run.meta.dispatch_attempt!==job.token||run.workspace!==job.workspace||JSON.stringify(q.meta.review_target)!==JSON.stringify(job.reviewQueue)||input.head!==job.reviewQueue.head||input.base!==job.reviewQueue.base)throw Error('never-started recovery needs one unchanged original normal queue run');
  const target=q.meta.review_target,subjectHash=hash(JSON.stringify(unstartedSubject(q))),runHash=hash(JSON.stringify(unstartedRun(run)));
  const decision=initial.find(e=>e.seq===decisionSeq&&e.type==='note.added'&&e.decision&&e.by===binding.native.name&&e.id===q.id&&[id,journal,hash(bytes),target.head].every(v=>e.text.includes(v)));
  if(!decision)throw Error('never-started recovery needs actual native supervisor exact-request decision');
  // Elapsed lock/capacity/implementation barriers are typed, not preparation
  // failures. Any other real error must name an actual changed source input.
  const transient=new Set(['DISPATCH_SESSION_CAP_LOCKED','DISPATCH_SESSION_CAP','DISPATCH_REVIEW_CAP','DISPATCH_IMPLEMENTATION_CHANGED']);
  let fixedInput;
  if(job.error&&!transient.has(job.failure?.code)){
    const fix=input.fix,previous=job.sourceSelection?.head;
    if(!fix?.why||!previous||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(fix.commit??'')||!fix.file||path.isAbsolute(fix.file)||fix.file.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('real preparation error requires its actual changed source input/fix, never timeout-only');
    git(root,['merge-base','--is-ancestor',previous,fix.commit]);git(root,['merge-base','--is-ancestor',fix.commit,sourceHead]);
    if(!git(root,['diff','--no-ext-diff','--no-textconv',previous,fix.commit,'--',fix.file]))throw Error('preparation fix did not change its named input');
    const file=path.join(root,fix.file),actual=reviewPlain(file),expected=execFileSync('git',['-C',root,'show',`${fix.commit}:${fix.file}`]);
    if(hash(actual)!==hash(expected))throw Error('preparation fixed input is no longer current');
    fixedInput={file,sha256:hash(actual),previous,commit:fix.commit,why:fix.why};
  }
  const files=[...new Set([resolution,journal,job.routeConfig,job.brief,target.evidence,...driverFiles(journal),...(fixedInput?[fixedInput.file]:[])])].map(original=>{
    if(typeof original!=='string'||!path.resolve(original).startsWith(identity+path.sep)&&original!==fixedInput?.file)throw Error('never-started evidence/source metadata missing or foreign');
    return{original,bytes:reviewPlain(original)};
  });
  const request={id,item:q.id,review_item:q.id,original_run:run.id,journal,journal_sha256:hash(bytes),target,subject:unstartedSubject(q),original_record:unstartedRun(run),subject_sha256:subjectHash,run_sha256:runHash,ownership:job.ownership,decision_seq:decisionSeq,native_caller:binding.native,source:{root,head:sourceHead,canonical_head:mainHead},fix:fixedInput??null,files:files.map(f=>({original:f.original,sha256:hash(f.bytes)}))},requestHash=hash(JSON.stringify(request));
  const guard=events=>{
    const fresh=fold(events),item=fresh.items.get(q.id),original=fresh.runs.get(run.id),native=nativeSender(org,{cwd,env,call}).native;
    if(JSON.stringify(tuple(native))!==JSON.stringify(tuple(binding.native)))throw Error('native supervisor identity changed before recovery');
    if(gitProject(repo).identity!==project.identity||git(root,['rev-parse','HEAD'])!==sourceHead||git(repo,['rev-parse','HEAD'])!==mainHead||git(repo,['status','--porcelain=v1'])||git(root,['status','--porcelain=v1']))throw Error('never-started source/head/clean CAS changed');
    for(const file of [path.join(lineDirectory(org,project.identity),'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])if(fs.existsSync(file))throw Error('STOP/HOLD prevents never-started recovery');
    if([item,...ancestors(fresh,q.id)].some(i=>!i||i.closed||i.meta.hold||i.meta.held||i.meta.reserved||i.meta.operator_reserved)||hash(JSON.stringify(unstartedSubject(item)))!==subjectHash||JSON.stringify(item.runs)!==JSON.stringify(q.runs)||hash(JSON.stringify(unstartedRun(original)))!==runHash)throw Error('never-started subject/run changed or held/reserved');
    for(const f of files)if(hash(reviewPlain(f.original))!==hash(f.bytes))throw Error('never-started original evidence changed');
    if(JSON.stringify(driverFiles(journal))!==JSON.stringify(files.filter(f=>f.original.startsWith(journal+'.driver')).map(f=>f.original)))throw Error('never-started driver progressed');
    if(job.stage!=='worker'||job.native_launch_attempted!==false||job.worker||job.launchProcess||job.sessionBinding||job.watcher||run.report||original.report||run.report_path&&fs.existsSync(run.report_path)||fs.existsSync(path.join(org,'watch',run.id+'.json')))throw Error('positive pre-native proof is missing/UNKNOWN or progressed');
    const worker=effectiveWorkerIdentity(original,fresh);
    if(worker.identity_conflict||['agent','pane','worker_workspace','terminal_id','agent_session_id'].some(k=>worker[k])||events.some(e=>(e.run===run.id||e.id===run.id)&&['run.session_bound','closeout.effect'].includes(e.type)))throw Error('original native/session outcome is UNKNOWN or started');
    if(/EPERM|EACCES|native refusal|foreign|identity|ownership|reserved|HOLD|STOP/i.test(job.error??''))throw Error('original native/identity/reserved refusal remains held');
    const claim=readOwnedRun(org,run.id);requireController(claim,'brain');if(!job.ownership)throw Error('original claim generation is UNKNOWN');assertOwner(claim,job.ownership);
    const actual=gitProject(job.workspace);if(actual.identity!==project.identity||actual.canonical!==repo||actual.checkout!==job.workspace||job.workspace===repo||git(job.workspace,['branch','--show-current'])!==`lane/${job.lane}`||git(job.workspace,['rev-parse','HEAD'])!==target.head||git(job.workspace,['status','--porcelain=v1']))throw Error('original lane/source binding changed or dirty');
    const inventory=JSON.parse(call('herdr',['agent','list']));
    if(inventory.error||!Array.isArray(inventory.result?.agents))throw Error('native absence is UNKNOWN; retain original');
    if(inventory.result.agents.some(a=>a.cwd&&fs.realpathSync(a.cwd)===job.workspace))throw Error('original native reviewer is present; retain original');
    if(events.some(e=>e.type==='change.reviewed'&&(e.review_item===q.id||e.item===q.meta.review_source_item&&e.head===target.head)||e.type==='review.verdict'&&(e.run===run.id||e.review_item===q.id)))throw Error('completed verdict remains retained');
    const attempts=fs.readdirSync(path.join(org,'dispatch')).filter(f=>f.endsWith('.json')&&!f.endsWith('.routes.json')).map(f=>path.join(org,'dispatch',f));
    if(attempts.some(f=>f!==journal&&JSON.parse(reviewPlain(f)).item===q.id))throw Error('another saved/UNKNOWN request remains held');
    const intents=events.filter(e=>e.type==='review.unstarted-intent'&&e.review_item===q.id);
    if(intents.some(e=>e.id!==id||e.request_sha256!==requestHash)||intents.length>1)throw Error('one never-started recovery intent already retained');
  };
  let locked,release;
  try{
    locked=lockRequest(journal);release=acquireLock(path.join(project.identity,'lane-promote.lock'));guard(loadEvents(org).events);
    const old=unstartedReviewProof({events:initial,state,org,common:project.identity,item:q});
    if(old){if(old.id!==id)throw Error('one never-started recovery already authorized');return{result:'unstarted_review_ready',review_item:q.id,authorization:old.seq,existing:true};}
    const intent=transact(org,events=>{guard(events);const old=events.find(e=>e.type==='review.unstarted-intent'&&e.id===id);return protectRecordMutation({org,events,state:fold(events),command:'archive never-started review',mutation:{add:old?[]:[{type:'review.unstarted-intent',id,item:q.id,review_item:q.id,project:project.identity,org,request,request_sha256:requestHash}],result:old?.seq}});},{actor:binding.native.name,strictTail:true,lockOptions:{recover:false}});
    const directory=path.join(org,'evidence/review-recovery',id);fs.mkdirSync(directory,{recursive:true});
    const archived=files.map((f,i)=>{const archive=path.join(directory,`${i}-${path.basename(f.original)}`);immutable(archive,f.bytes);return{original:f.original,archive,sha256:hash(f.bytes)};});
    const manifestBytes=Buffer.from(JSON.stringify({request,files:archived},null,2)+'\n'),manifest=path.join(directory,'manifest.json');immutable(manifest,manifestBytes);
    const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    return transact(org,events=>{
      guard(events);const seq=(events.at(-1)?.seq??0)+1,abandon=run.abandoned?[]:[{type:'run.abandoned',id:run.id,note:`Positively never-started original archived by ${id}; claim, journal and review history retained.`}],authorization={type:'review.unstarted-authorized',...request,project:project.identity,org,request_sha256:requestHash,intent_seq:intent.added[0]?.seq??intent.result,abandon_seq:run.abandoned?.seq??seq,archive:{file:manifest,sha256:hash(manifestBytes)},continuation_cap:1};
      const projected=[...events,...abandon.map((e,i)=>({...e,seq:seq+i,by:binding.native.name})),{...authorization,seq:seq+abandon.length,by:binding.native.name}],current=fold(projected);
      validateQueuedReview({item:current.items.get(q.id),state:current,events:projected,org,repo});
      return protectRecordMutation({org,events,state:fold(events),command:'authorize never-started review',mutation:{add:[...abandon,authorization],result:{result:'unstarted_review_ready',review_item:q.id,authorization:seq+abandon.length,head:target.head,dispatch_base:target.head,existing:false}}});
    },{actor:binding.native.name,strictTail:true,lockOptions:{recover:false}}).result;
  }finally{release?.();locked?.release();}
}
