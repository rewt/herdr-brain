// A stopped, explicit release-to-release handoff. Restart remains the existing
// launchd operation, with a fresh native/pin/cutoff check and one bootstrap.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {lineContext} from './cutoff.mjs';
import {acceptedRuntime,runtimeRoot,runtimeHistory,digest} from './runtime.mjs';
import {inspectService,replacementPlist} from './migrate-runtime.mjs';
import {checkRelease,releaseHome,requireReadyAcceptance} from '../lib/releases.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {canonical} from '../messages/schema.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {readPlainFile,plainDirectory,writeFileAtomic} from '../lib/files.mjs';
import {withRuntimeLocks} from './runtime-locks.mjs';
import {loadDiscoveredRoutes} from '../lanes/routes.mjs';
import {installationPhaseProof,settledInstallation} from './runtime-phase.mjs';
import {requireRecordCompatibility} from '../lib/record-compatibility.mjs';
import {probationRuntime} from './probation.mjs';

const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
const same=(a,b)=>canonical(a)===canonical(b);
const json=v=>JSON.stringify(v)+'\n';

function releaseRoot(root,home,repo,{allowEnded=false}={}){
  if(!path.isAbsolute(root??'')||path.resolve(root)!==root||fs.realpathSync(root)!==root)throw Error('name an exact immutable accepted release root');
  const trial=probationRuntime(repo,{root,home,allowEnded});
  if(trial)return trial;
  const release=checkRelease(home,path.basename(root),{verifyFiles:true});
  if(release.root!==root)throw Error('release root differs from the installation home');
  requireReadyAcceptance(release,home);return release;
}

