import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lookupProcess, createProcessTracker } from './helpers/processes.mjs';

process.env.ORG_ACTOR = 'eng122-process-source-test';
const row = (identity = '1700000000:123456') => ({ pid: 101, ppid: 1, pgid: 101, state: 'S', identity, command: 'owned fixture' });
const output = value => ({ status: 0, stdout: JSON.stringify(value) + '\n', stderr: '' });

test('Darwin lookup uses a non-setuid source and preserves microsecond birth identity', () => {
  const calls = [];
  const result = lookupProcess(101, { platform: 'darwin', execute: (file, args) => {
    calls.push([file, args]); return output(row());
  } });
  assert.deepEqual(result, { ok: true, value: row() });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0][0], /(?:^|\/)ps$/);
});

test('a reused PID with identical argv and a different birth time never licenses PID or group signals', () => {
  for (const group of [false, true]) {
    let current = row();
    const tracker = createProcessTracker({
      readIdentity: pid => lookupProcess(pid, { platform: 'darwin', execute: () => output(current) }),
      sendSignal: () => assert.fail('replacement must not receive a signal'), report: () => {},
    });
    const owned = tracker.registerProcess(101, group);
    current = row('1700000000:123457');
    assert.equal(tracker.killProcess(owned).reason, 'changed');
  }
});

test('unavailable sources refuse clearly without falling back to ps or signalling', () => {
  const calls = [];
  const result = lookupProcess(101, { platform: 'darwin', execute: file => {
    calls.push(file); return { error: Object.assign(Error('source missing'), { code: 'ENOENT' }) };
  } });
  assert.equal(result.ok, false);
  assert.match(result.error, /process.*source|source.*unavailable/i);
  assert.ok(calls.every(file => !/(?:^|\/)ps$/.test(file)));
  assert.equal(lookupProcess(101, { platform: 'unsupported' }).ok, false);
});

function procStat(pid, birth = '12345', state = 'S') {
  // /proc stat fields 3..22; comm may contain spaces and closing parentheses.
  return `${pid} (fixture ) name) ${state} ${[1, pid, ...Array(16).fill(0), birth].join(' ')}\n`;
}
test('Linux proc lookup brackets argv with a stable kernel start tick and fails closed on races', () => {
  const read = values => file => {
    if (file.endsWith('/stat')) return values.shift();
    if (file.endsWith('/cmdline')) return Buffer.from('node\0fixture\0');
    throw Error(`unexpected read ${file}`);
  };
  const result = lookupProcess(101, { platform: 'linux', readFile: read([procStat(101), procStat(101)]) });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.identity, '12345');
  assert.equal(result.value.command, 'node fixture');
  for (const values of [[procStat(101), procStat(101, '12346')], ['partial', 'partial']]) {
    assert.equal(lookupProcess(101, { platform: 'linux', readFile: read(values) }).ok, false);
  }
  const denied = lookupProcess(101, { platform: 'linux', readFile: () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); } });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /denied/);
  assert.deepEqual(lookupProcess(101, { platform: 'linux', readFile: () => { throw Object.assign(Error('gone'), { code: 'ENOENT' }); } }), { ok: true, value: null });
});

test('Linux snapshots retain parentless group members, omit proven exits and refuse partial or unanchored reads', () => {
  const files = new Map();
  for (const pid of [process.pid, 101]) {
    files.set(`/proc/${pid}/stat`, procStat(pid));
    files.set(`/proc/${pid}/cmdline`, Buffer.from('owned fixture\0'));
  }
  const options = { platform: 'linux', listDirectory: () => ['self', String(process.pid), '101', '202'], readFile: file => {
    if (!files.has(file)) throw Object.assign(Error('gone'), { code: 'ENOENT' });
    return files.get(file);
  } };
  const result = lookupProcess(undefined, options);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual([...result.value.keys()], [process.pid, 101]);
  const tracker = createProcessTracker({ readIdentity: pid => lookupProcess(pid, options), readIdentities: () => lookupProcess(undefined, options) });
  const owned = tracker.registerProcess(101, true);
  files.set('/proc/303/stat', procStat(303).replace('S 1 303 ', 'S 1 101 '));
  files.set('/proc/303/cmdline', Buffer.from('orphan fixture\0'));
  options.listDirectory = () => [String(process.pid), '101', '303'];
  assert.deepEqual(tracker.auditGroup(owned).survivors.map(row => row.pid), [303]);
  files.set('/proc/303/cmdline', Buffer.from('truncated'));
  assert.equal(lookupProcess(undefined, options).ok, false);
  options.listDirectory = () => ['101'];
  assert.equal(lookupProcess(undefined, options).ok, false);
  options.listDirectory = () => { throw Error('proc unavailable'); };
  assert.match(lookupProcess(undefined, options).error, /proc unavailable/);
});

