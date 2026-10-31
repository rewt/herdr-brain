#!/usr/bin/env node
// One model-free pass. launchd supplies the schedule, existing CLIs own effects.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {foregroundCommand} from '../dispatch/foreground-command.mjs';
import {originalDispatchOutcome} from '../dispatch/outcome.mjs';
import {pendingSessionBinding,replaySessionBinding} from '../dispatch/session-bind-replay.mjs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, loadEvents, loadRecord, writeFileAtomic } from '../lib/store.mjs';
import { itemStatus, sortItems } from '../lib/state.mjs';
import { effectiveWorkerIdentity, workerReceipt } from '../lib/worker-identity.mjs';
import { readOwnedRun, requireController, assertOwner } from '../lib/run-owner.mjs';
import { loadDiscoveredRoutes, resolveLaunchRoute, selectRoute } from '../lanes/routes.mjs';
import { correctionSource } from '../lib/report-closeout.mjs';
import { directCloseoutObservation, currentCloseoutEntries, closeoutEvaluation } from '../lib/closeout.mjs';
import { checkSessionCap,dispatchPool } from '../dispatch/session-cap.mjs';
import { noticeLock } from '../supervisor/notice-lock.mjs';
import { closeoutRevision, scheduleLineCloseouts,lineServiceOwnsCleanup } from '../lib/closeout.mjs';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { reviewAttempt, readServiceJournal } from './review.mjs';
import {referenceRevision} from './review-reference-proof.mjs';
import {reviewQueueNoMutation} from './review-queue-outcome.mjs';
import {completionAttempts,completionPlanningProof,reconcileReviewCompletion} from './review-completion.mjs';
import { queueConsumer, isQueueReview, validateQueuedReview, reviewQueueBrief, reviewQueueRoute } from './review-queue.mjs';
import { roleIs } from '../lib/roles.mjs';
import { recordLineNotice,canonicalFailure } from './record-inbox.mjs';
import { enqueueNamedDecision } from './decision-wake.mjs';
import { canonical } from '../messages/schema.mjs';
import {bundleRelease} from '../lib/releases.mjs';
import {serviceSource,acceptedRuntime} from './runtime.mjs';
import {installedContext} from './cutoff.mjs';
import { discoverChanges,dispatchInput,phase0Boundary,morningDigest,recordReviewResults,reviewCompletionPlan,recordReviewCompletion,ensureReviewBoundary,canonicalReviewIndex,observeReviewHealth } from './phase1.mjs';
import {preflightContinuation,initialCapacityRefusal,initialBriefRefusal,initialSourceRootRefusal} from '../dispatch/preflight.mjs';
import {sourceCompletionProof,preEffectSourceHold,queueSourceException} from './source-completion.mjs';
import {createWorkerBrief,projectExceptionAddress} from '../lib/worker-brief.mjs';
import {observeReviewProgress,recoverServiceReview} from './review-recovery.mjs';
import {haltObservation,completeHaltPass} from './halt-repair.mjs';
import {itemLaunchHold} from '../lib/item-launch-hold.mjs';
import {queuePolicy,queueClass,queueSelected,orderQueue} from './priority-order.mjs';
import {isDecision,decisionActivation,decisionRoute,decisionBrief,applyDecision,observeDecisionConsequences} from './decisions.mjs';
import {judgmentDispatchAllowed} from './decision-policy.mjs';
import {outcomeFailure} from '../lib/uncertain-outcome.mjs';
import {queueOutcomeDecision,observeOutcomeDecisions} from './outcome-decision.mjs';
import {registerCloseoutWait,closeoutWait,closeoutWaitState,closeoutNextStage} from '../lib/closeout-status.mjs';
import {runCloseoutTurn,runReportIntake,CLOSEOUT_TURN_BUDGET_MS} from './closeout-turn.mjs';
import {transact} from '../lib/store.mjs';
import {readReviewAdmission,readOrdinaryAdmission,reviewAdmissionSubject} from './review-admission.mjs';
import {reviewAdmissionHold} from '../lib/review-admission.mjs';
import {ordinaryAdmissionHold} from '../lib/ordinary-admission.mjs';
import {commandIntent,finishCommand,forgetActiveCommand,pendingSubjectCommand} from '../lib/command-receipt.mjs';
import {refreshJournal,effectSubject} from './scheduling.mjs';
import {appendPassJournal,withPassJournal,passJournalSize,readPassJournal} from './pass-journal.mjs';
import {negativeEvaluationCache} from './evaluation-cache.mjs';
import {observeGeneralOwners} from './general-owner-alarm.mjs';
export { reviewAttempt } from './review.mjs';

export const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function noticeBoundary(key,entry,boundary){
  // Older journals omitted boundary. Only the original canonical key may
  // supply it on recurrence or from the retained audit row.
  boundary=entry.boundary??boundary;
  if(typeof boundary!=='string'||key!==createHash('sha256').update(canonical([boundary,entry.reason,entry.scope])).digest('hex')||entry.id!==`line-record-${key}`)throw Error('notice boundary/source is inconsistent');
  entry.boundary=boundary;
  return entry;
}
export function replayNoticeAudit(file,effects){
  return withPassJournal(file,view=>{
  const restored=new Set();for(const row of view.rows(effects.notice_audit_offset??view.size)){
    if(row.action==='review-health'&&row.health){if(row.health.project!==effects.identity||row.health.org!==effects.org)throw Error('diagnostic health project binding changed');effects.review_health=row.health;}
    if(row.action==='engineering-idle'&&row.progress){
      const p=row.progress;if(p.project!==effects.identity||p.org!==effects.org||!Number.isSafeInteger(p.count)||p.count<0||typeof p.pass!=='string'||!p.signature)throw Error('halt progress audit binding changed');
      effects.halt_progress=p;
    }
    const notice=row.notice_record;if(!notice)continue;const {key,entry}=notice;
    if(!entry||!Number.isSafeInteger(entry.count)||entry.count<1||!Number.isFinite(Date.parse(entry.first_at)))throw Error('notice audit source/count is inconsistent');
    noticeBoundary(key,entry,row.boundary);
    effects.record_notices??={};const prior=effects.record_notices[key];if(prior){noticeBoundary(key,prior,entry.boundary);if(prior.first_at!==entry.first_at)throw Error('notice audit first occurrence is inconsistent');}
    if(!prior||entry.count>prior.count){effects.record_notices[key]={...entry,state:prior?.state==='recorded'?'recorded':'diagnostic-only',...(prior?.record?{record:prior.record}:{}),...(prior?.review_count_recorded!==undefined?{review_count_recorded:prior.review_count_recorded}:{})};restored.add(key);}
  }
  return [...restored];
  });
}
export const serviceDirectory = (org, identity) => path.join(org, 'line-service', digest(identity).slice(0, 20));
export function reserved(item) {
  return item.role === 'human' || item.meta.operator_reserved || item.meta.reserved ||
    ['security', 'funds-and-chain', 'publish', 'delete-data', 'licensing', 'priorities'].includes(item.meta.category);
}
export function routeFor(item, config) {
  if(isDecision(item)){const route=item.meta.route??decisionRoute(config);resolveLaunchRoute(config,{route});return route;}
  const role = {ENG:'engineer',ARCH:'architect',REV:'reviewer',DOC:'writer',RES:'researcher',PLAN:'planner',TRI:'triage',DES:'designer'};
  const normalized = Object.entries(role).find(([prefix])=>roleIs(item,prefix))?.[1] ?? item.role;
  const task = {engineer:'implementation',architect:'planning',planner:'planning',reviewer:'review',writer:'writing',researcher:'research',triage:'chore',designer:'design'}[normalized];
  let route = item.meta.route ?? (config.routes?.[item.role] ? item.role : config.routes?.[normalized] ? normalized : null);
  if(!route){
    if(!task&&!item.capability)throw Error(`unsupported line role: ${item.role}; assign an explicit route or task capability`);
    const requested=item.capability??task;
    // Established task vocabularies differ across projects. Only known narrow
    // defaults are aliases; explicit capabilities and unsupported roles refuse.
    const aliases={implementation:['implementation-narrow'],planning:['planning-bounded']};
    const selected=!item.capability&&config.selection_policy?.by_task_class?.[requested]===undefined
      ? aliases[requested]?.find(name=>config.selection_policy?.by_task_class?.[name]!==undefined)??requested : requested;
    const fallback={planning:'unblock',research:'research',review:'review',chore:'chore',writing:'writer'}[requested];
    route=!item.capability&&config.selection_policy?.by_task_class?.[selected]===undefined&&fallback&&config.routes?.[fallback]
      ? fallback : selectRoute(config,selected);
  }
  resolveLaunchRoute(config, { route });
  return route;
}

function closeoutOrHold(closeout, log) {
  try { return closeout(); }
  catch (error) {
    const evidence = { ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.receipt !== undefined ? { receipt: error.receipt } : {}) };
    log({ action: 'closeout-held', reason: error.message, ...evidence });
    return { held: error.message, ...evidence };
  }
}

