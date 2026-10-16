import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ShadowJournal } from '../messages/journal.mjs';
import { shadowInput, recordInput, replay } from '../logs/inputs.mjs';
import { measure, selectEntries, render, coalesce } from '../logs/view.mjs';
import { LogJournal } from '../logs/journal.mjs';
import { productFiles } from '../lib/product-files.mjs';
import { logFixture, AT, at } from './helpers/log-fixture.mjs';

const cli = path.resolve(import.meta.dirname, '../logs/logs.mjs');
function run(f, args) {
  return spawnSync(process.execPath, [cli, ...args, '--identity', f.scope.identity, '--common-dir', f.commonDir], { cwd: f.root, encoding: 'utf8' });
}
function recordFixture(f) {
  const org = path.join(f.root, 'record'); fs.mkdirSync(org);
  const lines = [
    { seq: 1, at: AT, by: 'fixture', type: 'item.added', id: 'ENG-1', title: 'Synthetic', role: 'engineer' },
    { seq: 2, at: AT, by: 'fixture', type: 'run.started', id: 'R-1', item: 'ENG-1', report_path: '/does/not/exist/report.md', brief_path: '/does/not/exist/brief.md' },
    { seq: 3, at: AT, by: 'fixture', type: 'note.added', id: 'ENG-1', text: 'Unselected private note must never enter the mirror' },
    { seq: 4, at: AT, by: 'fixture', type: 'report.ingested', run: 'R-1', file: '/does/not/exist/report.md', sha256: 'a'.repeat(64), report: { run: 'R-1', outcome: 'blocked', summary: 'Do not copy record prose', blockers: ['not copied'] } },
    { seq: 5, at: AT, by: 'fixture', type: 'watch.receipt', run: 'R-1', item: 'ENG-1', receipt: { channel: 'watch-no-report', process: 'stopped', report: 'absent' } },
    { seq: 6, at: AT, by: 'fixture', type: 'review.verdict', run: 'R-1', item: 'ENG-1', verdict: 'NEEDS-WORK' },
  ];
  const file = path.join(org, 'events.jsonl'); fs.writeFileSync(file, lines.map(JSON.stringify).join('\n') + '\n');
  return { org, file, before: fs.readFileSync(file) };
}

test('foreground replay reads accepted shadow entries and selected folded record fields; stable counts-only JSON', async t => {
  const f = logFixture(t), shadowRoot = path.join(f.root, 'shadow'), shadow = new ShadowJournal({ ...f.scope, root: shadowRoot });
  const q = f.message(1, { channel: 'operational', outcome: 'progress' }); q.payload.kind = 'question';
  await shadow.append(q); await shadow.append(q);
  await assert.rejects(shadow.append({ ...q, payload: { ...q.payload, summary: 'Conflicting synthetic input' } }), /conflicting/);
  const parked = f.event(2, 'worker.observation', { validated: true, state: 'ParkedAwaitingReview', process: 'idle', openRun: true, report: 'absent', idleSince: at(-90) }, { run: 'R-2' });
  await shadow.append(parked);
  const record = recordFixture(f), sourceBefore = fs.readFileSync(path.join(shadow.directory, 'shadow.jsonl'));
  const args = ['replay', '--root', f.scope.root, '--from-shadow', '--shadow-root', shadowRoot, '--from-record', '--org', record.org, '--json'];
  const first = run(f, args); assert.equal(first.status, 0, first.stderr);
  const summary = JSON.parse(first.stdout);
  assert.equal(summary.schema, 'brain.logs-report/v1'); assert.equal(summary.events, 7);
  assert.equal(summary.byType['detector.hit'], 1); assert.equal(summary.directShadowLines, 1);
  assert.equal(summary.wouldRoute.direct, 4); assert.equal(summary.wouldRoute.telemetry, 2);
  assert.equal(summary.byType['session.message.v1'], 1);
  const second = run(f, args); assert.equal(second.status, 0, second.stderr); assert.equal(second.stdout, first.stdout);
  assert.deepEqual(fs.readFileSync(record.file), record.before); assert.deepEqual(fs.readFileSync(path.join(shadow.directory, 'shadow.jsonl')), sourceBefore);
  const events = (await f.journal.read()).entries;
  assert.equal(events.some(e => JSON.stringify(e).includes('Do not copy')), false);
  assert.equal(events.some(e => JSON.stringify(e).includes('Unselected private')), false);
  assert.ok(events.some(e => e.payload.reportRef === '/does/not/exist/report.md'));
  assert.equal(fs.existsSync('/does/not/exist/report.md'), false);
  const third = run(f, args.filter(a => a !== '--json')); assert.equal(third.status, 0, third.stderr);
  assert.equal(third.stdout.split('\n').filter(line => line.startsWith('[log-shadow]')).length, 1);
  assert.ok(productFiles(path.resolve(import.meta.dirname, '..')).includes('logs/logs.mjs'));
});

