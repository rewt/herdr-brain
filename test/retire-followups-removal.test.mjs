import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRetirement } from '../supervisor/retire.mjs';
import { fixture, assertNoRemoval } from './helpers/retire-fixture.mjs';

function addFollowUp(f) {
  fs.appendFileSync(f.eventFile, JSON.stringify({ type: 'item.added', seq: 5, at: '2026-01-01T00:00:00Z',
    by: 'run:R-1', id: 'ENG-2', parent: 'ENG-1', from_run: 'R-1', role: 'engineer',
    title: 'Independent cleanup investigation' }) + '\n');
  return fs.readFileSync(f.eventFile, 'utf8');
}

for (const workspace of [true, false]) test(`integrated proposal follow-up permits actual guarded worktree removal (workspace ${workspace})`, t => {
  const f = fixture(t, { occupied: workspace });
  if (!workspace) { f.state.workspaces = []; f.save(); }
  const bytes = addFollowUp(f), retirement = f.retirement();
  if (workspace) {
    const plan = retirement.plan(); assert.equal(plan.close.length, 1);
    assert.equal(retirement.apply(plan)[0].action, 'closed');
  }
  const result = retirement.removeLane({ lane: f.lane, branch: 'lane/topic', expectedTip: f.head, gitOnly: true });
  assert.equal(result.integrated, true); assert.deepEqual(result.pending, []);
  assert.deepEqual(f.read().workspaces, [], 'the empty Herdr workspace must also close');
  assert.equal(fs.existsSync(f.lane), false, 'the real fixture worktree must be removed');
  assert.equal(f.git(['branch', '--list', 'lane/topic']), '', 'the integrated lane branch is retired');
  assert.equal(f.git(['tag', '--list', 'archive/lane/topic']), '', 'integrated work needs no archive');
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), bytes, 'the follow-up remains open in the unchanged record');
});

for (const verification of [1, 2]) test(`empty workspace keeps when removed tip loses integration at proof verification ${verification}`, t => {
  const f = fixture(t, { occupied: false }), base = f.git(['rev-parse', 'HEAD^']);
  const bytes = addFollowUp(f); let verified = 0;
  const command = (exe, args, options) => {
    if (exe === 'git' && args.includes('merge-base') && args.includes('--is-ancestor') && !fs.existsSync(f.lane)) {
      if (++verified === verification) f.git(['update-ref', 'refs/heads/main', base]);
    }
    return spawnSync(exe, args, options);
  };
  const retirement = createRetirement({ cwd: f.repo, org: f.org, herdr: f.job.herdr, env: f.env, command });
  const result = retirement.removeLane({ lane: f.lane, branch: 'lane/topic', expectedTip: f.head, gitOnly: true });
  assert.equal(verified, verification, 'the initial and final empty-workspace observations must recheck ancestry');
  assert.equal(result.pending.length, 1); assert.match(result.pending[0], /exit 1$/);
  assert.equal(fs.existsSync(f.lane), false, 'the worktree was already retired before integration changed');
  assert.equal(f.read().workspaces.length, 1, 'failed re-verification must retain the empty workspace');
  assert.deepEqual(f.read().actions, []); assert.equal(fs.readFileSync(f.eventFile, 'utf8'), bytes);
});

for (const workspace of [true, false]) test(`unintegrated proposal follow-up keeps the actual worktree (workspace ${workspace})`, t => {
  const f = fixture(t, { merged: false, occupied: false });
  if (!workspace) { f.state.workspaces = []; f.save(); }
  const bytes = addFollowUp(f), retirement = f.retirement();
  // Omit expectedTip: ordinary unmerged removal could archive this tip, but a
  // proposal follow-up only releases a source lane already contained in main.
  assert.throws(() => retirement.removeLane({ lane: f.lane, branch: 'lane/topic', gitOnly: true }), /ENG-2 has no recorded disposition/);
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.equal(f.git(['tag', '--list', 'archive/lane/topic']), '', 'refusal must happen before archival');
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), bytes); assertNoRemoval(f);
});
