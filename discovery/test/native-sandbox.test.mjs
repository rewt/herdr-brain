import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { joinFleet } from '../../lib/fleet.mjs';
import { command } from '../runtime.mjs';
import { runTemporary, temporaryEnvironment } from '../temporary.mjs';
import { nativeSandboxLaunch, nativeSession } from '../native-sandbox.mjs';

function fixture(t, fallbackState = 'owned') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'a18-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = { checkout: path.join(root, 'a'), record: path.join(root, 'ar'), temp: path.join(root, 'at'), worktrees: path.join(root, 'aw') };
  const other = { checkout: path.join(root, 'b'), record: path.join(root, 'br'), temp: path.join(root, 'bt'), worktrees: path.join(root, 'bw') };
  for (const directory of [...Object.values(own), ...Object.values(other)]) fs.mkdirSync(directory);
  const context = { workspace: own.checkout, canonical: own.checkout, org: own.record, tempRoot: own.temp, projects: [other] };
  const binary = path.join(root, 'native');
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
  return { root, own, other, context, binary, fallback, fallbackInspections: () => fallbackInspections };
}

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
  assert.deepEqual(settings.hooks, hooks);
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
    else assert.ok(launch.args.includes(extra));
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
    assert.deepEqual(launch.args, choice.args, 'the operator sandbox choice remains untouched');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /WARNING.*sandbox_mode.*danger-full-access/u);
    assert.ok(warnings[0].includes(choice.source), warnings[0]);
  }
  fs.writeFileSync(file, '# no base override\n');
  const profile = path.join(process.env.CODEX_HOME, 'weaker.config.toml');
  fs.writeFileSync(profile, 'sandbox_mode = "danger-full-access"\n');
  const warnings = [], args = ['--profile', 'weaker', 'Task'];
  const launch = nativeSandboxLaunch({ kind: 'codex', binary: f.binary, args, context: f.context, warn: s => warnings.push(s) }); t.after(launch.close);
  assert.deepEqual(launch.args, args); assert.equal(warnings.length, 1); assert.ok(warnings[0].includes(profile));
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
  assert.deepEqual(settings.hooks, hooks);
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
  const receipt = path.join(f.root, 'receipt.json');
  fs.writeFileSync(f.binary, `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2);
if(args.includes('--help')){console.log('--sandbox --add-dir --settings --permission-profile');process.exit(0);}
if(args.includes('--version')){console.log('2.1.284');process.exit(0);}
const env=process.env;
fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({args,cwd:process.cwd(),temp:env.TMPDIR,tmp:env.TMP,temp2:env.TEMP,socket:env.HERDR_SOCKET_PATH,
 settings:args.includes('--settings')?JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1])):null}));`, { mode: 0o755 });
  for (const kind of ['codex', 'claude']) {
    const args = kind === 'codex' ? ['exec', '--model', 'literal', 'Task'] : ['--print', '--model', 'literal', 'Task'];
    const result = spawnSync(process.execPath, [new URL(`../adapters/${kind}.mjs`, import.meta.url).pathname, '--auto-entry', '--repo', f.own.checkout, '--binary', f.binary, '--', ...args], {
      cwd: f.own.checkout, env: { ...process.env, MONITOR_ENTRY_BYPASS: '1', HERDR_SOCKET_PATH: '/fake/herdr.sock' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const got = JSON.parse(fs.readFileSync(receipt));
    assert.equal(got.cwd, f.own.checkout); assert.equal(path.dirname(got.temp), fleet.project.temp);
    assert.equal(got.temp, got.tmp); assert.equal(got.tmp, got.temp2); assert.equal(got.socket, '/fake/herdr.sock');
    assert.ok(!fs.existsSync(got.temp), 'finished run temp is removed');
    if (kind === 'codex') assert.ok(got.args.includes('default_permissions="monitor-worker"'));
    else assert.equal(got.settings.sandbox.enabled, true);
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

test('real Codex native roots deny another project checkout, record and temp including symlinks', {
  skip: !process.env.MONITOR_TEST_SANDBOX && 'set MONITOR_TEST_SANDBOX for the offline native boundary probe',
}, async t => {
  const f = fixture(t), binary = process.env.MONITOR_TEST_SANDBOX;
  const launch = nativeSandboxLaunch({ kind: 'codex', binary, args: [], context: f.context }); t.after(launch.close);
  const targets = [f.other.checkout, f.other.record, f.other.temp];
  const socket = path.join(f.root, 'herdr.sock');
  let notice;
  const notified = new Promise(resolve => { notice = resolve; });
  const server = net.createServer(client => { client.on('error', () => {}); client.once('data', data => { notice(data.toString()); client.end(); }); });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  fs.symlinkSync(f.other.checkout, path.join(f.own.checkout, 'escape'));
  const hookFile = process.env.MONITOR_TEST_HERDR_HOOK;
  const hookProbe = hookFile ? `const r=require('child_process').spawnSync('/bin/sh',[${JSON.stringify(hookFile)},'session'],{input:JSON.stringify({hook_event_name:'SessionStart',session_id:'fixture-session'}),env:{...process.env,HERDR_ENV:'1',HERDR_PANE_ID:'fixture-pane',HERDR_SOCKET_PATH:${JSON.stringify(socket)}},encoding:'utf8'});assert.equal(r.status,0,r.stderr);`
    : `const hook=require('net').connect(${JSON.stringify(socket)});hook.on('error',e=>{throw e});hook.on('connect',()=>hook.end('agent-status: working',()=>hook.destroy()));`;
  const script = `const fs=require('fs'),assert=require('assert');
for(const p of ${JSON.stringify([...targets.map(p => path.join(p, 'bad')), path.join(f.own.checkout, 'escape/bad'), path.join(f.root, 'system-temp')])})assert.throws(()=>fs.writeFileSync(p,'bad'),e=>['EPERM','EACCES'].includes(e.code),p);
for(const p of ${JSON.stringify([f.own.checkout, f.own.record, launch.env.TMPDIR])})fs.writeFileSync(p+'/ok','ok');
${hookProbe}`;
  const settings = launch.args.filter((_, i) => launch.args[i - 1] === '-c');
  const result = spawnSync(binary, ['sandbox', '--permission-profile', 'monitor-worker', '-C', f.own.checkout, ...settings.flatMap(s => ['-c', s]), '--', process.execPath, '-e', script], {
    cwd: f.own.checkout, env: launch.env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const sent = await notified;
  if (hookFile) {
    const request = JSON.parse(sent);
    assert.equal(request.method, 'pane.report_agent_session');
    assert.equal(request.params.pane_id, 'fixture-pane');
    assert.equal(request.params.agent_session_id, 'fixture-session');
  } else assert.equal(sent, 'agent-status: working');
});
