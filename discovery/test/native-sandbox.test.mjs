import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { joinFleet } from '../../lib/fleet.mjs';
import { command } from '../runtime.mjs';
import { runTemporary, temporaryEnvironment } from '../temporary.mjs';
import { nativeSandboxLaunch, nativeSession } from '../native-sandbox.mjs';
import { toml } from '../confinement.mjs';
import { fakeControlSocket } from '../../test/helpers/fake-control-socket.mjs';
import { unattendedHookArguments } from '../../supervisor/unattended.mjs';
import { fileURLToPath } from 'node:url';

const projectTrust = directories => `projects=${toml(Object.fromEntries([...new Set(directories)].map(directory => [directory, { trust_level: 'trusted' }])))}`;

function fixture(t, fallbackState = 'owned') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'a18-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = { checkout: path.join(root, 'a'), record: path.join(root, 'ar'), temp: path.join(root, 'at'), worktrees: path.join(root, 'aw') };
  const other = { checkout: path.join(root, 'b'), record: path.join(root, 'br'), temp: path.join(root, 'bt'), worktrees: path.join(root, 'bw') };
  for (const directory of [...Object.values(own), ...Object.values(other)]) fs.mkdirSync(directory);
  const context = { workspace: own.checkout, canonical: own.checkout, org: own.record, tempRoot: own.temp, worktrees: own.worktrees, projects: [other] };
  const binary = path.join(root, 'native');
  const socket = fakeControlSocket(t, root);
  const beforeSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = socket;
  t.after(() => { if (beforeSocket === undefined) delete process.env.HERDR_SOCKET_PATH; else process.env.HERDR_SOCKET_PATH = beforeSocket; });
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = --help ] || [ "$2" = --help ]; then echo "--sandbox --add-dir --settings --permission-profile"; elif [ "$1" = --version ]; then echo "2.1.284"; fi\n', { mode: 0o755 });
  const codexHome = path.join(root, 'codex'); fs.mkdirSync(codexHome);
  const claudeHome = path.join(root, 'claude'); fs.mkdirSync(claudeHome);
  // Fixtures never inherit the operator's real permission choices.
  for (const [key, value] of Object.entries({ CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome })) {
    const before = process.env[key]; process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  // Keep in-process fallback checks independent of the machine's shared Claude
  // directory; use the real checkedDirectory traversal with a private stand-in.
  const fallback = path.join(fs.realpathSync('/tmp'), `claude-${process.getuid?.() ?? 0}`);
  const standIn = path.join(root, 'fallback'); fs.mkdirSync(standIn, { mode: 0o700 });
  const lstat = fs.lstatSync, realpath = fs.realpathSync, open = fs.openSync;
  let fallbackInspections = 0;
  t.mock.method(fs, 'lstatSync', function (file, ...args) {
    if (file !== fallback) return lstat.call(this, file, ...args);
    fallbackInspections++;
    if (fallbackState === 'missing') throw Object.assign(new Error(`ENOENT: no such directory, ${fallback}`), { code: 'ENOENT' });
    const entry = lstat.call(this, standIn, ...args);
    if (fallbackState === 'foreign') entry.uid = (process.getuid?.() ?? 0) + 1;
    if (fallbackState === 'writable') entry.mode |= 0o002;
    if (fallbackState === 'symlink') entry.isSymbolicLink = () => true;
    return entry;
  });
  t.mock.method(fs, 'realpathSync', function (file, ...args) {
    return file === fallback ? fallback : realpath.call(this, file, ...args);
  });
  t.mock.method(fs, 'openSync', function (file, ...args) {
    if (file !== fallback) return open.call(this, file, ...args);
    if (fallbackState === 'denied') throw Object.assign(new Error(`EPERM: operation not permitted, open '${fallback}'`), { code: 'EPERM' });
    return open.call(this, standIn, ...args);
  });
  return { root, own, other, context, binary, socket, fallback, fallbackInspections: () => fallbackInspections };
}

test('native question guard merges with supplied Claude hooks and lane guards and keeps Codex settings per launch', t => {
  const f = fixture(t), root = fileURLToPath(new URL('../../', import.meta.url));
  const settings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing-command' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'existing-start' }] }] } };
  const file = path.join(f.root, 'operator-settings.json'); fs.writeFileSync(file, JSON.stringify(settings));
  for (const kind of ['claude', 'codex']) {
    const guard = unattendedHookArguments(kind, { ...f.context, role: 'supervisor' }, root, { MONITOR_SESSION_KIND: 'chat' });
    const launch = nativeSandboxLaunch({ kind, binary: f.binary, args: [...(kind === 'claude' ? ['--settings', file] : []), ...guard], context: f.context });
    t.after(launch.close);
    if (kind === 'claude') {
      const merged = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
      assert.deepEqual(merged.hooks.PreToolUse[0], settings.hooks.PreToolUse[0]);
      assert.deepEqual(merged.hooks.SessionStart, settings.hooks.SessionStart);
      assert.equal(merged.hooks.PreToolUse.filter(g => g.matcher.includes('AskUserQuestion')).length, 1);
      assert.ok(merged.hooks.PreToolUse.some(g => g.matcher.includes('NotebookEdit')));
      assert.match(merged.hooks.PreToolUse[1].hooks[0].command, /'conversation'/);
    } else {
      assert.ok(launch.args.includes(guard[1]));
      assert.match(guard[1], /request_user_input/);
    }
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), settings);
  for (const directory of ['.claude', '.codex']) assert.ok(!fs.existsSync(path.join(f.own.checkout, directory)), 'no persistent settings created');
});

test('headless tasks and resumes get a sandbox even when prompt text names a utility', () => {
  for (const args of [['exec', 'help'], ['--model', 'literal', 'exec', 'debug'], ['resume', 'session']]) assert.equal(nativeSession('codex', args), true);
  assert.equal(nativeSession('codex', ['--model', 'literal', 'sandbox', '--help']), false);
  assert.equal(nativeSession('codex', ['sandbox', '/usr/bin/true']), false);
  assert.equal(nativeSession('claude', ['--print', 'auth']), true);
});

test('each run gets short private fleet temp and all three temp variables', t => {
  const f = fixture(t), a = runTemporary(f.own.temp), b = runTemporary(f.own.temp);
  assert.notEqual(a, b); assert.equal(path.dirname(a), f.own.temp);
  assert.ok(Buffer.byteLength(a) <= 60);
  assert.equal(fs.statSync(a).mode & 0o777, 0o700);
  assert.deepEqual(temporaryEnvironment(a, {}), { TMPDIR: a, TMP: a, TEMP: a, PYTHONPYCACHEPREFIX: path.join(a, 'pycache') });
});

for (const kind of ['codex', 'claude']) test(`${kind} preserves the operator's Python bytecode environment`, t => {
  const f = fixture(t);
  for (const python of [
    {}, { PYTHONPYCACHEPREFIX: '/operator/cache' }, { PYTHONDONTWRITEBYTECODE: '1' },
    { PYTHONPYCACHEPREFIX: '/operator/cache', PYTHONDONTWRITEBYTECODE: '1' },
    { PYTHONPYCACHEPREFIX: '' }, { PYTHONDONTWRITEBYTECODE: '' },
    { PYTHONPYCACHEPREFIX: '', PYTHONDONTWRITEBYTECODE: '' },
    { PYTHONPYCACHEPREFIX: '/operator/cache', PYTHONDONTWRITEBYTECODE: '' },
    { PYTHONPYCACHEPREFIX: '', PYTHONDONTWRITEBYTECODE: '1' },
  ]) {
    const launch = nativeSandboxLaunch({ kind, binary: f.binary, args: [], context: f.context, env: python });
    t.after(launch.close);
    const expected = Object.values(python).some(value => value !== '') ? python
      : { ...python, PYTHONPYCACHEPREFIX: path.join(launch.env.TMPDIR, 'pycache') };
    const environments = [launch.env];
    if (kind === 'claude') environments.push(JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1])).env);
    for (const env of environments) for (const key of ['PYTHONPYCACHEPREFIX', 'PYTHONDONTWRITEBYTECODE']) assert.equal(env[key], expected[key]);
  }
});

