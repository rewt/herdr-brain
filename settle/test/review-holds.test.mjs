import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { report, setupOrg } from '../../test/helpers.mjs';
import { itemStatus } from '../../lib/state.mjs';
import { snapshotState, waitingOutcome } from '../record-state.mjs';

for (const resolution of ['PASS', 'dropped']) test(`settle keeps an unlinked blocked report waiting after a ${resolution} child review, but releases a linked report`, t => {
  const f = setupOrg(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.ok(['add', 'Implement the change', '--role', 'engineer']);
  f.ok(['add', 'Review the change', '--role', 'reviewer', '--parent', 'ENG-1']);
  f.ok(['start', 'ENG-1']);
  fs.writeFileSync(path.join(f.dir, 'runs/R-1/report.md'), report(`run: R-1
outcome: blocked
summary: Waiting for an external dependency.
headline: Work is waiting
blockers:
  - External dependency`));
  f.ok(['sync']);
  if (resolution === 'PASS') {
    f.ok(['start', 'REV-1']);
    fs.writeFileSync(path.join(f.dir, 'runs/R-2/report.md'), report(`run: R-2
outcome: done
verdict: PASS
summary: Review passed.
headline: Review passed`));
    f.ok(['sync']);
  } else f.ok(['close', 'REV-1', '--dropped', '--note', 'Review waived by explicit exception']);

  const snapshot = f.json(['status', '--json']);
  let state = snapshotState(snapshot, f.events()), item = state.items.get('ENG-1');
  assert.deepEqual(item.blocked_by, ['REV-1'], 'snapshot includes the derived child hold');
  assert.equal(state.links.length, 0, 'the hold is not a recorded link');
  assert.equal(item.status, 'blocked');
  assert.equal(itemStatus(state, item.id), 'blocked', 'snapshot-shaped state supports status derivation');
  assert.equal(waitingOutcome(state, item), true);

  f.ok(['block', 'ENG-1', '--by', 'REV-1']);
  // Reading a newer tail cannot change the record prefix described by the old snapshot.
  const historical = snapshotState(snapshot, f.events());
  assert.equal(historical.links.length, 0);
  assert.equal(waitingOutcome(historical, historical.items.get('ENG-1')), true);

  state = snapshotState(f.json(['status', '--json']), f.events()); item = state.items.get('ENG-1');
  assert.deepEqual(state.links.map(l => [l.blocker, l.blocked]), [['REV-1', 'ENG-1']]);
  assert.equal(item.status, 'ready');
  assert.equal(itemStatus(state, item.id), 'ready');
  assert.equal(waitingOutcome(state, item), false);
});
