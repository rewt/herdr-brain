import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishProvingReservation, RESERVATION_WAIT_EXPIRED_CODE } from '../../test-slot/reservations.mjs';
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

for (const command of ['dispatch', 'review', 'promote', 'promote-batch']) test(`lane ${command} defers at its proving deadline without launch, validation or a promotion lock`, async () => {
  const fixture = makeFixture(); let held, pending;
  try {
    const lane = openLane(fixture, 'bounded-proof'); commitFile(lane, 'work', 'ready', 'ready');
    const before = git(fixture.repo, ['rev-parse', 'main']);
    const preload = join(fixture.root, 'fast-admission.mjs');
    writeFileSync(preload, `const now=performance.now.bind(performance);Object.defineProperty(performance,'now',{value:()=>now()*10000});`);
    fixture.env.NODE_OPTIONS = `${fixture.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}`;
    fixture.env.MONITOR_TEST_SLOT_WAIT_SECONDS = '1';
    held = publishProvingReservation({ lockPath: fixture.env.MONITOR_TEST_SLOT_COMPAT_PATH, cwd: fixture.repo,
      label: 'proof', reason: 'bounded lane launch', expiresAt: new Date(Date.now() + 60000).toISOString() });
    const receipt = join(fixture.root, 'resumed-train.json');
    const saved = JSON.stringify({ schema: 'promotion-train/v1', identity: git(fixture.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      jobs: [{ id: 'one' }], attempts: [{ phase: 'integrated', tip: before }], phase: 'fast-forwarding' });
    if (command === 'promote-batch') writeFileSync(receipt, saved);
    pending = laneProcess(fixture, [command, command === 'promote-batch' ? receipt : 'bounded-proof',
      ...(command === 'dispatch' ? ['--kind', 'codex', '--model', 'offline', '--json'] :
        command === 'review' ? ['--round', '1', '--change', 'bounded-proof'] : [])]);
    await pending.completed;
    assert.equal(pending.child.exitCode, 75, pending.stderr());
    const result = JSON.parse(pending.stdout()); assert.equal(result.result, 'deferred');
    assert.equal(result.code, RESERVATION_WAIT_EXPIRED_CODE); assert.ok(result.elapsed_ms >= 0);
    assert.equal(git(fixture.repo, ['rev-parse', 'main']), before);
    assert.equal(existsSync(join(fixture.repo, '.git/lane-promote.lock')), false);
    assert.ok(existsSync(held.path));
    if (command === 'promote-batch') assert.equal(readFileSync(receipt, 'utf8'), saved);
  } finally {
    held?.release();
    if (pending?.child.exitCode === null) { pending.child.kill('SIGTERM'); await pending.completed; }
    fixture.cleanup();
  }
});