for (const source of ['user', 'project', 'local', 'cli-json', 'cli-file', 'managed', 'managed-fragment']) {
  test(`Claude respects Python bytecode values in ${source} settings`, t => {
    const f = fixture(t);
    const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';
    const files = {
      user: path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'),
      project: path.join(f.own.checkout, '.claude/settings.json'),
      local: path.join(f.own.checkout, '.claude/settings.local.json'),
      'cli-file': path.join(f.root, 'operator-settings.json'),
      managed: path.join(managed, 'managed-settings.json'),
      'managed-fragment': path.join(managed, 'managed-settings.d/python.json'),
    };
    let supplied;
    if (source.startsWith('managed')) {
      const read = fs.readFileSync, readdir = fs.readdirSync;
      t.mock.method(fs, 'readFileSync', function (file, ...args) {
        return file === files[source] ? JSON.stringify(supplied) : read.call(this, file, ...args);
      });
      t.mock.method(fs, 'readdirSync', function (directory, ...args) {
        return directory === path.join(managed, 'managed-settings.d')
          ? (source === 'managed-fragment' ? ['python.json'] : []) : readdir.call(this, directory, ...args);
      });
    } else if (files[source]) fs.mkdirSync(path.dirname(files[source]), { recursive: true });
    for (const python of [
      { PYTHONPYCACHEPREFIX: '/operator/settings-cache' }, { PYTHONDONTWRITEBYTECODE: '1' },
      { PYTHONPYCACHEPREFIX: '/operator/settings-cache', PYTHONDONTWRITEBYTECODE: '1' },
      { PYTHONPYCACHEPREFIX: '' }, { PYTHONDONTWRITEBYTECODE: '' },
      { PYTHONPYCACHEPREFIX: '', PYTHONDONTWRITEBYTECODE: '' },
    ]) for (const inherited of [{}, { PYTHONPYCACHEPREFIX: '', PYTHONDONTWRITEBYTECODE: '' }]) {
      supplied = { env: { ...python, OPERATOR_SETTING: 'kept' } };
      if (files[source] && !source.startsWith('managed')) fs.writeFileSync(files[source], JSON.stringify(supplied));
      const args = source === 'cli-json' ? ['--settings', JSON.stringify(supplied)]
        : source === 'cli-file' ? [`--settings=${files[source]}`] : [];
      const launch = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args, context: f.context, env: inherited });
      t.after(launch.close);
      const generated = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
      if (Object.values(python).some(value => value !== '')) {
        for (const key of ['PYTHONPYCACHEPREFIX', 'PYTHONDONTWRITEBYTECODE']) {
          assert.equal(launch.env[key], inherited[key], 'settings choice suppresses the launch default');
          assert.equal(generated.env[key], source.startsWith('cli-') ? python[key] : undefined,
            'operator values retain their native settings scope');
        }
      } else {
        assert.equal(launch.env.PYTHONPYCACHEPREFIX, path.join(launch.env.TMPDIR, 'pycache'));
        assert.equal(generated.env.PYTHONPYCACHEPREFIX, launch.env.PYTHONPYCACHEPREFIX);
      }
      if (source.startsWith('cli-')) assert.equal(generated.env.OPERATOR_SETTING, 'kept');
      else if (!source.startsWith('managed')) assert.deepEqual(JSON.parse(fs.readFileSync(files[source])), supplied);
    }
  });
}

test('long and redirected temp roots refuse before creating a run', t => {
  const f = fixture(t), long = path.join(f.root, 'x'.repeat(61));
  assert.throws(() => runTemporary(long), /temp.*60.*Unix socket/u);
  assert.ok(!fs.existsSync(long));
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.own.temp, alias);
  assert.throws(() => runTemporary(alias), /redirected/u);
  const unicode = path.join(f.root, 'é'.repeat(24));
  assert.throws(() => runTemporary(unicode), /60/u);
});

test('Codex uses native workspace roots, excludes system temp and retains hook transport', t => {
  const f = fixture(t), env = { HERDR_SOCKET_PATH: '/operator/herdr.sock', TMPDIR: '/foreign/temp' };
  const launch = nativeSandboxLaunch({ kind: 'codex', binary: f.binary, args: ['--model', 'literal', 'Task'], context: f.context, env });
  t.after(launch.close);
  assert.equal(launch.binary, f.binary);
  assert.ok(!launch.args.includes('sandbox'));
  assert.ok(launch.args.includes('default_permissions="monitor-worker"'));
  const filesystem = launch.args.find(a => a.startsWith('permissions.monitor-worker.filesystem='));
  for (const directory of [f.own.record, launch.env.TMPDIR]) assert.ok(filesystem.includes(`${JSON.stringify(directory)}="write"`));
  for (const directory of Object.values(f.other)) assert.ok(!filesystem.includes(directory));
  assert.ok(filesystem.includes('":root"="read"')); assert.ok(!filesystem.includes('"/tmp"="write"'));
  assert.equal(launch.env.HERDR_SOCKET_PATH, env.HERDR_SOCKET_PATH);
  assert.equal(launch.env.TMPDIR, launch.env.TMP); assert.equal(launch.env.TMP, launch.env.TEMP);
});

test('legacy Codex uses writable roots with system temp excluded', t => {
  const f = fixture(t);
  fs.writeFileSync(f.binary, '#!/bin/sh\nif [ "$1" = --help ]; then echo "--sandbox --add-dir"; fi\n', { mode: 0o755 });
  const launch = nativeSandboxLaunch({ kind: 'codex', binary: f.binary, args: ['Task'], context: f.context });
  t.after(launch.close);
  assert.ok(launch.args.includes('sandbox_mode="workspace-write"'));
  assert.ok(!launch.args.includes('--sandbox'));
  const roots = JSON.parse(launch.args.find(a => a.startsWith('sandbox_workspace_write.writable_roots=')).split('=').slice(1).join('='));
  assert.deepEqual(roots, [f.own.record, launch.env.TMPDIR]);
  assert.ok(launch.args.includes('sandbox_workspace_write.exclude_slash_tmp=true'));
  assert.ok(launch.args.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'));
});

test('Claude gets per-session native write settings and keeps existing hooks', t => {
  const f = fixture(t), hooks = { Stop: [{ hooks: [{ type: 'command', command: 'herdr-agent-state.sh' }] }] };
  const launch = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args: ['--settings', JSON.stringify({ hooks }), 'Task'], context: f.context, env: { HERDR_SOCKET_PATH: '/operator/herdr.sock' } });
  t.after(launch.close);
  assert.equal(launch.args.filter(a => a === '--settings').length, 1);
  const settingsFile = launch.args[launch.args.indexOf('--settings') + 1];
  assert.equal(path.dirname(settingsFile), launch.env.TMPDIR);
  const settings = JSON.parse(fs.readFileSync(settingsFile));
  assert.deepEqual(settings.hooks.Stop, hooks.Stop);
  assert.equal(settings.sandbox.enabled, true); assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, [f.own.record, launch.env.TMPDIR]);
  for (const directory of Object.values(f.other)) assert.ok(settings.sandbox.filesystem.denyWrite.includes(directory));
  assert.equal(launch.env.CLAUDE_CODE_TMPDIR, launch.env.TMPDIR);
  assert.equal(launch.env.HERDR_SOCKET_PATH, '/operator/herdr.sock');
  const fallback = path.join(fs.realpathSync('/tmp'), `claude-${process.getuid?.() ?? 0}`);
  const shellTemp = path.join(launch.env.TMPDIR, `claude-${process.getuid?.() ?? 0}`);
  assert.deepEqual(settings.sandbox.network, { allowUnixSockets: Buffer.byteLength(shellTemp) <= 44 ? [launch.env.TMPDIR] : [launch.env.TMPDIR, fallback] });
  assert.equal(settings.sandbox.allowPty, undefined);
  assert.equal(settings.env.TMPDIR, launch.env.TMPDIR);
  assert.equal(settings.env.CLAUDE_CODE_TMPDIR, launch.env.TMPDIR);
});

