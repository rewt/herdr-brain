import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { report, setupOrg } from './helpers.mjs';
import { fold } from '../lib/state.mjs';
import { todayJson } from '../lib/today.mjs';

// America/Chicago is UTC-5 in September: the local day 2026-09-15 runs 05:00Z to 05:00Z.
const YESTERDAY = '2026-09-15T04:30:00Z';
const MORNING = '2026-09-15T14:00:00Z';
const NOW = '2026-09-15T21:00:00Z';

function busyOrg() {
  const t = setupOrg({ tz: 'America/Chicago' });
  const at = (now) => ({ now });
  t.ok(['add', '--goal', 'Theft fix shipped'], at(YESTERDAY));
  t.ok(['add', 'Implement the theft fix', '--parent', 'G-1', '--role', 'engineer', '--priority', '50'], at(YESTERDAY)); // ENG-1
  t.ok(['add', 'Review the theft fix', '--parent', 'G-1', '--role', 'reviewer', '--priority', '40', '--blocked-by', 'ENG-1'], at(YESTERDAY)); // REV-1
  t.ok(['add', 'Tidy the notes', '--parent', 'G-1', '--blocked-by', 'REV-1'], at(YESTERDAY)); // W-1, no priority
  t.ok(['add', 'Five-repository release map', '--parent', 'G-1', '--role', 'architect', '--priority', '30'], at(YESTERDAY)); // ARCH-1
  t.ok(['add', 'Old finished task', '--parent', 'G-1', '--role', 'engineer', '--priority', '10'], at(YESTERDAY)); // ENG-2
  t.ok(['block', 'W-1', '--by', 'ENG-2'], at(YESTERDAY));

  const ask = (title, extra, now = MORNING) => t.ok(['ask', title, '--parent', 'G-1', '--recommend', 'yes', '--why', `Why ${title}`, ...extra], at(now)).trim();
  assert.equal(ask('Adopt the theft fix?', ['--category', 'design', '--blocks', 'ENG-1', '--on-yes', 'Work starts.', '--on-no', 'Work stops.']), 'HUM-1');
  assert.equal(ask('Fund one test transaction?', ['--category', 'funds-and-chain', '--priority', '90']), 'HUM-2');
  assert.equal(ask('Install the storage tool?', ['--category', 'tooling', '--blocks', 'REV-1']), 'HUM-3');
  assert.equal(ask('Rename the goal?', ['--category', 'goals', '--blocks', 'W-1']), 'HUM-4');
  assert.equal(ask('Answered yesterday?', ['--category', 'design'], YESTERDAY), 'HUM-5');
  t.ok(['answer', 'HUM-5', 'yes'], at(YESTERDAY));
  assert.equal(ask('Publish the notes?', ['--category', 'publish']), 'HUM-6');
  t.ok(['answer', 'HUM-6', 'no', '--note', 'Not yet.'], at('2026-09-15T15:00:00Z'));

  t.ok(['note', 'ENG-1', '--decision', 'Old decision'], at(YESTERDAY));
  t.ok(['note', 'ENG-1', '--decision', '--summary', 'Skip the proof run', 'Skip per R-4 (deadbeef12)'], at('2026-09-15T16:09:00Z'));
  t.ok(['note', 'ENG-1', 'not a decision'], at('2026-09-15T16:10:00Z'));

  t.ok(['start', 'ARCH-1', '--harness', 'claude-code', '--model', 'claude-opus-5', '--effort', 'high', '--workspace', '/tmp/lane-release-map',
    '--meta', 'agent=lane-release-map', '--meta', 'lane=release-map'], at('2026-09-15T16:06:00Z')); // R-1
  t.ok(['start', 'ENG-2'], at(YESTERDAY)); // R-2
  fs.writeFileSync(path.join(t.dir, 'runs/R-2/report.md'), report('run: R-2\noutcome: done\nsummary: Finished.\nheadline: The old task is finished'));
  t.ok(['sync'], at('2026-09-15T16:14:00Z'));
  t.ok(['add', 'Dropped today', '--role', 'researcher'], at(YESTERDAY));
  t.ok(['close', 'RES-1', '--dropped', '--note', 'not needed'], at('2026-09-15T17:00:00Z'));
  return t;
}