export function upgradeRuntime({repo,org,id,fromRoot,targetRoot,rollback=false,dryRun=false,expectedPlan,cwd=process.cwd(),env=process.env,command=spawnSync,call,home=releaseHome(),fault=()=>{}}={}){
  if(process.platform!=='darwin'||process.version!=='v20.19.4')throw Error('service upgrade requires macOS and project-pinned Node 20.19.4');
  if(!/^[-a-zA-Z0-9_]{1,80}$/.test(id??''))throw Error('service upgrade needs a stable --id (letters, digits, dash, underscore)');
  if(fromRoot===targetRoot)throw Error('upgrade needs different current and target roots');
  // The qualified tool may be the successor for both upgrade and rollback.
  // This allows rollback to an older accepted release predating this command.
  if(runtimeRoot!==fromRoot&&runtimeRoot!==targetRoot)throw Error('executing upgrade tool must be the named current or target accepted root');
  const c=lineContext(repo,org),installationFile=path.join(c.directory,'installation.json'),file=path.join(c.directory,'service.plist'),stop=path.join(c.directory,'STOP');
  plainDirectory(c.directory,{create:false});
  const target=`gui/${process.getuid()}/dev.herdr.line.${path.basename(c.directory)}`;
  const bind=()=>{
    const b=nativeSender(c.org,{cwd,env,...(call?{call}:{})});
    if(b.project.checkout!==c.repo||b.project.identity!==c.identity)throw Error('upgrade requires the actual own canonical native supervisor');
    return {project:b.project,native:{name:b.native.name,pane:b.native.pane_id,workspace:b.native.workspace_id,terminal:b.native.terminal_id,session:b.native.agent_session.value}};
  };
  const owner=bind(),direction=rollback?'rollback':'upgrade';
  const initial=()=>{
    if(!same(bind(),owner))throw Error('upgrade native owner changed');
    for(const name of ['STOP','HOLD'])if(fs.existsSync(path.join(c.repo,'.lane/supervisor',name)))throw Error('project STOP/HOLD prevents service upgrade');
    const stopBytes=readPlainFile(stop);if(!stopBytes)throw Error('upgrade requires this service own STOP');
    const main=loadDiscoveredRoutes({cwd:c.repo,env}).config.main??'main';
    if(git(c.repo,['symbolic-ref','--short','HEAD'])!==main||git(c.repo,['status','--porcelain=v1','--untracked-files=all']))throw Error('upgrade requires clean canonical main');
    const previous=releaseRoot(fromRoot,home,c.repo,{allowEnded:rollback}),runtime=releaseRoot(targetRoot,home,c.repo);
    if(rollback&&previous.probation){
      const prior=previous.probation.previous;
      if(!same(runtime,prior.release)||digest(readPlainFile(path.join(targetRoot,'.release-manifest.json')))!==prior.manifest_sha256)
        throw Error('probation rollback target differs from its archived previous runtime');
    }
    acceptedRuntime(c.repo,{root:targetRoot,home});
    const service=inspectService(target,c.repo,command);
    if(service.loaded)throw Error('service remains loaded; retain STOP and finish its supported stop');
    return {head:git(c.repo,['rev-parse','HEAD']),previous,runtime,stop_sha256:digest(stopBytes),service};
  };
  const snapshot=initial(),loaded=loadEvents(c.org);if(loaded.tornTail)throw Error('incomplete record prevents service upgrade');
  requireRecordCompatibility(targetRoot,loaded.events);
  const savedBytes=readPlainFile(installationFile),saved=JSON.parse(savedBytes),plistBytes=readPlainFile(file);
  if(saved.repo!==c.repo||saved.org!==c.org||saved.file!==file||saved.target!==target||saved.node!==process.execPath||!['installed','uncertain-or-refused'].includes(saved.phase)||!(saved.migration||saved.fresh_install))throw Error('saved migrated/fresh installation binding differs; retain it');
  const history=events=>{
    const cutovers=events.filter(e=>e.type==='line-service.cutover'&&e.project===c.identity&&e.org===c.org);
    if(cutovers.length!==1||cutovers[0].repo!==c.repo||cutovers[0].main!==git(c.repo,['symbolic-ref','--short','HEAD']))throw Error('original service cutover binding differs');
    git(c.repo,['merge-base','--is-ancestor',cutovers[0].canonical_head,snapshot.head]);
    return runtimeHistory(events,{...c,installation:saved,cutover:cutovers[0],root:saved.source});
  };
  const state=history(loaded.events),existing=loaded.events.filter(e=>e.type==='line-service.runtime-upgraded'&&e.project===c.identity&&e.org===c.org&&e.id===id);
  if(existing.length){
    const event=existing[0];
    if(existing.length!==1||state.last.seq!==event.seq||event.previous_source!==fromRoot||event.source!==targetRoot||event.direction!==direction)throw Error('completed upgrade id differs; no replacement or replay');
    if(!dryRun&&expectedPlan!==event.archive.sha256)throw Error('upgrade requires its exact dry-run --expected-plan SHA256');
    return {existing:true,id,target,dry_run:dryRun,archive:{id,...event.archive},runtime:snapshot.runtime,stopped:true,runtime_started:false};
  }
  if(saved.source!==fromRoot||!same(saved.runtime,snapshot.previous))throw Error('current accepted root differs from the saved installation');
  if(rollback&&(state.last.type!=='line-service.runtime-upgraded'||state.last.previous_source!==targetRoot))throw Error('rollback must name the previous accepted root');
  const replacement=replacementPlist(c,saved,command,targetRoot);
  // Rollback restores the exact prior saved bytes. In particular, a release
  // predating upgrade events can still read its original migration receipt.
  const settlement=rollback?null:installationPhaseProof(saved,savedBytes,{target,service:snapshot.service,stop_sha256:snapshot.stop_sha256});
  const nextPlist=rollback?state.previous.plist:replacement,after=rollback?state.previous.installation:settledInstallation({...saved,source:targetRoot,runtime:snapshot.runtime},settlement);
  if(after.source!==targetRoot||!same(after.runtime,snapshot.runtime))throw Error('previous accepted runtime binding changed');
  const archiveFile=path.join(c.directory,'upgrades',id+'.json');
  const archive={schema:'line-runtime-upgrade/v1',id,repo:c.repo,org:c.org,identity:c.identity,direction,source:targetRoot,previous_source:fromRoot,previous_seq:state.last.seq,
    owner,canonical_head:snapshot.head,stop_sha256:snapshot.stop_sha256,runtime:snapshot.runtime,...(settlement?{phase_settlement:settlement}:{}),
    before:{installation:savedBytes,plist:plistBytes},after:{installation:JSON.stringify(after),plist:nextPlist}};
  const bytes=json(archive),ref={id,file:archiveFile,sha256:digest(bytes)},nextInstallation=json(rollback?after:{...after,upgrade:ref});
  const validate=()=>{
    if(!same(initial(),snapshot)||readPlainFile(installationFile)!==savedBytes||readPlainFile(file)!==plistBytes)
      throw Error('service upgrade source/native CAS changed');
  };
  if(!dryRun&&(!/^[a-f0-9]{64}$/.test(expectedPlan??'')||expectedPlan!==ref.sha256))throw Error('upgrade dry-run plan changed or --expected-plan SHA256 is missing; no replacement authorized');
  return withRuntimeLocks(c,{id,operation:direction,dryRun,owner,validate},()=>{
    if(dryRun){
      validate();
      return {dry_run:true,id,direction,target,archive:ref,previous:snapshot.previous,runtime:snapshot.runtime,stopped:true,runtime_started:false,
        changes:['installation.source','installation.runtime','installation.upgrade','service.ProgramArguments[1]'],preserved:['migration archive/event','cutover','phase0','STOP','node','transport','saved jobs/watchers','claims','queue attempts']};
    }
    const result=transact(c.org,events=>{
      requireRecordCompatibility(targetRoot,events);
      if(!same(initial(),snapshot)||readPlainFile(installationFile)!==savedBytes||readPlainFile(file)!==plistBytes||fs.existsSync(archiveFile)||
          history(events).last.seq!==state.last.seq)throw Error('service upgrade source/record/native CAS changed');
      plainDirectory(path.dirname(archiveFile));
      const fd=fs.openSync(archiveFile,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fault('intent');writeFileAtomic(file,nextPlist,0o600);fault('plist');
      if(!rollback){writeFileAtomic(installationFile,nextInstallation,0o600);fault('installation');}
      if(inspectService(target,c.repo,command).loaded||digest(readPlainFile(stop))!==snapshot.stop_sha256||readPlainFile(file)!==nextPlist||
          !rollback&&readPlainFile(installationFile)!==nextInstallation)throw Error('upgrade completion service/configuration changed; original intent retained');
      return {add:[...(settlement?[{type:'line-service.installation-settled',id,project:c.identity,repo:c.repo,org:c.org,
        operation:direction,proof:settlement,archive:ref,native_caller:owner.native,runtime_started:false}]:[]),{type:'line-service.runtime-upgraded',id,project:c.identity,repo:c.repo,org:c.org,direction,source:targetRoot,previous_source:fromRoot,previous_seq:state.last.seq,
        runtime:snapshot.runtime,archive:{file:ref.file,sha256:ref.sha256},native_caller:owner.native,runtime_started:false}],
      result:{upgraded:true,id,direction,target,archive:ref,previous:snapshot.previous,runtime:snapshot.runtime,stopped:true,runtime_started:false}};
    },{actor:owner.native.name,strictTail:true,lockOptions:{recover:false}}).result;
    // An older runtime cannot recognize a pending upgrade intent. Publish
    // the rollback event before restoring its legacy-readable receipt;
    // until then its saved source mismatches and startup must refuse.
    if(rollback){fault('record');writeFileAtomic(installationFile,nextInstallation,0o600);fault('installation');}
    return result;
  });
}