test('Claude socket grants stay within each run and its measured shell fallback', t => {
  const f = fixture(t), launches = [];
  for (let i = 0; i < 2; i++) {
    const launch = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args: [], context: f.context });
    t.after(launch.close); launches.push(launch);
  }
  const grants = launches.map(launch => JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1])).sandbox.network.allowUnixSockets);
  for (const [i, allowed] of grants.entries()) {
    assert.ok(allowed.includes(launches[i].env.TMPDIR));
    for (const denied of [f.own.temp, launches[1 - i].env.TMPDIR, ...Object.values(f.other), '/Users/operator/.config/herdr/herdr.sock', '/tmp', fs.realpathSync('/tmp')]) assert.ok(!allowed.includes(denied), denied);
  }
});

test('a short Claude run temp needs no shared shell fallback grant', t => {
  const f = fixture(t, 'denied'), short = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'c-'));
  t.after(() => fs.rmSync(short, { recursive: true, force: true }));
  const warnings = [];
  const launch = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args: [], context: { ...f.context, tempRoot: short }, warn: message => warnings.push(message) });
  t.after(launch.close);
  assert.ok(Buffer.byteLength(path.join(launch.env.TMPDIR, `claude-${process.getuid?.() ?? 0}`)) <= 44);
  const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
  assert.deepEqual(settings.sandbox.network.allowUnixSockets, [launch.env.TMPDIR]);
  assert.equal(f.fallbackInspections(), 0);
  assert.deepEqual(warnings, []);
});

test('a long Claude run temp keeps the safely owned canonical per-user fallback grant', t => {
  const f = fixture(t), tempRoot = path.join(f.root, 'socket-temp-long'); fs.mkdirSync(tempRoot);
  const warnings = [];
  const launch = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args: [], context: { ...f.context, tempRoot }, warn: message => warnings.push(message) }); t.after(launch.close);
  assert.ok(Buffer.byteLength(path.join(launch.env.TMPDIR, `claude-${process.getuid?.() ?? 0}`)) > 44);
  const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
  assert.deepEqual(settings.sandbox.network.allowUnixSockets, [launch.env.TMPDIR, f.fallback]);
  assert.deepEqual(warnings, []);
});

for (const [state, reason] of [['missing', /ENOENT/u], ['denied', /EPERM/u], ['foreign', /not safely owned/u], ['writable', /not safely owned/u], ['symlink', /redirected/u]]) {
  test(`Claude launches without the ${state} shared fallback grant and warns once`, t => {
    const f = fixture(t, state), tempRoot = path.join(f.root, 'socket-temp-long'); fs.mkdirSync(tempRoot);
    const warnings = [];
    const launch = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args: ['Task'], context: { ...f.context, tempRoot }, warn: message => warnings.push(message) });
    t.after(launch.close);
    assert.ok(Buffer.byteLength(path.join(launch.env.TMPDIR, `claude-${process.getuid?.() ?? 0}`)) > 44);
    assert.equal(launch.binary, f.binary);
    assert.ok(launch.args.includes('Task'));
    const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
    assert.deepEqual(settings.sandbox.network.allowUnixSockets, [launch.env.TMPDIR]);
    assert.deepEqual(settings.sandbox.filesystem.allowWrite, [f.own.record, launch.env.TMPDIR]);
    assert.equal(settings.env.CLAUDE_CODE_TMPDIR, launch.env.TMPDIR);
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(f.fallback));
    assert.match(warnings[0], /WARNING: skipping shared Claude temp socket grant/u);
    assert.match(warnings[0], reason);
    launch.close();
    assert.ok(!fs.existsSync(launch.env.TMPDIR));
  });
}

test('Claude merges supplied Unix sockets and leaves inherited grants in native scopes', t => {
  const f = fixture(t), user = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  const project = path.join(f.own.checkout, '.claude/settings.json'); fs.mkdirSync(path.dirname(project));
  fs.writeFileSync(user, JSON.stringify({ sandbox: { network: { allowUnixSockets: ['/configured/user.sock'] } } }));
  fs.writeFileSync(project, JSON.stringify({ sandbox: { network: { allowUnixSockets: ['/configured/project.sock'] } } }));
  const supplied = { sandbox: { network: { allowUnixSockets: ['/configured/cli.sock', '/configured/user.sock'], allowedDomains: ['example.test'], allowLocalBinding: false, allowAllUnixSockets: false } } };
  const warnings = [];
  const launch = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args: ['--settings', JSON.stringify(supplied)], context: f.context, warn: text => warnings.push(text) }); t.after(launch.close);
  const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
  assert.deepEqual(settings.sandbox.network.allowUnixSockets.slice(0, 2), ['/configured/cli.sock', '/configured/user.sock']);
  assert.ok(!settings.sandbox.network.allowUnixSockets.includes('/configured/project.sock'), 'repository grants must not be lifted into the trusted CLI tier');
  assert.deepEqual(settings.sandbox.network.allowedDomains, ['example.test']);
  assert.equal(settings.sandbox.network.allowLocalBinding, false);
  assert.equal(settings.sandbox.network.allowAllUnixSockets, false);
  assert.equal(warnings.length, 1);
  for (const source of [user, project, 'CLI --settings JSON']) assert.ok(warnings[0].includes(`sandbox.network.allowUnixSockets from ${source}`));
  assert.deepEqual(JSON.parse(fs.readFileSync(user)).sandbox.network.allowUnixSockets, ['/configured/user.sock']);
  assert.deepEqual(JSON.parse(fs.readFileSync(project)).sandbox.network.allowUnixSockets, ['/configured/project.sock']);
  const filtered = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args: ['--setting-sources', ''], context: f.context }); t.after(filtered.close);
  const filteredSettings = JSON.parse(fs.readFileSync(filtered.args[filtered.args.indexOf('--settings') + 1]));
  assert.ok(!filteredSettings.sandbox.network.allowUnixSockets.some(p => p.startsWith('/configured/')));
});

test('Claude warns when native socket or TCP overrides widen generated confinement', t => {
  const f = fixture(t), warnings = [];
  const network = { allowAllUnixSockets: true, allowLocalBinding: true };
  const launch = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args: ['--settings', JSON.stringify({ sandbox: { network } })], context: f.context, warn: text => warnings.push(text) }); t.after(launch.close);
  const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
  for (const key of Object.keys(network)) { assert.equal(settings.sandbox.network[key], true); assert.ok(warnings[0].includes(`sandbox.network.${key} from CLI --settings JSON`)); }
  assert.equal(warnings.length, 1);
});

test('extra directories are supplied through native options in canonical project config', t => {
  const f = fixture(t), extra = path.join(f.root, 'extra'); fs.mkdirSync(extra);
  fs.writeFileSync(path.join(f.own.checkout, '.lane.json'), JSON.stringify({
    sandbox_workspace_write: { writable_roots: [extra] }, always_args: { claude: ['--add-dir', extra] },
  }));
  for (const kind of ['codex', 'claude']) {
    const launch = nativeSandboxLaunch({ kind, binary: f.binary, args: ['--add-dir', extra, '--model', 'literal', 'Task'], context: f.context }); t.after(launch.close);
    if (kind === 'codex') assert.ok(launch.args.find(a => a.startsWith('permissions.monitor-worker.filesystem=')).includes(extra));
    else {
      assert.ok(!launch.args.includes(extra), 'extra writes do not widen working directories');
      const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
      assert.ok(settings.sandbox.filesystem.allowWrite.includes(extra));
      assert.ok(settings.permissions.allow.includes(`Edit(/${extra}/**)`));
    }
    assert.throws(() => nativeSandboxLaunch({ kind, binary: f.binary, args: ['--add-dir', f.other.checkout], context: f.context }), /project config/u);
  }
});

