// Native Git merge train. The durable plan owns scratch work only; lane tips
// are authorization inputs and remain untouched until integration succeeds.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic, readPlainFile } from '../lib/files.mjs';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { validateTree, validationEnvironment } from '../lanes/validation.mjs';
import { withPromotionGuard, withPromotionGuards } from './guard.mjs';

const replacement = fileURLToPath(new URL('../settle/replace-lane-head.mjs', import.meta.url));

export function verifyTrainResult(result, { project, saved }) {
  try {
    if (result.source_head !== saved.head || typeof result.receipt !== 'string' ||
        path.relative(path.join(project.identity, 'promote/batches'), result.receipt).startsWith('..')) return false;
    const plan = JSON.parse(readPlainFile(result.receipt));
    const job = plan.jobs.find(j => j.id === result.id);
    if (plan.schema !== 'promotion-train/v1' || plan.identity !== project.identity || plan.id !== result.batch ||
        job?.expectedHead !== saved.head || job.run !== saved.run || job.org !== saved.org || job.topic !== saved.lane) return false;
    const attempt = plan.attempts.find(a => ['integrated', 'complete'].includes(a.phase) && a.tips[result.id] === result.tip);
    const captured = attempt?.jobs.find(j => j.id === result.id);
    if (captured?.sourceHead !== saved.head || attempt.gate?.exit_code !== 0 || attempt.gate.signal !== null || attempt.gate.head !== attempt.tip) return false;
    const git = args => {
      const r = spawnSync('git', ['-C', project.canonical, ...args], { encoding: 'utf8' });
      if (r.error || r.status !== 0) throw new Error('train Git proof refused');
      return r.stdout.trim();
    };
    const log = readPlainFile(attempt.gate.log);
    if (createHash('sha256').update(JSON.stringify(log)).digest('hex') !== attempt.gate.log_hash ||
        attempt.gate.tree !== git(['rev-parse', `${attempt.tip}^{tree}`])) return false;
    git(['merge-base', '--is-ancestor', result.tip, attempt.tip]);
    const index = attempt.jobs.findIndex(j => j.id === result.id);
    const onto = index ? attempt.tips[attempt.jobs[index - 1].id] : attempt.base;
    const expected = git(['merge-tree', '--write-tree', onto, saved.head]).split('\n')[0];
    return expected === git(['rev-parse', `${result.tip}^{tree}`]) && git(['merge-base', onto, result.tip]) === onto &&
      git(['rev-list', '--merges', `${onto}..${result.tip}`]) === '';
  } catch { return false; }
}
export function runTrain({ file, canonical, identity, main, prepare, validation }) {
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (plan.schema !== 'promotion-train/v1' || plan.identity !== identity || !Array.isArray(plan.jobs)) throw new Error('invalid train receipt');
  const save = () => writeFileAtomic(file, JSON.stringify(plan, null, 2) + '\n', 0o600);
  const env = validationEnvironment();
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
    if (job.run) {
      const at = fold(loadEvents(job.org).events).runs.get(job.run)?.report?.at;
      if (at) captured.report_at = at;
    }
    return captured;
  };
  const guards = jobs => jobs.map(job => ({ canonical, identity, ...job, expectedHead: job.sourceHead }));
  const result = (job, value) => { plan.results[job.id] = value; save(); };
  // Batch phase is live telemetry; attempt.phase remains the recovery checkpoint.
  // In particular, an in-flight gate still resumes from its prepared candidate.
  const phase = value => { plan.phase = value; save(); };
  plan.started_at ??= new Date().toISOString();
  plan.results ??= {}; plan.attempts ??= []; plan.groups ??= [plan.jobs.map(j => j.id)]; save();
  const canonicalReady = () => {
    try { canonicalCheck(); return true; }
    catch (error) {
      for (const job of plan.jobs.filter(j => !plan.results[j.id])) result(job, { outcome: 'refused', reason: error.message, batch: plan.id });
      plan.groups = []; save(); return false;
    }
  };
  // A persisted integrated checkpoint never gates or fast-forwards twice.
  const finishIntegrated = attempt => {
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
        reason: warnings.length ? warnings.join('; ') : 'green batch fast-forward', batch: plan.id,
        gate: attempt.gate, integrated_at: integratedAt, report_at: job.report_at ?? null,
        report_to_main_s: job.report_at ? Math.max(0, (Date.parse(integratedAt) - Date.parse(job.report_at)) / 1000) : null });
    }
    attempt.phase = 'complete'; save();
  };
  for (const attempt of plan.attempts) {
    if (attempt.phase === 'validated') {
      const integrated = run(['merge-base', '--is-ancestor', attempt.tip, main]);
      if (integrated.error || ![0, 1].includes(integrated.status)) throw new Error(integrated.stderr || integrated.error?.message || 'train ancestry proof failed');
      if (integrated.status === 0) {
        // A lost FF response remains adoptable after later batches advance main.
        attempt.phase = 'integrated'; attempt.integrated_at ??= new Date().toISOString(); save();
      }
    }
    if (attempt.phase === 'integrated') finishIntegrated(attempt);
  }
  while (plan.groups.length) {
    const ids = plan.groups[0].filter(id => !plan.results[id]);
    if (!ids.length) { plan.groups.shift(); save(); continue; }
    phase('preparing');
    if (!canonicalReady()) break;
    let attempt = plan.attempts.findLast(a => ['prepared', 'validated'].includes(a.phase) && JSON.stringify(a.ids) === JSON.stringify(ids));
    if (attempt && git(['rev-parse', main]) !== attempt.base) {
      attempt.phase = 'stale'; attempt.error = 'main moved; replan from the current integration branch'; save();
      attempt = null;
    }
    if (!attempt) {
      const jobs = [];
      for (const id of ids) {
        const job = plan.jobs.find(j => j.id === id);
        try { jobs.push(capture(job)); }
        catch (error) { result(job, { outcome: 'refused', reason: error.message, batch: plan.id }); }
      }
      if (!jobs.length) continue;
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
      if (!kept.length) { attempt.phase = 'complete'; save(); continue; }
    }
    if (git(['rev-parse', main]) !== attempt.base) {
      attempt.phase = 'stale'; attempt.error = 'main moved during preparation; replan'; save(); continue;
    }
    let invalid = false;
    for (const job of attempt.jobs) {
      try { capture(job); }
      catch (error) { result(job, { outcome: 'refused', reason: error.message, batch: plan.id }); invalid = true; }
    }
    if (invalid) { attempt.phase = 'invalid'; save(); continue; }
    clean(attempt.scratch);
    if (git(['rev-parse', 'HEAD'], attempt.scratch) !== attempt.tip || git(['symbolic-ref', '--short', 'HEAD'], attempt.scratch) !== attempt.branch) throw new Error('train scratch changed');
    try {
      phase('preparing');
      for (const step of prepare) {
        if (step.unless !== undefined && fs.existsSync(path.join(attempt.scratch, step.unless))) continue;
        const r = spawnSync(step.run, { cwd: attempt.scratch, env, shell: '/bin/sh', stdio: 'inherit' });
        if (r.error || r.status !== 0) throw new Error(`train preparation failed: ${step.run}`);
      }
      if (git(['rev-parse', 'HEAD'], attempt.scratch) !== attempt.tip || git(['symbolic-ref', '--short', 'HEAD'], attempt.scratch) !== attempt.branch) throw new Error('train scratch tip or branch changed during preparation');
      process.stdout.write(`validating in ${attempt.scratch}: ${validation.tiers.promotion.command}\n`);
      // Publish the clock before the synchronous gate blocks. No exit code is
      // present until validation returns, so this can never prove a green gate.
      // A resumed validated attempt must also return to prepared before its
      // old proof is replaced; validated always means a completed green gate.
      attempt.phase = 'prepared';
      attempt.gate = { command: validation.tiers.promotion.command, started_at: new Date().toISOString() };
      phase('validating');
      attempt.gate = validateTree({ cwd: attempt.scratch, common: identity, tier: 'promotion', command: validation.tiers.promotion.command,
        prepare, environment: validation.environment, env, label: 'train scratch' });
    } catch (error) {
      if (attempt.gate && !attempt.gate.finished_at) {
        attempt.gate.finished_at = new Date().toISOString();
        attempt.gate.duration_s = Math.max(0, (Date.parse(attempt.gate.finished_at) - Date.parse(attempt.gate.started_at)) / 1000);
        attempt.gate.error = error.message;
      }
      attempt.phase = 'invalid'; attempt.error = error.message; plan.groups.shift();
      for (const job of attempt.jobs) result(job, { outcome: 'refused', reason: error.message, batch: plan.id });
      save(); continue;
    }
    attempt.phase = attempt.gate.exit_code === 0 ? 'validated' : 'red'; save();
    if (attempt.phase === 'red') {
      plan.groups.shift();
      if (attempt.jobs.length === 1) result(attempt.jobs[0], { outcome: 'refused', reason: `batch validation failed (exit ${attempt.gate.exit_code}); lane isolated for correction`, gate: attempt.gate, batch: plan.id });
      else {
        const middle = Math.ceil(attempt.ids.length / 2);
        plan.groups.unshift(attempt.ids.slice(0, middle), attempt.ids.slice(middle));
      }
      save(); continue;
    }
    if (!canonicalReady()) break;
    if (git(['rev-parse', main]) !== attempt.base) {
      attempt.phase = 'stale'; attempt.error = 'main moved during validation; replan'; save(); continue;
    }
    invalid = false;
    for (const job of attempt.jobs) {
      try { capture(job); }
      catch (error) { result(job, { outcome: 'refused', reason: error.message, batch: plan.id }); invalid = true; }
    }
    if (invalid) { attempt.phase = 'invalid'; save(); continue; }
    clean(attempt.scratch);
    if (git(['rev-parse', 'HEAD'], attempt.scratch) !== attempt.tip) throw new Error('validated train tip changed');
    phase('fast-forwarding');
    try { withPromotionGuards(guards(attempt.jobs), () => git(['merge', '--ff-only', attempt.tip])); }
    catch (error) {
      attempt.phase = 'invalid'; attempt.error = error.message;
      for (const job of attempt.jobs) result(job, { outcome: 'refused', reason: error.message, batch: plan.id });
      save(); continue;
    }
    attempt.integrated_at = new Date().toISOString(); attempt.phase = 'integrated'; save();
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
