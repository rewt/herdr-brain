import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFeedReader, reportFeed, noticeEntries, noticeFields, trainFacts } from '../modern/feed.mjs';

test('notice delivery includes explicit autopilot handling without claiming a sent prompt', () => {
  const events = [{ type: 'notice', id: 'promotion', message: '[promote-queue] id=j outcome=promoted' },
    { type: 'autopilot', id: 'promotion', result: { disposition: 'handled' } }];
  assert.equal(noticeEntries(events)[0].delivery, 'handled');
});

const at = n => new Date(Date.UTC(2026, 9, 4, 17, n)).toISOString();
const report = (id, n, outcome = 'done') => ({ id, item: 'ENG-1', report: { at: at(n), outcome, headline: `Headline ${id}` } });
const notice = (id, n, message) => ({ type: 'notice', id, at: at(n), message });

test('feed uses record headlines and explicit watch checks, newest first including closed items', () => {
  const runs = [report('R-1', 1), report('R-2', 2, 'blocked'), report('R-3', 3)];
  const status = { runs, items: [{ id: 'ENG-1', runs: ['R-1', 'R-2', 'R-3'], closed: {} }] };
  const journal = [notice('old', 0, '[watch-blocked] run=R-1 item=ENG-1'),
    notice('final', 1, '[org-report] run=R-1 item=ENG-1 check=pass headline="Journal text is not the headline"')];
  const result = reportFeed(status, journal);
  assert.deepEqual(result.map(r => [r.run, r.outcome, r.check]), [['R-3', 'done', 'unknown'], ['R-2', 'blocked', 'unknown'], ['R-1', 'done', 'pass']]);
  assert.equal(result[2].headline, 'Headline R-1');
  assert.ok(result.every(r => !r.attention));
});

test('watch exceptions are deduplicated, readable after delivery, and superseded by final ingestion', () => {
  const journal = [notice('blocked', 1, '[watch-blocked] run=R-1 item=ENG-1'),
    notice('invalid', 2, '[watch-invalid-report] run=R-1 item=ENG-1 check=fail error="bad \\"quote\\" and outcome"'),
    { type: 'sending', id: 'invalid' }, { type: 'sent', id: 'invalid' },
    notice('missing', 3, '[watch-no-report] run=R-2 item=ENG-2 state=done'),
    notice('other', 4, '[unrelated] run=R-3 item=ENG-3'),
    notice('final', 5, '[org-report] run=R-4 item=ENG-4 outcome=done check=pass headline="Ready to ingest"')];
  const result = reportFeed({ runs: [] }, journal);
  assert.deepEqual(result.map(r => r.outcome), ['awaiting ingest', 'no report', 'invalid']);
  assert.equal(result[2].headline, 'bad "quote" and outcome');
  assert.equal(result[2].delivery, 'sent'); assert.equal(result[2].attention, true);
  assert.equal(reportFeed({ runs: [report('R-1', 6)] }, journal).filter(r => r.run === 'R-1').length, 1);
  assert.equal(noticeEntries(journal).filter(n => n.id === 'invalid').length, 1);
  assert.equal(noticeFields('unstructured text'), null);
});

test('recent feed is bounded but keeps unresolved exceptions and drops superseded attention', () => {
  const runs = Array.from({ length: 20 }, (_, n) => ({ ...report(`R-${n}`, n, n === 0 ? 'blocked' : 'done'), item: `ENG-${n}` }));
  const result = reportFeed({ runs });
  assert.equal(result.length, 9); assert.equal(result.at(-1).attention, true);
  const resolved = reportFeed({ runs, items: [{ id: 'ENG-0', runs: ['R-0', 'R-99'] }] });
  assert.equal(resolved.length, 8);
});

test('train merges queue and receipts, shows waiting, active CI and interrupted work without invented clocks', () => {
  const batches = [{ id: 'b', created_at: at(1), jobs: [{ id: 'old', topic: 'old' }], command: 'npm run ci', log: '/train.log',
    attempts: [{ phase: 'prepared', jobs: [{ topic: 'one' }, { topic: 'two' }] }],
    results: { old: { outcome: 'refused', reason: 'red', gate: { finished_at: at(2) } } } }];
  const queue = { pending: [{ topic: 'next' }], current: { id: 'b', phase: 'batching', jobs: [{ topic: 'one' }] },
    interrupted: [{ jobs: [{ topic: 'held' }] }], results: [{ id: 'new', topic: 'new', outcome: 'promoted', finished: at(3) }] };
  const facts = trainFacts(queue, batches);
  assert.deepEqual(facts.current.lanes, ['one', 'two']); assert.equal(facts.current.command, 'npm run ci');
  assert.equal(facts.current.started, at(1)); assert.equal(facts.current.checkStarted, null);
  assert.equal(facts.waiting[0].topic, 'next'); assert.equal(facts.interrupted.length, 1);
  assert.deepEqual(facts.results.map(r => [r.topic, r.outcome]), [['new', 'promoted'], ['old', 'refused']]);
  assert.equal(facts.results[1].log, '/train.log');
});

