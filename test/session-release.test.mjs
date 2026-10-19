import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { fold as olderFold } from './fixtures/state-v0.mjs';
import { retirementStatus } from '../lib/retire-status.mjs';
import { paneReleaseEvents } from '../lib/retire-command.mjs';
import { exitFixture } from './helpers/retire-exit-fixture.mjs';
import { hold } from './helpers/retire-fixture.mjs';
import { parseOverride } from '../housekeeping/config.mjs';

function writeEvents(f, events) {
  fs.writeFileSync(f.eventFile, events.map((e, i) => JSON.stringify({ ...e, seq: i + 1 }) + '\n').join(''));
}
function openFixture(t, { reviewer = false, landed = false, verdict = 'PASS' } = {}) {
  const f = exitFixture(t), events = loadEvents(f.org).events.filter(e => e.type !== 'item.closed');
  if (reviewer) { events[0].role = 'reviewer'; events[2].report.extra = { verdict }; }
  else events.push(
    { type: 'item.added', id: 'ENG-2', role: 'engineer', kind: 'work', parent: 'ENG-1' },
    { type: 'item.added', id: 'REV-1', role: 'reviewer', kind: 'work', parent: 'ENG-1' },
    { type: 'run.started', id: 'R-2', item: 'REV-1', workspace: f.lane, meta: {} },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done', extra: { verdict } } });
  if (landed) events.push({ type: 'promotion.reconciled', identity: f.common, batch: 'batch', tip: f.head,
    heads: [{ run: 'R-1', item: 'ENG-1', head: f.head }], runs: ['R-1'], items: ['ENG-1'] });
  writeEvents(f, events);
  return f;
}
const releaseEvents = f => loadEvents(f.org).events.filter(e => e.type === 'retirement.release');
const assertKept = f => {
  const r = f.retirement(), plan = r.plan();
  assert.equal(plan.sessionReleases?.length ?? 0, 0);
  assert.equal(plan.close.length, 0);
  r.apply(plan);
  assert.deepEqual(f.read().actions, []);
  assert.deepEqual(releaseEvents(f), []);
  return plan.keep[0].why;
};

test('default policy releases a reviewer PASS through pane-release and S7 while its chain is open', t => {
  const f = openFixture(t, { reviewer: true }), r = f.retirement(), before = fold(loadEvents(f.org).events);
  const plan = r.plan();
  assert.equal(plan.close.length, 0, 'a prospective policy release cannot directly authorize close');
  assert.equal(plan.sessionReleases.length, 1);
  assert.equal(retirementStatus(r.observe()).rows.find(row => row.type === 'tab').class, 'TERMINAL');
  const results = r.apply(plan);
  assert.ok(results.some(row => row.action === 'session-released'));
  assert.ok(results.some(row => row.action === 'closed'), JSON.stringify(results));
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t'], ['workspace', 'close', 'w']]);
  const release = releaseEvents(f)[0];
  assert.equal(release.authority, 'per-run-session-release/v1');
  assert.equal(release.session, 'session'); assert.equal(release.terminal, 'term');
  assert.equal(fold(loadEvents(f.org).events).items.get('ENG-1').closed, null);
  assert.deepEqual(fold(loadEvents(f.org).events).runs, before.runs);
  assert.deepEqual(olderFold(loadEvents(f.org).events).runs, olderFold(loadEvents(f.org).events.filter(e => !e.type.startsWith('retirement.'))).runs);
  assert.equal(fs.existsSync(f.lane), true, 'releasing the session does not remove an open lane');
  r.apply(r.plan()); assert.equal(releaseEvents(f).length, 1);
});

test('a worker releases after its exact run lands even with an open child; PASS before landing keeps it', t => {
  const f = openFixture(t), r = f.retirement();
  assertKept(f);
  const events = loadEvents(f.org).events;
  events.push({ type: 'promotion.reconciled', identity: f.common, batch: 'batch', tip: f.head,
    heads: [{ run: 'R-1', item: 'ENG-1', head: f.head }], runs: ['R-1'], items: ['ENG-1'] });
  writeEvents(f, events);
  assert.equal(r.plan().sessionReleases.length, 1);
  const result = r.apply(r.plan());
  assert.ok(result.some(row => row.action === 'closed'), JSON.stringify(result));
  assert.equal(fold(loadEvents(f.org).events).items.get('ENG-2').closed, null);
  assert.match(f.git(['branch', '--list', 'lane/topic']), /lane\/topic/);
});

for (const reviewer of [true, false]) test(`NEEDS-WORK keeps the ${reviewer ? 'reviewer' : 'worker'} session`, t => {
  assertKept(openFixture(t, { reviewer, landed: !reviewer, verdict: 'NEEDS-WORK' }));
});

test('a reused worker and its pane/terminal identity cannot be released as an older landed run', t => {
  const f = openFixture(t, { landed: true }), events = loadEvents(f.org).events;
  events.push({ type: 'run.started', id: 'R-3', item: 'ENG-1', workspace: f.lane,
    meta: { ...events[1].meta } });
  writeEvents(f, events);
  assert.match(assertKept(f), /report is not ingested/);
  assert.throws(() => paneReleaseEvents(loadEvents(f.org).events, 'R-1', { ...f.retirement().observe(),
    session: 'session', terminal: 'term', pane: 'w:p', head: f.head, confirm: true,
    authority: 'policy', next: 'successor', unresolved: 'retained', evidence: ['receipt'], why: 'landed' }), /continuation keeps/);
});

test('a confirmed different successor releases the old worker; missing or reused identity does not', t => {
  const f = openFixture(t), events = loadEvents(f.org).events;
  const meta = { ...events[1].meta, agent: 'successor', pane: 'w:q', terminal_id: 'next-terminal', agent_session_id: 'next-session' };
  events.push({ type: 'run.started', id: 'R-3', item: 'ENG-1', workspace: f.lane, meta });
  f.state.tabs.push({ tab_id: 'w:u', workspace_id: 'w' });
  f.state.panes.push({ pane_id: 'w:q', tab_id: 'w:u', workspace_id: 'w', terminal_id: 'next-terminal' });
  f.state.agents.push({ ...f.state.agents[0], name: 'successor', pane_id: 'w:q', tab_id: 'w:u', terminal_id: 'next-terminal',
    agent_session: { value: 'next-session' }, agent_status: 'working' });
  writeEvents(f, events); f.save();
  assert.equal(f.retirement().plan().sessionReleases?.length ?? 0, 0, 'a newer run is not a confirmed handoff');
  events.push({ type: 'retirement.handoff', from: 'R-1', to: 'R-3', confirmed: true }); writeEvents(f, events);
  const plan = f.retirement().plan();
  assert.equal(plan.sessionReleases.length, 1); assert.equal(plan.sessionReleases[0].run, 'R-1');
  assert.match(plan.sessionReleases[0].opt.why, /confirmed retained successor R-3/);
  for (const key of ['terminal_id', 'pane', 'agent_session_id']) {
    const previous = meta[key]; meta[key] = events[1].meta[key]; writeEvents(f, events);
    assert.equal(f.retirement().plan().sessionReleases?.length ?? 0, 0, key);
    meta[key] = previous;
  }
});

test('another run or another repository integration receipt cannot release this worker', t => {
  for (const field of ['run', 'identity']) {
    const f = openFixture(t, { landed: true }), events = loadEvents(f.org).events, landed = events.at(-1);
    if (field === 'run') { landed.runs = ['R-999']; landed.heads[0].run = 'R-999'; }
    else landed.identity = '/foreign/.git';
    writeEvents(f, events); assertKept(f);
  }
});

test('a landed worker with subsequent unintegrated edits stays warm', t => {
  const f = openFixture(t, { landed: true });
  fs.writeFileSync(path.join(f.lane, 'seed'), 'new work');
  assertKept(f);
  f.git(['commit', '-am', 'new work'], f.lane);
  assertKept(f);
});

test('a successor review cannot retain the old run after its own PASS and integration', t => {
  const f = openFixture(t, { landed: true }), events = loadEvents(f.org).events;
  events.push({ type: 'run.started', id: 'R-3', item: 'ENG-1', workspace: f.lane, meta: {
    agent: 'successor', pane: 'w:q', terminal_id: 'next-terminal', agent_session_id: 'next-session' } },
  { type: 'run.started', id: 'R-4', item: 'REV-1', workspace: f.lane, meta: {} },
  { type: 'report.ingested', run: 'R-4', report: { outcome: 'done', extra: { verdict: 'NEEDS-WORK' } } });
  writeEvents(f, events);
  const plan = f.retirement().plan();
  assert.equal(plan.sessionReleases.length, 1); assert.equal(plan.sessionReleases[0].run, 'R-1');
});

for (const mismatch of ['terminal_id', 'session', 'name']) test(`a mismatched ${mismatch} keeps the session with a named lanes reason`, t => {
  const f = openFixture(t, { reviewer: true });
  if (mismatch === 'session') f.state.agents[0].agent_session.value = 'replacement';
  else f.state.agents[0][mismatch] = 'replacement';
  f.save();
  assert.match(assertKept(f), /mismatched recorded launch identity/);
  assert.match(retirementStatus(f.retirement().observe()).rows.find(row => row.type === 'tab').reason, /identity/);
});

test('HOLD and live references refuse automatic release before it records any disposition', t => {
  const f = openFixture(t, { reviewer: true }), clear = hold(f);
  assert.match(assertKept(f), /HOLD-WORKER-TAB-CLOSE/);
  clear();
  fs.writeFileSync(path.join(f.org, 'references/live.json'), JSON.stringify({ schema: 'herdr-reference/v1',
    kind: 'named callback', job: 'job', owner: 'owner', item: 'ENG-1', run: 'R-1', state: 'running',
    created_at: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' }));
  assert.match(assertKept(f), /named callback reference job/);
});

test('policy off keeps both kinds of eligible session; invalid overrides fail closed', t => {
  assert.equal(parseOverride('release_sessions', 'false'), false);
  assert.throws(() => parseOverride('release_sessions', 'yes'), /true\|false/);
  for (const reviewer of [true, false]) {
    const f = openFixture(t, { reviewer, landed: !reviewer });
    fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), JSON.stringify({ release_sessions: false }));
    assert.match(assertKept(f), /policy is off/);
    fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), JSON.stringify({ release_sessions: 'false' }));
    assert.match(assertKept(f), /session release policy unreadable/);
  }
});

