// Explicit stopped-service handoff. This never bootstraps a job, clears STOP,
// changes a pin, or rewrites a saved worker/watch request.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {lineContext,serviceCutoff} from './cutoff.mjs';
import {acceptedRuntime,runtimeRoot,digest} from './runtime.mjs';
import {launchPlist} from './plist.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {canonical} from '../messages/schema.mjs';
import {loadEvents,transact,writeFileAtomic} from '../lib/store.mjs';
import {readPlainFile,plainDirectory} from '../lib/files.mjs';
import {withRuntimeLocks} from './runtime-locks.mjs';
import {loadDiscoveredRoutes} from '../lanes/routes.mjs';
import {recipientChanges,legacyRecipientHistory} from './recipient-history.mjs';
import {installationPhaseProof,settledInstallation} from './runtime-phase.mjs';

const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
const tuple=b=>({project:b.project,native:{name:b.native.name,pane:b.native.pane_id,workspace:b.native.workspace_id,terminal:b.native.terminal_id,session:b.native.agent_session.value}});
const same=(a,b)=>canonical(a)===canonical(b);
const json=value=>JSON.stringify(value)+'\n';

export function inspectService(target,repo,command=spawnSync) {
  const r=command('/bin/launchctl',['print',target],{cwd:repo,encoding:'utf8',maxBuffer:4*1024*1024});
  if(!r.error&&r.status===0)return{loaded:true,native:r.stdout?.trim()};
  if(!r.error&&/could not find service/i.test(r.stderr??''))return{loaded:false,native:r.stderr.trim()};
  throw Error((r.stderr||r.stdout||r.error?.message||`launchctl print exit ${r.status}`).trim());
}

// Decode through the native plist reader, then validate the complete supported
// job schema. Regeneration changes only argv[1], retaining all other bindings.
export function savedPlist(c,installation,command) {
  const r=command('/usr/bin/plutil',['-convert','json','-o','-','--',installation.file],{cwd:c.repo,encoding:'utf8',maxBuffer:4*1024*1024});
  if(r.error||r.status!==0)throw Error((r.stderr||r.error?.message||'saved plist could not be read').trim());
  const p=JSON.parse(r.stdout),a=p.ProgramArguments,e=p.EnvironmentVariables,label=`dev.herdr.line.${path.basename(c.directory)}`;
  if(!Array.isArray(a)||a.length!==11||typeof a[8]!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(a[8])||
      !path.isAbsolute(a[10]??'')||!path.isAbsolute(e?.HERDR_SOCKET_PATH??'')||typeof e?.PATH!=='string'||!e.PATH||
      !Number.isSafeInteger(p.StartInterval)||p.StartInterval<1)throw Error('saved plist transport/runtime binding differs');
  const expected={Label:label,ProgramArguments:[installation.node,path.join(installation.source,'line-service/line-service.mjs'),'--once','--repo',c.repo,'--org',c.org,'--to',a[8],'--herdr',a[10]],
    WorkingDirectory:c.repo,EnvironmentVariables:{PATH:e.PATH,HERDR_SOCKET_PATH:e.HERDR_SOCKET_PATH},StartInterval:p.StartInterval,RunAtLoad:true,
    StandardOutPath:path.join(c.directory,'launchd.log'),StandardErrorPath:path.join(c.directory,'launchd.error.log')};
  if(!same(p,expected))throw Error('saved plist bindings drifted; no replacement authorized');
  if(installation.recipient!==undefined&&installation.recipient!==a[8])throw Error('saved installation recipient differs from plist');
  return p;
}
export function replacementPlist(c,installation,command,source=runtimeRoot) {
  const p=savedPlist(c,installation,command),a=p.ProgramArguments,e=p.EnvironmentVariables,label=p.Label;
  return launchPlist({label,repo:c.repo,org:c.org,to:a[8],herdr:a[10],socket:e.HERDR_SOCKET_PATH,directory:c.directory,interval:p.StartInterval,
    node:installation.node,environment:e,source});
}

