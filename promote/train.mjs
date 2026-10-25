// Native Git merge train. The durable plan owns scratch work only; lane tips
// are authorization inputs and remain untouched until integration succeeds.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic, readPlainFile } from '../lib/files.mjs';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { captureCompletionMember, accountUncapturedMember, recordFor } from './completion.mjs';
import { operatorWaivedGate } from '../lib/validation-declaration.mjs';
import { createHash } from 'node:crypto';
import { validateTree, validationEnvironment } from '../lanes/validation.mjs';
import { withPromotionGuard, withPromotionGuards } from './guard.mjs';
import { guardPromotionJob } from '../lib/run-owner-guard.mjs';
import { resolveGateProfile, checkCompetingProcesses, HOST_ENV } from './gate-profile.mjs';

import { probeNativeGate } from './native-context.mjs';
import { gateHistoryKey } from '../test-slot/limits.mjs';
import { changedPaths, plannedCommand, noRetryCommand } from './test-plan.mjs';
import { canonicalTestPlan } from '../settle/test-plan.mjs';
import { shadowSelection, completeShadow } from './selector.mjs';
import { readReceiptDeclaration, restrictEnvironment, excludedAdditions, exactIdentity, explainMiss, requireExactPlan, selectionUnknown } from '../lanes/exact-validation.mjs';

const replacement = fileURLToPath(new URL('../settle/replace-lane-head.mjs', import.meta.url));

