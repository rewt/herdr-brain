// Explicit, separately authorized stopped effects within one original trial.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {lineContext} from './cutoff.mjs';
import {runtimeRoot,runtimeHistory} from './runtime.mjs';
import {probationRuntime,authorityOwner} from './probation.mjs';
import {verifyDevelopmentRecovery,developmentSourceMatches,recoveryDigest as sha} from './development-recovery.mjs';
import {inspectService,replacementPlist} from './migrate-runtime.mjs';
import {readPlainFile,plainDirectory,writeFileAtomic} from '../lib/files.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {canonical} from '../messages/schema.mjs';
import {readProjectPolicy} from '../lib/config-policy.mjs';
import {gitProject} from '../lib/project.mjs';
import {projectEnvironment,releaseHome} from '../lib/releases.mjs';
import {requireRecordCompatibility} from '../lib/record-compatibility.mjs';
import {withRuntimeLocks} from './runtime-locks.mjs';
const same=(a,b)=>canonical(a)===canonical(b),json=v=>JSON.stringify(v)+'\n';
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{env:projectEnvironment(),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();

export function probationSwitch({repo,org,id,trial,fromRoot,targetRoot,authority,dryRun=false,expectedPlan,cwd=process.cwd(),env=process.env,
  command=spawnSync,call,home=releaseHome(),fault=()=>{}}={}){
  if(process.platform!=='darwin'||process.version!=='v20.19.4')throw Error('probation switch requires macOS and pinned Node 20.19.4');
  if(![id,trial].every(v=>/^[-a-zA-Z0-9_]{1,80}$/.test(v??''))||fromRoot===targetRoot)throw Error('probation switch needs original --trial, distinct roots and stable effect --id');
  const c=lineContext(repo,org),file=path.join(c.directory,'service.plist'),installationFile=path.join(c.directory,'installation.json');
  const archiveFile=path.join(c.directory,'probation-switches',id+'.json');
  const bind=()=>{
    const b=nativeSender(c.org,{cwd,env,...(call?{call}:{})});
    const policy=readProjectPolicy(c.repo,'promote',env,{canonical:c.repo}).config;
    if(b.project.checkout!==c.repo||b.project.identity!==c.identity||!policy.to||b.native.name!==policy.to)throw Error('probation switch requires recorded actual canonical native supervisor');
    return{project:b.project,native:{name:b.native.name,pane:b.native.pane_id,workspace:b.native.workspace_id,terminal:b.native.terminal_id,session:b.native.agent_session.value}};
  };
  const owner=bind();
  const snapshot=events=>{
    if(!same(bind(),owner))throw Error('probation switch native owner changed');
    for(const name of ['STOP','HOLD'])if(fs.existsSync(path.join(c.repo,'.lane/supervisor',name)))throw Error('project STOP/HOLD prevents probation switch');
    const main=readProjectPolicy(c.repo,'lane',env,{canonical:c.repo}).config.main??'main';
    if(git(c.repo,['symbolic-ref','--short','HEAD'])!==main||git(c.repo,['status','--porcelain=v1','--untracked-files=all']))throw Error('probation switch requires clean canonical main');
    const stop=readPlainFile(path.join(c.directory,'STOP'));if(!stop)throw Error('probation switch requires service own STOP');
    const authorities=events.filter(e=>e.type==='line-service.probation-authorized'&&e.project===c.identity&&e.org===c.org&&e.id===trial);
    if(authorities.length!==1)throw Error('original probation trial missing/ambiguous');
    const event=authorities[0],scope=event.scope,previous=scope.previous;
    authorityOwner(events.find(e=>e.seq===event.authority),events);
    if(previous.kind!=='development-recovery')throw Error('probation switch requires typed development recovery; installed-root upgrades retain their existing command');
    const runtime=probationRuntime(c.repo,{root:scope.candidate.release.root,events,home,allowEnded:true});
    if(runtime?.probation.id!==trial||event.owner.native.name!==owner.native.name)throw Error('probation switch trial owner differs');
    verifyDevelopmentRecovery(c,previous,events);
    const allowed=[scope.candidate.release.root,previous.release.root];
    if(!allowed.includes(targetRoot)||![c.repo,...allowed].includes(fromRoot))throw Error('probation switch roots outside original trial');
    if(targetRoot===scope.candidate.release.root)probationRuntime(c.repo,{root:targetRoot,events,home});
    // Either original canonical issuing source or an exact sealed trial tool.
    if(!allowed.includes(runtimeRoot)){
      const source=gitProject(runtimeRoot,{env:projectEnvironment()});
      if(source.checkout!==runtimeRoot||source.canonical!==c.repo||source.identity!==c.identity)throw Error('probation switch tool is outside original Brain source/trial');
    }
    requireRecordCompatibility(targetRoot,events);
    const installation=readPlainFile(installationFile),saved=JSON.parse(installation),plist=readPlainFile(file);
    const service=inspectService(saved.target,c.repo,command);if(service.loaded)throw Error('probation switch requires positively stopped service');
    const rows=events.filter(e=>e.type==='line-service.probation-switched'&&e.project===c.identity&&e.org===c.org);
    const folder=path.dirname(archiveFile);
    if(fs.existsSync(folder)){
      plainDirectory(folder,{create:false});
      if(!same(fs.readdirSync(folder).sort(),rows.map(e=>e.id+'.json').sort()))throw Error('existing/UNKNOWN probation switch retained; no replay or replacement');
    }else if(rows.length)throw Error('probation switch archive missing');
    if(rows.some(e=>e.id===id))throw Error('completed probation switch id retained; no replay');
    const cutover=previous.original.cutover;
    if(!same(events.find(e=>e.seq===cutover.seq),cutover))throw Error('probation switch original cutover changed');
    git(c.repo,['merge-base','--is-ancestor',cutover.canonical_head,'HEAD']);
    let last;
    if(!rows.length){
      if(fromRoot!==c.repo||targetRoot!==scope.candidate.release.root||installation!==previous.original.installation||plist!==previous.original.plist)
        throw Error('probation initial entry differs from original development installation');
      last=cutover;
    }else last=runtimeHistory(events,{...c,installation:saved,cutover,root:saved.source}).last;
    if(rows.length?saved.source!==fromRoot:!developmentSourceMatches(saved.source,fromRoot))throw Error('probation switch current root differs from saved installation');
    return{head:git(c.repo,['rev-parse','HEAD']),installation,plist,last_seq:last.seq,scope_sha256:runtime.probation.scope_sha256,
      recovery_sha256:sha(canonical(previous)),stop_sha256:sha(stop),service,previous,
      runtime:targetRoot===scope.candidate.release.root?scope.candidate.release:previous.release};
  };
  const loaded=loadEvents(c.org);if(loaded.tornTail)throw Error('incomplete record prevents probation switch');
  const initial=snapshot(loaded.events),base=JSON.parse(initial.previous.derived.installation);
  const after={...base,source:targetRoot,runtime:initial.runtime};
  const nextPlist=targetRoot===initial.previous.release.root?initial.previous.derived.plist:replacementPlist(c,JSON.parse(initial.installation),command,targetRoot);
  const archive={schema:'brain-probation-switch/v1',id,trial,repo:c.repo,org:c.org,identity:c.identity,owner,
    canonical_head:initial.head,source:targetRoot,previous_source:fromRoot,previous_seq:initial.last_seq,
    scope_sha256:initial.scope_sha256,recovery_sha256:initial.recovery_sha256,stop_sha256:initial.stop_sha256,runtime:initial.runtime,
    before:{installation:initial.installation,plist:initial.plist},after:{installation:json(after),plist:nextPlist}};
  const bytes=json(archive),ref={file:archiveFile,sha256:sha(bytes)},required_decision=`Brain probation switch authorized: ${id} ${ref.sha256}`;
  const validate=events=>{const loaded=events?{events}:loadEvents(c.org);if(loaded.tornTail||!same(snapshot(loaded.events),initial))throw Error('probation switch source/record/native CAS changed');};
  return withRuntimeLocks(c,{id,operation:'probation-switch',dryRun,owner,validate},()=>{
    validate();
    if(dryRun)return{dry_run:true,id,trial,archive:ref,plan_sha256:ref.sha256,scope_sha256:initial.scope_sha256,recovery_sha256:initial.recovery_sha256,
      runtime:initial.runtime,required_decision,stopped:true,runtime_started:false};
    if(expectedPlan!==ref.sha256)throw Error('probation switch dry-run plan changed; exact --expected-plan required');
    return transact(c.org,events=>{
      validate(events);
      const note=events.find(e=>e.seq===Number(authority));
      if(note?.type!=='note.added'||note.decision!==true||note.by!==owner.native.name||note.text!==required_decision)throw Error('probation switch needs exact recorded supervisor effect authority');
      authorityOwner(note,events);
      // All intent bytes precede configuration writes. Partial effects fence
      // history under every ID, even when the original record reply was lost.
      plainDirectory(path.dirname(archiveFile));
      const fd=fs.openSync(archiveFile,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fault('intent');writeFileAtomic(file,nextPlist,0o600);fault('plist');
      const nextInstallation=json({...after,probation_bootstrap:{trial,id,...ref}});
      writeFileAtomic(installationFile,nextInstallation,0o600);fault('installation');
      if(inspectService(after.target,c.repo,command).loaded||sha(readPlainFile(path.join(c.directory,'STOP')))!==initial.stop_sha256||
          readPlainFile(file)!==nextPlist||readPlainFile(installationFile)!==nextInstallation)throw Error('probation switch completion changed; original UNKNOWN intent retained');
      return{add:[{type:'line-service.probation-switched',id,trial,project:c.identity,repo:c.repo,org:c.org,source:targetRoot,previous_source:fromRoot,
        previous_seq:initial.last_seq,runtime:initial.runtime,authority:note.seq,archive:ref,native_caller:owner.native,runtime_started:false}],
        result:{switched:true,id,trial,archive:ref,scope_sha256:initial.scope_sha256,recovery_sha256:initial.recovery_sha256,runtime:initial.runtime,stopped:true,runtime_started:false}};
    },{actor:owner.native.name,strictTail:true,lockOptions:{recover:false}}).result;
  });
}