export function migrateRuntime({repo,org,id,dryRun=false,expectedPlan,cwd=process.cwd(),env=process.env,command=spawnSync,call,home,fault=()=>{}}={}) {
  if(process.platform!=='darwin'||process.version!=='v20.19.4')throw Error('service migration requires macOS and project-pinned Node 20.19.4');
  if(!/^[-a-zA-Z0-9_]{1,80}$/.test(id??''))throw Error('service migration needs a stable --id (letters, digits, dash, underscore)');
  const c=lineContext(repo,org),installationFile=path.join(c.directory,'installation.json'),file=path.join(c.directory,'service.plist'),stop=path.join(c.directory,'STOP');
  plainDirectory(c.directory,{create:false});
  const target=`gui/${process.getuid()}/dev.herdr.line.${path.basename(c.directory)}`;
  const bind=()=>{
    const b=nativeSender(c.org,{cwd,env,...(call?{call}:{})});
    if(b.project.checkout!==c.repo||b.project.identity!==c.identity)throw Error('migration requires the actual own canonical native supervisor');
    return tuple(b);
  };
  const owner=bind(),archiveFile=path.join(c.directory,'migrations',id+'.json');
  const initial=()=>{
    if(!same(bind(),owner))throw Error('migration native owner changed');
    for(const name of ['STOP','HOLD'])if(fs.existsSync(path.join(c.repo,'.lane/supervisor',name)))throw Error('project STOP/HOLD prevents service migration');
    const stopBytes=readPlainFile(stop);if(!stopBytes)throw Error('migration requires this service own STOP');
    const main=loadDiscoveredRoutes({cwd:c.repo,env}).config.main??'main';
    if(git(c.repo,['symbolic-ref','--short','HEAD'])!==main||git(c.repo,['status','--porcelain=v1','--untracked-files=all']))throw Error('migration requires clean canonical main');
    const head=git(c.repo,['rev-parse','HEAD']),runtime=acceptedRuntime(c.repo,{home});
    const service=inspectService(target,c.repo,command);
    if(service.loaded)throw Error('service remains loaded; retain STOP and finish its supported stop');
    return{head,runtime,stop_sha256:digest(stopBytes),service};
  };
  const snapshot=initial(),loaded=loadEvents(c.org);if(loaded.tornTail)throw Error('incomplete record prevents service migration');
  const savedBytes=readPlainFile(installationFile),saved=JSON.parse(savedBytes),plistBytes=readPlainFile(file);
  const recipientHistory=recipientChanges(loaded.events,c);
  if(saved.repo!==c.repo||saved.org!==c.org||saved.file!==file||saved.target!==target||saved.node!==process.execPath||!['installed','uncertain-or-refused'].includes(saved.phase)||!path.isAbsolute(saved.source??''))throw Error('saved installation binding differs; retain it');
  const prior=loaded.events.filter(e=>e.type==='line-service.runtime-migrated'&&e.project===c.identity&&e.org===c.org);
  if(prior.length){
    serviceCutoff(loaded.events,c);
    if(prior.length!==1||prior[0].id!==id)throw Error('service already migrated; no implicit replacement');
    if(!dryRun&&expectedPlan!==prior[0].archive.sha256)throw Error('migration requires its exact dry-run --expected-plan SHA256');
    return{existing:true,id,dry_run:dryRun,target,archive:{id,...prior[0].archive},runtime:snapshot.runtime,stopped:true,runtime_started:false};
  }
  const migrationDirectory=path.dirname(archiveFile);
  if(fs.existsSync(migrationDirectory)){
    plainDirectory(migrationDirectory,{create:false});
    if(fs.readdirSync(migrationDirectory).length)throw Error('existing/UNKNOWN migration is retained; no replay or replacement');
  }
  if(saved.source===runtimeRoot||saved.migration||saved.runtime)throw Error('existing/UNKNOWN migration is retained; no replay or replacement');
  const cutovers=loaded.events.filter(e=>e.type==='line-service.cutover'&&e.project===c.identity&&e.org===c.org),cutover=cutovers[0];
  if(cutovers.length!==1||cutover.repo!==c.repo||!path.isAbsolute(cutover.source??'')||path.resolve(cutover.source)!==path.resolve(saved.source)||!cutover.id||!Number.isSafeInteger(cutover.seq)||cutover.seq<1||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(cutover.canonical_head??'')||cutover.main!==git(c.repo,['symbolic-ref','--short','HEAD']))throw Error('original cutover binding differs; preserve it');
  git(c.repo,['merge-base','--is-ancestor',cutover.canonical_head,snapshot.head]);
  legacyRecipientHistory(recipientHistory,{installation:saved,plist:plistBytes,cutover});
  const settlement=installationPhaseProof(saved,savedBytes,{target,service:snapshot.service,stop_sha256:snapshot.stop_sha256});
  const nextPlist=replacementPlist(c,saved,command),after=settledInstallation({...saved,source:runtimeRoot,runtime:snapshot.runtime},settlement);
  // Observe the stopped state, never complete or replay the refused bootstrap.
  // The immutable archive retains the original phase/error. The installed
  // configuration names this separate stopped-state settlement.
  const stoppedInstallation=saved.phase==='uncertain-or-refused'?{
    schema:'line-stopped-installation/v1',phase:saved.phase,installation_sha256:digest(savedBytes),
    target,service:snapshot.service,stop_sha256:snapshot.stop_sha256,bootstrap_replayed:false,
  }:null;
  const archive={schema:'line-runtime-migration/v1',id,repo:c.repo,org:c.org,identity:c.identity,source:runtimeRoot,previous_source:cutover.source,
    owner,canonical_head:snapshot.head,stop_sha256:snapshot.stop_sha256,cutover,runtime:snapshot.runtime,
    ...(stoppedInstallation?{stopped_installation:stoppedInstallation,phase_settlement:settlement}:{}),
    before:{installation:savedBytes,plist:plistBytes},after:{installation:JSON.stringify(after),plist:nextPlist}};
  const bytes=json(archive),ref={id,file:archiveFile,sha256:digest(bytes)},nextInstallation=json({...after,migration:ref});
  const validate=()=>{
    if(!same(initial(),snapshot)||readPlainFile(installationFile)!==savedBytes||readPlainFile(file)!==plistBytes)
      throw Error('service migration source/native CAS changed');
  };
  if(!dryRun&&(!/^[a-f0-9]{64}$/.test(expectedPlan??'')||expectedPlan!==ref.sha256))throw Error('migration dry-run plan changed or --expected-plan SHA256 is missing; no replacement authorized');
  return withRuntimeLocks(c,{id,operation:'migration',dryRun,owner,validate},()=>{
    if(dryRun){
      validate();
      return{dry_run:true,id,target,runtime:snapshot.runtime,archive:ref,changes:['installation.source','installation.runtime','installation.migration','service.ProgramArguments[1]'],
        preserved:['node','transport','recipient','interval','logs','STOP','cutover','phase0','saved jobs/watchers','claims','queue attempts'],stopped:true,runtime_started:false};
    }
    const result=transact(c.org,events=>{
      if(!same(initial(),snapshot)||readPlainFile(installationFile)!==savedBytes||readPlainFile(file)!==plistBytes||fs.existsSync(archiveFile)||
          events.some(e=>e.type==='line-service.runtime-migrated'&&e.project===c.identity&&e.org===c.org)||
          !same(events.find(e=>e.seq===cutover.seq),cutover))throw Error('service migration source/record/native CAS changed');
      // Publish the immutable intent before either replacement. A crash at
      // any later point leaves STOP and this archive; it never auto-retries.
      plainDirectory(path.dirname(archiveFile));
      const fd=fs.openSync(archiveFile,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fault('intent');
      writeFileAtomic(file,nextPlist,0o600);fault('plist');
      writeFileAtomic(installationFile,nextInstallation,0o600);fault('installation');
      if(inspectService(target,c.repo,command).loaded||
          digest(readPlainFile(stop))!==snapshot.stop_sha256||readPlainFile(file)!==nextPlist||readPlainFile(installationFile)!==nextInstallation)
        throw Error('migration completion service/configuration changed; original intent retained');
      const observed=stoppedInstallation?[{type:'line-service.stopped-installation-verified',id,project:c.identity,repo:c.repo,org:c.org,
        observation:stoppedInstallation,archive:{file:ref.file,sha256:ref.sha256},native_caller:owner.native,runtime_started:false}]:[];
      return{add:[...observed,...(settlement?[{type:'line-service.installation-settled',id,project:c.identity,repo:c.repo,org:c.org,
        operation:'migration',proof:settlement,archive:ref,native_caller:owner.native,runtime_started:false}]:[]),{type:'line-service.runtime-migrated',id,project:c.identity,repo:c.repo,org:c.org,source:runtimeRoot,previous_source:cutover.source,
        cutover_seq:cutover.seq,cutover_id:cutover.id,runtime:snapshot.runtime,archive:{file:ref.file,sha256:ref.sha256},native_caller:owner.native,runtime_started:false}],result:{migrated:true,id,target,archive:ref,runtime:snapshot.runtime,stopped:true,runtime_started:false}};
    },{actor:owner.native.name,strictTail:true,lockOptions:{recover:false}});
    return result.result;
  });
}
