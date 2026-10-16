import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detect, RULES, directShadow, route } from '../logs/rules.mjs';
import { logFixture, AT, at } from './helpers/log-fixture.mjs';

test('common blocker motivating shape requires two lanes, cause keys and the two-hour edge', t => {
  const f = logFixture(t), event = (n, lane, minutes = 0) => f.event(n, 'worker.observation', { validated: true, lane, causeKey: 'synthetic-slice-map', outcome: 'blocked' }, { occurredAt: at(minutes) });
  assert.equal(detect([event(1, 'a')]).length, 0);
  assert.equal(detect([event(1, 'a'), event(2, 'a')]).length, 0);
  assert.equal(detect([event(1, 'a'), event(2, 'b', 120.001)]).length, 0);
  const hit = detect([event(1, 'a'), event(2, 'b', 120)]).at(-1);
  assert.equal(hit.rule, 'common-blocker'); assert.equal(hit.path, 'triage'); assert.equal(hit.recurrence, 2);
  assert.equal(detect([event(1, 'a'), event(2, 'b'), event(2, 'b')]).length, 1);
  const bad = event(2, 'b'); delete bad.payload.causeKey;
  assert.equal(detect([event(1, 'a'), bad]).length, 0);
  bad.payload.causeKey = 'other'; assert.equal(detect([event(1, 'a'), bad]).length, 0);
});

test('stall edges, parked review, holds, contradictory evidence and stop-without-report twice', async t => {
  const f = logFixture(t), event = (n, minutes, evidence = {}) => f.event(n, 'worker.observation', { validated: true, process: 'idle', openRun: true, report: 'absent', idleSince: AT, ...evidence }, { run: 'R-1', occurredAt: at(minutes) });
  assert.equal(detect([event(1, 30)]).length, 0);
  assert.equal(detect([event(1, 30.001)]).at(-1).path, 'direct');
  assert.equal(detect([event(1, 90, { parkedReview: true })]).length, 0);
  assert.equal(detect([event(1, 90, { expectedHold: true })]).length, 0);
  assert.equal(detect([event(1, 90, { report: 'present' })]).at(-1).status, 'unknown');
  const stops = [event(1, 0, { process: 'stopped', attempt: 'first' }), event(2, 1, { process: 'stopped', attempt: 'second' })];
  assert.equal(detect(stops).filter(h => h.rule === 'stall').length, 2);
  for (const e of stops) await f.journal.append(e);
  await f.journal.append(stops[0]); await f.journal.reconcileDetectors();
  const state = await f.journal.read(); assert.equal(directShadow(state.entries).length, 2);
  assert.equal(state.entries.filter(e => e.type === 'detector.hit').length, 2);
  await f.journal.append(event(3, 120, { parkedReview: true }));
  assert.ok((await f.journal.read()).entries.some(e => e.eventId === 'fixture:3'), 'parked evidence retained');
});

test('resource motivating shape requires two distinct admission requests within one hour', t => {
  const f = logFixture(t), event = (n, minutes = 0, extra = {}) => f.event(n, 'resource.admission', { validated: true, admission: 'refused', resource: 'fixture-memory', causeKey: 'synthetic-admission', requestId: `request-${n}`, ...extra }, { occurredAt: at(minutes) });
  assert.equal(detect([event(1)]).length, 0);
  assert.equal(detect([event(1), event(2, 60.001)]).length, 0);
  assert.equal(detect([event(1), event(2, 60)]).at(-1).path, 'triage');
  assert.equal(detect([event(1), event(2, 1, { requestId: 'request-1' })]).length, 0);
  assert.equal(detect([event(1), event(2, 1, { causeKey: 'other' })]).length, 0);
});

