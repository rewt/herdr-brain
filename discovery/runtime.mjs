// Foreground, machine-side session adapter. Capabilities come only from worktree
// creation and verified Git identity held in memory, never session metadata.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gitProject, ignoreRuntime } from '../lib/project.mjs';
import { plainDirectory, readPlainFile, removePlainDirectory, writeFileAtomic as writeAgentFileAtomic } from '../lib/files.mjs';
import { withLock, findOrgDir } from '../lib/store.mjs';
import { loadDiscoveredRoutes, validateRoutesConfig } from '../lanes/routes.mjs';
import { ROUTE_PRESET } from '../lanes/preset.mjs';
import { readReport } from '../lib/report.mjs';
import { entryLifecycle, worktreeDirectory } from './lifecycle.mjs';
import { projectEntrySettings } from './settings.mjs';
import { sandboxCommand, selectSandbox } from './confinement.mjs';

const local = (p) => new URL(p, import.meta.url).pathname;
export const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
export function command(binary, args, cwd, env = {}) {
  const r = spawnSync(binary, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000, killSignal: 'SIGKILL' });
  if (r.error || r.status !== 0) throw new Error((`${r.stdout ?? ''}${r.stderr ?? ''}` || r.error?.message || `exit ${r.status}`).trim());
  return r.stdout.trim();
}

