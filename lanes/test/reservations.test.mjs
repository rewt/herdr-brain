import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishProvingReservation } from '../../test-slot/reservations.mjs';
import { makeFixture, openLane, commitFile, laneProcess, waitForCondition, git } from './lane-fixture.mjs';

test('STOP cancels a lane promotion proving wait before any promotion lock or validation', async () => {
  const fixture = makeFixture(); let held, pending;
  try {
    const lane = openLane(fixture, 'proving-stop'); commitFile(lane, 'work', 'ready', 'ready');
    const before = git(fixture.repo, ['rev-parse', 'main']);
    held = publishProvingReservation({ lockPath: fixture.env.MONITOR_TEST_SLOT_COMPAT_PATH, cwd: fixture.repo,
      label: 'proof', reason: 'ENG-424 R-601', expiresAt: new Date(Date.now() + 60000).toISOString() });
    pending = laneProcess(fixture, ['promote', 'proving-stop']);
    await waitForCondition(() => pending.stderr().includes('waiting; proving'), 'promotion did not pause at its launch gate', 10000);
    assert.equal(existsSync(join(fixture.repo, '.git/lane-promote.lock')), false);
    mkdirSync(join(fixture.repo, '.lane/supervisor'), { recursive: true });
    writeFileSync(join(fixture.repo, '.lane/supervisor/STOP'), 'STOP');
    await pending.completed;
    assert.equal(pending.child.exitCode, 1, pending.stderr()); assert.match(pending.stderr(), /PROMOTION_STOPPED/);
    assert.equal(git(fixture.repo, ['rev-parse', 'main']), before); assert.ok(existsSync(held.path));
    assert.equal(existsSync(join(fixture.repo, '.git/lane-promote.lock')), false);
  } finally {
    held?.release();
    if (pending?.child.exitCode === null) { pending.child.kill('SIGTERM'); await pending.completed; }
    fixture.cleanup();
  }
});
