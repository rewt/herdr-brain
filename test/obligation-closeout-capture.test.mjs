// One read-only rebuild of the producer's immutable record for REV-290's Major.
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fold } from '../lib/state.mjs';
import { obligationInventory } from '../lib/obligations.mjs';

const source = process.env.OBLIGATION_CORRECTION_RECORD;
const destination = process.env.OBLIGATION_EVIDENCE;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('closeout correction rebuild releases at least the 429 completed captured waits and preserves original attempts', { skip: !source }, t => {
  const bytes = fs.readFileSync(source), digest = sha(bytes);
  assert.equal(digest, 'd3cc1946b86170bdeac07267c6852a28a2224866d9e64d09dd5bdb84a329f1dd');
  const events = bytes.toString().trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 47408);
  const previous = JSON.parse(fs.readFileSync(path.resolve(path.dirname(source), '../controls-1/inventory.json')));
  const started = performance.now(), inventory = obligationInventory(fold(events), { now: Date.parse(events.at(-1).at) });
  const byId = new Map(inventory.rows.map(row => [row.id, row]));
  const oldWaits = previous.counts['closeout-wait'];
  assert.equal(oldWaits.pending, 972);
  const released = oldWaits.pending - inventory.counts['closeout-wait'].pending;
  assert.ok(released >= 429, `Only ${released} of at least 429 completed waits released`);
  assert.equal(inventory.counts['closeout-wait'].total, oldWaits.total);
  for (const old of previous.rows) {
    const row = byId.get(old.id);
    assert.ok(row, old.id);
    assert.deepEqual(row.source, old.source);
    if (old.kind === 'closeout-wait') {
      assert.deepEqual(row.waiting, old.waiting);
      assert.deepEqual(row.statuses.map(({ verified, ...status }) => status), old.statuses.map(({ verified, ...status }) => status));
      if (!row.pending) {
        assert.equal(row.outcome.result.parent_closeout.completed, true);
        assert.ok(row.waiting.producers.every(p => row.statuses.some(s => JSON.stringify(s.producer) === JSON.stringify(p) && s.verified && s.status === 'complete')));
      } else { assert.equal(row.supported, false); assert.ok(row.diagnosis); }
    }
    if (old.kind === 'native-outcome') {
      assert.deepEqual(row.original, old.original); assert.equal(row.attempt, old.attempt);
      assert.deepEqual(row.outcome, old.outcome);
    }
  }
  const observations = {
    source, source_sha256: digest, events: events.length, projection_ms: performance.now() - started,
    closeout_wait: { before: oldWaits, after: inventory.counts['closeout-wait'], released },
    superseded_reports: inventory.rows.filter(r => r.kind === 'report-intake' && r.superseded_by).length,
    historical_source_completions: inventory.rows.filter(r => r.kind === 'source-completion' && r.pending && r.historical_close && !r.supported).length,
    completed_unsupported_review_handoffs: inventory.rows.filter(r => r.kind === 'review-handoff' && !r.pending && !r.supported).length,
    limits: 'Immutable captured projection only; no native attempt, installed/live acceptance, release coverage or scheduling latency measured.',
  };
  if (destination) {
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'inventory.json'), JSON.stringify({ ...inventory, source_sha256: digest }, null, 2) + '\n');
    fs.writeFileSync(path.join(destination, 'capture-observations.json'), JSON.stringify(observations, null, 2) + '\n');
  }
  assert.equal(sha(fs.readFileSync(source)), digest);
  t.diagnostic(JSON.stringify(observations));
});
