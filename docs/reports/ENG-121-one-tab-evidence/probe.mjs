// No models, dependencies, live operator socket, or release harness.
// Reproduce Herdr 0.8.2's tab-selection limitation in a private server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const version = spawnSync('herdr', ['--version'], { encoding: 'utf8' });
if (version.error?.code === 'ENOENT') {
  console.log('SKIP: Herdr is absent; private-server capability check requires Herdr.');
  process.exit(0);
}
assert.equal(version.status, 0, version.stderr);
const root = fs.mkdtempSync('/private/tmp/eng-121-herdr-');
const socket = path.join(root, 'herdr.sock');
const config = path.join(root, 'config.toml');
fs.writeFileSync(config, 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n');
const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root,
  HERDR_CONFIG_PATH: config, HERDR_SOCKET_PATH: socket };
for (const key of Object.keys(env)) {
  if (key.startsWith('HERDR_') && !['HERDR_CONFIG_PATH', 'HERDR_SOCKET_PATH'].includes(key)) delete env[key];
}
const log = fs.openSync(path.join(root, 'server.log'), 'w');
const server = spawn('herdr', ['server'], { cwd: root, env, stdio: ['ignore', log, log] });
const exited = new Promise((resolve, reject) => { server.once('exit', resolve); server.once('error', reject); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cli = (...args) => {
  const run = spawnSync('herdr', args, { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr || run.stdout || run.error?.message);
  const document = JSON.parse(run.stdout);
  assert.equal(document.error, undefined);
  return document.result;
};
const rpc = (method, params) => new Promise((resolve, reject) => {
  const connection = net.createConnection(socket);
  let buffer = '';
  const timer = setTimeout(() => finish(new Error('socket request timed out')), 5000);
  const finish = (error, result) => {
    clearTimeout(timer); connection.destroy();
    if (error) reject(error); else resolve(result);
  };
  connection.on('error', error => finish(error));
  connection.on('connect', () => connection.write(JSON.stringify({ id: 'probe', method, params }) + '\n'));
  connection.on('data', chunk => {
    buffer += chunk;
    if (!buffer.includes('\n')) return;
    try {
      const response = JSON.parse(buffer.split('\n')[0]);
      finish(response.error ? new Error(JSON.stringify(response.error)) : undefined, response.result);
    } catch (error) { finish(error); }
  });
});
const observations = { version: version.stdout.trim(), private_socket: socket };
try {
  for (let attempt = 0; attempt < 100 && !fs.existsSync(socket) && server.exitCode === null; attempt++) await pause(100);
  assert.ok(fs.existsSync(socket), fs.readFileSync(path.join(root, 'server.log'), 'utf8'));
  const repository = path.join(root, 'repository'), checkout = path.join(root, 'lane');
  fs.mkdirSync(repository);
  const git = (...args) => {
    const run = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 5000,
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.equal(run.status, 0, run.stderr);
  };
  git('init', '-b', 'main');
  git('-c', 'user.name=Capability Probe', '-c', 'user.email=probe@example.invalid', 'commit', '--allow-empty', '-m', 'Initial');
  git('worktree', 'add', '-b', 'lane/probe', checkout);
  const anchor = cli('workspace', 'create', '--cwd', repository, '--label', 'anchor', '--focus');
  cli('worktree', 'open', '--workspace', anchor.workspace.workspace_id, '--path', checkout, '--label', 'lane', '--no-focus');
  const initial = cli('api', 'snapshot').snapshot;
  const lane = initial.workspaces.find(workspace => workspace.worktree?.checkout_path === checkout);
  assert.ok(lane);
  const first = lane.active_tab_id;
  const second = cli('tab', 'create', '--workspace', lane.workspace_id, '--label', 'agent:probe', '--no-focus').tab.tab_id;
  const snapshot = () => {
    const state = cli('api', 'snapshot').snapshot;
    return { focused_workspace_id: state.focused_workspace_id, focused_tab_id: state.focused_tab_id,
      focused_pane_id: state.focused_pane_id,
      lane: state.workspaces.find(workspace => workspace.workspace_id === lane.workspace_id),
      tabs: state.tabs.filter(tab => tab.workspace_id === lane.workspace_id) };
  };
  observations.initial_tab = first;
  observations.agent_tab = second;
  observations.after_create = snapshot();
  assert.equal(observations.after_create.focused_workspace_id, anchor.workspace.workspace_id);
  assert.equal(observations.after_create.lane.active_tab_id, first);
  await rpc('tab.move', { tab_id: second, insert_index: 0 });
  observations.after_move = snapshot();
  assert.equal(observations.after_move.lane.active_tab_id, first);
  assert.equal(observations.after_move.focused_workspace_id, anchor.workspace.workspace_id);
  let focusTab = second;
  if (process.argv.includes('--layout')) {
    const agentPane = cli('api', 'snapshot').snapshot.panes.find(pane => pane.tab_id === second).pane_id;
    observations.layout_result = await rpc('layout.apply', {
      tab_id: second, focus: false, root: { type: 'pane', pane_id: agentPane },
    });
    observations.after_layout = snapshot();
    assert.equal(observations.after_layout.lane.active_tab_id, first);
    assert.equal(observations.after_layout.focused_workspace_id, anchor.workspace.workspace_id);
    observations.move_pane_result = await rpc('pane.move', {
      pane_id: observations.layout_result.layout.focused_pane_id, focus: false,
      destination: { type: 'new_tab', workspace_id: lane.workspace_id, label: 'moved-agent' },
    });
    observations.after_move_pane = snapshot();
    assert.equal(observations.after_move_pane.lane.active_tab_id, first);
    assert.equal(observations.after_move_pane.focused_workspace_id, anchor.workspace.workspace_id);
    focusTab = observations.move_pane_result.move_result.pane.tab_id;
  }
  // TabTarget has no focus field. Adding one does not add a no-focus operation.
  await rpc('tab.focus', { tab_id: focusTab, focus: false });
  observations.after_focus_false = snapshot();
  assert.equal(observations.after_focus_false.lane.active_tab_id, focusTab);
  assert.equal(observations.after_focus_false.focused_workspace_id, lane.workspace_id);
} finally {
  if (fs.existsSync(socket)) {
    try { cli('server', 'stop'); } catch { server.kill('SIGTERM'); }
  } else server.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (server.exitCode === null && Date.now() < deadline) await pause(50);
  if (server.exitCode === null) server.kill('SIGKILL');
  await exited;
  fs.closeSync(log);
  observations.server_exit_code = server.exitCode;
  console.log(JSON.stringify(observations, null, 2));
}
