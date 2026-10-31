import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { waitForChange, waitForFile } from './helpers/file-wait.mjs';
import { recoverScratch } from './helpers/scratch.mjs';
import { spawnChild, waitForExit } from './helpers/child.mjs';

const local = file => fileURLToPath(new URL(file, import.meta.url));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-proof-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function registration(root, owner) {
  const stat = fs.lstatSync(root, { bigint: true });
  return { schema: 'test-scratch/v1', root, owner, dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) };
}

test('scratch recovery retains foreign paths, reused PIDs, live owners and unknown evidence', t => {
  const root = fixture(t), owner = { pid: 400, pgid: 400, identity: 'birth', command: 'fixture' };
  const owned = path.join(root, 'owned'), foreign = path.join(root, 'foreign');
  fs.mkdirSync(owned); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep'), 'foreign');
  const record = registration(owned, owner), journal = path.join(root, 'journal');
  fs.writeFileSync(journal, JSON.stringify(record) + '\n');
  const absent = () => ({ ok: true, value: null }), emptyGroup = () => ({ ok: true, absent: true });
  const recover = (lookup = absent, groupProbe = emptyGroup) => recoverScratch(journal, { joined: true, suite: owner, lookup, groupProbe });
  for (const [lookup, groupProbe, live] of [
    [() => ({ ok: false, error: 'refused' }), emptyGroup, 0],
    [() => { throw Error('refused'); }, emptyGroup, 0],
    [() => ({ ok: true, value: { ...owner, identity: 'reused', state: 'S' } }), emptyGroup, 0],
    [() => ({ ok: true, value: { ...owner, state: 'S' } }), emptyGroup, 1],
    [() => ({ ok: true, value: { pid: owner.pid } }), emptyGroup, 0],
    [absent, () => ({ ok: true, absent: false }), 0],
    [absent, () => ({ ok: false, error: 'EPERM' }), 0],
  ]) {
    const result = recover(lookup, groupProbe);
    assert.equal(result.retained, 1);
    assert.equal(result.retained_live, live);
    assert.equal(result.retained_unknown, 1 - live);
    assert.ok(fs.existsSync(owned));
  }
  assert.equal(recoverScratch(journal, { joined: false, suite: owner, lookup: absent, groupProbe: emptyGroup }).retained_unknown, 1);
  fs.renameSync(owned, owned + '-original'); fs.symlinkSync(foreign, owned);
  assert.equal(recover().retained_unknown, 1, 'a substituted path is never followed');
  assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'foreign');
  fs.unlinkSync(owned); fs.mkdirSync(owned);
  assert.equal(recover().retained_unknown, 1, 'a replacement directory is not owned');
  fs.rmdirSync(owned); fs.renameSync(owned + '-original', owned);
  const result = recover();
  assert.equal(result.created, 1); assert.equal(result.removed, 1); assert.equal(result.retained, 0);
  assert.equal(recover().absent, 1);
  assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'foreign');
});

test('scratch recovery uses one targeted birth lookup per owner and no inventory', t => {
  const root = fixture(t), owner = { pid: 400, pgid: 400, identity: 'birth' };
  const directories = ['one', 'two'].map(name => path.join(root, name));
  for (const directory of directories) fs.mkdirSync(directory);
  const journal = path.join(root, 'journal');
  fs.writeFileSync(journal, directories.map(directory => JSON.stringify(registration(directory, owner))).join('\n'));
  const calls = [], probes = [];
  const result = recoverScratch(journal, { joined: true, suite: owner,
    lookup: pid => { assert.equal(pid, owner.pid); calls.push(pid); return { ok: true, value: null }; },
    groupProbe: pid => { probes.push(pid); return { ok: true, absent: true }; } });
  assert.deepEqual(calls, [owner.pid]); assert.deepEqual(probes, [owner.pid]);
  assert.equal(result.removed, 2); assert.equal(result.retained, 0);
});