export { verifyTrainResult } from './evidence.mjs';
export async function runTrain({ file, canonical, identity, main, prepare, validation }) {
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (plan.schema !== 'promotion-train/v1' || plan.identity !== identity || !Array.isArray(plan.jobs)) throw new Error('invalid train receipt');
  const save = () => writeFileAtomic(file, JSON.stringify(plan, null, 2) + '\n', 0o600);
  const profile = validation.landing_waiver ? null : resolveGateProfile(canonical);
  if (profile && process.env[HOST_ENV] !== profile.fingerprint) throw new Error('declared gate profile requires the promotion queue host adapter; enqueue with promote/promote.mjs');
  const env = profile?.env ?? validationEnvironment();
  // Unconfigured trains also queue for the slot with a cap. Explicit host
  // settings, including immediate refusal, retain their existing precedence.
  env.MONITOR_TEST_SLOT_WAIT_SECONDS ??= env.BCH_CLOAK_TEST_SLOT_WAIT_SECONDS ?? '7200';
  if (profile) {
    prepare = [...prepare, ...profile.prepare];
    validation = { ...validation, environment: `${validation.environment}\nprofile:${profile.fingerprint}` };
    checkCompetingProcesses(profile);
  }
  const run = (args, cwd = canonical, extra = {}) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024, ...extra });
  const git = (args, cwd, extra) => {
    const r = run(args, cwd, extra);
    if (r.error || r.status !== 0) throw new Error((r.stderr || r.error?.message || `Git exit ${r.status}`).trim());
    return r.stdout.trim();
  };
  const clean = cwd => { if (git(['status', '--porcelain=v1', '--untracked-files=all'], cwd)) throw new Error(`worktree is not clean: ${cwd}`); };
  const canonicalCheck = () => {
    clean(canonical);
    if (git(['symbolic-ref', '--short', 'HEAD']) !== main) throw new Error(`canonical checkout must be on ${main}`);
  };
  const capture = job => {
    // Reject a foreign record before reading its run or claim, preserving the
    // canonical-record refusal even when that record has no matching run.
    if (job.run) recordFor(canonical, job.org);
    guardPromotionJob(job);
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(job.topic)) throw new Error('invalid train lane topic');
    const entry = git(['worktree', 'list', '--porcelain']).split('\n\n').find(e => e.split('\n').includes(`branch refs/heads/lane/${job.topic}`));
    const workspace = entry?.split('\n').find(l => l.startsWith('worktree '))?.slice(9);
    if (!workspace) throw new Error(`no worktree for lane/${job.topic}`);
    if (fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], workspace)) !== identity) throw new Error('lane Git identity changed');
    if (git(['symbolic-ref', '--short', 'HEAD'], workspace) !== `lane/${job.topic}`) throw new Error('lane branch changed');
    clean(workspace);
    const head = git(['rev-parse', 'HEAD'], workspace);
    if (job.sourceHead && job.sourceHead !== head) throw new Error('lane tip changed since train capture');
    const captured = { ...job, workspace, sourceHead: head };
    withPromotionGuard({ canonical, identity, ...captured });
    if (plan.completion && !plan.completion.git_only) {
      const excluded = plan.completion.jobs.filter(b => b.job !== job.id && plan.results[b.job] && plan.results[b.job].outcome !== 'promoted')
        .map(b => ({ item: b.item, run: b.run, superseded: [], disposition: 'historical',
          reason: plan.results[b.job].reason || plan.results[b.job].outcome,
          next_action: 'Inspect the retained excluded lane before authorizing a new request.' }));
      captureCompletionMember({ canonical, identity, job, prepared: plan.completion, excluded });
    }
    if (job.run) {
      const at = fold(loadEvents(job.org).events).runs.get(job.run)?.report?.at;
      if (at) captured.report_at = at;
    }
    return captured;
  };
  const guards = jobs => jobs.map(job => ({ canonical, identity, ...job, expectedHead: job.sourceHead,
    completionExpected: plan.completion?.jobs?.find(b => b.job === job.id)?.expected }));
  const result = (job, value) => {
    if (['refused', 'timeout'].includes(value.outcome)) accountUncapturedMember(plan, job);
    plan.results[job.id] = value; save();
  };
  // Batch phase is live telemetry; attempt.phase remains the recovery checkpoint.
  // In particular, an in-flight gate still resumes from its prepared candidate.
  const phase = value => { plan.phase = value; save(); };
  // Capture completion inputs before any gate or integration, never on recovery
  // of a legacy successful train that lacked this evidence.
  if (!plan.completion && !plan.attempts?.length) plan.completion = plan.jobs.every(j => !j.run)
    ? { version: 1, git_only: true }
    : { version: 1, identity, canonical, branch: main, base: git(['rev-parse', main]), jobs: [], refused: [] };
  plan.started_at ??= new Date().toISOString();
  plan.external_lock_required ??= Boolean(profile?.externalLock);
  plan.results ??= {}; plan.attempts ??= []; plan.groups ??= [plan.jobs.map(j => j.id)];
  // A caller can die while its slot child is running. Recover the durable
  // sidecar's original grant before replacing that attempt's gate on resume.
  for (const attempt of plan.attempts) saveSlotGrant(attempt);
  save();
  const canonicalReady = () => {
    try { canonicalCheck(); return true; }
    catch (error) {
      for (const job of plan.jobs.filter(j => !plan.results[j.id])) result(job, { outcome: 'refused', reason: error.message, batch: plan.id });
      plan.groups = []; save(); return false;
    }
  };
  // A persisted integrated checkpoint never gates or fast-forwards twice.
  const finishIntegrated = attempt => {
    if (!['integrated', 'complete'].includes(attempt.phase)) throw new Error('train bookkeeping requires an integrated checkpoint');
    phase('closing');
    if (git(['merge-base', attempt.tip, main]) !== attempt.tip) throw new Error('integrated train tip is no longer on main');
    for (const job of attempt.jobs) {
      if (plan.results[job.id]?.outcome === 'promoted') continue;
      const tip = attempt.tips[job.id], warnings = [];
      try {
        const current = git(['rev-parse', 'HEAD'], job.workspace);
        if (current !== tip) {
          if (current !== job.sourceHead) throw new Error('lane moved after integration; retained for inspection');
          const r = spawnSync(process.execPath, [replacement, JSON.stringify({ workspace: job.workspace, repo: canonical,
            common: identity, branch: `refs/heads/lane/${job.topic}`, from: job.sourceHead, to: tip,
            main, mainHead: git(['rev-parse', main]) })], { env, encoding: 'utf8' });
          if (r.error || r.status !== 0) throw new Error(r.stderr || r.error?.message || 'lane replacement refused');
        }
      } catch (error) { warnings.push(error.message.trim()); }
      const integratedAt = attempt.integrated_at;
      result(job, { outcome: 'promoted', tip, source_head: job.sourceHead, workspace: job.workspace, warnings,
        ...(warnings.length ? { replacement_pending: true } : {}),
        reason: warnings.length ? warnings.join('; ') : (operatorWaivedGate(attempt.gate) ? 'operator-waived fast-forward; checks deferred to final release' : 'green batch fast-forward'), batch: plan.id,
        gate: attempt.gate, integrated_at: integratedAt, report_at: job.report_at ?? null,
        report_to_main_s: job.report_at ? Math.max(0, (Date.parse(integratedAt) - Date.parse(job.report_at)) / 1000) : null });
    }
    attempt.phase = 'complete'; save();
  };
  for (const attempt of plan.attempts) {
    if (['validated', 'waived'].includes(attempt.phase)) {
      const integrated = run(['merge-base', '--is-ancestor', attempt.tip, main]);
      if (integrated.error || ![0, 1].includes(integrated.status)) throw new Error(integrated.stderr || integrated.error?.message || 'train ancestry proof failed');
      if (integrated.status === 0) {
        // A lost FF response remains adoptable after later batches advance main.
        attempt.phase = 'integrated'; attempt.integrated_at ??= new Date().toISOString(); save();
      }
    }
    if (attempt.phase === 'integrated') finishIntegrated(attempt);
  }
  const prepareAttempt = ids => {
    phase('preparing');
    if (!canonicalReady()) return null;
    let attempt = plan.attempts.findLast(a => ['prepared', 'validated', 'waived'].includes(a.phase) && JSON.stringify(a.ids) === JSON.stringify(ids));
    if (attempt && git(['rev-parse', main]) !== attempt.base) {
      attempt.phase = 'stale'; attempt.error = 'main moved; replan from the current integration branch'; save();
      attempt = null;
    }
    if (!attempt) {
      const jobs = [];
      for (const id of ids) {
        const job = plan.jobs.find(j => j.id === id);
        try { jobs.push(capture(job)); }
        catch (error) {
          result(job, { outcome: 'refused', reason: error.message, ...(error.code ? { code: error.code } : {}), batch: plan.id });
        }
      }
      if (!jobs.length) return null;
      const base = git(['rev-parse', main]);
      const branch = `promote-train/${randomUUID()}`;
      const scratch = path.join(path.dirname(file), `scratch-${plan.attempts.length}`);
      attempt = { ids: jobs.map(j => j.id), jobs, base, branch, scratch, tips: {}, phase: 'preparing' };
      plan.attempts.push(attempt); save();
      git(['worktree', 'add', '-b', branch, scratch, base]);
      phase('rebasing');
      let tip = base;
      const kept = [];
      for (const job of jobs) {
        try {
          const fork = git(['merge-base', base, job.sourceHead]);
          if (git(['rev-list', '--merges', `${fork}..${job.sourceHead}`])) throw new Error('lane contains merge commits; replay refused');
          // Named external merge drivers cannot be an independent tree oracle.
          const drivers = run(['config', '--get-regexp', '^merge\\..*\\.(driver|recursive)$']);
          if (drivers.status === 0 && drivers.stdout.trim()) throw new Error('custom merge drivers prevent proved train replay');
          const merged = run(['merge-tree', '--write-tree', tip, job.sourceHead]);
          if (merged.error || merged.status !== 0) throw new Error(`lane does not rebase cleanly: ${merged.stdout}\n${merged.stderr}`);
          const expected = merged.stdout.trim().split('\n')[0];
          if (git(['merge-base', tip, job.sourceHead]) === tip) git(['reset', '--hard', job.sourceHead], scratch);
          else {
            git(['reset', '--hard', job.sourceHead], scratch);
            try { git(['rebase', '--no-fork-point', '--no-autostash', '--no-update-refs', '--no-rebase-merges',
              '--no-autosquash', '--reapply-cherry-picks', '--empty=keep', '--onto', tip, fork], scratch); }
            catch (error) {
              const conflicts = git(['diff', '--name-only', '--diff-filter=U'], scratch);
              const aborted = run(['rebase', '--abort'], scratch);
              if (aborted.error || aborted.status !== 0) throw new Error(`scratch rebase recovery uncertain: ${scratch}`);
              throw new Error(`rebase replay onto ${main} failed; conflicts in: ${conflicts || error.message}; lane kept intact`);
            }
          }
          const replayed = git(['rev-parse', 'HEAD'], scratch);
          if (git(['rev-parse', 'HEAD^{tree}'], scratch) !== expected || git(['merge-base', tip, replayed]) !== tip) throw new Error('replayed tree does not preserve the reviewed diff');
          attempt.tips[job.id] = replayed; kept.push(job); tip = replayed;
        } catch (error) {
          process.stdout.write(`lane/${job.topic}: ${error.message}\n`);
          result(job, { outcome: 'refused', reason: `rebase replay refused: ${error.message}`, batch: plan.id });
          git(['reset', '--hard', tip], scratch);
        }
      }
      attempt.jobs = kept; attempt.ids = kept.map(j => j.id); attempt.tip = tip;
      attempt.phase = 'prepared'; save();
      if (!kept.length) { attempt.phase = 'complete'; save(); return null; }
    }
    if (git(['rev-parse', main]) !== attempt.base) {
      attempt.phase = 'stale'; attempt.error = 'main moved during preparation; replan'; save(); return null;
    }
    let invalid = false;
    for (const job of attempt.jobs) {
      try { capture(job); }
      catch (error) { result(job, { outcome: 'refused', reason: error.message, ...(error.code ? { code: error.code } : {}), batch: plan.id }); invalid = true; }
    }
    if (invalid) { attempt.phase = 'invalid'; save(); return null; }
    clean(attempt.scratch);
    if (git(['rev-parse', 'HEAD'], attempt.scratch) !== attempt.tip || git(['symbolic-ref', '--short', 'HEAD'], attempt.scratch) !== attempt.branch) throw new Error('train scratch changed');
    return attempt;
  };
  const validateAttempt = attempt => {
    try {
      if (validation.landing_waiver) {
        plan.native_context = { outcome: 'not-required', executed: false, authority: validation.landing_waiver,
          reason: 'No test workload; actual Git/source/claim/lock/FF guards authorize integration, not test capabilities' };
        clean(attempt.scratch);
        if (git(['rev-parse', 'HEAD'], attempt.scratch) !== attempt.tip) throw Error('waived train tip changed');
        const log = file + `.${attempt.ids.join('-')}.waiver.log`;
        const text = `Operator waiver ${validation.landing_waiver}: no preparation, planner, tests or review gate executed before main. Full checks deferred to final release.\n`;
        if (!fs.existsSync(log)) fs.writeFileSync(log, text, { flag: 'wx', mode: 0o600 });
        if (fs.readFileSync(log, 'utf8') !== text) throw Error('operator waiver evidence changed');
        attempt.gate = { schema: 'operator-landing-waiver/v1', authority: validation.landing_waiver,
          outcome: 'waived', executed: false, exit_code: null, signal: null, head: attempt.tip,
          tree: git(['rev-parse', 'HEAD^{tree}'], attempt.scratch), log,
          log_hash: createHash('sha256').update(JSON.stringify(text)).digest('hex') };
        process.stdout.write(text);
        attempt.phase = 'waived'; save(); return true;
      }
      plan.native_context = probeNativeGate(); save();
      if (!plan.native_context.ok) throw Object.assign(new Error(plan.native_context.reason), { code: plan.native_context.code });
      const declaration = readReceiptDeclaration({ repo: canonical, base: attempt.base });
      const exact = declaration ? { base: attempt.base, declaration } : undefined;
      const gateEnv = declaration ? restrictEnvironment(env, declaration) : env;
      if (exact && (!validation.promotion_tests || validation.tiers.promotion.source === 'env')) requireExactPlan(validation, null);
      if (attempt.prepare) (attempt.prepare_history ??= []).push(attempt.prepare);
      attempt.prepare = { started_at: new Date().toISOString() };
      phase('preparing');
      for (const step of prepare) {
        if (step.unless !== undefined && fs.existsSync(path.join(attempt.scratch, step.unless))) continue;
        const r = spawnSync(step.run, { cwd: attempt.scratch, env: gateEnv, shell: '/bin/sh', stdio: 'inherit' });
        if (r.error || r.status !== 0) {
          attempt.prepare.failure = { exit_code: r.status, signal: r.signal ?? null, error: r.error?.code ?? null };
          throw new Error(`train preparation failed: ${step.run}`);
        }
      }
      if (git(['rev-parse', 'HEAD'], attempt.scratch) !== attempt.tip || git(['symbolic-ref', '--short', 'HEAD'], attempt.scratch) !== attempt.branch) throw new Error('train scratch tip or branch changed during preparation');
      const excluded = new Set(exact ? excludedAdditions({ repo: attempt.scratch, base: attempt.base, head: attempt.tip, declaration }) : []);
      const changed = [...new Set(attempt.jobs.flatMap(job => changedPaths(attempt.scratch, git(['merge-base', attempt.base, job.sourceHead]), job.sourceHead)))].filter(name => !excluded.has(name));
      // Coverage comes from the captured base and its imports; the candidate
      // supplies only the tree being inspected and the supplemental test run.
      const required = [...new Set(attempt.jobs.flatMap(job => job.requiredTests ?? []))].sort();
      try {
        attempt.test_plan = canonicalTestPlan({ repo: canonical, base: attempt.base, cwd: attempt.scratch,
          planner: validation.promotion_tests, changed, required, baseCommand: validation.tiers.promotion.command, env: gateEnv });
        if (exact) requireExactPlan(validation, attempt.test_plan);
      } catch (error) { throw exact && error.code !== 'SELECTION_UNKNOWN' ? selectionUnknown(error.message) : error; }
      const covered = [...(attempt.test_plan?.files ?? []), ...(attempt.test_plan?.covered ?? [])];
      if (attempt.jobs.some(job => (job.requiredTests ?? []).some(file => !covered.includes(file)))) throw Error('promotion test plan no longer covers the bound deferred test evidence');
      const command = plannedCommand(validation.tiers.promotion.command, attempt.test_plan);
      if (attempt.selector_shadow) (attempt.selector_shadow_history ??= []).push(attempt.selector_shadow);
      attempt.selector_shadow = shadowSelection({ repo: canonical, base: attempt.base, head: attempt.tip, cwd: attempt.scratch, env: gateEnv });
      if (exact) {
        const current = exactIdentity({ cwd: attempt.scratch, common: identity, base: attempt.base, commands: [command], prepare,
          environment: validation.environment, env: gateEnv, declaration });
        const pointers = attempt.jobs.map(job => path.join(job.workspace, '.lane/gate.json'));
        let previous, pointer;
        try {
          previous = JSON.parse(readPlainFile(pointers[0]));
          pointer = previous?.exact?.identity ? 'exact' : 'legacy';
        } catch (error) { pointer = error.code === 'ENOENT' ? 'missing' : 'unreadable'; }
        const single = attempt.jobs.length === 1;
        attempt.receipt_bridge = { outcome: 'miss', field: !single || pointer !== 'exact' ? 'candidate' : explainMiss(current, previous) ?? 'candidate',
          receipt: single ? pointers[0] : pointers,
          ...(single && pointer !== 'exact' ? { pointer } : {}) };
      }
      attempt.prepare.finished_at = new Date().toISOString(); save();
      process.stdout.write(`validating in ${attempt.scratch}: ${validation.tiers.promotion.command}\n`);
      // Publish the clock before the synchronous gate blocks. No exit code is
      // present until validation returns, so this can never prove a green gate.
      // A resumed validated attempt must also return to prepared before its
      // old proof is replaced; validated always means a completed green gate.
      attempt.phase = 'prepared';
      if (attempt.gate) (attempt.gate_history ??= []).push(attempt.gate);
      attempt.gate = { command, started_at: new Date().toISOString() };
      phase('validating');
      attempt.gate = validateTree({ cwd: attempt.scratch, common: identity, tier: 'promotion', command, historyKey: gateHistoryKey('promotion', ['/bin/sh', '-c', validation.tiers.promotion.command]),
        prepare, timeoutSeconds: profile?.timeoutSeconds ?? validation.tiers.promotion.timeoutSeconds,
        idleTimeoutSeconds: profile?.idleTimeoutSeconds ?? validation.tiers.promotion.idleTimeoutSeconds, environment: validation.environment,
        env: gateEnv, watchContext: { ...env, MONITOR_GATE_NOTICE_CONTEXT: JSON.stringify({ to: attempt.jobs[0].to, org: attempt.jobs[0].org ?? undefined, cwd: canonical, herdr: attempt.jobs[0].herdr }) }, exact, label: 'train scratch',
        onStart: gate => { attempt.gate = gate; save(); } });
      if (exact && attempt.gate.reused) attempt.receipt_bridge = { outcome: 'reused', field: null,
        receipt: path.join(identity, 'lane-validation/exact', `${attempt.gate.key}.json`) };
      attempt.selector_shadow = completeShadow(attempt.selector_shadow, attempt.gate, [attempt.scratch, canonical]);
    } catch (error) {
      if (attempt.prepare && !attempt.prepare.finished_at) attempt.prepare.finished_at = new Date().toISOString();
      // A dirty execution is measurable, but never a completed green proof.
      if (error.gate) attempt.gate = { ...attempt.gate, finished_at: error.gate.finished_at,
        duration_s: error.gate.duration_s, execution: error.gate, error: error.message };
      if (error.gate) attempt.selector_shadow = completeShadow(attempt.selector_shadow, error.gate, [attempt.scratch, canonical]);
      if (attempt.gate && !attempt.gate.finished_at) {
        attempt.gate.finished_at = new Date().toISOString();
        attempt.gate.duration_s = Math.max(0, (Date.parse(attempt.gate.finished_at) - Date.parse(attempt.gate.started_at)) / 1000);
        attempt.gate.error = error.message;
      }
      attempt.phase = 'invalid'; attempt.error = error.message; plan.groups.shift();
      for (const job of attempt.jobs) result(job, { outcome: 'refused', reason: error.message, ...(error.code ? { code: error.code } : {}), batch: plan.id });
      saveSlotGrant(attempt); save(); return false;
    }
    saveSlotGrant(attempt);
    attempt.phase = attempt.gate.outcome === 'timeout' ? 'timeout' : attempt.gate.exit_code === 0 ? 'validated' : 'red'; save();
    if (attempt.phase === 'timeout') {
      plan.groups.shift();
      const reason = attempt.gate.gate_timeout?.kind === 'frozen' ? 'gate frozen without output or process activity' : attempt.gate.gate_timeout?.kind === 'idle' ? 'gate no-output limit exceeded' : 'gate wall-clock limit exceeded';
      for (const job of attempt.jobs) result(job, { outcome: 'timeout', reason: `${reason}; ${attempt.jobs.length === 1 ? 'lane isolated for correction' : 'batch timed out; re-enqueue lanes individually'}`, gate: attempt.gate, batch: plan.id });
      save(); return false;
    }
    if (attempt.phase === 'red') {
      plan.groups.shift();
      if (noRetryCommand(validation.tiers.promotion.command)) {
        for (const job of attempt.jobs) result(job, { outcome: 'refused', reason: `batch validation failed (exit ${attempt.gate.exit_code}); no-retry command forbids bisection`, gate: attempt.gate, batch: plan.id });
      } else if (attempt.jobs.length === 1) result(attempt.jobs[0], { outcome: 'refused', reason: `batch validation failed (exit ${attempt.gate.exit_code}); lane isolated for correction`, gate: attempt.gate, batch: plan.id });
      else {
        const middle = Math.ceil(attempt.ids.length / 2);
        plan.groups.unshift(attempt.ids.slice(0, middle), attempt.ids.slice(middle));
      }
      save(); return false;
    }
    return true;
  };
  // Unconfigured trains take the slot at validation; profiled trains already
  // saved the outer grant before preparation. Keep the first grant on resume.
  function saveSlotGrant(attempt) {
    for (const gate of [...(attempt.gate_history ?? []), ...(attempt.gate ? [attempt.gate] : [])]) {
      if (plan.slot_granted_at) return;
      if (gate.reused) continue;
      try {
        const slot = JSON.parse(fs.readFileSync(gate.slot_receipt, 'utf8'));
        if (slot.state === 'acquired' && Number.isFinite(Date.parse(slot.acquired_at))) plan.slot_granted_at = slot.acquired_at;
      } catch { /* Refused or interrupted waits have no grant. */ }
    }
  }
  const integrateAttempt = attempt => {
    if ((!operatorWaivedGate(attempt.gate) && (attempt.phase !== 'validated' || attempt.gate?.exit_code !== 0)) || (operatorWaivedGate(attempt.gate) && attempt.phase !== 'waived') || attempt.gate.signal !== null || attempt.gate.head !== attempt.tip) throw new Error('train integration requires exact-commit green evidence');
    if (!canonicalReady()) return false;
    if (profile) checkCompetingProcesses(profile);
    if (git(['rev-parse', main]) !== attempt.base) {
      attempt.phase = 'stale'; attempt.error = 'main moved during validation; replan'; save(); return false;
    }
    let invalid = false;
    for (const job of attempt.jobs) {
      try { capture(job); }
      catch (error) { result(job, { outcome: 'refused', reason: error.message, ...(error.code ? { code: error.code } : {}), batch: plan.id }); invalid = true; }
    }
    if (invalid) { attempt.phase = 'invalid'; save(); return false; }
    clean(attempt.scratch);
    if (git(['rev-parse', 'HEAD'], attempt.scratch) !== attempt.tip) throw new Error('validated train tip changed');
    phase('fast-forwarding');
    try { withPromotionGuards(guards(attempt.jobs), () => git(['merge', '--ff-only', attempt.tip])); }
    catch (error) {
      attempt.phase = 'invalid'; attempt.error = error.message;
      for (const job of attempt.jobs) result(job, { outcome: 'refused', reason: error.message, batch: plan.id });
      save(); return false;
    }
    attempt.integrated_at = new Date().toISOString(); attempt.phase = 'integrated'; save();
    return true;
  };
  while (plan.groups.length) {
    const ids = plan.groups[0].filter(id => !plan.results[id]);
    if (!ids.length) { plan.groups.shift(); save(); continue; }
    const attempt = prepareAttempt(ids);
    if (!attempt || !validateAttempt(attempt) || !integrateAttempt(attempt)) continue;
    finishIntegrated(attempt);
  }
  plan.phase = 'complete'; save();
  for (const attempt of plan.attempts) {
    try {
      if (fs.existsSync(attempt.scratch)) git(['worktree', 'remove', attempt.scratch]);
      git(['branch', '-D', attempt.branch]);
    } catch (error) { attempt.cleanup_warning = error.message; save(); }
  }
}
