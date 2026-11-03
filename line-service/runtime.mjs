// The line's executing source is explicit. Saved worker/watch runtimes are not
// selected again when the controller moves to an accepted installed release.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {gitProject} from '../lib/project.mjs';
import {bundleRelease,projectPin,selectRelease,checkRelease,releaseHome,requireReadyAcceptance} from '../lib/releases.mjs';
import {readPlainFile,plainDirectory} from '../lib/files.mjs';
import {loginChanges,applyLoginChange} from './login-history.mjs';
import {recipientChanges,applyRecipientChange,legacyRecipientHistory} from './recipient-history.mjs';
import {installationPhaseProof,settledInstallation} from './runtime-phase.mjs';
import {freshInstallation} from './install-history.mjs';
import {findOrgDir,loadEvents} from '../lib/store.mjs';
import {requireRecordCompatibility} from '../lib/record-compatibility.mjs';
import {probationRuntime} from './probation.mjs';
import {developmentHistory} from './development-recovery.mjs';
import {completionRows,completedInstallation} from './probation-completion.mjs';

export const runtimeRoot=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export function acceptedRuntime(repo,{root=runtimeRoot,home=releaseHome(),verifyFiles=true,admission}={}) {
  root=fs.realpathSync(root);
  const trial=probationRuntime(repo,{root,home});
  if(trial)return trial;
  const pin=projectPin(repo);
  if(!pin?.release)throw Error('line runtime requires an explicit accepted project pin');
  const selected=selectRelease(repo,home,{pin});
  if(selected.root!==root)throw Error('executing line runtime differs from the accepted project pin');
  const release=checkRelease(home,pin.release,{verifyFiles});
  requireReadyAcceptance(release,home);
  const org=findOrgDir({cwd:repo,env:{...process.env,ORG_DIR:''}});
  if(org){const loaded=loadEvents(org);if(loaded.tornTail)throw Error('incomplete record prevents runtime admission');requireRecordCompatibility(root,loaded.events,admission);}
  return release;
}

export function serviceSource(repo,options={}) {
  const bundle=bundleRelease();
  if(bundle.commit)return acceptedRuntime(repo,options);
  const source=gitProject(runtimeRoot);
  if(source.checkout!==source.canonical)throw Error('live line service must use canonical development source or its accepted installed runtime');
  return bundle;
}

