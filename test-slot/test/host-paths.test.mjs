import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateSlotPath, slotPathOf, LOCK_PATH_INVALID_CODE } from '../paths.mjs';
import { resourceStanza } from '../resources.mjs';
import { run } from '../test-slot.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { MAX_RESERVATION_MS } from '../reservations.mjs';

const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-paths-'))), lock = path.join(root, 'slot');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  const run = (command, args = [], overrides = {}) => spawnSync(process.execPath, [cli, 'run', 'ENG-424 R-601', ...args, '--', ...command],
    { env: { ...env, ...overrides }, cwd: root, encoding: 'utf8', timeout: loadTimeout(15000) });
  return { root, lock, env, run };
}

test('all path inputs refuse prover basenames, symlinks and nonregular files before any publication', t => {
  const f = fixture(t), command = [process.execPath, '-e', 'throw Error("payload started")'];
  const symlink = path.join(f.root, 'symlink'), directory = path.join(f.root, 'directory');
  fs.writeFileSync(path.join(f.root, 'target'), 'unchanged'); fs.symlinkSync(path.join(f.root, 'target'), symlink); fs.mkdirSync(directory);
  for (const basename of ['apnt-gnark-r2-proof-12.lock', 'bch-cloak-sp1-prover-exclusive-v1', '.prover.lock', 'symlink', 'directory']) {
    const file = path.join(f.root, basename);
    for (const input of ['workspace', 'compat', 'flag']) {
      const result = f.run(command, input === 'flag' ? ['--lock-path', file] : [],
        input === 'flag' ? {} : { [input === 'workspace' ? 'MONITOR_TEST_SLOT_PATH' : 'MONITOR_TEST_SLOT_COMPAT_PATH']: file });
      assert.equal(result.status, 75, result.stderr); assert.match(result.stderr, /TEST_SLOT_LOCK_PATH_INVALID:/);
      assert.equal(result.stdout, '');
    }
  }
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['directory', 'symlink', 'target']);
  assert.equal(fs.readFileSync(path.join(f.root, 'target'), 'utf8'), 'unchanged');
});

test('injected prover inode aliases are refused for workspace, compat and explicit lock selections', async t => {
  const f = fixture(t), prover = path.join(f.root, 'prover'), alias = path.join(f.root, 'alias');
  fs.writeFileSync(prover, 'prover bytes'); fs.linkSync(prover, alias);
  const options = { provers: [prover] };
  const refuses = fn => assert.throws(fn, e => e.code === LOCK_PATH_INVALID_CODE);
  refuses(() => slotPathOf({ MONITOR_TEST_SLOT_PATH: alias }, options));
  refuses(() => validateSlotPath(alias, { ...options, compat: true }));
  // --lock-path selects both paths; the same pre-publication validator applies.
  refuses(() => validateSlotPath(alias, options));
  for (const input of ['workspace', 'compat', 'flag']) await assert.rejects(run({ positional: ['refused alias'],
    options: { lockPath: input === 'compat' ? f.lock : alias, compatPath: input === 'workspace' ? f.lock : alias, provers: [prover] },
    child: [process.execPath, '-e', 'throw Error("payload started")'] }), e => e.code === LOCK_PATH_INVALID_CODE);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['alias', 'prover']);
});

test('compat permits private temporary scratch, refuses writable and out-of-scratch locations, and readers remain read-only', t => {
  const f = fixture(t);
  assert.equal(validateSlotPath(f.lock, { compat: true, provers: [] }), f.lock);
  fs.chmodSync(f.root, 0o777);
  assert.throws(() => validateSlotPath(f.lock, { compat: true, provers: [] }), e => e.code === LOCK_PATH_INVALID_CODE);
  fs.chmodSync(f.root, 0o700);
  assert.throws(() => validateSlotPath(f.lock, { compat: true, uid: process.getuid() + 1, provers: [] }), /LOCK_PATH_INVALID/);
  assert.throws(() => validateSlotPath(path.join(os.tmpdir(), 'not-private.lock'), { compat: true, provers: [] }), /LOCK_PATH_INVALID/);
  // The checkout itself can be under TMPDIR during release acceptance. The
  // filesystem root is outside both temporary roots; no writer touches it.
  const external = path.join(path.parse(f.root).root, 'unused-reservation-test-slot');
  assert.throws(() => validateSlotPath(external, { compat: true, provers: [] }), /LOCK_PATH_INVALID/);
  assert.equal(slotPathOf({ MONITOR_TEST_SLOT_PATH: external }, { readOnly: true }), external);
  const result = f.run([process.execPath, '-e', 'console.log("started")']);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'started\n');
});

