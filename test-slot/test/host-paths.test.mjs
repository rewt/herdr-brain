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
  const external = path.join(process.cwd(), 'unused-reservation-test-slot');
  assert.throws(() => validateSlotPath(external, { compat: true, provers: [] }), /LOCK_PATH_INVALID/);
  assert.equal(slotPathOf({ MONITOR_TEST_SLOT_PATH: external }, { readOnly: true }), external);
  const result = f.run([process.execPath, '-e', 'console.log("started")']);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'started\n');
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