test('org today --json builds the console read model deterministically', () => {
  const t = busyOrg();
  const run = () => t.ok(['today', '--json'], { now: NOW });
  const text = run();
  assert.equal(run(), text, 'same events, config and now give the same document');
  const doc = JSON.parse(text);

  assert.equal(doc.project.org, t.dir);
  assert.equal(doc.project.as_of, '2026-09-15T21:00:00.000Z');
  assert.equal(doc.project.day.start, '2026-09-15T05:00:00.000Z');
  assert.equal(doc.project.day.end, '2026-09-16T05:00:00.000Z');
  assert.equal(doc.project.day.date, '2026-09-15');
  assert.deepEqual(doc.project.item_prefixes, ['ARCH', 'ENG', 'G', 'HUM', 'RES', 'REV', 'W']);
  assert.equal(doc.project.open_stage, null, 'no goal carries stage_now, so no stage is open');
  assert.deepEqual(doc.project.top_goal, { id: 'G-1', title: 'Theft fix shipped' }, 'instructions to the project go on its top goal');

  // Ranked by prioritized work unblocked (transitively), then priority.
  assert.deepEqual(doc.waiting.map((w) => [w.id, w.unblocks_prioritized]), [
    ['HUM-1', 2], ['HUM-3', 1], ['HUM-2', 0], ['HUM-4', 0],
  ]);
  const first = doc.waiting[0];
  assert.deepEqual(first, {
    id: 'HUM-1', title: 'Adopt the theft fix?', status: 'ready', category: 'design', recommend: 'yes',
    why: 'Why Adopt the theft fix?', on_yes: 'Work starts.', on_no: 'Work stops.', memo: null, priority: null, stage: null,
    created: { at: MORNING.replace('Z', '.000Z'), by: 'human' },
    blocks: [{ id: 'ENG-1', title: 'Implement the theft fix' }],
    unblocks_prioritized: 2,
  });

  assert.deepEqual(doc.decided.map((d) => [d.kind, d.id]), [['note', 'ENG-1'], ['question', 'HUM-6']]);
  assert.deepEqual(doc.decided[0], {
    kind: 'note', id: 'ENG-1', seq: doc.decided[0].seq, title: 'Implement the theft fix',
    summary: 'Skip the proof run', text: 'Skip per R-4 (deadbeef12)', at: '2026-09-15T16:09:00.000Z', by: 'human',
  });
  assert.equal(doc.decided[1].answer, 'no');
  assert.equal(doc.decided[1].answered_by, 'human');
  assert.equal(doc.decided[1].overruled, false);
  assert.equal(doc.decided[1].note, 'Not yet.');
  assert.equal(doc.decided[1].recommend, 'yes');

  assert.equal(doc.running.length, 1);
  assert.deepEqual({ ...doc.running[0], brief_path: path.basename(doc.running[0].brief_path) }, {
    run: 'R-1', item: 'ARCH-1', title: 'Five-repository release map', role: 'architect',
    started: '2026-09-15T16:06:00.000Z', agent: 'lane-release-map', lane: 'release-map',
    harness: 'claude-code', model: 'claude-opus-5', effort: 'high', workspace: '/tmp/lane-release-map', round: 1,
    brief_path: 'brief.md', report_path: path.join(t.dir, 'runs/R-1/report.md'),
  });

  assert.deepEqual(doc.finished.map((f) => [f.kind, f.item]), [['closed', 'RES-1'], ['report', 'ENG-2']]);
  assert.equal(doc.finished[1].headline, 'The old task is finished');
  assert.equal(doc.finished[1].report_file, path.join(t.dir, 'reports/R-2.md'));
  assert.equal(doc.finished[0].as, 'dropped');

  assert.equal(doc.approvals.policy.default, 'ask');
  assert.equal(doc.approvals.policy.categories.design, 'ask');
  assert.deepEqual(doc.approvals.counts.design, { answered: 1, answered_as_recommended: 1, overruled: 0, auto: 0 });
  assert.deepEqual(doc.approvals.counts.publish, { answered: 1, answered_as_recommended: 0, overruled: 0, auto: 0 });
  assert.deepEqual(doc.attention.map((a) => [a.id, a.kind]), [['G-1', 'budget']]);
});

test('org today distinguishes historical abandoned reports from newer-run late reports', () => {
  const events = [
    { type: 'item.added', id: 'ENG-1', title: 'Historical reports' },
    { type: 'run.started', id: 'R-1', item: 'ENG-1' },
    { type: 'run.abandoned', id: 'R-1' },
    { type: 'run.started', id: 'R-2', item: 'ENG-1' },
    { type: 'run.started', id: 'R-3', item: 'ENG-1' },
    { type: 'report.ingested', run: 'R-3', report: { outcome: 'done' }, file: 'R-3.md' },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'failed' }, file: 'R-2.md' },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'failed' }, file: 'R-1.md', late: true },
  ].map((event, index) => ({ ...event, seq: index + 1, at: MORNING, by: 'test' }));
  const doc = todayJson(fold(events), { now: new Date(NOW), orgDir: '/tmp/org', config: {} });
  assert.deepEqual(doc.finished.map(({ run, late, abandoned }) => ({ run, late, abandoned })), [
    { run: 'R-1', late: true, abandoned: true },
    { run: 'R-2', late: true, abandoned: false },
    { run: 'R-3', late: false, abandoned: false },
  ]);
});