test('macOS private scratch remains admitted through aliases when exact validation omits TMPDIR', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), env = { ...f.env };
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) delete env[key];
  // The physical path and /var alias name the same mkdtemp directory. The
  // sanitized child sees /tmp from os.tmpdir(), not its parent's per-user root.
  for (const lock of new Set([f.lock, path.join(os.tmpdir(), path.basename(f.root), 'slot')])) {
    const command = [process.execPath, '-e', 'console.log("private scratch")'];
    const result = spawnSync(process.execPath, [cli, 'run', 'exact scratch', '--lock-path', lock, '--', ...command], {
      env, cwd: f.root, encoding: 'utf8', timeout: loadTimeout(15000),
    });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'private scratch\n');
  }
  fs.chmodSync(f.root, 0o777);
  const denied = spawnSync(process.execPath, [cli, 'run', 'unsafe scratch', '--lock-path', f.lock, '--', process.execPath, '-e', 'throw Error("started")'], {
    env, cwd: f.root, encoding: 'utf8', timeout: loadTimeout(15000),
  });
  assert.equal(denied.status, 75, denied.stderr); assert.match(denied.stderr, /TEST_SLOT_LOCK_PATH_INVALID/);
  assert.deepEqual(fs.readdirSync(f.root), ['slot.occupancy']);
});

test('an exclusive payload sees both locks and the reservation group before its first instruction', t => {
  const f = fixture(t), workspace = path.join(f.root, 'workspace');
  const body = `const fs=require('fs'),assert=require('assert/strict');
    for(const file of [process.env.MONITOR_TEST_SLOT_PATH,process.env.MONITOR_TEST_SLOT_COMPAT_PATH]){const row=JSON.parse(fs.readFileSync(file));assert.equal(row.pgid,process.pid);assert(row.groupStart);assert(row.groupBirth);}
    const directory=process.env.MONITOR_TEST_SLOT_COMPAT_PATH+'.occupancy';const records=fs.readdirSync(directory).filter(n=>!n.startsWith('.')).map(n=>JSON.parse(fs.readFileSync(directory+'/'+n)));
    const row=records.find(r=>r.schema==='host-reservation/v1');assert.equal(row.pgid,process.pid);assert(row.groupStart);assert(row.groupBirth);assert.equal(row.reserveGib,17);assert.equal(row.reason,'ENG-424 R-601');console.log('recorded');`;
  const command = [process.execPath, '-e', body];
  const result = f.run(command, ['--resource', JSON.stringify(resourceStanza('fixture/proving', command, 'EXCLUSIVE')),
    '--reason', 'ENG-424 R-601', '--expected-seconds', '30', '--reserve-gib', '17'], { MONITOR_TEST_SLOT_PATH: workspace });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'recorded\n');
  assert.equal(fs.existsSync(f.lock), false); assert.equal(fs.existsSync(workspace), false);
  assert.deepEqual(fs.readdirSync(`${f.lock}.occupancy`), []);
});

for (const phase of ['initial', 'group']) test(`a ${phase} reservation publication failure never starts an exclusive payload`, t => {
  const f = fixture(t), preload = path.join(f.root, 'fail.mjs'), marker = path.join(f.root, 'payload');
  fs.writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.renameSync;let count=0;fs.renameSync=(from,to)=>{if(String(to).startsWith(${JSON.stringify(f.lock + '.occupancy/')})){
      if(++count===${phase === 'initial' ? 1 : 2})throw Error('fixture publication failure');}return rename(from,to);};syncBuiltinESMExports();`);
  const command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`];
  const result = f.run(command, ['--resource', JSON.stringify(resourceStanza('fixture/proving', command, 'EXCLUSIVE'))],
    { NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /fixture publication failure/);
  assert.equal(fs.existsSync(marker), false);
});

test('a missing exclusive command preserves the spawn-failure exit code', t => {
  const f = fixture(t), command = [path.join(f.root, 'missing')];
  const result = f.run(command, ['--resource', JSON.stringify(resourceStanza('fixture/proving', command, 'EXCLUSIVE'))]);
  assert.equal(result.status, 127, result.stderr); assert.equal(fs.existsSync(f.lock), false);
  const actual = [process.execPath, '-e', 'process.exit(126)'];
  const payload = f.run(actual, ['--resource', JSON.stringify(resourceStanza('fixture/proving', actual, 'EXCLUSIVE'))]);
  assert.equal(payload.status, 126, payload.stderr);
});

test('the foreground barrier preserves payload signals separately from numeric exits', t => {
  const f = fixture(t), receipt = path.join(f.root, 'execution.json');
  for (const signal of ['SIGTERM', 'SIGPIPE', null]) {
    // A native shell can die from PIPE, which Node normally ignores.
    const command = signal ? ['/bin/sh', '-c', `kill -${signal.slice(3)} $$`] : [process.execPath, '-e', 'process.exit(143)'];
    const result = f.run(command, ['--resource', JSON.stringify(resourceStanza('fixture/proving', command, 'EXCLUSIVE')), '--result-path', receipt]);
    assert.equal(result.status, signal ? 128 + os.constants.signals[signal] : 143, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(receipt)).signal, signal);
  }
});

