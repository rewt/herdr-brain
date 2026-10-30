import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('scratch recovery retains foreign paths, reused PIDs, live groups and unavailable native evidence', t => {
  const root = fixture(t), owner = { pid: 400, pgid: 400, identity: 'birth', command: 'fixture' };
  const owned = path.join(root, 'owned'), foreign = path.join(root, 'foreign');
  fs.mkdirSync(owned); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep'), 'foreign');
  const record = registration(owned, owner), journal = path.join(root, 'journal');
  fs.writeFileSync(journal, JSON.stringify(record) + '\n');
  const recover = snapshot => recoverScratch(journal, { joined: true, suite: owner, snapshot });
  for (const snapshot of [
    () => ({ ok: false, error: 'refused' }),
    () => ({ ok: true, value: new Map([[400, { ...owner, identity: 'reused', state: 'S' }]]) }),
    () => ({ ok: true, value: new Map([[401, { ...owner, pid: 401, state: 'S' }]]) }),
  ]) {
    assert.equal(recover(snapshot).retained, 1);
    assert.ok(fs.existsSync(owned));
  }
  const empty = () => ({ ok: true, value: new Map() });
  assert.equal(recoverScratch(journal, { joined: false, suite: owner, snapshot: empty }).retained, 1);
  fs.renameSync(owned, owned + '-original'); fs.symlinkSync(foreign, owned);
  assert.equal(recover(empty).retained, 1, 'a substituted path is never followed');
  assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'foreign');
  fs.unlinkSync(owned); fs.mkdirSync(owned);
  assert.equal(recover(empty).retained, 1, 'a replacement directory is not owned');
  fs.rmdirSync(owned); fs.renameSync(owned + '-original', owned);
  const result = recover(empty);
  assert.equal(result.created, 1); assert.equal(result.removed, 1); assert.equal(result.retained, 0);
  assert.equal(recover(empty).absent, 1);
  assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'foreign');
});

for (const mode of ['success', 'assertion', 'killed-worker', 'lost-reply']) {
  test(`runner reclaims registered scratch and retains TAP after ${mode}`, async t => {
    const root = fixture(t), file = path.join(root, 'victim.test.mjs'), published = path.join(root, 'ready.json');
    const preload = path.join(root, 'drop-reply.mjs');
    fs.writeFileSync(preload, `if(process.argv.includes('--worker')){const send=process.send.bind(process);process.send=(message,...args)=>message.fileTapComplete?true:send(message,...args);}`);
    fs.writeFileSync(file, `import test from ${JSON.stringify(local('./helpers/bounded-test.mjs'))};
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
test('owned victim',()=>{
const scratch=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'owned-victim-')));
fs.writeFileSync(path.join(scratch,'payload'),'owned');
fs.writeFileSync(${JSON.stringify(published)},JSON.stringify({scratch,history:process.env.MONITOR_GATE_HISTORY_ROOT}));
console.error('retained victim evidence');
${mode === 'assertion' ? "assert.fail('intentional witness failure');" : mode === 'killed-worker' ? "process.kill(Number(process.env.HERDR_TEST_SUITE_PID),'SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);" : ''}
});`);
    // A new coordinator owns this journal; the enclosing test keeps its own
    // registry. Drop only the final file IPC reply, never its disk receipt.
    const wrapper = path.join(root, 'runner.mjs');
    fs.writeFileSync(wrapper, `delete process.env.HERDR_TEST_SCRATCH_JOURNAL;process.argv=[process.execPath,${JSON.stringify(local('./helpers/run.mjs'))},${JSON.stringify(file)}];await import(${JSON.stringify(local('./helpers/run.mjs'))});`);
    const child = spawnChild(t, process.execPath, [wrapper], { env: { ...process.env,
      ...(mode === 'lost-reply' ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}` } : {}) } });
    const result = await waitForExit(child);
    assert.equal(result.code, ['assertion', 'killed-worker'].includes(mode) ? 1 : 0, result.stdout + result.stderr);
    const ready = JSON.parse(fs.readFileSync(published, 'utf8'));
    const match = result.stderr.match(/SCRATCH_RECOVERY: (.+)/);
    assert.ok(match, result.stderr);
    const summary = JSON.parse(match[1]), recovery = JSON.parse(fs.readFileSync(summary.receipt, 'utf8'));
    for (const directory of [ready.scratch, ready.history]) {
      assert.equal(fs.existsSync(directory), false, directory);
      const row = recovery.results.find(row => row.root === directory);
      assert.ok(row && ['removed', 'absent'].includes(row.status), JSON.stringify(row));
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
    console.error(`SCRATCH_WITNESS: ${JSON.stringify({ mode, receipt: summary.receipt, created: recovery.created, removed: recovery.removed, absent: recovery.absent, retained: recovery.retained })}`);
  });
}
