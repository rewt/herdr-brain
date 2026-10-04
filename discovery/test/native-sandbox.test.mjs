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

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'a18-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = { checkout: path.join(root, 'a'), record: path.join(root, 'ar'), temp: path.join(root, 'at'), worktrees: path.join(root, 'aw') };
  const other = { checkout: path.join(root, 'b'), record: path.join(root, 'br'), temp: path.join(root, 'bt'), worktrees: path.join(root, 'bw') };
  for (const directory of [...Object.values(own), ...Object.values(other)]) fs.mkdirSync(directory);
  const context = { workspace: own.checkout, canonical: own.checkout, org: own.record, tempRoot: own.temp, projects: [other] };
  const binary = path.join(root, 'native');
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = --help ] || [ "$2" = --help ]; then echo "--sandbox --add-dir --settings --permission-profile"; elif [ "$1" = --version ]; then echo "2.1.284"; fi\n', { mode: 0o755 });
  return { root, own, other, context, binary };
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
  assert.deepEqual(temporaryEnvironment(a), { TMPDIR: a, TMP: a, TEMP: a });
});

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

test('legacy Codex uses writable roots with system temp excluded and refuses sandbox bypass', t => {
  const f = fixture(t);
  fs.writeFileSync(f.binary, '#!/bin/sh\nif [ "$1" = --help ]; then echo "--sandbox --add-dir"; fi\n', { mode: 0o755 });
  const launch = nativeSandboxLaunch({ kind: 'codex', binary: f.binary, args: ['--sandbox', 'workspace-write', 'Task'], context: f.context });
  t.after(launch.close);
  assert.ok(launch.args.includes('sandbox_mode="workspace-write"'));
  assert.ok(!launch.args.includes('--sandbox'));
  const roots = JSON.parse(launch.args.find(a => a.startsWith('sandbox_workspace_write.writable_roots=')).split('=').slice(1).join('='));
  assert.deepEqual(roots, [f.own.record, launch.env.TMPDIR]);
  assert.ok(launch.args.includes('sandbox_workspace_write.exclude_slash_tmp=true'));
  assert.ok(launch.args.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'));
  assert.throws(() => nativeSandboxLaunch({ kind: 'codex', binary: f.binary, args: ['--dangerously-bypass-approvals-and-sandbox'], context: f.context }), /bypass/u);
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
  assert.equal(settings.sandbox.network, undefined);
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
