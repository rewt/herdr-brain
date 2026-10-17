import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, isolatedEnv, hold, assertNoRemoval } from './helpers/retire-fixture.mjs';
import { createHousekeeping } from '../housekeeping/housekeeping.mjs';
import { noticeIdleRetirement } from '../housekeeping/retirement-notices.mjs';
import { requestRetirement } from '../lib/retire-trigger.mjs';
import { readRetirementStatus, readRetirementWorktrees } from '../lib/retire-runtime.mjs';
import { retirementStatus, renderRetirementStatus } from '../lib/retire-status.mjs';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { planRetirement } from '../lib/retire.mjs';
import { enqueueSupervisor, readInbox } from '../supervisor/prompt-supervisor.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const saveEvents = (f, events) => fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
function runner(t, f) {
  isolatedEnv(t, f);
  const logs = [], calls = [];
  const run = createHousekeeping({ cwd: f.repo, org: f.org, herdr: f.job.herdr, selfTab: null,
    log: entry => logs.push(entry), command(exe, args, options) {
      calls.push([exe, args]); return spawnSync(exe, args, { ...options, env: { ...options.env, ...f.env } });
    } });
  return { tick: extra => run.tick({ cleanup: false, resume: false, ...extra }), logs, calls };
}

test('housekeeping coalesces requests before cleanup is due and retains a request written during apply', t => {
  const f = fixture(t), r = runner(t, f);
  for (const eventSeq of [2, 3, 4]) requestRetirement({ org: f.org, eventSeq, source: 'many completions' });
  f.state.triggerOnClose = true; f.save();
  r.tick({ cleanup: true });
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
  assert.equal(r.logs.filter(e => e.action === 'retirement-consumed').length, 1);
  assert.equal(r.logs.filter(e => e.action === 'closed').length, 1);
  assert.equal(read(path.join(f.org, 'retirement/handled.json')).revision, 4);
  assert.equal(read(path.join(f.org, 'retirement/request.json')).revision, 5);
  r.tick();
  assert.equal(read(path.join(f.org, 'retirement/handled.json')).revision, 5);
  const before = r.calls.length;
  r.tick();
  // Only the normal recovery/status observation remains after acknowledgement.
  assert.equal(r.calls.slice(before).filter(([exe, a]) => exe === f.job.herdr && a[0] === 'workspace').length, 1);
  assert.equal(r.logs.filter(e => e.action === 'retirement-consumed').length, 2);
});

test('housekeeping HOLD keeps the request pending, and dry-run never acknowledges or closes', t => {
  const f = fixture(t), removeHold = hold(f), r = runner(t, f);
  requestRetirement({ org: f.org, eventSeq: 4, source: 'held completion' });
  r.tick(); r.tick();
  assertNoRemoval(f);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/handled.json')), false);
  const held = r.logs.filter(e => e.action === 'retirement-consumed');
  assert.equal(held.length, 2); assert.ok(held.every(e => e.pending && !e.handled));
  removeHold();
  r.tick({ dryRun: true }); assertNoRemoval(f);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/handled.json')), false);
  r.tick(); assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

test('a non-cleanup housekeeping tick prunes an absent callback receipt', t => {
  const f = fixture(t), r = runner(t, f), file = path.join(f.org, 'retirement/occupants/absent.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 'retirement-occupant/v1', kind: 'watcher', common: f.common,
    cwd: f.lane, workspace: 'w', tab: 'absent:t', pane: 'absent:p',
    shell: { pid: 1, identity: 'shell', command: '[zsh]' }, process: { pid: 2, identity: 'watcher', command: '[node]' } }));
  r.tick();
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(f.read().actions, []);
});