test('replay reports source loss once without changing a torn input or following body paths', async t => {
  const f = logFixture(t), shadowRoot = path.join(f.root, 'shadow'), shadow = new ShadowJournal({ ...f.scope, root: shadowRoot });
  const message = f.message(1, { channel: 'operational', outcome: 'progress' });
  message.payload.body_ref = { path: '/unreadable/must-not-open', bytes: 4, sha256: 'b'.repeat(64), mediaType: 'text/plain' };
  await shadow.append(message);
  const file = path.join(shadow.directory, 'shadow.jsonl'); fs.appendFileSync(file, '{torn');
  const before = fs.readFileSync(file), input = await shadowInput({ ...f.scope, root: shadowRoot });
  assert.equal(input.gaps.length, 1); await replay(f.journal, [input]); await replay(f.journal, [input]);
  assert.equal(measure(await f.journal.read()).sourceGaps, 1); assert.deepEqual(fs.readFileSync(file), before);
  const record = recordFixture(f); fs.appendFileSync(record.file, '{torn');
  const read = await recordInput({ ...f.scope, org: record.org }); assert.equal(read.gaps.length, 1);
});

test('view filters time, workspace and session, includes linked detector hits and is read-only', async t => {
  const f = logFixture(t);
  await f.journal.append(f.event(1, 'worker.observation', { validated: true, process: 'stopped', report: 'absent' }, { run: 'R-1', sessionUid: 'a', incarnation: 'one', workspaceUid: 'w-a' }));
  await f.journal.append(f.event(2, 'herdr.observation', {}, { sessionUid: 'b', incarnation: 'one', workspaceUid: 'w-b', occurredAt: at(1) }));
  const state = await f.journal.read(), before = fs.readdirSync(f.journal.directory);
  const selected = selectEntries(state.entries, { session: 'a', workspace: 'w-a', since: AT });
  assert.equal(selected.length, 2); assert.equal(selected[1].type, 'detector.hit'); assert.match(render(selected), /stall\/v1 hit recurrence=1/);
  assert.equal(selectEntries(state.entries, { since: at(2) }).length, 0);
  assert.throws(() => selectEntries(state.entries, { since: 'yesterday' }), /UTC/);
  const result = run(f, ['view', '--root', f.scope.root, '--session', 'a', '--workspace', 'w-a', '--since', AT, '--json']);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).length, 2);
  assert.deepEqual(fs.readdirSync(f.journal.directory), before);
  const fresh = path.join(f.root, 'no-output'); assert.equal(run(f, ['view', '--root', fresh]).status, 0); assert.equal(fs.existsSync(fresh), false);
});

test('progress annotations preserve originals and record exact sequence ranges in five-second windows', async t => {
  const f = logFixture(t);
  for (let n = 1; n <= 3; n++) await f.journal.append(f.message(n, { channel: 'operational', outcome: 'progress' }, { occurredAt: new Date(Date.parse(AT) + n * 1000).toISOString() }));
  const control = f.message(4, { channel: 'operational', outcome: 'progress' }); control.payload.kind = 'hold'; await f.journal.append(control);
  assert.equal(await coalesce(f.journal), 1); assert.equal(await coalesce(f.journal), 0);
  const state = await f.journal.read(), annotations = state.entries.filter(e => e.type === 'service.events.coalesced');
  assert.equal(annotations[0].payload.count, 3); assert.deepEqual(annotations[0].payload.sequenceRanges, [[1, 3]]);
  assert.equal(state.entries.filter(e => e.type === 'session.message.v1').length, 4);
  const summary = measure(state); assert.equal(summary.coalesced, 3); assert.equal(summary.byPath.rule, 1);
  await f.journal.append(f.message(5, { channel: 'operational', outcome: 'progress' }));
  assert.equal(await coalesce(f.journal), 0, 'a late single source does not recount the original group');
  await f.journal.append(f.message(6, { channel: 'operational', outcome: 'progress' }));
  assert.equal(await coalesce(f.journal), 1); assert.equal(measure(await f.journal.read()).coalesced, 5);
});

test('measurement uses a sliding burst and viewer escapes inert control characters', async t => {
  const f = logFixture(t);
  await f.journal.append(f.event(1, 'unknown.future', { summary: '\u001b[31m\nsynthetic' }, { occurredAt: '2026-10-16T12:00:00.900Z' }));
  await f.journal.append(f.event(2, 'unknown.future', {}, { occurredAt: '2026-10-16T12:00:01.100Z' }));
  const state = await f.journal.read(), summary = measure(state);
  assert.equal(summary.maximumBurst.events, 2); assert.equal(summary.wouldRoute.unknown, 2);
  assert.equal(render(state.entries).split('\n').length, 3); assert.match(render(state.entries), /\\u001b/);
});

test('CLI refuses implicit mutation roots, loops, input/root collisions and arbitrary unknown flags', t => {
  const f = logFixture(t);
  for (const args of [['replay', '--from-shadow'], ['repair'], ['retain'], ['coalesce'], ['view', '--follow'], ['replay', '--root', f.scope.root], ['replay', '--root', f.scope.root, '--from-record']]) assert.equal(run(f, args).status, 1);
  const record = recordFixture(f);
  const result = run(f, ['replay', '--root', record.org, '--from-record', '--org', record.org]); assert.equal(result.status, 1); assert.match(result.stderr, /separate from the record/);
  assert.deepEqual(fs.readFileSync(record.file), record.before);
  assert.equal(fs.existsSync(f.scope.root), false);
});
