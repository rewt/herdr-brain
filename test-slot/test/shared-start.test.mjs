import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';

const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-start-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), compat = path.join(root, 'compat');
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: workspace, MONITOR_TEST_SLOT_COMPAT_PATH: compat };
  const receipt = path.join(root, 'result.json');
  const run = (command, overrides = {}) => spawnSync(process.execPath,
    [cli, 'run', 'shared start', '--result-path', receipt, '--', ...command],
    { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: loadTimeout(15000) });
  return { root, workspace, compat, env, receipt, run };
}

test('a shared payload sees its group in compat occupancy at its first instruction', t => {
  const f = fixture(t);
  const result = f.run([process.execPath, '-e', `const fs=require('fs'),assert=require('assert/strict');
    const file=process.env.MONITOR_TEST_SLOT_OCCUPANCY_PATH,row=JSON.parse(fs.readFileSync(file));
    assert(file.startsWith(process.env.MONITOR_TEST_SLOT_COMPAT_PATH+'.occupancy/'));
    assert.equal(row.pgid,process.pid);assert(row.groupStart);assert(row.groupBirth);
    assert.equal(fs.existsSync(process.env.MONITOR_TEST_SLOT_PATH),false);
    assert.equal(fs.existsSync(process.env.MONITOR_TEST_SLOT_COMPAT_PATH),false);
    console.log('published before start');`]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'published before start\n');
  assert.deepEqual(fs.readdirSync(`${f.compat}.occupancy`), []);
  assert.equal(fs.existsSync(`${f.workspace}.occupancy`), false);
});

for (const phase of ['initial', 'group']) test(`failed ${phase} shared publication keeps the payload behind the barrier`, t => {
  const f = fixture(t), preload = path.join(f.root, 'fail.mjs'), marker = path.join(f.root, 'started');
  fs.writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.renameSync;fs.renameSync=(from,to)=>{
      if(String(to).startsWith(${JSON.stringify(f.compat + '.occupancy/')})){
        const row=JSON.parse(fs.readFileSync(from));
        if(${phase === 'initial' ? 'row.pgid===null' : 'row.pgid!==null'}){
          // Give an unguarded shell time to write the marker before failing.
          const end=Date.now()+300;while(!fs.existsSync(${JSON.stringify(marker)})&&Date.now()<end)
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
          throw Error('fixture shared publication failure');
        }
      }
      return rename(from,to);
    };syncBuiltinESMExports();`);
  const result = f.run(['/bin/sh', '-c', 'echo started > "$1"', 'fixture', marker],
    { NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture shared publication failure/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(f.workspace), false);
  assert.equal(fs.existsSync(f.compat), false);
  if (fs.existsSync(f.receipt)) assert.notEqual(JSON.parse(fs.readFileSync(f.receipt)).command_started, true);
});

test('a missing shared command retains exit 127 after the barrier', t => {
  const f = fixture(t), result = f.run([path.join(f.root, 'missing')]);
  assert.equal(result.status, 127, result.stderr);
  assert.deepEqual(fs.readdirSync(`${f.compat}.occupancy`), []);
});

test('the shared start barrier preserves signals and numeric payload exits', t => {
  const f = fixture(t);
  for (const signal of ['SIGTERM', 'SIGPIPE', null]) {
    const command = signal ? ['/bin/sh', '-c', `kill -${signal.slice(3)} $$`] : [process.execPath, '-e', 'process.exit(143)'];
    const result = f.run(command);
    assert.equal(result.status, signal ? 128 + os.constants.signals[signal] : 143, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(f.receipt)).signal, signal);
    assert.deepEqual(fs.readdirSync(`${f.compat}.occupancy`), []);
  }
});