test('optional read sources are cached, reject wrong identities and malformed lines, ignore only a torn journal tail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-feed-'));
  try {
    const project = { org: path.join(root, 'org'), git: true, repoKey: path.join(root, '.git') };
    const reader = createFeedReader();
    assert.deepEqual(reader.journal(project), []); assert.equal(reader.train(project).current, null);
    assert.deepEqual(fs.readdirSync(root), []);
    fs.mkdirSync(path.join(project.org, 'supervisor'), { recursive: true });
    const inbox = path.join(project.org, 'supervisor/inbox.log');
    fs.writeFileSync(inbox, JSON.stringify(notice('n', 0, '[watch-blocked] run=R-1 item=ENG-1')) + '\n{"partial":');
    const first = reader.journal(project); assert.equal(first.length, 1); assert.equal(reader.journal(project), first);
    fs.writeFileSync(inbox, 'broken\n'); assert.throws(() => reader.journal(project), SyntaxError);
    const dir = path.join(project.repoKey, 'promote'), receipt = path.join(dir, 'batches/b/train.json');
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    const queue = path.join(dir, 'queue.json');
    fs.writeFileSync(queue, JSON.stringify({ identity: '/foreign', current: null }));
    assert.throws(() => reader.train(project), /identity/);
    fs.writeFileSync(queue, JSON.stringify({ identity: project.repoKey, current: { id: 'b', phase: 'batching', jobs: [{ topic: 'one' }] } }));
    fs.writeFileSync(receipt, JSON.stringify({ id: 'b', identity: project.repoKey, attempts: [{ phase: 'prepared' }] }));
    fs.writeFileSync(path.join(path.dirname(receipt), 'train.log'), 'validating in /scratch: node test/check.mjs\n');
    const facts = reader.train(project); assert.equal(facts.current.command, 'node test/check.mjs'); assert.ok(facts.current.started);
    assert.equal(facts.current.checkStarted, null);
    fs.writeFileSync(receipt, '{'); assert.throws(() => reader.train(project), SyntaxError);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a final resumed receipt wins over an older interrupted queue row, before and after delivery', () => {
  for (const outcome of ['promoted', 'refused']) {
    const batches = [{ id: 'batch', jobs: [{ id: 'job', topic: 'lane' }], results: { job: { outcome, integrated_at: at(3), reason: 'final' } } }];
    const stale = { id: 'job', topic: 'lane', outcome: 'interrupted', finished: at(1) };
    assert.equal(trainFacts({ results: [stale] }, batches).results[0].outcome, outcome);
    const delivered = { id: 'job', outcome, finished: at(4), delivered: true };
    const result = trainFacts({ results: [stale, delivered] }, batches).results;
    assert.equal(result.length, 1); assert.equal(result[0].outcome, outcome); assert.equal(result[0].at, at(4));
  }
});

test('batch start survives atomic receipt replacement and honours explicit timestamps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-train-clock-'));
  try {
    const repoKey = path.join(root, '.git'), directory = path.join(repoKey, 'promote/batches/b');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'train.json'), queue = path.join(repoKey, 'promote/queue.json');
    const value = { id: 'b', identity: repoKey, attempts: [{ phase: 'prepared' }] };
    fs.writeFileSync(file, JSON.stringify(value));
    fs.writeFileSync(queue, JSON.stringify({ identity: repoKey, current: { id: 'b', phase: 'batching', jobs: [{ topic: 'one' }] } }));
    let revision = 1;
    const fsApi = { ...fs, statSync(p) {
      const st = fs.statSync(p);
      if (p === file) return { ...st, mtimeMs: revision * 1000, birthtimeMs: revision * 1000 };
      if (p === directory) return { ...st, birthtimeMs: Date.parse(at(1)) };
      return st;
    } };
    const reader = createFeedReader({ fsApi }), project = { repoKey, git: true };
    assert.equal(reader.train(project).current.started, at(1));
    const replacement = path.join(directory, 'next.json');
    fs.writeFileSync(replacement, JSON.stringify(value)); fs.renameSync(replacement, file); revision++;
    assert.equal(reader.train(project).current.started, at(1));
    fs.writeFileSync(file, JSON.stringify({ ...value, created_at: at(2) })); revision++;
    assert.equal(reader.train(project).current.started, at(2));
    fs.writeFileSync(file, JSON.stringify({ ...value, started_at: at(3), created_at: at(2) })); revision++;
    assert.equal(reader.train(project).current.started, at(3));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('train projection carries finished check clocks and durations during delivery', () => {
  const gate = { command: 'node check', started_at: at(1), finished_at: at(3), duration_s: 120, exit_code: 0 };
  const result = trainFacts({ current: { id: 'b', phase: 'batch-delivering' } }, [{ id: 'b', attempts: [{ gate }] }]).current;
  assert.equal(result.checkFinished, at(3)); assert.equal(result.checkDurationSeconds, 120); assert.equal(result.checkComplete, true);
});