export function createLineService({ repo, org, to, herdr = 'herdr', env = process.env, command = foregroundCommand,
  recordNotice = recordLineNotice, wakeDecision = enqueueNamedDecision, capacity, identify = gitProject, now = () => new Date().toISOString(),
  childTimeoutMs=120000,maxStarts,maxStepsPerStage=8,passBudgetMs=480000,alertAfter=3,haltAfter=Number(env.HERDR_LINE_HALT_PASSES??3),workClock=()=>performance.now(),runtimeHome,closeoutMeasure }) {
  if(!Number.isSafeInteger(haltAfter)||haltAfter<1)throw Error('halt repair threshold must be a positive completed-pass count');
  const project = identify(repo);
  if (project.checkout !== project.canonical) throw Error('line service requires the canonical project checkout');
  repo = project.canonical;
  const discovered = findOrgDir({ cwd: repo, env: { ...env, ORG_DIR: '' } });
  org = fs.realpathSync(org ?? discovered);
  if (!discovered || fs.realpathSync(discovered) !== org) throw Error('line-service record differs from the project record');
  if (typeof to !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(to)) throw Error('name the actual project supervisor or brain-chat recipient with --to');
  const directory = serviceDirectory(org, project.identity), journal = path.join(directory, 'effects.json');
  fs.mkdirSync(directory, { recursive: true });
  const log = row => appendPassJournal(path.join(directory,'passes.jsonl'),{at:now(),pid:process.pid,...row});
  const childEnv = { ...env, ORG_DIR: org, ORG_ACTOR: 'line-service', HERDR_BRAIN_ROOT: sourceRoot };
  // Only development dispatches use this override. An accepted release keeps
  // its immutable entry point and normal project-pin selection, even if the
  // installer's environment carried a different source override.
  if (bundleRelease().commit) delete childEnv.HERDR_BRAIN_ROOT;
  // A launchd controller has no pane/session identity. Never inherit an installer's.
  for (const key of Object.keys(childEnv)) if (/^(HERDR_(ENV|PANE_ID|TAB_ID|WORKSPACE_ID)|CODEX_(SESSION_ID|THREAD_ID)|GIT_.*|LANE_CONFIG)$/.test(key)) delete childEnv[key];
  delete childEnv.ORG_GUARD_OVERRIDE; // A routine line never inherits an explicit judgment override.
  delete childEnv.HERDR_LINE_SUBJECT;delete childEnv.HERDR_LINE_SUBJECT_TOKEN;
  let timings,commandTurn;
  const invoke = (exe, args, { receipt = false } = {}) => {
    const started = performance.now();
    let r;
    try { const options={ cwd: repo, env: childEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,timeout:0 };
      r = commandTurn ? commandTurn(exe,args,options) : command(exe,args,options); }
    finally { if (timings) timings.effect_command_ms += performance.now() - started; }
    if (r.error || r.status !== 0) throw Object.assign(Error((r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim()), { code:r.error?.code,receipt: { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr,error:r.error?.code,...(r.activity?{activity:r.activity,signal_sent:r.signal_sent}:{}) } });
    return receipt ? { status: r.status, signal: r.signal ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } : r.stdout?.trim() ?? '';
  };
  const native = args => JSON.parse(invoke(herdr, args)).result;
  const cli = (file, args, options) => invoke(process.execPath, [path.join(sourceRoot, file), ...args], options);
  const sourceGit = (cwd, args) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
    env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,timeout:10000,
  }).trim();
  const observe = () => {
    const started = performance.now();
    if (timings) timings.snapshots++;
    const live = identify(repo);
    if (live.identity !== project.identity || live.canonical !== repo) throw Error('project identity changed');
    if(bundleRelease().commit)acceptedRuntime(repo,{verifyFiles:false,home:runtimeHome});
    if (fs.existsSync(path.join(directory, 'STOP')) || fs.existsSync(path.join(repo, '.lane/supervisor/STOP')) || fs.existsSync(path.join(repo, '.lane/supervisor/HOLD'))) throw Error('STOP/HOLD prevents line-service effects');
    const loaded = loadRecord(org);
    if (loaded.tornTail) throw Error('incomplete record tail');
    const result = { events: loaded.events, tornTail: loaded.tornTail, state: loaded.state };
    if (timings) timings.record_snapshot_ms += performance.now() - started;
    return result;
  };
  const guardRun = (id, { reported = true,current=true,workspace=true } = {}) => {
    const snapshot = observe(), run = snapshot.state.runs.get(id), item = run && snapshot.state.items.get(run.item);
    if (!run || run.abandoned || !item || current&&item.runs.at(-1) !== id) throw Error('unknown, abandoned or superseded run');
    requireController(readOwnedRun(org, id), 'brain');
    if (workspace&&identify(run.workspace).identity !== project.identity) throw Error('foreign run workspace');
    if(!workspace&&snapshot.events.find(e=>e.type==='run.started'&&e.id===id)?.meta?.dispatch_project!==project.identity)throw Error('original run project binding is missing/foreign');
    if (reported && !run.report) throw Error('report not ingested');
    return { ...snapshot, run, item };
  };
  const intake=()=>runReportIntake({project,org,cli,guard:observe,maxSteps:maxStepsPerStage,clock:workClock});
  const closeout=(options={})=>runCloseoutTurn({project,org,env:childEnv,cli,guard:observe,maxSteps:maxStepsPerStage,budgetMs:CLOSEOUT_TURN_BUDGET_MS,clock:workClock,...options,
    ...(closeoutMeasure?{measure:closeoutMeasure}:{})});
  const acquirePass=(options={})=>noticeLock(path.join(directory,'pass.lock'),{...options,onRecovery:recovery=>{
    observe();
    log({action:'general-pass-lock-recovery',schema:'line-pass-lock-recovery/v1',project:project.identity,org,...recovery});
  }});
  function pass(options) {
    // pass.lock serializes scans, but is deliberately yielded for foreground
    // effects. Keep at most two whole passes (one slow owner plus independent
    // admission) instead of retaining a full record for every scheduled wake.
    let releaseGeneral;
    for(let slot=0;slot<2&&!releaseGeneral;slot++)try{
      releaseGeneral=noticeLock(path.join(directory,`general-${slot}.lock`),{onRecovery:recovery=>{
        observe();log({action:'general-owner-recovery',...recovery});
      }});
    }catch(error){if(!error.message.startsWith('locked:'))throw error;}
    try{
      let alarm;
      try{alarm=observeGeneralOwners({directory,identity:project.identity,org,blocked:!releaseGeneral,at:now()});}
      catch(error){log({action:'general-owner-alarm-held',reason:error.message});}
      if(!releaseGeneral){log({action:'general-owner-held',reason:'two finite general passes already own the scheduling allowance',owners:alarm?.owners});return{already_running:true};}
      return generalPass(options);
    }finally{releaseGeneral?.();}
  }
  function generalPass({reconcileCloseout=true}={}) {
    const closeoutStarted=workClock();
    let closeout_ms;
    try { if(reconcileCloseout)closeoutOrHold(closeout, log); }
    finally {
      closeout_ms=Math.max(0,workClock()-closeoutStarted);
      log({action:'closeout-timing',duration_ms:closeout_ms,budget_ms:CLOSEOUT_TURN_BUDGET_MS});
    }
    let release = acquirePass(),lockedAt=performance.now();
    let effects,checkpointNotices;
    const passAt=now(),heartbeat=phase=>writeFileAtomic(path.join(directory,'heartbeat.json'),JSON.stringify({at:now(),started_at:passAt,project:project.identity,source:sourceRoot,phase,pid:process.pid})+'\n',0o600);
    heartbeat('starting');
    try {
      const passStarted = performance.now();
      let workStarted=workClock();const maintenanceStarted=workStarted,expired=()=>workClock()-workStarted>=passBudgetMs;
      timings = { closeout_ms,snapshots: 0, record_snapshot_ms: 0, effect_command_ms: 0, historical_intake_skipped: 0, historical_review_skipped: 0, closeout_retained: 0,outcome_decisions_deferred:0,effects_journal_writes:0,notice_record_attempts:0,
        pass_lock_ms:0,pass_lock_max_segment_ms:0,suspended_ms:0 };
      effects = readServiceJournal(journal) ?? { identity: project.identity, org, actions: {}, notices: {} };
      if (effects.identity !== project.identity || effects.org !== org) throw Error('effect journal project binding changed');
      const audit=path.join(directory,'passes.jsonl'),restored=replayNoticeAudit(audit,effects);let noticesDirty=false;
      timings.notice_audit_replayed=restored.length;
      // Older unbound rows remain visible and unchanged; they grant no effect.
      timings.review_error_unbound=0;
      for(const [key,e]of Object.entries(effects.record_notices??{}))if(e.review){try{noticeBoundary(key,e);}catch{timings.review_error_unbound++;}}
      const save = () => {if(!release)throw Error('journal mutation requires the scheduling lock');effects.notice_audit_offset=passJournalSize(audit);writeFileAtomic(journal, JSON.stringify(effects, null, 2) + '\n', 0o600);timings.effects_journal_writes++;noticesDirty=false;};
      checkpointNotices=()=>{if(noticesDirty)save();};
      if(effects.pass_number!==undefined&&(!Number.isSafeInteger(effects.pass_number)||effects.pass_number<0))throw Error('service pass counter is inconsistent');
      effects.pass_number=(effects.pass_number??0)+1;save();
      let snapshot, stale = true, reviewCache = new Map();
      const current = () => { if (stale) { snapshot = observe(); stale = false; reviewCache = new Map(); } return snapshot; };
      let activeSubject,activeKey,parentCommand;
      const subjectLock=subject=>path.join(directory,'subjects',digest(subject)+'.lock');
      const withSubject=(key,operation)=>{
        const subject=effectSubject(key,current().state);
        if(activeSubject===subject)return operation();
        const pending=pendingSubjectCommand(directory,subject);
        if(pending){log({action:'subject-held',subject,key,original:pending.command,reason:'original command remains active or UNKNOWN',owner:pending.intent.stuck_owner});return;}
        const unknown=Object.entries(effects.actions).find(([other,entry])=>other!==key&&entry.state==='started'&&
          (entry.execution_subject??effectSubject(other,current().state))===subject);
        if(unknown){log({action:'subject-held',subject,key,original:unknown[0],reason:'original started action retained; no replacement'});return;}
        let unlock;try{unlock=noticeLock(subjectLock(subject),{onRecovery:recovery=>log({action:'subject-lock-recovery',subject,...recovery})});}
        catch(error){if(!error.message.startsWith('locked:'))throw error;log({action:'subject-held',subject,key,reason:error.message});return;}
        const previous={activeSubject,activeKey,subject:childEnv.HERDR_LINE_SUBJECT,token:childEnv.HERDR_LINE_SUBJECT_TOKEN};
        activeSubject=subject;activeKey=key;childEnv.HERDR_LINE_SUBJECT=subject;
        childEnv.HERDR_LINE_SUBJECT_TOKEN=JSON.parse(fs.readFileSync(path.join(subjectLock(subject),'owner.json'),'utf8')).token;
        try{return operation();}finally{activeSubject=previous.activeSubject;activeKey=previous.activeKey;
          if(previous.subject===undefined)delete childEnv.HERDR_LINE_SUBJECT;else childEnv.HERDR_LINE_SUBJECT=previous.subject;
          if(previous.token===undefined)delete childEnv.HERDR_LINE_SUBJECT_TOKEN;else childEnv.HERDR_LINE_SUBJECT_TOKEN=previous.token;unlock();}
      };
      const binding=()=>({project:project.identity,org,subject:activeSubject??null,key:activeKey??null,
        ...(activeKey&&effects.actions[activeKey]?.admission?{admission:effects.actions[activeKey].admission}:{}),
        consumer:'line-service',wake_fact:'terminal command receipt on the next line wake',stuck_owner:to,...(parentCommand?{parent:parentCommand.receipt}:{})});
      const unlockSchedule=()=>{
        const duration_ms=performance.now()-lockedAt;timings.pass_lock_ms+=duration_ms;
        timings.pass_lock_max_segment_ms=Math.max(timings.pass_lock_max_segment_ms,duration_ms);
        log({action:'schedule-unlocked',pass:passAt,pid:process.pid,duration_ms});
        const unlock=release;release=null;unlock();
      };
      const yieldWork=(exe,args,operation)=>{
        const ref=commandIntent(directory,{exe,args,cwd:repo,...binding()});
        if(activeKey&&effects.actions[activeKey]){effects.actions[activeKey].commands??=[];effects.actions[activeKey].commands.push(ref);}
        checkpointNotices();save();heartbeat('executing');
        const pausedAt=performance.now(),pausedWork=workClock(),previous=parentCommand;parentCommand=ref;
        unlockSchedule();
        try{return operation(ref);}
        finally{
          // This is allocation waiting, never a timeout or permission to stop A.
          // No journal write is allowed until the current writer hands it back.
          while(!release)try{release=acquirePass({waitMs:1000});}
          catch(error){if(!error.message.startsWith('locked:'))throw error;}
          lockedAt=performance.now();
          const latest=readServiceJournal(journal);
          if(!latest||latest.identity!==project.identity||latest.org!==org)throw Error('journal binding changed while scheduling was yielded');
          refreshJournal(effects,latest);stale=true;noticesDirty=false;parentCommand=previous;
          timings.suspended_ms+=performance.now()-pausedAt;workStarted+=workClock()-pausedWork;
          // A helper publishes its result before replying. Missing completion
          // remains UNKNOWN and fences maintenance, without blocking other work.
          try{forgetActiveCommand(ref);}catch(error){log({action:'command-outcome-retained',command:ref,reason:error.message,owner:to});}
          heartbeat('scheduling');
        }
      };
      commandTurn=(exe,args,options)=>{
        const execute=ref=>{const result=command(exe,args,{...options,commandReceipt:ref});finishCommand(ref,result);return result;};
        if(release)return yieldWork(exe,args,execute);
        // A direct guarded operation can make several finite commands while
        // outside scheduling. Its still-pending parent fences maintenance.
        const ref=commandIntent(directory,{exe,args,cwd:repo,...binding()});
        try{return execute(ref);}finally{try{forgetActiveCommand(ref);}catch{/* original intent remains */}}
      };
      const outside=(name,key,operation)=>withSubject(key,()=>yieldWork('line-operation',[name,key],ref=>{
        try{const result=operation();finishCommand(ref,{status:0,stdout:JSON.stringify(result??null)});return result;}
        catch(error){finishCommand(ref,{status:1,stderr:error.message,error});throw error;}
      }));
      const note = (boundary, reason, scope = {}, force = false, row = {}) => {
        scope=Object.fromEntries(Object.entries(scope).filter(([,value])=>value!==undefined));
        const scoped=scope.item??/^dispatch:([A-Z]+-\d+)/.exec(boundary)?.[1],review=scope.review===true||/^review|DISPATCH_REVIEW/i.test(boundary)||roleIs(snapshot?.state.items.get(scoped),'REV');
        const normalized=canonicalFailure(reason),key=createHash('sha256').update(canonical([boundary,normalized,scope])).digest('hex');
        effects.record_notices??={};
        const prior=effects.record_notices[key],entry=effects.record_notices[key]=prior??{first_at:now(),reason:normalized,scope,boundary,state:'diagnostic-only',id:`line-record-${key}`,count:0};
        noticeBoundary(key,entry,boundary);
        entry.count++;entry.last_at=now();if(review)entry.review=true;noticesDirty=true;
        const alert=!entry.inspection_due&&(force||review||entry.count>=alertAfter);if(alert)entry.inspection_due=true;
        // One cumulative diagnostic per key. A lost checkpoint replays the
        // fsynced delta, never native intents or a SENT/consumed assertion.
        log({action:'hold',...row,boundary,reason,canonical_key:key,scope,...(alert?{inspection_due:true}:{}),notice_record:{key,entry}});
      };
      const effectBody = (key, run, binding, operation, safe=false, outcomeReadback=false, before,admission) => {
        const retain=prior=>{
          log({ action: 'effect-retained', key, state: prior.state });
          if (prior.state !== 'complete') note(key, prior.error ?? 'prior failed/uncertain effect retained; inspect its existing receipt, do not replay');
          return prior;
        };
        const pendingHandoff = result => key.startsWith('closeout:') && Array.isArray(result?.evaluated) && result.evaluated.length===0 &&
          Array.isArray(result.restart?.keys) && result.restart.keys.length>0 && result.successor?.pending===true &&
          result.successor.reason==='fresh drain required' && JSON.stringify(result.successor.keys)===JSON.stringify(result.restart.keys);
        if (effects.actions[key]) {
          const prior = effects.actions[key];
          const failure=prior.failure??outcomeFailure(prior);
          if(!safe||prior.state==='complete'&&!pendingHandoff(prior.result)||failure.kind==='fence'||prior.state!=='complete'&&!outcomeReadback){
            return retain(prior);
          }
        }
        if(expired())return;
        checkpointNotices();
        const fresh=observe();
        stale = true;
        // Admission can defer a stale selection before recording any intent.
        // Existing failed/uncertain effects above keep their normal authority.
        if(before&&!before(fresh))return;
        const prior=effects.actions[key],history=prior?[...(prior.history??[]),Object.fromEntries(Object.entries(prior).filter(([k])=>k!=='history'))]:[];
        const continuation=prior&&typeof outcomeReadback==='function'?outcomeReadback(fresh):null;
        if(prior&&typeof outcomeReadback==='function'&&!continuation)return retain(prior);
        const entry = effects.actions[key] = { state: 'started',owner:'line-service',subject:key,execution_subject:activeSubject,attempt:randomUUID(),
          consumer:'line-service',wake_fact:'original command completion or next line wake',stuck_owner:to,at: now(),...(admission?{admission}:{}),...(history.length?{history}:{}),...(continuation?{queue_recovery:continuation}:{}), ...(binding ? { review_target: binding, review_operation: operation } : {}) }; save();
        log({action:'effect-intent',key,subject:activeSubject,attempt:entry.attempt});
        if(continuation)log({action:'review-queue-no-mutation',key,proof:continuation});
        try {
          entry.result = run(fresh); entry.state = 'complete';
          if (['escalate', 'failed', 'stopped', 'judge_promotion'].includes(entry.result?.result)) {
            entry.state = 'held'; entry.error = entry.result.reason ?? entry.result.result;
          }
          if(entry.result?.already_running){entry.state='held';entry.error='ordinary closeout consumer contention; unchanged request retained';}
          if(pendingHandoff(entry.result)){entry.state='held';entry.error='closer implementation changed before effect; original requests need a fresh drain';}
          const deferred = entry.result?.evaluated?.filter(row => !row.completed&&!row.sessions_retired);
          if (deferred?.length) { entry.state = 'held'; entry.error = deferred.map(row => `${row.run}: ${row.reason}`).join('; '); }
        }
        catch (e) { entry.state = 'held'; entry.error = e.message; entry.receipt = e.receipt;entry.failure=outcomeFailure(e); }
        entry.finished_at = now(); save(); log({ action: 'effect', key, ...entry });
        if (entry.state === 'held') note(key, entry.error);
        return entry;
      };
      const effect=(...args)=>withSubject(args[0],()=>effectBody(...args));
      const sourceRevision=bundleRelease().commit??sourceGit(sourceRoot,['rev-parse','HEAD']);
      log({ action: 'pass-start', pid: process.pid, identity: project.identity, source: sourceRoot,source_head:sourceRevision });
      try { snapshot = current(); } catch (e) { log({ action: 'pass-held', reason: e.message }); return { held: e.message, directory }; }
      const admissionPolicy=readReviewAdmission(repo,childEnv);
      const ordinaryPolicy=readOrdinaryAdmission(repo,childEnv);
      const {config}=loadDiscoveredRoutes({cwd:repo,env:childEnv});
      const evaluationCounts={admission_evaluated:0,admission_skipped:0,source_evaluated:0,source_skipped:0};
      const evaluationCache=negativeEvaluationCache({store:()=>effects,identity:project.identity,org,repo,revision:sourceRevision,
        counts:evaluationCounts,dirty:()=>{noticesDirty=true;}});
      const evaluationPolicy={admissionPolicy,ordinaryPolicy,config,supervisor:childEnv.MONITOR_SUPERVISOR_AGENT??null};
      effects.review_admission={schema:'review-admission-pass/v1',policy:admissionPolicy,held:[]};
      effects.ordinary_admission={schema:'ordinary-admission-pass/v1',policy:ordinaryPolicy,held:[]};save();
      const ordinaryHold=(item,state,stage,policy=ordinaryPolicy)=>{
        const hold=ordinaryAdmissionHold(policy,{item,state});
        if(hold){const row={stage,item:item.id,...hold};effects.ordinary_admission.held.push(row);noticesDirty=true;log({action:'ordinary-admission-held',...row});}
        return hold;
      };
      // Retain every excluded open ordinary row, even beyond the start/cap limit.
      for(const item of snapshot.state.items.values())if(ordinaryPolicy.selected_only&&!item.closed&&item.kind!=='goal'){
        const selection=evaluationCache.probe('selection',{snapshot,item:item.id,policy:evaluationPolicy});
        if(selection.skip){effects.ordinary_admission.held.push({stage:'selection',item:item.id,...selection.reason,cached:true});noticesDirty=true;continue;}
        const held=ordinaryHold(item,snapshot.state,'selection');if(held)selection.retain(held);
      }
      const admit=(subject,stage,fresh=false)=>{
        const hold=reviewAdmissionHold(fresh?readReviewAdmission(repo,childEnv):admissionPolicy,reviewAdmissionSubject(subject));
        if(!hold)return reviewAdmissionSubject(subject).kind!=='ordinary'||!ordinaryHold(subject.item,subject.state??snapshot.state,stage,fresh?readOrdinaryAdmission(repo,childEnv):ordinaryPolicy);
        const row={stage,item:subject.item?.id,run:subject.run?.id,head:subject.target?.head??subject.item?.meta.review_target?.head,...reviewAdmissionSubject(subject),...hold};
        effects.review_admission.held.push(row);noticesDirty=true;log({action:'review-admission-held',...row});return false;
      };
      snapshot=current();
      // Saved timely proposals are idempotent record facts, independent of
      // prompt/review recovery and the phase-zero cutoff. Refusals stay final.
      const bindings=[];
      for(const run of snapshot.state.runs.values())try{
        if(pendingSessionBinding(run,org,project.identity))bindings.push(run);
      }catch(e){note(`session-binding:${run.id}`,e.message,{item:run.item,run:run.id});}
      const offset=bindings.length?effects.pass_number%bindings.length:0;
      for(let n=0;n<Math.min(bindings.length,maxStepsPerStage)&&!expired();n++){
        const run=bindings[(offset+n)%bindings.length];
        try{
          checkpointNotices();
          const result=outside('session-binding',`session-binding:${run.id}`,()=>replaySessionBinding({journal:run.meta.dispatch_journal,org,project:project.identity,guard:observe,
            record:journal=>cli('bin/org.mjs',['session-bind','--journal',journal])}));
          stale=true;log({action:'session-binding-replay',run:run.id,result});
          if(result?.outcome==='refused')note(`session-binding:${run.id}`,result.error.message,{item:run.item,run:run.id});
        }catch(e){note(`session-binding:${run.id}`,e.message,{item:run.item,run:run.id});}
      }
      snapshot=current();
      let cutoff;try{cutoff=phase0Boundary(snapshot.events,{repo,org,identity:project.identity});}catch{
        try{checkpointNotices();ensureReviewBoundary({repo,org,env:childEnv});stale=true;snapshot=current();cutoff=phase0Boundary(snapshot.events,{repo,org,identity:project.identity});}catch(e){note('review-cutoff',e.message);}
      }
      const recordedReviews=new Set(snapshot.events.filter(e=>e.type==='change.reviewed').map(e=>e.review_run));let resultSteps=0;
      for(const run of snapshot.state.runs.values()){
        if(expired()||resultSteps>=maxStepsPerStage)break;
        const review=snapshot.state.items.get(run.item);
        if(run.report&&isQueueReview(review)&&!recordedReviews.has(run.id)){
          resultSteps++;
          effect(`review-result:${run.id}:${run.report.sha256}`,()=>outside('review-result',`review-result:${run.id}:${run.report.sha256}`,()=>recordReviewResults({repo,org,runId:run.id,env:childEnv})),undefined,undefined,true);
        }
      }
      snapshot=current();
      try{
        const observed=observeReviewProgress({state:snapshot.state,org,identity:project.identity,pass:effects.pass_number,previous:effects.review_progress});effects.review_progress=observed.progress;save();let recoveries=0;
        for(const id of observed.candidates){
          if(expired()||recoveries>=maxStepsPerStage)break;const q=snapshot.state.items.get(id),target=q.meta.review_target;
          if(!admit({item:q},'recovery',true))continue;
          const held=effects.review_recovery_holds?.[id],capability='original-scope-continuation/v2',productHold=held&&/partial\/ambiguous producer|historical\/partial target/.test(held.reason);
          if(held?.signature===observed.progress[id].signature&&!(productHold&&held.capability!==capability))continue;
          try{checkpointNotices();const result=outside('review-recovery',`review-progress:${id}`,()=>recoverServiceReview({repo,org,reviewId:id,env:childEnv,call:(_exe,args)=>JSON.stringify({result:native(args)})}));if(!result)continue;log({action:'review-progress-resolution',item:id,...result});if(['review_queued','original_prestart_ready','original_review_ready'].includes(result.result))stale=true;
            if(result.result==='original_review_ready')effect(`review-original:${id}:${result.proof}`,()=>JSON.parse(cli('dispatch/dispatch.mjs',['--retry',result.journal,'--repo',repo,'--org',org,'--continue-review'])),undefined,undefined,false,false,()=>admit({item:q},'recovery-launch',true));
          }
          catch(e){effects.review_recovery_holds??={};if(/EPERM|EACCES|native refusal|identity|reserved|HOLD|STOP|UNKNOWN|partial|ambiguous/i.test(e.message))effects.review_recovery_holds[id]={signature:observed.progress[id].signature,reason:e.message,capability};save();note(`review-progress:${id}`,e.message,{item:id,review:true});}
          recoveries++;
        }
      }catch(e){note('review-progress',e.message);}
      snapshot=current();
      let discovered,index;try{index=canonicalReviewIndex({events:snapshot.events,state:snapshot.state,repo,org,identity:project.identity,boundary:cutoff});discovered=discoverChanges({events:snapshot.events,state:snapshot.state,repo,org,identity:project.identity,pendingOnly:true,index,heldCache:(item,run)=>evaluationCache.probe('source',{snapshot,item:item.id,run:run.id,policy:evaluationPolicy,extra:{tip:index.tip,boundary:cutoff}})});}catch(e){discovered={changes:[],holds:[{reason:e.message}]};}
      for(const held of discovered.holds)note(`review-source:${held.run??'boundary'}:${held.head??''}`,held.reason,{item:held.item,run:held.run,head:held.head,review:true});
      let reviewSteps=0;
      for(const {item,run,target}of discovered.changes){
        if(expired()||reviewSteps>=maxStepsPerStage)break;
        if(!admit({item,run,target},'queue'))continue;
        const key=`review:${item.id}:${target.head}`;let reviewLock;
        try{
          reviewLock=noticeLock(path.join(directory,`review-change-${digest([item.id,target.head])}.lock`),{recover:false});
          const ignoreService={file:journal,key,target,operation:'record-queue'};
          const retained=effects.review_reference_observed?.[key],resolutionSeq=referenceRevision({events:snapshot.events,identity:project.identity,org,item:item.id,run:run.id,target});
          if(retained&&resolutionSeq<=(effects.review_reference_reconsidered?.[key]?.resolution_seq??0))continue;
          const attempt=reviewAttempt(item,{org,identity:project.identity,events:snapshot.events,state:snapshot.state,repo,effects,cache:reviewCache,target,capturedRun:run.id,ignoreService});
          if(attempt){
            if(retained){effects.review_reference_reconsidered??={};effects.review_reference_reconsidered[key]={resolution_seq:resolutionSeq,target,attempt};}
            else{effects.review_reference_observed??={};effects.review_reference_observed[key]={owner:'line-service',target,attempt};}save();
            if(attempt.includes('UNKNOWN'))note(`outcome:${key}`,'Original review completion producer is missing; retain its attempt for the project supervisor.',{item:item.id,run:run.id,head:target.head,attempt});
            note(key,attempt,{item:item.id,run:run.id,head:target.head,review:true},false,{action:'review-retained',item:item.id,head:target.head});continue;
          }
          queueConsumer({run,env:childEnv});reviewSteps++;
          effect(key,()=>{
            // Selection scanned all producers. This fresh exact-target fence
            // keeps global attribution/peers without rebuilding their ranges.
            const fresh=observe(),checked=discoverChanges({events:fresh.events,state:fresh.state,repo,org,identity:project.identity,runId:run.id}).changes.find(c=>c.item.id===item.id&&c.target.head===target.head);
            if(!checked||JSON.stringify(checked.target)!==JSON.stringify(target))throw Error('immutable landed target/evidence changed before queue mutation');
            queueConsumer({run:checked.run,env:childEnv});
            return JSON.parse(cli('bin/org.mjs',['queue-review',run.id,'--head',target.head,'--base',target.base]));
          },target,'record-queue',true,fresh=>{
            const proof=reviewQueueNoMutation({entry:effects.actions[key],key,...fresh,repo,org,identity:project.identity,item,run,target});
            if(!proof)return null;
            // A fresh inventory check under the existing pass/change locks
            // precedes the durable continuation intent; ordinary queue-review
            // still owns its record CAS, source/native/STOP guards and cap1.
            return reviewAttempt(item,{...fresh,repo,org,identity:project.identity,effects,target,capturedRun:run.id,ignoreService})?null:proof;
          },()=>admit({item,run,target},'queue-mutation',true));
        }catch(e){note(key,e.message,{item:item.id,run:run.id,head:target.head});}
        finally{reviewLock?.();}
      }
      for(const {selector,target}of discovered.unattributed??[]){
        if(expired()||reviewSteps>=maxStepsPerStage)break;
        if(!admit({selector,target},'queue'))continue;
        const key=`review:${selector}`;let reviewLock;
        try{
          reviewLock=noticeLock(path.join(directory,`review-change-${digest(selector)}.lock`),{recover:false});reviewSteps++;
          effect(key,()=>{
            const fresh=observe(),checked=discoverChanges({events:fresh.events,state:fresh.state,repo,org,identity:project.identity}).unattributed?.find(c=>c.selector===selector);
            if(!checked||JSON.stringify(checked.target)!==JSON.stringify(target))throw Error('immutable canonical target/evidence changed before queue mutation');
            return JSON.parse(cli('bin/org.mjs',['queue-review',selector,'--head',target.head,'--base',target.base]));
          },target,'record-queue',true,false,()=>admit({selector,target},'queue-mutation',true));
        }catch(e){note(key,e.message,{head:target.head,review:true});}
        finally{reviewLock?.();}
      }
      if(index)try{
        checkpointNotices();
        const errors=Object.values(effects.record_notices??{}).filter(e=>e.review),health=outside('review-health','review-health',()=>observeReviewHealth({repo,org,index,passId:`${directory}:${effects.pass_number}`,errorCounts:{unique:errors.length,occurrences:errors.reduce((n,e)=>n+e.count,0)},prior:effects.review_health,env:childEnv}));
        if(!health)throw Error('review health observation already owned');
        log({action:'review-health',health});effects.review_health=health;noticesDirty=true;
        for(const gap of health.attribution_gaps)note(`review-attribution:${gap.head}`,gap.reason,{item:gap.item,run:gap.run,head:gap.head,review:true});
        const attribution=new Set(health.attribution_gaps.map(g=>g.head));
        for(const gap of health.coverage_gaps)if(!attribution.has(gap.head)&&gap.retained)note(`review-coverage:${gap.head}`,'Retained producer review scopes do not cover this landed source; preserve immutable attempts and verdicts, judgment is needed.',{item:gap.item,run:gap.run,head:gap.head,review:true});
        for(const held of health.retained_issues)note(`review-cardinality:${held.group}`,held.reason,{item:held.item,run:held.run,review:true});
        if(health.gap_passes>3)note('review-gap','More than three real passes have canonical source without complete queued or reviewed coverage; inspect the review health digest.',{review:true,boundary:index.boundary.id},true);
      }catch(e){note('review-health',e.message);}
      // Source completion releases the real admission slot independently of
      // review verdicts and physical cleanup. The record owns the conditional
      // current-run/report/blocker/reopen transaction; there is no override.
      snapshot = current();
      for(const item of snapshot.state.items.values())if(isQueueReview(item)&&!item.closed){
        const run=snapshot.state.runs.get(item.runs.at(-1));if(!run?.report||run.report.outcome!=='done')continue;
        const originals=completionAttempts(effects,run.id);
        try{
          if(originals.length){
            if(originals.length!==1)throw Error('original completion attempts ambiguous; no replacement');
            const [key,entry]=originals[0];
            if(entry.state==='complete')throw Error('original completed outcome lacks review closure; retain original');
            // Reject ineligible originals read-only, before a command intent,
            // scheduling yield or shared landing lock. The writer still proves
            // everything afresh under its existing mutation guards.
            completionPlanningProof({...snapshot,repo,org,identity:project.identity,runId:run.id,key,entry});
            // Use a separate bookkeeping command, never append another command
            // to the original entry or mint a replacement effect/attempt.
            withSubject(`review-completion-reconcile:${run.id}`,()=>outside('review-completion-reconcile',`review-completion-reconcile:${run.id}`,
              ()=>reconcileReviewCompletion({repo,org,runId:run.id,key,env:childEnv})));
            continue;
          }
          const plan=reviewCompletionPlan({events:snapshot.events,state:snapshot.state,runId:run.id});effect(`review-complete:${run.id}:${plan.token}`,()=>outside('review-complete',`review-complete:${run.id}:${plan.token}`,()=>recordReviewCompletion({repo,org,runId:run.id,env:childEnv})),undefined,undefined,true);
        }
        catch(e){
          const signature=digest({originals,reason:e.message});
          effects.review_completion_holds??={};
          if(effects.review_completion_holds[run.id]===signature)continue;
          effects.review_completion_holds[run.id]=signature;noticesDirty=true;
          log({action:'review-completion-held',schema:'review-completion-held/v1',item:item.id,run:run.id,originals:originals.map(([key,entry])=>({key,attempt:entry.attempt})),owner:'project-supervisor',reason:e.message,original_command_replayed:false});
          note(`review-complete:${run.id}`,e.message,{item:item.id,run:run.id});
        }
      }
      snapshot=current();
      let closeSteps=0;
      for (const item of [...snapshot.state.items.values()].sort((a,b)=>(snapshot.state.runs.get(b.runs.at(-1))?.report?.seq??0)-(snapshot.state.runs.get(a.runs.at(-1))?.report?.seq??0))) {
        if(expired()||closeSteps>=maxStepsPerStage)break;
        const run=snapshot.state.runs.get(item.runs.at(-1));
        if(item.closed||isQueueReview(item)||isDecision(item)||run?.report?.outcome!=='done'||run.abandoned||!run.workspace||
            !run.owner||run.owner.legacy||run.owner.controller!=='brain')continue;
        const key=`source-complete:${run.id}:${run.report.sha256}`,prior=effects.actions[key];
        const receipt=(type,details)=>{
          const binding={project:project.identity,org,item:item.id,run:run.id,report_sha256:run.report.sha256,claim_generation:run.owner_generation,...details};
          const signature=digest(binding);
          transact(org,events=>({add:events.some(e=>e.type===type&&e.signature===signature)?[]:[{type,signature,...binding}]}),{actor:'line-service',strictTail:true});
          stale=true;
        };
        try {
          closeSteps++;
          if(reserved(item)||item.meta.hold||item.meta.held||run.report.blockers?.length||(run.report.questions??run.report.extra?.questions)?.length){
            receipt('line-service.source-completion-held',{reason:'held/reserved item or report blockers/questions',command_started:false});continue;
          }
          const proofFor=bound=>sourceCompletionProof({project,org,run:bound.run,events:bound.events,state:bound.state,git:sourceGit,identify});
          const present=Boolean(fs.lstatSync(run.workspace,{throwIfNoEntry:false}));
          const bound=guardRun(run.id,{workspace:present});
          let proof;
          try{proof=proofFor(bound);}catch(error){
            receipt('line-service.source-completion-held',{reason:error.message,...(error.source_provenance?{source_provenance:error.source_provenance}:{}),command_started:false});
            if(error.source_provenance?.status==='external'){
              try{const exception=queueSourceException({repo,org,run:bound.run,proof:error.source_provenance,env:childEnv,git:sourceGit});
                receipt('line-service.source-exception',{exception,command_started:false});}
              catch(failure){note(`source-exception:${run.id}`,failure.message,{item:item.id,run:run.id});}
            }
            continue;
          }
          const legacy=preEffectSourceHold(prior);
          const landed=bound.events.findLast(e=>e.type==='change.landed'&&e.project===project.identity&&e.run===run.id&&e.item===item.id&&e.landed_at&&e.producer?.ownership_generation===run.owner_generation);
          if(prior?.state==='held'&&!legacy&&(!landed||prior.source_producer_seq===landed.seq)){
            effects.outcome_decisions??={};
            effects.outcome_decisions[key]??=queueOutcomeDecision({repo,org,env:childEnv,check:{key,subject:{item:item.id,run:run.id,report:run.report.sha256},defect:'Retained source completion has no linked actual landing producer; no timer, recheck or replay.'}});save();continue;
          }
          const held=bound.events.findLast(e=>e.type==='line-service.source-completion-held'&&e.run===run.id&&e.report_sha256===run.report.sha256);
          const completionKey=legacy?`source-complete-readmitted:${digest([key,prior])}`:key;
          if((legacy||held)&&!effects.actions[completionKey])receipt('line-service.source-completion-readmitted',{
            original_key:key,recovery_key:completionKey,held_seq:held?.seq??null,original_sha256:legacy?digest(prior):null,proof,command_started:false});
          const completed=effect(completionKey,()=>{
            const bound=guardRun(run.id,{workspace:proof.allocation==='present'}),ownership=requireController(readOwnedRun(org,run.id),'brain');
            if(bound.item.closed)return{retained:'already source-complete'};
            if(bound.run.report.sha256!==run.report.sha256||bound.run.report.outcome!=='done'||reserved(bound.item)||bound.item.meta.hold||bound.item.meta.held||
                bound.run.report.blockers?.length||(bound.run.report.questions??bound.run.report.extra?.questions)?.length)throw Error('T2 source completion needs supervisor judgment: current item/report scope changed');
            if(JSON.stringify(proofFor(bound))!==JSON.stringify(proof))throw Error('T2 source completion needs supervisor judgment: source boundary changed before conditional close');
            assertOwner(readOwnedRun(org,run.id),ownership);
            const args=['close',item.id,'--if-current-run',run.id,'--note',
              `Routine conditional source completion of current done report ${run.id} (${run.report.sha256}); immutable source ${proof.source_head} integrated at ${proof.integrated_tip}; allocation ${proof.allocation}. Preserve independent review/verdict holds, callbacks, HOLD, archives and final-release/Major-correction obligations; physical cleanup is separate.`];
            return{...proof,report_sha256:run.report.sha256,ownership,command:[process.execPath,path.join(sourceRoot,'bin/org.mjs'),...args],close:cli('bin/org.mjs',args,{receipt:true})};
          },undefined,undefined,!legacy,Boolean(landed));
          if(completed&&landed){completed.source_producer_seq=landed.seq;save();}
        }catch(error){note(`source-complete:${run.id}`,`T2 source completion needs supervisor judgment: ${error.message}`);}
      }
      // Consume original typed answers, but do not manufacture fresh judgment
      // sessions from blocked work. The owning supervisor answers actual questions.
      snapshot=current();
      if(decisionActivation(snapshot.events,project.identity,org)){
        let decisionSteps=0;
        for(const item of snapshot.state.items.values())if(isDecision(item)&&!item.closed){
          if(expired()||decisionSteps>=maxStepsPerStage)break;
          const run=snapshot.state.runs.get(item.runs.at(-1));if(!run?.report)continue;
          decisionSteps++;
          effect(`decision-apply:${item.id}:${run.id}:${run.report.sha256}`,()=>outside('decision-apply',`decision-apply:${item.id}:${run.id}:${run.report.sha256}`,()=>applyDecision({repo,org,itemId:item.id,env:childEnv,native})));
        }
        try{checkpointNotices();outside('decision-consequence','decision-consequence',()=>observeDecisionConsequences({repo,org,env:childEnv,native}));stale=true;}catch(e){note('decision-consequence',e.message);}
      }
      // Only a real post-cutover
      // pending reserved question with an explicitly named decider may wake.
      snapshot=current();
      if(cutoff)for(const item of snapshot.state.items.values()){
        if(item.role!=='human'||item.closed||item.meta.answer||item.meta.operator_reserved!==true||item.meta.decider!=='brain-chat'||item.created.seq<=cutoff.seq)continue;
        effects.decisions??={};effects.decider_next??={};
        if(effects.decisions[item.id])continue;
        const time=Date.parse(now());if(time<(effects.decider_next[item.meta.decider]??0))continue;
        effects.decisions[item.id]={state:'intent',at:now(),decider:item.meta.decider};effects.decider_next[item.meta.decider]=time+60000;save();
        try{
          timings.notice_record_attempts++;
          const message=recordNotice({repo,org,id:`line-decision-${digest([project.identity,item.id])}`,boundary:`decision:${item.id}`,reason:'actual pending explicitly named reserved decision',scope:{item:item.id},first_at:effects.decisions[item.id].at,audit:path.join(directory,'passes.jsonl'),counts:`${journal}#decisions/${item.id}`,env:childEnv,kind:'question',question:item.id});
          const result=wakeDecision({envelope:message.envelope,binding:message.binding,state:snapshot.state,fresh:observe});
          effects.decisions[item.id]={...effects.decisions[item.id],state:'queued-or-retained',result};
        }catch(e){effects.decisions[item.id]={...effects.decisions[item.id],state:'held',error:e.message};note(`decision:${item.id}`,e.message,{item:item.id});}
        save();
      }
      // Failed cleanup/review never prevents considering independent ready work.
      snapshot = current();
      for(const [key,entry]of Object.entries(effects.actions))if(key.startsWith('dispatch:')&&(entry.state!=='complete'||entry.result?.result==='detached'&&entry.original_outcome?.status!=='dispatch-complete')){
        if(entry.state==='started')continue; // The original command, live or UNKNOWN, owns its outcome.
        const item=key.split(':')[1];
        try{
          let status=entry.recorded_dispatch_status;
          const outcome=entry.original_outcome??originalDispatchOutcome({repo,org,common:project.identity,item,brief:path.join(directory,`${digest(key)}.ask.md`),journal:entry.result?.journal,events:snapshot.events});
          if(!entry.original_outcome){entry.original_outcome=outcome;save();log({action:'dispatch-outcome-readback',key,...outcome});}
          status??=snapshot.events.findLast(e=>e.type==='dispatch.completed'&&e.project===project.identity&&e.journal===outcome.journal&&e.attempt===outcome.producer?.attempt&&e.item===item&&e.run===outcome.run);
          if(status&&!entry.recorded_dispatch_status){entry.recorded_dispatch_status=status;save();log({action:'dispatch-linked-status',key,status});}
          if(status&&outcomeFailure(status).kind==='fence'){
            // The detached parent acknowledged only the original start. Its
            // child's exact terminal refusal stops that effect, without
            // changing the saved acknowledgement or issuing another dispatch.
            entry.failure=status.failure;entry.state='held';entry.error=`Original dispatch stopped: ${status.failure.code}`;save();
            effects.outcome_decisions??={};
            effects.outcome_decisions[key]??=queueOutcomeDecision({repo,org,env:childEnv,check:{key,
              subject:{item,run:status.run,journal:status.journal,attempt:status.attempt},failure:status.failure,status,outcome}});
            save();stale=true;
          }
          else if(!outcome.producer&&!['not-started','dispatch-complete'].includes(outcome.status)){
            note(`outcome:${key}`,'Original dispatch completion producer is missing; retain its original attempt for the project supervisor.',{item,journal:outcome.journal??null,outcome});
          }
        }catch(e){note(key,e.message,{item});}
      }
      const standing=queuePolicy(snapshot.state);
      // Productive cleanup is allowed to finish. It cannot consume READY work's
      // independent admission allowance. All actual effects still recount and
      // re-read native/record/source/STOP/HOLD; no worker is stopped by a clock.
      const precedingWork=workClock()-maintenanceStarted;workStarted=workClock();
      let starts=0,admissionLogged=false,latestOccupancy;
      const countCapacity = kind => (capacity??(()=>checkSessionCap({config,org,kind,common:project.identity,
        agent:name=>native(['agent','get',name]).agent,processInfo:pane=>native(['pane','process-info','--pane',pane]).process_info})))(kind);
      const queueSelection = state => {
        const policy=queuePolicy(state);
        return JSON.stringify({policy,candidates:orderQueue(state,[...state.items.values()].filter(i=>!i.closed&&i.kind!=='goal'),policy)
          .map(i=>[i.id,queueClass(state,i,policy),queueSelected(i,state,ordinaryPolicy)])});
      };
      const obsoleteDecision=observeOutcomeDecisions({identity:project.identity,org});
      const capacityHeld=(item,input,error,observed_at)=>{
        const key=digest([item.id,input]);effects.capacity_waits??={};
        let wait=effects.capacity_waits[key];
        if(!wait||wait.state==='released')wait=effects.capacity_waits[key]={item:item.id,input,first_at:now(),state:'waiting',consumer:'line-service',
          wake_fact:['dispatch.completed','report.ingested','run.abandoned','closeout.effect','next capacity observation'],stuck_owner:to,
          ...(wait?{history:[...(wait.history??[]),Object.fromEntries(Object.entries(wait).filter(([k])=>k!=='history'))]}:{})};
        wait.last_at=now();wait.code=error.code;noticesDirty=true;
        log({action:'capacity-held',item:item.id,input,observed_at,waiting_since:wait.first_at,code:error.code,reason:error.message});
      };
      const admitItems = (items,repair=false) => {
        const selection=queueSelection(snapshot.state);
        for (const item of items) {
        if(expired()||!repair&&starts>=(maxStarts??config.dispatch?.max_sessions??7))break;
        snapshot=current();
        if(JSON.stringify(queuePolicy(snapshot.state))!==JSON.stringify(standing)||queueSelection(snapshot.state)!==selection){log({action:'queue-selection-changed'});break;}
        const observation=evaluationCache.probe('admission',{snapshot,item:item.id,policy:{...evaluationPolicy,standing}});
        if(observation.skip)continue;
        if(!queueSelected(snapshot.state.items.get(item.id),snapshot.state,ordinaryPolicy)){observation.retain('not selected');continue;}
        if(obsoleteDecision(snapshot.state.items.get(item.id),snapshot)){timings.outcome_decisions_deferred++;continue;}
        const input=dispatchInput({...snapshot,item:snapshot.state.items.get(item.id),org,identity:project.identity});
        if(!input){observation.retain('no dispatch input');continue;}
        const eligibleAt=now(),decisionStarted=performance.now();
        log({action:'admission-eligible',item:item.id,input,source_seq:item.created.seq,source_at:item.created.at,
          observed_at:eligibleAt,wake_owner:'line-service',event_to_wake_ms:null});
        // A saved request may finish through the original guarded continuation.
        // No new rule-generated review/dispatch or backlog attempt is admitted.
        if(!judgmentDispatchAllowed(item,input,effects.actions)){observation.retain('judgment input retained');continue;}
        if(!admissionLogged){log({action:'admission-stage',preceding_work_ms:precedingWork,preceding_budget_exhausted:precedingWork>=passBudgetMs,work_budget_ms:passBudgetMs});admissionLogged=true;}
        if(roleIs(item,'REV')&&cutoff&&isQueueReview(item)&&!index?.heads.includes(item.meta.review_target?.head)&&!snapshot.events.some(e=>e.type==='review.recovery-completed'&&e.item===item.meta.review_source_item&&e.target?.head===item.meta.review_target?.head)){
          try{sourceGit(repo,['merge-base','--is-ancestor',item.meta.review_target.head,cutoff.canonical_head]);timings.historical_review_skipped++;continue;}catch{/* Unlanded/unknown targets are errors, never historical skips. */}
        }
        const hold=itemLaunchHold(snapshot.state,item.id,snapshot.events);
        if (reserved(item) || hold) { note(`dispatch:${item.id}`, 'held or reserved ready item needs judgment',hold?{subject:hold.subject}:{},true);observation.retain('held or reserved');continue; }
        if(!admit({item:snapshot.state.items.get(item.id)},'launch')){observation.retain('admission policy');continue;}
        if (roleIs(item, 'REV') && !isQueueReview(item)) { note(`dispatch:${item.id}`, 'T2 legacy/manual review queue binding UNKNOWN; retain existing owner/attempt'); observation.retain('legacy review binding');continue; }
        try {
          const key = `dispatch:${item.id}:${input}`;
          let continuation,retryAdmission,briefRecovery,sourceRecovery,dispatchKey=key;
          if (effects.actions[key]) {
            const original=effects.actions[key];
            dispatchKey=original.prejournal_recovery?.key??key;
            const prior=effects.actions[dispatchKey];
            if(!prior)throw Error('pre-journal recovery intent has UNKNOWN outcome; retain owner');
            if(prior.original_outcome?.producer&&!prior.recorded_dispatch_status){log({action:'dispatch-producer-pending',key:dispatchKey});continue;}
            let result=prior.result;
            if(typeof result==='string')try{result=JSON.parse(result);}catch{}
            if(!result?.journal&&prior.receipt?.stdout)try{result=JSON.parse(prior.receipt.stdout);}catch{}
            if(!result?.journal&&prior.original_outcome?.journal)result={journal:prior.original_outcome.journal};
            if(result?.journal)continuation=preflightContinuation({journal:result.journal,repo,org,common:project.identity,root:fs.realpathSync(sourceRoot),events:snapshot.events});
            else {
              retryAdmission=initialCapacityRefusal(prior);
              if(!retryAdmission&&!original.prejournal_recovery){
                const contract=()=>{
                  const route=routeFor(item,config),brief=path.join(directory,`${digest(key)}.ask.md`);
                  return createWorkerBrief({item,ask:brief,askText:fs.readFileSync(brief,'utf8'),project:repo,org,lane:`line-${item.id.toLowerCase()}-${item.runs.length+1}`,route,harness:resolveLaunchRoute(config,{route}).kind,reviewRoute:reviewQueueRoute(config),exception:projectExceptionAddress(repo,config,route,childEnv)});
                };
                sourceRecovery=initialSourceRootRefusal({entry:prior,events:snapshot.events,item:item.id,outcome:prior.original_outcome,release:bundleRelease(),env:childEnv});
                briefRecovery=sourceRecovery??initialBriefRefusal({entry:prior,contract,events:snapshot.events,item:item.id,outcome:prior.original_outcome});
                if(briefRecovery)dispatchKey=`dispatch-recovered:${digest([key,briefRecovery])}`;
              }
            }
            if(!continuation&&!retryAdmission&&!briefRecovery){log({ action: 'dispatch-retained', key:dispatchKey, state: prior.state });if(roleIs(item,'REV')&&prior.state!=='complete'&&!prior.original_outcome?.error)note(key,prior.error??'original review launch outcome retained; no duplicate launch',{item:item.id,review:true});continue;}
          }
          const reviewTarget = isQueueReview(item) ? validateQueuedReview({ item, state: snapshot.state, events: snapshot.events, org, repo,...(continuation?{allowJournal:continuation.journal}:{}) }) : null;
          const route = continuation?.job.route??(reviewTarget ? reviewQueueRoute(config, item, snapshot.state) : routeFor(item, config));
          const capacityStarted=performance.now(),occupancy = countCapacity(dispatchPool({item:snapshot.state.items.get(item.id),job:{reviewQueue:reviewTarget}}));latestOccupancy=occupancy; log({ action: 'capacity',item:item.id,observation_ms:performance.now()-capacityStarted,...occupancy });
          const wait=effects.capacity_waits?.[digest([item.id,input])];
          if(wait?.state==='waiting'){wait.state='released';wait.released_at=now();wait.duration_ms=Math.max(0,Date.parse(wait.released_at)-Date.parse(wait.first_at));noticesDirty=true;}
          const decidedAt=performance.now(),admission={item:item.id,input,observed_at:eligibleAt,decision_at:now(),decision_ms:decidedAt-decisionStarted,
            capacity_wait_ms:wait?.duration_ms??0,capacity_wait_scope:'first observed full capacity to next observed available capacity',event_to_wake_ms:null};
          log({action:'admission-decision',...admission});
          const dispatched = effect(continuation?`dispatch-preflight:${continuation.token}:${continuation.key}`:dispatchKey, fresh => {
            const current = fresh.state.items.get(item.id);
            if (!current || !queueSelected(current,fresh.state,readOrdinaryAdmission(repo,childEnv)) || obsoleteDecision(current,fresh) || itemLaunchHold(fresh.state,item.id,fresh.events) || dispatchInput({...fresh,item:current,org,identity:project.identity}) !== input || reserved(current) || (!continuation&&(reviewTarget ? reviewQueueRoute(config, current, fresh.state) : routeFor(current, config)) !== route)) throw Error('dispatch readiness or route changed');
            const startDispatch = args => {
              // A lost reply can still mean a live session. Spend this pass's
              // allowance before issuing the command, regardless of its reply.
              starts++;
              log({action:'admission-attempted',...admission,start:starts});
              return JSON.parse(cli('dispatch/dispatch.mjs',args));
            };
            if(briefRecovery){
              if(sourceRecovery){
                const proof=initialSourceRootRefusal({entry:effects.actions[key],events:fresh.events,item:item.id,outcome:originalDispatchOutcome({repo,org,common:project.identity,item:item.id,brief:path.join(directory,`${digest(key)}.ask.md`),events:fresh.events}),release:bundleRelease(),env:childEnv});
                if(JSON.stringify(proof)!==JSON.stringify(sourceRecovery))throw Error('original zero-effect source refusal changed before re-admission');
                transact(org,events=>{
                  if(events.some(e=>e.type==='run.started'&&e.item===item.id&&Date.parse(e.at)>=Date.parse(effects.actions[key].at)))throw Error('run started before dispatch re-admission');
                  return{add:[{type:'line-service.dispatch-readmitted',project:project.identity,org,item:item.id,key,recovery_key:dispatchKey,proof}]};
                },{actor:'line-service',strictTail:true});
              }
              effects.actions[key].prejournal_recovery={...briefRecovery,key:dispatchKey,at:now()};save();log({action:'prejournal-recovery',key,recovery:effects.actions[key].prejournal_recovery});
            }
            if(continuation){
              const checked=preflightContinuation({journal:continuation.journal,repo,org,common:project.identity,root:fs.realpathSync(sourceRoot),events:fresh.events});
              if(!checked||checked.request_sha256!==continuation.request_sha256||checked.capability!==continuation.capability)throw Error('original preflight progress/source changed before continuation');
              if(reviewTarget)validateQueuedReview({item:current,state:fresh.state,events:fresh.events,org,repo,allowJournal:continuation.journal});
              return startDispatch(['--retry',continuation.journal,'--repo',repo,'--org',org,'--continue-preflight']);
            }
            const brief = path.join(directory, `${digest(key)}.ask.md`);
            const target = reviewTarget ? validateQueuedReview({ item: current, state: fresh.state, events: fresh.events, org, repo }) : null;
            const correction = correctionSource({ item: current, state: fresh.state, events: fresh.events, repo, org });
            writeFileAtomic(brief, target ? reviewQueueBrief(current) : isDecision(current) ? decisionBrief(current) : `# ${current.title}\n\n${current.accept.join('\n')}\n\n${correction?.brief ?? ''}Work from the existing item fields/notes and accepted directions. The generated execution brief supplies role guidance and project routing.\n`, 0o600);
            return startDispatch([item.id, '--repo', repo, '--org', org, '--lane', `${target ? 'review' : 'line'}-${item.id.toLowerCase()}-${current.runs.length + 1}`, '--route', route, '--brief', brief, ...(target ? ['--base', target.head] : correction ? ['--base', correction.base] : []),'--detach']);
          },undefined,undefined,Boolean(retryAdmission),Boolean(retryAdmission),fresh=>{
            if(!admit({item:fresh.state.items.get(item.id),state:fresh.state},'launch-mutation',true))return false;
            if(queueSelection(fresh.state)===selection)return true;
            log({action:'queue-selection-changed',item:item.id,stage:'after-capacity'});
            return false;
          },admission);
          // Acknowledgement timing is separate from the attempted-start budget.
          // The next candidate gets a fresh native count; no launch is replayed.
          if (dispatched?.state === 'complete'){log({action:'admission-started',item:item.id,input,observed_at:eligibleAt,decision_at:admission.decision_at,
            decision_to_ack_ms:performance.now()-decidedAt,eligible_to_ack_ms:performance.now()-decisionStarted,
            command_receipts:dispatched.commands??[],event_to_wake_ms:null});}
        } catch (e) {
          if(e.code==='REVIEW_CUTOFF'){timings.historical_review_skipped++;continue;}
          if(['DISPATCH_REVIEW_CAP','DISPATCH_DECISION_CAP'].includes(e.code)){capacityHeld(item,input,e,eligibleAt);note(`capacity:${e.code}`,e.message);continue;}
          if (['DISPATCH_SESSION_CAP', 'DISPATCH_UNLANDED_CAP'].includes(e.code)) {capacityHeld(item,input,e,eligibleAt);note(`capacity:${e.code}`, e.message); if(decisionActivation(snapshot.events,project.identity,org)&&(e.code==='DISPATCH_UNLANDED_CAP'||e.sessions?.kind==='build'&&e.sessions.native_count<e.sessions.native_cap))continue;break; }
          note(`dispatch:${item.id}`, e.message);
        }
      }};
      const ordered=orderQueue(snapshot.state,[...snapshot.state.items.values()].filter(item=>!item.closed&&item.kind!=='goal'),standing);
      log({action:'queue-order',policy:standing,candidates:ordered.map(item=>({item:item.id,class:queueClass(snapshot.state,item,standing)}))});
      admitItems(ordered);
      // Detached acknowledgements and review activity are not engineering
      // progress. This is the end of a completed pass, under the same lock.
      const latestAdmission=readReviewAdmission(repo,childEnv);
      if(!latestAdmission.enabled||!latestAdmission.hold_ordinary)try {
        snapshot=observe();
        const haltConfig={...config,ordinary_admission:readOrdinaryAdmission(repo,childEnv)};
        const observation=haltObservation({...snapshot,org,identity:project.identity,config:haltConfig,actions:effects.actions,occupancy:latestOccupancy});
        {
          if(observation.ready.length)try{latestOccupancy=countCapacity('build');}catch(e){latestOccupancy=e.sessions??{unknown:e.message};log({action:'halt-capacity-held',code:e.code,reason:e.message});}
          const observed=haltObservation({...snapshot,org,identity:project.identity,config:haltConfig,actions:effects.actions,occupancy:latestOccupancy});
          const route=config.routes?.['engineer-xhigh']?'engineer-xhigh':routeFor({role:'engineer',meta:{}},config);
          const completedPass=randomUUID();
          log({action:'engineering-idle-observation',pass:completedPass,observation:observed});
          const repair=completeHaltPass({repo,org,env:childEnv,pass:completedPass,previous:effects.halt_progress,observation:observed,route,after:haltAfter,audit:path.join(directory,'passes.jsonl'),effects:journal,actions:effects.actions});
          log({action:'engineering-idle',...repair});
          effects.halt_progress=repair.progress;save();
          if(repair.dispatch){
            // One diagnosis has an independent scheduling allowance; actual
            // native/shared capacity is still recounted by ordinary admission.
            workStarted=workClock();stale=true;snapshot=current();
            const item=snapshot.state.items.get(repair.item);if(item)admitItems([item],true);
          }
        }
      }catch(e){note('halt-repair',e.message);}
      checkpointNotices();
      if(performance.now()-passStarted>600000)note('long-pass','line pass exceeded ten minutes',{},true);
      checkpointNotices();const duration_ms = performance.now() - passStarted;
      for(const [key,entry]of Object.entries(effects.actions))if(entry.state!=='started'&&((entry.failure??outcomeFailure(entry)).kind==='fence'||key.startsWith('review:')&&entry.state!=='complete'&&!entry.recorded_review_status))try{
        if(key.startsWith('review:')&&entry.failure?.kind!=='fence'){
          const q=[...current().state.items.values()].find(q=>q.meta.review_source_item===key.split(':')[1]&&q.meta.review_target?.head===entry.review_target?.head);
          if(q){entry.recorded_review_status={item:q.id,created_seq:q.created.seq};save();continue;}
        }
        if(['review:','dispatch:'].some(prefix=>key.startsWith(prefix))){
          note(`outcome:${key}`,'The original action needs its project supervisor; retain the failed receipt and current ownership without another decision item.',{item:key.split(':')[1],effect:key,failure:entry.failure??outcomeFailure(entry)});continue;
        }
        effects.outcome_decisions??={};effects.outcome_decisions[key]??=queueOutcomeDecision({repo,org,env:childEnv,check:{key,subject:{item:key.split(':')[1],effect:key},failure:entry.failure??outcomeFailure(entry),receipt:entry.receipt,
          defect:key.startsWith('review:')?'Original review-queue command returned without a linked record item; no pending status producer is available.':undefined}});save();
      }catch(e){note(key,e.message);}
      const finalEvents=current().events,waits=finalEvents.filter(e=>e.type==='closeout.waiting'&&e.identity===project.identity),
        statuses=waits.map(w=>({wait:w,status:closeoutWaitState(w,finalEvents)})),
        pending=statuses.filter(row=>!['complete','classified'].includes(row.status)).map(row=>row.wait);
      log({ action: 'pass-complete', starts,unknown_open:pending.length,unknown_oldest_min:pending.length?Math.max(0,...pending.map(w=>(Date.parse(now())-Date.parse(w.at))/60000)):0,
        unknown_settled:statuses.filter(row=>row.status==='complete').length,
        classified_retained:statuses.filter(row=>row.status==='classified').length,unknown_escalated:Object.keys(effects.outcome_decisions??{}).length,
        evaluations:evaluationCounts,backlog:ordered.length,
        timing: { ...timings,pass_lock_ms:timings.pass_lock_ms+performance.now()-lockedAt,
          pass_lock_max_segment_ms:Math.max(timings.pass_lock_max_segment_ms,performance.now()-lockedAt),duration_ms,
          other_scan_and_guard_ms: Math.max(0, duration_ms - timings.effect_command_ms - timings.record_snapshot_ms) } });
      return { result: 'pass-complete', directory };
    } finally {commandTurn=undefined;try{if(release)checkpointNotices?.();}finally{try{heartbeat('finished');}finally{if(release){
      log({action:'schedule-unlocked',pass:passAt,pid:process.pid,duration_ms:performance.now()-lockedAt});release();release=null;
    }}} }
  }
  return { pass, closeout, intake, directory, log, acquirePass };
}

