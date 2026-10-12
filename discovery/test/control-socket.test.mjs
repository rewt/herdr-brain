import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fakeControlSocket } from '../../test/helpers/fake-control-socket.mjs';
import { toml } from '../confinement.mjs';
import { herdrControlSocket } from '../control-socket.mjs';
import { nativeSandboxLaunch } from '../native-sandbox.mjs';
import { sessionEnvironment, sessionHookArguments } from '../../supervisor/session-hooks.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'r259-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { role: 'worker', workspace: path.join(root, 'repo'), canonical: path.join(root, 'repo'),
    org: path.join(root, 'record'), worktrees: path.join(root, 'lanes'), tempRoot: path.join(root, 'temp'), projects: [] };
  for (const directory of Object.values(context).filter(value => typeof value === 'string' && path.isAbsolute(value))) fs.mkdirSync(directory, { recursive: true });
  for (const args of [['init','-q','-b','main'],['-c','user.name=Socket tests','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','Seed']]) {
    const result=spawnSync('git',['-C',context.canonical,...args],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  }
  const config = path.join(root, 'config'); fs.mkdirSync(config);
  const socket = fakeControlSocket(t, root);
  const alias = path.join(root, 'control-alias'); fs.symlinkSync(socket, alias);
  const env = { ...process.env, HERDR_SOCKET_PATH: alias, CODEX_HOME: config, CLAUDE_CONFIG_DIR: config };
  const binary = path.join(root, 'native');
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = --help ] || [ "$2" = --help ]; then echo "--sandbox --add-dir --settings --permission-profile"; elif [ "$1" = --version ]; then echo "2.1.284"; fi\n', { mode: 0o755 });
  return { root, context, config, socket, alias, env, binary };
}

test('control socket resolves the environment and default path and refuses unsafe or unreachable endpoints', t => {
  const f = fixture(t);
  assert.equal(herdrControlSocket(f.env), f.socket);
  const home = path.join(f.root, 'home'); fs.mkdirSync(path.join(home, '.config/herdr'), { recursive: true });
  fs.symlinkSync(f.socket, path.join(home, '.config/herdr/herdr.sock'));
  assert.equal(herdrControlSocket({ ...f.env, HOME: home, HERDR_SOCKET_PATH: '' }), f.socket);
  for (const [file, pattern] of [[path.join(f.root, 'absent'), /ENOENT/], [f.binary, /not a Unix socket/]])
    assert.throws(() => herdrControlSocket({ ...f.env, HERDR_SOCKET_PATH: file }), pattern);
  const stale = path.join(f.root, 'stale.sock');
  spawnSync(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1],()=>process.kill(process.pid,'SIGKILL'))", stale], { timeout: 5000 });
  assert.throws(() => herdrControlSocket({ ...f.env, HERDR_SOCKET_PATH: stale }), /ECONNREFUSED/);
  const client = path.join(f.root, 'herdr-client.sock'); fs.symlinkSync(f.socket, client);
  assert.throws(() => herdrControlSocket({ ...f.env, HERDR_SOCKET_PATH: client }), /not the control socket/);
  const resolvedClient = fakeControlSocket(t, f.root, 'herdr-client.sock-real');
  // Also reject a benign alias of an endpoint actually named herdr-client.sock.
  fs.unlinkSync(client); fs.renameSync(resolvedClient, client); fs.unlinkSync(f.alias); fs.symlinkSync(client, f.alias);
  assert.throws(() => herdrControlSocket(f.env), /not the control socket/);
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', function (file, ...args) {
    const entry = stat.call(this, file, ...args);
    if (file === f.socket) entry.uid = (process.getuid?.() ?? 0) + 1;
    return entry;
  });
  assert.throws(() => herdrControlSocket({ ...f.env, HERDR_SOCKET_PATH: f.socket }), /not owned by the current user/);
});