test('unsupported harness runs with a visible warning and its own temp', t => {
  const f = fixture(t), warnings = [];
  fs.writeFileSync(f.binary, '#!/bin/sh\necho old-harness\n', { mode: 0o755 });
  const launch = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args: ['Task'], context: f.context, warn: text => warnings.push(text) });
  t.after(launch.close);
  assert.deepEqual(launch.args, ['Task']); assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WARNING.*native sandbox.*unconfined/u);
  assert.equal(path.dirname(launch.env.TMPDIR), f.own.temp);
});

test('Codex respects inherited and CLI sandbox choices with one source-naming warning', t => {
  const f = fixture(t), file = path.join(process.env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(file, 'sandbox_mode = "danger-full-access"\n');
  const choices = [
    { args: ['Task'], source: file },
    { args: ['-c', 'sandbox_mode="danger-full-access"', 'Task'], source: '-c' },
    { args: ['-c', 'sandbox_mode=danger-full-access', 'Task'], source: '-c' },
    { args: ['-csandbox_mode="danger-full-access"', 'Task'], source: '-c' },
    { args: ['--config=sandbox_mode="danger-full-access"', 'Task'], source: '--config' },
    { args: ['--sandbox', 'danger-full-access', 'Task'], source: '--sandbox' },
    { args: ['--yolo', 'Task'], source: '--yolo' },
    { args: ['--dangerously-bypass-approvals-and-sandbox', 'Task'], source: '--dangerously-bypass-approvals-and-sandbox' },
  ];
  for (const choice of choices) {
    const warnings = [];
    const launch = nativeSandboxLaunch({ kind: 'codex', binary: f.binary, args: choice.args, context: f.context, warn: s => warnings.push(s) });
    t.after(launch.close);
    assert.deepEqual(launch.args.slice(0, choice.args.length), choice.args, 'the operator sandbox choice remains untouched');
    assert.deepEqual(launch.args.slice(choice.args.length), ['-c', projectTrust([f.own.checkout])]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /WARNING.*sandbox_mode.*danger-full-access/u);
    assert.ok(warnings[0].includes(choice.source), warnings[0]);
  }
  fs.writeFileSync(file, '# no base override\n');
  const profile = path.join(process.env.CODEX_HOME, 'weaker.config.toml');
  fs.writeFileSync(profile, 'sandbox_mode = "danger-full-access"\n');
  const warnings = [], args = ['--profile', 'weaker', 'Task'];
  const launch = nativeSandboxLaunch({ kind: 'codex', binary: f.binary, args, context: f.context, warn: s => warnings.push(s) }); t.after(launch.close);
  assert.deepEqual(launch.args.slice(0, args.length), args); assert.equal(warnings.length, 1); assert.ok(warnings[0].includes(profile));
});

test('roles receive scoped lane access and launch-only trust for fleet worktrees', t => {
  const f = fixture(t), workspace = path.join(f.own.worktrees, 'lane-worker'); fs.mkdirSync(workspace);
  const codexFile = path.join(process.env.CODEX_HOME, 'config.toml');
  const claudeFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  const codexSettings = `default_permissions=":workspace"\n[projects.${JSON.stringify(f.own.checkout)}]\ntrust_level="untrusted"\n`;
  const claudeSettings = JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true }, sandbox: { filesystem: { denyRead: [f.root] } } });
  fs.writeFileSync(codexFile, codexSettings); fs.writeFileSync(claudeFile, claudeSettings);
  for (const role of ['worker', 'supervisor']) for (const kind of ['claude', 'codex']) {
    const context = { ...f.context, role, workspace: role === 'worker' ? workspace : f.own.checkout };
    const launch = nativeSandboxLaunch({ kind, binary: f.binary, args: ['--model', 'literal', 'Task'], context, warn: () => {} }); t.after(launch.close);
    if (kind === 'claude') {
      const directories = launch.args.filter((_, i) => launch.args[i - 1] === '--add-dir');
      const expected = [f.own.worktrees, f.own.record, launch.env.TMPDIR];
      assert.deepEqual(directories, [launch.env.TMPDIR]);
      assert.equal(launch.args[launch.args.lastIndexOf('--add-dir') + 2], '--settings', 'variadic directories end at a flag');
      const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
      assert.deepEqual(settings.sandbox.filesystem.allowRead, expected);
      assert.ok(settings.permissions.allow.includes(`Read(/${f.own.worktrees}/**)`));
      assert.equal(settings.permissions.allow.includes(`Edit(/${f.own.worktrees}/**)`), role === 'supervisor');
      assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, undefined, 'no global read-block override');
      assert.equal(settings.sandbox.filesystem.allowWrite.includes(f.own.worktrees), role === 'supervisor');
      for (const directory of Object.values(f.other)) {
        assert.ok(!directories.includes(directory));
        assert.ok(settings.sandbox.filesystem.denyWrite.includes(directory));
      }
    } else {
      const trust = launch.args.filter(arg => arg.startsWith('projects='));
      assert.deepEqual(trust, [projectTrust([f.own.checkout, context.workspace])]);
      assert.equal(launch.args.some(arg => arg.startsWith('permissions.')), role === 'supervisor', 'coordinators get a generated profile, workers retain the inherited selector');
    }
    assert.equal(fs.readFileSync(codexFile, 'utf8'), codexSettings);
    assert.equal(fs.readFileSync(claudeFile, 'utf8'), claudeSettings);
    for (const directory of [f.root, f.own.temp, ...Object.values(f.other)]) assert.ok(!launch.args.includes(directory), directory);
    const temporary = launch.env.TMPDIR; launch.close(); assert.ok(!fs.existsSync(temporary));
  }
});

test('Claude denies sibling lanes and rejects configured lane write grants', t => {
  const f = fixture(t), parent = path.join(f.own.worktrees, 'group'), workspace = path.join(parent, 'own');
  const siblings = [path.join(f.own.worktrees, 'lane-sibling'), path.join(parent, 'sibling')];
  fs.mkdirSync(workspace, { recursive:true });
  for (const directory of siblings) fs.mkdirSync(directory);
  for (const role of ['worker','review','supervisor','chat']) {
    const launch = nativeSandboxLaunch({kind:'claude',binary:f.binary,args:[],context:{...f.context,role,workspace:['worker','review'].includes(role)?workspace:f.own.checkout}});
    t.after(launch.close);
    const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings')+1]));
    const denied = ['worker','review'].includes(role)?siblings:[];
    for (const directory of denied) {
      assert.ok(settings.sandbox.filesystem.denyWrite.includes(directory));
      assert.ok(settings.permissions.deny.includes(`Edit(/${directory}/**)`));
    }
    assert.equal(settings.sandbox.filesystem.allowWrite.includes(f.own.worktrees), ['supervisor','chat'].includes(role));
    assert.ok(!settings.sandbox.filesystem.denyWrite.includes(workspace));
    assert.deepEqual(launch.args.filter((_,i)=>launch.args[i-1]==='--add-dir'), [launch.env.TMPDIR]);
  }
  for (const extra of [siblings[0], parent, f.own.worktrees]) {
    fs.writeFileSync(path.join(f.own.checkout,'.lane.json'), JSON.stringify({always_args:{claude:['--add-dir',extra]}}));
    assert.throws(()=>nativeSandboxLaunch({kind:'claude',binary:f.binary,args:[],context:{...f.context,workspace}}), /sibling lanes/u);
  }
});

