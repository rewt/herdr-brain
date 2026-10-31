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
import {claimedCommitTokens,declaredSourceRanges} from '../settle/review-range.mjs';
import {queueConsumer,queueReviewMutation} from './review-queue.mjs';
import {lineDirectory} from './cutoff.mjs';
import {reviewDigest as hash,reviewPlain,reviewResolution,reviewPredecessor} from './review-resolutions.mjs';
import {serviceRecordBinding} from './record-inbox.mjs';
import {discoverChanges,capturedProducerTarget} from './phase1.mjs';
import {sameCapturedTarget,sameProducerQueue,capturedReviewCommits} from './review-group.mjs';
import {lockRequest} from '../dispatch/request-lock.mjs';
import {lookupProcess} from '../lib/processes.mjs';
import {implementationChangeOutcome} from '../dispatch/preflight.mjs';
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
function originalDriverFiles(journal){
  const directory=journal+'.driver',files=[];
  if(fs.existsSync(directory)){
    const s=fs.lstatSync(directory);if(!s.isDirectory()||s.isSymbolicLink())throw Error('original review driver evidence is redirected');
    for(const name of fs.readdirSync(directory).sort()){const file=path.join(directory,name);files.push({original:file,bytes:reviewPlain(file)});}
  }
  if(fs.existsSync(journal+'.driver.log'))files.push({original:journal+'.driver.log',bytes:reviewPlain(journal+'.driver.log')});return files;
}

// Progress is an original-request/record fingerprint across real passes, never
// an elapsed timer. Unattributed/multiple requests are retained, not absence.
export function observeReviewProgress({state,org,identity,pass,previous={}}){
  const directory=path.join(org,'dispatch'),jobs=[];
  if(fs.existsSync(directory))for(const name of fs.readdirSync(directory))if(name.endsWith('.json')&&!name.endsWith('.routes.json')){try{const file=path.join(directory,name),bytes=reviewPlain(file),job=JSON.parse(bytes);if(job.common===identity&&job.org===org)jobs.push({file,job,sha256:hash(bytes)});}catch{/* No positive request proof is derived from an unreadable file. */}}
  const progress={},candidates=[];
  for(const q of state.items.values()){
    if(!roleIs(q,'REV')||q.closed||q.meta.review_round_cap!==1||!q.meta.review_target||q.meta.hold||q.meta.held||q.meta.reserved||q.meta.operator_reserved||q.runs.some(id=>state.runs.get(id)?.report))continue;
    const matches=jobs.filter(j=>j.job.item===q.id);if(matches.length!==1)continue;const request=matches[0];
    const driver=originalDriverFiles(request.file).map(f=>({original:f.original,sha256:hash(f.bytes)})),signature=hash(JSON.stringify([q.meta,request.sha256,driver,q.runs.map(id=>{const r=state.runs.get(id);return[r?.id,r?.owner,r?.owner_generation,r?.abandoned,r?.meta];})])),old=previous[q.id],unchanged=old?.signature===signature&&old.pass<pass;
    progress[q.id]={signature,pass,stable_passes:unchanged?(old.stable_passes??1)+1:old?.pass===pass&&old.signature===signature?old.stable_passes:1,journal:request.file,request_sha256:request.sha256,driver_files:driver};
    if(unchanged)candidates.push(q.id);
  }
  return{progress,candidates};
}

