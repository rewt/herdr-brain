// Invoked only by the fixed, native-deadline detached fixture entrypoint.
import test from '../../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resumeInbox } from '../../../supervisor/prompt-supervisor.mjs';
import { stopFixtureInbox } from '../../../test/helpers/inbox.mjs';
import { createProcessTracker } from '../../../test/helpers/processes.mjs';

const [root] = process.argv.slice(2);
const script = fileURLToPath(new URL('../../../supervisor/prompt-supervisor.mjs', import.meta.url));
const nativeSpawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (options) {
  // Exec preserves the product's PID/argv/IPC and genuine detached group.
  // The kernel alarm also bounds a failed test or a killed enclosing suite.
  if (options.file === process.execPath && options.args.includes('--owner-worker')) {
    options.file = path.join(root, 'fixture-deadline');
    options.args = [options.file, ...options.args];
  }
  return nativeSpawn.call(this, options);
};

test('a live detached inbox owner survives the test body and stops in its after-hook', async t => {
  const file = path.join(root, 'inbox.log');
  // Every transport refuses immediately, so this pending owner cannot finish.
  fs.writeFileSync(file, JSON.stringify({ type: 'notice', id: 'detached-teardown', to: 'fixture',
    message: 'offline fixture notice', herdr: '/usr/bin/false', attempts: 1, retrySeconds: 0 }) + '\n');
  const pid = await resumeInbox(file, { waitSeconds: 1, confirmSeconds: 0.02, pollSeconds: 0.02 });
  const tracker = createProcessTracker();
  const snapshot = tracker.snapshot();
  assert.ok(snapshot.ok, snapshot.error);
  const owner = snapshot.value.get(pid), caller = snapshot.value.get(process.pid);
  assert.ok(owner && !/^Z/.test(owner.state), 'owner is still live at test end');
  assert.equal(owner.pgid, pid, 'product owner leads its detached group');
  assert.notEqual(owner.pgid, caller.pgid, 'owner has left the test group');
  const metadata = JSON.parse(fs.readFileSync(`${file}.owner.lock/owner.json`, 'utf8'));
  assert.equal(owner.command, metadata.argv.join(' '), 'live command matches recorded argv');
  fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify(owner));
  t.after(async () => {
    const current = tracker.snapshot();
    assert.ok(current.ok, current.error);
    assert.equal(current.value.get(pid)?.identity, owner.identity, 'owner outlived the test body');
    await stopFixtureInbox(file, { script, tracker });
    const stopped = tracker.snapshot();
    assert.ok(stopped.ok, stopped.error);
    const survivor = stopped.value.get(pid);
    assert.ok(!survivor || /^Z/.test(survivor.state), 'confirmed owner is gone or awaiting reaping');
    fs.writeFileSync(path.join(root, 'teardown-complete'), 'owner stopped');
  });
});
