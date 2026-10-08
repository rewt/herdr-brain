#!/usr/bin/env node
// Finite, foreground supervisor operation. All record writes go through the CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, writeFileAtomic } from '../lib/store.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { releaseSettings, releaseArgv } from './config.mjs';
import { runTestSlotSync, REFUSED_EXIT } from '../test-slot/run.mjs';
import { resolveValidation } from '../lanes/validation.mjs';
import { resolveGateLimits } from '../test-slot/limits.mjs';
import { readMemory, memoryReason } from '../lib/memory.mjs';
import { pruneSnapshots } from './retention.mjs';

const SELF = fileURLToPath(import.meta.url);
const RECORD = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const invoke = (command, args, options = {}) => {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (r.error || r.status !== 0) throw new Error(r.stderr || r.error?.message || `command exited ${r.status}`);
  return r.stdout;
};
const git = (cwd, args) => invoke('git', ['-C', cwd, ...args]).trim();

export function quietPoint(project, config, { load = os.loadavg()[0], cpus = os.availableParallelism(), memory = readMemory() } = {}) {
  if (fs.existsSync(path.join(project.canonical, '.lane/supervisor/STOP'))) return 'supervisor STOP exists';
  if (!Number.isFinite(load) || !Number.isFinite(cpus) || cpus < 1 || load / cpus > config.max_load_per_cpu) return `load ${load} / ${cpus} CPUs exceeds ${config.max_load_per_cpu}`;
  const pressure = memoryReason(memory);
  if (pressure) return pressure;
  const queueFile = path.join(project.identity, 'promote/queue.json');
  if (fs.existsSync(queueFile)) {
    const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    if (queue.identity !== project.identity || !Array.isArray(queue.pending)) throw new Error('invalid promotion queue identity');
    if (queue.current || queue.pending.length) return 'promotion queue is active or pending';
  }
  if (fs.existsSync(path.join(project.identity, 'lane-promote.lock'))) return 'promotion or release holds the project lock';
  return null;
}

