// One exact successor of the original Brain trial. No service/native inputs,
// release acceptance or replacement trial are performed here.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {lineContext} from './cutoff.mjs';
import {runtimeHistory} from './runtime.mjs';
import {probationRuntime,probationTuple,authorityOwner} from './probation.mjs';
import {verifyDevelopmentRecovery,recoveryNode} from './development-recovery.mjs';
import {successorExtension,successorRows,successorFence,successorFenceBytes,successorDigest as sha,successorJSON as json} from './probation-successor-history.mjs';
import {inspectService,replacementPlist} from './migrate-runtime.mjs';
import {readPlainFile,plainDirectory,writeFileAtomic} from '../lib/files.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {canonical} from '../messages/schema.mjs';
import {readProjectPolicy,homePolicyDigest} from '../lib/config-policy.mjs';
import {gitProject} from '../lib/project.mjs';
import {captureProductCheckout} from '../lib/product-files.mjs';
import {projectEnvironment,releaseHome} from '../lib/releases.mjs';
import {requireRecordCompatibility} from '../lib/record-compatibility.mjs';
import {withRuntimeLocks} from './runtime-locks.mjs';
const toolRoot=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const same=(a,b)=>canonical(a)===canonical(b);
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{env:projectEnvironment(),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
function immutable(file,bytes){
  plainDirectory(path.dirname(file));const fd=fs.openSync(file,'wx',0o444);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}

export function probationSuccessor({repo,org,id,trial,fromRoot,targetRoot,rollback=false,authority,dryRun=false,expectedPlan,cwd=process.cwd(),env=process.env,
  command=spawnSync,call,home=releaseHome(),fault=()=>{}}={}){
  if(process.platform!=='darwin'||process.version!=='v20.19.4')throw Error('probation successor requires macOS and pinned Node 20.19.4');
  if(![id,trial].every(v=>/^[-a-zA-Z0-9_]{1,80}$/.test(v??''))||fromRoot===targetRoot)throw Error('probation successor needs original --trial, distinct exact roots and unique --id');
  const c=lineContext(repo,org);let source;
  try{source=gitProject(toolRoot,{env:projectEnvironment()});}
  catch(cause){throw Error('probation successor requires clean canonical Brain tool root',{cause});}
  if(source.checkout!==toolRoot||source.canonical!==toolRoot||source.identity!==c.identity||toolRoot!==c.repo)
    throw Error('probation successor requires clean canonical Brain tool root');
  const file=path.join(c.directory,'service.plist'),installationFile=path.join(c.directory,'installation.json');
  const extensionFile=path.join(c.directory,'probation-successors',trial+'.json');
  const ref={file:path.join(c.directory,'probation-successor-effects',id+'.json')};
  const bind=()=>{
    const b=nativeSender(c.org,{cwd,env,...(call?{call}:{})}),policy=readProjectPolicy(c.repo,'promote',env,{canonical:c.repo}).config;
    if(b.project.checkout!==c.repo||b.project.identity!==c.identity||b.native.name!==policy.to)throw Error('probation successor requires recorded actual canonical native supervisor');
    return{project:b.project,native:{name:b.native.name,pane:b.native.pane_id,workspace:b.native.workspace_id,terminal:b.native.terminal_id,session:b.native.agent_session.value}};
  };
  const owner=bind();
  const policies=()=>({home:homePolicyDigest(c.repo,env),files:['lane','promote'].map(kind=>{
    const p=readProjectPolicy(c.repo,kind,env,{canonical:c.repo});
    return{kind,file:p.file,config:p.config,bytes:p.file&&fs.existsSync(p.file)?readPlainFile(p.file):null};
  })});
  const snapshot=events=>{
    if(!same(bind(),owner))throw Error('probation successor native owner changed');
    for(const name of ['STOP','HOLD'])if(fs.existsSync(path.join(c.repo,'.lane/supervisor',name)))throw Error('project STOP/HOLD prevents probation successor');
    const main=readProjectPolicy(c.repo,'lane',env,{canonical:c.repo}).config.main??'main';
    if(git(c.repo,['symbolic-ref','--short','HEAD'])!==main||git(c.repo,['status','--porcelain=v1','--untracked-files=all']))throw Error('probation successor requires clean canonical main');
    const head=git(c.repo,['rev-parse','HEAD']),captured=captureProductCheckout(c.repo,head);
    const stop=readPlainFile(path.join(c.directory,'STOP'));if(!stop)throw Error('probation successor requires service own STOP');
    const originals=events.filter(e=>e.type==='line-service.probation-authorized'&&e.project===c.identity&&e.org===c.org&&e.id===trial);
    if(originals.length!==1)throw Error('original probation trial missing/ambiguous');
    const original=originals[0],p=original.scope.previous;
    if(p.kind!=='development-recovery'||original.owner.native.name!==owner.native.name)throw Error('successor requires original development trial owner');
    const originalNote=events.find(e=>e.seq===original.authority);authorityOwner(originalNote,events);
    // Active original admission validates its untouched note/archive and owner.
    const admitted=probationRuntime(c.repo,{root:p.release.root,events,home});
    if(admitted?.probation.id!==trial)throw Error('successor original authority differs');
    verifyDevelopmentRecovery(c,p,events);
    git(c.repo,['merge-base','--is-ancestor',p.original.cutover.canonical_head,head]);
    git(c.repo,['merge-base','--is-ancestor',p.source.commit,head]);
    const extension=successorExtension(events,c,original),rows=successorRows(events,c);
    if(rows.some(e=>e.id===id))throw Error('completed successor id retained; no replay');
    const installation=readPlainFile(installationFile),saved=JSON.parse(installation),plist=readPlainFile(file);
    const service=inspectService(saved.target,c.repo,command);if(service.loaded)throw Error('probation successor requires positively stopped service');
    const history=runtimeHistory(events,{...c,installation:saved,cutover:p.original.cutover,root:saved.source});
    if(saved.source!==fromRoot)throw Error('successor current root differs from saved installation');
    const candidateRoot=rollback?fromRoot:targetRoot,candidate=probationTuple(candidateRoot,home);
    if(candidateRoot===original.scope.candidate.release.root||candidateRoot===p.release.root||candidate.common!==c.identity||
        git(c.repo,['rev-parse',`${candidate.release.commit}^{tree}`])!==candidate.tree)throw Error('successor requires a new exact Brain candidate');
    git(c.repo,['merge-base','--is-ancestor',candidate.release.commit,head]);
    // A future bundle must actually carry this reader; frozen cfc is immutable.
    for(const name of ['probation-successor.mjs','probation-successor-history.mjs','probation.mjs','development-recovery.mjs','runtime.mjs','launchd.mjs']){
      const relative='line-service/'+name;
      if(readPlainFile(path.join(candidateRoot,relative))!==readPlainFile(path.join(c.repo,relative)))throw Error('successor candidate protocol differs from canonical tool');
    }
    if(rollback?targetRoot!==p.release.root:fromRoot!==p.release.root)throw Error('successor supports recovery entry, deliberate --rollback and exact return only');
    if(rollback&&!extension)throw Error('successor rollback requires completed entry');
    if(extension&&!same(candidate,extension.scope.candidate))throw Error('successor exact authority tuple changed');
    if(!extension&&(history.last.type!=='line-service.probation-switched'||saved.source!==p.release.root))throw Error('successor requires completed legacy recovery anchor');
    requireRecordCompatibility(candidateRoot,events);requireRecordCompatibility(p.release.root,events);
    const successorScope=extension?.scope??{schema:'brain-probation-successor/v1',trial,repo:c.repo,org:c.org,identity:c.identity,owner,
      original:{seq:original.seq,archive:original.archive,scope_sha256:admitted.probation.scope_sha256,recovery_sha256:sha(canonical(p))},
      candidate,node:recoveryNode()};
    if(!same(successorScope.node,recoveryNode()))throw Error('successor Node integrity changed');
    const extensionRef=extension?.event.archive??{file:extensionFile,sha256:sha(json(successorScope))};
    const anchor=history.successor.anchor;
    const after=rollback?anchor.installation:json({...JSON.parse(anchor.installation),source:targetRoot,runtime:candidate.release});
    const nextPlist=rollback?anchor.plist:replacementPlist(c,saved,command,targetRoot);
    return{head,source_sha256:sha(canonical(captured)),policies:policies(),record_sha256:sha(canonical(events.filter(e=>e.seq!==Number(authority)))),
      owner_id:originalNote.id,installation,plist,service,stop_sha256:sha(stop),last_seq:history.last.seq,
      extension:extensionRef,successor_scope:successorScope,new_extension:!extension,
      scope_sha256:admitted.probation.scope_sha256,recovery_sha256:sha(canonical(p)),
      after:{installation:after,plist:nextPlist},runtime:rollback?p.release:candidate.release,
      fences:Object.fromEntries(history.successor.fences)};
  };
  const loaded=loadEvents(c.org);if(loaded.tornTail)throw Error('incomplete record prevents probation successor');
  const initial=snapshot(loaded.events);
  const a={schema:'brain-probation-successor-effect/v1',id,trial,repo:c.repo,org:c.org,identity:c.identity,owner,
    canonical_head:initial.head,source_sha256:initial.source_sha256,policies:initial.policies,record_sha256:initial.record_sha256,
    source:targetRoot,previous_source:fromRoot,previous_seq:initial.last_seq,rollback,
    extension:initial.extension,successor_scope:initial.successor_scope,scope_sha256:initial.scope_sha256,recovery_sha256:initial.recovery_sha256,
    stop_sha256:initial.stop_sha256,service:initial.service,runtime:initial.runtime,
    before:{installation:initial.installation,plist:initial.plist},after:initial.after};
  const bytes=json(a);ref.sha256=sha(bytes);
  const required_decision=`Brain probation successor authorized: ${id} ${ref.sha256}`;
  const validate=events=>{
    const loaded=events?{events}:loadEvents(c.org);
    if(loaded.tornTail||!same(snapshot(loaded.events),initial))throw Error('probation successor source/record/config/native CAS changed');
  };
  const effectGuard=(events,installation,plist)=>{
    if(!same(bind(),owner)||!same(policies(),initial.policies)||
        sha(canonical(captureProductCheckout(c.repo,initial.head)))!==initial.source_sha256)throw Error('successor source/native/policy CAS changed; original intent retained');
    for(const name of ['STOP','HOLD'])if(fs.existsSync(path.join(c.repo,'.lane/supervisor',name)))throw Error('project STOP/HOLD prevents successor effect');
    const original=events.find(e=>e.type==='line-service.probation-authorized'&&e.project===c.identity&&e.org===c.org&&e.id===trial);
    authorityOwner(events.find(e=>e.seq===original.authority),events);
    if(events.some(e=>['line-service.probation-withdrawn','line-service.probation-completed'].includes(e.type)&&e.project===c.identity&&e.org===c.org&&e.id===trial))throw Error('original probation ended; successor effect held');
    verifyDevelopmentRecovery(c,original.scope.previous,events);
    if(!same(probationTuple(initial.successor_scope.candidate.release.root,home),initial.successor_scope.candidate)||
        inspectService(JSON.parse(installation).target,c.repo,command).loaded||sha(readPlainFile(path.join(c.directory,'STOP')))!==initial.stop_sha256||
        readPlainFile(file)!==plist||readPlainFile(installationFile)!==installation)throw Error('successor runtime/config/STOP CAS changed; original intent retained');
  };
  return withRuntimeLocks(c,{id,operation:'probation-successor',dryRun,owner,validate},()=>{
    validate();
    const result={id,trial,archive:ref,extension:initial.extension,plan_sha256:ref.sha256,scope_sha256:initial.scope_sha256,
      recovery_sha256:initial.recovery_sha256,runtime:initial.runtime,stopped:true,runtime_started:false,stable_ready:false};
    if(dryRun)return{...result,dry_run:true,required_decision,successor_scope:initial.successor_scope};
    if(expectedPlan!==ref.sha256)throw Error('probation successor dry-run plan changed; exact --expected-plan required');
    const completed=transact(c.org,events=>{
      validate(events);
      const note=events.find(e=>e.seq===Number(authority));
      if(note?.type!=='note.added'||!note.decision||note.by!==owner.native.name||note.id!==initial.owner_id||note.text!==required_decision)
        throw Error('probation successor needs exact original-owner supervisor effect authority');
      authorityOwner(note,events);
      // The OLD reader's extra-file fence must exist before ANY intent/config.
      immutable(successorFence(c,id),successorFenceBytes({...a,archive:ref}));fault('fence');
      effectGuard(events,initial.installation,initial.plist);
      if(initial.new_extension)immutable(extensionFile,json(initial.successor_scope));fault('authority');
      effectGuard(events,initial.installation,initial.plist);
      immutable(ref.file,bytes);fault('intent');
      effectGuard(events,initial.installation,initial.plist);
      writeFileAtomic(file,a.after.plist,0o600);fault('plist');
      effectGuard(events,initial.installation,a.after.plist);
      const after=JSON.parse(a.after.installation);
      const next=rollback?a.after.installation:json({...after,probation_successor:{trial,id,...ref,extension:initial.extension}});
      writeFileAtomic(installationFile,next,0o600);fault('installation');
      effectGuard(events,next,a.after.plist);
      const base={id,trial,project:c.identity,repo:c.repo,org:c.org,authority:note.seq,native_caller:owner.native,runtime_started:false};
      return{add:[...(initial.new_extension?[{...base,type:'line-service.probation-successor-authorized',archive:initial.extension,
        candidate:initial.successor_scope.candidate,plan_sha256:ref.sha256}]:[]),
        {...base,type:'line-service.probation-successor-switched',source:targetRoot,previous_source:fromRoot,previous_seq:initial.last_seq,rollback,runtime:initial.runtime,archive:ref}],result:{...result,switched:true}};
    },{actor:owner.native.name,strictTail:true,lockOptions:{recover:false}});
    fault('completion');
    if(rollback){
      // Only a durable COMPLETED rollback can clear the OLD reader's fence.
      // A crash here remains held; it is never treated as an uncertain replay.
      const event=completed.added.at(-1),fences={...initial.fences,[id]:successorFenceBytes({...a,archive:ref})};
      transact(c.org,events=>{
        const prior=events.filter(e=>!completed.added.some(a=>a.seq===e.seq)&&e.seq!==Number(authority));
        if(sha(canonical(prior))!==initial.record_sha256)throw Error('successor record CAS changed before fence clear; retain');
        effectGuard(events,a.after.installation,a.after.plist);
        immutable(path.join(c.directory,'probation-successor-clears',id+'.json'),json({schema:'brain-probation-successor-clear/v1',trial,id,
          completion_seq:event.seq,archive:ref,fences}));fault('clear-receipt');
        for(const [effect,expected]of Object.entries(fences)){
          effectGuard(events,a.after.installation,a.after.plist);
          if(readPlainFile(successorFence(c,effect))!==expected||(fs.statSync(successorFence(c,effect)).mode&0o222))throw Error('completed rollback fence changed; retain');
          fs.unlinkSync(successorFence(c,effect));
        }
        fault('clear');return{add:[]};
      },{actor:owner.native.name,strictTail:true,lockOptions:{recover:false}});
    }
    return completed.result;
  });
}