test('scratch recovery never removes an ancestor of a live or unknown registered root', t => {
  for (const live of [true, false]) {
    const root = fixture(t), parent = path.join(root, 'parent'), nested = path.join(parent, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const suite = { pid: 400, pgid: 400, identity: 'suite' }, owner = { pid: 401, pgid: 400, identity: 'escaped' };
    const journal = path.join(root, 'journal');
    fs.writeFileSync(journal, [registration(parent, suite), registration(nested, owner)].map(row => JSON.stringify(row)).join('\n'));
    const result = recoverScratch(journal, { joined: true, suite,
      lookup: pid => pid === suite.pid ? { ok: true, value: null } : live
        ? { ok: true, value: { ...owner, pgid: 500, state: 'S' } } : { ok: false, error: 'refused' },
      groupProbe: () => ({ ok: true, absent: true }) });
    assert.equal(result.removed, 0); assert.equal(result.retained, 2);
    assert.equal(result.retained_live, live ? 1 : 0);
    assert.equal(result.results[0].reason, 'contains retained scratch');
    assert.ok(fs.existsSync(nested));
  }
});

for (const mode of ['success', 'assertion', 'killed-worker', 'lost-reply', 'group-unknown', 'group-unknown-assertion', 'ps-denied']) {
  test(`runner reclaims registered scratch and retains TAP after ${mode}`, async t => {
    if (mode === 'ps-denied' && process.platform !== 'darwin') { t.skip('worker seatbelt witness requires macOS'); return; }
    const root = fixture(t), file = path.join(root, 'victim.test.mjs'), published = path.join(root, 'ready.json');
    const preload = path.join(root, 'drop-reply.mjs'), retained = path.join(root, 'retained');
    const unknown = mode.startsWith('group-unknown');
    fs.writeFileSync(preload, unknown
      ? `const kill=process.kill;process.kill=function(pid,signal){if(pid < -1 && signal===0)throw Object.assign(Error('group probe denied'),{code:'EPERM'});return kill.call(this,pid,signal);};`
      : `if(process.argv.includes('--worker')){const send=process.send.bind(process);process.send=(message,...args)=>message.fileTapComplete?true:send(message,...args);}`);
    fs.writeFileSync(file, `import test from ${JSON.stringify(local('./helpers/bounded-test.mjs'))};
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {waitForFile} from ${JSON.stringify(local('./helpers/file-wait.mjs'))};
test('owned victim',async t=>{
const scratch=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'owned-victim-')));
fs.writeFileSync(path.join(scratch,'payload'),'owned');
fs.writeFileSync(${JSON.stringify(published)},JSON.stringify({scratch,history:process.env.MONITOR_GATE_HISTORY_ROOT}));
console.error('retained victim evidence');
${mode.endsWith('assertion') ? "assert.fail('intentional witness failure');" : mode === 'killed-worker' ? "await waitForFile("+JSON.stringify(retained)+",text=>text==='retained',{signal:t.signal});process.kill(Number(process.env.HERDR_TEST_SUITE_PID),'SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);" : ''}
});`);
    // A new coordinator owns this journal; the enclosing test keeps its own
    // registry. Drop only the final file IPC reply, never its disk receipt.
    const wrapper = path.join(root, 'runner.mjs');
    fs.writeFileSync(wrapper, `${mode === 'ps-denied' ? `import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';const denied=spawnSync('/bin/ps',['-p',String(process.pid)],{encoding:'utf8'});assert.notEqual(denied.status,0,'actual ps must be denied');console.error('PS_DENIED: '+JSON.stringify({status:denied.status,error:denied.error?.code,stderr:denied.stderr}));` : ''}
delete process.env.HERDR_TEST_SCRATCH_JOURNAL;process.argv=[process.execPath,${JSON.stringify(local('./helpers/run.mjs'))},${JSON.stringify(file)}];await import(${JSON.stringify(local('./helpers/run.mjs'))});`);
    const needsSeatbelt = mode === 'ps-denied' && spawnSync('/bin/ps', ['-p', String(process.pid)], { encoding: 'utf8' }).status === 0;
    const child = spawnChild(t, needsSeatbelt ? '/usr/bin/sandbox-exec' : process.execPath,
      needsSeatbelt ? ['-p', '(version 1)(allow default)(deny network*)', process.execPath, wrapper] : [wrapper], { env: { ...process.env,
        ...((mode === 'lost-reply' || unknown) ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}` } : {}) } });
    if (mode === 'killed-worker') {
      let diagnostics = '';
      child.stderr.on('data', bytes => { diagnostics += bytes; });
      const reference = await waitForChange([published], () => {
        try { JSON.parse(fs.readFileSync(published, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
        const marker = diagnostics.match(/FILE_TAP: (.+)/);
        return marker && JSON.parse(marker[1]);
      });
      await waitForFile(reference.stderr_artifact, text => text.includes('retained victim evidence'));
      fs.writeFileSync(retained, 'retained');
    }
    const result = await waitForExit(child);
    assert.equal(result.code, mode.endsWith('assertion') || mode === 'killed-worker' ? 1 : 0, result.stdout + result.stderr);
    const ready = JSON.parse(fs.readFileSync(published, 'utf8'));
    const match = result.stderr.match(/SCRATCH_RECOVERY: (.+)/);
    assert.ok(match, result.stderr);
    const summary = JSON.parse(match[1]), recovery = JSON.parse(fs.readFileSync(summary.receipt, 'utf8'));
    for (const directory of [ready.scratch, ready.history]) {
      const retainedScratch = unknown && directory === ready.scratch;
      assert.equal(fs.existsSync(directory), retainedScratch, directory);
      const row = recovery.results.find(row => row.root === directory);
      if (retainedScratch) {
        assert.equal(row?.status, 'retained'); assert.equal(row.retention, 'unknown');
        assert.equal(row.reason, 'group lookup unavailable');
        // The test owns this deliberately retained fixture after its child exit.
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      } else assert.ok(row && ['removed', 'absent'].includes(row.status), JSON.stringify(row));
    }
    const marker = result.stderr.match(/FILE_TAP: (.+)/);
    assert.ok(marker, result.stderr);
    const reference = JSON.parse(marker[1]);
    assert.ok(fs.existsSync(reference.artifact), 'TAP survives scratch recovery');
    assert.match(fs.readFileSync(reference.stderr_artifact, 'utf8'), /retained victim evidence/);
    const completion = JSON.parse(fs.readFileSync(reference.completion_artifact, 'utf8'));
    if (mode === 'killed-worker') {
      assert.equal(completion.observed_by, 'coordinator');
      assert.equal(completion.worker_signal, 'SIGKILL');
      assert.equal(recovery.joined, true, 'native worker exit and drained pipes permit recovery without a signal to a departed leader');
      assert.equal(completion.tap_complete, false);
    } else assert.ok(completion.native_exit, 'native file exit survives a lost IPC reply');
    if (unknown) { assert.equal(recovery.retained_live, 0); assert.ok(recovery.retained_unknown > 0); }
    if (mode === 'ps-denied') assert.match(result.stderr, /PS_DENIED:/);
    console.error(`SCRATCH_WITNESS: ${JSON.stringify({ mode, receipt: summary.receipt, created: recovery.created, removed: recovery.removed, absent: recovery.absent, retained: recovery.retained,
      retained_live: recovery.retained_live, retained_unknown: recovery.retained_unknown, exit_code: result.code,
      ...(mode === 'ps-denied' ? { ps_denied: JSON.parse(result.stderr.match(/PS_DENIED: (.+)/)[1]) } : {}) })}`);
  });
}
