#!/usr/bin/env node
// One model-free pass. launchd supplies the schedule, existing CLIs own effects.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import {foregroundCommand} from '../dispatch/foreground-command.mjs';
import {originalDispatchOutcome} from '../dispatch/outcome.mjs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, loadEvents, writeFileAtomic } from '../lib/store.mjs';
import { fold, itemStatus, sortItems } from '../lib/state.mjs';
import { effectiveWorkerIdentity, workerReceipt } from '../lib/worker-identity.mjs';
import { readOwnedRun, requireController, assertOwner } from '../lib/run-owner.mjs';
import { loadDiscoveredRoutes, resolveLaunchRoute, selectRoute } from '../lanes/routes.mjs';
import { checkSessionCap } from '../dispatch/session-cap.mjs';
import { noticeLock } from '../supervisor/notice-lock.mjs';
import { readCloseoutEntries, closeoutRevision, safeCloseoutRetry,closeoutOutcomeObservation,scheduleLineCloseouts } from '../lib/closeout.mjs';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { reviewAttempt, readServiceJournal } from './review.mjs';
import { queueConsumer, isQueueReview, validateQueuedReview, reviewQueueBrief, reviewQueueRoute } from './review-queue.mjs';
import { roleIs } from '../lib/roles.mjs';
import { recordLineNotice,canonicalFailure } from './record-inbox.mjs';
import { enqueueNamedDecision } from './decision-wake.mjs';
import { canonical } from '../messages/schema.mjs';
import { discoverChanges,dispatchInput,phase0Boundary,morningDigest,recordReviewResults,reviewCompletionPlan,recordReviewCompletion,ensureReviewBoundary,canonicalReviewIndex,recordReviewErrors,recordReviewHealth } from './phase1.mjs';
import {preflightContinuation,initialCapacityRefusal} from '../dispatch/preflight.mjs';
import {observeReviewProgress,recoverServiceReview} from './review-recovery.mjs';
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
function replayNoticeAudit(file,effects){
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});if(!stat)return[];
  if(!stat.isFile()||fs.realpathSync(file)!==file)throw Error('notice audit is redirected');
  const offset=effects.notice_audit_offset??stat.size;if(!Number.isSafeInteger(offset)||offset<0||offset>stat.size)throw Error('notice audit checkpoint is inconsistent');
  const bytes=Buffer.alloc(stat.size-offset),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{let n=0;while(n<bytes.length){const got=fs.readSync(fd,bytes,n,bytes.length-n,offset+n);if(!got)throw Error('notice audit changed during read');n+=got;}}finally{fs.closeSync(fd);}
  const text=bytes.toString('utf8');if(text&&!text.endsWith('\n'))throw Error('notice audit tail is incomplete; preserve it');
  const restored=new Set();for(const line of text.split('\n').filter(Boolean)){const row=JSON.parse(line),notice=row.notice_record;if(!notice)continue;const {key,entry}=notice;
    if(!entry||!Number.isSafeInteger(entry.count)||entry.count<1||!Number.isFinite(Date.parse(entry.first_at)))throw Error('notice audit source/count is inconsistent');
    noticeBoundary(key,entry,row.boundary);
    effects.record_notices??={};const prior=effects.record_notices[key];if(prior){noticeBoundary(key,prior,entry.boundary);if(prior.first_at!==entry.first_at)throw Error('notice audit first occurrence is inconsistent');}
    if(!prior||entry.count>prior.count){effects.record_notices[key]={...entry,state:prior?.state==='recorded'?'recorded':'recording',...(prior?.record?{record:prior.record}:{}),review_count_recorded:prior?.review_count_recorded??0};restored.add(key);}
  }
  return [...restored];
}
export const serviceDirectory = (org, identity) => path.join(org, 'line-service', digest(identity).slice(0, 20));
export function reserved(item) {
  return item.role === 'human' || item.meta.operator_reserved || item.meta.reserved ||
    ['security', 'funds-and-chain', 'publish', 'delete-data', 'licensing', 'priorities'].includes(item.meta.category);
}
export function routeFor(item, config) {
  const task = { engineer: 'implementation', architect: 'planning', reviewer: 'review', writer: 'writing', researcher: 'research' }[item.role];
  const route = item.meta.route ?? (config.routes?.[item.role] ? item.role : selectRoute(config, item.capability ?? task));
  resolveLaunchRoute(config, { route });
  return route;
}

