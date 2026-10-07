// Operator-created project conversations. Receipts belong to the machine's
// fleet home; project files and records are only read by this launcher.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { spawnSync } from 'node:child_process';
import { readFleet, staleProject, excludedFleetRoot } from '../lib/fleet.mjs';
import { writeFileAtomic } from '../lib/files.mjs';
import { withInstallationLock } from '../herdr/entry-lock.mjs';
import { loadDiscoveredRoutes, resolveLaunchRoute } from '../lanes/routes.mjs';
import { projectEntrySettings } from '../discovery/settings.mjs';
import { gitProject } from '../lib/project.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const agentName = identity => `chat-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
const id = (value, label) => {
  if (typeof value !== 'string' || !value) throw new Error(`Herdr returned no ${label}; inspect before retrying`);
  return value;
};
const agents = herdr => {
  const rows = herdr(['agent', 'list']).agents;
  if (!Array.isArray(rows)) throw new Error('Herdr returned no agent list');
  return rows;
};
const inCheckout = (cwd, project) => {
  const git = gitProject(cwd);
  return git.identity === project.identity && git.checkout === project.checkout;
};
const paneText = (herdr, pane, source = 'visible') => {
  const text = herdr(['pane', 'read', pane, '--source', source, '--format', 'text']).text;
  if (typeof text !== 'string') throw new Error('Herdr returned no pane text');
  return stripVTControlCharacters(text).replaceAll('\r', '');
};
const markerCommand = marker => `printf '\\n%s%s\\n' ${quote(marker.slice(0, 24))} ${quote(marker.slice(24))}`;