// Routine recovery is service-owned and uses the existing archive + record
// queue path. A legacy unresolved native launch is never made zero by a missing
// run. Only a serialized pre-start barrier or a positively ended bound native
// process can establish inactivity. Original journals/flags remain unchanged.
export function recoverServiceReview({repo,org,reviewId,env=process.env,call=invokeHerdr,kill=process.kill,readProcess=pid=>lookupProcess(pid,{identityOnly:true})}){
  const binding=serviceRecordBinding({repo,org,env}),project=gitProject(repo),journalFile=path.join(binding.directory,'effects.json'),effects=JSON.parse(reviewPlain(journalFile)),progress=effects.review_progress?.[reviewId];
  if(!progress||progress.pass!==effects.pass_number||progress.stable_passes<2)throw Error('review has no unchanged original-request proof across real passes');
  const initial=loadEvents(org).events,state=fold(initial),q=state.items.get(reviewId),source=state.items.get(q?.meta.review_source_item),run=state.runs.get(q?.meta.review_source_run);
  if(!q||!source||!run||!run.report&&q.meta.review_target?.evidence_kind!=='native-landings/v1'||q.closed||q.runs.some(id=>state.runs.get(id)?.report)||!roleIs(q,'REV')||q.meta.review_round_cap!==1)throw Error('review progressed/completed or is not an owned normal queue attempt');
  const peers=[...state.items.values()].filter(i=>sameProducerQueue(i,source.id,run.id));
  const journal=progress.journal;if(path.dirname(journal)!==path.join(org,'dispatch'))throw Error('original review request is outside its owning record');
  const bytes=reviewPlain(journal),job=JSON.parse(bytes),target=q.meta.review_target,id=`service-${hash(JSON.stringify([source.id,run.id,target.reportHash,target.head])).slice(0,48)}`;
  const driver=originalDriverFiles(journal);if(JSON.stringify(driver.map(f=>({original:f.original,sha256:hash(f.bytes)})))!==JSON.stringify(progress.driver_files))throw Error('original reviewer driver progressed; observe its changed input');
  if(hash(bytes)!==progress.request_sha256||job.item!==q.id||job.repo!==repo||job.org!==org||job.common!==project.identity||path.basename(journal)!==`${job.token}.json`||job.reviewQueueProtocol!==1||JSON.stringify(job.reviewQueue)!==JSON.stringify(target))throw Error('original review request/source/target CAS changed');
  if(/EPERM|EACCES|native refusal|foreign|identity|reserved|HOLD|STOP/i.test(job.error??'')||q.meta.hold||q.meta.held||q.meta.reserved||q.meta.operator_reserved)throw Error('native/ownership/reserved refusal remains stopped; no automatic replacement');
  const prior=reviewResolution({events:initial,org,item:source.id,head:target.head});if(prior)throw Error('one exact producer replacement budget already spent');
  const current=discoverChanges({events:initial,state,repo,org,identity:project.identity,runId:run.id}).changes.find(c=>c.item.id===source.id&&c.run.id===run.id);
  if(!current||current.authorization)throw Error('historical/unknown target differs from its actual producer source; retain it');
  const originalScope=peers.length!==1||!sameCapturedTarget(target,current.target),validatePeers=fresh=>{
    capturedProducerTarget({repo,target,whole:current});const ours=new Set(capturedReviewCommits(target));
    for(const peer of fresh.items.values())if(peer.id!==q.id&&sameProducerQueue(peer,source.id,run.id)){
      capturedProducerTarget({repo,target:peer.meta.review_target,whole:current});if(capturedReviewCommits(peer.meta.review_target).some(h=>ours.has(h)))throw Error('overlapping/UNKNOWN original producer scopes remain held; no duplicate review');
    }
  };
  if(originalScope)validatePeers(state);
  const reviewRuns=q.runs.map(id=>state.runs.get(id));if(reviewRuns.length>1||reviewRuns.some(r=>r.abandoned||r.report||r.report_path&&fs.existsSync(r.report_path)))throw Error('original reviewer report/attempt needs intake or judgment, not replacement');
  const original=reviewRuns[0];
  if(original&&(job.run!==original.id||original.meta.dispatch_journal!==journal||original.meta.dispatch_attempt!==job.token))throw Error('original reviewer claim/request binding differs');
  if(original){const claim=readOwnedRun(org,original.id);requireController(claim,'brain');assertOwner(claim,{owner:original.owner,generation:original.owner_generation});}
  if(!original&&(job.run||initial.some(e=>e.type==='run.started'&&(e.item===q.id||e.meta?.dispatch_journal===journal||e.meta?.dispatch_attempt===job.token))))throw Error('original request has unbound record-start progress; retain it');
  const prestart=!original&&['open','start'].includes(job.stage)&&!job.worker&&!job.launchProcess&&!job.sessionBinding&&job.native_launch_attempted!==true;
  const implementationOutcome=implementationChangeOutcome(job);
  if(implementationOutcome&&prestart&&job.native_launch_attempted!==false)throw Error('old implementation-change outcome has UNKNOWN native launch evidence; retain original request');
  const zeroWorker=original&&job.stage==='worker'&&job.native_launch_attempted===false&&!job.worker&&!job.launchProcess&&!job.sessionBinding;
  const unprompted=original&&['watch','prompt'].includes(job.stage)&&job.native_launch_attempted===true&&job.worker&&!job.sessionBinding;
  const continueOriginal=zeroWorker||unprompted;
  if(continueOriginal){
    if(!job.ownership)throw Error('original continuation claim generation is UNKNOWN');
    assertOwner(readOwnedRun(org,original.id),job.ownership);
    if(zeroWorker&&['agent','pane','worker_workspace','terminal_id','agent_session_id'].some(k=>original.meta[k]))throw Error('zero-native barrier conflicts with recorded worker identity');
  }
  if(originalScope&&!prestart&&!continueOriginal)throw Error('partial/ambiguous producer attempts remain immutable; no replacement or retarget');
  if(!prestart&&!continueOriginal&&(!original||job.stage!=='complete'||!job.worker))throw Error('original native launch outcome remains UNKNOWN; no missing-run inference');
  const owner=readOwnedRun(org,run.id);requireController(owner,'brain');assertOwner(owner,{owner:run.owner,generation:run.owner_generation});queueConsumer({run,env});
  const authority={kind:'installed-service-progress',project:project.identity,org,installation:binding.installationFile,installation_sha256:hash(reviewPlain(binding.installationFile))};
  const guard=events=>{
    const live=serviceRecordBinding({repo,org,env});if(live.identity!==project.identity||hash(reviewPlain(binding.installationFile))!==authority.installation_sha256)throw Error('service source/installation changed');
    for(const file of [path.join(binding.directory,'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])if(fs.existsSync(file))throw Error('STOP/HOLD prevents routine review recovery');
    if(hash(reviewPlain(journal))!==hash(bytes)||hash(reviewPlain(target.evidence))!==target.reportHash||git(repo,['status','--porcelain=v1']))throw Error('original request/evidence/clean source changed');
    if(JSON.stringify(originalDriverFiles(journal).map(f=>({original:f.original,sha256:hash(f.bytes)})))!==JSON.stringify(progress.driver_files))throw Error('original review driver progressed before archival completion');
    assertOwner(readOwnedRun(org,run.id),{owner:run.owner,generation:run.owner_generation});
    if(original){assertOwner(readOwnedRun(org,original.id),{owner:original.owner,generation:original.owner_generation});if(original.report_path&&fs.existsSync(original.report_path))throw Error('original reviewer report appeared; retain it for intake');}
    if(events){const fresh=fold(events),old=fresh.items.get(q.id);if(old?.closed||old?.meta.hold||old?.meta.held||old?.meta.reserved||old?.meta.operator_reserved||JSON.stringify(old?.meta.review_target)!==JSON.stringify(target)||JSON.stringify(old?.runs)!==JSON.stringify(q.runs)||q.runs.some(id=>fresh.runs.get(id)?.report)||events.some(e=>e.type==='change.reviewed'&&e.item===source.id&&e.head===target.head))throw Error('review progressed, was held or received a verdict');
      if(originalScope)validatePeers(fresh);
      if(original&&events.some(e=>e.type==='closeout.effect'&&e.run===original.id&&['agent-exit-requested','shell-close-requested'].includes(e.outcome?.action)))throw Error('original native retirement intent remains retained');}
  };
  const native=args=>{let raw;try{raw=JSON.parse(call('herdr',args));}catch(e){if(args[0]==='pane'&&args[1]==='get'&&/"code"\s*:\s*"pane_not_found"/.test(e.message))return{error:{code:'pane_not_found'}};throw e;}if(raw.error){if(args[0]==='pane'&&args[1]==='get'&&raw.error.code==='pane_not_found')return raw;throw Error(JSON.stringify(raw.error));}return raw.result;};
  const inactive=()=>{
    const inventory=native(['agent','list']);if(!Array.isArray(inventory?.agents))throw Error('native absence inventory is incomplete; keep original review');
    const trees=git(repo,['worktree','list','--porcelain']).split('\n\n').filter(Boolean).map(block=>Object.fromEntries(block.split('\n').map(row=>{const n=row.indexOf(' ');return[row.slice(0,n),row.slice(n+1)];}))).filter(w=>w.branch===`refs/heads/lane/${job.lane}`);
    if(trees.length>1||trees.some(w=>w.HEAD!==target.head)||job.workspace&&trees[0]?.worktree!==job.workspace)throw Error('original review lane/source binding changed');
    const w=original&&effectiveWorkerIdentity(original,state),saved=job.worker;
    if(continueOriginal&&(trees.length!==1||git(job.workspace,['status','--porcelain=v1'])))throw Error('original continuation worktree/source is UNKNOWN or dirty');
    if(unprompted){
      if(trees.length!==1||!w?.agent||!w.pane||!w.worker_workspace||!w.terminal_id||!w.agent_session_id||w.identity_conflict||saved.agentName!==w.agent||saved.pane!==w.pane||saved.workspaceId!==w.worker_workspace||saved.terminalId!==w.terminal_id||saved.agentSessionId!==w.agent_session_id)throw Error('original unprompted native identity is UNKNOWN; owner must supply exact session qualification');
      const matches=inventory.agents.filter(a=>a.cwd===job.workspace||a.name===w.agent||a.pane_id===w.pane||a.agent_session?.value===w.agent_session_id);
      if(matches.length!==1)throw Error('original unprompted native presence is UNKNOWN/ambiguous');
      const a=native(['agent','get',w.agent])?.agent;
      if(!a||a.name!==w.agent||a.cwd!==job.workspace||a.pane_id!==w.pane||a.workspace_id!==w.worker_workspace||a.terminal_id!==w.terminal_id||a.agent_session?.value!==w.agent_session_id)throw Error('original unprompted native identity changed');
      if(!['idle','done'].includes(a.agent_status))return false;
      const process=job.launchProcess,observed=Number.isSafeInteger(process?.pid)&&process.identity&&readProcess(process.pid);
      if(!observed?.ok||observed.value?.pid!==process.pid||observed.value?.identity!==process.identity)throw Error('original unprompted process continuity is UNKNOWN');
      return true;
    }
    if(inventory.agents.some(a=>trees.some(t=>a.cwd===t.worktree)||w&&[w.agent&&a.name===w.agent,w.pane&&a.pane_id===w.pane,w.agent_session_id&&a.agent_session?.value===w.agent_session_id].some(Boolean)))return false;
    if(prestart||zeroWorker)return true;
    if(!w?.agent||!w.pane||!w.terminal_id||!w.agent_session_id||w.identity_conflict||saved.agentName!==w.agent||saved.pane!==w.pane||saved.terminalId!==w.terminal_id||saved.agentSessionId!==w.agent_session_id)throw Error('original reviewer native identity is UNKNOWN');
    const process=job.launchProcess??job.sessionBinding?.process;if(!Number.isSafeInteger(process?.pid)||!process.identity)throw Error('original reviewer process outcome is UNKNOWN');
    const observed=readProcess(process.pid);if(!observed?.ok)throw Error('original reviewer process outcome is UNKNOWN; retain attempt');
    if(observed.value!==null&&!(observed.value?.pid===process.pid&&typeof observed.value.identity==='string'&&observed.value.identity!==process.identity))return false;
    const pane=native(['pane','get',w.pane]);if(pane?.error?.code!=='pane_not_found')return false;
    return true;
  };
  let requestLock,release;
  try{
    guard(initial);try{requestLock=lockRequest(journal,{kill});}catch(e){if(/already running/.test(e.message))return{result:'review_retained',reason:'original request owner remains live'};throw e;}
    release=acquireLock(path.join(project.identity,'lane-promote.lock'));guard(loadEvents(org).events);if(!inactive())return{result:'review_retained',reason:'original native reviewer still present'};
    const sourceHead=git(repo,['rev-parse','HEAD']);git(repo,['merge-base','--is-ancestor',target.head,sourceHead]);
    if(prestart&&(originalScope||implementationOutcome)||continueOriginal){
      const preparation=`original-${hash(JSON.stringify([q.id,journal,hash(bytes),progress.signature])).slice(0,48)}`,old=initial.find(e=>['review.original-prestart','review.original-continuation'].includes(e.type)&&e.id===preparation);
      if(old)return{result:continueOriginal?'original_review_ready':'original_prestart_ready',review_item:q.id,journal,proof:old.seq,existing:true};
      const directory=path.join(org,'evidence/review-recovery',preparation);fs.mkdirSync(directory,{recursive:true});const files=[{original:journal,bytes},{original:target.evidence,bytes:reviewPlain(target.evidence)},...driver];
      const snapshots=files.map((f,i)=>{const archive=path.join(directory,`${i}-${path.basename(f.original)}`);immutable(archive,f.bytes);return{original:f.original,archive,sha256:hash(f.bytes)};}),manifest={id:preparation,review_item:q.id,target,request_sha256:hash(bytes),files:snapshots},manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),file=path.join(directory,'manifest.json');immutable(file,manifestBytes);const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      const type=continueOriginal?'review.original-continuation':'review.original-prestart',kind=zeroWorker?'typed-pre-native-worker-barrier':'bound-unprompted-original';
      const result=transact(org,events=>{guard(events);if(!inactive())throw Error('original reviewer changed before continuation confirmation');const existing=events.find(e=>e.type===type&&e.id===preparation);if(existing)return{add:[],result:existing.seq};return protectRecordMutation({org,events,state:fold(events),command:'original review continuation proof',mutation:{add:[{type,id:preparation,project:project.identity,org,review_item:q.id,item:source.id,run:run.id,journal,target,request_sha256:hash(bytes),original_native_launch_attempted:job.native_launch_attempted??null,...(continueOriginal?{kind,review_run:original.id,ownership:job.ownership}:{}),service_authority:authority,archive:{file,sha256:hash(manifestBytes)}}]}});},{actor:'line-service',strictTail:true,lockOptions:{recover:false}});
      return{result:continueOriginal?'original_review_ready':'original_prestart_ready',review_item:q.id,journal,proof:result.added[0]?.seq??result.result};
    }
    const effectRows=[];for(const [key,value]of Object.entries(effects.actions??{}))if(key.startsWith(`review:${source.id}:`)&&JSON.stringify(value.review_target)===JSON.stringify(target))effectRows.push({file:journalFile,key,sha256:hash(JSON.stringify(value))});
    let files=[{original:journal,bytes},{original:target.evidence,bytes:reviewPlain(target.evidence)},...driver,...(effectRows.length?[{original:journalFile,bytes:reviewPlain(journalFile)}]:[])];
    const proof={kind:prestart?'serialized-pre-record-start-barrier':zeroWorker?'typed-pre-native-worker-barrier':'confirmed-ended-bound-native',review_item:q.id,review_run:original?.id??null,original_journal:journal,request_sha256:hash(bytes),original_native_launch_attempted:job.native_launch_attempted??null,progress_signature:progress.signature};
    let request={id,item:source.id,run:run.id,target,service_authority:authority,inactivity:proof,files:files.map(f=>({original:f.original,sha256:hash(f.bytes)})),effects:effectRows};
    const prepared=initial.find(e=>e.type==='review.recovery-intent'&&e.id===id);
    if(prepared){
      for(const key of ['item','run','target','service_authority','inactivity','effects'])if(JSON.stringify(prepared[key])!==JSON.stringify(request[key]))throw Error('original routine recovery preparation changed; retain archive');
      if(JSON.stringify(prepared.files.map(f=>f.original))!==JSON.stringify(files.map(f=>f.original)))throw Error('original routine recovery inventory changed');
      files=files.map((f,i)=>{const archive=path.join(org,'evidence/review-recovery',id,`${i}-${path.basename(f.original)}`),old=fs.existsSync(archive)?reviewPlain(archive):f.bytes;if(hash(old)!==prepared.files[i].sha256)throw Error('original prepared review bytes are unavailable; retain intent');return{original:f.original,bytes:old};});
      request={...request,files:prepared.files};
    }
    const requestHash=hash(JSON.stringify(request));
    transact(org,events=>{guard(events);const old=events.find(e=>e.type==='review.recovery-intent'&&e.id===id);if(old&&old.request_sha256!==requestHash)throw Error('original routine recovery preparation changed; retain archive');return protectRecordMutation({org,events,state:fold(events),command:'queue-review progress recovery',mutation:{add:old?[]:[{type:'review.recovery-intent',...request,request_sha256:requestHash,project:project.identity,org}]}});},{actor:'line-service',strictTail:true,lockOptions:{recover:false}});
    const directory=path.join(org,'evidence/review-recovery',id);fs.mkdirSync(directory,{recursive:true});const archived=files.map((f,i)=>{guard();const archive=path.join(directory,`${i}-${path.basename(f.original)}`);immutable(archive,f.bytes);return{original:f.original,archive,sha256:hash(f.bytes)};});
    const manifest={...request,request_sha256:requestHash,files:archived},manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),manifestFile=path.join(directory,'manifest.json');immutable(manifestFile,manifestBytes);const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    return transact(org,events=>{
      guard(events);if(!inactive())throw Error('original reviewer became live before archival completion');if(git(repo,['rev-parse','HEAD'])!==sourceHead)throw Error('source CAS changed at routine archive completion');
      const fresh=fold(events),old=events.find(e=>e.type==='review.recovery-completed'&&e.item===source.id&&e.target?.head===target.head);if(old)return{add:[],result:{result:'review_queued',review_item:old.review_item,existing:true}};
      for(const row of effectRows)if(hash(JSON.stringify(JSON.parse(reviewPlain(row.file)).actions?.[row.key]))!==row.sha256)throw Error('original queue effect progressed before archival completion');
      const event={type:'review.recovery-completed',by:'line-service',id,item:source.id,run:run.id,target,project:project.identity,org,service_authority:authority,inactivity:proof,archive:{file:manifestFile,sha256:hash(manifestBytes)},archived_review_items:[q.id],replacement_cap:1,prior_caps_preserved:true,seq:events.at(-1).seq+1};
      const projected=[...events,event],queued=queueReviewMutation({state:fold(projected),events:projected,org,repo,runId:run.id,head:target.head,base:target.base,env:{...env,ORG_ACTOR:'line-service'}});event.review_item=queued.result.review_item;
      return protectRecordMutation({org,events,state:fresh,command:'queue-review progress recovery',mutation:{add:[event,{type:'item.closed',id:q.id,as:'dropped',note:`Confirmed inactive review archived by ${id}; no verdict claimed. One normal-route replacement ${event.review_item}; original evidence/native flags/cap retained.`},...(original?[{type:'run.abandoned',id:original.id,note:`Confirmed inactive review archived by ${id}; original callbacks/evidence retained, no verdict claimed.`}]:[]),...queued.add],result:queued.result}});
    },{actor:'line-service',strictTail:true,lockOptions:{recover:false}}).result;
  }finally{release?.();requestLock?.release();}
}
export function recoverInactiveReview({repo,org,runId,head,base,resolution,decisionSeq,id,role,predecessorPreparation,cwd=process.cwd(),env=process.env,call=invokeHerdr}){
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
  let verifyPreparation=()=>{};
  const guard=()=>{
    native();queueConsumer({run,env});assertOwner(readOwnedRun(org,runId),{owner:run.owner,generation:run.owner_generation});
    if(gitProject(repo).identity!==project.identity||git(repo,['rev-parse','HEAD'])!==sourceHead||git(repo,['status','--porcelain=v1']))throw Error('review recovery source/head/clean CAS changed');
    for(const file of [path.join(lineDirectory(org,project.identity),'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])if(fs.existsSync(file))throw Error('STOP/HOLD prevents review recovery');
    if(hash(reviewPlain(resolution))!==hash(inputBytes))throw Error('inactive resolution evidence changed');
    verifyPreparation(loadEvents(org).events);
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
    if(![head,base].every(value=>/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value??''))||head===base||!claimedCommitTokens(run.report.artifacts??[]).some(token=>head.startsWith(token)))throw Error('no positively claimed committed source tuple; admission/packet/no-code head is insufficient');
    for(const range of declaredSourceRanges(run.report.artifacts??[]).filter(r=>head.startsWith(r.head)))if(git(repo,['rev-parse',`${range.head}^{commit}`])!==head||git(repo,['rev-parse',`${range.base}^{commit}`])!==base)throw Error('declared source/base artifact differs from requested immutable tuple');
    git(repo,['merge-base','--is-ancestor',base,head]);const diff=git(repo,['diff','--no-ext-diff','--no-textconv',base,head]);if(!diff)throw Error('requested source has an empty/no-code delta');
    const evidence=path.resolve(org,run.report.file??'');if(evidence!==inside(input.evidence)||hash(reviewPlain(evidence))!==run.report.sha256)throw Error('immutable source report/evidence tuple changed');
    const start=initialEvents.find(e=>e.type==='run.started'&&e.id===runId),dispatch=start?.meta?.dispatch_journal;
    if(!dispatch?.startsWith(path.join(org,'dispatch')+path.sep))throw Error('original source dispatch attribution is missing');
    const saved=JSON.parse(reviewPlain(dispatch));if(saved.run!==runId||saved.item!==item.id||saved.common!==project.identity||saved.org!==org||saved.token!==start.meta.dispatch_attempt||saved.workspace!==run.workspace)throw Error('original source claim/project attribution changed');
    if(saved.base===head||saved.sourceSelection?.head===head&&saved.sourceSelection?.root&&gitProject(saved.sourceSelection.root).identity===project.identity)throw Error('admission head is not a delivered changed-source review target');
    const attempts=input.attempts.map(inside).map(original=>({original,bytes:reviewPlain(original)}));
    for(const attempt of attempts){let prior;try{prior=JSON.parse(attempt.bytes);}catch{continue;}if(prior.run===runId&&(prior.head===head||prior.deliveryRange?.head===head)&&prior.deliveryRange&&(prior.deliveryRange.head!==head||prior.deliveryRange.base!==base))throw Error('archived settle deliveryRange differs from requested immutable source tuple');}
    const target={head,base,reportHash:run.report.sha256,evidence,diff_sha256:hash(diff),dispatch,scope:{base,commits:git(repo,['rev-list','--reverse',`${base}..${head}`]).split('\n').filter(Boolean),claims:[head],unresolved:[],deferred:false}};
    const files=[...new Map([...new Set([resolution,evidence,inside(input.inactive.evidence)])].map(file=>[file,{original:file,bytes:reviewPlain(file)}]).concat(attempts.map(f=>[f.original,f]))).values()];
    const known=initialEvents.find(e=>(e.type==='change.reviewed'&&e.item===item.id&&e.head===head)||(e.type==='review.verdict'&&e.run===runId&&(e.reviewed_head??e.head)===head));
    const verdict=known?.verdict??known?.review?.verdict??files.map(f=>completedVerdict(f.bytes,head)).find(Boolean);if(verdict)return{result:'review_preserved',item:item.id,head,verdict};
    const prior=reviewResolution({events:initialEvents,org,item:item.id,head});if(prior){if(prior.event.id!==id)throw Error('one inactive replacement budget already spent');return{result:'review_queued',review_item:prior.event.review_item,source_item:item.id,head,existing:true};}
    const decision=initialEvents.find(e=>e.seq===decisionSeq&&e.type==='note.added'&&e.decision&&e.by===binding.native.name&&[item.id,runId].includes(e.id)&&e.text.includes(item.id)&&e.text.includes(head));
    if(!decision)throw Error('recovery needs the actual native supervisor scoped decision; no authority inferred from metadata');
    const predecessorArgs={org,project:project.identity,item:item.id,run:runId,target,caller:binding.native,id,decisionSeq,predecessor:predecessorPreparation,attempts:attempts.map(f=>({original:f.original,sha256:hash(f.bytes)}))},predecessor=predecessorPreparation?reviewPredecessor({...predecessorArgs,events:initialEvents}):undefined;
    if(predecessor&&predecessor.inactive_kind!==input.inactive.kind)throw Error('predecessor input correction cannot change its native inactivity disposition');
    if(predecessor)verifyPreparation=events=>{if(JSON.stringify(reviewPredecessor({...predecessorArgs,caller:native(),events}))!==JSON.stringify(predecessor))throw Error('predecessor preparation/archive changed at the mutation boundary');};
    verifyInactive(initialState);
    const effects=[];
    const serviceDirs=fs.existsSync(path.join(org,'line-service'))?fs.readdirSync(path.join(org,'line-service'),{withFileTypes:true}).filter(e=>e.isDirectory()):[];
    for(const dir of serviceDirs){
      const file=path.join(org,'line-service',dir.name,'effects.json');if(!fs.existsSync(file))continue;const bytes=reviewPlain(file),journal=JSON.parse(bytes);let used=false;
      for(const [key,value]of Object.entries(journal.actions??{}))if(/review/i.test(key)&&((key.includes(item.id)&&JSON.stringify(value).includes(head))||JSON.stringify(value).includes(runId))){effects.push({file,key,sha256:hash(JSON.stringify(value))});used=true;}
      if(used&&!files.some(f=>f.original===file))files.push({original:file,bytes});
    }
    const request={id,item:item.id,run:runId,target,decision_seq:decisionSeq,resolution_sha256:hash(inputBytes),files:files.map(f=>({original:f.original,sha256:hash(f.bytes)})),effects,...(predecessor?{predecessor_preparation:predecessor}:{})};
    const requestHash=hash(JSON.stringify(request));
    transact(org,events=>{guard();const old=events.find(e=>e.type==='review.recovery-intent'&&e.id===id);if(old&&old.request_sha256!==requestHash)throw Error('stable review recovery id has different source/evidence');return protectRecordMutation({org,events,state:fold(events),command:'queue-review recovery',mutation:{add:old?[]:[{type:'review.recovery-intent',...request,request_sha256:requestHash,project:project.identity,native_caller:native()}]}});},{actor:binding.native.name,strictTail:true,lockOptions:{recover:false}});
    const archiveDir=path.join(org,'evidence/review-recovery',id);fs.mkdirSync(archiveDir,{recursive:true});
    const archived=files.map((f,i)=>{guard();const archive=path.join(archiveDir,`${i}-${path.basename(f.original)}`);immutable(archive,f.bytes);return{original:f.original,archive,sha256:hash(f.bytes)};});
    const manifest={id,item:item.id,run:runId,target,request_sha256:requestHash,files:archived,effects,...(predecessor?{predecessor_preparation:predecessor}:{})},manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),manifestFile=path.join(archiveDir,'manifest.json');immutable(manifestFile,manifestBytes);const fd=fs.openSync(archiveDir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const final=transact(org,events=>{
      guard();const state=fold(events);verifyInactive(state);if(state.runs.get(runId)?.report.sha256!==run.report.sha256)throw Error('source report changed before archival completion');
      if(events.some(e=>e.type==='change.reviewed'&&e.item===item.id&&e.head===head))return{add:[],result:{result:'review_preserved',item:item.id,head}};
      for(const f of files)if(!effects.some(e=>e.file===f.original)&&hash(reviewPlain(f.original))!==hash(f.bytes))throw Error('original review evidence progressed before resolution; no replacement');
      for(const effect of effects){const current=JSON.parse(reviewPlain(effect.file));if(hash(JSON.stringify(current.actions?.[effect.key]))!==effect.sha256)throw Error('original review effect progressed before resolution; no replacement');}
      const old=events.find(e=>e.type==='review.recovery-completed'&&e.item===item.id&&e.target?.head===head);if(old)return{add:[],result:{result:'review_queued',review_item:old.review_item,existing:true}};
      const archivedItems=[...state.items.values()].filter(q=>q.meta.review_source_item===item.id&&q.meta.review_target?.head===head).map(q=>q.id);
      const event={type:'review.recovery-completed',id,item:item.id,run:runId,target,project:project.identity,org,decision_seq:decisionSeq,native_caller:native(),archive:{file:manifestFile,sha256:hash(manifestBytes)},archived_review_items:archivedItems,replacement_cap:1,prior_caps_preserved:true,...(predecessor?{predecessor_preparation:predecessor}:{}),seq:events.at(-1).seq+1};
      const projected=[...events,event],queued=queueReviewMutation({state:fold(projected),events:projected,org,repo,runId,head,base,env:{...env,ORG_ACTOR:binding.native.name},recoveryBinding:{...binding,native:event.native_caller}});event.review_item=queued.result.review_item;
      const retired=archivedItems.flatMap(qid=>[{type:'item.closed',id:qid,as:'dropped',note:`Inactive review attempt archived by ${id}; no verdict claimed. One exact-change replacement ${event.review_item}; original evidence/cap retained.`},
        ...state.items.get(qid).runs.filter(rid=>!state.runs.get(rid).report&&!state.runs.get(rid).abandoned).map(rid=>({type:'run.abandoned',id:rid,note:`Inactive review attempt archived by ${id}; no verdict or product completion claimed.`}))]);
      return protectRecordMutation({org,events,state,command:'queue-review recovery',mutation:{add:[event,...retired,...queued.add],result:queued.result}});
    },{actor:binding.native.name,strictTail:true,lockOptions:{recover:false}});
    return final.result;
  }finally{release();}
}
