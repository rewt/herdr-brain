// Brain-only, explicitly recorded probation. This is neither a pin nor READY.
// Only canonical Brain source can issue authority; installed roots consume it.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {gitProject} from '../lib/project.mjs';
import {checkRelease,releaseHome,requireReadyAcceptance,projectPin,selectRelease,projectEnvironment} from '../lib/releases.mjs';
import {findOrgDir,loadEvents,transact} from '../lib/store.mjs';
import {requireRecordCompatibility} from '../lib/record-compatibility.mjs';
import {readPlainFile,plainDirectory} from '../lib/files.mjs';
import {readProjectPolicy} from '../lib/config-policy.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {canonical} from '../messages/schema.mjs';
import {withRuntimeLocks} from './runtime-locks.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {fold} from '../lib/state.mjs';
import {trialOwnerHold} from '../lib/item-launch-hold.mjs';
import {prepareDevelopmentRecovery,sealDevelopmentRecovery,verifyDevelopmentRecovery,recoveryNode} from './development-recovery.mjs';
import {legacyRecipientHistory,recipientChanges} from './recipient-history.mjs';
import {successorExtensions} from './probation-successor-history.mjs';
import {requireRecoveryEntry} from './recovery-admission.mjs';

const toolRoot=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>canonical(a)===canonical(b);
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_'))),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
function context(repo,org){
  const p=gitProject(repo,{env:projectEnvironment()});
  if(p.checkout!==p.canonical)throw Error('probation requires canonical Brain project');
  const discovered=findOrgDir({cwd:p.canonical,env:{...process.env,ORG_DIR:''}});
  if(!discovered||fs.realpathSync(discovered)!==fs.realpathSync(org))throw Error('probation record differs from actual project');
  org=fs.realpathSync(org);
  return{...p,repo:p.canonical,org,directory:path.join(org,'line-service',sha(JSON.stringify(p.identity)).slice(0,20))};
}
export function probationTuple(root,home){
  if(!path.isAbsolute(root??'')||fs.realpathSync(root)!==root)throw Error('probation requires exact immutable release root');
  const release=checkRelease(home,path.basename(root),{verifyFiles:true});
  if(release.root!==root)throw Error('probation candidate is outside the named release home');
  const manifest=readPlainFile(path.join(root,'.release-manifest.json'));
  const frozen=readPlainFile(path.join(root,'.release-validation.json')),validation=JSON.parse(frozen);
  if(validation.releaseMode!=='routine'||validation.payloadCommit!==release.commit||!validation.validation?.tree)
    throw Error('probation requires a frozen routine candidate, never synthetic READY');
  return{release,tree:validation.validation.tree,common:validation.common,manifest_sha256:sha(manifest),validation_sha256:sha(frozen),
    node:{executable:process.execPath,version:process.version,platform:process.platform,arch:process.arch}};
}
const tuple=probationTuple;
function trials(events,c){return events.filter(e=>e.type==='line-service.probation-authorized'&&e.project===c.identity&&e.org===c.org);}
function ended(events,c,id){return events.some(e=>['line-service.probation-withdrawn','line-service.probation-completed'].includes(e.type)&&e.project===c.identity&&e.org===c.org&&e.id===id);}
function archived(event,c){
  const ref=event.archive;
  if(!/^[-a-zA-Z0-9_]{1,80}$/.test(event.id??'')||ref?.file!==path.join(c.directory,'probation',event.id+'.json'))throw Error('probation authority archive binding differs');
  const bytes=readPlainFile(ref.file),a=JSON.parse(bytes);
  if(sha(bytes)!==ref.sha256||a.schema!=='brain-probation/v1'||a.id!==event.id||a.repo!==c.repo||a.org!==c.org||a.project!==c.identity||
      !same(a.scope,event.scope)||!same(a.owner,event.owner)||a.authority!==event.authority||a.scope.brain_common!==c.identity)
    throw Error('probation authority archive changed');
  const decision=a.authority&&event.authority;
  if(!Number.isSafeInteger(decision))throw Error('probation recorded authority is missing');
  return a;
}
export function authorityOwner(note,events){
  const state=fold(events),run=state.runs.get(note.id),item=state.items.get(run?.item??note.id);
  if(!item||run?.abandoned)throw Error('probation authority owning item/run is unavailable');
  const hold=trialOwnerHold(state,item.id);
  if(hold)throw Error(`probation authority HOLD: ${hold.reason}`);
}

