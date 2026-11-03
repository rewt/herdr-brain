// A Brain-only executable predecessor, not a release or consumer acceptance.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {captureProductCheckout,payloadEntry,verifyProductPayload} from '../lib/product-files.mjs';
import {readPlainFile,plainDirectory} from '../lib/files.mjs';
import {canonical} from '../messages/schema.mjs';
import {requireRecordCompatibility} from '../lib/record-compatibility.mjs';
import {installationPhaseProof,settledInstallation} from './runtime-phase.mjs';
import {replacementPlist} from './migrate-runtime.mjs';
import {loginChanges,applyLoginChange} from './login-history.mjs';
import {successorHistory} from './probation-successor-history.mjs';

export const recoveryDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
// Reuse is opt-in: every caller except a line snapshot verifies fresh.
export const verifyFresh=(key,paths,verify)=>verify();
// Normalize only original development path identity, never archived bytes or
// immutable installed-runtime tuples.
export const developmentSourceMatches=(source,repo)=>typeof source==='string'&&path.isAbsolute(source)&&path.resolve(source)===repo;
const same=(a,b)=>canonical(a)===canonical(b);
export const recoveryNode=()=>({executable:process.execPath,version:process.version,platform:process.platform,arch:process.arch,
  sha256:recoveryDigest(fs.readFileSync(process.execPath))});
const json=v=>JSON.stringify(v)+'\n';

export function prepareDevelopmentRecovery(c,{id,head,installation,plist,cutover,service,stop_sha256,command}){
  const saved=JSON.parse(installation),source=captureProductCheckout(c.repo,head);
  if(source.root!==c.repo||source.common!==c.identity||!developmentSourceMatches(saved.source,c.repo)||saved.runtime||saved.migration||saved.fresh_install||saved.probation_bootstrap||
      !['installed','stopped','uncertain-or-refused'].includes(saved.phase)||saved.repo!==c.repo||saved.org!==c.org||saved.node!==process.execPath||saved.file!==path.join(c.directory,'service.plist')||
      saved.target!==`gui/${process.getuid()}/dev.herdr.line.${path.basename(c.directory)}`)
    throw Error('development recovery requires the actual original Brain development installation');
  if(cutover?.repo!==c.repo||cutover.project!==c.identity||cutover.org!==c.org||cutover.source!==c.repo||
      !Number.isSafeInteger(cutover.seq)||!cutover.id||cutover.mode==='accepted-release-install')throw Error('development recovery original cutover differs');
  const root=path.join(c.directory,'development-recovery',id,'runtime'),release={root,id:'runtime',commit:source.commit,protocol:1};
  const manifest=json({schema:'herdr-release/v1',protocol:1,commit:source.commit,
    files:Object.fromEntries(Object.entries(source.files).map(([file,e])=>[file,e.sha256])),
    modes:Object.fromEntries(Object.entries(source.files).map(([file,e])=>[file,e.mode])),acceptance:{ran:false,ready:false}});
  const proof=installationPhaseProof(saved,installation,{target:saved.target,service,stop_sha256});
  const derived=settledInstallation({...saved,source:root,runtime:release},proof);
  return{kind:'development-recovery',release,source,node:recoveryNode(),manifest_sha256:recoveryDigest(manifest),
    inventory_sha256:recoveryDigest(JSON.stringify(source.files)),original:{installation,plist,cutover},
    derived:{installation:json(derived),plist:replacementPlist(c,saved,command,root)},...(proof?{phase_settlement:proof}:{})};
}

