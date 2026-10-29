// Original-request continuation only. No native reads/effects or lock recovery.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {originalPrestartProof} from '../line-service/review-resolutions.mjs';
import {validateWorkerBrief} from '../lib/worker-brief.mjs';
const implementation=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const hash=b=>createHash('sha256').update(b).digest('hex');
const plain=file=>{const s=fs.lstatSync(file);if(!s.isFile()||fs.realpathSync(file)!==path.resolve(file))throw Error('redirected original preflight evidence');return fs.readFileSync(file,'utf8');};
const capacityCodes=new Set(['DISPATCH_SESSION_CAP','DISPATCH_REVIEW_CAP','DISPATCH_DECISION_CAP']);
const implementationErrors=new Set(['loaded queue/dispatch implementation changed; wait for next real pass','immutable saved queue/dispatch implementation changed; retain its owner']);
export function implementationChangeOutcome(job){
  if(job.failure?.code!=='DISPATCH_IMPLEMENTATION_CHANGED'&&!implementationErrors.has(job.error))return null;
  return{kind:'implementation-changed',source:job.failure?.code==='DISPATCH_IMPLEMENTATION_CHANGED'?'typed-failure':'exact-legacy-outcome',native_launch_attempted:typeof job.native_launch_attempted==='boolean'?job.native_launch_attempted:null};
}
export function initialCapacityRefusal(entry){
  if(entry?.receipt?.status!==1||entry.receipt.signal||/EPERM|EACCES|native refusal|foreign|identity|reserved|HOLD|STOP/i.test(entry.error??''))return null;
  try{const value=JSON.parse(entry.receipt.stdout);return value.result==='failed'&&capacityCodes.has(value.code)&&!value.journal&&typeof value.reason==='string'?value:null;}catch{return null;}
}