test('Claude native file hook denies late siblings and aliases without approving ordinary edits', t => {
  const f = fixture(t), workspace = path.join(f.own.worktrees, "own 'lane"), existing = path.join(f.own.worktrees, 'sibling');
  fs.mkdirSync(workspace); fs.mkdirSync(existing);
  const hooks = {PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'existing-hook'}]}]};
  for (const role of ['worker']) {
    const cwd = role==='worker'?workspace:f.own.checkout;
    const launch = nativeSandboxLaunch({kind:'claude',binary:f.binary,args:['--settings',JSON.stringify({hooks})],context:{...f.context,role,workspace:cwd}});
    t.after(launch.close);
    const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings')+1]));
    assert.deepEqual(settings.hooks.PreToolUse[0], hooks.PreToolUse[0]);
    const guard = settings.hooks.PreToolUse.at(-1);
    assert.equal(guard.matcher, 'Edit|Write|NotebookEdit');
    const late = path.join(f.own.worktrees, 'late-'+role); fs.mkdirSync(late);
    const alias = path.join(cwd, 'alias-'+role); fs.symlinkSync(late, alias);
    const dangling = path.join(cwd, 'dangling-'+role); fs.symlinkSync(path.join(f.own.worktrees,'missing-'+role),dangling);
    const outsideAlias = path.join(f.root, 'alias-'+role); fs.symlinkSync(late, outsideAlias);
    const invoke = (tool_name, file) => {
      const event = {tool_name,cwd,tool_input:tool_name==='NotebookEdit'?{notebook_path:file}:{file_path:file}};
      const result = spawnSync('/bin/sh',['-c',guard.hooks[0].command],{env:launch.env,input:JSON.stringify(event),encoding:'utf8',timeout:5000});
      assert.equal(result.status,0,result.stderr);
      return result.stdout?JSON.parse(result.stdout).hookSpecificOutput:null;
    };
    for (const tool of ['Edit','Write','NotebookEdit']) {
      for (const file of [undefined,path.join(dangling,'new.md'),path.join(existing,'report.md'),path.join(late,'new.md'),path.join(alias,'new.md'),path.join(outsideAlias,'new.md'),path.relative(cwd,path.join(late,'new.md'))]) {
        const decision = invoke(tool,file);
        assert.equal(decision.hookEventName,'PreToolUse');
        assert.equal(decision.permissionDecision,'deny', tool+':'+file);
      }
      for (const file of [path.join(cwd,'own.md'),path.join(launch.env.TMPDIR,'note.md'),path.join(f.own.record,'report.md')])
        assert.equal(invoke(tool,file),null,'ordinary edits retain native permission flow');
    }
    assert.equal(invoke('Read',path.join(late,'report.md')),null,'no read interception');
  }
});

test('Codex generated and legacy sandbox branches both receive exact project trust', t => {
  const f = fixture(t), workspace = path.join(f.own.worktrees, 'lane.with "quotes"'); fs.mkdirSync(workspace);
  const context = { ...f.context, workspace };
  for (const legacy of [false, true]) {
    if (legacy) fs.writeFileSync(f.binary, '#!/bin/sh\nif [ "$1" = --help ]; then echo "--sandbox --add-dir"; fi\n', { mode: 0o755 });
    const launch = nativeSandboxLaunch({ kind: 'codex', binary: f.binary, args: ['resume', 'session'], context }); t.after(launch.close);
    assert.deepEqual(launch.args.filter(arg => arg.startsWith('projects=')), [projectTrust([f.own.checkout, workspace])]);
    assert.ok(launch.args.includes(legacy ? 'sandbox_mode="workspace-write"' : 'default_permissions="monitor-worker"'));
  }
});

test('native Codex config reader accepts dotted and quoted launch trust without persisting it', {
  skip: !process.env.MONITOR_TEST_CODEX_CONFIG && 'set MONITOR_TEST_CODEX_CONFIG for the offline native config reader',
}, async t => {
  const f = fixture(t), binary = process.env.MONITOR_TEST_CODEX_CONFIG;
  const workspace = path.join(f.own.worktrees, 'lane.with "quotes"'); fs.mkdirSync(workspace);
  command('git', ['init', '-qb', 'main'], f.own.checkout);
  command('git', ['config', 'user.name', 'Trust test'], f.own.checkout);
  command('git', ['config', 'user.email', 'trust@example.invalid'], f.own.checkout);
  fs.writeFileSync(path.join(f.own.checkout, 'seed'), 'seed');
  command('git', ['add', '.'], f.own.checkout); command('git', ['commit', '-qm', 'Seed'], f.own.checkout);
  fs.rmdirSync(workspace); command('git', ['worktree', 'add', '-qb', 'lane-worker', workspace], f.own.checkout);
  const configFile = path.join(process.env.CODEX_HOME, 'config.toml');
  const config = `sandbox_mode="workspace-write"\n[projects.${JSON.stringify(f.own.checkout)}]\ntrust_level="untrusted"\n[projects.${JSON.stringify(f.other.checkout)}]\ntrust_level="untrusted"\n`;
  fs.writeFileSync(configFile, config);
  fs.mkdirSync(path.join(workspace, '.codex'));
  fs.writeFileSync(path.join(workspace, '.codex/config.toml'), 'developer_instructions="offline project trust marker"\n');
  const launch = nativeSandboxLaunch({ kind: 'codex', binary, args: [], context: { ...f.context, workspace }, warn: () => {} }); t.after(launch.close);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server', '--stdio', ...launch.args], { cwd: workspace, env: { ...launch.env, HOME: f.root }, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    let reply, stderr = '', error;
    const timer = setTimeout(() => { error = new Error('native config reader timed out'); child.kill('SIGKILL'); }, 10000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', e => { error = e; });
    child.on('close', () => { clearTimeout(timer); lines.close(); if (error || !reply) reject(error ?? new Error(stderr)); else resolve(reply); });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.id === 1) {
        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
        child.stdin.write(JSON.stringify({ id: 2, method: 'config/read', params: { cwd: workspace, includeLayers: true } }) + '\n');
      }
      if (message.id === 2) { reply = message; child.kill('SIGTERM'); }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'offline-trust-test', version: '1' }, capabilities: { experimentalApi: true } } }) + '\n');
  });
  assert.equal(result.error, undefined, JSON.stringify(result));
  const loaded = result.result.config;
  for (const directory of [f.own.checkout, workspace]) assert.equal(loaded.projects[directory].trust_level, 'trusted');
  assert.equal(loaded.projects[f.other.checkout].trust_level, 'untrusted');
  assert.equal(loaded.developer_instructions, 'offline project trust marker', 'native loader enables the trusted worktree project layer');
  assert.equal(fs.readFileSync(configFile, 'utf8'), config);
});

