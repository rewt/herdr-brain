// Completion discharges the bootstrap exception into an ordinary migration.
// The original trial/recovery remains immutable provenance, never a new trial.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {canonical} from '../messages/schema.mjs';
import {readPlainFile,plainDirectory,writeFileAtomic} from '../lib/files.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {projectEnvironment,projectPin,selectRelease,checkRelease,requireReadyAcceptance} from '../lib/releases.mjs';
import {requireRecordCompatibility} from '../lib/record-compatibility.mjs';
import {probationRuntime,completedProbationRuntime,authorityOwner} from './probation.mjs';
import {developmentHistory} from './development-recovery.mjs';
import {runtimeHistory,digest} from './runtime.mjs';
import {inspectService} from './migrate-runtime.mjs';
import {withRuntimeLocks} from './runtime-locks.mjs';

const same=(a,b)=>canonical(a)===canonical(b),json=v=>JSON.stringify(v)+'\n';
const folder=c=>path.join(c.directory,'probation-completions');
export const completionFile=(c,id)=>path.join(folder(c),id+'.json');

// An uncommitted file is UNKNOWN even when the installation was never written.
export function completionRows(events,c){
  const rows=events.filter(e=>e.type==='line-service.runtime-migrated'&&e.mode==='probation-completion'&&e.project===c.identity&&e.org===c.org);
  if(fs.existsSync(folder(c))){
    plainDirectory(folder(c),{create:false});
    if(!same(fs.readdirSync(folder(c)).sort(),rows.map(e=>e.id+'.json').sort()))throw Error('existing/UNKNOWN probation completion retained; no replay or replacement');
  }else if(rows.length)throw Error('probation completion archive missing');
  return rows;
}

export function completedInstallation(events,c,{event,cutover}){
  const ref=event.archive;
  if(!/^[-a-zA-Z0-9_]{1,80}$/.test(event.id??'')||ref?.file!==completionFile(c,event.id))throw Error('probation completion anchor binding differs');
  const bytes=readPlainFile(ref.file),a=JSON.parse(bytes),end=events.find(e=>e.seq===event.seq+1);
  const original=events.find(e=>e.type==='line-service.probation-authorized'&&e.id===event.id&&e.project===c.identity&&e.org===c.org);
  if(digest(bytes)!==ref.sha256||(fs.statSync(ref.file).mode&0o222)||a.schema!=='line-runtime-probation-completion/v1'||a.id!==event.id||
      a.repo!==c.repo||a.org!==c.org||a.identity!==c.identity||event.repo!==c.repo||event.trial!==event.id||
      a.source!==event.source||event.previous_source!==a.source||!same(a.runtime,event.runtime)||!same(a.cutover,cutover)||
      event.cutover_seq!==cutover.seq||event.cutover_id!==cutover.id||!original||a.authority_seq!==original.seq||!same(a.authority_archive,original.archive)||
      a.previous_seq!==event.previous_seq||event.previous_seq>=event.seq||!same(a.owner.native,event.native_caller)||event.by!==a.owner.native.name||
      end?.type!=='line-service.probation-completed'||end.id!==event.id||end.project!==c.identity||end.repo!==c.repo||end.org!==c.org||
      end.authority_seq!==original.seq||!same(end.archive,original.archive)||!same(end.conversion,{id:event.id,...ref})||
      !same(end.native_caller,event.native_caller)||end.by!==event.by)throw Error('probation completion archive/event changed');
  const before=JSON.parse(a.before.installation),admitted=completedProbationRuntime(c.repo,{root:before.source,events,completion:event});
  if(admitted?.probation.id!==event.id||!before.probation_bootstrap||before.probation_bootstrap.trial!==event.id||before.migration||before.fresh_install)
    throw Error('probation completion original bootstrap differs');
  const prior=developmentHistory(events,{...c,installation:before,cutover,root:before.source,trial:admitted.probation,
    through:event.previous_seq,plistBytes:a.before.plist,archiveOnly:true});
  const {probation_bootstrap,probation_successor,...base}=before;
  const {probation,...release}=admitted;
  const after={...base,runtime:release};
  if(prior.last.seq!==event.previous_seq||before.source!==a.source||!same(a.runtime,release)||a.after.installation!==json(after)||a.after.plist!==a.before.plist)
    throw Error('probation completion installation/history differs');
  return{installation:{...after,migration:{id:event.id,...ref}},plist:a.after.plist,last:event};
}

