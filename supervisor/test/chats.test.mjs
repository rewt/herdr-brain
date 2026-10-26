import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { joinFleet } from '../../lib/fleet.mjs';
import { openProjectChat, openStandardSession, herdrCommand } from '../chats.mjs';

const client = new URL('../../discovery/client.mjs', import.meta.url).pathname;
const fake = `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const file = process.env.CHAT_FAKE_STATE;
const state = JSON.parse(fs.readFileSync(file)), a = process.argv.slice(2);
state.calls.push(a);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const result = body => { save(); console.log(JSON.stringify({result: body})); };
const fail = message => { save(); console.error(message); process.exit(1); };
const runReply = () => { save();process.stdout.write(state.paneRunOutput ?? '');process.exit(state.paneRunExit ?? 0); };
if (state.fail === a.slice(0, 2).join(' ')) fail('injected failure');
const value = flag => a[a.indexOf(flag) + 1];
const environment = () => Object.fromEntries(a.flatMap((word, i) => word === '--env' ? [a[i+1].split(/=(.*)/s).slice(0, 2)] : []));
function create(workspace) {
  const number = ++state.counter, tab = { tab_id: workspace + ':t' + number, workspace_id: workspace, label: value('--label') };
  const pane = { pane_id: workspace + ':p' + number, tab_id: tab.tab_id, workspace_id: workspace, foreground_cwd: value('--cwd') };
  state.tabs.push(tab); state.panes.push(pane); state.env[pane.pane_id] = environment();
  return { tab, root_pane: pane };
}
if (a[0] === 'workspace' && a[1] === 'list') result({workspaces: state.spaces});
else if (a[0] === 'workspace' && a[1] === 'create') {
  const workspace = { workspace_id: 'control-' + ++state.counter, label: value('--label') };
  state.spaces.push(workspace); result({workspace, ...create(workspace.workspace_id)});
} else if (a[0] === 'tab' && a[1] === 'create') result(create(value('--workspace')));
else if (a[0] === 'tab' && a[1] === 'list') result({tabs: state.tabs.filter(t => t.workspace_id === value('--workspace'))});
else if (a[0] === 'tab' && a[1] === 'rename') { state.tabs.find(t => t.tab_id === a[2]).label = a[3]; result({}); }
else if (a[0] === 'tab' && a[1] === 'focus') { state.focus = a[2]; result({}); }
else if (a[0] === 'pane' && a[1] === 'get') result({pane: state.panes.find(p => p.pane_id === a[2])});
else if (a[0] === 'pane' && a[1] === 'process-info') result({process_info: {shell_pid: state.shellPid || 12, foreground_processes: [{pid: state.busy ? 13 : (state.shellPid || 12), name: 'zsh'}]}});
else if (a[0] === 'pane' && a[1] === 'read') {
  let screen = state.screen || 'checkout % ';
  if (state.updateReads > 0) { state.updateReads--; screen = 'Would you like to update? [Y/n]'; }
  if (state.updatePrompt) screen = 'Would you like to update? [Y/n]';
  save(); console.log(screen);
}
else if (a[0] === 'pane' && a[1] === 'run') {
  if (state.updatePrompt || state.updateReads > 0) fail('input swallowed by update prompt');
  const pane = state.panes.find(p => p.pane_id === a[2]); save();
  if (state.dropInput) { state.screen = a[3] + '\\ncheckout % '; runReply(); }
  const run = spawnSync('/bin/sh', ['-c', a[3]], {cwd: pane.foreground_cwd, env: {...process.env, ...state.env[a[2]]}, encoding: 'utf8'});
  if (run.status !== 0) fail(run.stderr);
  state.screen = (state.screen || '') + '\\n' + run.stdout + '\\ncheckout % ';
  runReply();
} else if (a[0] === 'agent' && a[1] === 'start') {
  const native = a.includes('--') ? a.slice(a.indexOf('--') + 1) : [];
  if (native.some(arg => /[\\x00-\\x1f\\x7f-\\x9f]/u.test(arg)))
    fail(JSON.stringify({error:{code:'invalid_agent_argument',message:'agent arguments cannot be encoded safely for the target shell'}}));
  if (state.startDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.startDelayMs);
  const pane = state.panes.find(p => p.pane_id === value('--pane'));
  const callerEnv = Object.fromEntries(['ORG_DIR', 'ORG_ACTOR', 'HERDR_AGENT_NAME', 'HERDR_MONITOR_FLEET',
    'MONITOR_SUPERVISOR_AGENT', 'MONITOR_SESSION_ROLE', 'LANE_CONFIG', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'CHAT_LAUNCHER_ONLY'].map(key => [key, process.env[key]]));
  const instructions = value('--kind') === 'claude' ? fs.readFileSync(native.at(-1), 'utf8')
    : JSON.parse(native.at(-1).slice('developer_instructions='.length));
  state.launches.push({kind: value('--kind'), args: native, instructions, env: state.env[pane.pane_id], callerEnv});
  if (!state.noDetect) state.agents.push({pane_id: pane.pane_id, agent: state.detectKind || value('--kind'),
    name: state.unnamed ? null : a[2], cwd: state.wrongCwd || pane.foreground_cwd});
  result({});
} else if (a[0] === 'agent' && a[1] === 'list') { if(state.emptyAgentList) { save();process.exit(0); } result({agents: state.agents}); }
else if (a[0] === 'agent' && a[1] === 'rename') { state.agents.find(p => p.pane_id === a[2]).name = a[3]; result({}); }
else fail('unexpected fake call: ' + JSON.stringify(a));
`;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-')));
  fixtureFleet(t, root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const stateFile = path.join(root, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({counter: 0, calls: [], spaces: [], tabs: [], panes: [], agents: [], env: {}, launches: [], focus: 'operator-work'}));
  fs.writeFileSync(path.join(bin, 'herdr'), fake, { mode: 0o755 });
  const env = { ...process.env, HERDR_BIN_PATH: path.join(bin, 'herdr'),
    ORG_DIR: '', HERDR_ORG_CONSOLE_CONFIG: path.join(root, 'absent-console.json'),
    HERDR_MONITOR_SUPERVISOR_HARNESS: 'codex', CHAT_FAKE_STATE: stateFile,
    MONITOR_SUPERVISOR_AGENT: 'foreign-ops', LANE_CONFIG: '/foreign/config',
    HERDR_MONITOR_CONTROL_WORKSPACE: '' };
  const projects = [0, 1].map(i => {
    const parent = path.join(root, `p${i}`); fs.mkdirSync(parent);
    const repo = path.join(parent, "same '$()` checkout"); fs.mkdirSync(repo);
    const git = args => { const r = spawnSync('git', ['-C', repo, ...args], {encoding: 'utf8'}); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Chat tests']); git(['config', 'user.email', 'chat@example.invalid']);
    fs.writeFileSync(path.join(repo, 'seed'), 'seed'); git(['add', '.']); git(['commit', '-qm', 'seed']);
    const config = path.join(parent, 'owned.json');
    fs.writeFileSync(config, JSON.stringify({ dispatch: { env: [`MONITOR_SUPERVISOR_AGENT=ops-${i}`] },
      routes: { executive: {kind: 'claude', model: 'model-chat', effort: 'high', args: ['--plugin-dir', '/space and quotes/it\'s-plugin']} },
      always_args: { codex: ['-p', `profile-${i}`] } }));
    const joined = joinFleet({cwd: repo, env, layers: [config], temp: path.join(root, `t${i}`)});
    return {...joined.project, name: joined.name, git};
  });
  const state = () => JSON.parse(fs.readFileSync(stateFile));
  const change = fn => { const s = state(); fn(s); fs.writeFileSync(stateFile, JSON.stringify(s)); };
  let time = 0;
  const open = (p = projects[0], extra = {}) => openProjectChat({ project: p.name, identity: p.identity, env, startupMs: 1000, now: () => time, sleep: ms => {time += ms;}, ...extra });
  const snapshot = dir => {
    const files = [];
    const visit = prefix => { for (const entry of fs.readdirSync(path.join(dir, prefix), {withFileTypes: true})) {
      const file = path.join(prefix, entry.name);
      if (entry.isDirectory()) visit(file); else files.push([file, fs.readFileSync(path.join(dir, file)).toString('base64')]);
    } }; visit(''); return files;
  };
  return {root, env, projects, state, change, open, snapshot};
}

test('default chat launches the native Codex harness with no sandbox preflight or Claude fallback', t => {
  const f = fixture(t), home = path.join(f.root, 'codex-home'); fs.mkdirSync(home);
  // A legacy native sandbox selector is the harness's business, not the launcher's.
  fs.writeFileSync(path.join(home, 'config.toml'), 'sandbox_mode = "workspace-write"\n'); f.env.CODEX_HOME = home;
  delete f.env.HERDR_MONITOR_SUPERVISOR_HARNESS; // Codex is the default.
  const receipt = f.open();
  assert.equal(receipt.kind, 'codex'); assert.equal(receipt.available, true);
  assert.equal(receipt.fallback, undefined); assert.equal(receipt.herdr_mode, undefined);
  assert.equal(f.state().launches[0].kind, 'codex');
  assert.equal(f.state().launches[0].args.length, 2);
  assert.equal(f.state().launches[0].args[0], '-c');
  assert.match(f.state().launches[0].args[1], /^developer_instructions=/);
  assert.ok(f.state().calls.some(a => a[0] === 'agent' && a[1] === 'start'));
  assert.ok(!f.state().launches[0].args.some(a => /sandbox|permission-profile|trust|socket/.test(a)));
  assert.equal(f.state().env[receipt.pane].MONITOR_SESSION_ROLE, 'chat');
  assert.equal(f.state().env[receipt.pane].MONITOR_SESSION_KIND, undefined, 'session kinds are gone');
  assert.equal(f.state().launches[0].env.MONITOR_SUPERVISOR_AGENT, 'ops-0');
});

test('one quiet chat per canonical fleet identity shares a control workspace, reopens by receipt, and preserves project files', t => {
  const f = fixture(t), before = f.projects.map(p => f.snapshot(p.checkout));
  const first = f.open(undefined, {focus: false});
  assert.equal(f.state().focus, 'operator-work');
  assert.match(first.name, /^chat-[a-f0-9]{24}$/); assert.equal(first.to, 'ops-0');
  const launch = f.state().launches[0];
  assert.equal(launch.args[0], '-c');
  assert.match(launch.args[1], /developer_instructions=.*project chat/);
  assert.equal(launch.env.ORG_DIR, f.projects[0].record); assert.equal(launch.env.ORG_ACTOR, first.name);
  assert.equal(f.state().env[first.pane].MONITOR_SESSION_ROLE, 'chat');
  assert.equal(launch.env.MONITOR_SUPERVISOR_AGENT, 'ops-0'); assert.equal(f.state().env[first.pane].MONITOR_SESSION_KIND, undefined);
   assert.equal(launch.env.LANE_CONFIG, '');
  f.change(s => {s.tabs[0].label = 'Operator renamed this';});
  const again = f.open(); assert.equal(again.reused, true); assert.equal(again.tab, first.tab); assert.equal(f.state().focus, first.tab);
  const second = f.open(f.projects[1], {focus: false});
  assert.equal(second.workspace, first.workspace); assert.notEqual(second.name, first.name); assert.equal(second.to, 'ops-1');
  assert.equal(f.state().spaces.length, 1); assert.equal(f.state().tabs.length, 2); assert.equal(f.state().launches.length, 2);
  assert.equal(f.state().focus, first.tab);
  assert.deepEqual(f.projects.map(p => f.snapshot(p.checkout)), before);
  for (const call of f.state().calls.filter(a => ['workspace', 'tab'].includes(a[0]) && a[1] === 'create')) assert.ok(call.includes('--no-focus'));
  assert.equal(f.state().calls.some(a => a.includes('prompt') || a.includes('close') || a.includes('send-keys')), false);
});

test('operator CLI works without entry, selects an existing control workspace, and uses project routes and explicit ops', t => {
  const f = fixture(t);
  f.change(s => {s.spaces.push({workspace_id: 'chosen', label: 'Custom control'});});
  const r = spawnSync(process.execPath, [client, 'chat', f.projects[0].name, '--workspace', 'chosen', '--route', 'executive', '--to', 'ops-explicit', '--no-focus'], {env: f.env, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  const receipt = JSON.parse(r.stdout); assert.equal(receipt.workspace, 'chosen'); assert.equal(receipt.to, 'ops-explicit');
  const launch = f.state().launches[0]; assert.equal(launch.kind, 'claude');
  assert.deepEqual(launch.args.slice(0, 6), ['--plugin-dir', "/space and quotes/it's-plugin", '--model', 'model-chat', '--effort', 'high']);
  assert.equal(launch.args[6], '--append-system-prompt-file');
  assert.match(launch.instructions, /project chat/);
  assert.equal(fs.statSync(launch.args[7]).mode & 0o777, 0o600);
  assert.equal(path.dirname(launch.args[7]), path.join(f.env.HERDR_MONITOR_FLEET, 'sessions/contexts'));
  assert.equal(launch.env.MONITOR_SUPERVISOR_AGENT, 'ops-explicit'); assert.equal(f.state().focus, 'operator-work');
  assert.equal(f.state().calls.some(a => a[0] === 'workspace' && a[1] === 'create'), false);
  assert.throws(() => f.open(f.projects[1], {workspace: 'other'}), /already use control workspace/);
});

test('failed or uncertain startup retains one tab and never launches again on reopen', t => {
  const f = fixture(t); f.change(s => {s.noDetect = true;});
  assert.throws(() => f.open(), /startup not detected.*retained tab/);
  const receipt = f.open(); assert.equal(receipt.reused, true); assert.equal(receipt.available, false);
  assert.equal(f.state().tabs.length, 1); assert.equal(f.state().launches.length, 1);
  assert.equal(f.state().focus, receipt.tab);
});

test('agent start can wait beyond ten seconds within the requested startup window', t => {
  const f = fixture(t); f.change(s => {s.startDelayMs = 10500;});
  const receipt = f.open(undefined, {startupMs: 12000});
  assert.equal(receipt.available, true);
  const start = f.state().calls.find(a => a[0] === 'agent' && a[1] === 'start');
  assert.equal(start[start.indexOf('--timeout') + 1], '12000');
  assert.equal(f.state().launches.length, 1);
});

test('agent start failure explains the retained tab and reopening never repeats the launch', t => {
  const f = fixture(t); f.change(s => {s.fail = 'agent start';});
  assert.throws(() => f.open(), /chat startup not detected; retained tab .*inspect before retrying: Herdr agent start: injected failure/);
  const receipt = f.open(); assert.equal(receipt.reused, true); assert.equal(receipt.available, false);
  assert.equal(f.state().tabs.length, 1);
  assert.equal(f.state().calls.filter(a => a[0] === 'agent' && a[1] === 'start').length, 1);
});

for (const kind of ['codex', 'claude']) test(`${kind} agent start caller receives the resolved chat environment over the launcher environment`, t => {
  const f = fixture(t), p = f.projects[0];
  const config = JSON.parse(fs.readFileSync(p.layers[0]));
  config.routes.account = {kind, env: ['CODEX_HOME=/route/codex', 'CLAUDE_CONFIG_DIR=/route/claude']};
  fs.writeFileSync(p.layers[0], JSON.stringify(config));
  Object.assign(f.env, {ORG_DIR: '/foreign/record', ORG_ACTOR: 'foreign-actor', HERDR_AGENT_NAME: 'foreign-agent',
    CODEX_HOME: '/foreign/codex', CLAUDE_CONFIG_DIR: '/foreign/claude', CHAT_LAUNCHER_ONLY: 'inherited'});
  const receipt = f.open(p, {route: 'account', to: 'ops-explicit'});
  const launch = f.state().launches[0];
  assert.match(launch.instructions, /\n/u);
  assert.equal(launch.args.some(arg => /[\x00-\x1f\x7f-\x9f]/u.test(arg)), false);
  const expected = {ORG_DIR: p.record, ORG_ACTOR: receipt.name, HERDR_AGENT_NAME: receipt.name,
    HERDR_MONITOR_FLEET: f.env.HERDR_MONITOR_FLEET, MONITOR_SUPERVISOR_AGENT: 'ops-explicit',
    MONITOR_SESSION_ROLE: 'chat', LANE_CONFIG: '', CODEX_HOME: '/route/codex', CLAUDE_CONFIG_DIR: '/route/claude'};
  assert.deepEqual(launch.env, expected);
  assert.deepEqual(launch.callerEnv, {...expected, CHAT_LAUNCHER_ONLY: 'inherited'});
  assert.equal(f.env.ORG_ACTOR, 'foreign-actor'); assert.equal(f.env.CLAUDE_CONFIG_DIR, '/foreign/claude');
});

test('shell readiness fails before sending input and retains a recoverable tab', t => {
  const f = fixture(t); f.change(s => {s.busy = true;});
  assert.throws(() => f.open(), /shell not ready/);
  assert.equal(f.state().launches.length, 0); assert.equal(f.state().focus, 'operator-work');
  assert.equal(f.open().reused, true); assert.equal(f.state().tabs.length, 1);
});

test('an unnamed detected launch is recovered only in the receipt pane with the same harness and checkout', t => {
  const f = fixture(t); f.change(s => {s.unnamed = true;});
  f.open();
  assert.equal(f.state().agents[0].name, null);
  f.change(s => {delete s.fail; s.agents[0].agent = 'claude';});
  assert.throws(() => f.open(), /another occupant/);
  f.change(s => {s.agents[0].agent = 'codex';});
  const receipt = f.open(undefined, {focus: false});
  assert.equal(receipt.reused, true); assert.equal(receipt.available, true);
  assert.equal(f.state().agents[0].name, receipt.name);
  assert.equal(f.state().tabs.length, 1); assert.equal(f.state().launches.length, 1);
  assert.equal(f.state().focus, receipt.tab);
});

test('late detection after timeout recovers the unnamed chat without replaying launch', t => {
  const f = fixture(t); f.change(s => {s.noDetect = true;});
  assert.throws(() => f.open(), /startup not detected/);
  const stored = JSON.parse(fs.readFileSync(path.join(f.env.HERDR_MONITOR_FLEET, 'chats.json'))).projects[f.projects[0].identity];
  f.change(s => {s.agents.push({pane_id: stored.pane, agent: stored.kind, cwd: stored.checkout, name: null});});
  assert.equal(f.open().available, true);
  assert.equal(f.state().agents[0].name, stored.name);
  assert.equal(f.state().launches.length, 1);
});

test('an oh-my-zsh builtin update question never receives shell input', t => {
  const f = fixture(t); f.change(s => {s.updatePrompt = true;});
  assert.throws(() => f.open(), /shell not ready/);
  assert.equal(f.state().calls.some(a => a[0] === 'pane' && a[1] === 'run'), false);
  assert.equal(f.state().launches.length, 0);
});

test('startup waits through an update question before proving prompt and command execution', t => {
  const f = fixture(t); f.change(s => {s.updateReads = 3;});
  const receipt = f.open(undefined, {focus: false});
  assert.equal(receipt.available, true);
  const calls = f.state().calls;
  const firstInput = calls.findIndex(a => a[0] === 'pane' && a[1] === 'run');
  assert.equal(calls.slice(0, firstInput).filter(a => a[0] === 'pane' && a[1] === 'read').length, 5);
  assert.equal(f.state().launches.length, 1); assert.equal(f.state().focus, 'operator-work');
});

test('echoed probe input is not execution proof and cannot launch an agent', t => {
  const f = fixture(t); f.change(s => {s.dropInput = true;});
  assert.throws(() => f.open(), /shell not ready/);
  assert.equal(f.state().launches.length, 0);
  assert.equal(f.state().calls.filter(a => a[0] === 'pane' && a[1] === 'run').length, 1);
});


function prototype(f) {
  const p = f.projects[0];
  f.change(s => {
    s.spaces.push({workspace_id: 'w2XS', label: 'chats'});
    s.tabs.push({tab_id: 'w2XS:prototype', workspace_id: 'w2XS', label: p.name});
    s.panes.push({pane_id: 'w2XS:chat', tab_id: 'w2XS:prototype', workspace_id: 'w2XS', foreground_cwd: p.checkout});
    s.agents.push({pane_id: 'w2XS:chat', name: `chat-${p.name}`, agent: 'claude', cwd: p.checkout});
    s.env['w2XS:chat'] = {CLAUDE_CONFIG_DIR: '/personal/config', LEGACY_RECEIPT: 'unchanged'};
  });
}

test('the named prototype in chats is adopted unchanged and other projects join that workspace', t => {
  const f = fixture(t); prototype(f);
  // Adoption must not need the default adapter or relaunch using its account.
  const receipt = f.open();
  assert.equal(receipt.reused, true); assert.equal(receipt.kind, 'claude');
  assert.equal(receipt.workspace, 'w2XS'); assert.equal(receipt.pane, 'w2XS:chat');
  assert.equal(receipt.name, `chat-${f.projects[0].name}`);
  assert.equal(Object.hasOwn(receipt, 'to'), false, 'adoption cannot infer the running recipient from routes');
  assert.equal(f.state().focus, 'w2XS:prototype');
  assert.deepEqual(f.state().env[receipt.pane], {CLAUDE_CONFIG_DIR: '/personal/config', LEGACY_RECEIPT: 'unchanged'});
  assert.equal(f.state().calls.some(a => ['create', 'run', 'rename'].includes(a[1])), false);
  f.change(s => {s.tabs[0].label = 'My ongoing conversation';});
  assert.equal(f.open().tab, receipt.tab);
  const second = f.open(f.projects[1], {kind: 'claude', focus: false});
  assert.equal(second.workspace, 'w2XS'); assert.equal(f.state().spaces.length, 1);
  assert.equal(f.state().tabs.length, 2); assert.equal(f.state().launches.length, 1);
  assert.equal(f.state().focus, receipt.tab);
});

test('prototype adoption and reopening ignore unusable launch configuration and selectors', t => {
  const f = fixture(t), p = f.projects[0]; prototype(f);
  fs.writeFileSync(p.layers[0], '{broken');
  f.env.HERDR_MONITOR_SUPERVISOR_HARNESS = 'unsupported';
  const before = f.snapshot(p.checkout);
  const receipt = f.open(p, {route: 'missing', kind: 'unsupported', to: 'chat-other', args: ['\0'], focus: false});
  assert.equal(receipt.kind, 'claude'); assert.equal(receipt.available, true);
  assert.equal(Object.hasOwn(receipt, 'to'), false);
  const saved = JSON.parse(fs.readFileSync(path.join(f.env.HERDR_MONITOR_FLEET, 'chats.json'))).projects[p.identity];
  assert.deepEqual(saved, {workspace: 'w2XS', tab: 'w2XS:prototype', pane: 'w2XS:chat',
    name: `chat-${p.name}`, checkout: p.checkout, record: p.record, kind: 'claude'});
  assert.equal(f.open(p, {route: 'missing', focus: false}).pane, receipt.pane);
  assert.deepEqual(f.snapshot(p.checkout), before);
  assert.deepEqual(f.state().env[receipt.pane], {CLAUDE_CONFIG_DIR: '/personal/config', LEGACY_RECEIPT: 'unchanged'});
  assert.equal(f.state().focus, 'operator-work');
  assert.equal(f.state().calls.some(a => ['create', 'run', 'rename', 'start'].includes(a[1])), false);
  // A different project still needs valid routes to launch a new chat.
  assert.throws(() => f.open(f.projects[1], {route: 'missing', focus: false}), /route/);
});

test('prototype adoption refuses a foreign checkout or a pane outside the chats workspace', t => {
  const f = fixture(t); prototype(f);
  f.change(s => {s.agents[0].cwd = f.projects[1].checkout;});
  assert.throws(() => f.open(), /prototype chat binding differs/);
  f.change(s => {s.agents[0].cwd = f.projects[0].checkout; s.panes[0].workspace_id = 'elsewhere';});
  assert.throws(() => f.open(), /outside the control workspace/);
  assert.equal(f.state().launches.length, 0); assert.equal(f.state().focus, 'operator-work');
});

test('chat recipients are rejected, failed topology reads stay errors, and foreign or moved occupants are never adopted', t => {
  const f = fixture(t);
  assert.throws(() => f.open(undefined, {to: 'chat-other'}), /never a project chat/);
  f.change(s => {s.fail = 'workspace list';}); assert.throws(() => f.open(), /injected failure/);
  f.change(s => {delete s.fail;});
  const receipt = f.open();
  f.change(s => {s.agents[0].cwd = f.projects[1].checkout;});
  const count = f.state().calls.filter(a => a[1] === 'focus').length;
  assert.throws(() => f.open(), /another occupant/);
  assert.equal(f.state().calls.filter(a => a[1] === 'focus').length, count);
  f.change(s => {s.tabs = [];});
  assert.throws(() => f.open(), /outside its recorded tab/);
  assert.equal(f.state().launches.length, 1); assert.equal(f.state().spaces.length, 1);
  assert.equal(receipt.to, 'ops-0');
});

test('a closed chat tab can be recreated while the other project remains in the same workspace', t => {
  const f = fixture(t), first = f.open(), second = f.open(f.projects[1]);
  f.change(s => {s.tabs = s.tabs.filter(t => t.tab_id !== first.tab); s.panes = s.panes.filter(p => p.pane_id !== first.pane); s.agents = s.agents.filter(a => a.pane_id !== first.pane);});
  const replacement = f.open(); assert.notEqual(replacement.tab, first.tab); assert.equal(replacement.workspace, second.workspace);
  assert.equal(f.state().tabs.length, 2); assert.equal(f.open(f.projects[1]).tab, second.tab);
});

test('an existing named control workspace is reused and ambient recipients never cross project boundaries', t => {
  const f = fixture(t), p = f.projects[0];
  const layer = JSON.parse(fs.readFileSync(p.layers[0])); delete layer.dispatch;
  fs.writeFileSync(p.layers[0], JSON.stringify(layer));
  f.change(s => {s.spaces.push({workspace_id: 'brain', label: 'chats'});});
  const receipt = f.open(undefined, {focus: false}); assert.equal(receipt.workspace, 'brain'); assert.equal(receipt.to, 'supervisor-herdr');
  assert.equal(f.state().launches[0].env.MONITOR_SUPERVISOR_AGENT, 'supervisor-herdr');
  assert.equal(f.state().spaces.length, 1); assert.equal(f.state().focus, 'operator-work');
});

test('committed read/scoped chat settings and older receipts with any herdr_mode open full chats', t => {
  const f = fixture(t), p = f.projects[0];
  fs.writeFileSync(path.join(p.checkout, '.lane.json'), JSON.stringify({ chat: { herdr_mode: 'scoped', presets: { wallet: { command: 'fixed-command', cwd: p.checkout } } } }));
  p.git(['add', '.lane.json']); p.git(['commit', '-qm', 'Scoped chat']);
  const opened = f.open(undefined, { kind: 'codex' });
  assert.equal(opened.kind, 'codex'); assert.equal(opened.herdr_mode, undefined);
  const file = path.join(f.env.HERDR_MONITOR_FLEET, 'chats.json');
  for (const mode of ['read', 'scoped', 'full', 'retired-mode']) {
    const state = JSON.parse(fs.readFileSync(file)); state.projects[p.identity].herdr_mode = mode;
    fs.writeFileSync(file, JSON.stringify(state));
    const again = f.open(); assert.equal(again.reused, true); assert.equal(again.tab, opened.tab);
  }
  assert.equal(f.state().launches.length, 1);

});

test('unknown and stale fleet projects fail before Herdr mutations while retired entry settings are ignored', t => {
  const f = fixture(t), p = f.projects[0];
  assert.throws(() => f.open(p, { project: 'not-joined' }), /unknown fleet/);
  assert.throws(() => f.open(p, { identity: '/different/.git' }), /identity changed/);
  const file = path.join(f.env.HERDR_MONITOR_FLEET, 'fleet.json'), raw = JSON.parse(fs.readFileSync(file));
  raw.projects[p.name].identity = '/missing/.git'; fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => f.open(p, { identity: undefined }), /stale fleet/);
  assert.deepEqual(f.state().calls, []);
  raw.projects[p.name].identity = p.identity; raw.excluded_roots = [p.checkout];
  fs.writeFileSync(file, JSON.stringify(raw));
  fs.writeFileSync(path.join(p.checkout, '.lane.json'), JSON.stringify({ entry: { enabled: false }, chat: false, always_args: 'retired' }));
  assert.equal(f.open().available, true);
});

test('standard supervisor and chat argv are byte-identical with disabled, enabled or invalid hook config', t => {
  const f = fixture(t), project = f.projects[0], file = path.join(project.checkout, '.hook-pull.json');
  f.change(s => s.spaces.push({ workspace_id: 'standard', label: 'Standard' }));
  for (const role of ['supervisor', 'chat']) {
    let expected;
    for (const config of [undefined, '{"enabled":false}', '{"enabled":true}', '{broken']) {
      if (config === undefined) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, config);
      openStandardSession({ target: { workspace: 'standard', checkout: project.checkout }, create: true,
        launch: { kind: 'claude', args: ['--settings', 'owner settings'], env: [], model: 'model', effort: 'high' },
        name: 'standard-conversation', role, record: project.record, instructions: 'Conversation',
        env: f.env, herdr: herdrCommand(f.env), startupMs: 1000 });
      const launch = f.state().launches.at(-1), args = launch.args.slice(0, -1);
      expected ??= JSON.stringify(args); assert.equal(JSON.stringify(args), expected);
      assert.deepEqual(args, ['--settings', 'owner settings', '--model', 'model', '--effort', 'high', '--append-system-prompt-file']);
      assert.equal(launch.instructions, 'Conversation');
    }
  }
  assert.equal(fs.existsSync(path.join(project.identity, 'sessions/hook-pull')), false);
});

test('standard launch argument failure occurs before tab creation', t => {
  const f = fixture(t), project = f.projects[0];
  assert.throws(() => openStandardSession({ target: { workspace: 'standard', checkout: project.checkout }, create: true,
    launch: { kind: 'claude', args: null, env: [] }, name: 'standard-conversation', role: 'supervisor',
    record: project.record, instructions: 'Conversation', env: f.env, herdr: herdrCommand(f.env) }), TypeError);
  assert.deepEqual(f.state().calls, []);
});

test('standard session proves the marker with empty or whitespace pane run output', t => {
  const f=fixture(t), p=f.projects[0];
  for(const output of ['', ' \n\t', '{"result":{}}']) {
    f.change(s=>s.paneRunOutput=output);
    const receipt=openStandardSession({target:{workspace:'standard',checkout:p.checkout},create:true,
      launch:{kind:'claude',args:[],env:[]},name:'standard-conversation',role:'chat',record:p.record,
      instructions:'Conversation',env:f.env,herdr:herdrCommand(f.env),startupMs:1000});
    assert.ok(receipt.pane);assert.match(f.state().screen,/chat-ready-/);
  }
  assert.equal(f.state().launches.length,3);
});
test('empty failing pane run and empty agent list fail, and malformed pane run stays strict', t => {
  const f=fixture(t);f.change(s=>s.paneRunExit=7);
  assert.throws(()=>f.open(),/Herdr pane run/);assert.equal(f.state().launches.length,0);
  f.change(s=>{s.paneRunExit=0;s.paneRunOutput='malformed';});
  assert.throws(()=>herdrCommand(f.env)(['pane','run',f.state().panes[0].pane_id,"printf '%s' 'marker'"]),SyntaxError);
  f.change(s=>s.emptyAgentList=true);
  assert.throws(()=>herdrCommand(f.env)(['agent','list']),SyntaxError);
});

test('fake Herdr rejects inline multiline and control arguments before starting a chat', t => {
  const f = fixture(t), herdr = herdrCommand(f.env);
  for (const control of ['\n', '\r', '\t', '\x01', '\x7f', '\x85']) {
    assert.throws(() => herdr(['agent', 'start', 'inline', '--kind', 'claude', '--pane', 'unused',
      '--', '--append-system-prompt', 'first' + control + 'second']), /invalid_agent_argument/);
  }
  assert.equal(f.state().launches.length, 0);
  assert.equal(f.state().agents.length, 0);
});

for (const kind of ['claude', 'codex']) test(kind + ' standard launch preserves multiline instructions without control characters in argv', t => {
  const f = fixture(t), p = f.projects[0], instructions = 'First line\nSecond line\r\nTabs\tand controls \x01; Unicode café 🐑';
  openStandardSession({ target: { workspace: 'standard', checkout: p.checkout }, create: true,
    launch: { kind, args: [], env: [] }, name: 'standard-conversation', role: 'chat', record: p.record,
    instructions, operationId: 'multiline-launch', common: p.identity,
    env: f.env, herdr: herdrCommand(f.env), startupMs: 1000 });
  const launch = f.state().launches.at(-1);
  assert.equal(launch.instructions, instructions);
  assert.equal(launch.args.some(arg => /[\x00-\x1f\x7f-\x9f]/u.test(arg)), false);
  if (kind === 'claude') {
    assert.equal(launch.args.at(-2), '--append-system-prompt-file');
    assert.equal(launch.args.at(-1), path.join(p.identity, 'sessions/contexts/multiline-launch.instructions.md'));
    assert.equal(fs.statSync(launch.args.at(-1)).mode & 0o777, 0o600);
  } else {
    assert.equal(launch.args.at(-2), '-c');
    assert.match(launch.args.at(-1), /developer_instructions=.*\\n.*\\r\\n.*\\t.*\\u0001/u);
  }
});

test('standard launch refuses control characters in route arguments before creating a tab', t => {
  const f = fixture(t), p = f.projects[0];
  for (const kind of ['claude', 'codex']) assert.throws(() => openStandardSession({
    target: { workspace: 'standard', checkout: p.checkout }, create: true,
    launch: { kind, args: ['--example', 'bad\nargument'], env: [] },
    name: 'standard-conversation', role: 'chat', record: p.record, instructions: 'Conversation',
    env: f.env, herdr: herdrCommand(f.env) }), /control character/);
  assert.deepEqual(f.state().calls, []);
});

test('project chat refuses control characters in route arguments before any Herdr mutation', t => {
  for (const kind of ['claude', 'codex']) for (const existingWorkspace of [false, true]) {
    const f = fixture(t), p = f.projects[0], config = JSON.parse(fs.readFileSync(p.layers[0]));
    config.routes.invalid = { kind, args: ['--example', 'bad\nargument'] };
    fs.writeFileSync(p.layers[0], JSON.stringify(config));
    if (existingWorkspace) f.change(s => s.spaces.push({ workspace_id: 'control', label: 'chats' }));
    const before = f.state();
    assert.throws(() => f.open(p, { route: 'invalid' }), /control character/);
    const after = f.state();
    assert.deepEqual(after.spaces, before.spaces);
    assert.deepEqual(after.tabs, []);
    assert.deepEqual(after.panes, []);
    assert.deepEqual(after.launches, []);
    assert.equal(after.calls.every(a => a[1] === 'list'), true);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_MONITOR_FLEET, 'chats.json')), false);
    assert.equal(fs.existsSync(path.join(f.env.HERDR_MONITOR_FLEET, 'sessions/contexts')), false);
  }
});

test('Codex launches instructions containing DEL and C1 using lossless Unicode escapes', t => {
  const f = fixture(t), p = f.projects[0], instructions = 'DEL \x7f and C1 \x85\nEnd.';
  openStandardSession({ target: { workspace: 'standard', checkout: p.checkout }, create: true,
    launch: { kind: 'codex', args: [], env: [] }, name: 'standard-conversation', role: 'chat',
    record: p.record, instructions, env: f.env, herdr: herdrCommand(f.env), startupMs: 1000 });
  assert.equal(f.state().launches.length, 1);
  const launch = f.state().launches[0];
  assert.equal(launch.instructions, instructions);
  assert.match(launch.args.at(-1), /\\u007f/u);
  assert.match(launch.args.at(-1), /\\u0085/u);
  assert.equal(launch.args.some(arg => /[\x00-\x1f\x7f-\x9f]/u.test(arg)), false);
});
