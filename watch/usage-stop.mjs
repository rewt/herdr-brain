// Watcher-owned recovery only: no launch, claim transfer, or runtime migration.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, sameNative, readWatchSubject } from './shared.mjs';
import { writeFileAtomic, withRecordGuard } from '../lib/store.mjs';
import { assertOwner, readOwnedRun } from '../lib/run-owner-guard.mjs';
import { effectiveWorkerIdentity } from '../lib/worker-identity.mjs';
import { dispatchSourceBinding } from '../lib/source-provenance.mjs';
import { gitProject } from '../lib/project.mjs';
import { openQuestionsFor } from '../lib/state.mjs';
import { offerQuiet } from '../supervisor/prompt-supervisor.mjs';

export const usageStopFile = (org, run) => path.join(org, 'watch', 'usage-stops', `${run}.json`);
const hash = text => createHash('sha256').update(text).digest('hex');
const plain = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
const bindingFor = current => ({agent:current.meta?.agent,pane:current.meta?.pane,
  workspace:current.meta?.worker_workspace,terminal:current.meta?.terminal_id,
  session:current.meta?.agent_session_id,cwd:current.workspace});

// Inspect the last native error, rather than matching quoted source/transcript
// prose above it. Other native layouts fall back to an explicit unclassified stop.
export function classifyUsageStop(screen) {
  const text = plain(screen), lines = text.split('\n');
  const start = lines.findLastIndex(line => /^\s*[■!]/.test(line) || /^\s*⎿\s+Not logged in\b/i.test(line));
  const tail = start < 0 ? [] : lines.slice(start);
  const prompt = tail.findIndex(line=>/^\s*[›❯](?:\s|$)/.test(line));
  let body = prompt < 0 ? tail : tail.slice(0,prompt);
  const completion = body.findIndex(line => /^\s*[✻✽✶✳✢·]\s+\S+(?:\s+\S+)*?\s+for\s+\d+(?:\.\d+)?(?:ms|s|m|h)\b/.test(line));
  if (completion >= 0) body = body.slice(0,completion);
  const blank = body.findIndex(line=>!line.trim());
  // A stale error above a later assistant turn is not this turn's stop.
  const stale = blank>=0 && body.slice(blank).some(line=>line.trim());
  const error = stale ? '' : body.join(' ');
  // Claude's zero-second failed turn uses a tool-result marker, not the
  // Codex error marker. Never infer restored credentials from a quiet prompt.
  if (/^\s*(?:[■!]|⎿)\s*(?:Not logged in\b|Authentication failed\b|Session expired\b)/i.test(error))
    return {kind:'sign-in-required',reset_at:null,
      reason:'native sign-in failed; supervisor must restore sign-in in the original worker, verify its run/claim/native binding, then continue that same run; no automatic input'};
  const limited = /(?:usage|rate|account|request|message|weekly|credit|quota).{0,50}(?:limit|quota|exhaust|exceed|reached)|(?:hit|reached|exceeded).{0,40}(?:limit|quota)|(?:out of|insufficient|not enough)\s+credits/i.test(error);
  if (!limited) return {kind:'unclassified-stop',reset_at:null,reason:'terminal worker without a valid report; native stop reason/reset unknown'};
  const resetText = /(?:try\s+again\s+at|resets?\s+(?:at|on))\s+(.+?)(?:\.(?:\s|$)|$)/i.exec(error)?.[1]?.trim();
  // Native absolute dates use the host's local timezone. Relative/ambiguous
  // clocks are deliberately held, never guessed into an early resume.
  const normalized = resetText?.replace(/(\d)(?:st|nd|rd|th)\b/g, '$1');
  const absolute = normalized && /\b\d{4}\b/.test(normalized) && /\d:\d{2}/.test(normalized);
  const reset = absolute ? Date.parse(normalized) : NaN;
  return {kind:'usage-limit',reset_at:Number.isFinite(reset)?new Date(reset).toISOString():null,
    reason:Number.isFinite(reset)?'account usage limit; waiting for native reset time':'account usage limit; native reset time unavailable or ambiguous'};
}

// Native quiet checks surround this fresh record/source fence. The final quiet
// read is immediately before input, using the existing guarded offer adapter.
export function recoveryFence({org, current, ownership, canonical, binding}, action) {
  return withRecordGuard(org, (events, state) => {
    const run = assertOwner(readOwnedRun(org, current.id, events), ownership);
    const worker = effectiveWorkerIdentity(run, state), project = gitProject(run.workspace);
    if (project.canonical !== canonical || project.checkout !== binding.cwd || worker.identity_conflict ||
        !sameNative(binding, {name:worker.agent,pane_id:worker.pane,workspace_id:worker.worker_workspace,
          terminal_id:worker.terminal_id,agent_session:{value:worker.agent_session_id},cwd:run.workspace}))
      throw Error('original worker/source binding changed');
    dispatchSourceBinding({run,events,identity:project.identity,org,workspace:binding.cwd});
    let item = state.items.get(run.item);
    if (!item || item.closed || run.report || run.abandoned ||
        item.runs.findLast(id => !state.runs.get(id)?.abandoned) !== run.id || openQuestionsFor(state,run.item).length)
      throw Error('run is no longer eligible for in-place recovery');
    while(item) { if(item.meta.hold)throw Error(`HOLD on ${item.id}`); item=state.items.get(item.parent); }
    if ([path.join(canonical,'.lane/supervisor/STOP'),path.join(canonical,'.lane/supervisor/HOLD'),path.join(org,'STOP')].some(file=>fs.existsSync(file)))
      throw Error('STOP/HOLD prevents usage-limit recovery');
    if (run.report_path && fs.existsSync(run.report_path))
      throw Error('report file present; retain it for normal watcher validation');
  }, action, {label:'usage-limit-recovery'});
}