for (const enabled of [false, true]) test(`a closed landed chain uses ordinary retirement with per-run policy ${enabled ? 'on' : 'off'}`, t => {
  const f = openFixture(t, { landed: true }), events = loadEvents(f.org).events;
  for (const id of ['ENG-2', 'REV-1', 'ENG-1']) events.push({ type: 'item.closed', id, as: 'done' });
  writeEvents(f, events);
  fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), JSON.stringify({ release_sessions: enabled }));
  const eventBytes = fs.readFileSync(f.eventFile), r = f.retirement(), plan = r.plan();
  assert.equal(plan.close.length, 1, 'the core close must not become a per-run KEEP');
  assert.equal(plan.close[0].tab_id, 'w:t');
  assert.equal(plan.sessionReleases?.length ?? 0, 0, 'ordinary retirement needs no pane-release transaction');
  const results = r.apply(plan);
  assert.equal(results.filter(row => row.action === 'closed' && row.tab_id === 'w:t').length, 1, JSON.stringify(results));
  assert.equal(results.some(row => row.action === 'session-released'), false);
  assert.deepEqual(releaseEvents(f), []);
  assert.deepEqual(fs.readFileSync(f.eventFile), eventBytes);
  const actions = [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']];
  assert.deepEqual(f.read().actions, actions, 'the native exit and tab close each run once');
  r.apply(r.plan());
  assert.deepEqual(f.read().actions, actions, 'a later observation cannot handle the tab twice');
});

