// Explicit stopped-service routing control. No launchctl mutation, saved
// request rewrite, lock recovery, pin update or notice delivery occurs here.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {installedContext,serviceCutoff} from './cutoff.mjs';
import {serviceSource,runtimeRoot,digest} from './runtime.mjs';
import {savedPlist,inspectService} from './migrate-runtime.mjs';
import {recipientName,recipientPlist} from './recipient-history.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {invokeHerdr} from '../lib/herdr-command.mjs';
import {gitProject} from '../lib/project.mjs';
import {canonical} from '../messages/schema.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {readPlainFile,plainDirectory,writeFileAtomic} from '../lib/files.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {loadDiscoveredRoutes} from '../lanes/routes.mjs';

const same=(a,b)=>canonical(a)===canonical(b);
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
const tuple=a=>({name:a.name,pane:a.pane_id,workspace:a.workspace_id,terminal:a.terminal_id,session:a.agent_session?.value,cwd:a.cwd});

export function liveRecipient(to,identity,{herdr='herdr',env=process.env,call=invokeHerdr}={}){
  if(!recipientName(to))throw Error('name a live project agent with --to');
  const a=JSON.parse(call(herdr,['agent','get',to],{env})).result?.agent;
  if(a?.name!==to||!a.pane_id||!a.workspace_id||!a.terminal_id||!a.agent_session?.value||
      !['idle','working','done'].includes(a.agent_status)||!a.cwd||gitProject(a.cwd).identity!==identity)throw Error('recipient is missing, inactive or foreign to the project');
  return tuple(a);
}