// The existing launchd schedule stays finite while the general pass runs in
// its own finite child. Every wake reconciles closeout even during long review.
// pass.lock serializes scheduling/journal writes; subject locks retain ongoing
// commands while another finite wake can admit independent work.
export function wakeLineService({service,launch,launchCloseout}){
  // A held closeout grants no authority over its effect. The general child
  // retains its own fresh identity, STOP/HOLD, source and admission guards.
  // The scheduled process must return while cleanup runs. Otherwise launchd
  // cannot supply another intake wake, even with separate intake/closeout locks.
  const intake=launchCloseout?closeoutOrHold(()=>service.intake(),row=>service.log(row)):undefined;
  const closeout=closeoutOrHold(()=>launchCloseout?launchCloseout():service.closeout(),row=>service.log(row));
  let general,release;
  try{release=(service.acquirePass??(()=>noticeLock(path.join(service.directory,'pass.lock'))))();}
  catch(error){
    if(!error.message.startsWith('locked:'))throw error;
    // A stale heartbeat never grants authority over a live/unidentified PID.
    // Keep it visible for its owner; only noticeLock's repeated ESRCH proof
    // permits recovery. A later child still acquires this same lock itself.
    service.log?.({action:'general-pass-held',schema:'line-pass-lock-held/v1',reason:error.message});
    general={already_running:true,reason:error.message};
  }
  if(release){release();general=launch();}
  return{result:'line-wake-complete',...(intake?{intake}:{}),closeout,general};
}