test('Claude 2.1.292 native permissions prevent read prompts and confine sibling file writes by role', {
  skip: !process.env.MONITOR_TEST_CLAUDE_READ && 'set MONITOR_TEST_CLAUDE_READ for the offline native permission check',
}, t => {
  const f = fixture(t), binary = process.env.MONITOR_TEST_CLAUDE_READ;
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 });
  assert.match(version.stdout, /^2\.1\.292 /u, 'private native permission proof is pinned to this version');
  const source = fs.readFileSync(binary, 'utf8');
  const module = source.match(/import\{[^{}]*\bZh\b[^{}]*\}from"(\/\$bunfs\/root\/[^"\n]+)"/u)?.[1];
  assert.ok(module, 'find the exported native permission functions');
  // san is the interactive outside-read gate, not exported by the bundle.
  // Evaluate its exact installed body with an interactive auto-mode context;
  // the permission matchers below are imported directly from the binary.
  const gate = source.match(/function san\(e,n,r,s\)\{.*?(?=function fzo\()/u)?.[0];
  assert.ok(gate, 'find the native outside-read prompt gate');
  const preload = path.join(f.root, 'read-preload.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import assert from 'node:assert/strict';
try {
  const input = JSON.parse(fs.readFileSync(process.env.MONITOR_READ_PROBE, 'utf8'));
  const { Zh, DE: read, Iy: edit } = await import(input.module);
  const permissions = {
    mode: 'auto', additionalWorkingDirectories: new Map(input.directories.map(path => [path, {path, source:'cliArg'}])),
    alwaysAllowRules: {cliArg: input.settings.permissions.allow},
    alwaysDenyRules: {cliArg: input.settings.permissions.deny}, alwaysAskRules: {},
  };
  const gate = new Function('fwr','de','Ni','Lt','V0e','An','ce', input.gate + '; return san;')(
    new Set(['Read','Grep','Glob']), ctx => ctx.permissions, mode => mode === 'auto',
    () => false, () => false, () => true, () => ({hasSeenAutoModeOutsideReadPrompt:false}));
  const context = {permissions, options:{isNonInteractiveSession:false}, session:{outsideReadPrompt:{
    answered:false, isOpenElsewhere:()=>false,
  }}};
  const report = input.sibling + '/report.md';
  const tool = {name:'Read', getPath:i=>i.file_path}, args = {file_path:report};
  assert.equal(Zh(report, permissions), false, 'shared lanes are outside working directories');
  const control = read(tool, args, {...permissions, alwaysAllowRules:{}});
  assert.equal(control.behavior, 'ask', 'without scoped Read rules, a lane read needs permission');
  assert.equal(gate(tool, args, control, context), true, 'interactive auto-mode control opens the actual outside-read prompt');
  const allowed = read(tool, args, permissions);
  assert.equal(allowed.behavior, 'allow');
  assert.equal(allowed.decisionReason.type, 'rule', 'read grant must be an explicit native rule');
  assert.equal(gate(tool, args, allowed, context), false, 'generated Read rule prevents the prompt');
  for (const name of ['Edit','Write','NotebookEdit']) for (const mode of ['default','acceptEdits','auto','bypassPermissions']) {
    for (const file of [report, input.sibling + '/new.md', input.workspace + '/sibling-link/report.md']) {
      if (input.role === 'supervisor' && file.includes('/sibling-link/')) continue;
      const denied = edit({name,getPath:i=>i.file_path}, {file_path:file}, {
        ...permissions, mode, alwaysAllowRules:{cliArg:[...permissions.alwaysAllowRules.cliArg, 'Edit', 'Edit(/' + input.worktrees + '/**)']},
      });
      assert.equal(denied.behavior, input.role === 'supervisor' ? 'allow' : 'deny', name + ':' + mode + ':' + file);
      assert.equal(denied.decisionReason.type, 'rule');
    }
  }
  const own = input.workspace + '/own.md';
  assert.equal(edit({name:'Edit',getPath:i=>i.file_path}, {file_path:own}, {...permissions,mode:'acceptEdits'}).behavior, 'allow');
  for (const directory of input.peers) {
    assert.equal(read(tool, {file_path:directory+'/report.md'}, permissions).behavior, 'ask', 'no peer Read grant');
  }
  // Explicit user read blocks/denies retain native precedence.
  assert.equal(read(tool, args, {...permissions,blockReadsOutsideWorkingDirectories:true}).behavior, 'deny');
  assert.equal(read(tool, args, {...permissions,alwaysDenyRules:{cliArg:[...input.settings.permissions.deny,'Read(/'+input.worktrees+'/**)']}}).behavior, 'deny');
  console.log('native read prompt and role-specific Edit/Write/NotebookEdit boundaries passed');
  process.exit(0);
} catch (error) { console.error(error); process.exit(1); }
`);
  const workspace = path.join(f.own.worktrees, 'lane-worker'), sibling = path.join(f.own.worktrees, 'lane-sibling');
  fs.mkdirSync(workspace); fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, 'report.md'), 'sibling report');
  fs.symlinkSync(sibling, path.join(workspace, 'sibling-link'));
  for (const role of ['supervisor', 'worker']) {
    const context = { ...f.context, role, workspace: role === 'worker' ? workspace : f.own.checkout };
    const launch = nativeSandboxLaunch({ kind:'claude', binary, args:['--setting-sources',''], context, warn:()=>{} }); t.after(launch.close);
    const input = path.join(f.root, 'read-probe.json');
    fs.writeFileSync(input, JSON.stringify({ module, gate, role, workspace:context.workspace, sibling,
      worktrees:f.own.worktrees, settings:JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings')+1])),
      directories:launch.args.filter((_,i)=>launch.args[i-1]==='--add-dir'), peers:Object.values(f.other) }));
    const result = spawnSync(binary, ['--version'], {cwd:context.workspace,
      env:{...launch.env,HOME:f.root,MONITOR_READ_PROBE:input,BUN_OPTIONS:`--preload ${preload}`}, encoding:'utf8',timeout:10000});
    assert.equal(result.status, 0, result.stdout+result.stderr);
    assert.match(result.stdout, /native read prompt and role-specific Edit\/Write\/NotebookEdit boundaries passed/u);
  }
});

test('Claude preserves interpreter exclusions from loaded settings and names their source once', t => {
  const f = fixture(t), file = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ sandbox: { excludedCommands: ['node'] } }));
  for (const args of [['Task'], ['--settings', JSON.stringify({ sandbox: { excludedCommands: ['python'] } }), 'Task']]) {
    const warnings = [];
    const launch = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args, context: f.context, warn: s => warnings.push(s) });
    t.after(launch.close);
    const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
    assert.ok(!settings.sandbox.excludedCommands || settings.sandbox.excludedCommands.includes('python'));
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).sandbox.excludedCommands, ['node']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /WARNING.*sandbox.excludedCommands/u);
    assert.ok(warnings[0].includes(file));
    if (args.includes('--settings')) assert.ok(warnings[0].includes('--settings'));
  }
});

test('Claude preserves undeclared directories and sibling temp grants with one source-naming warning', t => {
  const f = fixture(t), file = path.join(f.own.checkout, '.claude/settings.local.json');
  fs.mkdirSync(path.dirname(file));
  const inherited = { permissions: { additionalDirectories: [f.root] }, sandbox: { filesystem: { allowWrite: [f.own.temp] } } };
  fs.writeFileSync(file, JSON.stringify(inherited));
  const warnings = [], hooks = { Stop: [{ hooks: [{ type: 'command', command: 'herdr-agent-state.sh' }] }] };
  const launch = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args: ['--settings', JSON.stringify({ hooks, permissions: { additionalDirectories: [f.other.temp] }, sandbox: { filesystem: { allowWrite: [f.own.temp] } } }), 'Task'], context: f.context, warn: s => warnings.push(s) });
  t.after(launch.close);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), inherited);
  const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
  assert.deepEqual(settings.permissions.additionalDirectories, [f.other.temp]);
  assert.ok(settings.sandbox.filesystem.allowWrite.includes(f.own.temp), 'the supplied sibling temp grant is preserved');
  assert.deepEqual(settings.hooks.Stop, hooks.Stop);
  assert.equal(warnings.length, 1);
  for (const setting of ['permissions.additionalDirectories', 'sandbox.filesystem.allowWrite', file, '--settings']) assert.ok(warnings[0].includes(setting), warnings[0]);
});

test('nested fleet roots refuse before launch in both Codex paths and Claude', t => {
  const f = fixture(t);
  for (const kind of ['codex', 'claude']) for (const modern of [true, false]) {
    fs.writeFileSync(f.binary, `#!/bin/sh\nif [ "$1" = --help ] || [ "$2" = --help ]; then echo "--sandbox --add-dir --settings ${modern ? '--permission-profile' : ''}"; elif [ "$1" = --version ]; then echo "2.1.284"; fi\n`, { mode: 0o755 });
    for (const own of [f.own.checkout, f.own.record, f.own.temp, f.own.worktrees]) for (const key of ['checkout', 'record', 'temp', 'worktrees']) {
      const nested = path.join(own, `peer-${key}`); fs.mkdirSync(nested, { recursive: true });
      const context = { ...f.context, worktrees: f.own.worktrees, projects: [{ ...f.other, [key]: nested }] };
      assert.throws(() => nativeSandboxLaunch({ kind, binary: f.binary, args: [], context }), /overlapping fleet.*peer-/u);
    }
    assert.throws(() => nativeSandboxLaunch({ kind, binary: f.binary, args: [], context: { ...f.context, projects: [{ ...f.other, checkout: f.root }] } }), /overlapping fleet/u);
  }
});

