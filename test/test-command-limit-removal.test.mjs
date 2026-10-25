import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp, { spawnSync, execFileSync, execSync } from 'node:child_process';
// Install the existing lifetime adapter before taking the command identities.
import './helpers/fixture-lifetime.mjs';
import { commandAllowance } from './helpers/command-allowance.mjs';

const commands = { spawnSync: cp.spawnSync, execFileSync: cp.execFileSync, execSync: cp.execSync };
const helper = new URL('./helpers/bounded-test.mjs', import.meta.url);
const { default: test, currentTest, TEST_TIMEOUT, COMMAND_TIMEOUT } = await import(helper);

test('the shared boundary removes test timeout options and installs no command ceiling', () => {
  const source = fs.readFileSync(helper, 'utf8');
  assert.match(source, /const \{ timeout: _timeout, \.\.\.nodeOptions \} = options \?\? \{\};/);
  assert.match(source, /return nodeTest\(name, nodeOptions,/);
  assert.doesNotMatch(source, /loadTimeout|setTimeout|setInterval|Math\.min|childProcess|syncBuiltinESMExports/);
  assert.deepEqual({ spawnSync: cp.spawnSync, execFileSync: cp.execFileSync, execSync: cp.execSync }, commands);
  assert.deepEqual({ spawnSync, execFileSync, execSync }, commands, 'named ESM exports stay unchanged too');
  assert.equal(TEST_TIMEOUT, 60000);
  assert.equal(COMMAND_TIMEOUT, 15000);
  assert.equal(typeof commandAllowance, 'symbol');
});

test('sync command overloads and the legacy allowance token retain successful output', () => {
  const options = { encoding: 'utf8', [commandAllowance]: 'legacy marker' };
  assert.equal(cp.spawnSync('/bin/echo', ['spawn'], options).stdout, 'spawn\n');
  assert.equal(cp.spawnSync('/usr/bin/true', options).status, 0);
  assert.equal(cp.execFileSync('/bin/echo', ['file'], options), 'file\n');
  assert.equal(cp.execFileSync('/usr/bin/true', options), '');
  assert.equal(cp.execSync('printf shell', options), 'shell');
  assert.deepEqual(options, { encoding: 'utf8', [commandAllowance]: 'legacy marker' });
});

test('sync commands preserve real missing-command, exit, signal and option errors', t => {
  const missing = path.join(process.env.HERDR_TEST_OFFLINE_ROOT, 'absent-command');
  assert.equal(cp.spawnSync(missing).error.code, 'ENOENT');
  assert.throws(() => cp.execFileSync(missing), { code: 'ENOENT' });
  const result = cp.spawnSync('/bin/sh', ['-c', 'printf out; printf err >&2; exit 7'], { encoding: 'utf8' });
  assert.equal(result.status, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  for (const execute of [
    () => cp.execFileSync('/bin/sh', ['-c', 'printf out; printf err >&2; exit 7'], { encoding: 'utf8', stdio: 'pipe' }),
    () => cp.execSync('printf out; printf err >&2; exit 7', { encoding: 'utf8', stdio: 'pipe' }),
  ]) assert.throws(execute, error => error.status === 7 && error.stdout === 'out' && error.stderr === 'err');
  const signaled = cp.spawnSync('/bin/sh', ['-c', 'kill -TERM $$']);
  assert.equal(signaled.status, null);
  assert.equal(signaled.signal, 'SIGTERM');
  assert.throws(() => cp.spawnSync('/usr/bin/true', { killSignal: 'invalid-signal' }), { code: 'ERR_UNKNOWN_SIGNAL' });
  t.diagnostic('captured ENOENT, exit 7 with both streams, SIGTERM and ERR_UNKNOWN_SIGNAL');
});

function fixture(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-limit-removal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'fixture.test.mjs');
  const receipt = path.join(root, 'receipt.json');
  const cleanup = path.join(root, 'cleanup');
  fs.writeFileSync(file, `import test, { currentTest } from ${JSON.stringify(helper.href)};
import nativeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
assert.equal(test.test, test);
for (const key of ['describe','it','before','after','beforeEach','afterEach','run','mock']) assert.equal(test[key], nativeTest[key]);
assert.throws(currentTest, /fixture child must be spawned inside a test/);
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ slot: path.dirname(process.env.MONITOR_TEST_SLOT_PATH),
  fleet: process.env.HERDR_MONITOR_FLEET, offline: process.env.HERDR_TEST_OFFLINE_ROOT,
  fifo: process.env.HERDR_FIXTURE_LIFETIME_FIFO, token: process.env.MONITOR_TEST_SLOT_TOKEN ?? null }));
test.after(() => fs.appendFileSync(${JSON.stringify(cleanup)}, 'after\\n'));
${body(cleanup)}`);
  const result = cp.spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  const state = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.notEqual(state.slot, path.dirname(process.env.MONITOR_TEST_SLOT_PATH));
  assert.equal(fs.existsSync(state.slot), false, 'child exit removed its own slot scratch');
  assert.equal(state.offline, process.env.HERDR_TEST_OFFLINE_ROOT);
  assert.notEqual(state.fleet, process.env.HERDR_MONITOR_FLEET);
  assert.equal(state.token, null);
  assert.ok(fs.existsSync(state.fifo), 'existing FIFO ownership remains installed');
  assert.equal(fs.readFileSync(cleanup, 'utf8'), 'body cleanup\nafter\n');
  return result;
}

test('Node test modes, async context, hooks and isolated fixture cleanup still complete', t => {
  assert.equal(currentTest(), t);
  const result = fixture(t, cleanup => `
test('plain', t => assert.equal(currentTest(), t));
test.test('explicit options', { timeout: 60000, concurrency: true }, async t => {
  assert.equal(currentTest(), t);
  t.after(() => fs.appendFileSync(${JSON.stringify(cleanup)}, 'body cleanup\\n'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(currentTest(), t);
  await t.test('subtest', () => assert.ok(true));
});
test.only('only mode', t => assert.equal(currentTest(), t));
test.skip('skip mode', () => assert.fail('skip body ran'));
test.todo('todo mode');
test.describe('suite mode', () => test.it('native it', () => assert.ok(true)));
`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of ['plain', 'explicit options', 'subtest', 'only mode', 'skip mode', 'todo mode', 'suite mode', 'native it'])
    assert.ok(result.stdout.includes(name), result.stdout);
  assert.match(result.stdout, /# SKIP/);
  assert.match(result.stdout, /# TODO/);
  t.diagnostic('nested Node modes exit 0; hooks ran and the child slot scratch was removed');
});

for (const failure of ['body', 'cleanup']) {
  test(`real ${failure} errors remain failures and run fixture cleanup`, t => {
    const result = fixture(t, cleanup => `test('real ${failure} failure', t => {
  t.after(() => { fs.appendFileSync(${JSON.stringify(cleanup)}, 'body cleanup\\n');
    ${failure === 'cleanup' ? "throw Error('real cleanup witness');" : ''} });
  ${failure === 'body' ? "throw Error('real body witness');" : ''}
});`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`real ${failure} witness`));
    assert.match(result.stdout, /# fail 1/);
    t.diagnostic(`captured real ${failure} witness with exit 1; cleanup and child slot removal confirmed`);
  });
}