function waitForShell(herdr, receipt, project, { now, sleep, startupMs }) {
  const deadline = now() + startupMs;
  let previous;
  do {
    const info = herdr(['pane', 'process-info', '--pane', receipt.pane]).process_info;
    const pane = herdr(['pane', 'get', receipt.pane]).pane;
    const screen = paneText(herdr, receipt.pane).trimEnd();
    const shell = Number.isSafeInteger(info?.shell_pid) && info.shell_pid > 0 &&
      info.foreground_processes?.length === 1 && info.foreground_processes[0].pid === info.shell_pid &&
      pane?.foreground_cwd === project.checkout;
    // A shell can own the foreground while an rc builtin reads an answer.
    // Require a stable prompt as well, then prove it executes harmless input.
    const prompt = shell && /[$#%❯➜›]$/u.test(screen.split('\n').at(-1) ?? '');
    if (prompt && previous === screen) {
      const marker = `chat-ready-${randomBytes(24).toString('hex')}`;
      herdr(['pane', 'run', receipt.pane, markerCommand(marker)]);
      do {
        if (paneText(herdr, receipt.pane, 'recent-unwrapped').split('\n').includes(marker)) return;
        sleep(100);
      } while (now() < deadline);
      break;
    }
    previous = prompt ? screen : undefined;
    sleep(100);
  } while (now() < deadline);
  throw new Error(`chat shell not ready; retained tab ${receipt.tab}, nothing launched`);
}

export function herdrCommand(env = process.env) {
  return args => {
    const reply = spawnSync(env.HERDR_BIN_PATH || 'herdr', args, { env, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    if (reply.error || reply.status !== 0) throw new Error(`Herdr ${args.slice(0, 2).join(' ')}: ${(reply.stderr || reply.stdout || reply.error?.message).trim()}`);
    if (args[0] === 'pane' && args[1] === 'read' && args.includes('text')) return { text: reply.stdout };
    const body = JSON.parse(reply.stdout);
    if (!body.result || body.ok === false) throw new Error(`Herdr ${args.slice(0, 2).join(' ')} returned an invalid result`);
    return body.result;
  };
}

export function openProjectChat({ project: name, identity, workspace, kind, route, to, args = [], focus = true,
  env = process.env, herdr = herdrCommand(env), now = Date.now, sleep = pause, startupMs = 30000 } = {}) {
  const fleet = readFleet(env);
  const project = fleet && Object.hasOwn(fleet.projects, name ?? '') ? fleet.projects[name] : null;
  if (!project) throw new Error(`unknown fleet project: ${name ?? '(choose a project)'}`);
  if (identity && project.identity !== identity) throw new Error(`fleet identity changed for ${name}; refresh before opening its chat`);
  if (staleProject(project)) throw new Error(`stale fleet project ${name}: ${project.checkout}`);
  if (excludedFleetRoot(project.checkout, fleet)) throw new Error(`fleet project ${name} is excluded`);
  if (!projectEntrySettings({ canonical: project.checkout }).enabled) throw new Error(`project ${name} has opted out of Monitor entry`);

  const home = path.dirname(fleet.file), file = path.join(home, 'chats.json');
  return withInstallationLock(path.join(home, 'chats.lock'), () => {
    let state = { version: 1, workspace: null, projects: {} };
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error(`invalid chat receipts ${file}: ${e.message}`); }
    if (state?.version !== 1 || !state.projects || typeof state.projects !== 'object' || Array.isArray(state.projects)) throw new Error(`invalid chat receipts ${file}`);
    const spaces = herdr(['workspace', 'list']).workspaces;
    if (!Array.isArray(spaces)) throw new Error('Herdr returned no workspace list');
    const requested = workspace || env.HERDR_MONITOR_CONTROL_WORKSPACE;
    let control = spaces.find(w => w.workspace_id === state.workspace);
    if (control && requested && requested !== control.workspace_id) throw new Error(`project chats already use control workspace ${control.workspace_id}`);
    if (!control && requested) {
      control = spaces.find(w => w.workspace_id === requested);
      if (!control) throw new Error(`control workspace ${requested} is not open`);
    }
    if (!control) {
      const matches = spaces.filter(w => w.label === 'chats');
      if (matches.length > 1) throw new Error('multiple chats workspaces; select one with --workspace');
      control = matches[0];
    }
    const saved = state.projects[project.identity];
    if (control && saved?.workspace === control.workspace_id) {
      const tabs = herdr(['tab', 'list', '--workspace', control.workspace_id]).tabs;
      if (!Array.isArray(tabs)) throw new Error('Herdr returned no tab list');
      const tab = tabs.find(t => t.tab_id === saved.tab);
      if (tab) {
        if (saved.checkout !== project.checkout || saved.record !== project.record ||
          ![agentName(project.identity), `chat-${name}`].includes(saved.name)) throw new Error('chat binding changed; inspect the existing tab');
        const pane = herdr(['pane', 'get', saved.pane]).pane;
        if (pane?.tab_id !== saved.tab || pane.workspace_id !== control.workspace_id) throw new Error('chat pane moved; inspect its binding');
        if (!inCheckout(pane.foreground_cwd, project)) throw new Error('chat pane checkout changed; inspect before reopening');
        const live = agents(herdr), occupant = live.find(a => a.pane_id === saved.pane);
        if (occupant && (occupant.agent !== saved.kind || !inCheckout(occupant.cwd, project) ||
          (occupant.name && occupant.name !== saved.name))) throw new Error('chat pane has another occupant; inspect before reopening');
        if (occupant && !occupant.name) {
          if (live.some(a => a.name === saved.name && a.pane_id !== saved.pane)) throw new Error('chat name is occupied outside its recorded pane');
          herdr(['agent', 'rename', saved.pane, saved.name]);
        }
        if (focus) herdr(['tab', 'focus', saved.tab]);
        return { ...saved, project: name, reused: true, available: Boolean(occupant) };
      }
    }

    // Resolve only this project's settings. Inherited worker/other-project
    // LANE_CONFIG and notice recipients must not select its launch account.
    const { config } = loadDiscoveredRoutes({ cwd: project.checkout, env: { ...env, LANE_CONFIG: undefined } });
    const bin = env.HERDR_MONITOR_ENTRY_BIN || path.join(env.HERDR_MONITOR_HOME || path.join(os.homedir(), '.local/share/herdr-monitor'), 'entry/bin');
    const harness = kind || env.HERDR_MONITOR_SUPERVISOR_HARNESS || (fs.existsSync(path.join(bin, 'monitor-codex')) ? 'codex' : 'claude');
    const launch = resolveLaunchRoute(config, { ...(route ? { route } : { kind: harness }), args });
    if (!['codex', 'claude'].includes(launch.kind)) throw new Error('project chats require codex or claude');
    const chat = agentName(project.identity);
    if (agents(herdr).some(a => a.name === chat)) throw new Error('project chat exists outside its recorded tab; inspect before opening another');
    const pairs = new Map(launch.env.map(pair => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(pair) || pair.includes('\0')) throw new Error('invalid chat launch environment');
      const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)];
    }));
    const ops = to || pairs.get('MONITOR_SUPERVISOR_AGENT') || 'supervisor-herdr';
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(ops) || ops.startsWith('chat-')) throw new Error('notice recipient must be an ops agent, never a project chat');
    // Adopt the operator's prototype without restarting it or changing its
    // account, entry bypass or conversation. Labels alone never bind a chat.
    const prototypes = agents(herdr).filter(a => a.name === `chat-${name}`);
    if (prototypes.length) {
      const prototype = prototypes[0];
      if (prototypes.length !== 1 || !control || !['claude', 'codex'].includes(prototype.agent) || !inCheckout(prototype.cwd, project)) throw new Error('prototype chat binding differs; inspect before adopting');
      const pane = herdr(['pane', 'get', prototype.pane_id]).pane;
      const tabs = herdr(['tab', 'list', '--workspace', control.workspace_id]).tabs;
      if (pane?.workspace_id !== control.workspace_id || !Array.isArray(tabs) ||
        !tabs.some(t => t.tab_id === pane.tab_id) || !inCheckout(pane.foreground_cwd, project)) throw new Error('prototype chat is outside the control workspace or checkout; inspect before adopting');
      const receipt = { workspace: control.workspace_id, tab: pane.tab_id, pane: prototype.pane_id,
        name: prototype.name, checkout: project.checkout, record: project.record, kind: prototype.agent, to: ops };
      state.workspace = receipt.workspace; state.projects[project.identity] = receipt;
      writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n', 0o600);
      if (focus) herdr(['tab', 'focus', receipt.tab]);
      return { ...receipt, project: name, reused: true, available: true };
    }
    const adapter = path.join(bin, `monitor-${launch.kind}`);
    fs.accessSync(adapter, fs.constants.X_OK);
    for (const [key, value] of Object.entries({ ORG_DIR: project.record, ORG_ACTOR: chat, HERDR_AGENT_NAME: chat,
      HERDR_MONITOR_FLEET: home, MONITOR_SUPERVISOR_AGENT: ops, MONITOR_SESSION_KIND: 'chat',
      MONITOR_SESSION_ROLE: 'chat', MONITOR_ENTRY_BYPASS: '1', MONITOR_REQUEST_DIR: '', MONITOR_RUNTIME_DIR: '',
      MONITOR_WORKTREE_ROOT: '', LANE_CONFIG: '', HERDR_PLUGIN_CONTEXT_JSON: '', HERDR_PLUGIN_ROOT: '' })) pairs.set(key, value);
    const environment = [...pairs].flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    let created;
    if (!control) {
      created = herdr(['workspace', 'create', '--cwd', project.checkout, '--label', 'chats', '--no-focus', ...environment]);
      control = created.workspace;
      id(control?.workspace_id, 'workspace id');
      herdr(['tab', 'rename', id(created.tab?.tab_id, 'tab id'), name]);
    } else created = herdr(['tab', 'create', '--workspace', control.workspace_id, '--cwd', project.checkout, '--label', name, '--no-focus', ...environment]);
    const receipt = { workspace: control.workspace_id, tab: id(created.tab?.tab_id, 'tab id'), pane: id(created.root_pane?.pane_id, 'pane id'),
      name: chat, checkout: project.checkout, record: project.record, kind: launch.kind, to: ops };
    state.workspace = receipt.workspace;
    state.projects[project.identity] = receipt;
    // Retain the tab even if startup fails or its reply is lost. Reopening
    // never types a second launch into an uncertain pane or creates a duplicate.
    writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n', 0o600);
    waitForShell(herdr, receipt, project, { now, sleep, startupMs });
    const native = [...launch.args];
    if (launch.model) native.push('--model', launch.model);
    if (launch.effort) native.push(...(launch.kind === 'codex' ? ['-c', `model_reasoning_effort=${launch.effort}`] : ['--effort', launch.effort]));
    const clean = ['MONITOR_REQUEST_DIR', 'MONITOR_RUNTIME_DIR', 'MONITOR_WORKTREE_ROOT', 'LANE_CONFIG', 'HERDR_PLUGIN_CONTEXT_JSON', 'HERDR_PLUGIN_ROOT'];
    const started = `chat-started-${randomBytes(24).toString('hex')}`;
    const command = ['/usr/bin/env', ...clean.flatMap(key => ['-u', key]),
      adapter, '--repo', project.checkout, '--role', 'chat', '--', ...native].map(quote).join(' ');
    herdr(['pane', 'run', receipt.pane, ['/bin/sh', '-c', `${markerCommand(started)}; exec ${command}`].map(quote).join(' ')]);
    const detectionDeadline = now() + startupMs;
    let detected, verified = false;
    do {
      verified ||= paneText(herdr, receipt.pane, 'recent-unwrapped').split('\n').includes(started);
      detected = agents(herdr).find(a => a.pane_id === receipt.pane && a.agent === launch.kind);
      if (detected && verified) break;
      sleep(100);
    } while (now() < detectionDeadline);
    if (!detected || !verified) throw new Error(`chat startup not detected or command unverified; retained tab ${receipt.tab}, inspect before retrying`);
    if (!inCheckout(detected.cwd, project)) throw new Error(`chat started in another checkout; inspect tab ${receipt.tab}`);
    herdr(['agent', 'rename', receipt.pane, chat]);
    if (focus) herdr(['tab', 'focus', receipt.tab]);
    return { ...receipt, project: name, reused: false, available: true };
  });
}