test('org today follows the local day of TZ', () => {
  const t = busyOrg();
  // In UTC, 04:30Z is already 2026-09-15, so yesterday's decision and answer count as today.
  const utc = JSON.parse(t.ok(['today', '--json'], { now: NOW, env: { TZ: 'UTC' } }));
  assert.equal(utc.project.day.start, '2026-09-15T00:00:00.000Z');
  assert.deepEqual(utc.decided.map((d) => d.id), ['ENG-1', 'HUM-6', 'ENG-1', 'HUM-5']);
});

test('org today prints plain text with codes only in parentheses', () => {
  const t = busyOrg();
  const text = t.ok(['today'], { now: NOW });
  assert.match(text, /WAITING ON YOU \(4\)\n {2}Adopt the theft fix\? · design · recommend: yes · unblocks 2 \(HUM-1\)\n/);
  assert.match(text, /DECIDED TODAY \(2\)\n {2}11:09 {2}Skip the proof run · by human \(ENG-1\)\n {2}10:00 {2}Publish the notes\? → no · by human \(HUM-6\)/);
  assert.match(text, /RUNNING \(1\)\n {2}Five-repository release map · architect · since 11:06 · lane-release-map \(R-1\)/);
  assert.match(text, /FINISHED TODAY \(2\)\n {2}12:00 {2}Dropped today · dropped \(RES-1\)\n {2}11:14 {2}The old task is finished \(R-2\)/);
  for (const line of text.split('\n').filter((l) => l.startsWith('  '))) {
    assert.doesNotMatch(line.replace(/\([^)]*\)$/, ''), /\b[A-Z]+-\d+\b/, line);
  }
});

test('org today --json names the latest run of each agent, finished runs included, so a front end can name idle agents', () => {
  const t = setupOrg();
  const at = (now) => ({ now });
  t.ok(['add', 'Build the console', '--role', 'engineer'], at('2026-09-10T10:00:00Z')); // ENG-1
  const start = (agent, now, extra = []) => t.ok(['start', 'ENG-1', '--harness', 'claude-code', '--model', 'opus', '--effort', 'high',
    '--meta', `agent=${agent}`, '--meta', 'lane=brain-console', ...extra], at(now));
  const finish = (run, now) => {
    fs.writeFileSync(path.join(t.dir, `runs/${run}/report.md`), report(`run: ${run}\noutcome: done\nsummary: Done.`));
    t.ok(['sync'], at(now));
  };
  start('lane-a', '2026-09-10T11:00:00Z'); // R-1
  finish('R-1', '2026-09-10T12:00:00Z');
  start('lane-b', '2026-09-11T11:00:00Z'); // R-2
  finish('R-2', '2026-09-11T12:00:00Z');
  start('lane-b', '2026-09-12T11:00:00Z'); // R-3: the same agent again
  finish('R-3', '2026-09-12T12:00:00Z');
  t.ok(['add', 'Untracked work'], at('2026-09-12T13:00:00Z'));
  t.ok(['start', 'W-1'], at('2026-09-12T13:00:00Z')); // R-4: no agent
  start('lane-c', '2026-09-12T14:00:00Z'); // R-5: still open

  const doc = JSON.parse(t.ok(['today', '--json'], { now: '2026-09-12T15:00:00Z' }));
  assert.deepEqual(doc.running.map((r) => r.run), ['R-4', 'R-5']);
  assert.deepEqual(doc.agent_runs.map((r) => [r.agent, r.run, r.lane, r.round, r.model]), [
    ['lane-b', 'R-3', 'brain-console', 3, 'opus'],
    ['lane-a', 'R-1', 'brain-console', 1, 'opus'],
  ]);
  assert.equal(doc.agent_runs[0].started, '2026-09-12T11:00:00.000Z');
  assert.equal(path.basename(doc.agent_runs[0].brief_path), 'brief.md');
  // Reading it writes nothing.
  const events = doc.project.events;
  assert.equal(JSON.parse(t.ok(['today', '--json'], { now: '2026-09-12T15:00:00Z' })).project.events, events);
});

test('org today says which stage is open and which stage each question belongs to', () => {
  const t = busyOrg();
  t.ok(['set', 'G-1', 'meta.stage_now=1'], { now: NOW });
  t.ok(['set', 'HUM-2', 'meta.stage=4'], { now: NOW });
  t.ok(['set', 'HUM-3', 'meta.stage=parked'], { now: NOW });
  const doc = JSON.parse(t.ok(['today', '--json'], { now: NOW }));
  assert.equal(String(doc.project.open_stage), '1');
  const stage = Object.fromEntries(doc.waiting.map((w) => [w.id, w.stage]));
  assert.equal(String(stage['HUM-2']), '4');
  assert.equal(stage['HUM-3'], 'parked');
  assert.equal(stage['HUM-1'], null, 'a question with no stage says so');
});