export function retargetService({repo,org,to,dryRun=false,cwd=process.cwd(),env=process.env,command=spawnSync,call,home,fault=()=>{}}={}){
  if(process.platform!=='darwin'||process.version!=='v20.19.4')throw Error('service retarget requires macOS and project-pinned Node 20.19.4');
  // installedContext validates completed runtime/recipient history and rejects
  // unmatched immutable intents, including an interrupted previous retarget.
  const c=installedContext(repo,org),file=c.installation.file,stop=path.join(c.directory,'STOP');
  plainDirectory(c.directory,{create:false});
  const savedBytes=readPlainFile(c.installationFile),plistBytes=readPlainFile(file),saved=JSON.parse(savedBytes);
  if(saved.phase!=='installed')throw Error('retarget requires a known installed phase; retain refused/UNKNOWN installation');
  const p=savedPlist(c,saved,command),oldRecipient=p.ProgramArguments[8];
  const bind=()=>{
    const b=nativeSender(c.org,{cwd,env,...(call?{call}:{})});
    if(b.project.checkout!==c.repo||b.project.identity!==c.identity)throw Error('retarget requires the actual own canonical native supervisor');
    return tuple(b.native);
  };
  const owner=bind();
  const initial=()=>{
    if(!same(bind(),owner))throw Error('retarget native owner changed');
    for(const name of ['STOP','HOLD'])if(fs.existsSync(path.join(c.repo,'.lane/supervisor',name)))throw Error('project STOP/HOLD prevents service retarget');
    const stopBytes=readPlainFile(stop);if(!stopBytes)throw Error('retarget requires this service own STOP');
    const main=loadDiscoveredRoutes({cwd:c.repo,env}).config.main??'main';
    if(git(c.repo,['symbolic-ref','--short','HEAD'])!==main||git(c.repo,['status','--porcelain=v1','--untracked-files=all']))throw Error('retarget requires clean canonical main');
    const source=serviceSource(c.repo,{home});
    if(!source.commit&&git(runtimeRoot,['status','--porcelain=v1','--untracked-files=all']))throw Error('retarget requires clean canonical source');
    const sourceHead=source.commit??git(runtimeRoot,['rev-parse','HEAD']);
    if(inspectService(saved.target,c.repo,command).loaded)throw Error('service remains loaded; retain STOP and finish its supported stop');
    const recipient=liveRecipient(to,c.identity,{herdr:p.ProgramArguments[10],env:{...env,HERDR_SOCKET_PATH:p.EnvironmentVariables.HERDR_SOCKET_PATH},...(call?{call}:{})});
    return {head:git(c.repo,['rev-parse','HEAD']),source,source_head:sourceHead,stop_sha256:digest(stopBytes),recipient};
  };
  const snapshot=initial(),loaded=loadEvents(c.org);if(loaded.tornTail)throw Error('incomplete record prevents service retarget');
  const history=events=>{
    const cutover=serviceCutoff(events,c);
    git(c.repo,['merge-base','--is-ancestor',cutover.canonical_head,snapshot.head]);
    return events.filter(e=>e.project===c.identity&&e.org===c.org&&['line-service.cutover','line-service.runtime-migrated','line-service.runtime-upgraded','line-service.recipient-retargeted'].includes(e.type)).at(-1);
  };
  const previous=history(loaded.events),nextPlist=recipientPlist(plistBytes,oldRecipient,to),after={...saved,recipient:to};
  const id=digest(canonical({repo:c.repo,org:c.org,previous_seq:previous.seq,before:{installation:savedBytes,plist:plistBytes},to}));
  const archiveFile=path.join(c.directory,'retargets',id+'.json');
  const archive={schema:'line-recipient-retarget/v1',id,repo:c.repo,org:c.org,identity:c.identity,previous_seq:previous.seq,
    old_recipient:oldRecipient,new_recipient:to,owner,recipient:snapshot.recipient,canonical_head:snapshot.head,stop_sha256:snapshot.stop_sha256,
    before:{installation:savedBytes,plist:plistBytes},after:{installation:JSON.stringify(after),plist:nextPlist}};
  const bytes=JSON.stringify(archive)+'\n',ref={file:archiveFile,sha256:digest(bytes)};
  const validate=events=>{
    if(!same(initial(),snapshot)||readPlainFile(c.installationFile)!==savedBytes||readPlainFile(file)!==plistBytes||history(events).seq!==previous.seq)throw Error('service retarget source/record/native CAS changed');
  };
  const releaseControl=noticeLock(path.join(c.directory,'control.lock'),{recover:false});
  try{
    const releasePass=noticeLock(path.join(c.directory,'pass.lock'),{recover:false});
    try{
      const releasePromotion=acquireLock(path.join(c.identity,'lane-promote.lock'));
      try{
        const result={target:saved.target,old_recipient:oldRecipient,new_recipient:to,stopped:true,runtime_started:false};
        if(dryRun||oldRecipient===to){
          const fresh=loadEvents(c.org);if(fresh.tornTail)throw Error('incomplete record prevents service retarget');validate(fresh.events);
          return {...result,dry_run:dryRun,unchanged:oldRecipient===to,changes:oldRecipient===to?[]:['installation.recipient','service.ProgramArguments[8]']};
        }
        return transact(c.org,events=>{
          validate(events);
          plainDirectory(path.dirname(archiveFile));
          const fd=fs.openSync(archiveFile,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
          fault('intent');writeFileAtomic(file,nextPlist,0o600);fault('plist');
          writeFileAtomic(c.installationFile,JSON.stringify(after)+'\n',0o600);fault('installation');
          return {add:[{type:'line-service.recipient-retargeted',schema:archive.schema,id,project:c.identity,repo:c.repo,org:c.org,previous_seq:previous.seq,
            old_recipient:oldRecipient,new_recipient:to,archive:ref,native_caller:owner,recipient:snapshot.recipient,runtime_started:false}],
            result:{...result,retargeted:true,archive:ref}};
        },{actor:owner.name,strictTail:true,lockOptions:{recover:false}}).result;
      }finally{releasePromotion();}
    }finally{releasePass();}
  }finally{releaseControl();}
}
