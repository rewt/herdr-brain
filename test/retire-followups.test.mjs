import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fold } from '../lib/state.mjs';
import { planRetirement, laneRemovalReason, executeRetirement } from '../lib/retire.mjs';
import { retirementStatus, renderRetirementStatus } from '../lib/retire-status.mjs';
import { fixture, hold, heldReason, assertNoRemoval } from './helpers/retire-fixture.mjs';

const cli = fileURLToPath(new URL('../supervisor/retire.mjs', import.meta.url));
const proposal = { type: 'item.added', id: 'ENG-2', parent: 'ENG-1', role: 'engineer',
  title: 'Investigate the intermittent cleanup assertion', from_run: 'R-1', why: 'Independent follow-up' };
function record(f, extra = [proposal]) {
  const events = [...f.eventBytes.trim().split('\n').map(JSON.parse), ...extra]
    .map((event, i) => ({ at: '2026-01-01T00:00:00Z', by: 'fixture', ...event, seq: i + 1 }));
  fs.writeFileSync(f.eventFile, events.map(event => JSON.stringify(event) + '\n').join(''));
  return fold(events);
}
const followUps = plan => plan.diagnostics.filter(d => d.type === 'follow-up');
const vacant = s => ({ ...s, tabs: [], panes: [], agents: [],
  removal: { cwd: s.git[0].path, branch: 'lane/topic' } });

