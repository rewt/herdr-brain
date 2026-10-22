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

test('follow-up terminal age uses the same observed lane Git facts as its retirement class', t => {
  const f = fixture(t); record(f);
  const snapshot = f.retirement().observe(), generatedAt = '2026-01-01T01:00:00Z';
  const before = structuredClone(snapshot);
  const tab = retirementStatus(snapshot, { generatedAt }).rows.find(r => r.type === 'tab');
  assert.equal(tab.class, 'TERMINAL');
  assert.equal(tab.terminalAt, '2026-01-01T00:00:00Z'); assert.equal(tab.terminalAgeMs, 3600000);
  assert.deepEqual(snapshot, before, 'terminal-age projection must not mutate observed authority');
  const unintegrated = structuredClone(snapshot); unintegrated.git[0].integrated = false;
  const kept = retirementStatus(unintegrated, { generatedAt }).rows.find(r => r.type === 'tab');
  assert.notEqual(kept.class, 'TERMINAL'); assert.equal(kept.terminalAt, null); assert.equal(kept.terminalAgeMs, null);
  const unknown = structuredClone(snapshot); delete unknown.git[0].integrated;
  assert.equal(retirementStatus(unknown, { generatedAt }).rows.find(r => r.type === 'tab').terminalAt, null);
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

test('landed content ignores child dispositions while local live runs and unknown bindings still keep', t => {
  const f = fixture(t); record(f);
  const baseline = { ...f.retirement().observe(), closeoutQueuePolicy: true };
  const cases = [
    ['direct link blocker', s => { s.record.links.push({ blocked: 'ENG-1', blocker: 'ENG-2' }); }],
    ['direct blocked_by blocker', s => { s.record.items[0].blocked_by = ['ENG-2']; }],
    ['transitive mixed blocker path', s => {
      s.record.items.push({ id: 'ENG-3', role: 'engineer', closed: { as: 'done' }, blocked_by: ['ENG-2'] });
      s.record.links.push({ blocked: 'ENG-1', blocker: 'ENG-3' });
    }],
    ['own reported run in this checkout', s => { s.record.runs.push({ id: 'R-2', item: 'ENG-2', workspace: f.lane,
      started: { seq: 6 }, report: { seq: 7, outcome: 'done' } }); }],
    ['own run in a checkout subdirectory', s => { s.record.runs.push({ id: 'R-2', item: 'ENG-2', started: { seq: 6 }, workspace: path.join(f.lane, 'subdir') }); }],
    ['own run with unknown checkout', s => { s.record.runs.push({ id: 'R-2', item: 'ENG-2', started: { seq: 6 } }); }],
    ['unintegrated tip', s => { s.git[0].integrated = false; }],
    ['archive alone', s => { s.git[0].integrated = false; s.git[0].archived = true; }],
    ['missing integration observation', s => { delete s.git[0].integrated; }],
    ['ordinary child', s => { delete s.record.items[1].created.run; }],
    ['unknown proposal run', s => { s.record.items[1].created.run = 'R-404'; }],
    ['proposal run outside this chain', s => {
      s.record.items[1].created.run = 'R-9';
      s.record.items.push({ id: 'ENG-9', role: 'engineer' });
      s.record.runs.push({ id: 'R-9', item: 'ENG-9', started: { seq: 6 }, workspace: '/another/lane', report: { seq: 8, outcome: 'done' } });
    }],
    ['proposal reviewer without PASS', s => { s.record.items[1].role = 'reviewer'; }],
    ['declined answer', s => { s.record.items[1].meta.answer = 'no'; }],
  ];
  for (const [name, mutate] of cases) {
    const s = structuredClone(baseline); mutate(s);
    const plan = planRetirement(s);
    const hold = ['own run in a checkout subdirectory', 'own run with unknown checkout', 'unintegrated tip', 'missing integration observation'].includes(name);
    assert.equal(plan.close.length, hold ? 0 : 1, name); assert.equal(plan.keep.length, hold ? 1 : 0, name);
    assert.equal(Boolean(laneRemovalReason(vacant(s), f.lane)), hold, name);
    assert.equal(planRetirement(vacant(s)).laneKeep.length, hold ? 1 : 0, name);
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

test('open source children release with landed content; live references remain holds', t => {
  const f = fixture(t); record(f);
  const s = { ...f.retirement().observe(), closeoutQueuePolicy: true };
  s.record.items.push({ id: 'ENG-3', parent: 'ENG-1', role: 'engineer' });
  assert.equal(planRetirement(s).close.length, 1);
  assert.equal(laneRemovalReason(vacant(s), f.lane), null);
  s.record.items.pop(); s.references.push({ kind: 'callback', item: 'ENG-2' });
  assert.match(planRetirement(s).keep[0].why, /callback reference/);
  assert.match(laneRemovalReason(vacant(s), f.lane), /callback reference/);
});

test('a separately dispatched follow-up owns its reviewer, corrections and exclusive blocker chain', t => {
  const f = fixture(t); record(f, [proposal,
    { type: 'run.started', id: 'R-2', item: 'ENG-2', workspace: path.join(f.scratch, 'followup-lane') },
    { type: 'item.added', id: 'REV-1', parent: 'ENG-2', role: 'reviewer', from_run: 'R-2' },
    { type: 'item.added', id: 'ENG-3', parent: 'REV-1', role: 'engineer' },
    { type: 'item.added', id: 'HUM-1', role: 'human' },
    { type: 'item.added', id: 'ENG-4', parent: 'HUM-1', role: 'engineer' },
    { type: 'link.added', blocked: 'ENG-2', blocker: 'HUM-1' },
  ]);
  const s = { ...f.retirement().observe(), closeoutQueuePolicy: true }, before = structuredClone(s);
  const plan = planRetirement(s);
  assert.equal(plan.close.length, 1); assert.equal(laneRemovalReason(vacant(s), f.lane), null);
  assert.deepEqual(followUps(plan).map(d => d.item), ['ENG-2']);
  assert.deepEqual(s, before, 'exemptions must not rewrite the folded chain');
  assert.equal(retirementStatus(s).counts.UNKNOWN, 0);
  const cases = [
    ['reviewer run in source checkout', fresh => { fresh.record.runs.push({ id: 'R-3', item: 'REV-1', started: { seq: 12 }, workspace: f.lane }); }],
    ['correction run in source subdirectory', fresh => { fresh.record.runs.push({ id: 'R-3', item: 'ENG-3', started: { seq: 12 }, workspace: path.join(f.lane, 'subdir') }); }],
    ['descendant with unknown run binding', fresh => { fresh.record.runs.push({ id: 'R-3', item: 'ENG-3', started: { seq: 12 } }); }],
    ['subtree blocker through links', fresh => { fresh.record.links.push({ blocked: 'ENG-1', blocker: 'ENG-3' }); }],
    ['subtree blocker through blocked_by', fresh => { fresh.record.items[0].blocked_by = ['REV-1']; }],
    ['subtree blocker through satisfied source blocker', fresh => {
      fresh.record.items.push({ id: 'ENG-5', role: 'engineer', closed: { as: 'done' }, blocked_by: ['ENG-3'] });
      fresh.record.links.push({ blocked: 'ENG-1', blocker: 'ENG-5' });
    }],
    ['follow-up blocker independently belongs to source subtree', fresh => { fresh.record.items.find(i => i.id === 'HUM-1').parent = 'ENG-1'; }],
    ['follow-up blocker also blocks source root', fresh => { fresh.record.links.push({ blocked: 'ENG-1', blocker: 'HUM-1' }); }],
  ];
  for (const [name, mutate] of cases) {
    const fresh = structuredClone(s); mutate(fresh);
    const hold = name.includes('run in source') || name.includes('unknown run binding');
    assert.equal(planRetirement(fresh).close.length, hold ? 0 : 1, name);
    assert.equal(Boolean(laneRemovalReason(vacant(fresh), f.lane)), hold, name);
  }
  for (const mutate of [
    fresh => { fresh.record.runs.push({ id: 'R-3', item: 'REV-1', started: { seq: 12 }, workspace: f.lane }); },
    fresh => { fresh.record.links.push({ blocked: 'ENG-1', blocker: 'ENG-3' }); },
  ]) {
    const fresh = structuredClone(s); mutate(fresh);
    const result = executeRetirement(plan, { observe: () => fresh, close: () => assert.fail('newly bound subtree was closed') });
    assert.equal(result[0].action, 'skip-close');
  }
});

test('dependencies between exempt follow-ups do not retain the source, but a retained branch revokes their exemption', t => {
  const f = fixture(t); record(f, [proposal,
    { ...proposal, id: 'ENG-3', title: 'Another independent follow-up' },
    { type: 'item.added', id: 'REV-1', parent: 'ENG-3', role: 'reviewer' },
    { type: 'link.added', blocked: 'ENG-2', blocker: 'REV-1' },
  ]);
  const s = { ...f.retirement().observe(), closeoutQueuePolicy: true };
  assert.equal(planRetirement(s).close.length, 1);
  assert.equal(laneRemovalReason(vacant(s), f.lane), null);
  assert.deepEqual(followUps(planRetirement(s)).map(d => d.item), ['ENG-2', 'ENG-3']);
  s.record.runs.push({ id: 'R-2', item: 'ENG-2', started: { seq: 6 }, workspace: f.lane, report: { seq: 8, outcome: 'done' } });
  assert.equal(planRetirement(s).close.length, 1);
  assert.equal(laneRemovalReason(vacant(s), f.lane), null);
  assert.deepEqual(followUps(planRetirement(s)), [], 'retained source work depends on the second follow-up subtree');
});

test('fresh blocker and same-lane dispatch observations invalidate a prior follow-up release', t => {
  const f = fixture(t); record(f);
  const s = f.retirement().observe(), plan = planRetirement(s);
  assert.equal(plan.close.length, 1);
  for (const mutate of [
    fresh => { fresh.record.links.push({ blocked: 'ENG-1', blocker: 'ENG-2' }); },
    fresh => { fresh.record.runs.push({ id: 'R-2', item: 'ENG-2', started: { seq: 6 }, workspace: f.lane }); },
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
