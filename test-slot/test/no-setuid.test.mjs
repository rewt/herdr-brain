import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';
import { processStart, processState, processStartRecord, legacyStart } from '../lock-support.mjs';
import { acquireTestSlot, holderState } from '../test-slot.mjs';

process.env.ORG_ACTOR = 'eng122-slot-source-test';
test('slot ownership records exact kernel births and refuses same-second PID reuse', { timeout: 15000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eng122-slot-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const lockPath = path.join(scratch, 'slot');
  const slot = await acquireTestSlot('test', { lockPath, env: testSlotEnvironment() });
  t.after(() => slot.release());
  const before = fs.readFileSync(lockPath, 'utf8');
  const holder = JSON.parse(before);
  assert.match(holder.processBirth, /^(darwin:\d+:\d+|linux:[a-f0-9-]{36}:\d+)$/);
  assert.equal(holderState(holder).state, 'live');
  assert.equal(holderState({ ...holder, processStart: 'ps-utc-c:wall clock adjusted' }).state, 'live', 'kernel birth remains stable across wall-clock changes');
  const replacement = holder.processBirth.replace(/\d+$/, value => String(BigInt(value) + 1n));
  assert.equal(holderState({ ...holder, processBirth: replacement }).state, 'gone');
  assert.equal(processState(process.pid, processStart(process.pid), replacement).state, 'gone');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
});

test('slot accepts the existing UTC/C holder schema and preserves live ambiguous legacy records', { timeout: 15000 }, () => {
  const start = processStart(process.pid);
  assert.match(start, /^ps-utc-c:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
  assert.equal(processState(process.pid, start).state, 'live');
  assert.equal(processState(process.pid, start.replace('ps-utc-c:', '')).state, 'unknown');
});

test('Linux legacy timestamps use kernel boot seconds and validated clock ticks', { timeout: 15000 }, () => {
  const options = { platform: 'linux', readFile: () => 'cpu 0 0 0\nbtime 1700000000\n', execute: () => ({ status: 0, stdout: '100\n', stderr: '' }) };
  assert.equal(legacyStart('12345', options), 'ps-utc-c:Tue Nov 14 22:15:23 2023');
  for (const result of [{ status: 0, stdout: '0' }, { status: 1, stdout: '' }, { error: Error('getconf missing') }])
    assert.throws(() => legacyStart('12345', { ...options, execute: () => result }), /clock ticks unavailable/);
  assert.throws(() => legacyStart('12345', { ...options, readFile: () => 'partial' }), /clock ticks unavailable/);
});

test('Linux slot births distinguish identical start ticks across reboots', { timeout: 15000 }, () => {
  const first = '11111111-1111-1111-1111-111111111111', next = '22222222-2222-2222-2222-222222222222';
  const identity = boot => processStartRecord(101, { platform: 'linux', lookup: () => ({ ok: true, value: { identity: '12345' } }),
    readFile: file => file.endsWith('boot_id') ? boot : 'btime 1700000000\n', execute: () => ({ status: 0, stdout: '100\n' }) });
  assert.notEqual(identity(first).birth, identity(next).birth);
  assert.throws(() => identity('partial'), /boot identity unavailable/);
});

test('a missing source refuses a fresh slot before creating a lock or starting its command', { timeout: 15000 }, t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eng122-slot-refusal-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const preload = path.join(scratch, 'deny.mjs'), lock = path.join(scratch, 'slot'), marker = path.join(scratch, 'started');
  fs.writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const execute=cp.spawnSync,read=fs.readFileSync;
cp.spawnSync=(file,...args)=>String(file).includes('process-source-')?{error:Object.assign(Error('source missing'),{code:'ENOENT'})}:execute(file,...args);
fs.readFileSync=(file,...args)=>String(file).startsWith('/proc/')?(()=>{throw Object.assign(Error('source missing'),{code:'EACCES'});})():read(file,...args);syncBuiltinESMExports();`);
  const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', preload, cli, 'run', 'denied', '--lock-path', lock, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`], { env: testSlotEnvironment(), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /TEST_SLOT_HOLDER_UNKNOWN:.*process source identity/);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(marker), false);
});

test('slot exclusion and token-free nesting work inside seatbelt without setuid ps', { timeout: 15000, skip: process.platform !== 'darwin' && 'seatbelt requires macOS' }, t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eng122-slot-seatbelt-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
  const lock = path.join(scratch, 'slot');
  const program = `import {spawnSync} from 'node:child_process';import {holderState} from ${JSON.stringify(new URL('../test-slot.mjs', import.meta.url).href)};import fs from 'node:fs';
const holder=JSON.parse(fs.readFileSync(${JSON.stringify(lock)},'utf8'));if(holderState(holder).state!=='live')throw Error('lost live holder');
const env={...process.env};delete env.MONITOR_TEST_SLOT_TOKEN;delete env.BCH_CLOAK_TEST_SLOT_TOKEN;
const inner=spawnSync(process.execPath,[${JSON.stringify(cli)},'run','nested','--lock-path',${JSON.stringify(lock)},'--',process.execPath,'-e','console.log("SLOT_NESTED")'],{env,encoding:'utf8',timeout:5000});if(inner.status!==0)throw Error(inner.stderr);console.log(inner.stdout);`;
  const profile = '(version 1)(allow default)(deny network*)';
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, cli, 'run', 'outer', '--lock-path', lock, '--', process.execPath, '--input-type=module', '-e', program], { env: testSlotEnvironment(), encoding: 'utf8', timeout: 12000 });
  if (result.stderr?.includes('sandbox_apply: Operation not permitted')) { t.skip('seatbelt cannot nest; promotion host verifies this acceptance'); return; }
  const legacy = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 5000, env: { ...testSlotEnvironment(), LC_ALL: 'C', TZ: 'UTC' } });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(processStart(process.pid), `ps-utc-c:${legacy.stdout.trim()}`);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /SLOT_NESTED/);
  assert.equal(fs.existsSync(lock), false);
});
