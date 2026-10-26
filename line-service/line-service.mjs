#!/usr/bin/env node
// One model-free pass. launchd supplies the schedule, existing CLIs own effects.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, loadEvents, writeFileAtomic } from '../lib/store.mjs';
import { fold, itemStatus, sortItems } from '../lib/state.mjs';
import { effectiveWorkerIdentity, workerReceipt } from '../lib/worker-identity.mjs';
import { readOwnedRun, requireController, assertOwner } from '../lib/run-owner.mjs';
import { loadDiscoveredRoutes, resolveLaunchRoute, selectRoute } from '../lanes/routes.mjs';
import { checkSessionCap } from '../dispatch/session-cap.mjs';
import { checkUnlandedCap } from '../dispatch/unlanded-cap.mjs';
import { noticeLock } from '../supervisor/notice-lock.mjs';
import { readCloseoutEntries } from '../lib/closeout.mjs';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { reviewAttempt, bindReviewTarget } from './review.mjs';
import { queueConsumer, isQueueReview, validateQueuedReview, reviewQueueBrief, reviewQueueRoute } from './review-queue.mjs';
import { roleIs } from '../lib/roles.mjs';
import { recordLineNotice,canonicalFailure } from './record-inbox.mjs';
import { enqueueNamedDecision } from './decision-wake.mjs';
import { serviceCutoff,postCutoffLanding } from './cutoff.mjs';
import { canonical } from '../messages/schema.mjs';
export { reviewAttempt } from './review.mjs';

export const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
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

