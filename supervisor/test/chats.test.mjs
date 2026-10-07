import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { joinFleet } from '../../lib/fleet.mjs';
import { openProjectChat } from '../chats.mjs';

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
else if (a[0] === 'pane' && a[1] === 'process-info') result({process_info: {shell_pid: 12, foreground_processes: [{pid: state.busy ? 13 : 12, name: 'zsh'}]}});
else if (a[0] === 'pane' && a[1] === 'run') {
  const pane = state.panes.find(p => p.pane_id === a[2]); save();
  const run = spawnSync('/bin/sh', ['-c', a[3]], {cwd: pane.foreground_cwd, env: {...process.env, ...state.env[a[2]]}, encoding: 'utf8'});
  if (run.status !== 0) fail(run.stderr);
  state.launches.push(JSON.parse(run.stdout));
  if (!state.noDetect) state.agents.push({pane_id: a[2], agent: state.detectKind || state.launches.at(-1).kind, name: null,
    cwd: state.wrongCwd || pane.foreground_cwd, agent_status: 'blocked'});
  result({});
} else if (a[0] === 'agent' && a[1] === 'list') result({agents: state.agents});
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
  for (const kind of ['codex', 'claude']) fs.writeFileSync(path.join(bin, `monitor-${kind}`), `#!${process.execPath}\nconsole.log(JSON.stringify({kind: '${kind}', args: process.argv.slice(2), env: Object.fromEntries(['ORG_DIR','ORG_ACTOR','MONITOR_SUPERVISOR_AGENT','MONITOR_SESSION_KIND','MONITOR_REQUEST_DIR','LANE_CONFIG'].map(k => [k, process.env[k]]))}));\n`, { mode: 0o755 });
  const env = { ...process.env, HERDR_BIN_PATH: path.join(bin, 'herdr'), HERDR_MONITOR_ENTRY_BIN: bin,
    ORG_DIR: '', HERDR_ORG_CONSOLE_CONFIG: path.join(root, 'absent-console.json'),
    HERDR_MONITOR_SUPERVISOR_HARNESS: 'codex', CHAT_FAKE_STATE: stateFile,
    MONITOR_SUPERVISOR_AGENT: 'foreign-ops', MONITOR_REQUEST_DIR: '/foreign/requests', LANE_CONFIG: '/foreign/config',
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
  const open = (p = projects[0], extra = {}) => openProjectChat({ project: p.name, identity: p.identity, env, startupMs: 10, now: () => time, sleep: ms => {time += ms;}, ...extra });
  const snapshot = dir => {
    const files = [];
    const visit = prefix => { for (const entry of fs.readdirSync(path.join(dir, prefix), {withFileTypes: true})) {
      const file = path.join(prefix, entry.name);
      if (entry.isDirectory()) visit(file); else files.push([file, fs.readFileSync(path.join(dir, file)).toString('base64')]);
    } }; visit(''); return files;
  };
  return {root, env, projects, state, change, open, snapshot};
}

test('one quiet chat per canonical fleet identity shares a control workspace, reopens by receipt, and preserves project files', t => {
  const f = fixture(t), before = f.projects.map(p => f.snapshot(p.checkout));
  const first = f.open(undefined, {focus: false});
  assert.equal(f.state().focus, 'operator-work');
  assert.match(first.name, /^chat-[a-f0-9]{24}$/); assert.equal(first.to, 'ops-0');
  const launch = f.state().launches[0];
  assert.deepEqual(launch.args, ['--repo', f.projects[0].checkout, '--role', 'supervisor', '--', '-p', 'profile-0']);
  assert.equal(launch.env.ORG_DIR, f.projects[0].record); assert.equal(launch.env.ORG_ACTOR, first.name);
  assert.equal(launch.env.MONITOR_SUPERVISOR_AGENT, 'ops-0'); assert.equal(launch.env.MONITOR_SESSION_KIND, 'chat');
  assert.equal(launch.env.MONITOR_REQUEST_DIR, undefined); assert.equal(launch.env.LANE_CONFIG, undefined);
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
  assert.deepEqual(launch.args, ['--repo', f.projects[0].checkout, '--role', 'supervisor', '--', '--plugin-dir', "/space and quotes/it's-plugin", '--model', 'model-chat', '--effort', 'high']);
  assert.equal(launch.env.MONITOR_SUPERVISOR_AGENT, 'ops-explicit'); assert.equal(f.state().focus, 'operator-work');
  assert.equal(f.state().calls.some(a => a[0] === 'workspace' && a[1] === 'create'), false);
  assert.throws(() => f.open(f.projects[1], {workspace: 'other'}), /already use control workspace/);
});