test('workers protect canonical receipts with native filesystem and Edit rules and keep the queue outside', t => {
  const f = fixture(t), protectedPath = path.join(f.own.checkout, '.lane/discovery');
  fs.mkdirSync(protectedPath, { recursive: true });
  const requests = path.join(f.own.temp, 'queue'); fs.mkdirSync(requests);
  const context = { ...f.context, role: 'worker', requests };
  const codex = nativeSandboxLaunch({ kind: 'codex', binary: f.binary, args: [], context }); t.after(codex.close);
  assert.ok(codex.args.find(a => a.startsWith('permissions.monitor-worker.filesystem=')).includes(`${JSON.stringify(protectedPath)}="read"`));
  for (const role of ['worker', 'supervisor']) {
    const launch = nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args: [], context: { ...context, role } }); t.after(launch.close);
    const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
    assert.equal(settings.sandbox.filesystem.denyWrite.includes(protectedPath), role === 'worker');
    assert.equal(settings.sandbox.filesystem.denyWrite.includes(path.dirname(protectedPath)), role === 'worker');
    assert.equal(settings.permissions.deny.includes(`Edit(/${protectedPath}/**)`), role === 'worker');
    assert.ok(settings.sandbox.filesystem.allowWrite.includes(requests));
  }
  assert.throws(() => nativeSandboxLaunch({ kind: 'claude', binary: f.binary, args: [], context: { ...context, requests: protectedPath } }), /request queue.*coordination/u);
  if (process.env.MONITOR_TEST_SANDBOX) {
    const binary = process.env.MONITOR_TEST_SANDBOX;
    const launch = nativeSandboxLaunch({ kind: 'codex', binary, args: [], context }); t.after(launch.close);
    const receipt = path.join(protectedPath, 'receipt.json'); fs.writeFileSync(receipt, 'trusted');
    const script = `const fs=require('fs'),assert=require('assert');
assert.throws(()=>fs.writeFileSync(${JSON.stringify(receipt)},'tampered'),e=>['EPERM','EACCES'].includes(e.code));
assert.throws(()=>fs.renameSync(${JSON.stringify(path.dirname(protectedPath))},${JSON.stringify(path.join(f.own.checkout, 'moved'))}),e=>['EPERM','EACCES'].includes(e.code));
fs.writeFileSync(${JSON.stringify(path.join(requests, 'ok'))},'ok');`;
    const result = spawnSync(binary, ['sandbox', '--permission-profile', 'monitor-worker', '-C', f.own.checkout, ...launch.args, '--', process.execPath, '-e', script], { cwd: f.own.checkout, env: launch.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(receipt, 'utf8'), 'trusted');
  }
  fs.writeFileSync(f.binary, '#!/bin/sh\nif [ "$1" = --help ]; then echo "--sandbox --add-dir"; fi\n', { mode: 0o755 });
  assert.throws(() => nativeSandboxLaunch({ kind: 'codex', binary: f.binary, args: [], context }), /cannot protect.*coordination/u);
});