export async function reconcileUsageStop({org,current,ownership,canonical,native,herdr,call,
  now=Date.now,offer=offerQuiet,fence=recoveryFence,confirmSeconds=3}) {
  // Resolve the side-table binding locally; raw runs are completion inputs and
  // must never be enriched with a late session.
  const subject=readWatchSubject(org,current.id);
  if(subject.meta.identity_conflict)throw Error('original worker identity_conflict; retain usage-stop duty');
  const file=usageStopFile(org,current.id), binding=bindingFor(subject);
  let saved=readJson(file);
  if (saved && (JSON.stringify(saved.ownership)!==JSON.stringify(ownership) ||
      JSON.stringify(saved.binding)!==JSON.stringify(binding)))
    throw Error('original usage-stop recovery binding changed; retain receipt');
  const save = value => {
    const next={schema:'brain.usage-stop/v1',run:current.id,ownership,binding,...value};
    // No native effect is authorized by this diagnostic write.
    withRecordGuard(org,events=>assertOwner(readOwnedRun(org,current.id,events),ownership),()=>{
      fs.mkdirSync(path.dirname(file),{recursive:true});
      writeFileAtomic(file,JSON.stringify(next)+'\n');
    },{label:'usage-stop-observation'});
    saved=next;
  };
  if (!sameNative(binding,native)) return {handled:false,reason:'original native binding unavailable; reset unknown'};
  if (native?.agent_status==='working') {
    if(saved && saved.phase!=='working')save({...saved,phase:'working',attempt:(saved.attempt??0)+1,reason:'original worker observed working'});
    return {handled:false};
  }
  if (!['idle','done'].includes(native?.agent_status)) return {handled:false};
  const counters={state_change_seq:native.state_change_seq,completion_seq:native.completion_seq};
  const advanced=saved && Object.keys(counters).some(key=>Number.isSafeInteger(counters[key]) &&
    Number.isSafeInteger(saved.native_counters?.[key]) && counters[key]>saved.native_counters[key]);
  // A finite observer may miss the entire working interval. A later terminal
  // sequence ends this hold, but does not grant permission to replay input.
  if(saved?.kind==='usage-limit' && (saved.phase==='completed' || saved.phase!=='working' && advanced)){
    if(saved.phase!=='completed')save({...saved,phase:'completed',native_counters:counters,
      reason:'original native lifecycle advanced without observed working; owner must inspect the new terminal result'});
    return {handled:false,receipt:saved};
  }
  // No complete immutable record/native tuple means no input authority.
  if (saved && ['offering','delivered','refused','uncertain'].includes(saved.phase))
    return {handled:true,wait_ms:30000,receipt:saved};
  let screen;
  try {screen=call(herdr,['pane','read',binding.pane,'--lines','60','--format','ansi']);}
  catch(error) {
    save({...saved,phase:'held',kind:'unclassified-stop',reset_at:null,reason:`native screen unavailable: ${error.message}`});
    return {handled:false,receipt:saved};
  }
  const observation=classifyUsageStop(screen);
  if (!saved || saved.screen_sha256!==hash(screen) || saved.phase==='working')
    save({attempt:saved?.attempt??0,observed_at:new Date(now()).toISOString(),screen_sha256:hash(screen),native_counters:counters,...observation,phase:'held'});
  if(observation.kind==='sign-in-required')return {handled:true,wait_ms:30000,receipt:saved};
  if(observation.kind!=='usage-limit')return {handled:false,receipt:saved};
  if(!observation.reset_at)return {handled:true,wait_ms:30000,receipt:saved};
  const remaining=Date.parse(observation.reset_at)-now();
  if(remaining>0)return {handled:true,wait_ms:Math.min(remaining+1000,30000),receipt:saved};
  const context={org,current,ownership,canonical,binding};
  let fenceRejected=false;
  try {
    fence(context,()=>{});
    const result=await offer({text:`[usage-limit-resume] Continue the existing run ${current.id} in this session after the account reset. Preserve the original claim, folder and any unlanded commit; inspect existing evidence and do not replay completed checks or effects.`,
      binding:{name:binding.agent,pane:binding.pane,terminal:binding.terminal,nativeSession:binding.session,
        workspace:binding.workspace,cwd:binding.cwd,generation:String(ownership.generation),herdr},
      beforePrompt:()=>{
        // Save before entering the source fence to avoid nesting record locks.
        save({...saved,phase:'offering',offered_at:new Date(now()).toISOString(),reason:'input intent saved; acknowledgement pending'});
        try {fence(context,()=>{});}catch(error){fenceRejected=true;throw error;}
      }},
    {call,confirmSeconds});
    save({...saved,phase:result.state==='pending'?'held':result.state,reason:result.reason});
  }catch(error){
    // A crash or failure after intent never authorizes another offer.
    save({...saved,phase:!fenceRejected && saved.phase==='offering'?'uncertain':'held',reason:error.message});
  }
  return {handled:true,wait_ms:30000,receipt:saved};
}