export function createLineService({ repo, org, to, herdr = 'herdr', env = process.env, command = foregroundCommand,
  recordNotice = recordLineNotice, wakeDecision = enqueueNamedDecision, capacity, identify = gitProject, now = () => new Date().toISOString(),
  childTimeoutMs=120000,maxStarts,maxStepsPerStage=8,passBudgetMs=480000,alertAfter=3,workClock=()=>performance.now() }) {
  const project = identify(repo);
  if (project.checkout !== project.canonical) throw Error('line service requires the canonical project checkout');
  repo = project.canonical;
  const discovered = findOrgDir({ cwd: repo, env: { ...env, ORG_DIR: '' } });
  org = fs.realpathSync(org ?? discovered);
  if (!discovered || fs.realpathSync(discovered) !== org) throw Error('line-service record differs from the project record');
  if (typeof to !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(to)) throw Error('name the actual project supervisor or brain-chat recipient with --to');
  const directory = serviceDirectory(org, project.identity), journal = path.join(directory, 'effects.json');
  fs.mkdirSync(directory, { recursive: true });
  const log = row => {
    const fd = fs.openSync(path.join(directory, 'passes.jsonl'), 'a', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ at: now(), ...row }) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };
  const childEnv = { ...env, ORG_DIR: org, ORG_ACTOR: 'line-service', HERDR_BRAIN_ROOT: sourceRoot };
  // A launchd controller has no pane/session identity. Never inherit an installer's.
  for (const key of Object.keys(childEnv)) if (/^(HERDR_(ENV|PANE_ID|TAB_ID|WORKSPACE_ID)|CODEX_(SESSION_ID|THREAD_ID)|GIT_.*|LANE_CONFIG)$/.test(key)) delete childEnv[key];
  delete childEnv.ORG_GUARD_OVERRIDE; // A routine line never inherits an explicit judgment override.
  let timings;
  const invoke = (exe, args, { receipt = false } = {}) => {
    const started = performance.now();
    let r;
    try { r = command(exe, args, { cwd: repo, env: childEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,timeout:0 }); }
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
    if (fs.existsSync(path.join(directory, 'STOP')) || fs.existsSync(path.join(repo, '.lane/supervisor/STOP')) || fs.existsSync(path.join(repo, '.lane/supervisor/HOLD'))) throw Error('STOP/HOLD prevents line-service effects');
    const loaded = loadEvents(org);
    if (loaded.tornTail) throw Error('incomplete record tail');
    const result = { ...loaded, state: fold(loaded.events) };
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
  function pass() {
    const release = noticeLock(path.join(directory, 'pass.lock'));
    let effects,checkpointNotices;
    const passAt=now(),heartbeat=phase=>writeFileAtomic(path.join(directory,'heartbeat.json'),JSON.stringify({at:now(),started_at:passAt,project:project.identity,source:sourceRoot,phase,pid:process.pid})+'\n',0o600);
    heartbeat('starting');
    try {
      const passStarted = performance.now();
      let workStarted=workClock();const expired=()=>workClock()-workStarted>=passBudgetMs;
      timings = { snapshots: 0, record_snapshot_ms: 0, effect_command_ms: 0, historical_intake_skipped: 0, historical_review_skipped: 0, closeout_retained: 0,effects_journal_writes:0,notice_record_attempts:0,review_error_batches:0 };
      effects = readServiceJournal(journal) ?? { identity: project.identity, org, actions: {}, notices: {} };
      if (effects.identity !== project.identity || effects.org !== org) throw Error('effect journal project binding changed');
      const audit=path.join(directory,'passes.jsonl'),restored=replayNoticeAudit(audit,effects),pendingErrors=new Map();let noticesDirty=false,counterFailed=false;
      timings.notice_audit_replayed=restored.length;
      const errorRow=(key,e)=>({key,count:e.count,boundary:e.boundary,reason:e.reason,scope:e.scope});
      // An older row that cannot prove its canonical boundary stays retained and
      // counted; it never fails the batch for every other bound counter.
      timings.review_error_unbound=0;
      for(const [key,e]of Object.entries(effects.record_notices??{}))if(e.review&&(e.review_count_recorded??0)<e.count){try{noticeBoundary(key,e);pendingErrors.set(key,errorRow(key,e));}catch{timings.review_error_unbound++;}}
      const save = () => {effects.notice_audit_offset=fs.statSync(audit,{throwIfNoEntry:false})?.size??0;writeFileAtomic(journal, JSON.stringify(effects, null, 2) + '\n', 0o600);timings.effects_journal_writes++;noticesDirty=false;};
      const flushErrors=()=>{
        if(!pendingErrors.size||counterFailed)return;
        try{timings.review_error_batches++;recordReviewErrors({repo,org,rows:[...pendingErrors.values()],env:childEnv});for(const [key,row]of pendingErrors)effects.record_notices[key].review_count_recorded=row.count;pendingErrors.clear();noticesDirty=true;}
        catch(e){counterFailed=true;log({action:'review-error-counter-held',error:e.message});}
      };
      checkpointNotices=()=>{flushErrors();if(noticesDirty)save();};
      if(effects.pass_number!==undefined&&(!Number.isSafeInteger(effects.pass_number)||effects.pass_number<0))throw Error('service pass counter is inconsistent');
      effects.pass_number=(effects.pass_number??0)+1;save();
      let snapshot, stale = true, reviewCache = new Map();
      const current = () => { if (stale) { snapshot = observe(); stale = false; reviewCache = new Map(); } return snapshot; };
      const deliverNotice=(key,entry)=>{
        if(entry.state==='recorded')return;
        try{
          timings.notice_record_attempts++;
          const receipt=recordNotice({repo,org,id:entry.id,boundary:entry.boundary,reason:entry.reason,scope:entry.scope,first_at:entry.first_at,audit,counts:`${journal}#record_notices/${key}`,env:childEnv,...(entry.review?{reviewError:errorRow(key,entry)}:{})});
          entry.state='recorded';entry.record={id:receipt.id,state:receipt.state};if(receipt.review_error_recorded){entry.review_count_recorded=entry.count;pendingErrors.delete(key);}
        }catch(e){entry.state='record-uncertain';entry.error=e.message;log({action:'record-inbox-held',canonical_key:key,error:e.message});}
        noticesDirty=true;
      };
      const note = (boundary, reason, scope = {}, force = false, row = {}) => {
        scope=Object.fromEntries(Object.entries(scope).filter(([,value])=>value!==undefined));
        const scoped=scope.item??/^dispatch:([A-Z]+-\d+)/.exec(boundary)?.[1],review=scope.review===true||/^review|DISPATCH_REVIEW/i.test(boundary)||roleIs(snapshot?.state.items.get(scoped),'REV');
        const normalized=canonicalFailure(reason),key=createHash('sha256').update(canonical([boundary,normalized,scope])).digest('hex');
        effects.record_notices??={};
        const prior=effects.record_notices[key],entry=effects.record_notices[key]=prior??{first_at:now(),reason:normalized,scope,boundary,state:'recording',id:`line-record-${key}`,count:0};
        noticeBoundary(key,entry,boundary);
        entry.count++;entry.last_at=now();if(review){entry.review=true;pendingErrors.set(key,errorRow(key,entry));}noticesDirty=true;
        // The compact fsynced delta precedes the record mutation. A lost full
        // checkpoint replays notice counts only, never native effect intents.
        log({action:'hold',...row,boundary,reason,canonical_key:key,scope,notice_record:{key,entry}});
        if(!force&&!review&&entry.count<alertAfter)return;
        deliverNotice(key,entry);
      };
      const effect = (key, run, binding, operation, safe=false, outcomeReadback=false) => {
        const pendingHandoff = result => key.startsWith('closeout:') && Array.isArray(result?.evaluated) && result.evaluated.length===0 &&
          Array.isArray(result.restart?.keys) && result.restart.keys.length>0 && result.successor?.pending===true &&
          result.successor.reason==='fresh drain required' && JSON.stringify(result.successor.keys)===JSON.stringify(result.restart.keys);
        if (effects.actions[key]) {
          const prior = effects.actions[key];
          const unsafe=/EPERM|EACCES|native refusal|foreign|identity|reserved|HOLD|supervisor judgment/i.test(prior.error??'');
          if(!safe||prior.state==='complete'&&!pendingHandoff(prior.result)||unsafe&&!outcomeReadback){
            log({ action: 'effect-retained', key, state: prior.state });
            if (prior.state !== 'complete') note(key, prior.error ?? 'prior failed/uncertain effect retained; inspect its existing receipt, do not replay');
            return prior;
          }
        }
        if(expired())return;
        checkpointNotices();
        observe();
        stale = true;
        const prior=effects.actions[key],history=prior?[...(prior.history??[]),Object.fromEntries(Object.entries(prior).filter(([k])=>k!=='history'))]:[];
        const entry = effects.actions[key] = { state: 'started', at: now(),...(history.length?{history}:{}), ...(binding ? { review_target: binding, review_operation: operation } : {}) }; save();
        try {
          entry.result = run(); entry.state = 'complete';
          if (['escalate', 'failed', 'stopped', 'judge_promotion'].includes(entry.result?.result)) {
            entry.state = 'held'; entry.error = entry.result.reason ?? entry.result.result;
          }
          if(entry.result?.already_running){entry.state='held';entry.error='ordinary closeout consumer contention; unchanged request retained';}
          if(pendingHandoff(entry.result)){entry.state='held';entry.error='closer implementation changed before effect; original requests need a fresh drain';}
          const deferred = entry.result?.evaluated?.filter(row => !row.completed&&!row.sessions_retired);
          if (deferred?.length) { entry.state = 'held'; entry.error = deferred.map(row => `${row.run}: ${row.reason}`).join('; '); }
        }
        catch (e) { entry.state = 'held'; entry.error = e.message; entry.receipt = e.receipt; }
        entry.finished_at = now(); save(); log({ action: 'effect', key, ...entry });
        if (entry.state === 'held') note(key, entry.error);
        return entry;
      };
      log({ action: 'pass-start', pid: process.pid, identity: project.identity, source: sourceRoot,source_head:sourceGit(sourceRoot,['rev-parse','HEAD']) });
      try { snapshot = current(); } catch (e) { log({ action: 'pass-held', reason: e.message }); return { held: e.message, directory }; }
      for(const key of restored){const entry=effects.record_notices[key];if(entry.review||entry.count>=alertAfter)deliverNotice(key,entry);}
      let intakeSteps=0;
      for (const run of snapshot.state.runs.values()) {
        if(expired()||intakeSteps>=maxStepsPerStage)break;
        if(run.report||run.abandoned){if(snapshot.state.items.get(run.item)?.closed)timings.historical_intake_skipped++;continue;}
        if(!run.report_path||!fs.existsSync(run.report_path))continue;
        const item=snapshot.state.items.get(run.item);if(!item)continue;
        if(item.closed||!run.owner||run.owner.legacy||run.owner.controller!=='brain'||item.runs.at(-1)!==run.id&&snapshot.state.runs.get(item.runs.at(-1))?.report){timings.historical_intake_skipped++;continue;}
        try{
          const workspace=Boolean(run.workspace&&fs.existsSync(run.workspace));
          guardRun(run.id,{reported:false,current:false,workspace});
          intakeSteps++;
          effect(`ingest:${run.id}`,()=>{
            guardRun(run.id,{reported:false,current:false,workspace});
            return cli('bin/org.mjs',['ingest',run.report_path,'--run',run.id,...(item.runs.at(-1)===run.id?['--if-current-run',run.id]:[])]);
          },undefined,undefined,true);
        }catch(e){note(`ingest:${run.id}`,e.message);}
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
          effect(`review-result:${run.id}:${run.report.sha256}`,()=>recordReviewResults({repo,org,runId:run.id,env:childEnv}),undefined,undefined,true);
        }
      }
      snapshot=current();
      try{
        const observed=observeReviewProgress({state:snapshot.state,org,identity:project.identity,pass:effects.pass_number,previous:effects.review_progress});effects.review_progress=observed.progress;save();let recoveries=0;
        for(const id of observed.candidates){
          if(expired()||recoveries>=maxStepsPerStage)break;const q=snapshot.state.items.get(id),target=q.meta.review_target;
          const held=effects.review_recovery_holds?.[id],capability='original-scope-continuation/v2',productHold=held&&/partial\/ambiguous producer|historical\/partial target/.test(held.reason);
          if(held?.signature===observed.progress[id].signature&&!(productHold&&held.capability!==capability))continue;
          try{checkpointNotices();const result=recoverServiceReview({repo,org,reviewId:id,env:childEnv,call:(_exe,args)=>JSON.stringify({result:native(args)})});log({action:'review-progress-resolution',item:id,...result});if(['review_queued','original_prestart_ready','original_review_ready'].includes(result.result))stale=true;
            if(result.result==='original_review_ready')effect(`review-original:${id}:${result.proof}`,()=>JSON.parse(cli('dispatch/dispatch.mjs',['--retry',result.journal,'--repo',repo,'--org',org,'--continue-review'])));
          }
          catch(e){effects.review_recovery_holds??={};if(/EPERM|EACCES|native refusal|identity|reserved|HOLD|STOP|UNKNOWN|partial|ambiguous/i.test(e.message))effects.review_recovery_holds[id]={signature:observed.progress[id].signature,reason:e.message,capability};save();note(`review-progress:${id}`,e.message,{item:id,review:true});}
          recoveries++;
        }
      }catch(e){note('review-progress',e.message);}
      snapshot=current();
      let discovered,index;try{index=canonicalReviewIndex({events:snapshot.events,state:snapshot.state,repo,org,identity:project.identity,boundary:cutoff});discovered=discoverChanges({events:snapshot.events,state:snapshot.state,repo,org,identity:project.identity,pendingOnly:true,index});}catch(e){discovered={changes:[],holds:[{reason:e.message}]};}
      for(const held of discovered.holds)note(`review-source:${held.run??'boundary'}:${held.head??''}`,held.reason,{item:held.item,run:held.run,head:held.head,review:true});
      let reviewSteps=0;
      for(const {item,run,target}of discovered.changes){
        if(expired()||reviewSteps>=maxStepsPerStage)break;
        const key=`review:${item.id}:${target.head}`;let reviewLock;
        try{
          reviewLock=noticeLock(path.join(directory,`review-change-${digest([item.id,target.head])}.lock`),{recover:false});
          const ignoreService={file:journal,key,target,operation:'record-queue'};
          const attempt=reviewAttempt(item,{org,identity:project.identity,events:snapshot.events,state:snapshot.state,repo,effects,cache:reviewCache,target,capturedRun:run.id,ignoreService});
          if(attempt){note(key,attempt,{item:item.id,run:run.id,head:target.head,review:true},false,{action:'review-retained',item:item.id,head:target.head});continue;}
          queueConsumer({run,env:childEnv});reviewSteps++;
          effect(key,()=>{
            const fresh=observe(),checked=discoverChanges({events:fresh.events,state:fresh.state,repo,org,identity:project.identity}).changes.find(c=>c.item.id===item.id&&c.target.head===target.head);
            if(!checked||JSON.stringify(checked.target)!==JSON.stringify(target))throw Error('immutable landed target/evidence changed before queue mutation');
            queueConsumer({run:checked.run,env:childEnv});
            return JSON.parse(cli('bin/org.mjs',['queue-review',run.id,'--head',target.head,'--base',target.base]));
          },target,'record-queue',true);
        }catch(e){note(key,e.message,{item:item.id,run:run.id,head:target.head});}
        finally{reviewLock?.();}
      }
      for(const {selector,target}of discovered.unattributed??[]){
        if(expired()||reviewSteps>=maxStepsPerStage)break;
        const key=`review:${selector}`;let reviewLock;
        try{
          reviewLock=noticeLock(path.join(directory,`review-change-${digest(selector)}.lock`),{recover:false});reviewSteps++;
          effect(key,()=>{
            const fresh=observe(),checked=discoverChanges({events:fresh.events,state:fresh.state,repo,org,identity:project.identity}).unattributed?.find(c=>c.selector===selector);
            if(!checked||JSON.stringify(checked.target)!==JSON.stringify(target))throw Error('immutable canonical target/evidence changed before queue mutation');
            return JSON.parse(cli('bin/org.mjs',['queue-review',selector,'--head',target.head,'--base',target.base]));
          },target,'record-queue',true);
        }catch(e){note(key,e.message,{head:target.head,review:true});}
        finally{reviewLock?.();}
      }
      if(index)try{
        checkpointNotices();
        const errors=Object.values(effects.record_notices??{}).filter(e=>e.review),health=recordReviewHealth({repo,org,index,passId:`${directory}:${effects.pass_number}`,errorCounts:{unique:errors.length,occurrences:errors.reduce((n,e)=>n+e.count,0)},env:childEnv});
        log({action:'review-health',owed:health.owed,queued:health.queued,running:health.running,done:health.done,missing_queue:health.missing_queue,gap_passes:health.gap_passes,errors:health.errors});
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
        try{const plan=reviewCompletionPlan({events:snapshot.events,state:snapshot.state,runId:run.id});effect(`review-complete:${run.id}:${plan.token}`,()=>recordReviewCompletion({repo,org,runId:run.id,env:childEnv}),undefined,undefined,true);}
        catch(e){note(`review-complete:${run.id}`,e.message,{item:item.id,run:run.id});}
      }
      snapshot=current();
      let closeSteps=0;
      for (const item of [...snapshot.state.items.values()].sort((a,b)=>(snapshot.state.runs.get(b.runs.at(-1))?.report?.seq??0)-(snapshot.state.runs.get(a.runs.at(-1))?.report?.seq??0))) {
        if(expired()||closeSteps>=maxStepsPerStage)break;
        const run = snapshot.state.runs.get(item.runs.at(-1));
        if (item.closed || isQueueReview(item) || run?.report?.outcome !== 'done' || run.abandoned || !run.workspace || !fs.existsSync(run.workspace) ||
            !run.owner || run.owner.legacy || run.owner.controller !== 'brain') continue;
        try {
          if (identify(run.workspace).identity !== project.identity) continue;
          if (reserved(item) || item.meta.hold || item.meta.held || run.report.blockers?.length || (run.report.questions ?? run.report.extra?.questions)?.length) {
            note(`source-complete:${run.id}`, 'T2 source completion needs supervisor judgment: held/reserved item or report blockers/questions; no explicit-judgment override used'); continue;
          }
          closeSteps++;
          effect(`source-complete:${run.id}:${run.report.sha256}`, () => {
            const bound = guardRun(run.id), ownership = requireController(readOwnedRun(org, run.id), 'brain');
            if (bound.item.closed) return { retained: 'already source-complete' };
            if (bound.run.report.outcome !== 'done' || reserved(bound.item) || bound.item.meta.hold || bound.item.meta.held ||
                bound.run.report.blockers?.length || (bound.run.report.questions ?? bound.run.report.extra?.questions)?.length) throw Error('T2 source completion needs supervisor judgment: current item/report scope changed');
            const head = sourceGit(run.workspace, ['rev-parse', 'HEAD']), tip = sourceGit(repo, ['rev-parse', 'HEAD']);
            if (sourceGit(run.workspace, ['status', '--porcelain=v1', '--untracked-files=all']) || sourceGit(repo, ['status', '--porcelain=v1', '--untracked-files=all'])) throw Error('T2 source completion needs supervisor judgment: source/canonical worktree is not clean');
            try { sourceGit(repo, ['merge-base', '--is-ancestor', head, tip]); }
            catch { throw Error(`T2 source completion needs supervisor judgment: reported source ${head} is not integrated at ${tip}`); }
            const fresh = guardRun(run.id);
            assertOwner(readOwnedRun(org, run.id), ownership);
            if (fresh.run.report.sha256 !== run.report.sha256 || sourceGit(run.workspace, ['rev-parse', 'HEAD']) !== head || sourceGit(repo, ['rev-parse', 'HEAD']) !== tip) throw Error('T2 source completion needs supervisor judgment: owner/report/source boundary changed');
            const args = ['close', item.id, '--if-current-run', run.id, '--note',
              `Routine conditional source completion of current done report ${run.id} (${run.report.sha256}); clean source ${head} integrated at ${tip}. Preserve existing independent review/verdict holds, callbacks, HOLD, archives and next final-release/Major-correction obligations; physical cleanup is separate.`];
            return { source_head: head, integrated_tip: tip, report_sha256: run.report.sha256, ownership,
              command: [process.execPath, path.join(sourceRoot, 'bin/org.mjs'), ...args], close: cli('bin/org.mjs', args, { receipt: true }) };
          },undefined,undefined,true);
        } catch (e) { note(`source-complete:${run.id}`, `T2 source completion needs supervisor judgment: ${e.message}`); }
      }
      try {
        const observed = current(), evaluations = new Map(observed.events.filter(e => e.type === 'closeout.evaluated').map(e => [e.key, e]));
        const entries = readCloseoutEntries(project.identity).filter(e => {
          if (e.org !== org || e.project !== repo) return false;
          // Retained legacy/native-held requests keep their existing owner.
          // A code handoff is not changed input for an old refused effect.
          if(!cutoff||e.source.seq<=cutoff.seq){timings.closeout_retained++;return false;}
          const prior = evaluations.get(e.key);
          if (prior?.completed) {timings.closeout_retained++;return false;}
          if (!prior && !fs.existsSync(e.cwd)) return false;
          if(prior&&/EPERM|EACCES|native refusal|foreign|identity|reserved|HOLD/i.test(prior.reason??'')&&!closeoutOutcomeObservation(prior,{entry:e,events:observed.events})){timings.closeout_retained++;return false;}
          return !prior||closeoutRevision(e,observed.events,observed.state)>(prior.revision??0)||safeCloseoutRetry(prior,{entry:e,events:observed.events})||
            closeoutOutcomeObservation(prior,{entry:e,events:observed.events});
        });
        for(const {entry,sessionsOnly}of scheduleLineCloseouts(entries,observed.events)){
          const revision=closeoutRevision(entry,observed.events,observed.state),outcomeReadback=closeoutOutcomeObservation(evaluations.get(entry.key),{entry,events:observed.events});
          effect(`closeout:${sessionsOnly?'sessions':'physical'}:${digest([entry.key,revision])}`,()=>JSON.parse(cli('supervisor/closeout.mjs',['drain','--repo',repo,'--org',org,'--keys',JSON.stringify([entry.key]),'--no-restart','--retry-safe','--deadline','0',...(sessionsOnly?['--sessions-only']:[])])),undefined,undefined,true,outcomeReadback);
        }
      } catch (e) { note('closeout', e.message); }
      // A routine error never creates a decision. Only a real post-cutover
      // pending reserved question with an explicitly named decider may wake.
      snapshot=current();
      if(cutoff)for(const item of snapshot.state.items.values()){
        if(item.role!=='human'||item.closed||item.meta.answer||item.meta.operator_reserved!==true||item.meta.decider!=='brain-chat'||item.created.seq<=cutoff.seq)continue;
        effects.decisions??={};effects.decider_next??={};
        if(effects.decisions[item.id])continue;
        const time=Date.parse(now());if(time<(effects.decider_next[item.meta.decider]??0))continue;
        effects.decisions[item.id]={state:'intent',at:now(),decider:item.meta.decider};effects.decider_next[item.meta.decider]=time+60000;save();
        try{
          const message=recordNotice({repo,org,id:`line-decision-${digest([project.identity,item.id])}`,boundary:`decision:${item.id}`,reason:'actual pending explicitly named reserved decision',scope:{item:item.id},first_at:effects.decisions[item.id].at,audit:path.join(directory,'passes.jsonl'),counts:`${journal}#decisions/${item.id}`,env:childEnv,kind:'question',question:item.id});
          const result=wakeDecision({envelope:message.envelope,binding:message.binding,state:snapshot.state,fresh:observe});
          effects.decisions[item.id]={...effects.decisions[item.id],state:'queued-or-retained',result};
        }catch(e){effects.decisions[item.id]={...effects.decisions[item.id],state:'held',error:e.message};note(`decision:${item.id}`,e.message,{item:item.id});}
        save();
      }
      // Failed cleanup/review never prevents considering independent ready work.
      snapshot = current();
      for(const [key,entry]of Object.entries(effects.actions))if(key.startsWith('dispatch:')&&(entry.state!=='complete'||entry.result?.result==='detached'&&entry.original_outcome?.status!=='dispatch-complete')){
        const item=key.split(':')[1];
        try{
          const outcome=originalDispatchOutcome({repo,org,common:project.identity,item,brief:path.join(directory,`${digest(key)}.ask.md`),journal:entry.original_outcome?.journal??entry.result?.journal,events:snapshot.events});
          if(JSON.stringify(outcome)!==JSON.stringify(entry.original_outcome)){entry.original_outcome=outcome;save();log({action:'dispatch-outcome-readback',key,...outcome});}
          if(outcome.status==='unknown')note(key,outcome.reason,{item});
          else if(outcome.error)note(key,outcome.error,{item});
        }catch(e){note(key,e.message,{item});}
      }
      const { config } = loadDiscoveredRoutes({ cwd: repo, env: childEnv });
      // Productive cleanup is allowed to finish. It cannot consume READY work's
      // independent admission allowance. All actual effects still recount and
      // re-read native/record/source/STOP/HOLD; no worker is stopped by a clock.
      const precedingWork=workClock()-workStarted;workStarted=workClock();
      let starts=0,admissionLogged=false;
      for (const item of sortItems([...snapshot.state.items.values()].filter(item => !item.closed && item.kind !== 'goal')).sort((a, b) => Number(isQueueReview(b)) - Number(isQueueReview(a)))) {
        if(expired()||starts>=(maxStarts??config.dispatch?.max_sessions??7))break;
        snapshot=current();
        const input=dispatchInput({...snapshot,item:snapshot.state.items.get(item.id),org,identity:project.identity});
        if(!input)continue;
        if(!admissionLogged){log({action:'admission-stage',preceding_work_ms:precedingWork,preceding_budget_exhausted:precedingWork>=passBudgetMs,work_budget_ms:passBudgetMs});admissionLogged=true;}
        if(roleIs(item,'REV')&&cutoff&&isQueueReview(item)&&!index?.heads.includes(item.meta.review_target?.head)&&!snapshot.events.some(e=>e.type==='review.recovery-completed'&&e.item===item.meta.review_source_item&&e.target?.head===item.meta.review_target?.head)){
          try{sourceGit(repo,['merge-base','--is-ancestor',item.meta.review_target.head,cutoff.canonical_head]);timings.historical_review_skipped++;continue;}catch{/* Unlanded/unknown targets are errors, never historical skips. */}
        }
        if (roleIs(item, 'REV') && !isQueueReview(item)) { note(`dispatch:${item.id}`, 'T2 legacy/manual review queue binding UNKNOWN; retain existing owner/attempt'); continue; }
        if (reserved(item) || item.meta.hold || item.meta.held) { note(`dispatch:${item.id}`, 'held or reserved ready item needs judgment'); continue; }
        try {
          const key = `dispatch:${item.id}:${input}`;
          let continuation,retryAdmission;
          if (effects.actions[key]) {
            const prior=effects.actions[key];let result=prior.result;
            if(typeof result==='string')try{result=JSON.parse(result);}catch{}
            if(!result?.journal&&prior.receipt?.stdout)try{result=JSON.parse(prior.receipt.stdout);}catch{}
            if(!result?.journal&&prior.original_outcome?.journal)result={journal:prior.original_outcome.journal};
            if(result?.journal)continuation=preflightContinuation({journal:result.journal,repo,org,common:project.identity,root:fs.realpathSync(sourceRoot),events:snapshot.events});
            else retryAdmission=initialCapacityRefusal(prior);
            if(!continuation&&!retryAdmission){log({ action: 'dispatch-retained', key, state: prior.state });if(roleIs(item,'REV')&&prior.state!=='complete'&&!prior.original_outcome?.error)note(key,prior.error??'original review launch outcome retained; no duplicate launch',{item:item.id,review:true});continue;}
          }
          const reviewTarget = isQueueReview(item) ? validateQueuedReview({ item, state: snapshot.state, events: snapshot.events, org, repo,...(continuation?{allowJournal:continuation.journal}:{}) }) : null;
          const route = continuation?.job.route??(reviewTarget ? reviewQueueRoute(config) : routeFor(item, config));
          const count = capacity ?? (() => checkSessionCap({ config, org, kind:reviewTarget?'review':'build',common: project.identity,
            agent: name => native(['agent', 'get', name]).agent,
            processInfo: pane => native(['pane', 'process-info', '--pane', pane]).process_info }));
          const occupancy = count(); log({ action: 'capacity', ...occupancy });
          const dispatched = effect(continuation?`dispatch-preflight:${continuation.token}:${continuation.key}`:key, () => {
            const fresh = observe(), current = fresh.state.items.get(item.id);
            if (!current || current.closed || dispatchInput({...fresh,item:current,org,identity:project.identity}) !== input || reserved(current) || current.meta.hold || current.meta.held || (!continuation&&(reviewTarget ? reviewQueueRoute(config) : routeFor(current, config)) !== route)) throw Error('dispatch readiness or route changed');
            if(continuation){
              const checked=preflightContinuation({journal:continuation.journal,repo,org,common:project.identity,root:fs.realpathSync(sourceRoot),events:fresh.events});
              if(!checked||checked.request_sha256!==continuation.request_sha256||checked.capability!==continuation.capability)throw Error('original preflight progress/source changed before continuation');
              if(reviewTarget)validateQueuedReview({item:current,state:fresh.state,events:fresh.events,org,repo,allowJournal:continuation.journal});
              return JSON.parse(cli('dispatch/dispatch.mjs',['--retry',continuation.journal,'--repo',repo,'--org',org,'--continue-preflight']));
            }
            const brief = path.join(directory, `${digest(key)}.ask.md`);
            const target = reviewTarget ? validateQueuedReview({ item: current, state: fresh.state, events: fresh.events, org, repo }) : null;
            writeFileAtomic(brief, target ? reviewQueueBrief(current) : `# ${current.title}\n\n${current.accept.join('\n')}\n\nWork from the existing item/run brief and accepted directions. Self-land OWN source and hand its immutable landed tuple/evidence to record queue-review; never start a parallel settle/lane review. Preserve STOP/HOLD, claims and native guards. Escalate judgment to ${to} through the existing native inbox.\n`, 0o600);
            return JSON.parse(cli('dispatch/dispatch.mjs', [item.id, '--repo', repo, '--org', org, '--lane', `${target ? 'review' : 'line'}-${item.id.toLowerCase()}-${current.runs.length + 1}`, '--route', route, '--brief', brief, ...(target ? ['--base', target.head] : []),'--detach']));
          },undefined,undefined,Boolean(retryAdmission));
          // Each original detached journal reserves admission before returning.
          // The next candidate gets a fresh native count; no launch is replayed.
          if (dispatched?.state === 'complete') starts++;
        } catch (e) {
          if(e.code==='REVIEW_CUTOFF'){timings.historical_review_skipped++;continue;}
          if(e.code==='DISPATCH_REVIEW_CAP'){log({action:'capacity-held',code:e.code,reason:e.message});note(`capacity:${e.code}`,e.message);continue;}
          if (['DISPATCH_SESSION_CAP', 'DISPATCH_UNLANDED_CAP'].includes(e.code)) { log({ action: 'capacity-held', code: e.code, reason: e.message }); note(`capacity:${e.code}`, e.message); break; }
          note(`dispatch:${item.id}`, e.message);
        }
      }
      checkpointNotices();
      if(performance.now()-passStarted>600000)note('long-pass','line pass exceeded ten minutes',{},true);
      checkpointNotices();const duration_ms = performance.now() - passStarted;
      log({ action: 'pass-complete', starts,timing: { ...timings, duration_ms, other_scan_and_guard_ms: Math.max(0, duration_ms - timings.effect_command_ms - timings.record_snapshot_ms) } });
      return { result: 'pass-complete', directory };
    } finally { try{checkpointNotices?.();}finally{try{heartbeat('finished');}finally{release();}} }
  }
  return { pass, directory, log };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, usage: 'line-service.mjs --once --repo CANONICAL --org RECORD --to SUPERVISOR', options: {
    once: { type: 'boolean' },digest:{type:'boolean'},since:{type:'string'}, repo: { type: 'string' }, org: { type: 'string' }, to: { type: 'string' }, herdr: { type: 'string' },
  } });
  if(values.digest){if(!values.org)throw Error('--digest needs --org RECORD');process.stdout.write(JSON.stringify(morningDigest({events:loadEvents(values.org).events,since:values.since}),null,2)+'\n');return;}
  if (!values.once || !values.repo) throw Error('use --once --repo CANONICAL; launchd owns the schedule');
  const source = gitProject(sourceRoot);
  if (source.checkout !== source.canonical) throw Error('live line service must use the canonical development source');
  const service = createLineService(values);
  const result = service.pass();
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (isMain(import.meta.url)) main().catch(e => { process.stderr.write(`line-service: ${e.message}\n`); process.exitCode = 1; });