export function sealDevelopmentRecovery(c,previous){
  const {source,release}=previous,root=release.root;
  if(!same(captureProductCheckout(c.repo,source.commit),source))throw Error('development recovery source changed before sealing');
  plainDirectory(path.dirname(root));
  fs.mkdirSync(root); // An existing, partial or UNKNOWN package is never replaced.
  for(const [file,e]of Object.entries(source.files)){
    const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(path.join(source.root,file),target,fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target,e.mode==='100755'?0o555:0o444);
    if(!same(payloadEntry(root,file),e))throw Error('development recovery copy changed');
  }
  const manifest=json({schema:'herdr-release/v1',protocol:1,commit:source.commit,
    files:Object.fromEntries(Object.entries(source.files).map(([file,e])=>[file,e.sha256])),
    modes:Object.fromEntries(Object.entries(source.files).map(([file,e])=>[file,e.mode])),acceptance:{ran:false,ready:false}});
  for(const [name,bytes]of [['.release-commit',source.commit+'\n'],['.release-manifest.json',manifest]]){
    const fd=fs.openSync(path.join(root,name),'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  function protect(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true}))if(e.isDirectory())protect(path.join(dir,e.name));fs.chmodSync(dir,0o555);}
  protect(root);
  verifyDevelopmentRecovery(c,previous);
}

export function verifyDevelopmentRecovery(c,previous,events,reuse=verifyFresh){
  const {release,source}=previous,root=release?.root;
  reuse(`development-recovery:${recoveryDigest(canonical([c.repo,c.identity,c.directory,previous]))}`,[root,process.execPath],()=>{
    if(previous.kind!=='development-recovery'||!root||root!==path.join(c.directory,'development-recovery',path.basename(path.dirname(root)),'runtime')||
        source.root!==c.repo||source.common!==c.identity||release.commit!==source.commit||release.id!=='runtime'||release.protocol!==1||
        fs.realpathSync(root)!==root||!same(recoveryNode(),previous.node))throw Error('development recovery identity/node changed');
    if(recoveryDigest(readPlainFile(path.join(root,'.release-manifest.json')))!==previous.manifest_sha256||
        readPlainFile(path.join(root,'.release-commit'))!==source.commit+'\n'||
        verifyProductPayload(root,source,{metadata:['.release-commit','.release-manifest.json'],readOnly:true})!==previous.inventory_sha256)
      throw Error('development recovery payload changed');
  });
  if(events)requireRecordCompatibility(root,events);
  return release;
}

// Reconstruct only this typed initial entry. Ordinary migrations/fresh installs
// keep their existing reader and requirements. Every incomplete effect fences it.
export function developmentSwitchRows(events,{directory,identity,org}){
  const rows=events.filter(e=>e.type==='line-service.probation-switched'&&e.project===identity&&e.org===org);
  const folder=path.join(directory,'probation-switches');
  if(fs.existsSync(folder)){
    plainDirectory(folder,{create:false});
    if(!same(fs.readdirSync(folder).filter(n=>!n.startsWith('.successor-')).sort(),rows.map(e=>e.id+'.json').sort()))throw Error('existing/UNKNOWN probation switch retained; no replay or replacement');
  }else if(rows.length)throw Error('development recovery switch archive missing');
  return rows;
}
export function developmentHistory(events,{repo,org,identity,directory,installation,cutover,root,trial,through=Infinity,plistBytes,archiveOnly=false}){
  const allEvents=events;
  if(archiveOnly)events=events.filter(e=>e.seq<=through);
  const p=trial.previous,authority=events.find(e=>e.seq===trial.seq),scope=authority?.scope;
  if(p?.kind!=='development-recovery'||!same(p.original.cutover,cutover)||scope?.previous?.release.root!==p.release.root)
    throw Error('development recovery history authority/cutover differs');
  // A completed anchor replays retained, hash-bound archives only. The active
  // bootstrap path still verifies the sealed payload, Node and live record.
  if(archiveOnly){
    if(!Number.isSafeInteger(through)||p.source.root!==repo||p.source.common!==identity||
        p.release.root!==path.join(directory,'development-recovery',trial.id,'runtime')||p.release.commit!==p.source.commit||
        p.release.id!=='runtime'||p.release.protocol!==1)throw Error('completed recovery provenance differs');
  }else verifyDevelopmentRecovery({repo,org,identity,directory},p,events);
  const rows=developmentSwitchRows(events,{directory,identity,org});
  const folder=path.join(directory,'probation-switches');
  if(!fs.existsSync(folder))throw Error('development recovery switch archive missing');
  plainDirectory(folder,{create:false});
  if(!same(fs.readdirSync(folder).filter(n=>!n.startsWith('.successor-')).sort(),rows.map(e=>e.id+'.json').sort()))throw Error('existing/UNKNOWN probation switch retained; no replay or replacement');
  let saved=JSON.parse(p.original.installation),savedBytes=p.original.installation,plist=p.original.plist,last=cutover;
  const ids=new Set();
  for(const event of rows){
    const ref=event.archive;
    if(event.trial!==trial.id||ids.has(event.id)||!/^[-a-zA-Z0-9_]{1,80}$/.test(event.id??'')||
        ref?.file!==path.join(folder,event.id+'.json')||event.repo!==repo||event.previous_seq!==last.seq||event.seq<=last.seq)
      throw Error('development recovery switch binding differs');
    ids.add(event.id);
    const bytes=readPlainFile(ref.file),a=JSON.parse(bytes),note=events.find(e=>e.seq===event.authority);
    const target=event.source===scope.candidate.release.root?scope.candidate.release:event.source===p.release.root?p.release:null;
    const previousSource=last===cutover&&developmentSourceMatches(saved.source,repo)?repo:saved.source;
    if(!target||event.source===previousSource||recoveryDigest(bytes)!==ref.sha256||a.schema!=='brain-probation-switch/v1'||a.id!==event.id||
        a.trial!==trial.id||a.repo!==repo||a.org!==org||a.identity!==identity||a.previous_seq!==last.seq||a.source!==event.source||
        a.previous_source!==previousSource||event.previous_source!==previousSource||a.recovery_sha256!==recoveryDigest(canonical(p))||
        a.owner.native.name!==authority.owner.native.name||!same(event.native_caller,a.owner.native)||
        a.scope_sha256!==trial.scope_sha256||!same(a.runtime,target)||!same(event.runtime,target)||a.before.installation!==savedBytes||a.before.plist!==plist||
        note?.type!=='note.added'||note.decision!==true||note.by!==a.owner.native.name||note.text!==`Brain probation switch authorized: ${event.id} ${ref.sha256}`)
      throw Error('development recovery switch archive/authority changed');
    const base=JSON.parse(p.derived.installation),after={...base,source:target.root,runtime:target};
    if(a.after.installation!==json(after))throw Error('development recovery switch installation differs');
    saved={...after,probation_bootstrap:{trial:trial.id,id:event.id,...ref}};savedBytes=json(saved);plist=a.after.plist;last=event;
  }
  const successor=successorHistory(events,{repo,org,identity,directory},{trial,scope,saved,savedBytes,plist,last});
  saved=successor.installation;plist=successor.plist;last=successor.last;
  for(const change of loginChanges(allEvents,{repo,org,identity,directory}).filter(c=>c.event.seq<=through)){
    const next=applyLoginChange(change,{installation:saved,plist,last});saved=next.installation;last=next.last;
  }
  if(last.seq>through||!rows.length||saved.source!==root||!same(saved,installation)||(plistBytes??readPlainFile(path.join(directory,'service.plist')))!==plist)
    throw Error('development recovery installation/plist drifted');
  return{last,installation:saved,plist,successor};
}