export function completeBootstrap({c,id,owner,clean,toolRoot,home,dryRun,expectedPlan,command,fault}){
  const installationFile=path.join(c.directory,'installation.json'),plistFile=path.join(c.directory,'service.plist');
  const read=()=>{const r=loadEvents(c.org);if(r.tornTail)throw Error('incomplete record prevents probation completion');return r.events;};
  const qualify=source=>{
    const pin=projectPin(c.repo);
    if(!pin?.release||selectRelease(c.repo,home,{pin}).root!==source)throw Error('bootstrap completion requires a READY pin selecting the settled installed root');
    const release=checkRelease(home,pin.release,{verifyFiles:true});requireReadyAcceptance(release,home);return release;
  };
  const controls=()=>{
    const head=clean();
    for(const name of ['STOP','HOLD'])if(fs.existsSync(path.join(c.repo,'.lane/supervisor',name)))throw Error('project STOP/HOLD prevents bootstrap completion');
    const stop=readPlainFile(path.join(c.directory,'STOP'));if(!stop)throw Error('bootstrap completion requires service own STOP');
    const target=`gui/${process.getuid()}/dev.herdr.line.${path.basename(c.directory)}`,service=inspectService(target,c.repo,command);
    if(service.loaded)throw Error('bootstrap completion requires positively stopped service');
    return{head,target,stop_sha256:digest(stop),service};
  };
  const events=read(),savedBytes=readPlainFile(installationFile),saved=JSON.parse(savedBytes),plist=readPlainFile(plistFile);
  const stateFor=current=>{
    const cutovers=current.filter(e=>e.type==='line-service.cutover'&&e.project===c.identity&&e.org===c.org);
    if(cutovers.length!==1||cutovers[0].repo!==c.repo)throw Error('bootstrap completion original cutover missing/ambiguous');
    return{cutover:cutovers[0],state:runtimeHistory(current,{...c,installation:saved,cutover:cutovers[0],root:saved.source})};
  };
  const initial=controls(),runtime=qualify(saved.source);
  if(saved.repo!==c.repo||saved.org!==c.org||saved.file!==plistFile||saved.node!==process.execPath||saved.target!==initial.target||saved.phase!=='installed')
    throw Error('bootstrap completion requires the settled installed root binding');
  const {cutover,state}=stateFor(events);
  const main=execFileSync('git',['-C',c.repo,'symbolic-ref','--short','HEAD'],{env:projectEnvironment(),encoding:'utf8'}).trim();
  if(cutover.main!==main)throw Error('bootstrap completion cutover main differs');
  execFileSync('git',['-C',c.repo,'merge-base','--is-ancestor',cutover.canonical_head,initial.head],{env:projectEnvironment(),stdio:['ignore','pipe','pipe']});
  const admitted=probationRuntime(c.repo,{root:saved.source,events,home,allowEnded:true});
  if(admitted?.probation.id!==id)throw Error('bootstrap completion requires the original installed trial');
  // Execute the new reader from the installed root itself. A newer canonical
  // tool must not convert an old bundle that cannot read its resulting anchor.
  if(toolRoot!==saved.source)throw Error('bootstrap completion must execute from its exact installed runtime');
  const ended=events.filter(e=>['line-service.probation-completed','line-service.probation-withdrawn'].includes(e.type)&&e.id===id&&e.project===c.identity&&e.org===c.org);
  if(ended.length){
    const conversion=ended[0].conversion;
    if(ended.length!==1||!conversion||!same(saved.migration,conversion)||state.last.type!=='line-service.runtime-migrated')throw Error('ended probation lacks its current exact completion anchor; no conversion replay');
    if(!dryRun&&expectedPlan!==undefined&&expectedPlan!==conversion.sha256)throw Error('bootstrap completion requires its exact --expected-plan');
    return{existing:true,id,dry_run:dryRun,conversion,admissions:false,ordinary_admissions:true,runtime_started:false};
  }
  if(!saved.probation_bootstrap||saved.probation_bootstrap.trial!==id||saved.migration||saved.fresh_install)throw Error('bootstrap completion requires original bootstrap installation');
  const original=events.find(e=>e.seq===admitted.probation.seq);
  const {probation,...release}=admitted;
  if(!same(runtime,release)||!same(saved.runtime,runtime))throw Error('bootstrap completion accepted runtime tuple differs');
  const {probation_bootstrap,probation_successor,...base}=saved,after={...base,runtime};
  const archive={schema:'line-runtime-probation-completion/v1',id,repo:c.repo,org:c.org,identity:c.identity,source:saved.source,runtime,
    authority_seq:admitted.probation.seq,authority_archive:admitted.probation.archive,cutover,previous_seq:state.last.seq,owner,canonical_head:initial.head,
    stop_sha256:initial.stop_sha256,service:initial.service,before:{installation:savedBytes,plist},after:{installation:json(after),plist}};
  const bytes=json(archive),ref={id,file:completionFile(c,id),sha256:digest(bytes)};
  const continuation={root:saved.source,release:runtime.id,installation_sha256:digest(savedBytes),plist_sha256:digest(plist)};
  const validate=current=>{
    authorityOwner(current.find(e=>e.seq===original.authority),current);
    if(!same(controls(),initial)||!same(qualify(saved.source),runtime)||readPlainFile(installationFile)!==savedBytes||readPlainFile(plistFile)!==plist||
        stateFor(current).state.last.seq!==state.last.seq)throw Error('bootstrap completion source/record/native CAS changed');
    requireRecordCompatibility(saved.source,current);
  };
  return withRuntimeLocks(c,{id,operation:'probation-complete',dryRun,owner,validate:()=>validate(read())},()=>{
    validate(read());
    if(dryRun)return{dry_run:true,id,expected_plan:ref.sha256,conversion:ref,admissions:false,ordinary_admissions:true,continuation,runtime_started:false};
    if(expectedPlan!==undefined&&expectedPlan!==ref.sha256)throw Error('bootstrap completion dry-run plan changed; exact --expected-plan required');
    return transact(c.org,current=>{
      validate(current);plainDirectory(folder(c));
      const fd=fs.openSync(ref.file,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fault('intent');
      if(!same(controls(),initial)||!same(qualify(saved.source),runtime)||readPlainFile(installationFile)!==savedBytes||readPlainFile(plistFile)!==plist)
        throw Error('bootstrap completion effect CAS changed; original intent retained');
      writeFileAtomic(installationFile,json({...after,migration:ref}),0o600);fault('installation');
      const common={id,project:c.identity,repo:c.repo,org:c.org,native_caller:owner.native};
      return{add:[{...common,type:'line-service.runtime-migrated',mode:'probation-completion',trial:id,source:saved.source,previous_source:saved.source,
        previous_seq:state.last.seq,cutover_seq:cutover.seq,cutover_id:cutover.id,runtime,archive:{file:ref.file,sha256:ref.sha256}},
      {...common,type:'line-service.probation-completed',authority_seq:admitted.probation.seq,archive:admitted.probation.archive,conversion:ref,emergency:false,continuation}],
      result:{id,converted:true,conversion:ref,admissions:false,ordinary_admissions:true,continuation,captured_work_preserved:true,runtime_started:false}};
    },{actor:owner.native.name,strictTail:true,lockOptions:{recover:false}}).result;
  });
}