test('failed or uncertain startup retains one tab and never launches again on reopen', t => {
  const f = fixture(t); f.change(s => {s.noDetect = true;});
  assert.throws(() => f.open(), /startup not detected; retained tab/);
  const receipt = f.open(); assert.equal(receipt.reused, true); assert.equal(receipt.available, false);
  assert.equal(f.state().tabs.length, 1); assert.equal(f.state().launches.length, 1);
  assert.equal(f.state().focus, receipt.tab);
});

test('shell readiness fails before sending input and retains a recoverable tab', t => {
  const f = fixture(t); f.change(s => {s.busy = true;});
  assert.throws(() => f.open(), /shell not ready/);
  assert.equal(f.state().launches.length, 0); assert.equal(f.state().focus, 'operator-work');
  assert.equal(f.open().reused, true); assert.equal(f.state().tabs.length, 1);
});

test('unknown, stale, excluded and opted-out fleet projects fail before any Herdr mutation', t => {
  const f = fixture(t), p = f.projects[0];
  assert.throws(() => f.open(p, {project: 'not-joined'}), /unknown fleet/);
  assert.throws(() => f.open(p, {identity: '/different/.git'}), /identity changed/);
  const file = path.join(f.env.HERDR_MONITOR_FLEET, 'fleet.json'), raw = JSON.parse(fs.readFileSync(file));
  raw.excluded_roots = [p.checkout]; fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => f.open(), /excluded/);
  delete raw.excluded_roots; raw.projects[p.name].identity = '/missing/.git'; fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => f.open(p, {identity: undefined}), /stale fleet/);
  raw.projects[p.name].identity = p.identity; fs.writeFileSync(file, JSON.stringify(raw));
  fs.writeFileSync(path.join(p.checkout, '.lane.json'), '{"entry":{"enabled":false}}');
  assert.throws(() => f.open(), /opted out/);
  assert.deepEqual(f.state().calls, []);
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
  f.change(s => {s.spaces.push({workspace_id: 'brain', label: 'Herdr Brain'});});
  const receipt = f.open(undefined, {focus: false}); assert.equal(receipt.workspace, 'brain'); assert.equal(receipt.to, 'supervisor-herdr');
  assert.equal(f.state().launches[0].env.MONITOR_SUPERVISOR_AGENT, 'supervisor-herdr');
  assert.equal(f.state().spaces.length, 1); assert.equal(f.state().focus, 'operator-work');
});

test('console --print refuses project chat keys for every profile without creating tabs or launching agents', t => {
  const f = fixture(t), p = f.projects[0], config = path.join(f.root, 'console.json');
  fs.writeFileSync(config, JSON.stringify({projects: [{name: p.name, cwd: p.checkout, org: p.record}], explain: false}));
  const app = new URL('../../console/app.mjs', import.meta.url).pathname;
  for (const profile of [[], ['--modern'], ['--minimal']]) {
    const r = spawnSync(process.execPath, [app, ...profile, '--config', config, '--project', p.name, '--print', '100x30', '--keys', 'C'], {env: f.env, encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /--print does not open project chats/);
  }
  assert.equal(f.state().tabs.length, 0); assert.equal(f.state().launches.length, 0); assert.equal(f.state().focus, 'operator-work');
});