export async function main(argv = process.argv.slice(2), {home}={}) {
  const { values } = parseArgs({ args: argv, usage: 'line-service.mjs --once --repo CANONICAL --org RECORD --to SUPERVISOR', options: {
    once: { type: 'boolean' },'general-pass':{type:'boolean'},'closeout-pass':{type:'boolean'},digest:{type:'boolean'},since:{type:'string'}, repo: { type: 'string' }, org: { type: 'string' }, to: { type: 'string' }, herdr: { type: 'string' },
  } });
  if(values.digest){
    if(!values.org)throw Error('--digest needs --org RECORD');
    const repo=values.repo??process.cwd(),identity=gitProject(repo).identity,audit=path.join(serviceDirectory(fs.realpathSync(values.org),identity),'passes.jsonl');
    const diagnostics=readPassJournal(audit);
    process.stdout.write(JSON.stringify(morningDigest({events:loadEvents(values.org).events,diagnostics,since:values.since}),null,2)+'\n');return;
  }
  if (!values.once || !values.repo) throw Error('use --once --repo CANONICAL; launchd owns the schedule');
  serviceSource(values.repo,{home});
  installedContext(values.repo,values.org??findOrgDir({cwd:values.repo,env:{...process.env,ORG_DIR:''}}));
  const service = createLineService({...values,runtimeHome:home});
  const launchFinite=flag=>{
    const output=fs.openSync(path.join(service.directory,'launchd.log'),'a',0o600);
    try{
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url),...argv,flag],
        {cwd:values.repo,env:process.env,detached:true,stdio:['ignore',output,output]});
      child.on('error',error=>service.log({action:'finite-start-deferred',role:flag,reason:error.message}));child.unref();
      return{pid:child.pid};
    }finally{fs.closeSync(output);}
  };
  const result = values['general-pass'] ? service.pass({reconcileCloseout:false}) : values['closeout-pass'] ? closeoutOrHold(()=>service.closeout({reconcileReports:false}),service.log) :
    wakeLineService({service,launch:()=>launchFinite('--general-pass'),launchCloseout:()=>launchFinite('--closeout-pass')});
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (isMain(import.meta.url)) main().catch(e => { process.stderr.write(`line-service: ${e.message}\n`); process.exitCode = 1; });
