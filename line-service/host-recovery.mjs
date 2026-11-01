// Diagnostics only. A lost process or a matching session never grants recovery
// authority. Original dispatch/watch receipts, refusals and native guards stand.
import fs from 'node:fs';
import path from 'node:path';
import {ownerAlive} from '../lib/process-owner.mjs';
import {readJson} from '../watch/shared.mjs';
import {usageStopFile} from '../watch/usage-stop.mjs';
import {inspectLoginRegistration} from './login-registration.mjs';
import {readProjectPolicy} from '../lib/config-policy.mjs';

export function hostRecoveryOwner(repo,env=process.env){
  try{return readProjectPolicy(repo,'promote',env,{canonical:repo}).config.to??'unresolved PROJECT SUPERVISOR (project promote.to is missing)';}
  catch(error){return `unresolved PROJECT SUPERVISOR (${error.message})`;}
}

export function hostRecoveryNotices({repo,org,identity,directory,installation,state,to,loaded,alive=ownerAlive}) {
  const notices=[],owner=to??installation?.recipient??'recorded PROJECT SUPERVISOR';
  const add=(boundary,reason,action,run)=>notices.push({boundary,owner,reason,action,...(run?{run}: {})});
  const source=installation?.source;
  if (!installation || installation.repo!==repo || installation.org!==org || installation.file!==path.join(directory,'service.plist') ||
      !path.isAbsolute(installation.source??'') || !path.isAbsolute(installation.node??'')) {
    add('installation','saved service installation is missing or foreign','Inspect the original installation and control receipts; do not bootstrap, replace or borrow another native identity.');
    return notices;
  }
  const control=`${JSON.stringify(installation.node)} ${JSON.stringify(path.join(source,'line-service/launchd.mjs'))}`;
  const args=`--repo ${JSON.stringify(repo)} --org ${JSON.stringify(org)}`;
  let registered=false;
  try { registered=!!installation.login&&inspectLoginRegistration(installation.login).registered; }
  catch(error){add('login-registration',error.message,'Retain the conflicting login entry; the project supervisor must inspect the saved installation before any repair.');}
  if(!registered)add('login-registration','this installation has no verified login entry; reboot does not bootstrap this service',
    `After login, restore the recorded supervisor's actual Herdr name/session in the canonical project. Inspect ${control} status ${args}; if unloaded, use that same source's stop ${args} then restart ${args}, with its fresh native/source/owner guards. For automatic login, the supervisor and release owner must use a source with the guarded register-login command: preview register-login with --dry-run, then apply with its exact --expected-plan SHA256 while the service is stopped. Preserve STOP/HOLD; never hand-edit its saved receipt.`);
  if(loaded===false)add('service-unloaded','launchd reports this saved service unloaded',
    `The project supervisor must restore its own native binding, inspect ${control} status ${args}, then use stop ${args} and restart ${args} from that source. Preserve existing STOP/HOLD and inspect their reasons first; do not clear them automatically.`);
  for(const marker of [path.join(directory,'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD'),path.join(org,'STOP')])
    if(fs.existsSync(marker))add('fence',`recovery held by ${marker}`,'The recorded owner of this STOP/HOLD must resolve it through existing guarded controls; diagnostic notices grant no permission to remove it.');
  for(const run of state.runs.values()){
    const item=state.items.get(run.item),m=run.meta??{};
    if(run.report||run.abandoned||!item||item.closed||item.runs.findLast(id=>!state.runs.get(id)?.abandoned)!==run.id||m.dispatch_project!==identity)continue;
    let watched=false;
    const watcher=m.watcher_host??(m.watcher_pid?{pid:Number(m.watcher_pid),identity:m.watcher_identity}:null);
    try{
      if(!watcher)throw Error('original watcher process receipt is missing; liveness is UNKNOWN');
      watched=alive(watcher);
    }
    catch(error){add('watcher-unknown',error.message,`Inspect the original watcher receipt for ${run.id}; unknown liveness never permits replacement.`,run.id);continue;}
    if(!watched)add('watcher-stopped','original watcher is absent or its recorded process birth no longer matches',
      `Project supervisor: inspect ${m.dispatch_journal??'the original dispatch journal'} and its saved release/recipient/claim. Use the original dispatch --retry ${run.id} --org ${JSON.stringify(org)} recovery, which first records a dead watcher and on a later explicit retry rearms it without replaying an acknowledged prompt. Shared duties also need their original observer owner restored. Preserve run, claim, folder, evidence, pending notices and any native refusal; never create a replacement run.`,run.id);
    try{
      const stop=readJson(usageStopFile(org,run.id));
      if(stop?.kind==='sign-in-required'&&stop.phase==='held')add('sign-in-required',stop.reason,
        `Supervisor must restore sign-in in original worker ${m.agent} (${m.pane}); verify its original run/claim/source/native tuple and continue ${run.id} in place. A terminal-ID mismatch remains held for supervisor inspection of original launch/session evidence; no implicit rebind or prompt replay.`,run.id);
    }catch(error){add('worker-stop-unknown',error.message,'Retain the original stop evidence for supervisor inspection.',run.id);}
  }
  return notices;
}
