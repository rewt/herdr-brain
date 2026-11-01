// Guarded existing-install registration only. No service activation or restart.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {lineContext} from './cutoff.mjs';
import {serviceSource,runtimeHistory,runtimeRoot,digest} from './runtime.mjs';
import {savedPlist,inspectService} from './migrate-runtime.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {canonical} from '../messages/schema.mjs';
import {readProjectPolicy} from '../lib/config-policy.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {plainDirectory,readPlainFile,writeFileAtomic} from '../lib/files.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {assertCommandQuiescence} from '../lib/command-receipt.mjs';
import {requireRecordCompatibility} from '../lib/record-compatibility.mjs';
import {recipientChanges,legacyRecipientHistory} from './recipient-history.mjs';
import {loginChanges,applyLoginChange} from './login-history.mjs';
import {loginRegistration,inspectLoginRegistration,createLoginRegistration} from './login-registration.mjs';
const same=(a,b)=>canonical(a)===canonical(b),json=v=>JSON.stringify(v)+'\n';
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
export function registerLogin({repo,org,dryRun=false,expectedPlan,cwd=process.cwd(),env=process.env,command=spawnSync,call,home,fault=()=>{}}={}){
  if(process.platform!=='darwin'||process.version!=='v20.19.4')throw Error('login registration requires macOS and pinned Node 20.19.4');
  const c=lineContext(repo,org),receiptFile=path.join(c.directory,'installation.json'),file=path.join(c.directory,'service.plist');
  plainDirectory(c.directory,{create:false});
  const savedBytes=readPlainFile(receiptFile),saved=JSON.parse(savedBytes),plist=readPlainFile(file);
  const label=`dev.herdr.line.${path.basename(c.directory)}`,target=`gui/${process.getuid()}/${label}`;
  if(saved.repo!==c.repo||saved.org!==c.org||saved.file!==file||saved.target!==target||saved.node!==process.execPath||saved.phase!=='installed'||!path.isAbsolute(saved.source??''))throw Error('login registration requires known installed binding');
  // An old frozen reader cannot interpret the additive receipt. Activation of
  // a source carrying this reader stays with the release owner, never this tool.
  if(!fs.existsSync(path.join(saved.source,'line-service/login-history.mjs')))throw Error('installed runtime lacks the login-registration reader; release owner must activate a compatible source first');
  const p=savedPlist(c,saved,command),recipient=p.ProgramArguments[8];
  const bind=()=>{
    const b=nativeSender(c.org,{cwd,env,...(call?{call}:{})});
    const owner=readProjectPolicy(c.repo,'promote',env,{canonical:c.repo}).config.to??recipient;
    if(b.project.checkout!==c.repo||b.project.identity!==c.identity||b.native.name!==owner)throw Error('login registration requires recorded actual canonical native supervisor');
    return {name:b.native.name,pane:b.native.pane_id,workspace:b.native.workspace_id,terminal:b.native.terminal_id,session:b.native.agent_session.value};
  };
  if(!path.isAbsolute(env.HOME??''))throw Error('login registration requires explicit absolute user HOME');
  const owner=bind(),login=loginRegistration(label,file,env.HOME);
  const read=()=>{const r=loadEvents(c.org);if(r.tornTail)throw Error('incomplete record prevents login registration');return r.events;};
  const history=events=>{
    const rows=events.filter(e=>e.type==='line-service.cutover'&&e.project===c.identity&&e.org===c.org),cutover=rows[0];
    if(rows.length!==1||cutover.repo!==c.repo)throw Error('login registration cutover missing/ambiguous');
    git(c.repo,['merge-base','--is-ancestor',cutover.canonical_head,'HEAD']);
    if(saved.migration||saved.fresh_install||saved.probation_bootstrap)return runtimeHistory(events,{...c,installation:saved,cutover,root:saved.source}).last;
    const recipients=recipientChanges(events,c);
    let state={installation:saved,plist,last:recipients.at(-1)?.event??cutover};
    const changes=loginChanges(events,c);
    const before=changes.length?JSON.parse(changes[0].archive.before.installation):saved;
    legacyRecipientHistory(recipients,{installation:before,plist,cutover});
    if(changes.length){state={...state,installation:before};for(const change of changes)state=applyLoginChange(change,state);}
    if(!same(state.installation,saved))throw Error('login registration installation drifted');
    return state.last;
  };
  const snapshot=events=>{
    if(!same(bind(),owner))throw Error('login registration native owner changed');
    for(const marker of [path.join(c.repo,'.lane/supervisor/STOP'),path.join(c.repo,'.lane/supervisor/HOLD'),path.join(c.org,'STOP')])
      if(fs.existsSync(marker))throw Error('project/record STOP/HOLD prevents login registration');
    const stop=readPlainFile(path.join(c.directory,'STOP'));if(!stop)throw Error('login registration requires service own STOP');
    if(inspectService(target,c.repo,command).loaded)throw Error('login registration requires positively stopped service');
    const main=readProjectPolicy(c.repo,'lane',env,{canonical:c.repo}).config.main??'main';
    if(git(c.repo,['symbolic-ref','--short','HEAD'])!==main||git(c.repo,['status','--porcelain=v1','--untracked-files=all']))throw Error('login registration requires clean canonical main');
    const source=serviceSource(c.repo,{home});
    if(!source.commit&&git(runtimeRoot,['status','--porcelain=v1','--untracked-files=all']))throw Error('login registration requires clean source');
    requireRecordCompatibility(runtimeRoot,events);
    if(readPlainFile(receiptFile)!==savedBytes||readPlainFile(file)!==plist)throw Error('login registration configuration changed');
    const last=history(events),registered=inspectLoginRegistration(login).registered;
    if(saved.login){if(!same(saved.login,login)||!registered)throw Error('saved login registration differs; retain it');}
    else if(registered)throw Error('existing login entry retained; no replacement or adoption');
    return {owner,head:git(c.repo,['rev-parse','HEAD']),source,source_head:source.commit??git(runtimeRoot,['rev-parse','HEAD']),stop_sha256:digest(stop),record_sha256:digest(canonical(events)),last_seq:last.seq};
  };
  const events=read(),initial=snapshot(events);
  if(saved.login)return {unchanged:true,dry_run:dryRun,login,runtime_started:false};
  const id=digest(canonical({before:savedBytes,plist,initial,login})),archiveFile=path.join(c.directory,'login-registrations',id+'.json');
  const plan={schema:'line-login-registration/v1',id,repo:c.repo,org:c.org,identity:c.identity,owner,user_home:env.HOME,previous_seq:initial.last_seq,initial,
    before:{installation:savedBytes,plist},after:{installation:json({...saved,login}),plist}};
  const bytes=json(plan),archive={file:archiveFile,sha256:digest(bytes)};
  const validate=current=>{if(!same(snapshot(current),initial))throw Error('login registration source/record/native CAS changed');};
  if(dryRun){validate(read());return {dry_run:true,expected_plan:archive.sha256,archive,plan,runtime_started:false};}
  if(expectedPlan!==archive.sha256)throw Error('login registration dry-run plan changed; exact --expected-plan required');
  const control=noticeLock(path.join(c.directory,'control.lock'),{recover:false});let pass,promotion;
  try{
    pass=noticeLock(path.join(c.directory,'pass.lock'),{recover:false});assertCommandQuiescence(c.directory);
    promotion=acquireLock(path.join(c.identity,'lane-promote.lock'));
    return transact(c.org,current=>{
      validate(current);plainDirectory(path.dirname(archiveFile));
      const fd=fs.openSync(archiveFile,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fault('intent');
      // Recheck binding and controls immediately before the exclusive symlink.
      if(!same(bind(),owner)||readPlainFile(receiptFile)!==savedBytes||readPlainFile(file)!==plist||
          digest(readPlainFile(path.join(c.directory,'STOP')))!==initial.stop_sha256||
          git(c.repo,['rev-parse','HEAD'])!==initial.head||git(c.repo,['status','--porcelain=v1','--untracked-files=all'])||
          !same(serviceSource(c.repo,{home}),initial.source)||inspectService(target,c.repo,command).loaded||
          [path.join(c.repo,'.lane/supervisor/STOP'),path.join(c.repo,'.lane/supervisor/HOLD'),path.join(c.org,'STOP')].some(p=>fs.existsSync(p)))throw Error('login registration effect CAS changed; original intent retained');
      createLoginRegistration(login);fault('login');
      writeFileAtomic(receiptFile,plan.after.installation,0o600);fault('installation');
      return {add:[{type:'line-service.login-registered',schema:plan.schema,id,project:c.identity,repo:c.repo,org:c.org,previous_seq:initial.last_seq,archive,native_caller:owner,runtime_started:false}],
        result:{registered:true,login,archive,runtime_started:false}};
    },{actor:owner.name,strictTail:true,lockOptions:{recover:false}}).result;
  }finally{promotion?.();pass?.();control();}
}
