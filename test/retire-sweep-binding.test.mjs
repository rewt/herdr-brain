import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers/retire-fixture.mjs';
import { sweepCommands } from './helpers/retire-sweep-fixture.mjs';

for (const layout of ['fleet entry', 'legacy layout']) test(`sweep establishes no recorded chain through successful ${layout} discovery`, t => {
  const f = fixture(t, { occupied: false });
  fs.writeFileSync(f.eventFile, '');
  const entry = { identity: f.common, checkout: f.repo, record: f.org, worktrees: f.scratch, layers: [] };
  fs.mkdirSync(f.env.HERDR_MONITOR_FLEET);
  fs.writeFileSync(path.join(f.env.HERDR_MONITOR_FLEET, 'fleet.json'), JSON.stringify({ version: 1, session_limit: 6,
    projects: layout === 'fleet entry' ? { project: entry } : {} }));
  if (layout === 'legacy layout') fs.symlinkSync(f.org, path.join(f.repo, '.org'));
  const before = fs.readFileSync(f.eventFile), commands = sweepCommands(f);
  // Discover through the same canonical project/fleet reader used in production,
  // without an explicit org option or inherited ORG_DIR supplying the answer.
  const retirement = f.retirement({ ...commands, org: undefined, env: { ...f.env, ORG_DIR: '' } });
  const rows = retirement.sweepIntegratedLanes();
  assert.equal(rows.length, 1); assert.equal(rows[0].action, 'lane-removed', JSON.stringify(rows));
  assert.equal(fs.existsSync(f.lane), false); assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  assert.ok(commands.calls.find(row => row.exe === 'git' && row.args.includes('remove'))?.locked);
  assert.deepEqual(fs.readFileSync(f.eventFile), before);
});