for (const capped of [false, true]) test(`an exclusive timeout retry keeps continuous proving coverage within its acquisition ceiling${capped ? ' near the six-hour cap' : ''}`, t => {
  const f = fixture(t), clock = path.join(f.root, 'clock'), attempts = path.join(f.root, 'attempts.json'), preload = path.join(f.root, 'clock.mjs');
  const publications = path.join(f.root, 'publications.jsonl');
  const initial = Date.now(), advance = capped ? MAX_RESERVATION_MS - 1000 : 100000;
  fs.writeFileSync(clock, String(initial));
  fs.writeFileSync(preload, `import fs from 'node:fs';import os from 'node:os';
    Date.now=()=>Number(fs.readFileSync(${JSON.stringify(clock)},'utf8'));os.loadavg=()=>[1000,1000,1000];
    const rename=fs.renameSync;fs.renameSync=(from,to)=>{
      if(String(to).startsWith(${JSON.stringify(f.lock + '.occupancy/')}))fs.appendFileSync(${JSON.stringify(publications)},JSON.stringify({at:Date.now(),record:JSON.parse(fs.readFileSync(from))})+'\\n');
      return rename(from,to);
    };`);
  const command = [process.execPath, '-e', `const fs=require('fs'),path=require('path'),assert=require('assert/strict');
    const dir=process.env.MONITOR_TEST_SLOT_COMPAT_PATH+'.occupancy';
    const file=path.join(dir,fs.readdirSync(dir).find(n=>!n.startsWith('.'))),record=JSON.parse(fs.readFileSync(file));
    const ceiling=Date.parse(record.acquiredAt)+${MAX_RESERVATION_MS};
    assert.equal(Date.parse(record.expiresAt),ceiling,'execution reserves the full acquisition allowance');
    const evidence=${JSON.stringify(attempts)};
    if(!fs.existsSync(evidence)){
      fs.writeFileSync(evidence,JSON.stringify({file,record}));fs.writeFileSync(${JSON.stringify(clock)},String(Date.now()+${advance}));
      console.error('ETIMEDOUT: first attempt');process.exit(124);
    }
    const first=JSON.parse(fs.readFileSync(evidence));assert.equal(file,first.file);assert.equal(record.acquiredAt,first.record.acquiredAt);
    assert.equal(record.expiresAt,first.record.expiresAt,'retry cannot move the acquisition ceiling');
    assert(Date.parse(first.record.expiresAt)>Date.now(),'the original reservation still covers the retry');
    assert.equal(process.env.MONITOR_TEST_SLOT_TIMEOUT_RETRIED,'1');console.log('covered');`];
  const result = f.run(command, ['--resource', JSON.stringify(resourceStanza('fixture/proving', command, 'EXCLUSIVE')),
    '--timeout-seconds', '10', '--retry-timeout-under-load'], { NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'covered\n');
  assert.equal((result.stderr.match(/TEST_SLOT_TIMEOUT_RETRY:/g) ?? []).length, 1);
  const rows = fs.readFileSync(publications, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.at === initial + advance), 'retry publication was observed');
  for (const { at, record } of rows) {
    assert.equal(Date.parse(record.acquiredAt), initial);
    assert.equal(Date.parse(record.expiresAt), initial + MAX_RESERVATION_MS, 'no publication exceeds the original six-hour cap');
    assert.ok(Date.parse(record.expiresAt) > at, 'coverage never lapses during publication or retry');
  }
  assert.equal(fs.existsSync(f.lock), false); assert.deepEqual(fs.readdirSync(`${f.lock}.occupancy`), []);
});

for (const damage of ['removed', 'changed']) for (const status of [0, 7])
  test(`an exclusive payload exiting ${status} releases both bridge locks after its reservation is ${damage}`, t => {
    const f = fixture(t), workspace = path.join(f.root, 'workspace'), evidence = path.join(f.root, 'reservation.json');
    const command = [process.execPath, '-e', `const fs=require('fs'),path=require('path'),assert=require('assert/strict');
      const dir=process.env.MONITOR_TEST_SLOT_COMPAT_PATH+'.occupancy',file=path.join(dir,fs.readdirSync(dir).find(n=>!n.startsWith('.')));
      const record=JSON.parse(fs.readFileSync(file));record.reason+=' changed externally';const bytes=JSON.stringify(record)+'\\n';
      if(${JSON.stringify(damage)}==='removed')fs.unlinkSync(file);else fs.writeFileSync(file,bytes);
      for(const lock of [process.env.MONITOR_TEST_SLOT_PATH,process.env.MONITOR_TEST_SLOT_COMPAT_PATH])assert(fs.existsSync(lock),'live group retains its bridge lock');
      fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({file,bytes}));console.log('payload status');process.exit(${status});`];
    const result = f.run(command, ['--resource', JSON.stringify(resourceStanza('fixture/proving', command, 'EXCLUSIVE'))], { MONITOR_TEST_SLOT_PATH: workspace });
    assert.equal(result.status, status, result.stderr); assert.equal(result.stdout, 'payload status\n');
    assert.match(result.stderr, /HOST_RESERVATION_RELEASE_WARNING:.*group exited; releasing bridge locks/);
    assert.equal(fs.existsSync(f.lock), false); assert.equal(fs.existsSync(workspace), false);
    const saved = JSON.parse(fs.readFileSync(evidence));
    if (damage === 'changed') assert.equal(fs.readFileSync(saved.file, 'utf8'), saved.bytes, 'foreign bytes are not removed');
    else assert.equal(fs.existsSync(saved.file), false);
  });
