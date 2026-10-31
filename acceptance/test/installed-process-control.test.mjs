import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {harnessEnvironment} from '../run.mjs';

test('installed process faults leave producer continuity and independent native readers intact', t => {
  assert.equal(process.platform, 'darwin', 'exercise the installed native process-source seam');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'installed-process-control-')));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  fs.mkdirSync(path.join(root, 'evidence'));
  fs.mkdirSync(path.join(root, 'home'));
  const source = path.resolve(import.meta.dirname, '../..');
  const url = file => JSON.stringify(new URL(file, `file://${source}/`).href);
  const shell = {pid:1_000_000_001,ppid:0,pgid:1_000_000_001,identity:'0:1000000001',command:'[sh]',state:'S'};
  const producer = {pid:1_000_000_002,ppid:shell.pid,pgid:1_000_000_002,identity:'0:1000000002',command:'[codex]',state:'S'};
  fs.writeFileSync(path.join(root, 'native.json'), JSON.stringify({repo:root,workspaces:{producer:{
    workspace_id:'producer',pane:{pane_id:'producer:p1'},agent:{name:'producer',agent:'codex'},
    shellProcess:shell,agentProcess:producer}}}));
  // This reader is a separate product process during every fault. Its native
  // process-info and process-source paths must both see the original producer.
  fs.writeFileSync(path.join(root, 'reader.mjs'), `
    import assert from 'node:assert/strict';
    import {spawnSync} from 'node:child_process';
    import {lookupProcess} from ${url('lib/processes.mjs')};
    import {ownerAlive} from ${url('lib/process-owner.mjs')};
    import {processControlPid} from ${url('acceptance/installed-observations.mjs')};
    const producer = ${JSON.stringify(producer)};
    assert.equal(ownerAlive(producer), true);
    assert.equal(lookupProcess(processControlPid, {identityOnly:true}).value, null);
    const native = spawnSync(process.execPath, [${JSON.stringify(path.join(source, 'acceptance/installed-native.mjs'))},
      'pane', 'process-info', 'producer:p1'], {encoding:'utf8'});
    assert.equal(native.status, 0, native.stderr);
    assert.deepEqual(JSON.parse(native.stdout).result.process_info.process_tree.at(-1), producer);
    console.log(JSON.stringify({producerAlive:true,nativeProcessUnchanged:true,scratchAbsent:true}));
  `);
  fs.writeFileSync(path.join(root, 'driver.mjs'), `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {spawnSync} from 'node:child_process';
    import {processContinuityControl} from ${url('acceptance/installed-canary.mjs')};
    import {processControlPid} from ${url('acceptance/installed-observations.mjs')};
    import {lookupProcess} from ${url('lib/processes.mjs')};
    import {ownerAlive} from ${url('lib/process-owner.mjs')};
    const producer = ${JSON.stringify(producer)}, before = fs.readFileSync('native.json'), phases = [];
    const observe = phase => {
      assert.equal(ownerAlive(producer), true);
      assert.deepEqual(fs.readFileSync('native.json'), before);
      const reader = spawnSync(process.execPath, ['reader.mjs'], {encoding:'utf8'});
      assert.equal(reader.status, 0, reader.stderr);
      phases.push({phase,...JSON.parse(reader.stdout)});
    };
    const result = processContinuityControl({ownerAlive,lookupProcess,observe});
    assert.equal(result.originalRestored, true);
    assert.deepEqual(phases.map(p => p.phase), ['original','reused','absent','malformed','recovered']);
    assert.equal(lookupProcess(processControlPid, {identityOnly:true}).value, null);
    // An interrupted assertion must clear the local fault too.
    assert.throws(() => processContinuityControl({ownerAlive,lookupProcess,observe:phase => {
      if (phase === 'reused') throw Error('interrupted control');
    }}), /interrupted control/);
    assert.equal(lookupProcess(processControlPid, {identityOnly:true}).value, null);
    assert.equal(ownerAlive(producer), true);
    assert.deepEqual(fs.readFileSync('native.json'), before);
    console.log(JSON.stringify({result,phases,sharedNativeUnchanged:true,interruptedControlCleared:true}));
  `);
  const before = fs.readFileSync(path.join(root, 'native.json'));
  const env = {...harnessEnvironment(process.env, root),INSTALLED_CYCLE_ROOT:root};
  const result = spawnSync(process.execPath, ['--import', path.join(source, 'acceptance/installed-observations.mjs'), 'driver.mjs'],
    {cwd:root,env,encoding:'utf8'});
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  assert.deepEqual(fs.readFileSync(path.join(root, 'native.json')), before);
  t.diagnostic(result.stdout.trim());
});