test('apply rechecks native identity, head, policy and references before recording pane-release', t => {
  for (const change of ['identity', 'head', 'policy', 'reference', 'hold']) {
    const f = openFixture(t, { reviewer: true }), r = f.retirement(), plan = r.plan();
    if (change === 'identity') { f.state.agents[0].terminal_id = 'replacement'; f.save(); }
    if (change === 'head') { fs.writeFileSync(path.join(f.lane, 'seed'), 'new'); f.git(['commit', '-am', 'advance'], f.lane); }
    if (change === 'policy') fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"release_sessions":false}');
    if (change === 'hold') hold(f);
    if (change === 'reference') fs.writeFileSync(path.join(f.org, 'references/bad.json'), '{');
    const result = r.apply(plan);
    assert.ok(result.some(row => ['release-kept', 'held'].includes(row.action)), `${change}: ${JSON.stringify(result)}`);
    assert.deepEqual(releaseEvents(f), [], change); assert.deepEqual(f.read().actions, [], change);
  }
});

test('a settle reviewer records its validated verdict and releases independently of the worker', t => {
  const f = openFixture(t), events = loadEvents(f.org).events;
  events[1].meta = { ...events[1].meta, agent: 'original-worker', pane: 'w:original', terminal_id: 'other-terminal', agent_session_id: 'other-session' };
  writeEvents(f, events);
  // Scripted PID 2 lives until the fake native exit unregisters its occupant.
  const r = f.retirement({ readOwner: () => f.read().agents.length > 0 });
  r.recordCallback({ kind: 'settle', pane: 'w:p', agent: 'worker', run: 'R-1' });
  const evidence = path.join(f.scratch, 'validated-review.md'), bytes = '**PASS**\nvalidated by lane review\n';
  fs.writeFileSync(evidence, bytes);
  const eventBytes = fs.readFileSync(f.eventFile);
  r.recordReviewVerdict({ pane: 'w:p', run: 'R-1', verdict: 'PASS', head: f.head, evidence,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  assert.deepEqual(fs.readFileSync(f.eventFile), eventBytes, 'review verdict evidence leaves the event log unchanged');
  fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"release_sessions":false}');
  assertKept(f);
  fs.unlinkSync(path.join(f.repo, '.housekeeping.json'));
  const plan = r.plan(); assert.equal(plan.sessionReleases?.length, 1, JSON.stringify({ plan, callbacks: r.observe().callbacks }));
  assert.equal(plan.sessionReleases[0].opt.reviewer, true);
  const results = r.apply(plan);
  assert.ok(results.some(row => row.action === 'closed'), JSON.stringify(results));
  const release = releaseEvents(f)[0];
  assert.equal(release.recipient, 'reviewer'); assert.equal(release.agent, 'worker');
  assert.equal(fold(loadEvents(f.org).events).items.get('ENG-1').closed, null);
});

test('an unregistered released shell retries a failed close and then closes its last workspace', t => {
  const f = openFixture(t, { reviewer: true }), r = f.retirement();
  f.state.failClose = true; f.save();
  const first = r.apply(r.plan());
  assert.ok(first.some(row => row.action === 'skip-close' && /injected tab failure/.test(row.why)), JSON.stringify(first));
  assert.equal(f.read().agents.length, 0);
  const state = f.read(); state.failClose = false; fs.writeFileSync(f.file, JSON.stringify(state));
  fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"release_sessions":false}');
  assert.equal(r.plan().close.length, 0, 'disabling the policy also holds a previously released but unclosed shell');
  fs.unlinkSync(path.join(f.repo, '.housekeeping.json'));
  const second = r.apply(r.plan());
  assert.ok(second.some(row => row.action === 'closed' && row.tab_id === 'w:t'), JSON.stringify(second));
  assert.equal(f.read().workspaces.length, 0);
  assert.equal(f.read().actions.filter(a => a[0] === 'agent').length, 1, 'the exit is not repeated');
  assert.equal(fs.existsSync(f.lane), true);
});
