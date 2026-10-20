import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { fold as olderFold } from './fixtures/state-v0.mjs';
import { retirementStatus } from '../lib/retire-status.mjs';
import { paneReleaseEvents } from '../lib/retire-command.mjs';
import { exitFixture } from './helpers/retire-exit-fixture.mjs';
import { hold } from './helpers/retire-fixture.mjs';
import { parseOverride } from '../housekeeping/config.mjs';
import { planRetirement } from '../lib/retire.mjs';

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

test('native detail lookup releases a recorded session while an unnamed operator keeps its own tab', t => {
  const f = openFixture(t, { reviewer: true });
  f.state.tabs.push({ tab_id: 'w:operator', workspace_id: 'w' });
  f.state.panes.push({ pane_id: 'w:operator-pane', tab_id: 'w:operator', workspace_id: 'w' });
  f.state.agents.push({ name: null, agent_status: 'idle', pane_id: 'w:operator-pane', tab_id: 'w:operator', workspace_id: 'w', cwd: f.lane });
  f.state.unregisterOnExit = false; f.save();
  let detailReads = 0;
  const r = f.retirement({ command: (exe, args, options) => {
    if (exe === f.job.herdr && args[0] === 'pane' && args[1] === 'process-info' && args.at(-1) === 'w:operator-pane')
      return { status: 0, stdout: JSON.stringify({ result: { process_info: { shell_pid: 10,
        foreground_processes: [{ pid: 10, name: 'zsh' }], process_tree_complete: true,
        process_tree: [{ pid: 10, identity: 'operator-shell', state: 'S', command: '[zsh]' }] } } }) };
    if (exe === f.job.herdr && args[0] === 'agent' && args[1] === 'get') {
      assert.equal(args[2], 'worker', 'an unnamed operator is never a named native lookup target');
      detailReads++;
    }
    const result = spawnSync(exe, args, options);
    if (exe === f.job.herdr && args[0] === 'agent' && args[1] === 'list') {
      const summary = JSON.parse(result.stdout);
      for (const agent of summary.result.agents) delete agent.agent_session;
      result.stdout = JSON.stringify(summary);
    }
    return result;
  } });
  const plan = r.plan();
  assert.equal(plan.sessionReleases.length, 1);
  assert.match(plan.keep.find(row => row.tab_id === 'w:operator').why, /unnamed operator occupant/);
  const results = r.apply(plan);
  assert.ok(results.some(row => row.action === 'closed' && row.tab_id === 'w:t'), JSON.stringify(results));
  assert.ok(detailReads > 0);
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
  assert.deepEqual(f.read().tabs.map(tab => tab.tab_id), ['w:operator']);
  assert.equal(f.read().agents[0].name, null);
  assert.equal(fs.existsSync(f.lane), true);
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

test('NEEDS-WORK keeps the worker pending a bound successor or landed PASS', t => {
  assertKept(openFixture(t, { landed: true, verdict: 'NEEDS-WORK' }));
});

for (const verdict of ['NEEDS-WORK', 'FAIL']) test(`a recorded ${verdict} review run releases its idle reviewer`, t => {
  const f = openFixture(t, { reviewer: true, verdict }), r = f.retirement();
  if (verdict === 'FAIL') {
    const events = loadEvents(f.org).events;
    events[2].report.outcome = 'failed'; writeEvents(f, events);
  }
  assert.equal(r.plan().sessionReleases.length, 1);
  assert.ok(r.apply(r.plan()).some(row => row.action === 'closed'));
  assert.deepEqual(f.read().actions.slice(0, 2), [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
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
  assert.equal(f.retirement().plan().sessionReleases?.length, 1, 'a fresh successor is bound to its own native occupant');
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

for (const abandoned of [false, true]) test(`a ${abandoned ? 'record-superseded unreported' : 'reported'} worker exits after a fresh successor binds without a handoff`, t => {
  const f = openFixture(t), events = loadEvents(f.org).events.filter(e => !abandoned || e.run !== 'R-1');
  if (abandoned) events.push({ type: 'run.abandoned', id: 'R-1', note: 'superseded by fresh fix worker' });
  else events.find(e => e.type === 'report.ingested' && e.run === 'R-1').report.outcome = 'blocked';
  const meta = { ...events[1].meta, agent: 'successor', pane: 'w:q', terminal_id: 'next-terminal', agent_session_id: 'next-session' };
  events.push({ type: 'run.started', id: 'R-3', item: 'ENG-1', workspace: f.lane, meta });
  writeEvents(f, events);
  f.state.tabs.push({ tab_id: 'w:u', workspace_id: 'w' });
  f.state.panes.push({ pane_id: 'w:q', tab_id: 'w:u', workspace_id: 'w', terminal_id: 'next-terminal' });
  f.state.agents.push({ ...f.state.agents[0], name: 'successor', pane_id: 'w:q', tab_id: 'w:u', terminal_id: 'next-terminal',
    agent_session: { value: 'next-session' }, agent_status: 'working' });
  f.state.unregisterOnExit = false; f.save();
  const r = f.retirement(), plan = r.plan(f.lane), snapshot = r.observe(f.lane);
  assert.equal(plan.sessionReleases.length, 1); assert.equal(plan.sessionReleases[0].run, 'R-1');
  assert.match(plan.sessionReleases[0].opt.why, /bound successor R-3/);
  const changes = [
    s => { delete s.record.runs.find(r => r.id === 'R-3').meta.agent_session_id; },
    s => { s.record.runs.find(r => r.id === 'R-3').meta.pane = 'w:p'; },
    s => { s.record.runs.find(r => r.id === 'R-3').abandoned = { seq: 99 }; },
    s => { s.agents = s.agents.filter(a => a.name !== 'successor'); },
    s => { s.panes = s.panes.filter(p => p.pane_id !== 'w:q'); },
    s => { s.panes.find(p => p.pane_id === 'w:q').terminal_id = 'replacement'; },
    s => { s.agents.find(a => a.name === 'successor').agent_status = 'unknown'; },
    s => { s.record.runs.find(r => r.id === 'R-3').workspace = '/foreign/lane'; s.agents.find(a => a.name === 'successor').cwd = '/foreign/lane'; },
    s => { s.record.runs.push({ id: 'R-4', item: 'ENG-1', workspace: f.lane, started: { seq: 99 }, meta: {} }); },
    s => { const old = s.record.runs.find(r => r.id === 'R-1'); old.report = null; old.abandoned = null; },
  ];
  for (const change of changes) {
    const current = structuredClone(snapshot); change(current);
    assert.equal(planRetirement(current).sessionReleases?.length ?? 0, 0);
  }
  const result = r.apply(plan, f.lane);
  assert.ok(result.some(row => row.action === 'closed' && row.tab_id === 'w:t'), JSON.stringify(result));
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
  assert.deepEqual(f.read().agents.map(a => a.name), ['successor']);
  assert.equal(releaseEvents(f)[0].run, 'R-1');
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(fold(loadEvents(f.org).events).items.get('ENG-1').closed, null);
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

function settleReviewer(t, verdict = 'PASS') {
  const f = openFixture(t), events = loadEvents(f.org).events;
  events[1].meta = { ...events[1].meta, agent: 'original-worker', pane: 'w:original', terminal_id: 'other-terminal', agent_session_id: 'other-session' };
  writeEvents(f, events);
  // Scripted PID 2 lives until the fake native exit unregisters its occupant.
  const r = f.retirement({ readOwner: owner => f.read().info.process_tree.some(row => row.pid === owner.pid && row.identity === owner.identity),
    command: (exe, args, options) => {
      const result = spawnSync(exe, args, options);
      if (exe === f.job.herdr && args[0] === 'agent' && args[1] === 'list') {
        const summary = JSON.parse(result.stdout);
        for (const agent of summary.result.agents) delete agent.agent_session;
        result.stdout = JSON.stringify(summary);
      }
      return result;
    } });
  const callback = r.recordCallback({ kind: 'settle', pane: 'w:p', agent: 'worker', run: 'R-1' });
  assert.equal(callback.agent_session_id, 'session', 'agent get supplies the native session missing from agent list');
  const evidence = path.join(f.scratch, 'validated-review.md'), bytes = `**${verdict}**\nvalidated by lane review\n`;
  fs.writeFileSync(evidence, bytes);
  const eventBytes = fs.readFileSync(f.eventFile);
  r.recordReviewVerdict({ pane: 'w:p', run: 'R-1', verdict, head: f.head, evidence,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  assert.ok(fs.readFileSync(f.eventFile).length > eventBytes.length, 'reviewer completion is a structured record event');
  const verdictEvent = loadEvents(f.org).events.find(e => e.type === 'review.verdict');
  assert.equal(verdictEvent.review.session, 'session');
  assert.equal(verdictEvent.review.process.identity, 'native');
  assert.equal(verdictEvent.review.followup_expected, false);
  return { f, r };
}

for (const verdict of ['PASS', 'NEEDS-WORK', 'FAIL']) test(`a settle ${verdict} reviewer records its verdict and exits before closing independently of the worker`, t => {
  const { f, r } = settleReviewer(t, verdict);
  fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"release_sessions":false}');
  assertKept(f);
  fs.unlinkSync(path.join(f.repo, '.housekeeping.json'));
  const plan = r.plan(); assert.equal(plan.sessionReleases?.length, 1, JSON.stringify({ plan, callbacks: r.observe().callbacks }));
  assert.equal(plan.sessionReleases[0].opt.reviewer, true);
  const results = r.apply(plan);
  assert.ok(results.some(row => row.action === 'closed'), JSON.stringify(results));
  const release = releaseEvents(f)[0];
  assert.equal(release.recipient, 'reviewer'); assert.equal(release.agent, 'worker');
  assert.deepEqual(f.read().actions.slice(0, 2), [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
  assert.equal(fold(loadEvents(f.org).events).items.get('ENG-1').closed, null);
});

test('record pane-release --reviewer accepts the settle launch and verdict receipts', t => {
  const { f, r } = settleReviewer(t, 'NEEDS-WORK');
  const args = [fileURLToPath(new URL('../bin/org.mjs', import.meta.url)), 'pane-release', 'R-1', '--reviewer',
    '--session', 'session', '--terminal', 'term', '--pane', 'w:p', '--head', f.head,
    '--authority', 'fixture supervisor', '--next', 'successor worker', '--unresolved', 'review findings',
    '--evidence', 'validated-review.md', '--confirm', '--why', 'verdict recorded'];
  const result = spawnSync(process.execPath, args, { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(releaseEvents(f)[0].recipient, 'reviewer');
  assert.equal(r.plan().close[0].decision, 'exit');
  assert.ok(r.apply(r.plan()).some(row => row.action === 'closed'));
});

test('settle release preserves every identity, process and protection guard before recording a disposition', t => {
  const { f, r } = settleReviewer(t), snapshot = r.observe(), plan = r.plan();
  const changes = [
    s => { s.agents[0].agent_status = 'working'; },
    s => { s.panes[0].process_info.process_tree[1].identity = 'replacement'; s.panes[0].process_info.process_tree_raw[1].identity = 'replacement'; },
    s => { s.panes[0].process_info.process_tree[0].identity = 'replacement'; s.panes[0].process_info.process_tree_raw[0].identity = 'replacement'; },
    s => { s.panes[0].terminal_id = 'replacement'; },
    s => { s.agents[0].agent_session.value = 'replacement'; },
    s => { s.panes[0].process_info.process_tree_raw.push({ pid: 99, ppid: 1, identity: 'sibling', state: 'S', command: '[node]' }); },
    s => { s.tabs[0].focused = true; },
    s => { s.retirementHold = 'operator hold'; },
    s => { s.workspaces[0].persistent = true; },
    s => { s.references.push({ kind: 'live work', cwd: f.lane }); },
    s => { s.reviewVerdicts = []; },
  ];
  for (const change of changes) {
    const current = structuredClone(snapshot); change(current);
    const kept = planRetirement(current);
    assert.equal(kept.sessionReleases?.length ?? 0, 0, JSON.stringify(kept));
    assert.equal(kept.close.length, 0);
  }
  f.state.info.process_tree[1].identity = 'replacement'; f.save();
  assert.ok(r.apply(plan).some(row => row.action === 'release-kept'));
  assert.deepEqual(f.read().actions, []); assert.deepEqual(releaseEvents(f), []);
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