test('review rounds and returning findings use stable chain evidence', t => {
  const f = logFixture(t), event = (n, round, findingKey) => f.event(n, 'review.round', { validated: true, round, reviewChain: 'chain', ...(findingKey ? { findingKey } : {}) });
  assert.equal(detect([event(1, 2)]).length, 0);
  assert.equal(detect([event(1, 3)]).at(-1).rule, 'review-loop');
  assert.equal(detect([event(1, 1, 'finding'), event(2, 1, 'finding')]).length, 0);
  assert.equal(detect([event(1, 1, 'finding'), event(2, 2, 'finding')]).at(-1).detail, 'stable finding returned in another review round');
  const other = event(2, 2, 'finding'); other.payload.reviewChain = 'other';
  assert.equal(detect([event(1, 1, 'finding'), other]).length, 0);
});

test('queue is strictly over sixty minutes; expected holds select interpretation', t => {
  const f = logFixture(t), event = (minutes, extra = {}) => f.event(1, 'queue.receipt', { validated: true, queueState: 'pending', jobId: 'job', pendingSince: AT, ...extra }, { occurredAt: at(minutes) });
  assert.equal(detect([event(60)]).length, 0);
  assert.equal(detect([event(60.001)]).at(-1).path, 'direct');
  assert.equal(detect([event(60.001, { expectedHold: true, holdOwner: 'fixture' })]).at(-1).path, 'triage');
  assert.equal(detect([event(90, { queueState: 'complete' })]).length, 0);
});

test('cost comparison requires usage and recorded compatible route baseline; unknown is never zero', t => {
  const f = logFixture(t), event = (value, baseline = { route: 'engineer', unit: 'tokens', usual: 100, ref: 'fixture-baseline/v1' }) => f.event(1, 'run.usage', { validated: true, route: 'engineer', usage: { value, unit: 'tokens' }, baseline });
  assert.equal(RULES.costSpike.baselineMultiplier, 2);
  assert.equal(detect([event(200)]).length, 0); assert.equal(detect([event(201)]).at(-1).status, 'hit');
  for (const baseline of [null, { route: 'engineer', unit: 'dollars', usual: 100, ref: 'fixture' }, { route: 'other', unit: 'tokens', usual: 100, ref: 'fixture' }]) assert.equal(detect([event(201, baseline)]).at(-1).status, 'unknown');
  const absent = event(0); delete absent.payload.usage;
  assert.equal(detect([absent]).at(-1).status, 'unknown');
  assert.equal(detect([event(0)]).length, 0);
});

test('detectors run after writer release, recover interrupted passes and keep one direct shadow line per condition', async t => {
  const f = logFixture(t), event = n => f.event(n, 'worker.observation', { validated: true, process: 'stopped', report: 'absent' }, { run: 'R-1' });
  await f.journal.appendRaw(event(1)); // crash between commit and evaluation
  const raw = f.journal.appendRaw.bind(f.journal);
  f.journal.appendRaw = async (...args) => {
    if (args[0].type === 'detector.hit') assert.equal(fs.existsSync(path.join(f.journal.directory, 'log-writer.lock')), false);
    return raw(...args);
  };
  await f.journal.append(event(1)); await f.journal.append(event(2)); await f.journal.append(event(2));
  const state = await f.journal.read(), hits = state.entries.filter(e => e.type === 'detector.hit');
  assert.equal(hits.length, 2); assert.equal(hits[1].payload.recurrence, 2);
  assert.equal(directShadow(state.entries).length, 1); assert.match(directShadow(state.entries)[0], /source=fixture#1 event=fixture:1/);
  assert.equal(route(hits[0]), 'telemetry');
  assert.equal(route(f.message(5, { channel: 'operational', outcome: 'progress' })), 'triage');
  const hold = f.message(6, { origin: 'operator' }); hold.payload.kind = 'hold'; assert.equal(route(hold), 'rule');
  assert.equal(route(f.event(7, 'controller.lifecycle', { kind: 'question' })), 'telemetry');
  assert.equal(detect([f.event(8, 'unknown.future', { validated: true, process: 'stopped', report: 'absent' }, { run: 'R-1' })]).length, 0);
});