test('assigned and headless adapters keep the checkout and run with native settings and temp', t => {
  const f = fixture(t); fixtureFleet(t, f.root);
  command('git', ['init', '-qb', 'main'], f.own.checkout);
  command('git', ['config', 'user.name', 'Native sandbox test'], f.own.checkout);
  command('git', ['config', 'user.email', 'test@example.invalid'], f.own.checkout);
  fs.writeFileSync(path.join(f.own.checkout, 'seed'), 'seed');
  command('git', ['add', '.'], f.own.checkout); command('git', ['commit', '-qm', 'Seed'], f.own.checkout);
  const fleet = joinFleet({ cwd: f.own.checkout, temp: f.own.temp });
  assert.equal(path.basename(fleet.project.worktrees), 'worktrees', 'exercise the default fleet layout');
  const workspace = path.join(fleet.project.worktrees, 'lane-worker');
  command('git', ['worktree', 'add', '-qb', 'lane-worker', workspace], f.own.checkout);
  const nativeConfig = path.join(process.env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(nativeConfig, 'sandbox_mode="workspace-write"\n');
  const receipt = path.join(f.root, 'receipt.json');
  fs.writeFileSync(f.binary, `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2);
if(args.includes('--help')){console.log('--sandbox --add-dir --settings --permission-profile');process.exit(0);}
if(args.includes('--version')){console.log('2.1.284');process.exit(0);}
const env=process.env;
fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({args,cwd:process.cwd(),temp:env.TMPDIR,tmp:env.TMP,temp2:env.TEMP,socket:env.HERDR_SOCKET_PATH,
 settings:args.includes('--settings')?JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1])):null}));`, { mode: 0o755 });
  for (const kind of ['codex', 'claude']) for (const role of ['supervisor', 'worker']) for (const resume of [false, true]) {
    const repo = role === 'worker' ? workspace : f.own.checkout;
    const args = resume ? ['--resume', 'fixture-session'] : kind === 'codex' ? ['exec', '--model', 'literal', 'Task'] : ['--print', '--model', 'literal', 'Task'];
    const result = spawnSync(process.execPath, [new URL(`../adapters/${kind}.mjs`, import.meta.url).pathname, '--auto-entry', '--role', role, '--repo', repo, '--binary', f.binary, '--', ...args], {
      cwd: repo, env: { ...process.env, MONITOR_ENTRY_BYPASS: '1', HERDR_SOCKET_PATH: '/fake/herdr.sock' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const got = JSON.parse(fs.readFileSync(receipt));
    assert.equal(got.cwd, repo); assert.equal(path.dirname(got.temp), fleet.project.temp);
    assert.equal(got.temp, got.tmp); assert.equal(got.tmp, got.temp2); assert.equal(got.socket, '/fake/herdr.sock');
    assert.ok(!fs.existsSync(got.temp), 'finished run temp is removed');
    if (kind === 'codex') {
      assert.deepEqual(got.args.filter(arg => arg.startsWith('projects=')), [projectTrust([f.own.checkout, repo])]);
      assert.ok(!got.args.includes('default_permissions="monitor-worker"'));
    } else {
      assert.equal(got.settings.sandbox.enabled, true);
      const expected = [fleet.project.worktrees, fleet.project.record, got.temp];
      assert.deepEqual(got.args.filter((_, i) => got.args[i - 1] === '--add-dir'), [got.temp]);
      assert.deepEqual(got.settings.sandbox.filesystem.allowRead, expected);
    }
    assert.equal(fs.readFileSync(nativeConfig, 'utf8'), 'sandbox_mode="workspace-write"\n');
  }
});

for (const kind of ['codex', 'claude']) for (const mode of ['default', 'prefix', 'disabled', 'empty-prefix', 'empty-disabled', 'empty-both',
  ...(kind === 'claude' ? ['settings-prefix', 'settings-disabled'] : [])]) {
  test(`${kind} adapter Python import keeps bytecode out of the worktree (${mode})`, t => {
    const python = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (python.error || python.status !== 0) {
      t.skip(`python3 is unavailable or non-functional (${python.error?.message ?? `exit ${python.status}`}): Python import probe skipped`);
      return;
    }
    const f = fixture(t); fixtureFleet(t, f.root);
    command('git', ['init', '-qb', 'main'], f.own.checkout);
    command('git', ['config', 'user.name', 'Python cache test'], f.own.checkout);
    command('git', ['config', 'user.email', 'test@example.invalid'], f.own.checkout);
    fs.writeFileSync(path.join(f.own.checkout, 'cache_probe.py'), 'value = 246\n');
    command('git', ['add', '.'], f.own.checkout); command('git', ['commit', '-qm', 'Seed'], f.own.checkout);
    joinFleet({ cwd: f.own.checkout, temp: f.own.temp });
    const receipt = path.join(f.root, 'python.json'), operatorCache = path.join(f.root, 'operator-cache');
    const script = `import cache_probe, json, os, sys
print(json.dumps(dict(value=cache_probe.value, prefix=sys.pycache_prefix, disabled=sys.dont_write_bytecode,
                     cached=cache_probe.__cached__, exists=os.path.exists(cache_probe.__cached__))))`;
    // The offline native stand-in executes a shell command with the launch env;
    // Claude applies settings.env to its shell commands as well.
    fs.writeFileSync(f.binary, `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2);
if(args.includes('--help')){console.log('--sandbox --add-dir --settings --permission-profile');process.exit(0);}
if(args.includes('--version')){console.log('2.1.284');process.exit(0);}
const settings=args.includes('--settings')?JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1])):{};
const env={...process.env,...settings.env};
const result=require('child_process').spawnSync('python3',['-c',${JSON.stringify(script)}],{env,encoding:'utf8',timeout:10000});
if(result.status!==0){console.error(result.error?.message??result.stderr);process.exit(1);}
fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({temp:env.TMPDIR,python:JSON.parse(result.stdout)}));`, { mode: 0o755 });
    const env = { ...process.env, MONITOR_ENTRY_BYPASS: '1', PYTHONPYCACHEPREFIX: undefined, PYTHONDONTWRITEBYTECODE: undefined };
    if (mode === 'prefix') env.PYTHONPYCACHEPREFIX = operatorCache;
    if (mode === 'disabled') env.PYTHONDONTWRITEBYTECODE = '1';
    if (mode === 'empty-prefix' || mode === 'empty-both') env.PYTHONPYCACHEPREFIX = '';
    if (mode === 'empty-disabled' || mode === 'empty-both') env.PYTHONDONTWRITEBYTECODE = '';
    const args = kind === 'codex' ? ['exec', 'Task'] : ['--print', 'Task'];
    if (mode.startsWith('settings-')) args.push('--settings', JSON.stringify({ env: mode === 'settings-prefix'
      ? { PYTHONPYCACHEPREFIX: operatorCache } : { PYTHONDONTWRITEBYTECODE: '1' } }));
    const result = spawnSync(process.execPath, [new URL(`../adapters/${kind}.mjs`, import.meta.url).pathname,
      '--auto-entry', '--repo', f.own.checkout, '--binary', f.binary, '--', ...args], {
      cwd: f.own.checkout, env, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
    const disabled = mode === 'disabled' || mode === 'settings-disabled';
    const operatorPrefix = mode === 'prefix' || mode === 'settings-prefix';
    const got = JSON.parse(fs.readFileSync(receipt)), prefix = operatorPrefix ? operatorCache : path.join(got.temp, 'pycache');
    assert.equal(got.python.value, 246);
    assert.equal(got.python.disabled, disabled);
    assert.equal(got.python.prefix, disabled ? null : prefix);
    assert.equal(got.python.exists, !disabled, 'the import writes bytecode unless disabled');
    if (!disabled) assert.ok(got.python.cached.startsWith(prefix + path.sep), got.python.cached);
    if (operatorPrefix) assert.ok(fs.existsSync(got.python.cached), 'operator cache survives run cleanup');
    assert.ok(!fs.existsSync(path.join(f.own.checkout, '__pycache__')));
    assert.equal(command('git', ['status', '--porcelain'], f.own.checkout), '', 'import leaves the worktree clean');
    assert.ok(!fs.existsSync(got.temp), 'run cleanup removes its bytecode cache');
  });
}

test('validation gets isolated fleet temp, denies peer writes and cleans scratch on failure', t => {
  const f = fixture(t), provider = path.join(f.root, 'provider'), observations = path.join(f.root, 'validation.json');
  const shared = path.join(f.own.checkout, '.org'); fs.mkdirSync(shared);
  fs.writeFileSync(path.join(f.own.checkout, '.lane.json'), JSON.stringify({ validate: '/usr/bin/true' }));
  fs.writeFileSync(provider, `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2),env=process.env;
fs.writeFileSync(${JSON.stringify(observations)},JSON.stringify({temp:env.TMPDIR,tmp:env.TMP,temp2:env.TEMP,args}));process.exit(17);`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [new URL('../validate.mjs', import.meta.url).pathname, provider, f.own.checkout, JSON.stringify([shared])], {
    cwd: f.own.checkout, env: { ...process.env, MONITOR_PROJECT_TEMP: f.own.temp, MONITOR_PROJECT_CONFIG: '', MONITOR_VALIDATION_DEADLINE: undefined, MONITOR_VALIDATION_TIER: 'fast' }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /sandboxed validation exited 17/u);
  const got = JSON.parse(fs.readFileSync(observations));
  assert.equal(path.dirname(got.temp), f.own.temp); assert.equal(got.temp, got.tmp); assert.equal(got.tmp, got.temp2);
  assert.ok(!fs.existsSync(got.temp));
  const filesystem = got.args.find(a => a.startsWith('permissions.monitor-validation.filesystem='));
  assert.ok(filesystem.includes(`${JSON.stringify(got.temp)}="write"`));
  for (const directory of Object.values(f.other)) assert.ok(!filesystem.includes(directory));
});

test('real Codex native roots deny peer writes and worker control-socket access including symlinks', {
  skip: !process.env.MONITOR_TEST_SANDBOX && 'set MONITOR_TEST_SANDBOX for the offline native boundary probe',
}, t => {
  const f = fixture(t), binary = process.env.MONITOR_TEST_SANDBOX;
  const launch = nativeSandboxLaunch({ kind: 'codex', binary, args: [], context: f.context }); t.after(launch.close);
  const targets = [f.other.checkout, f.other.record, f.other.temp];
  fs.symlinkSync(f.other.checkout, path.join(f.own.checkout, 'escape'));
  const socketAlias = path.join(f.own.checkout, 'herdr-alias'); fs.symlinkSync(f.socket, socketAlias);
  const script = `const fs=require('fs'),assert=require('assert');
for(const p of ${JSON.stringify([...targets.map(p => path.join(p, 'bad')), path.join(f.own.checkout, 'escape/bad'), path.join(f.root, 'system-temp')])})assert.throws(()=>fs.writeFileSync(p,'bad'),e=>['EPERM','EACCES'].includes(e.code),p);
for(const p of ${JSON.stringify([f.own.checkout, f.own.record, launch.env.TMPDIR])})fs.writeFileSync(p+'/ok','ok');
(async()=>{for(const socket of ${JSON.stringify([f.socket, socketAlias])}) {
  const code=await new Promise(resolve=>{const c=require('net').connect(socket);c.once('error',e=>resolve(e.code));c.once('connect',()=>{c.destroy();resolve('ALLOWED')});});
  assert.ok(['EPERM','EACCES'].includes(code),socket+': '+code);
}})().catch(e=>{console.error(e);process.exitCode=1});`;
  const settings = launch.args.filter((_, i) => launch.args[i - 1] === '-c');
  const result = spawnSync(binary, ['sandbox', '--permission-profile', 'monitor-worker', '-C', f.own.checkout, ...settings.flatMap(s => ['-c', s]), '--', process.execPath, '-e', script], {
    cwd: f.own.checkout, env: launch.env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