export function createEntry({ cwd = process.cwd(), role = 'worker', runtimeDir, worktreeRoot, sandboxBinary }) {
  const project = gitProject(cwd);
  const settings = projectEntrySettings(project);
  if (!settings.enabled) return null;
  if (!['worker', 'supervisor'].includes(role)) throw new Error('role must be worker or supervisor');
  const mode = role === 'supervisor' ? 'main' : settings.mode;
  const workerLane = role === 'worker' && mode === 'worker';
  if (mode === 'main' && project.checkout !== project.canonical) throw new Error(`${role} entry in main requires the canonical checkout`);
  const id = randomUUID().replaceAll('-', '');
  const topic = `entry-${id.slice(0, 12)}`;
  const env = { ORG_ACTOR: `entry-${id.slice(0, 12)}` };
  // Never inherit a different project's record into an unrelated session.
  let org = findOrgDir({ cwd, env: {} }) ?? path.join(project.canonical, '.org');
  const recordAlias = org;
  env.ORG_DIR = org;
  const record = (args, location = project.canonical) => command(process.execPath, [local('../bin/org.mjs'), ...args], location, env);
  const gitEnv = { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const k of Object.keys(process.env)) if (/^GIT_/u.test(k) && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(k)) gitEnv[k] = undefined;
  // Resolve the operator's identity normally before bounding Git execution config.
  for (const type of ['AUTHOR', 'COMMITTER']) {
    const identity = command('git', ['-C', project.canonical, 'var', `GIT_${type}_IDENT`]).match(/^(.+) <([^>]+)> \d+ [+-]\d+$/u);
    if (!identity) throw new Error('Git identity is unavailable');
    gitEnv[`GIT_${type}_NAME`] = identity[1]; gitEnv[`GIT_${type}_EMAIL`] = identity[2];
  }
  let filterPaths = [org, path.join(project.canonical, '.lane')];
  const filterConfig = new Map([['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['commit.gpgsign', 'false']]);
  let canonicalDrivers;
  const boundedGitEnv = () => {
    const pairs = [...filterConfig];
    return { ...gitEnv, GIT_CONFIG_COUNT: String(pairs.length), ...Object.fromEntries(pairs.flatMap(([key, value], i) =>
      [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])) };
  };
  const git = (args, location = project.canonical) => command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', location, ...args], location, boundedGitEnv());
  const externalGit = (location) => {
    const inspect = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', location];
    const r = spawnSync('git', [...inspect, 'config', '-z', '--get-regexp', '^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver|diff\\.(external|.*\\.(command|textconv)))$'], { encoding: 'utf8', timeout: 10_000 });
    if (r.error || ![0, 1].includes(r.status)) throw new Error('could not inspect Git execution configuration');
    const drivers = new Map(r.stdout.split('\0').filter(Boolean).map((line) => {
      const split = line.indexOf('\n'); return [line.slice(0, split), line.slice(split + 1)];
    }));
    const keys = [...drivers.keys()];
    const signature = JSON.stringify([...drivers].sort(([a], [b]) => a.localeCompare(b)));
    if (location === project.canonical) canonicalDrivers = signature;
    else if (signature !== canonicalDrivers) throw new Error('external Git driver configuration differs between lane and canonical checkout');
    for (const key of filterConfig.keys()) if (key.startsWith('filter.')) filterConfig.delete(key);
    if (keys.includes('diff.external')) throw new Error('external Git filters/drivers require a project-specific bounded adapter');
    const files = spawnSync('git', [...inspect, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', timeout: 10_000 });
    if (files.error || files.status !== 0) throw new Error('could not inspect Git paths');
    const attributes = spawnSync('git', [...inspect, 'check-attr', '-z', '--stdin', 'filter', 'diff', 'merge'], { input: files.stdout, encoding: 'utf8', timeout: 10_000 });
    if (attributes.error || attributes.status !== 0) throw new Error('could not inspect Git attributes');
    const fields = attributes.stdout.split('\0');
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const [, attribute, driver] = fields.slice(i, i + 3);
      if (['unspecified', 'unset', 'set'].includes(driver)) continue;
      const processDisabled = attribute === 'filter' && drivers.has(`filter.${driver}.process`) && !drivers.get(`filter.${driver}.process`);
      if (!processDisabled && keys.some((key) => key.startsWith(`${attribute}.${driver}.`) && drivers.get(key)) && (attribute !== 'filter' || !sandboxBinary))
        throw new Error(`external Git filters/drivers used by ${fields[i]} require a native validation sandbox`);
    }
    // Capture effective operator clean/smudge/process commands before disabling
    // global execution config. Every operation refreshes these trusted wrappers.
    const filterNames = new Set(keys.flatMap((key) => key.match(/^filter\.(.+)\.(?:clean|smudge|process)$/u)?.slice(1) ?? []));
    for (const name of filterNames) {
      const prefix = `filter.${name}.`;
      const processDisabled = drivers.has(prefix + 'process') && !drivers.get(prefix + 'process');
      const active = !processDisabled && ['clean', 'smudge', 'process'].some((direction) => drivers.get(prefix + direction));
      if (!active) {
        // Git gives an explicitly empty process precedence over classic
        // directions: the whole driver becomes identity. Never turn it into
        // a protocol subprocess or force required=true for a disabled driver.
        for (const direction of ['clean', 'smudge', 'process']) if (drivers.has(prefix + direction))
          filterConfig.set(prefix + direction, '');
        continue;
      }
      if (!sandboxBinary) continue;
      const provider = selectSandbox(sandboxBinary);
      for (const direction of ['clean', 'smudge', 'process']) {
        const key = prefix + direction, value = drivers.get(key) ?? '';
        if (direction === 'process' && !value) continue;
        const encoded = Buffer.from(value).toString('base64');
        filterConfig.set(key, [process.execPath, local('./git-driver.mjs'), provider, JSON.stringify(filterPaths), encoded].map(quote).join(' ')
          + (value.includes('%f') ? ' %f' : ''));
      }
      // Configured commands must succeed. Missing classic directions get the
      // trusted identity transport, so this never demands a missing executable.
      filterConfig.set(prefix + 'required', 'true');
    }
  };
  externalGit(project.canonical);
  const routes = loadDiscoveredRoutes({ cwd: project.canonical, env: {} });
  const lifecycle = Object.assign({}, ...routes.files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8'))));
  const branch = git(['branch', '--show-current']);
  const main = lifecycle.main ?? branch;
  if (typeof main !== 'string' || !main || branch !== main) throw new Error('canonical checkout must be on the configured integration branch');
  git(['rev-parse', '--verify', 'HEAD']);
  const coordination = path.join(project.canonical, '.lane/discovery');
  plainDirectory(coordination);
  const initial = withLock(coordination, () => {
    ignoreRuntime(project);
    record(['init', org]);
    // Resolve operator-selected record links once, before the child can act.
    org = fs.realpathSync(org); env.ORG_DIR = org; gitEnv.ORG_DIR = org;
    const stateFile = path.join(coordination, 'routing.json');
    let routing = fs.existsSync(stateFile) ? JSON.parse(readPlainFile(stateFile)) : null;
    if (routes.suggested && !routing) {
      const parent = record(['add', 'Choose model routing for this project', '--role', 'architect']).split('\n')[0];
      const question = record(['ask', 'Adopt the suggested model routes, or reply with your preferred routes?', '--parent', parent,
        '--category', 'other', '--wait', '--recommend', 'yes', '--why',
        'Engineering uses Codex gpt-6.1-sol high; independent review uses Claude opus high (Codex gpt-6-astra xhigh is an alternative). The portable preset also includes chore, monitor, planning, settle and executive routes. Reply yes to adopt it, or give a complete route configuration; no personal paths or accounts are copied.']).split('\n')[0];
      routing = { parent, question, preset: structuredClone(ROUTE_PRESET) };
      writeAgentFileAtomic(stateFile, JSON.stringify(routing, null, 2) + '\n');
    }
    return { routing, routes };
  });
  const recordPaths = Object.fromEntries(['events.jsonl', 'config.json', 'runs', 'reports'].map((name) => [name, fs.realpathSync(path.join(org, name))]));
  const sharedPaths = [...new Set([recordAlias, org, ...Object.values(recordPaths), path.dirname(coordination), coordination])];
  filterPaths = sharedPaths; externalGit(project.canonical);
  const lifecycleOwner = entryLifecycle({ project, coordination, git, externalGit });
  let workspace = project.canonical;
  if (workerLane) {
    const root = worktreeDirectory(worktreeRoot, project.identity);
    let containingProject;
    try { containingProject = gitProject(root); } catch {}
    if (containingProject) throw new Error('worktree root must be outside existing Git checkouts');
    workspace = path.join(root, `lane-${topic}`);
    try { lifecycleOwner.allocate({ id, topic, workspace, main, org }); }
    catch (error) {
      try { lifecycleOwner.close(); } catch (cleanup) { console.error(`monitor entry cleanup: ${cleanup.message}`); }
      throw error;
    }
  } else lifecycleOwner.sweep();
  let requests, metadata, configFile;
  try {
    const runtime = plainDirectory(path.resolve(runtimeDir ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-entry-'))));
    const requestPath = path.join(runtime, id);
    const metadataPath = path.join(git(['rev-parse', '--path-format=absolute', '--git-dir'], workspace), 'monitor-entry', id);
    lifecycleOwner.runtime({ requests: requestPath, metadata: metadataPath });
    requests = plainDirectory(requestPath);
    metadata = plainDirectory(metadataPath);
    configFile = path.join(metadata, 'lane-config.json');
    // Keep all project commands in the validation sandbox. The outer lane
    // process only runs trusted code and fixed Git operations.
    writeAgentFileAtomic(configFile, JSON.stringify({ main, prepare: [], worktree_root: path.dirname(workspace) }));
  } catch (error) {
    if (requests) removePlainDirectory(requests);
    if (metadata) removePlainDirectory(metadata);
    try { lifecycleOwner.close(); } catch (cleanup) { console.error(`monitor entry cleanup: ${cleanup.message}`); }
    throw error;
  }
  let run, item, report, appliedRouting = false;
  const audit = [];
  const verify = (op) => {
    const now = gitProject(workspace);
    if (now.identity !== project.identity || now.canonical !== project.canonical || now.checkout !== workspace) throw new Error('project identity changed');
    if (git(['branch', '--show-current'], workspace) !== (workerLane ? `lane/${topic}` : main)) {
      if (!workerLane) throw new Error('assigned integration branch changed');
      // Rebase temporarily detaches HEAD. Only the actual Git rebase receipt
      // for our assigned branch permits conflict recovery, never display data.
      const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], workspace);
      const receipt = ['rebase-merge/head-name', 'rebase-apply/head-name'].map((p) => path.join(gitDir, p))
        .find((p) => fs.existsSync(p) && fs.readFileSync(p, 'utf8').trim() === `refs/heads/lane/${topic}`);
      if (!receipt || !['context', 'continue', 'abort'].includes(op)) throw new Error('assigned branch changed; if resolving this lane rebase, use continue or abort');
    }
    if (fs.realpathSync(org) !== org || fs.realpathSync(requests) !== requests || fs.realpathSync(metadata) !== metadata) throw new Error('runtime or record path redirected');
    for (const [name, target] of Object.entries(recordPaths)) {
      if (fs.realpathSync(path.join(org, name)) !== target) throw new Error('record path redirected');
    }
    // Refresh filter wrappers and reject drivers without a bounded transport.
    externalGit(project.canonical); externalGit(workspace);
  };
  const lane = (args, location) => {
    if (!sandboxBinary) throw new Error('a native validation sandbox is required for check and promote');
    const validation = [process.execPath, local('./validate.mjs'), sandboxBinary, workspace, JSON.stringify(sharedPaths)].map(quote).join(' ');
    return command(process.execPath, [local('../lanes/lane.mjs'), ...args], location, {
      ...boundedGitEnv(), LANE_CONFIG: configFile, LANE_VALIDATE: validation,
      MONITOR_PROJECT_CONFIG: path.join(project.canonical, '.lane.json'),
    });
  };
  const context = () => ({ role, canonical: project.canonical, identity: project.identity, workspace,
    branch: workerLane ? `lane/${topic}` : main, main, entry: { ...settings, mode }, org, topic, run, item, report,
    routing: initial.routing ? { parent: initial.routing.parent, question: initial.routing.question } : null,
    suggestedRoutes: initial.routes.suggested === true, requests });
  const dispatch = (request) => {
    if (!request || typeof request !== 'object' || Object.keys(request).some((k) => !['op', 'text'].includes(k))) throw new Error('unknown request fields');
    const { op, text } = request;
    if (text !== undefined && (typeof text !== 'string' || text.length > 4000 || text.includes('\0'))) throw new Error('invalid text');
    if (!['context', 'start', 'resume', 'commit', 'rebase', 'continue', 'abort', 'check', 'promote', 'apply-routes', 'finish'].includes(op)) throw new Error('unknown operation');
    verify(op);
    if (op === 'context') return context();
    if (role !== 'worker') throw new Error('supervisor uses the record/dispatch/watch CLIs; worker Git capabilities are unavailable');
    if (!workerLane && ['rebase', 'continue', 'abort', 'promote'].includes(op)) throw new Error('main checkout entry has no lane to rebase or promote; commit, check and finish here');
    if (op === 'start' || op === 'resume') {
      if (!text?.trim()) throw new Error('start requires the actual task');
      if (run) return context();
      if (op === 'resume') {
        if (!/^[A-Z]+-\d+$/u.test(text)) throw new Error('resume requires an existing record item ID');
        const existing = JSON.parse(record(['show', text, '--json']));
        if (existing.role === 'human') throw new Error('operator questions are answered by the operator, not worker runs');
        item = text;
      } else item = record(['add', text.trim().split('\n')[0], '--role', 'engineer']);
      report = path.join(workspace, 'docs/reports', `${topic}.md`);
      run = record(['start', item, '--workspace', workspace, '--report', report]).match(/^R-\d+/u)?.[0];
      if (!run) throw new Error('record did not return a run');
      return { ...context(), brief: path.join(org, 'runs', run, 'brief.md') };
    }
    if (!run) throw new Error('start the task before changing or reporting work');
    if (op === 'apply-routes') {
      if (!initial.routing) throw new Error('project routes already configured');
      const q = JSON.parse(record(['show', initial.routing.question, '--json']));
      if (!q.closed || !q.meta?.answer || q.meta.answered_by === 'auto') throw new Error('routing question still requires an operator answer');
      let selected;
      if (q.meta.answer === 'yes') selected = initial.routing.preset;
      else if (q.meta.answer === 'no') throw new Error('operator declined; ask for their preferred routes');
      else selected = validateRoutesConfig(JSON.parse(q.meta.answer));
      const file = path.join(workspace, '.lane.json');
      const existing = fs.existsSync(file) ? JSON.parse(readPlainFile(file)) : {};
      writeAgentFileAtomic(file, JSON.stringify({ ...existing, ...selected, authority: `Operator answer to ${initial.routing.question}` }, null, 2) + '\n');
      appliedRouting = true;
      return { applied: initial.routing.question, file };
    }
    if (op === 'commit') {
      if (!text?.trim() || text.startsWith('-')) throw new Error('commit needs a subject');
      git(['add', '-A', '--', '.'], workspace);
      return git(['commit', '-m', text], workspace);
    }
    if (op === 'rebase') return withLock(coordination, () => {
      try { return git(['rebase', main], workspace); }
      catch (error) {
        const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], workspace);
        const paused = ['rebase-merge/head-name', 'rebase-apply/head-name'].some((p) => {
          const file = path.join(gitDir, p);
          return fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === `refs/heads/lane/${topic}`;
        });
        if (!paused) throw error;
        return { paused: true, conflicts: git(['diff', '--name-only', '--diff-filter=U'], workspace).split('\n').filter(Boolean),
          next: 'Edit the conflicted files in your own checkout, then run monitor continue. The adapter stages the resolved files and continues this rebase; you do not need direct git add or index access. Run monitor check and monitor promote afterwards. monitor abort restores the original committed lane.' };
      }
    });
    if (op === 'continue') {
      git(['add', '-A', '--', '.'], workspace);
      return git(['-c', 'core.editor=true', 'rebase', '--continue'], workspace);
    }
    if (op === 'abort') return git(['rebase', '--abort'], workspace);
    if (op === 'check') return lane(['check'], workspace);
    if (op === 'promote') return withLock(coordination, () => {
      const document = readReport(readPlainFile(report));
      if (document.errors.length || document.report?.run !== run || document.report?.outcome !== 'done') throw new Error('promotion requires a valid done report for this run; record check explains report errors');
      const output = lane(['promote', topic], project.canonical);
      record(['note', run, 'Promoted by lane after clean rebase and sandboxed green validation; local fast-forward, no push.']);
      if (appliedRouting) record(['close', initial.routing.parent, '--note', 'Approved route configuration promoted and validated.']);
      return output;
    });
    if (op === 'finish') {
      const data = readReport(readPlainFile(report));
      if (data.report?.run !== run) throw new Error('report must name this session run');
      record(['check', report]);
      if (data.report?.outcome === 'done') {
        const integrated = spawnSync('git', ['-C', workspace, 'merge-base', '--is-ancestor', 'HEAD', main]);
        if (integrated.status !== 0) throw new Error('done report requires successful promotion first; resolve/rebase, check and promote, or report blocked/needs_human without claiming integration');
        if (!workerLane) {
          // Main-mode completion still requires a clean, validated commit. Lane
          // promotion already enforces this for isolated worker checkouts.
          const checkedHead = git(['rev-parse', 'HEAD'], workspace);
          lane(['check'], workspace);
          verify(op);
          if (git(['rev-parse', 'HEAD'], workspace) !== checkedHead || git(['status', '--porcelain', '--untracked-files=all'], workspace)) {
            throw new Error('integration checkout changed during validation; commit the result and check again before finishing');
          }
          if (appliedRouting) record(['close', initial.routing.parent, '--note', 'Approved route configuration committed and validated in the integration checkout.']);
        }
      }
      return record(['ingest', report]);
    }
  };
  let processing = false;
  const poll = () => {
    if (processing) return;
    processing = true;
    try {
      if (plainDirectory(requests, { create: false }) !== requests) throw new Error('request queue redirected');
      for (const name of fs.readdirSync(requests).filter((p) => /^[0-9a-f-]+\.request\.json$/u.test(p))) {
        const file = path.join(requests, name), reply = file.replace('.request.', '.reply.');
        if (fs.existsSync(reply)) continue;
        let response;
        try {
          if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 8192) throw new Error('invalid request file');
          const request = JSON.parse(readPlainFile(file));
          response = { result: dispatch(request) };
          audit.push({ op: request.op, success: true, at: new Date().toISOString() });
        } catch (e) { response = { error: e.message }; audit.push({ success: false, error: e.message }); }
        // Requests are agent-writable. Never follow an agent-created temporary
        // symlink from a privileged writer, and never accept a redirected queue.
        if (fs.realpathSync(requests) !== requests) throw new Error('request queue redirected');
        writeAgentFileAtomic(reply, JSON.stringify(response) + '\n', 0o600);
      }
    } finally { processing = false; }
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      writeAgentFileAtomic(path.join(project.canonical, '.lane/discovery', `${topic}.audit.json`), JSON.stringify(audit, null, 2) + '\n');
    } finally {
      if (!workerLane) {
        removePlainDirectory(requests); removePlainDirectory(metadata);
      } else try { lifecycleOwner.close(); } catch (error) { console.error(`monitor entry cleanup: ${error.message}`); }
    }
  };
  const nativeLaunch = (binary, args) => {
    if (role !== 'worker' || workerLane) return { binary, args };
    verify('context');
    const guarded = sandboxCommand(sandboxBinary, workspace, { sharedPaths, writablePaths: [requests], native: true });
    return { binary: guarded.binary, args: [...guarded.args, binary, ...args] };
  };
  return { context, dispatch, poll, close, nativeLaunch, attachChild: lifecycleOwner.attachChild };
}