export function createLineService({ repo, org, to, herdr = 'herdr', env = process.env, command = spawnSync,
  recordNotice = recordLineNotice, wakeDecision = enqueueNamedDecision, capacity, identify = gitProject, now = () => new Date().toISOString() }) {
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
    try { r = command(exe, args, { cwd: repo, env: childEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
    finally { if (timings) timings.effect_command_ms += performance.now() - started; }
    if (r.error || r.status !== 0) throw Object.assign(Error((r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim()), { receipt: { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr } });
    return receipt ? { status: r.status, signal: r.signal ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } : r.stdout?.trim() ?? '';
  };
  const native = args => JSON.parse(invoke(herdr, args)).result;
  const cli = (file, args, options) => invoke(process.execPath, [path.join(sourceRoot, file), ...args], options);
  const sourceGit = (cwd, args) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
    env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
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
  const guardRun = (id, { reported = true } = {}) => {
    const snapshot = observe(), run = snapshot.state.runs.get(id), item = run && snapshot.state.items.get(run.item);
    if (!run || run.abandoned || !item || item.runs.at(-1) !== id) throw Error('unknown, abandoned or superseded run');
    requireController(readOwnedRun(org, id), 'brain');
    if (identify(run.workspace).identity !== project.identity) throw Error('foreign run workspace');
    if (reported && !run.report) throw Error('report not ingested');
    return { ...snapshot, run, item };
  };
  function pass() {
    const release = noticeLock(path.join(directory, 'pass.lock'),{recover:false});
    let effects;
    try {
      const passStarted = performance.now();
      timings = { snapshots: 0, record_snapshot_ms: 0, effect_command_ms: 0, historical_intake_skipped: 0, historical_review_skipped: 0, closeout_retained: 0 };
      effects = read(journal) ?? { identity: project.identity, org, actions: {}, notices: {} };
      if (effects.identity !== project.identity || effects.org !== org) throw Error('effect journal project binding changed');
      const save = () => writeFileAtomic(journal, JSON.stringify(effects, null, 2) + '\n', 0o600);
      let snapshot, stale = true, reviewCache = new Map();
      const current = () => { if (stale) { snapshot = observe(); stale = false; reviewCache = new Map(); } return snapshot; };
      const note = (boundary, reason, scope = {}) => {
        const normalized=canonicalFailure(reason),key=createHash('sha256').update(canonical([boundary,normalized,scope])).digest('hex');
        log({ action: 'hold', boundary, reason, canonical_key:key,scope });
        effects.record_notices??={};
        const prior=effects.record_notices[key],entry=effects.record_notices[key]=prior??{first_at:now(),reason:normalized,scope,state:'recording',id:`line-record-${key}`,count:0};
        entry.count++;entry.last_at=now();save();
        if(entry.state==='recorded')return;
        try {
          const receipt=recordNotice({repo,org,id:entry.id,boundary,reason:entry.reason,scope:entry.scope,first_at:entry.first_at,audit:path.join(directory,'passes.jsonl'),counts:`${journal}#record_notices/${key}`,env:childEnv});
          entry.state='recorded';entry.record={id:receipt.id,state:receipt.state};save();
        } catch (e) { entry.state='record-uncertain';entry.error=e.message;save();log({ action:'record-inbox-held',canonical_key:key,error:e.message }); }
      };
      const effect = (key, run, binding, operation) => {
        if (effects.actions[key]) {
          const prior = effects.actions[key];
          log({ action: 'effect-retained', key, state: prior.state });
          if (prior.state !== 'complete') note(key, prior.error ?? 'prior failed/uncertain effect retained; inspect its existing receipt, do not replay');
          return;
        }
        observe();
        stale = true;
        const entry = effects.actions[key] = { state: 'started', at: now(), ...(binding ? { review_target: binding, review_operation: operation } : {}) }; save();
        try {
          entry.result = run(); entry.state = 'complete';
          if (['escalate', 'failed', 'stopped', 'judge_promotion'].includes(entry.result?.result)) {
            entry.state = 'held'; entry.error = entry.result.reason ?? entry.result.result;
          }
          const deferred = entry.result?.evaluated?.filter(row => !row.completed);
          if (deferred?.length) { entry.state = 'held'; entry.error = deferred.map(row => `${row.run}: ${row.reason}`).join('; '); }
        }
        catch (e) { entry.state = 'held'; entry.error = e.message; entry.receipt = e.receipt; }
        entry.finished_at = now(); save(); log({ action: 'effect', key, ...entry });
        if (entry.state === 'held') note(key, entry.error);
        return entry;
      };
      log({ action: 'pass-start', pid: process.pid, identity: project.identity, source: sourceRoot,source_head:sourceGit(sourceRoot,['rev-parse','HEAD']) });
      try { snapshot = current(); } catch (e) { log({ action: 'pass-held', reason: e.message }); return { held: e.message, directory }; }
      for (const item of snapshot.state.items.values()) {
        if (item.closed) { timings.historical_intake_skipped++; continue; }
        const run = snapshot.state.runs.get(item.runs.at(-1));
        if (!run || run.abandoned || run.report || !run.workspace || !run.report_path || !fs.existsSync(run.report_path) || !fs.existsSync(run.workspace)) continue;
        try {
          if (identify(run.workspace).identity !== project.identity) continue;
          if (effects.actions[`ingest:${run.id}`]) continue;
          const bound = guardRun(run.id, { reported: false }), w = effectiveWorkerIdentity(bound.run, bound.state), receipt = workerReceipt(bound.run, bound.state);
          if (!receipt || w.identity_conflict || !w.agent || !w.terminal_id || ['agent', 'pane', 'worker_workspace', 'terminal_id'].some(k => receipt[k] !== w[k])) throw Error('native worker receipt missing or conflicted');
          const a = native(['agent', 'get', w.agent])?.agent;
          if (!a || a.name !== w.agent || a.pane_id !== w.pane || a.workspace_id !== w.worker_workspace || a.terminal_id !== w.terminal_id ||
              (w.agent_session_id && a.agent_session?.value !== w.agent_session_id) || fs.realpathSync(a.cwd) !== fs.realpathSync(run.workspace)) throw Error('native worker identity differs from its recorded receipt');
          if (!['idle', 'done'].includes(a.agent_status)) { log({ action: 'report-in-flight', run: run.id }); continue; }
          effect(`ingest:${run.id}`, () => { guardRun(run.id, { reported: false }); return cli('bin/org.mjs', ['ingest', run.report_path, '--run', run.id, '--if-current-run', run.id]); });
        } catch (e) { note(`intake:${run.id}`, e.message); }
      }
      snapshot = current();
      let cutoff;
      try{cutoff=serviceCutoff(snapshot.events,{repo,org,identity:project.identity});}
      catch(e){note('review-cutoff',e.message);}
      for (const item of snapshot.state.items.values()) {
        const run = snapshot.state.runs.get(item.runs.at(-1));
        if (!run?.report || run.abandoned || !run.workspace) continue;
        if (item.closed || !run.owner || run.owner.legacy || run.owner.controller !== 'brain') { timings.historical_review_skipped++; continue; }
        if (!fs.existsSync(run.workspace)) { timings.historical_review_skipped++; continue; }
        if (!roleIs(item, 'ENG')) continue; // Reviews never generate their own review.
        if (roleIs(snapshot.state.items.get(item.parent), 'REV')) continue; // Linked formal correction, no re-review chain.
        if(!cutoff){timings.historical_review_skipped++;continue;}
        let target;
        try{
          target=bindReviewTarget({item,run,events:snapshot.events,repo,org,identity:project.identity});
          postCutoffLanding({events:snapshot.events,repo,org,identity:project.identity,head:target.head});
        }catch(e){timings.historical_review_skipped++;continue;}
        let reviewLock;
        try {
          reviewLock = noticeLock(path.join(directory, `review-item-${digest(item.id)}.lock`),{recover:false});
          const attempt = reviewAttempt(item, { org, identity: project.identity, events: snapshot.events, state: snapshot.state, repo, effects, cache: reviewCache });
          if (attempt) { log({ action: 'review-retained', item: item.id, reason: attempt }); continue; }
          if (identify(run.workspace).identity !== project.identity) continue;
          if (run.report.outcome !== 'done' || run.report.blockers?.length || (run.report.questions ?? run.report.extra?.questions)?.length) note(`report:${run.id}:${run.report.sha256}`, 'worker report needs supervisor judgment');
          if (reserved(item) || item.meta.hold || item.meta.held) { note(`review:${item.id}`, 'held or reserved item needs judgment'); continue; }
          const consumer = queueConsumer({ run, env: childEnv });
          effect(`review:${item.id}`, () => {
            guardRun(run.id);
            const fresh = observe();
            const changed = reviewAttempt(fresh.state.items.get(item.id), { org, identity: project.identity, events: fresh.events, state: fresh.state, repo, effects,
              ignoreService: { file: journal, key: `review:${item.id}`, target, operation: 'record-queue' } });
            if (changed) throw Error(`review inventory changed before launch: ${changed}`);
            if (queueConsumer({ run: fresh.state.runs.get(run.id), env: childEnv }) !== consumer) throw Error('actual queue consumer changed before creation');
            const checked = bindReviewTarget({ item: fresh.state.items.get(item.id), run: fresh.state.runs.get(run.id), events: fresh.events, repo, org, identity: project.identity });
            if (JSON.stringify(checked) !== JSON.stringify(target)) throw Error('immutable review target/evidence changed before capture');
            return JSON.parse(cli('bin/org.mjs', ['queue-review', run.id, '--head', target.head, '--base', target.base]));
          }, target, 'record-queue');
        } catch (e) { if(e.code==='REVIEW_CUTOFF')timings.historical_review_skipped++;else note(`review:${item.id}`, `T2 automatic review held: ${e.message}`,{item:item.id,run:run.id,report:run.report.sha256}); }
        finally { reviewLock?.(); }
      }
      // Source completion releases the real admission slot independently of
      // review verdicts and physical cleanup. The record owns the conditional
      // current-run/report/blocker/reopen transaction; there is no override.
      snapshot = current();
      for (const item of snapshot.state.items.values()) {
        const run = snapshot.state.runs.get(item.runs.at(-1));
        if (item.closed || run?.report?.outcome !== 'done' || run.abandoned || !run.workspace || !fs.existsSync(run.workspace) ||
            !run.owner || run.owner.legacy || run.owner.controller !== 'brain') continue;
        try {
          if (identify(run.workspace).identity !== project.identity) continue;
          if (reserved(item) || item.meta.hold || item.meta.held || run.report.blockers?.length || (run.report.questions ?? run.report.extra?.questions)?.length) {
            note(`source-complete:${run.id}`, 'T2 source completion needs supervisor judgment: held/reserved item or report blockers/questions; no explicit-judgment override used'); continue;
          }
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
          });
        } catch (e) { note(`source-complete:${run.id}`, `T2 source completion needs supervisor judgment: ${e.message}`); }
      }
      try {
        const observed = current(), evaluations = new Map(observed.events.filter(e => e.type === 'closeout.evaluated').map(e => [e.key, e]));
        const entries = readCloseoutEntries(project.identity).filter(e => {
          if (e.org !== org || e.project !== repo) return false;
          const prior = evaluations.get(e.key);
          if (prior) timings.closeout_retained++;
          if (!prior && !fs.existsSync(e.cwd)) return false;
          return !prior; // Never automatically retry a named failed/native effect.
        });
        if (entries.length) {
          const revisions = observed.events.filter(e => ['closeout.retry', 'closeout.handoff', 'closeout.code-handoff', 'closeout.migrated'].includes(e.type)).at(-1)?.seq;
          effect(`closeout:${digest([entries, revisions])}`, () => JSON.parse(cli('supervisor/closeout.mjs', ['drain', '--repo', repo, '--org', org, '--keys', JSON.stringify(entries.map(e => e.key)), '--no-restart'])));
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
      const { config } = loadDiscoveredRoutes({ cwd: repo, env: childEnv });
      for (const item of sortItems([...snapshot.state.items.values()].filter(item => !item.closed && item.kind !== 'goal')).sort((a, b) => Number(isQueueReview(b)) - Number(isQueueReview(a)))) {
        if (item.kind === 'goal' || item.closed || itemStatus(snapshot.state, item.id) !== 'ready') continue;
        if(roleIs(item,'REV')&&(!cutoff||item.created.seq<=cutoff.seq)){timings.historical_review_skipped++;continue;}
        if (roleIs(item, 'REV') && !isQueueReview(item)) { note(`dispatch:${item.id}`, 'T2 legacy/manual review queue binding UNKNOWN; retain existing owner/attempt'); continue; }
        if (reserved(item) || item.meta.hold || item.meta.held) { note(`dispatch:${item.id}`, 'held or reserved ready item needs judgment'); continue; }
        try {
          const key = `dispatch:${item.id}:${item.runs.at(-1) ?? item.created.seq}`;
          if (effects.actions[key]) { log({ action: 'dispatch-retained', key, state: effects.actions[key].state }); continue; }
          const reviewTarget = isQueueReview(item) ? validateQueuedReview({ item, state: snapshot.state, events: snapshot.events, org, repo }) : null;
          const route = reviewTarget ? reviewQueueRoute(config) : routeFor(item, config);
          const count = capacity ?? (() => checkSessionCap({ config, org, common: project.identity,
            agent: name => native(['agent', 'get', name]).agent,
            processInfo: pane => native(['pane', 'process-info', '--pane', pane]).process_info }));
          const occupancy = count(); log({ action: 'capacity', ...occupancy });
          checkUnlandedCap({ config, org, common: project.identity, request: { item: item.id } });
          const dispatched = effect(key, () => {
            const fresh = observe(), current = fresh.state.items.get(item.id);
            if (!current || current.closed || itemStatus(fresh.state, item.id) !== 'ready' || reserved(current) || current.meta.hold || current.meta.held || (reviewTarget ? reviewQueueRoute(config) : routeFor(current, config)) !== route) throw Error('dispatch readiness or route changed');
            const brief = path.join(directory, `${digest(key)}.ask.md`);
            const target = reviewTarget ? validateQueuedReview({ item: current, state: fresh.state, events: fresh.events, org, repo }) : null;
            writeFileAtomic(brief, target ? reviewQueueBrief(current) : `# ${current.title}\n\n${current.accept.join('\n')}\n\nWork from the existing item/run brief and accepted directions. Self-land OWN source and hand its immutable landed tuple/evidence to record queue-review; never start a parallel settle/lane review. Preserve STOP/HOLD, claims and native guards. Escalate judgment to ${to} through the existing native inbox.\n`, 0o600);
            return JSON.parse(cli('dispatch/dispatch.mjs', [item.id, '--repo', repo, '--org', org, '--lane', `${target ? 'review' : 'line'}-${item.id.toLowerCase()}-${current.runs.length + 1}`, '--route', route, '--brief', brief, ...(target ? ['--base', target.head] : [])]));
          });
          // Fresh occupancy and readiness on the next scheduled pass. Dispatch
          // performs the authoritative, locked applicable-cap admission itself.
          if (dispatched?.state === 'complete') break;
        } catch (e) {
          if(e.code==='REVIEW_CUTOFF'){timings.historical_review_skipped++;continue;}
          if (['DISPATCH_SESSION_CAP', 'DISPATCH_UNLANDED_CAP'].includes(e.code)) { log({ action: 'capacity-held', code: e.code, reason: e.message }); note(`capacity:${e.code}`, e.message); break; }
          note(`dispatch:${item.id}`, e.message);
        }
      }
      const duration_ms = performance.now() - passStarted;
      log({ action: 'pass-complete', timing: { ...timings, duration_ms, other_scan_and_guard_ms: Math.max(0, duration_ms - timings.effect_command_ms - timings.record_snapshot_ms) } });
      return { result: 'pass-complete', directory };
    } finally { release(); }
  }
  return { pass, directory, log };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, usage: 'line-service.mjs --once --repo CANONICAL --org RECORD --to SUPERVISOR', options: {
    once: { type: 'boolean' }, repo: { type: 'string' }, org: { type: 'string' }, to: { type: 'string' }, herdr: { type: 'string' },
  } });
  if (!values.once || !values.repo) throw Error('use --once --repo CANONICAL; launchd owns the schedule');
  const source = gitProject(sourceRoot);
  if (source.checkout !== source.canonical) throw Error('live line service must use the canonical development source');
  const service = createLineService(values);
  const result = service.pass();
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (isMain(import.meta.url)) main().catch(e => { process.stderr.write(`line-service: ${e.message}\n`); process.exitCode = 1; });