// Resolve the immutable migration followed by completed release handoffs. The
// original boundary and migration stay intact, including across a rollback.
export function runtimeHistory(events,{repo,org,identity,directory,installation,cutover,root=runtimeRoot}) {
  const completions=completionRows(events,{repo,org,identity,directory});
  if(installation.probation_bootstrap){
    if(completions.length)throw Error('probation completion migration binding differs');
    const admitted=probationRuntime(repo,{root:installation.source,events,allowEnded:true});
    if(admitted?.probation.id!==installation.probation_bootstrap.trial)throw Error('development recovery trial binding differs');
    return developmentHistory(events,{repo,org,identity,directory,installation,cutover,root,trial:admitted.probation});
  }
  const changes=recipientChanges(events,{repo,org,identity,directory});
  const rows=events.filter(e=>e.type==='line-service.runtime-migrated'&&e.project===identity&&e.org===org);
  let saved,plist,last,previous,historyStart;
  if(rows.length===1&&rows[0].mode==='probation-completion'){
    const event=rows[0],ref=installation.migration;
    if(installation.probation_bootstrap||!ref||ref.id!==event.id||ref.file!==event.archive?.file||ref.sha256!==event.archive?.sha256)
      throw Error('probation completion migration binding differs');
    ({installation:saved,plist,last}=completedInstallation(events,{repo,org,identity,directory},{event,cutover}));historyStart=event.seq;
  }else if(cutover.mode==='accepted-release-install'){
    if(rows.length||installation.migration)throw Error('fresh release installation has an unexpected migration');
    ({installation:saved,plist,last}=freshInstallation({repo,org,identity,directory,cutover}));historyStart=cutover.seq;
  }else{
  if(rows.length!==1)throw Error('service runtime migration is missing/ambiguous');
  const event=rows[0],ref=installation.migration;
  if(event.repo!==repo||event.previous_source!==cutover.source||event.cutover_seq!==cutover.seq||
      event.cutover_id!==cutover.id||!ref||ref.id!==event.id||ref.file!==event.archive?.file||ref.sha256!==event.archive?.sha256||
      event.seq<=cutover.seq||!/^[-a-zA-Z0-9_]{1,80}$/.test(event.id??'')||ref.file!==path.join(directory,'migrations',event.id+'.json'))throw Error('service runtime migration binding differs');
  const bytes=readPlainFile(ref.file),archive=JSON.parse(bytes);
  if(digest(bytes)!==ref.sha256||archive.schema!=='line-runtime-migration/v1'||archive.id!==event.id||archive.repo!==repo||archive.org!==org||archive.identity!==identity||
      archive.source!==event.source||archive.previous_source!==cutover.source||JSON.stringify(archive.cutover)!==JSON.stringify(cutover)||
      JSON.stringify(archive.runtime)!==JSON.stringify(event.runtime))throw Error('service runtime migration archive changed');
  saved={...JSON.parse(archive.after.installation),migration:ref};plist=archive.after.plist;last=event;historyStart=event.seq;
  legacyRecipientHistory(changes.filter(c=>c.event.seq<event.seq),{installation:JSON.parse(archive.before.installation),plist:archive.before.plist,cutover});
  if(saved.source!==event.source||JSON.stringify(saved.runtime)!==JSON.stringify(event.runtime))throw Error('service runtime migration archive changed');
  }
  const logins=loginChanges(events,{repo,org,identity,directory});
  const upgrades=events.filter(e=>e.type==='line-service.runtime-upgraded'&&e.project===identity&&e.org===org);
  const upgradeDirectory=path.join(directory,'upgrades');
  if(fs.existsSync(upgradeDirectory)){
    plainDirectory(upgradeDirectory,{create:false});
    // An intent without its completion is UNKNOWN even if no files changed.
    const files=fs.readdirSync(upgradeDirectory).sort();
    if(JSON.stringify(files)!==JSON.stringify(upgrades.map(e=>e.id+'.json').sort()))throw Error('existing/UNKNOWN runtime upgrade is retained; no replay or replacement');
  }else if(upgrades.length)throw Error('service runtime upgrade archive is missing');
  const ids=new Set();
  for(const next of [...upgrades,...logins.filter(c=>c.event.seq>historyStart).map(c=>c.event),...changes.filter(c=>c.event.seq>historyStart).map(c=>c.event)].sort((a,b)=>a.seq-b.seq)){
    if(next.type==='line-service.login-registered'){
      const state=applyLoginChange(logins.find(c=>c.event.seq===next.seq),{installation:saved,plist,last});
      saved=state.installation;last=state.last;continue;
    }
    if(next.type==='line-service.recipient-retargeted'){
      const state=applyRecipientChange(changes.find(c=>c.event.seq===next.seq),{installation:saved,plist,last});
      saved=state.installation;plist=state.plist;last=state.last;continue;
    }
    const a=next.archive;
    if(!/^[-a-zA-Z0-9_]{1,80}$/.test(next.id??'')||ids.has(next.id)||next.repo!==repo||next.previous_seq!==last.seq||next.seq<=last.seq||
        next.previous_source!==saved.source||!path.isAbsolute(next.source??'')||next.source===saved.source||
        !['upgrade','rollback'].includes(next.direction)||a?.file!==path.join(upgradeDirectory,next.id+'.json'))throw Error('service runtime upgrade binding differs');
    ids.add(next.id);
    const bytes=readPlainFile(a.file),intent=JSON.parse(bytes);
    if(digest(bytes)!==a.sha256||intent.schema!=='line-runtime-upgrade/v1'||intent.id!==next.id||intent.repo!==repo||intent.org!==org||intent.identity!==identity||
        intent.source!==next.source||intent.previous_source!==saved.source||intent.previous_seq!==last.seq||intent.direction!==next.direction||
        JSON.stringify(intent.runtime)!==JSON.stringify(next.runtime)||intent.before.installation!==JSON.stringify(saved)+'\n'||intent.before.plist!==plist)throw Error('service runtime upgrade archive changed');
    if(next.direction==='rollback'&&(last.type!=='line-service.runtime-upgraded'||next.source!==last.previous_source||!previous))throw Error('runtime rollback does not name the previous accepted root');
    if(intent.phase_settlement&&JSON.stringify(intent.phase_settlement)!==JSON.stringify(installationPhaseProof(saved,intent.before.installation,
      {target:saved.target,service:intent.phase_settlement.service,stop_sha256:intent.stop_sha256})))throw Error('runtime installation settlement differs');
    const after=next.direction==='rollback'?previous.installation:settledInstallation({...saved,source:next.source,runtime:next.runtime},intent.phase_settlement);
    if(after.source!==next.source||JSON.stringify(after.runtime)!==JSON.stringify(next.runtime))throw Error('service runtime upgrade target differs');
    if(intent.after.installation!==JSON.stringify(after))throw Error('service runtime upgrade installation differs');
    if(next.direction==='rollback'&&intent.after.plist!==previous.plist)throw Error('service runtime rollback plist differs');
    previous={installation:saved,plist};
    saved=next.direction==='rollback'?after:{...after,upgrade:{id:next.id,...a}};plist=intent.after.plist;last=next;
  }
  if(saved.source!==root||JSON.stringify(saved)!==JSON.stringify(installation)||digest(readPlainFile(path.join(directory,'service.plist')))!==digest(plist))throw Error('migrated installation/plist drifted');
  return {last,installation:saved,plist,previous};
}
export function migratedCutover(events,options) {
  runtimeHistory(events,options);
  const {cutover}=options;
  return cutover;
}