for (const kind of ['claude', 'codex']) test(`${kind} grants only coordinating roles the resolved control socket and lane root`, t => {
  const f = fixture(t);
  for (const role of ['worker', 'review', 'supervisor', 'chat']) {
    const coordinating = ['supervisor', 'chat'].includes(role);
    const launch = nativeSandboxLaunch({ kind, binary: f.binary, args: [], context: { ...f.context, role }, env: f.env, warn: () => {} });
    t.after(launch.close);
    assert.equal(launch.env.HERDR_SOCKET_PATH, coordinating ? f.socket : f.alias);
    if (kind === 'claude') {
      const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
      assert.equal(settings.sandbox.network.allowUnixSockets.includes(f.socket), coordinating);
      assert.ok(!settings.sandbox.network.allowUnixSockets.includes(f.alias));
      assert.equal(settings.sandbox.filesystem.allowWrite.includes(f.context.worktrees), coordinating);
      assert.equal(settings.sandbox.filesystem.denyWrite.includes(f.context.worktrees), !coordinating);
      assert.equal(settings.sandbox.filesystem.denyWrite.includes(path.join(f.context.canonical, '.lane')), !coordinating);
      assert.equal(settings.hooks?.PreToolUse?.length > 0, !coordinating);
    } else {
      const profile = JSON.parse(launch.args.find(arg => arg.startsWith('default_permissions=')).slice('default_permissions='.length));
      assert.match(profile, coordinating ? /^monitor-coordinator-r-/ : /^monitor-worker$/);
      assert.ok(launch.args.includes(`default_permissions="${profile}"`));
      const filesystem = launch.args.find(arg => arg.startsWith(coordinating ? `permissions.${profile}=` : `permissions.${profile}.filesystem=`));
      assert.equal(filesystem.includes(`${JSON.stringify(f.context.worktrees)}="write"`), coordinating);
      assert.equal(filesystem.includes(`"unix_sockets"=${toml({ [f.socket]: 'allow' })}`), coordinating);
      assert.equal(launch.args.includes('features.network_proxy=true'), coordinating);
    }
  }
  for (const role of ['worker', 'review']) {
    const launch = nativeSandboxLaunch({ kind, binary: f.binary, args: [], context: { ...f.context, role }, env: { ...f.env, HERDR_SOCKET_PATH: '/missing/control.sock' }, warn: () => {} });
    launch.close();
  }
  for (const role of ['supervisor', 'chat']) {
    const before = fs.readdirSync(f.context.tempRoot);
    assert.throws(() => nativeSandboxLaunch({ kind, binary: f.binary, args: [], context: { ...f.context, role }, env: { ...f.env, HERDR_SOCKET_PATH: '/missing/control.sock' } }), /Herdr control socket.*ENOENT/);
    assert.deepEqual(fs.readdirSync(f.context.tempRoot), before, 'failed launch leaves no new temp');
  }
});