// This exact legacy failure is thrown before journal allocation. Missing
// journals/runs alone are never zero-effect proof. A now-valid contract proves
// the missing address input actually changed; all other failures stay retained.
export function initialBriefRefusal({entry,contract,events,item,outcome}) {
  if(entry?.state!=='held'||entry.receipt?.status!==1||entry.receipt.signal||entry.receipt.signal_sent||
      outcome?.status!=='unknown'||outcome.reason!=='original request outcome unavailable; no replacement')return null;
  let result;try{result=JSON.parse(entry.receipt.stdout);}catch{return null;}
  const reason='Worker brief missing required fields: PROJECT SUPERVISOR address (configure owning project promote.to or launch MONITOR_SUPERVISOR_AGENT); no worker spawned';
  if(result.result!=='failed'||!['DISPATCH_FAILED','WORKER_BRIEF_REQUIRED'].includes(result.code)||result.reason!==reason||result.journal||result.native_launch_attempted===true||
      (entry.error??'').replace(/^dispatch:\s*/,'').trim()!==reason||
      !Number.isFinite(Date.parse(entry.at))||events.some(e=>e.type==='run.started'&&e.item===item&&Date.parse(e.at)>=Date.parse(entry.at)))return null;
  const current=typeof contract==='function'?contract():contract;
  validateWorkerBrief(current);
  return {kind:'changed-brief-address',original_sha256:hash(JSON.stringify(entry.receipt)),input_sha256:hash(JSON.stringify(current))};
}
// The old release override check threw synchronously before allocating a
// journal or touching a native worker. Only that exact terminal diagnostic,
// with the override now absent in an accepted release, admits one new intent.
export function initialSourceRootRefusal({entry,events,item,outcome,release,env}) {
  const reason='HERDR_BRAIN_ROOT must match the invoked development source root; no dispatch created';
  if(!release?.commit||env.HERDR_BRAIN_ROOT!==undefined||entry?.state!=='held'||entry.receipt?.status!==1||
      entry.receipt.signal||entry.receipt.signal_sent||entry.receipt.error||entry.native_launch_attempted===true||entry.history?.length||entry.failure?.kind==='fence'||
      entry.result?.journal||entry.result?.run||entry.result?.worker||entry.result?.native_launch_attempted===true||
      outcome?.status!=='unknown'||outcome.reason!=='original request outcome unavailable; no replacement'||outcome.journal||
      (entry.error??'').replace(/^dispatch:\s*/,'').trim()!==reason||!Number.isFinite(Date.parse(entry.at))||
      events.some(e=>e.type==='run.started'&&e.item===item&&Date.parse(e.at)>=Date.parse(entry.at)))return null;
  let result;try{result=JSON.parse(entry.receipt.stdout);}catch{return null;}
  if(result.result!=='failed'||result.code!=='DISPATCH_FAILED'||result.reason!==reason||result.journal||result.retry||
      result.native_launch_attempted===true||result.run||result.worker||result.launchProcess)return null;
  return {schema:'dispatch-readmission/v1',kind:'release-source-override-cleared',
    original_sha256:hash(JSON.stringify(entry)),input_sha256:hash(JSON.stringify([release.root,release.commit,'HERDR_BRAIN_ROOT absent'])),
    native_launch_attempted:false};
}
function capacityEvidence({job,journal,org,common,failure,terminal}){
  if(job.failure?.kind==='capacity'&&capacityCodes.has(job.failure.code)&&job.failure.stage===job.stage&&job.failure.native_launch_attempted===false)return job.failure;
  const matches=value=>value&&capacityCodes.has(value.code)&&value.journal===journal&&(value.reason??value.error)===job.error;
  if(matches(failure))return failure;if(matches(terminal))return terminal;
  try{const lines=plain(journal+'.driver.log').trim().split('\n');for(const line of lines.reverse())try{const value=JSON.parse(line);if(matches(value))return value;}catch{}}catch(e){if(e.code!=='ENOENT')throw e;}
  const file=path.join(org,'line-service',hash(JSON.stringify(common)).slice(0,20),'effects.json');let saved;try{saved=JSON.parse(plain(file));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(saved.identity!==common||saved.org!==org)throw Error('original preflight receipt has foreign service ownership');
  for(const entry of Object.values(saved.actions??{})){
    if(matches(entry.result))return entry.result;
    if(entry.receipt?.status===1&&!entry.receipt.signal)try{const value=JSON.parse(entry.receipt.stdout);if(matches(value))return value;}catch{}
  }
  return null;
}
// This legacy diagnostic describes a coordination barrier, not an uncertain
// launch. Only its original terminal AND published completion prove that fact.
// An extant/unreadable lock stays held; this reader never probes or recovers it.
function clearedRetirementBarrier({job,journal,common,terminal,terminalZero,events,requestHash}) {
  const lock=path.join(common,'retirement/owner.lock');
  if(job.stage!=='open'||!job.detached||!job.detached_refused||job.native_launch_attempted!==false||!terminalZero||
      job.error!==`locked: ${lock}; owner is live or unknown`||job.failure?.code!=='OUTCOME_UNKNOWN'||
      job.failure.kind!=='unknown'||job.failure.stage!==job.stage||job.failure.native_launch_attempted!==false||terminal.code!==job.failure.code)return false;
  if(!events.some(e=>e.type==='dispatch.completed'&&e.project===common&&e.journal===journal&&e.attempt===job.token&&
      e.item===job.item&&!e.run&&e.stage===job.stage&&e.exit_code===terminal.exit_code&&e.native_launch_attempted===false&&
      e.request_sha256===requestHash&&JSON.stringify(e.failure)===JSON.stringify(job.failure)))return false;
  try{fs.lstatSync(lock);return false;}catch(e){return e.code==='ENOENT';}
}
export function preflightContinuation({journal,repo,org,common,root=implementation,events=[],failure}) {
  if(!journal||path.dirname(path.resolve(journal))!==path.join(org,'dispatch'))return null;
  const bytes=plain(journal),job=JSON.parse(bytes);
  if(job.repo!==repo||job.org!==org||job.common!==common||job.release?.root!==root||
      ![job.phase1_protocol,job.reviewQueueProtocol].includes(1)||!['open','start'].includes(job.stage)||job.run||job.worker||job.launchProcess||job.sessionBinding||job.native_launch_attempted===true)return null;
  const original=originalPrestartProof({events,org,common,journal,job,requestHash:hash(bytes)});
  if(/EPERM|EACCES|native refusal|foreign|identity|reserved|HOLD|STOP/i.test(job.error??'')||!job.error&&!original)return null;
  if(events.some(e=>e.type==='run.started'&&(e.meta?.dispatch_attempt===job.token||e.meta?.dispatch_journal===journal)))return null;
  let terminal=null;try{terminal=JSON.parse(plain(journal+'.driver/results.jsonl').trim().split('\n').at(-1));}catch(e){if(e.code!=='ENOENT')throw e;}
  const terminalZero=terminal?.journal===journal&&terminal.stage===job.stage&&!terminal.run&&Number.isInteger(terminal.exit_code)&&terminal.exit_code!==0&&terminal.error===job.error&&terminal.native_launch_attempted===false;
  if(job.native_launch_attempted!==false&&!terminalZero&&!original)return null;
  const capacity=job.failure?.kind==='capacity'||capacityCodes.has(failure?.code)||/^(?:review|session) cap \d+ reached:/.test(job.error)?capacityEvidence({job,journal,org,common,failure,terminal}):null;
  const retirement=clearedRetirementBarrier({job,journal,common,terminal,terminalZero,events,requestHash:hash(bytes)});
  if(/unknown|uncertain/i.test(job.error??'')&&!capacity&&!original&&!retirement)return null;
  const files=['dispatch/dispatch.mjs','dispatch/preflight.mjs','dispatch/foreground-command.mjs','dispatch/outcome.mjs','dispatch/completion.mjs','lib/uncertain-outcome.mjs','dispatch/not-started.mjs','dispatch/request-lock.mjs','dispatch/launch-guard.mjs','lib/item-launch-hold.mjs','lib/worker-brief.mjs','line-service/review-queue.mjs','line-service/review-group.mjs','dispatch/session-cap.mjs','dispatch/unlanded-cap.mjs'];
  const capability=hash(JSON.stringify(files.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))])));
  // Retirement replay protection relies on dispatch.mjs rewriting the journal (preflightContinuations and cleared error/failure), changing request_sha256 so the old completion cannot match.
  if(!capacity&&!retirement&&job.preflightContinuations?.some(p=>p.capability===capability))return null;
  const terminalHash=terminal?hash(JSON.stringify(terminal)):null;
  return{journal,token:job.token,job,request_sha256:hash(bytes),terminal_sha256:terminalHash,capability,key:capacity||retirement?hash(JSON.stringify([capability,hash(bytes),terminalHash])):capability,capacity:!!capacity,outcome:retirement?{kind:'retirement-lock-cleared',source:'original-terminal-and-completion'}:implementationChangeOutcome(job),native_launch_attempted:original?job.native_launch_attempted??null:false,...(original?{original_prestart:{seq:original.seq,request_sha256:original.request_sha256}}:{})};
}
