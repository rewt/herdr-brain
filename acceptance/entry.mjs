import assert from 'node:assert/strict';

// Shared by the release gate and offline installed-entry regression. Watch is
// armed by dispatch; supervisor entry supplies the cold start and notice path.
export function assertSupervisorEntry(policy) {
  assert.match(policy, /dispatch.*ITEM/);
  assert.match(policy, /Only a supervisor/);
  assert.match(policy, /supervisor\/supervisor\.mjs/);
  assert.match(policy, /Cold start \(no model, no pane mutations\):\nSupervisor cold start/);
  assert.match(policy, /Running \(record; no live pane inference\) \(\d+\)/);
  assert.match(policy, /Reports and settlement \(\d+\)/);
  assert.match(policy, /Waiting on operator \(\d+\)/);
  assert.match(policy, /Next \(\d+\)/);
  assert.match(policy, /Every final `\[org-report\]` notice takes one path/);
  assert.match(policy, /handle --notice 'THE COMPLETE NOTICE' --role supervisor/);
  assert.match(policy, /invokes settle/);
  assert.match(policy, /promote RUN --why/);
  assert.match(policy, /\[promote-queue\]/);
}
