// Reinterpret the immutable ENG-1049 installed witness with this new projection.
// This does not replay native input or claim a new installed/live acceptance.
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fold } from '../lib/state.mjs';
import { loadRecordReader } from '../lib/store.mjs';
import { obligationId, obligationPending, obligationInventory } from '../lib/obligations.mjs';

const source = process.env.OBLIGATION_CYCLE_EVIDENCE, destination = process.env.OBLIGATION_EVIDENCE;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('obligation projection consumes the recorded installed original review after folder removal and retains the uncertain attempt', { skip: !source }, t => {
  const evidence = path.join(source, 'evidence'), org = path.join(source, 'project/.org');
  const bytes = fs.readFileSync(path.join(org, 'events.jsonl')), stages = JSON.parse(fs.readFileSync(path.join(evidence, 'stages.json')));
  const facts = bytes.toString().trim().split('\n').map(JSON.parse), producer = stages.find(s => s.name === 'dispatch'),
    review = stages.find(s => s.name === 'original-review'), unknown = stages.find(s => s.name === 'uncertain-retained');
  assert.equal(stages.find(s => s.name === 'producer-cleanup').folderRemoved, true);
  assert.equal(review.producerFolderAbsent, true); assert.equal(unknown.attempts, 1); assert.equal(unknown.prompts, 1);
  const journal = path.join(org, 'dispatch', path.basename(unknown.journal)), original = fs.readFileSync(journal), job = JSON.parse(original);
  assert.equal(job.stage, 'prompting');
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obligation-installed-record-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  fs.writeFileSync(path.join(scratch, 'events.jsonl'), bytes);
  const started = performance.now(), reader = loadRecordReader(scratch);
  let inventory;
  try {
    const row = reader.state.obligations.get(obligationId('review-handoff', producer.run));
    assert.ok(row); assert.equal(row.queues.length, 1); assert.equal(row.outcome.result.review_item, review.item);
    assert.equal(row.queues[0].target.head, review.head); assert.equal(row.queues[0].target.base, review.base);
    assert.equal(obligationPending(row), false); assert.equal(row.landings.length, 1);
    const originalLanding = facts.find(e => e.type === 'change.landed' && e.run === producer.run);
    // The installed predecessor predates the typed dispatch-source field. Keep
    // its real null/legacy binding and native producer, never enrich history.
    assert.deepEqual(row.landings[0].binding, originalLanding.source ?? null);
    assert.deepEqual(row.landings[0].producer, originalLanding.producer);
    assert.equal(row.landings[0].source.seq, originalLanding.seq);
    const request = reader.state.obligations.get(obligationId('dispatch-outcome', unknown.run, job.token, unknown.journal));
    assert.ok(request); assert.equal(request.attempt, job.token); assert.equal(request.journal, unknown.journal);
    assert.equal(request.outcome.result.exit_code, 1); assert.equal(request.outcome.result.failure.code, job.failure.code);
    assert.ok([...reader.state.obligations.values()].some(r => r.kind === 'unsupported' && r.attempt === job.token && r.journal === unknown.journal && obligationPending(r)));
    assert.deepEqual(new Map(reader.state.obligations), fold(facts).obligations);
    inventory = obligationInventory(reader.state, { position: reader.position }); reader.verify();
  } finally { reader.close(); }
  assert.deepEqual(fs.readFileSync(journal), original); assert.deepEqual(fs.readFileSync(path.join(org, 'events.jsonl')), bytes);
  const result = { schema: 'obligation-recorded-cycle/v1', source, source_sha256: sha(bytes), original_journal_sha256: sha(original),
    producer, review, unknown, projection_ms: performance.now() - started, inventory,
    limits: 'New projection over the immutable installed predecessor record, not a new installed run or live acceptance. Original native input was not replayed.' };
  if (destination) { fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, 'recorded-cycle.json'), JSON.stringify(result, null, 2) + '\n'); }
  t.diagnostic(JSON.stringify({ source_sha256: result.source_sha256, counts: inventory.counts, projection_ms: result.projection_ms }));
});

const record = process.env.OBLIGATION_RECORD;
test('obligation inventory accounts for each pending source kind in the captured project record', { skip: !record }, t => {
  const started = performance.now(), reader = loadRecordReader(record);
  try {
    const inventory = obligationInventory(reader.state, { position: reader.position });
    reader.verify();
    assert.equal(new Set(inventory.rows.map(row => row.id)).size, inventory.rows.length);
    for (const row of inventory.rows) {
      assert.ok(row.source.seq > 0); assert.ok(row.source.type); assert.ok(row.stuck_owner);
      if (!row.pending) continue;
      if (row.supported) { assert.ok(row.consumer); assert.ok(row.wake.length); }
      else assert.ok(row.diagnosis);
    }
    const result = { ...inventory, projection_ms: performance.now() - started, source_sha256: sha(fs.readFileSync(path.join(record, 'events.jsonl'))) };
    if (destination) { fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, 'inventory.json'), JSON.stringify(result, null, 2) + '\n'); }
    t.diagnostic(JSON.stringify({ source_sha256: result.source_sha256, counts: result.counts, projection_ms: result.projection_ms }));
  } finally { reader.close(); }
});
