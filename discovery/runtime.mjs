// Foreground, machine-side session adapter. Capabilities come only from worktree
// creation and verified Git identity held in memory, never session metadata.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gitProject } from '../lib/project.mjs';
import { withLock, writeFileAtomic, findOrgDir } from '../lib/store.mjs';
import { loadDiscoveredRoutes, validateRoutesConfig } from '../lanes/routes.mjs';
import { ROUTE_PRESET } from '../lanes/preset.mjs';
import { readReport } from '../lib/report.mjs';

const local = (p) => new URL(p, import.meta.url).pathname;
export const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
export function command(binary, args, cwd, env = {}) {
  const r = spawnSync(binary, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error((`${r.stdout ?? ''}${r.stderr ?? ''}` || r.error?.message || `exit ${r.status}`).trim());
  return r.stdout.trim();
}
function plainDirectory(p) {
  fs.mkdirSync(p, { recursive: true });
  if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`directory must not redirect through symlinks: ${p}`);
  return fs.realpathSync(p);
}
function ignoreRuntime(project) {
  const file = path.join(project.identity, 'info/exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const additions = ['/.org/', '/.lane/'].filter((s) => !before.split('\n').includes(s));
  if (additions.length) fs.appendFileSync(file, `\n${additions.join('\n')}\n`);
}

export function createEntry({ cwd = process.cwd(), role = 'worker', runtimeDir, worktreeRoot, sandboxBinary }) {
  if (!['worker', 'supervisor'].includes(role)) throw new Error('role must be worker or supervisor');
  const project = gitProject(cwd);
  if (role === 'supervisor' && project.checkout !== project.canonical) throw new Error('supervisor entry requires the canonical checkout');
  const id = randomUUID().replaceAll('-', '');
  const topic = `entry-${id.slice(0, 12)}`;
  const env = { ORG_ACTOR: `entry-${id.slice(0, 12)}` };
  // Never inherit a different project's record into an unrelated session.
  const org = findOrgDir({ cwd: project.canonical, env: {} }) ?? path.join(project.canonical, '.org');
  env.ORG_DIR = org;
  const record = (args, location = project.canonical) => command(process.execPath, [local('../bin/org.mjs'), ...args], location, env);
  const gitEnv = { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const k of Object.keys(process.env)) if (/^GIT_/u.test(k) && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(k)) gitEnv[k] = '';
  const git = (args, location = project.canonical) => command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', location, ...args], location, gitEnv);
  const externalGit = (location) => {
    const r = spawnSync('git', ['-C', location, 'config', '--get-regexp', '^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver|diff\\.(external|.*\\.(command|textconv)))$'], { encoding: 'utf8' });
    if (r.error || ![0, 1].includes(r.status)) throw new Error('could not inspect Git execution configuration');
    if (r.status === 0 && r.stdout.trim()) throw new Error('external Git filters/drivers require a project-specific bounded adapter');
  };
  externalGit(project.canonical);
  const coordination = path.join(project.canonical, '.lane/discovery');
  plainDirectory(coordination);
  const initial = withLock(coordination, () => {
    ignoreRuntime(project);
    record(['init', org]);
    const routes = loadDiscoveredRoutes({ cwd: project.canonical, env: {} });
    const stateFile = path.join(coordination, 'routing.json');
    let routing = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
    if (routes.suggested && !routing) {
      const parent = record(['add', 'Choose model routing for this project', '--role', 'architect']).split('\n')[0];
      const question = record(['ask', 'Adopt the suggested model routes, or reply with your preferred routes?', '--parent', parent,
        '--category', 'other', '--wait', '--recommend', 'yes', '--why',
        'Engineering uses Codex gpt-6.1-sol high; independent review uses Claude opus high (Codex gpt-6-astra xhigh is an alternative). The portable preset also includes chore, monitor, planning, settle and executive routes. Reply yes to adopt it, or give a complete route configuration; no personal paths or accounts are copied.']).split('\n')[0];
      routing = { parent, question, preset: structuredClone(ROUTE_PRESET) };
      writeFileAtomic(stateFile, JSON.stringify(routing, null, 2) + '\n');
    }
    return { routing, routes };
  });
  const branch = git(['branch', '--show-current']);
  const main = initial.routes.config.main ?? branch;
  if (!main || git(['branch', '--show-current']) !== main) throw new Error('canonical checkout must be on the configured integration branch');
  let workspace = project.canonical;
  if (role === 'worker') {
    const root = plainDirectory(path.resolve(worktreeRoot ?? path.join(os.homedir(), '.herdr/worktrees', createHash('sha256').update(project.identity).digest('hex').slice(0, 16))));
    let containingProject;
    try { containingProject = gitProject(root); } catch {}
    if (containingProject) throw new Error('worktree root must be outside existing Git checkouts');
    workspace = path.join(root, `lane-${topic}`);
    withLock(coordination, () => git(['worktree', 'add', '-b', `lane/${topic}`, workspace, main]));
  }
  const runtime = plainDirectory(path.resolve(runtimeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-entry-'))));
  const requests = path.join(runtime, id);
  plainDirectory(requests);
  const metadata = plainDirectory(path.join(git(['rev-parse', '--path-format=absolute', '--git-dir'], workspace), 'monitor-entry', id));
  const configFile = path.join(metadata, 'lane-config.json');
  // Keep all project commands in the validation sandbox. The outer lane process
  // only runs trusted module code and fixed Git operations; prepare runs there too.
  writeFileAtomic(configFile, JSON.stringify({ main, prepare: [], worktree_root: path.dirname(workspace) }));
  let run, item, report, appliedRouting = false;
  const audit = [];
  const verify = (op) => {
    const now = gitProject(workspace);
    if (now.identity !== project.identity || now.canonical !== project.canonical || now.checkout !== workspace) throw new Error('project identity changed');
    if (role === 'worker' && git(['branch', '--show-current'], workspace) !== `lane/${topic}`) {
      // Rebase temporarily detaches HEAD. Only the actual Git rebase receipt
      // for our assigned branch permits conflict recovery, never display data.
      const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], workspace);
      const receipt = ['rebase-merge/head-name', 'rebase-apply/head-name'].map((p) => path.join(gitDir, p))
        .find((p) => fs.existsSync(p) && fs.readFileSync(p, 'utf8').trim() === `refs/heads/lane/${topic}`);
      if (!receipt || !['context', 'continue', 'abort'].includes(op)) throw new Error('assigned branch changed; if resolving this lane rebase, use continue or abort');
    }
    if (fs.realpathSync(org) !== org || fs.realpathSync(requests) !== requests || fs.realpathSync(metadata) !== metadata) throw new Error('runtime or record path redirected');
    for (const name of ['events.jsonl', 'config.json']) {
      if (fs.lstatSync(path.join(org, name)).isSymbolicLink()) throw new Error('record file redirected');
    }
    for (const name of ['runs', 'reports']) if (fs.realpathSync(path.join(org, name)) !== path.join(org, name)) throw new Error('record directory redirected');
    // Git clean filters can execute code outside the validation sandbox.
    externalGit(workspace);
  };
  const lane = (args, location) => {
    if (!sandboxBinary) throw new Error('a native validation sandbox is required for check and promote');
    const validation = [process.execPath, local('./validate.mjs'), sandboxBinary, workspace].map(quote).join(' ');
    return command(process.execPath, [local('../lanes/lane.mjs'), ...args], location, {
      ...env, LANE_CONFIG: configFile, LANE_VALIDATE: validation,
      MONITOR_PROJECT_CONFIG: path.join(project.canonical, '.lane.json'),
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'commit.gpgsign', GIT_CONFIG_VALUE_2: 'false',
    });
  };
  const context = () => ({ role, canonical: project.canonical, identity: project.identity, workspace,
    branch: role === 'worker' ? `lane/${topic}` : main, org, topic, run, item, report,
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
      const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      writeFileAtomic(file, JSON.stringify({ ...existing, ...selected, authority: `Operator answer to ${initial.routing.question}` }, null, 2) + '\n');
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
      const document = readReport(fs.readFileSync(report, 'utf8'));
      if (document.errors.length || document.report?.run !== run || document.report?.outcome !== 'done') throw new Error('promotion requires a valid done report for this run; record check explains report errors');
      const output = lane(['promote', topic], project.canonical);
      record(['note', run, 'Promoted by lane after clean rebase and sandboxed green validation; local fast-forward, no push.']);
      if (appliedRouting) record(['close', initial.routing.parent, '--note', 'Approved route configuration promoted and validated.']);
      return output;
    });
    if (op === 'finish') {
      const data = readReport(fs.readFileSync(report, 'utf8'));
      if (data.report?.run !== run) throw new Error('report must name this session run');
      if (data.report?.outcome === 'done') {
        const integrated = spawnSync('git', ['-C', workspace, 'merge-base', '--is-ancestor', 'HEAD', main]);
        if (integrated.status !== 0) throw new Error('done report requires successful promotion first; resolve/rebase, check and promote, or report blocked/needs_human without claiming integration');
      }
      record(['check', report]);
      return record(['ingest', report]);
    }
  };
  let processing = false;
  const poll = () => {
    if (processing) return;
    processing = true;
    try {
      for (const name of fs.readdirSync(requests).filter((p) => /^[0-9a-f-]+\.request\.json$/u.test(p))) {
        const file = path.join(requests, name), reply = file.replace('.request.', '.reply.');
        if (fs.existsSync(reply)) continue;
        let response;
        try {
          if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 8192) throw new Error('invalid request file');
          const request = JSON.parse(fs.readFileSync(file, 'utf8'));
          response = { result: dispatch(request) };
          audit.push({ op: request.op, success: true, at: new Date().toISOString() });
        } catch (e) { response = { error: e.message }; audit.push({ success: false, error: e.message }); }
        // Requests are agent-writable. Never follow an agent-created temporary
        // symlink from a privileged writer, and never accept a redirected queue.
        if (fs.realpathSync(requests) !== requests) throw new Error('request queue redirected');
        const temporary = `${reply}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(response) + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, reply);
      }
    } finally { processing = false; }
  };
  const close = () => {
    writeFileAtomic(path.join(project.canonical, '.lane/discovery', `${topic}.audit.json`), JSON.stringify(audit, null, 2) + '\n');
    fs.rmSync(requests, { recursive: true, force: true });
    fs.rmSync(metadata, { recursive: true, force: true });
    // Worktrees and records survive exit, failure and interrupted agents.
  };
  return { context, dispatch, poll, close };
}