test('Darwin bundles refuse missing, damaged, stale, redirected and setuid sources before execution', async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eng122-bundle-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const library = fileURLToPath(new URL('../lib/', import.meta.url));
  for (const file of ['processes.mjs', 'deadline.mjs', 'files.mjs', 'process-source.c']) fs.copyFileSync(path.join(library, file), path.join(scratch, file));
  fs.cpSync(path.join(library, 'native'), path.join(scratch, 'native'), { recursive: true });
  const { lookupProcess: isolated } = await import(new URL(`file://${scratch}/processes.mjs`));
  const binary = path.join(scratch, 'native', `process-source-darwin-${process.arch}`);
  const original = fs.readFileSync(binary), source = path.join(scratch, 'process-source.c');
  const originalSource = fs.readFileSync(source);
  for (const kind of ['missing', 'damaged', 'stale', 'redirected', 'setuid']) {
    if (kind === 'missing') fs.unlinkSync(binary);
    if (kind === 'damaged') fs.writeFileSync(binary, 'damaged');
    if (kind === 'stale') fs.appendFileSync(source, '\nchanged');
    if (kind === 'redirected') { fs.unlinkSync(binary); fs.symlinkSync(path.join(library, 'native', path.basename(binary)), binary); }
    if (kind === 'setuid') {
      fs.chmodSync(binary, 0o4755);
      if (!(fs.statSync(binary).mode & 0o6000)) {
        t.diagnostic('host sandbox strips setuid chmod; verify mode refusal on the promotion host'); continue;
      }
    }
    const result = isolated(101, { platform: 'darwin', execute: () => assert.fail(`unverified ${kind} source executed`) });
    assert.equal(result.ok, false, kind);
    assert.match(result.error, /process source unavailable/);
    fs.rmSync(binary, { force: true }); fs.writeFileSync(binary, original, { mode: 0o755 });
    fs.writeFileSync(source, originalSource);
  }
});

test('the installed native reader returns exact unicode and multiline argv without any tools on PATH', { skip: process.platform !== 'darwin' && 'Darwin native integration' }, () => {
  const module = new URL('../lib/processes.mjs', import.meta.url).href;
  const program = `import {lookupProcess} from ${JSON.stringify(module)};const own=lookupProcess(process.pid);const snapshot=lookupProcess();console.log(JSON.stringify({own,anchored:snapshot.ok&&snapshot.value.has(process.pid)}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, 'é☃', 'two words', 'line\nbreak'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.own.ok, true, actual.own.error);
  assert.equal(actual.anchored, true);
  assert.match(actual.own.value.identity, /^\d+:\d+$/);
  assert.ok(actual.own.value.command.endsWith('é☃ two words line\nbreak'));
});

test('the bounded runner executes and cleans up under seatbelt, where setuid ps cannot execute', { skip: process.platform !== 'darwin' && 'seatbelt requires macOS' }, t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eng122-seatbelt-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const fixture = path.join(scratch, 'smoke.test.mjs');
  fs.writeFileSync(fixture, "import test from 'node:test'; test('sandbox runner smoke',()=>{});\n");
  const profile = '(version 1)(allow default)(deny network*)';
  const denied = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/ps', '-p', String(process.pid)], { encoding: 'utf8' });
  if (denied.stderr?.includes('sandbox_apply: Operation not permitted')) {
    t.skip('seatbelt cannot nest; run this acceptance on the unsandboxed promotion host'); return;
  }
  assert.notEqual(denied.status, 0, 'profile must block the actual setuid executable');
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, 'test/helpers/run.mjs', fixture], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /sandbox runner smoke/);
});

test('the runner refuses before running fixtures when the native source is unavailable', { skip: process.platform !== 'darwin' && 'Darwin native source failure' }, t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eng122-source-refusal-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const preload = path.join(scratch, 'deny-source.mjs'), fixture = path.join(scratch, 'never.test.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawnSync; cp.spawnSync=(file,...args)=>String(file).includes('process-source-') ? {status:125,stdout:'',stderr:'process source unavailable: injected denial'} : original(file,...args); syncBuiltinESMExports();`);
  fs.writeFileSync(fixture, "throw Error('FIXTURE_MUST_NOT_RUN');\n");
  const result = spawnSync(process.execPath, ['--import', preload, 'test/helpers/run.mjs', fixture], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot establish ownership.*source unavailable/);
  assert.doesNotMatch(result.stderr + result.stdout, /FIXTURE_MUST_NOT_RUN/);
});