// Reads only. A withdrawn trial can be read solely to validate an archived
// rollback/captured request, never to admit a new controller or worker.
export function probationRuntime(repo,{root,home=releaseHome(),events,allowEnded=false}={}){
  const org=findOrgDir({cwd:repo,env:{...process.env,ORG_DIR:''}});
  if(!org)return null;
  const c=context(repo,org);
  if(!events&&!fs.existsSync(path.join(c.directory,'probation')))return null;
  const loaded=events?{events}:loadEvents(c.org);
  if(loaded.tornTail)throw Error('incomplete record prevents probation admission');
  const found=trials(loaded.events,c).filter(e=>e.scope?.candidate?.release?.root===root||
    e.scope?.previous?.kind==='development-recovery'&&e.scope.previous.release.root===root||
    loaded.events.some(s=>s.type==='line-service.probation-successor-authorized'&&s.project===c.identity&&s.org===c.org&&s.trial===e.id&&s.candidate?.release.root===root));
  if(!found.length)return null;
  if(found.length!==1)throw Error('probation candidate authority is ambiguous; no replacement trial');
  const event=found[0],a=archived(event,c),note=loaded.events.find(e=>e.seq===a.authority);
  if(note?.type!=='note.added'||note.decision!==true||note.by!==a.owner.native.name||note.text!==`Brain probation authorized: ${sha(canonical(a.scope))}`)
    throw Error('probation exact recorded authority is missing');
  if(!allowEnded&&ended(loaded.events,c,event.id)){
    // Ending probation removes only its exception. A separately qualified,
    // normally accepted exact pin can later admit this same immutable bundle.
    try{
      const pin=projectPin(repo);
      if(pin?.release&&selectRelease(repo,home,{pin}).root===root){
        requireReadyAcceptance(checkRelease(home,pin.release,{verifyFiles:true}),home);
        requireRecordCompatibility(root,loaded.events);return null;
      }
    }catch{/* An ended trial never excuses a failed ordinary admission. */}
    throw Error('probation authority withdrawn/completed; no new admissions');
  }
  if(!allowEnded)authorityOwner(note,loaded.events);
  const previous=a.scope.previous;
  const candidateRoot=a.scope.candidate.release.root,candidateHome=path.dirname(path.dirname(candidateRoot));
  if(event.repo!==c.repo||a.scope.candidate.common!==c.identity||!same(tuple(candidateRoot,candidateHome),a.scope.candidate))throw Error('probation candidate/project tuple drifted');
  requireRecordCompatibility(root,loaded.events);
  if(previous.kind==='development-recovery')verifyDevelopmentRecovery(c,previous,loaded.events);
  else if(!allowEnded){
    const old=checkRelease(home,previous.release.id,{verifyFiles:true});requireReadyAcceptance(old,home);
    if(!same(old,previous.release)||sha(readPlainFile(path.join(old.root,'.release-manifest.json')))!==previous.manifest_sha256)throw Error('probation previous runtime changed');
    requireRecordCompatibility(old.root,loaded.events);
  }
  const extensions=successorExtensions(loaded.events,c,event);
  for(const extension of extensions){
    const successor=extension.scope.candidate;
    if(!same(tuple(successor.release.root,path.dirname(path.dirname(successor.release.root))),successor)||!same(extension.scope.node,recoveryNode()))throw Error('probation successor tuple/Node drifted');
  }
  const extension=extensions.find(e=>e.scope.candidate.release.root===root);
  const successor=extension?.scope.candidate;
  const selected=root===candidateRoot?a.scope.candidate.release:root===previous.release.root?previous.release:successor?.release;
  if(!selected||selected.root!==root)throw Error('probation successor authority/root differs');
  return{...selected,probation:{id:event.id,seq:event.seq,archive:event.archive,scope_sha256:sha(canonical(a.scope)),previous,
    ...(root===successor?.release.root?{successor:{seq:extension.event.seq,archive:extension.event.archive,scope_sha256:sha(canonical(extension.scope))}}:{})}};
}

