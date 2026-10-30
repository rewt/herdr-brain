// Fresh accepted-release installation. Preview is read-only; an immutable
// intent fences every partial/UNKNOWN apply before any launchd effect.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {lineContext} from './cutoff.mjs';
import {acceptedRuntime,runtimeRoot,digest} from './runtime.mjs';
import {inspectService} from './migrate-runtime.mjs';
import {launchPlist} from './plist.mjs';
import {liveRecipient} from './retarget.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {canonical} from '../messages/schema.mjs';
import {bundleRelease} from '../lib/releases.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {plainDirectory,readPlainFile,writeFileAtomic} from '../lib/files.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {loadDiscoveredRoutes} from '../lanes/routes.mjs';
import {requireRecordCompatibility} from '../lib/record-compatibility.mjs';

const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
const same=(a,b)=>canonical(a)===canonical(b);
const json=v=>JSON.stringify(v)+'\n';

export function installRelease({repo,org,id,to,herdr,socket,interval=30,dryRun=false,expectedPlan,cwd=process.cwd(),env=process.env,command=spawnSync,call,home,fault=()=>{}}={}){
  if(process.platform!=='darwin'||process.version!=='v20.19.4')throw Error('service install requires macOS and project-pinned Node 20.19.4');
  if(!bundleRelease().commit)throw Error('previewed fresh install requires the accepted installed release');
  if(!/^[-a-zA-Z0-9_]{1,80}$/.test(id??''))throw Error('fresh install needs a stable --id (letters, digits, dash, underscore)');
  if(!path.isAbsolute(herdr??'')||!path.isAbsolute(socket??''))throw Error('install needs absolute --herdr and actual --socket');
  const c=lineContext(repo,org),label=`dev.herdr.line.${path.basename(c.directory)}`,target=`gui/${process.getuid()}/${label}`;
  const file=path.join(c.directory,'service.plist'),receiptFile=path.join(c.directory,'installation.json'),stop=path.join(c.directory,'STOP');
  const archiveFile=path.join(c.directory,'installs',id+'.json');
  const bind=()=>{
    const b=nativeSender(c.org,{cwd,env,...(call?{call}:{})});
    if(b.project.checkout!==c.repo||b.project.identity!==c.identity)throw Error('install requires the actual own canonical native supervisor');
    return {name:b.native.name,pane:b.native.pane_id,workspace:b.native.workspace_id,terminal:b.native.terminal_id,session:b.native.agent_session.value};
  };
  let locked=false;
  const snapshot=events=>{
    requireRecordCompatibility(runtimeRoot,events);
    const owner=bind();
    for(const name of ['STOP','HOLD'])if(fs.existsSync(path.join(c.repo,'.lane/supervisor',name)))throw Error('project STOP/HOLD prevents install');
    // Validate even absent paths through their nearest existing ancestor.
    let ancestor=c.directory;while(!fs.lstatSync(ancestor,{throwIfNoEntry:false}))ancestor=path.dirname(ancestor);
    plainDirectory(ancestor,{create:false});
    if(fs.existsSync(c.directory)&&fs.readdirSync(c.directory).some(name=>!locked||!['control.lock','pass.lock'].includes(name)))
      throw Error('existing/UNKNOWN service installation is retained; no replay or replacement');
    if(events.some(e=>e.project===c.identity&&e.org===c.org&&e.type.startsWith('line-service.')))
      throw Error('existing/UNKNOWN service record is retained; no fresh initialization');
    const main=loadDiscoveredRoutes({cwd:c.repo,env}).config.main??'main';
    if(git(c.repo,['symbolic-ref','--short','HEAD'])!==main||git(c.repo,['status','--porcelain=v1','--untracked-files=all']))throw Error('install requires clean canonical main');
    const head=git(c.repo,['rev-parse','HEAD']),runtime=acceptedRuntime(c.repo,{home});
    const recipient=liveRecipient(to??owner.name,c.identity,{herdr,env:{...env,HERDR_SOCKET_PATH:socket},...(call?{call}:{})});
    if(inspectService(target,c.repo,command).loaded)throw Error('service already loaded; no fresh initialization');
    const installation={target,repo:c.repo,org:c.org,source:runtimeRoot,node:process.execPath,file,recipient:recipient.name,runtime};
    const plist=launchPlist({label,repo:c.repo,org:c.org,to:recipient.name,herdr,socket,directory:c.directory,interval:Number(interval),source:runtimeRoot,searchPath:env.PATH});
    return {schema:'line-release-install/v1',id,repo:c.repo,org:c.org,identity:c.identity,owner,recipient,
      record_sha256:digest(canonical(events)),cutover:{id,main,canonical_head:head,source:runtimeRoot,source_head:runtime.commit,mode:'accepted-release-install'},installation,plist};
  };
  const read=()=>{const r=loadEvents(c.org);if(r.tornTail)throw Error('incomplete record prevents install');return r.events;};
  const originalEvents=read(),plan=snapshot(originalEvents),bytes=json(plan),archive={id,file:archiveFile,sha256:digest(bytes)};
  const validate=events=>{if(!same(snapshot(events),plan))throw Error('install source/record/native CAS changed; preview again');};
  if(dryRun){validate(read());return {dry_run:true,id,target,expected_plan:archive.sha256,archive,plan,runtime_started:false};}
  if(!/^[a-f0-9]{64}$/.test(expectedPlan??'')||expectedPlan!==archive.sha256)throw Error('install dry-run plan changed or --expected-plan SHA256 is missing');
  plainDirectory(c.directory);
  const releaseControl=noticeLock(path.join(c.directory,'control.lock'),{recover:false});
  let releasePass,releasePromotion;
  try{
    releasePass=noticeLock(path.join(c.directory,'pass.lock'),{recover:false});
    releasePromotion=acquireLock(path.join(c.identity,'lane-promote.lock'));locked=true;
    const result=transact(c.org,events=>{
      validate(events);
      plainDirectory(path.dirname(archiveFile));
      const fd=fs.openSync(archiveFile,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fault('intent');
      return {add:[{type:'line-service.cutover',...plan.cutover,project:c.identity,repo:c.repo,org:c.org,
        install_plan:archive,native_caller:plan.owner,runtime_started:false}]};
    },{actor:plan.owner.name,strictTail:true,lockOptions:{recover:false}});
    const cutover=result.added[0],receipt={...plan.installation,phase:'starting',fresh_install:archive},startingBytes=json(receipt);
    try{
      writeFileAtomic(file,plan.plist,0o600);fault('plist');
      writeFileAtomic(receiptFile,startingBytes,0o600);fault('installation');
      // Recheck record, source, native and local controls immediately before
      // the one bootstrap. The retained intent is deliberately not replayable.
      return transact(c.org,current=>{
      if(!same(current,[...originalEvents,cutover]))throw Error('install record CAS changed');
      const owner=bind(),runtime=acceptedRuntime(c.repo,{home});
      const recipient=liveRecipient(plan.installation.recipient,c.identity,{herdr,env:{...env,HERDR_SOCKET_PATH:socket},...(call?{call}:{})});
      const service=inspectService(target,c.repo,command);
      if(!same(owner,plan.owner)||!same(runtime,plan.installation.runtime)||!same(recipient,plan.recipient)||service.loaded||
          git(c.repo,['symbolic-ref','--short','HEAD'])!==plan.cutover.main||git(c.repo,['rev-parse','HEAD'])!==plan.cutover.canonical_head||
          git(c.repo,['status','--porcelain=v1','--untracked-files=all'])||
          ['STOP','HOLD'].some(name=>fs.existsSync(path.join(c.repo,'.lane/supervisor',name)))||fs.existsSync(stop)||
          readPlainFile(file)!==plan.plist||readPlainFile(receiptFile)!==startingBytes||readPlainFile(archiveFile)!==bytes)
        throw Error('install source/record/native CAS changed before bootstrap');
      const r=command('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,file],{cwd:c.repo,encoding:'utf8',maxBuffer:4*1024*1024});
      if(r.error||r.status!==0)throw Error((r.stderr||r.stdout||r.error?.message||`launchctl bootstrap exit ${r.status}`).trim());
      if(readPlainFile(file)!==plan.plist||readPlainFile(receiptFile)!==startingBytes||fs.existsSync(stop))throw Error('install completion configuration changed; original attempt retained');
      receipt.phase='installed';writeFileAtomic(receiptFile,json(receipt),0o600);
      return {add:[],result:{installed:true,id,target,directory:c.directory,archive,cutover,installation:receipt}};
      },{actor:plan.owner.name,strictTail:true,lockOptions:{recover:false}}).result;
    }catch(e){
      receipt.phase='uncertain-or-refused';receipt.error=e.message;
      if(!fs.existsSync(stop))fs.writeFileSync(stop,`Install refused or uncertain: ${e.message}\n`,{flag:'wx',mode:0o600});
      if(!fs.existsSync(receiptFile)||readPlainFile(receiptFile)===startingBytes)writeFileAtomic(receiptFile,json(receipt),0o600);
      fs.writeFileSync(path.join(c.directory,'install-outcome.json'),json({id,phase:'uncertain-or-refused',error:e.message,archive}),{flag:'wx',mode:0o600});throw e;
    }
  }finally{releasePromotion?.();releasePass?.();releaseControl();}
}