test('coordinating Codex profiles replace inherited profile selections but reject legacy selectors and old builds', t => {
  const f = fixture(t), file = path.join(f.config, 'config.toml'), warnings = [];
  fs.writeFileSync(file, 'default_permissions="operator"\n');
  const options = { kind: 'codex', binary: f.binary, args: [], context: { ...f.context, role: 'chat' }, env: f.env, warn: text => warnings.push(text) };
  const launch = nativeSandboxLaunch(options); t.after(launch.close);
  assert.ok(launch.args.some(arg => /^default_permissions="monitor-coordinator-r-/.test(arg)));
  assert.ok(warnings.some(warning => warning.includes(file) && warning.includes('generated permission profile')));
  assert.equal(fs.readFileSync(file, 'utf8'), 'default_permissions="operator"\n');
  fs.writeFileSync(file, 'sandbox_mode="workspace-write"\n');
  assert.throws(() => nativeSandboxLaunch(options), /legacy sandbox selectors/);
  fs.unlinkSync(file);
  for (const args of [['--yolo'], ['--sandbox', 'workspace-write'], ['-c', 'default_permissions="custom"']])
    assert.throws(() => nativeSandboxLaunch({ ...options, args }), /remove .*from CLI/);
  fs.writeFileSync(f.binary, '#!/bin/sh\nif [ "$1" = --help ]; then echo "--sandbox --add-dir"; fi\n', { mode: 0o755 });
  assert.throws(() => nativeSandboxLaunch(options), /require native permission-profile support/);
});

test('the local bridge warning names the removable file without rewriting it', t => {
  const f = fixture(t), file = path.join(f.context.canonical, '.claude/settings.local.json');
  fs.mkdirSync(path.dirname(file)); const text = JSON.stringify({ sandbox: { network: { allowUnixSockets: [f.socket] } } }); fs.writeFileSync(file, text);
  const warnings = [];
  const launch = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args: [], context: { ...f.context, role: 'chat' }, env: f.env, warn: warning => warnings.push(warning) });
  t.after(launch.close);
  assert.ok(warnings.some(warning => warning.includes(file) && warning.includes('grant-herdr-socket.mjs --remove')));
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('a coordinating Codex launch fails before handover when its native profile cannot connect', t => {
  const f = fixture(t);
  fs.writeFileSync(f.binary, '#!/bin/sh\nif [ "$1" = --help ] || [ "$2" = --help ]; then echo "--sandbox --add-dir --permission-profile"; else echo "EPERM: native socket permission refused" >&2; exit 1; fi\n', { mode: 0o755 });
  assert.throws(() => nativeSandboxLaunch({ kind: 'codex', binary: f.binary, args: [], context: { ...f.context, role: 'chat' }, env: f.env }), /native permission profile cannot reach Herdr.*EPERM/);
  assert.deepEqual(fs.readdirSync(f.context.tempRoot), []);
});

test('chat session bindings carry their role and receive no per-launch hooks', t => {
  const f = fixture(t), context = { ...f.context, role: 'chat' };
  const env = sessionEnvironment(context, f.root, { ...f.env, MONITOR_SUPERVISOR_AGENT: 'ops' });
  assert.equal(env.MONITOR_SUPERVISOR_AGENT, 'ops');
  assert.equal(env.MONITOR_SESSION_ROLE, 'chat'); assert.equal(env.MONITOR_ENTRY_BYPASS, '1');
  assert.equal(env.MONITOR_SUPERVISOR_ENTRY, ''); assert.equal(env.MONITOR_SUPERVISOR_IDENTITY, '');
  assert.equal(env.MONITOR_SESSION_KIND, undefined);
  for (const kind of ['claude', 'codex']) assert.deepEqual(sessionHookArguments(kind, context, f.root), [], 'chats get no per-launch hooks');
});

for (const kind of ['claude', 'codex']) test(`${kind} native sandbox connects to the fake control socket only for supervisor and chat`, {
  skip: !(kind === 'claude' ? process.env.MONITOR_TEST_CLAUDE_SOCKETS : process.env.MONITOR_TEST_SANDBOX) && 'set the offline native sandbox probe binary outside a nested sandbox',
}, t => {
  const f = fixture(t), binary = kind === 'claude' ? process.env.MONITOR_TEST_CLAUDE_SOCKETS : process.env.MONITOR_TEST_SANDBOX;
  let preload, module, symbol;
  if (kind === 'claude') {
    const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 });
    assert.match(version.stdout, /^2\.1\.(292|293) /);
    symbol = version.stdout.startsWith('2.1.293 ') ? 'icr' : 'Nir';
    module = fs.readFileSync(binary, 'utf8').match(new RegExp(`import\\{[^{}]*\\b${symbol}\\b[^{}]*\\}from"(/\\$bunfs/root/[^"\\n]+)"`))?.[1];
    assert.ok(module);
    preload = path.join(f.root, 'preload.mjs');
    fs.writeFileSync(preload, `import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
try {
  const input = JSON.parse(fs.readFileSync(process.env.MONITOR_SOCKET_PROBE, 'utf8'));
  const native = await import(input.module); const wrap = input.symbol === 'icr' ? native.icr : native.Nir;
  const quote = value => "'" + value.replaceAll("'", "'\\\\''") + "'";
  const settings = JSON.parse(fs.readFileSync(input.settings));
  const command = [input.node, '-e', input.script].map(quote).join(' ');
  const wrapped = wrap({command,needsNetworkRestriction:true,...settings.sandbox.network,
    writeConfig:{allowOnly:[input.workspace,...settings.sandbox.filesystem.allowWrite],denyWithinAllow:settings.sandbox.filesystem.denyWrite}});
  const result = spawnSync('/bin/sh',['-c',wrapped],{encoding:'utf8',timeout:10000});
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
} catch(error) { console.error(error); process.exit(1); }`);
  }
  // Include a sibling endpoint to prove the control grant stays scoped.
  const sibling = fakeControlSocket(t, f.root, 'sibling.sock');
  const inherited = `default_permissions="operator"\n[permissions.monitor-coordinator]\nworkspace_roots={${JSON.stringify(f.root)}=true}\n[permissions.monitor-coordinator.network]\nenabled=true\n`;
  fs.writeFileSync(path.join(f.config, 'config.toml'), inherited);
  for (const role of ['worker', 'review', 'supervisor', 'chat']) {
    const coordinating = ['supervisor', 'chat'].includes(role);
    // Worker profile generation remains independent of ENG-230's inherited
    // selector policy; coordinating roles must work with an inherited selector.
    if (!coordinating) fs.unlinkSync(path.join(f.config, 'config.toml'));
    else fs.writeFileSync(path.join(f.config, 'config.toml'), inherited);
    const launch = nativeSandboxLaunch({ kind, binary, args: ['--setting-sources', ''], context: { ...f.context, role }, env: f.env, warn: () => {} });
    t.after(launch.close);
    const script = `const fs=require('fs'),net=require('net'),assert=require('assert/strict');
async function connect(socket,allowed) { const result=await new Promise(resolve=>{const c=net.connect(socket); c.once('connect',()=>{c.destroy();resolve('ok')});c.once('error',e=>resolve(e.code));}); if(allowed)assert.equal(result,'ok');else assert.ok(['EPERM','EACCES'].includes(result),socket+': '+result); }
(async()=>{await connect(${JSON.stringify(f.socket)},${coordinating});await connect(${JSON.stringify(f.alias)},${coordinating});await connect(${JSON.stringify(sibling)},false);
const directory=${JSON.stringify(path.join(f.context.worktrees, role))};
if(${coordinating})fs.mkdirSync(directory);else assert.throws(()=>fs.mkdirSync(directory),e=>['EPERM','EACCES'].includes(e.code));
assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(f.root, 'outside-'))}+${JSON.stringify(role)},'bad'),e=>['EPERM','EACCES'].includes(e.code));
console.log('native role boundary passed: ${role}');})().catch(e=>{console.error(e);process.exitCode=1});`;
    let result;
    if (kind === 'codex') {
      const settings = launch.args.filter((_, i) => launch.args[i - 1] === '-c');
      const profile = JSON.parse(settings.find(setting => setting.startsWith('default_permissions=')).slice('default_permissions='.length));
      result = spawnSync(binary, ['sandbox', '--permission-profile', profile, '-C', f.context.workspace, ...settings.flatMap(setting => ['-c', setting]), '--', process.execPath, '-e', script], { env: launch.env, encoding: 'utf8', timeout: 15000 });
    } else {
      const input = path.join(f.root, 'probe.json'); fs.writeFileSync(input, JSON.stringify({ module, symbol, node: process.execPath, workspace: f.context.workspace, script, settings: launch.args[launch.args.indexOf('--settings') + 1] }));
      result = spawnSync(binary, ['--version'], { cwd: f.context.workspace, env: { ...launch.env, MONITOR_SOCKET_PROBE: input, BUN_OPTIONS: `--preload ${preload}` }, encoding: 'utf8', timeout: 15000 });
    }
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp('native role boundary passed: ' + role));
    if (role === 'worker') fs.writeFileSync(path.join(f.config, 'config.toml'), 'default_permissions="operator"\n');
  }
});