test('integrated nonblocking proposal releases the tab and lane check, with one actionable diagnostic', t => {
  const f = fixture(t); record(f);
  const retirement = f.retirement(), s = retirement.observe(), before = structuredClone(s);
  assert.equal(s.record.items.find(i => i.id === 'ENG-2').created.run, 'R-1');
  const plan = planRetirement(s);
  assert.equal(plan.close.length, 1); assert.deepEqual(plan.keep, []);
  assert.equal(laneRemovalReason(vacant(s), f.lane), null);
  assert.equal(planRetirement(vacant(s)).laneClose.length, 1);
  assert.equal(followUps(plan).length, 1);
  assert.deepEqual(followUps(plan)[0], { type: 'follow-up', item: 'ENG-2', title: proposal.title,
    owner: 'engineer', cwd: f.lane, reason: `ENG-2: ${proposal.title}; owner role engineer`,
    nextAction: 'dispatch or disposition in its own lane' });
  assert.deepEqual(s, before, 'classification must not mutate the fold or authority snapshot');
  assert.equal(retirement.apply(plan)[0].action, 'closed');
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

test('status CLI and table list each follow-up once, with its title, owner role and next action', t => {
  const f = fixture(t); record(f, [proposal,
    { type: 'run.started', id: 'R-2', item: 'ENG-1', workspace: f.lane },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done' } },
  ]);
  const command = verb => spawnSync(process.execPath, [cli, verb, '--repo', f.repo, '--org', f.org,
    '--herdr', f.job.herdr, ...(verb === 'status' ? ['--json'] : [])], { env: f.env, encoding: 'utf8' });
  const planned = command('plan'); assert.equal(planned.status, 0, planned.stderr);
  assert.equal(followUps(JSON.parse(planned.stdout)).length, 1, 'two chain runs must not duplicate the item');
  const displayed = command('status'); assert.equal(displayed.status, 0, displayed.stderr);
  const status = JSON.parse(displayed.stdout), rows = status.rows.filter(r => r.type === 'follow-up');
  assert.equal(rows.length, 1); assert.equal(rows[0].item, 'ENG-2'); assert.equal(rows[0].title, proposal.title);
  assert.equal(rows[0].owner, 'engineer'); assert.equal(rows[0].class, null);
  assert.equal(rows[0].nextAction, 'dispatch or disposition in its own lane');
  assert.equal(status.counts.UNKNOWN, 0);
  for (const markdown of [false, true]) {
    const text = renderRetirementStatus(status, { markdown });
    for (const value of ['follow-up', 'ENG-2', proposal.title, 'owner role engineer', rows[0].nextAction]) assert.ok(text.includes(value), value);
  }
  assert.deepEqual(f.read().actions, [], 'status and plan are read-only');
});

test('all provenance, lane-binding and dependency negatives keep both the tab and the worktree', t => {
  const f = fixture(t); record(f);
  const baseline = f.retirement().observe();
  const cases = [
    ['direct link blocker', s => { s.record.links.push({ blocked: 'ENG-1', blocker: 'ENG-2' }); }],
    ['direct blocked_by blocker', s => { s.record.items[0].blocked_by = ['ENG-2']; }],
    ['transitive mixed blocker path', s => {
      s.record.items.push({ id: 'ENG-3', role: 'engineer', closed: { as: 'done' }, blocked_by: ['ENG-2'] });
      s.record.links.push({ blocked: 'ENG-1', blocker: 'ENG-3' });
    }],
    ['own reported run in this checkout', s => { s.record.runs.push({ id: 'R-2', item: 'ENG-2', workspace: f.lane,
      started: { seq: 6 }, report: { seq: 7, outcome: 'done' } }); }],
    ['own run in a checkout subdirectory', s => { s.record.runs.push({ id: 'R-2', item: 'ENG-2', workspace: path.join(f.lane, 'subdir') }); }],
    ['own run with unknown checkout', s => { s.record.runs.push({ id: 'R-2', item: 'ENG-2' }); }],
    ['unintegrated tip', s => { s.git[0].integrated = false; }],
    ['archive alone', s => { s.git[0].integrated = false; s.git[0].archived = true; }],
    ['missing integration observation', s => { delete s.git[0].integrated; }],
    ['ordinary child', s => { delete s.record.items[1].created.run; }],
    ['unknown proposal run', s => { s.record.items[1].created.run = 'R-404'; }],
    ['proposal run outside this chain', s => {
      s.record.items[1].created.run = 'R-9';
      s.record.items.push({ id: 'ENG-9', role: 'engineer' });
      s.record.runs.push({ id: 'R-9', item: 'ENG-9', workspace: '/another/lane', report: { seq: 8, outcome: 'done' } });
    }],
    ['proposal reviewer without PASS', s => { s.record.items[1].role = 'reviewer'; }],
    ['declined answer', s => { s.record.items[1].meta.answer = 'no'; }],
  ];
  for (const [name, mutate] of cases) {
    const s = structuredClone(baseline); mutate(s);
    const plan = planRetirement(s);
    assert.equal(plan.close.length, 0, name); assert.equal(plan.keep.length, 1, name);
    assert.ok(laneRemovalReason(vacant(s), f.lane), name);
    assert.equal(planRetirement(vacant(s)).laneKeep.length, 1, name);
    assert.deepEqual(followUps(plan), [], name);
  }
});

test('a proposal dispatched in its own lane does not reclaim the integrated source checkout', t => {
  const f = fixture(t); record(f, [proposal,
    { type: 'run.started', id: 'R-2', item: 'ENG-2', workspace: path.join(f.scratch, 'followup-lane') },
  ]);
  const s = f.retirement().observe();
  assert.equal(planRetirement(s).close.length, 1);
  assert.equal(laneRemovalReason(vacant(s), f.lane), null);
  assert.equal(followUps(planRetirement(s)).length, 1);
});

test('ordinary descendants and live references remain holds even when the proposal itself qualifies', t => {
  const f = fixture(t); record(f);
  const s = f.retirement().observe();
  s.record.items.push({ id: 'ENG-3', parent: 'ENG-2', role: 'engineer' });
  assert.match(planRetirement(s).keep[0].why, /ENG-3 has no recorded disposition/);
  assert.match(laneRemovalReason(vacant(s), f.lane), /ENG-3 has no recorded disposition/);
  s.record.items.pop(); s.references.push({ kind: 'callback', item: 'ENG-2' });
  assert.match(planRetirement(s).keep[0].why, /callback reference/);
  assert.match(laneRemovalReason(vacant(s), f.lane), /callback reference/);
});

test('fresh blocker and same-lane dispatch observations invalidate a prior follow-up release', t => {
  const f = fixture(t); record(f);
  const s = f.retirement().observe(), plan = planRetirement(s);
  assert.equal(plan.close.length, 1);
  for (const mutate of [
    fresh => { fresh.record.links.push({ blocked: 'ENG-1', blocker: 'ENG-2' }); },
    fresh => { fresh.record.runs.push({ id: 'R-2', item: 'ENG-2', workspace: f.lane }); },
    fresh => { fresh.git[0].integrated = false; },
  ]) {
    const fresh = structuredClone(s); mutate(fresh);
    const result = executeRetirement(plan, { observe: () => fresh, close: () => assert.fail('stale close fired') });
    assert.equal(result[0].action, 'skip-close');
  }
});

test('a canonical HOLD retains proposal-follow-up panes and lane removal while status keeps the follow-up visible', t => {
  const f = fixture(t); record(f); const release = hold(f), retirement = f.retirement();
  const plan = retirement.plan(); assert.equal(plan.close.length, 0); assert.equal(plan.keep[0].why, heldReason);
  assert.equal(retirement.apply(plan)[0].action, 'held');
  const s = retirement.observe(); assert.equal(laneRemovalReason(vacant(s), f.lane), heldReason);
  const row = retirementStatus(s).rows.find(r => r.type === 'follow-up');
  assert.equal(row.item, 'ENG-2'); assert.equal(row.held, heldReason); assert.equal(row.class, null);
  assertNoRemoval(f); release();
  assert.equal(retirement.plan().close.length, 1);
});