export function releaseOnce({ cwd = process.cwd(), org, role, tag, env = process.env, measurement, slotHeld = false } = {}) {
  const project = gitProject(cwd);
  if (role !== 'supervisor' || project.checkout !== project.canonical) throw new Error('release requires --role supervisor from the canonical checkout; workers never run the release gate');
  let declaration = releaseSettings(project.canonical);
  // A missing native probe is advisory, never an invented pressure signal.
  const sample = () => {
    const memory = measurement?.memory ?? readMemory();
    if (memory.warning) process.stderr.write(`release: memory probe advisory: ${memory.warning}\n`);
    return { ...measurement, memory };
  };
  const reason = quietPoint(project, declaration.config, sample());
  if (reason) return { result: 'deferred', reason };
  // Own the slot before cutting or claiming a candidate. A busy host leaves no
  // once-only gate claim behind. The worker repeats all canonical-role checks.
  if (!slotHeld) {
    const declared = resolveValidation({ root: project.canonical }).tiers.release;
    const limits = resolveGateLimits({ common: project.identity, tier: 'release', ...declared });
    const result = runTestSlotSync(`release ${project.canonical}`, [process.execPath, SELF, '--held-once', JSON.stringify({ cwd: project.canonical, org: org ? path.resolve(org) : undefined, role, tag, measurement })],
      { cwd: project.canonical, env, common: project.identity, tier: 'release-host', timeoutSeconds: Math.max(600, 2 * limits.wall_seconds), idleTimeoutSeconds: 0, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, retryTimeout: false });
    if (result.status === REFUSED_EXIT && result.attempts === undefined) return { result: 'deferred', exit_code: REFUSED_EXIT, reason: result.stderr.trim() };
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `release wrapper exited ${result.status}`);
    return JSON.parse(result.stdout);
  }
  const unlock = acquireLock(path.join(project.identity, 'lane-promote.lock'));
  let record, cycleResult;
  const finish = value => { cycleResult = value; return value; };
  try {
    // Queue/load/STOP are checked again under the same lock as every promotion.
    const lockedReason = quietPoint(project, declaration.config, sample());
    if (lockedReason && lockedReason !== 'promotion or release holds the project lock') return { result: 'deferred', reason: lockedReason };
    if (git(project.canonical, ['symbolic-ref', '--short', 'HEAD']) !== declaration.config.base) throw new Error('canonical checkout must be on the declared release base');
    if (git(project.canonical, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('release requires a clean canonical worktree');
    const commit = git(project.canonical, ['rev-parse', 'HEAD']);
    declaration = releaseSettings(project.canonical, commit);
    org = org ? path.resolve(org) : findOrgDir({ cwd: project.canonical, env });
    // Discovery initializes an unconfigured project's record through the CLI.
    const recordEnv = { ...env, ORG_DIR: org ?? '', ORG_ACTOR: env.ORG_ACTOR || 'release-supervisor' };
    record = args => JSON.parse(invoke(process.execPath, [RECORD, ...args], { cwd: project.canonical, env: recordEnv }));
    const rows = record(['releases', '--json', '--identity', project.identity]).candidates;
    const existing = rows.find(c => c.commit === commit);
    if (existing?.gate) {
      if (git(project.canonical, ['rev-parse', `refs/tags/${existing.tag}^{commit}`]) !== existing.commit) throw new Error('recorded candidate tag moved; inspect before shipping');
      return finish({ result: existing.status, candidate: existing });
    }
    if (existing?.started) return finish({ result: 'inspect', reason: 'gate already started without a durable result; never replay it', candidate: existing });
    // Never cut a second candidate while an earlier operator decision is pending.
    const pending = rows.find(c => c.status === 'awaiting-operator' || c.status === 'inspect-interrupted' || c.status === 'pending-gate');
    if (pending && pending.id !== existing?.id) return finish({ result: 'deferred', reason: 'earlier candidate needs an operator decision or recovery', candidate: pending });
    const previous = rows.at(-1)?.commit ?? null;
    if (previous && spawnSync('git', ['-C', project.canonical, 'merge-base', '--is-ancestor', previous, commit]).status !== 0) throw new Error('release base history no longer descends from the previous candidate; inspect');
    tag = existing?.tag ?? tag ?? `rc-${new Date().toISOString().replace(/[-:.]/g, '')}-${commit.slice(0, 10)}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(tag) || tag.includes('..') || git(project.canonical, ['check-ref-format', `refs/tags/${tag}`])) throw new Error('invalid candidate tag');
    const directory = path.join(project.identity, 'release');
    fs.mkdirSync(directory, { recursive: true });
    const snapshot = path.join(directory, 'candidates', tag);
    const values = { tag, candidate: snapshot, commit, repo: project.canonical };
    const input = existing ?? { identity: project.identity, tag, base: declaration.config.base, commit,
      tree: git(project.canonical, ['rev-parse', `${commit}^{tree}`]), snapshot, previous,
      commits: git(project.canonical, ['rev-list', '--reverse', previous ? `${previous}..${commit}` : commit]).split('\n').filter(Boolean),
      gate_command: releaseArgv(declaration.config.gate, values), prepare: releaseArgv(declaration.config.prepare, values),
      ship: releaseArgv(declaration.config.ship, values), parent: declaration.config.parent };
    if (!existing && spawnSync('git', ['-C', project.canonical, 'show-ref', '--verify', '--quiet', `refs/tags/${tag}`]).status === 0) throw new Error('candidate tag already exists; choose a new tag');
    const payload = path.join(directory, 'receipt-input.json');
    const receipt = value => { writeFileAtomic(payload, JSON.stringify(value) + '\n'); return payload; };
    // Machine setup is retryable, unlike a claimed build/gate. Run the tracked
    // read-only check before recording a candidate or cutting its tag, so a
    // setup failure cannot block a later promoted commit from being released.
    const preflight = releaseArgv(declaration.config.preflight, values);
    if (preflight) {
      const log = path.join(directory, `${tag}.setup.log`);
      const r = spawnSync(preflight[0], preflight.slice(1), { cwd: project.canonical, env: recordEnv, encoding: 'utf8' });
      const detail = [r.stdout, r.stderr, r.error?.message, r.signal ? `preflight interrupted by ${r.signal}` : ''].filter(Boolean).join('\n').trim();
      fs.appendFileSync(log, `${new Date().toISOString()} ${JSON.stringify(preflight)}\n${detail}\n`);
      if (r.error || r.status !== 0) return finish({ result: 'setup-required', candidate: existing ?? null, commit, tag, command: preflight, log,
        reason: detail || `preflight exited ${r.status}`, next: 'correct machine setup and retry; the current release base will be cut and gated' });
      if (git(project.canonical, ['rev-parse', 'HEAD']) !== commit || git(project.canonical, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('preflight changed the canonical checkout; inspect before claiming the gate');
    }
    // Record before cutting the tag, so interruption can recover the exact intent.
    const candidate = existing ?? record(['release', 'cut', '--file', receipt(input)]);
    const tagExists = spawnSync('git', ['-C', project.canonical, 'show-ref', '--verify', '--quiet', `refs/tags/${tag}`]).status === 0;
    if (tagExists) {
      if (!existing || git(project.canonical, ['rev-parse', `refs/tags/${tag}^{commit}`]) !== commit) throw new Error('candidate tag already exists; inspect before any gate');
    } else git(project.canonical, ['tag', tag, commit]);
    const claimed = record(['release', 'start', candidate.id]);
    if (!claimed.started) return finish({ result: 'inspect', candidate: claimed.candidate });
    const log = path.join(directory, `${candidate.id}.log`);
    let gate = { result: 'failed', stage: 'snapshot', exit_code: null, command: null, log, detail: '' };
    try {
      if (fs.existsSync(snapshot) || fs.existsSync(`${snapshot}.partial`)) throw new Error('snapshot already exists without a recorded gate result; inspect');
      fs.mkdirSync(`${snapshot}.partial`, { recursive: true });
      const archive = invoke('git', ['-C', project.canonical, 'archive', commit], { encoding: undefined, maxBuffer: 256 * 1024 * 1024 });
      // BSD tar may stop reading at the archive end markers while Node is still
      // writing padded input, producing EPIPE despite successful extraction.
      // Keep an owned file outside the extraction tree; never pipe the archive.
      const archiveFile = `${snapshot}.archive.tar`;
      fs.writeFileSync(archiveFile, archive, { flag: 'wx' });
      invoke('tar', ['-x', '-f', archiveFile, '-C', `${snapshot}.partial`]);
      fs.unlinkSync(archiveFile);
      fs.writeFileSync(path.join(`${snapshot}.partial`, '.release-commit'), commit + '\n');
      fs.renameSync(`${snapshot}.partial`, snapshot);
      const run = (command, stage, extra = {}) => {
        gate.stage = stage; gate.command = command;
        if (fs.existsSync(path.join(project.canonical, '.lane/supervisor/STOP'))) throw new Error('STOP appeared before release command');
        if (git(project.canonical, ['rev-parse', `refs/tags/${tag}^{commit}`]) !== commit) throw new Error('candidate tag moved before release command');
        const fd = fs.openSync(log, 'a');
        let r;
        const watchdog = resolveValidation({ root: snapshot }).tiers.release;
        try { r = runTestSlotSync(`release ${stage} ${candidate.id}`, command, { cwd: snapshot, common: project.identity, tier: stage === 'gate' ? 'release' : 'release-prepare', timeoutSeconds: watchdog.timeoutSeconds, idleTimeoutSeconds: watchdog.idleTimeoutSeconds, env: { ...recordEnv, ...extra }, stdio: ['ignore', fd, fd], retryTimeout: stage === 'gate' }); }
        finally { fs.closeSync(fd); }
        gate.exit_code = r.status; gate.signal = r.signal;
        if (r.signal) gate.result = 'interrupted';
        if (r.error || r.status !== 0) throw new Error(r.error?.message || `${stage} exited ${r.status ?? r.signal}`);
      };
      if (candidate.prepare) run(candidate.prepare, 'prepare', declaration.config.prepare_env);
      run(candidate.gate_command, 'gate');
      if (git(project.canonical, ['rev-parse', `refs/tags/${tag}^{commit}`]) !== commit) throw new Error('candidate tag moved during release gate');
      gate.result = 'passed'; gate.detail = 'declared gate exited zero on the tagged candidate';
    } catch (error) {
      gate.detail = error.message;
      fs.appendFileSync(log, error.message + '\n');
    }
    const saved = record(['release', 'result', candidate.id, '--file', receipt(gate)]);
    return finish({ result: gate.result === 'passed' ? 'awaiting-operator' : 'gate-failed', candidate: saved,
      next: gate.result === 'passed' ? `Operator answers ${saved.question}; ship/activation is never automatic` : 'inspect gate evidence; a new promoted commit can become a new candidate' });
  } finally {
    try {
      if (record) {
        const retention = pruneSnapshots({ project, candidates: record(['releases', '--json', '--identity', project.identity]).candidates, env });
        if (cycleResult) cycleResult.retention = retention;
      }
    } catch (error) {
      if (cycleResult) cycleResult.retention = { advisory: error.message };
      process.stderr.write(`release: retention advisory: ${error.message}\n`);
    } finally { unlock(); }
  }
}

export function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--held-once' && argv.length === 2) {
    const options = JSON.parse(argv[1]);
    process.stdout.write(JSON.stringify(releaseOnce({ ...options, slotHeld: true })) + '\n');
    return;
  }
  const { values: opt, positionals } = parseArgs({ usage: "Usage: node release/release.mjs --once --role supervisor [OPTIONS] | --prune [--dry-run]", args: argv, allowPositionals: true, options: {
    repo: { type: 'string', default: process.cwd() }, org: { type: 'string' }, role: { type: 'string' },
    once: { type: 'boolean' }, tag: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'skip-live': { type: 'boolean' },
    'max-load-per-cpu': { type: 'string' },
    prune: { type: 'boolean' }, 'active-tag': { type: 'string' },
  } });
  if (opt.prune) {
    if (positionals.length || opt.once || opt.tag || opt['skip-live'] || opt['max-load-per-cpu']) throw new Error('usage: release.mjs --prune [--dry-run] [--active-tag TAG] [--repo DIR] [--org DIR]; pruning requires --role supervisor');
    const project = gitProject(opt.repo);
    if (!opt['dry-run'] && (opt.role !== 'supervisor' || project.checkout !== project.canonical)) throw new Error('pruning requires --role supervisor from the canonical checkout');
    if (!opt['dry-run'] && fs.existsSync(path.join(project.canonical, '.lane/supervisor/STOP'))) throw new Error('supervisor STOP exists');
    const org = opt.org ? path.resolve(opt.org) : findOrgDir({ cwd: project.canonical });
    if (!org) throw new Error('no record discovered');
    const unlock = opt['dry-run'] ? () => {} : acquireLock(path.join(project.identity, 'lane-promote.lock'));
    try {
      const candidates = JSON.parse(invoke(process.execPath, [RECORD, 'releases', '--json', '--identity', project.identity], { cwd: project.canonical, env: { ...process.env, ORG_DIR: org } })).candidates;
      process.stdout.write(JSON.stringify(pruneSnapshots({ project, candidates, dryRun: opt['dry-run'], activeTag: opt['active-tag'] })) + '\n');
    } finally { unlock(); }
    return;
  }
  if (opt['active-tag']) throw new Error('--active-tag requires --prune');
  if (positionals.length || (opt['skip-live'] || opt['max-load-per-cpu']) && !opt['dry-run']) throw new Error('usage: release.mjs --once --role supervisor [--repo DIR] [--org DIR] [--tag TAG]; --dry-run [--skip-live] [--max-load-per-cpu N] uses only scratch');
  if (opt['dry-run']) {
    const project = gitProject(opt.repo);
    if (git(project.checkout, ['status', '--porcelain'])) throw new Error('preview requires a clean committed checkout');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-release-preview-'));
    const repo = path.join(root, 'project');
    const commit = git(project.checkout, ['rev-parse', 'HEAD']);
    invoke('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', project.checkout, repo]);
    git(repo, ['checkout', '-B', 'main', commit]);
    // Preview config is a tracked override in the owned copy only.
    const settings = releaseSettings(repo).config;
    if (opt['max-load-per-cpu'] !== undefined) {
      settings.max_load_per_cpu = Number(opt['max-load-per-cpu']);
      if (!Number.isFinite(settings.max_load_per_cpu) || settings.max_load_per_cpu <= 0) throw new Error('preview load threshold must be positive');
    }
    if (opt['skip-live']) settings.gate = [...settings.gate, '--skip-live'];
    settings.base = 'main'; settings.parent = null;
    fs.writeFileSync(path.join(repo, '.release.json'), JSON.stringify(settings, null, 2) + '\n');
    git(repo, ['add', '.release.json']);
    invoke('git', ['-C', repo, '-c', 'user.name=Release preview', '-c', 'user.email=preview@example.invalid', 'commit', '--allow-empty', '-qm', 'Declare isolated release preview']);
    const env = { ...process.env, ORG_DIR: '', ORG_ACTOR: process.env.ORG_ACTOR || 'release-preview', HERDR_ENV: '' };
    delete env.RELEASE_NO_NPM;
    for (const key of Object.keys(env)) if (/^(HERDR_MONITOR_|HERDR_(PANE|TAB|WORKSPACE|SOCKET)|ACCEPTANCE_|LANE_)/.test(key)) delete env[key];
    const result = releaseOnce({ cwd: repo, role: 'supervisor', tag: opt.tag, env });
    process.stdout.write(JSON.stringify({ ...result, preview: root, source_commit: commit, preview_max_load_per_cpu: settings.max_load_per_cpu }) + '\n');
  } else {
    const result = releaseOnce({ cwd: opt.repo, org: opt.org, role: opt.role, tag: opt.tag });
    if (result.exit_code === REFUSED_EXIT) { process.stderr.write(result.reason + '\n'); process.exitCode = REFUSED_EXIT; }
    else process.stdout.write(JSON.stringify(result) + '\n');
  }
}
if (isMain(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`release: ${error.message}\n`); process.exitCode = 1; }
}