export function probationControl({repo,org,id,fromRoot,targetRoot,authority,recoveryAuthority,finish,developmentRecovery=false,dryRun=false,expectedPlan,cwd=process.cwd(),env=process.env,call,command=spawnSync,home=releaseHome(),fault=()=>{}}={}){
  if(process.platform!=='darwin'||process.version!=='v20.19.4')throw Error('probation requires macOS and pinned Node 20.19.4');
  if(!/^[-a-zA-Z0-9_]{1,80}$/.test(id??''))throw Error('probation needs a stable --id');
  const c=context(repo,org);
  const bind=()=>{
    const b=nativeSender(c.org,{cwd,env,...(call?{call}:{})});
    const policy=readProjectPolicy(c.repo,'promote',env,{canonical:c.repo}).config;
    if(b.project.checkout!==c.repo||b.project.identity!==c.identity||!policy.to||b.native.name!==policy.to)
      throw Error('probation requires the recorded actual canonical native supervisor');
    return{project:b.project,native:{name:b.native.name,pane:b.native.pane_id,workspace:b.native.workspace_id,terminal:b.native.terminal_id,session:b.native.agent_session.value}};
  };
  const owner=bind();
  const clean=()=>{
    if(!same(bind(),owner))throw Error('probation native owner changed');
    const main=readProjectPolicy(c.repo,'lane',env,{canonical:c.repo}).config.main??'main';
    if(git(c.repo,['symbolic-ref','--short','HEAD'])!==main||git(c.repo,['status','--porcelain=v1','--untracked-files=all']))throw Error('probation requires clean canonical main');
    return git(c.repo,['rev-parse','HEAD']);
  };
  if(finish){
    if(!['withdrawn','completed'].includes(finish)||dryRun||expectedPlan||fromRoot||targetRoot||authority||recoveryAuthority||developmentRecovery)throw Error('withdraw/complete takes only the original trial id');
    // Revocation may contain a running line even during STOP/HOLD. It performs
    // no native input, stop, cancellation, restart or installation mutation.
    const unlock=noticeLock(path.join(c.directory,'control.lock'),{recover:false});
    try{return transact(c.org,events=>{
      clean();const found=trials(events,c).filter(e=>e.id===id);
      if(found.length!==1)throw Error('original probation authority is missing/ambiguous');
      const a=archived(found[0],c);
      let ownSource=false;try{const source=gitProject(toolRoot,{env:projectEnvironment()});ownSource=source.identity===c.identity&&source.checkout===toolRoot&&source.canonical===toolRoot;}catch{}
      let successorTool=false;
      if(!ownSource&&toolRoot!==a.scope.candidate.release.root){
        const runtime=probationRuntime(c.repo,{root:toolRoot,events,home,allowEnded:true});
        successorTool=runtime?.probation.id===id&&Boolean(runtime.probation.successor);
      }
      if(!ownSource&&toolRoot!==a.scope.candidate.release.root&&!successorTool)throw Error('probation withdrawal tool is outside its original Brain source/candidate/successor');
      if(ended(events,c,id))return{add:[],result:{existing:true,id,admissions:false}};
      return{add:[{type:`line-service.probation-${finish}`,id,project:c.identity,repo:c.repo,org:c.org,authority_seq:found[0].seq,archive:found[0].archive,native_caller:owner.native}],result:{id,admissions:false,captured_work_preserved:true,runtime_started:false}};
    },{actor:owner.native.name,strictTail:true,lockOptions:{recover:false}}).result;}finally{unlock();}
  }
  // This comparison derives Brain's real common directory from the issuing
  // product source. A consumer label/config/environment cannot nominate it.
  const source=gitProject(toolRoot,{env:projectEnvironment()});
  if(source.checkout!==toolRoot||source.checkout!==source.canonical||source.canonical!==c.repo||source.identity!==c.identity)throw Error('only canonical Brain development source can issue probation authority');
  const snapshot=()=>{
    const head=clean();
    for(const name of ['STOP','HOLD'])if(fs.existsSync(path.join(c.repo,'.lane/supervisor',name)))throw Error('project STOP/HOLD prevents probation authorization');
    const stop=readPlainFile(path.join(c.directory,'STOP'));if(!stop)throw Error('probation authorization requires service own STOP');
    const target=`gui/${process.getuid()}/dev.herdr.line.${path.basename(c.directory)}`;
    const service=command('/bin/launchctl',['print',target],{cwd:c.repo,encoding:'utf8'});
    if(service.error||service.status===0||!/could not find service/i.test(service.stderr??''))throw Error('probation requires positively stopped service; native refusal retained');
    const candidate=tuple(targetRoot,home);
    if(targetRoot===fromRoot||candidate.common!==c.identity||git(c.repo,['rev-parse',`${candidate.release.commit}^{tree}`])!==candidate.tree)
      throw Error('probation requires Brain candidate and exact retained previous accepted root');
    git(c.repo,['merge-base','--is-ancestor',candidate.release.commit,head]);
    const installation=readPlainFile(path.join(c.directory,'installation.json')),plist=readPlainFile(path.join(c.directory,'service.plist')),saved=JSON.parse(installation);
    let previous;
    if(developmentRecovery){
      if(fromRoot!==c.repo)throw Error('development recovery predecessor must be actual canonical Brain source');
      const loaded=loadEvents(c.org);if(loaded.tornTail)throw Error('incomplete record prevents development recovery');
      const cutovers=loaded.events.filter(e=>e.type==='line-service.cutover'&&e.project===c.identity&&e.org===c.org);
      if(cutovers.length!==1||cutovers[0].main!==git(c.repo,['symbolic-ref','--short','HEAD'])||
          loaded.events.some(e=>['line-service.runtime-migrated','line-service.runtime-upgraded','line-service.probation-switched'].includes(e.type)&&e.project===c.identity&&e.org===c.org))
        throw Error('development recovery requires original initial cutover/history');
      git(c.repo,['merge-base','--is-ancestor',cutovers[0].canonical_head,head]);
      legacyRecipientHistory(recipientChanges(loaded.events,c),{installation:saved,plist,cutover:cutovers[0]});
      previous=prepareDevelopmentRecovery(c,{id,head,installation,plist,cutover:cutovers[0],service:{loaded:false,native:service.stderr.trim()},stop_sha256:sha(stop),command});
    }else{
      const release=checkRelease(home,path.basename(fromRoot),{verifyFiles:true});requireReadyAcceptance(release,home);
      if(release.root!==fromRoot||saved.source!==fromRoot||!same(saved.runtime,release)||!(saved.migration||saved.fresh_install))throw Error('probation requires prior installed accepted runtime; development migration is separate');
      previous={release,manifest_sha256:sha(readPlainFile(path.join(release.root,'.release-manifest.json')))};
    }
    return{head,stop_sha256:sha(stop),installation,plist,scope:{schema:'brain-probation-scope/v1',brain_common:c.identity,repo:c.repo,org:c.org,candidate,
      previous,
      end:'explicit-withdrawal-or-completion',stable_ready:false}};
  };
  const initial=snapshot(),loaded=loadEvents(c.org);if(loaded.tornTail)throw Error('incomplete record prevents probation authority');
  const archiveFile=path.join(c.directory,'probation',id+'.json');
  const inspect=events=>{
    if(trials(events,c).some(e=>!ended(events,c,e.id)))throw Error('one probation already exists; preserve it and explicitly withdraw/complete');
    if(trials(events,c).some(e=>e.id===id||e.scope.candidate.release.root===targetRoot)||fs.existsSync(archiveFile))throw Error('existing/UNKNOWN probation authority retained; no replay or replacement');
    const directory=path.dirname(archiveFile);
    if(fs.existsSync(directory)){
      plainDirectory(directory,{create:false});
      const expected=trials(events,c).map(e=>e.id+'.json').sort();
      if(!same(fs.readdirSync(directory).sort(),expected))throw Error('existing/UNKNOWN probation authority retained; no replay or replacement');
    }
    if(developmentRecovery&&fs.existsSync(path.dirname(initial.scope.previous.release.root)))throw Error('existing/UNKNOWN development recovery retained; no replacement');
    requireRecordCompatibility(targetRoot,events);requireRecordCompatibility(fromRoot,events);
    return requireRecoveryEntry({candidate:targetRoot,recovery:fromRoot,events,authority:recoveryAuthority,
      owner:owner.native.name,validateOwner:authorityOwner});
  };
  const recoveryContract=inspect(loaded.events);
  const scopeSha=sha(canonical(initial.scope)),planSha=sha(canonical({id,owner,...initial,recovery_contract:recoveryContract}));
  const validate=()=>{if(!same(snapshot(),initial))throw Error('probation source/native CAS changed');};
  return withRuntimeLocks(c,{id,operation:'probation-authorize',dryRun,owner,validate},()=>{
    validate();
    if(dryRun)return{dry_run:true,id,scope:initial.scope,scope_sha256:scopeSha,plan_sha256:planSha,required_decision:`Brain probation authorized: ${scopeSha}`,runtime_started:false};
    if(expectedPlan!==planSha)throw Error('probation dry-run plan changed; exact --expected-plan required');
    return transact(c.org,events=>{
      validate();inspect(events);
      const note=events.find(e=>e.seq===Number(authority));
      if(note?.type!=='note.added'||note.decision!==true||note.by!==owner.native.name||note.text!==`Brain probation authorized: ${scopeSha}`)throw Error('probation needs exact recorded supervisor trial authority');
      authorityOwner(note,events);
      const archive={schema:'brain-probation/v1',id,repo:c.repo,org:c.org,project:c.identity,scope:initial.scope,owner,authority:note.seq,
        canonical_head:initial.head,stop_sha256:initial.stop_sha256,recovery_contract:recoveryContract,before:{installation:initial.installation,plist:initial.plist}};
      const bytes=JSON.stringify(archive)+'\n';plainDirectory(path.dirname(archiveFile));
      const fd=fs.openSync(archiveFile,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fault('intent');
      if(developmentRecovery){sealDevelopmentRecovery(c,initial.scope.previous);fault('recovery');}
      const ref={file:archiveFile,sha256:sha(bytes)};
      return{add:[{type:'line-service.probation-authorized',id,project:c.identity,repo:c.repo,org:c.org,scope:initial.scope,owner,authority:note.seq,archive:ref}],
        result:{id,authorized:true,archive:ref,candidate:initial.scope.candidate,runtime_started:false,stable_ready:false}};
    },{actor:owner.native.name,strictTail:true,lockOptions:{recover:false}}).result;
  });
}