test('an old duplicate trigger consumed after tab reuse cannot close its new occupant', t => {
  const f = fixture(t), r = runner(t, f);
  requestRetirement({ org: f.org, eventSeq: 4, source: 'old completion' });
  f.state.agents[0] = { ...f.state.agents[0], terminal_id: 'new-terminal', agent_session: { value: 'new-session' }, agent_status: 'done' };
  f.save();
  requestRetirement({ org: f.org, eventSeq: 4, source: 'duplicate old completion' });
  r.tick(); assertNoRemoval(f);
  assert.equal(read(path.join(f.org, 'retirement/handled.json')).revision, 4);
  assert.match(r.logs.find(e => e.action === 'retirement-consumed').keep[0].why, /launch identity/);
});

for (const mode of ['report on disk', 'ingest', 'sync', 'wrong identity', 'stale release']) {
  test(`housekeeping preserves pending or mismatched work: ${mode}`, t => {
    const f = fixture(t), r = runner(t, f);
    let events = loadEvents(f.org).events;
    if (mode === 'wrong identity') { f.state.agents[0].terminal_id = 'replacement'; f.save(); }
    else {
      events = events.filter(e => e.type !== 'item.closed');
      if (['report on disk', 'ingest', 'sync'].includes(mode)) {
        events = events.filter(e => e.type !== 'report.ingested');
        const report = path.join(f.scratch, 'report.md');
        events.find(e => e.type === 'run.started').report_path = report;
        fs.writeFileSync(report, '---\nrun: R-1\noutcome: done\nsummary: Report awaiting chain completion.\n---\n');
      }
      if (mode === 'stale release') events.push({ type: 'retirement.release', seq: 4, at: '2026-01-01T01:00:00Z',
        run: 'R-1', confirmed: true, pane: 'w:p', terminal: 'term', session: 'session', workspace: 'w', cwd: f.lane, head: '0'.repeat(40) });
      saveEvents(f, events);
    }
    if (['ingest', 'sync'].includes(mode)) {
      const args = [path.join(root, 'bin/org.mjs'), mode, ...(mode === 'ingest' ? [path.join(f.scratch, 'report.md')] : [])];
      const result = spawnSync(process.execPath, args, { cwd: f.repo, env: f.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(read(path.join(f.org, 'retirement/request.json')).event_seq, loadEvents(f.org).events.at(-1).seq);
    } else requestRetirement({ org: f.org, eventSeq: events.at(-1).seq, source: mode });
    r.tick(); assertNoRemoval(f);
    const receipt = read(path.join(f.org, 'retirement/handled.json'));
    assert.equal(receipt.results.length, 0);
    assert.match(receipt.keep[0].why, /report is not ingested|chain is still open|launch identity|stale: head moved/);
  });
}

test('terminal age follows the event transition, advances with the clock, and never writes state', t => {
  const f = fixture(t), snapshot = f.retirement().observe(), before = fs.readFileSync(f.eventFile);
  const now = '2026-01-01T01:00:00Z';
  const status = retirementStatus(snapshot, { generatedAt: now });
  assert.equal(planRetirement(snapshot).token, planRetirement({ ...snapshot, events: [] }).token, 'display history never changes executor identity');
  const tab = status.rows.find(r => r.type === 'tab');
  assert.equal(tab.terminalAt, '2026-01-01T00:00:00Z'); assert.equal(tab.terminalAgeMs, 3600000);
  const later = retirementStatus(snapshot, { generatedAt: '2026-01-01T02:00:00Z' });
  assert.equal(later.rows[0].terminalAgeMs, 7200000);
  const noted = [...snapshot.events, { type: 'note.added', id: 'ENG-1', seq: 5, at: now, text: 'Unrelated later note' }];
  assert.equal(retirementStatus({ ...snapshot, events: noted, record: fold(noted) }, { generatedAt: now }).rows[0].terminalAt, tab.terminalAt);
  assert.match(renderRetirementStatus(status), /Terminal age/);
  assert.match(renderRetirementStatus(status, { markdown: true }), /TERMINAL older than 30 minutes: 2/);
  assert.deepEqual(fs.readFileSync(f.eventFile), before);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement')), false);
  const events = [...snapshot.events, { type: 'item.reopened', id: 'ENG-1', seq: 5, at: now }];
  const open = { ...snapshot, events, record: fold(events) };
  assert.equal(retirementStatus(open, { generatedAt: now }).rows[0].terminalAgeMs, null);
  events.push({ type: 'item.closed', id: 'ENG-1', as: 'done', seq: 6, at: now });
  assert.equal(retirementStatus({ ...snapshot, events, record: fold(events) }, { generatedAt: now }).rows[0].terminalAgeMs, 0);
});

test('final report ingestion, a review PASS, reconciliation close and exact pane release determine age', t => {
  const f = fixture(t), s = f.retirement().observe(), base = s.events.slice(0, 2);
  const at = '2026-01-01T01:00:00Z', now = '2026-01-01T02:00:00Z';
  const check = (events, extra = {}) => {
    const status = retirementStatus({ ...s, ...extra, events, record: fold(events) }, { generatedAt: now });
    assert.equal(status.rows[0].terminalAt, at);
  };
  check([...base, { ...s.events[3], seq: 3 }, { ...s.events[2], seq: 4, at }]);
  check([...s.events, { type: 'item.added', id: 'REV-1', parent: 'ENG-1', role: 'reviewer', seq: 5 },
    { type: 'run.started', id: 'R-2', item: 'REV-1', seq: 6 },
    { type: 'report.ingested', run: 'R-2', seq: 7, at, report: { outcome: 'done', extra: { verdict: 'PASS' } } }]);
  check([...s.events.slice(0, 3), { ...s.events[3], at },
    { type: 'promotion.reconciled', seq: 5, at, items: ['ENG-1'], runs: ['R-1'] }]);
  const release = { type: 'retirement.release', seq: 4, at, run: 'R-1', confirmed: true,
    pane: 'w:p', terminal: 'term', session: 'session', workspace: 'w', cwd: f.lane, head: f.head };
  check([...s.events.slice(0, 3), release], { releases: [release] });
  const wrong = { ...release, session: 'other' };
  const open = s.events.slice(0, 3);
  assert.equal(retirementStatus({ ...s, events: open, record: fold(open), releases: [wrong] }).rows[0].terminalAt, null);
});

test('idle notice is coalesced, durable across restarts, resets on occupant change and never edits events', t => {
  const f = fixture(t), snapshot = f.retirement().observe(), events = snapshot.events.filter(e => e.type !== 'item.closed');
  events.push({ ...events[1], id: 'R-2', seq: 4, at: '2026-01-01T00:01:00Z', meta: {
    ...events[1].meta, agent: 'successor', pane: 'next:p', agent_session_id: 'next-session' } });
  snapshot.record = fold(events); snapshot.events = events;
  const stateDir = path.join(f.scratch, 'housekeeping'), notices = [], logs = [], before = fs.readFileSync(f.eventFile);
  const options = { snapshot, stateDir, cwd: f.repo, org: f.org, herdr: f.job.herdr,
    enqueue: (to, message, options) => {
      notices.push({ to, message, ...options }); return enqueueSupervisor(to, message, { ...options, mirror: () => {} });
    }, log: e => logs.push(e) };
  const tick = (at, extra = {}) => noticeIdleRetirement({ ...options, status: retirementStatus(snapshot, { generatedAt: at }), ...extra });
  tick('2026-01-01T01:00:00Z'); tick('2026-01-02T01:00:00Z'); assert.equal(notices.length, 0);
  tick('2026-01-02T01:00:01Z', { dryRun: true }); assert.equal(notices.length, 0);
  tick('2026-01-02T01:00:01Z'); tick('2026-01-03T01:00:01Z');
  assert.equal(notices.length, 1); assert.match(notices[0].message, /record pane-release R-1 --session 'session' --terminal 'term' --pane 'w:p'/);
  const inbox = readInbox(path.join(f.org, 'supervisor/inbox.log'));
  assert.equal(inbox.length, 1); assert.equal(inbox[0].id, notices[0].id);
  assert.match(notices[0].message, new RegExp(f.head));
  assert.equal(logs.filter(e => e.action === 'retirement-notice').length, 1);
  const md = renderRetirementStatus(retirementStatus(snapshot), { markdown: true });
  assert.match(md, /IDLE-NONTERMINAL w:p: supervisor/); assert.match(md, /--evidence/);
  snapshot.agents[0].state_change_seq++;
  tick('2026-01-04T01:00:01Z'); assert.equal(notices.length, 1);
  tick('2026-01-05T01:00:02Z'); assert.equal(notices.length, 2);
  // Legacy terminal-only identity cannot use pane-release. The notice names
  // the guarded archive-tag lane close instead of inventing a native session.
  delete snapshot.agents[0].agent_session;
  delete snapshot.record.runs.get('R-1').meta.agent_session_id;
  tick('2026-01-06T01:00:02Z'); tick('2026-01-07T01:00:03Z');
  assert.equal(notices.length, 3); assert.match(notices[2].message, /lane close 'topic'/);
  assert.deepEqual(fs.readFileSync(f.eventFile), before);
});

test('an idle row lacking release identity logs its hold once and notifies once across ticks', t => {
  const f = fixture(t), stateDir = path.join(f.scratch, 'held-notice'), logs = [], notices = [];
  const row = { type: 'tab', class: 'IDLE-NONTERMINAL', workspace: 'w', tab: 'w:t', run: 'R-1', lane: 'topic',
    reason: 'review, correction or integration chain is still open', nextActor: 'supervisor', recommendation: null };
  const tick = (generatedAt, extra = {}) => noticeIdleRetirement({ status: { generatedAt, rows: [row] },
    snapshot: { common: f.common, agents: f.state.agents }, stateDir, log: entry => logs.push(entry),
    enqueue: (_to, message, options) => { notices.push(message); return { id: options.id }; }, ...extra });
  tick('2026-01-01T00:00:00Z');
  tick('2026-01-02T00:00:01Z', { dryRun: true });
  assert.equal(logs.filter(row => row.action === 'retirement-notice-held').length, 0);
  assert.equal(notices.length, 0);
  // A failed enqueue must not repeat the held log, but must remain retryable.
  assert.throws(() => tick('2026-01-02T00:00:01Z', { enqueue: () => { throw Error('enqueue unavailable'); } }), /enqueue unavailable/);
  for (const generatedAt of ['2026-01-02T00:00:02Z', '2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z']) tick(generatedAt);
  assert.equal(logs.filter(row => row.action === 'retirement-notice-held').length, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /lane topic/); assert.match(notices[0], /exact release identity unavailable/);
  const [receipt] = Object.values(read(path.join(stateDir, 'retirement-notices.json')));
  assert.equal(receipt.held, true); assert.ok(receipt.sent);
});

test('missing/prunable worktrees retain their own reason, lane and canonical owner without pruning', async t => {
  const f = fixture(t), stale = path.join(f.scratch, 'stale');
  f.git(['worktree', 'add', '-b', 'lane/stale', stale]); fs.rmSync(stale, { recursive: true });
  const before = f.git(['worktree', 'list', '--porcelain']);
  const trees = readRetirementWorktrees(f.common, { main: 'main', env: f.env });
  assert.equal(trees.length, 3); assert.equal(trees.filter(r => r.error).length, 1);
  const status = await readRetirementStatus({ cwd: f.repo, org: f.org, herdr: f.job.herdr, env: f.env });
  const row = status.rows.find(r => r.worktree === stale);
  assert.equal(row.type, 'worktree'); assert.equal(row.stale, true); assert.equal(row.identity, f.common);
  assert.equal(row.lane, 'stale'); assert.match(row.reason, /prunable worktree|missing worktree/);
  assert.equal(status.rows.find(r => r.type === 'tab').class, 'TERMINAL');
  assert.equal(status.rows.filter(r => r.type === 'diagnostic').length, 0);
  assert.equal(f.git(['worktree', 'list', '--porcelain']), before);
  assert.deepEqual(f.read().actions, []);
});
