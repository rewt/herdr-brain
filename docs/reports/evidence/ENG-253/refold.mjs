// Read-only record comparison. Run with ORG_DIR set; stdout is the evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fold, itemStatus } from '../../../../lib/state.mjs';
import { loadEvents } from '../../../../lib/store.mjs';

assert.ok(process.env.ORG_DIR, 'Set ORG_DIR explicitly to the record to inspect');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const baseline = process.argv[2] ?? 'f84602d4';
const source = spawnSync('git', ['show', `${baseline}:lib/state.mjs`], { cwd: root, encoding: 'utf8' });
assert.equal(source.status, 0, source.stderr);
const baselineSource = source.stdout.replace("'./discernment.mjs'",
  JSON.stringify(new URL('../../../../lib/discernment.mjs', import.meta.url).href));
const { fold: previousFold, itemStatus: previousStatus } = await import(
  `data:text/javascript;base64,${Buffer.from(baselineSource).toString('base64')}`);
const { events, tornTail } = loadEvents(process.env.ORG_DIR);
assert.equal(tornTail, false, 'Compare a complete event-log snapshot');
const previous = previousFold(events);
const current = fold(events);
const outcomeChanges = [];
const lateChanges = [];
for (const [id, item] of current.items) {
  const oldItem = previous.items.get(id);
  assert.deepEqual({ ...item, outcome: null }, { ...oldItem, outcome: null });
  if (JSON.stringify(item.outcome) === JSON.stringify(oldItem.outcome)) continue;
  const oldRun = current.runs.get(oldItem.outcome?.run);
  const newRun = current.runs.get(item.outcome?.run);
  assert.ok(oldRun && newRun, `${id}: both outcomes must have reported runs`);
  assert.ok(oldRun.started.seq < newRun.started.seq, `${id}: only newer starts may take ownership`);
  assert.ok(oldRun.report.seq > newRun.report.seq, `${id}: only out-of-order reports may change ownership`);
  outcomeChanges.push({ item: id, before: oldItem.outcome, after: item.outcome,
    status_before: previousStatus(previous, id), status_after: itemStatus(current, id) });
}
for (const [id, run] of current.runs) {
  const oldRun = previous.runs.get(id);
  if (run.report?.late !== oldRun.report?.late) {
    assert.equal(run.report.late, true);
    const newer = current.items.get(run.item).runs.map((runId) => current.runs.get(runId))
      .filter((other) => other.started.seq > run.started.seq && other.report?.seq < run.report.seq);
    assert.ok(newer.length, `${id}: late marking needs an already ingested newer run`);
    lateChanges.push({ item: run.item, run: id, newer_reported_runs: newer.map((other) => other.id) });
  }
  assert.deepEqual(run.report ? { ...run, report: { ...run.report, late: false } } : run,
    oldRun.report ? { ...oldRun, report: { ...oldRun.report, late: false } } : oldRun);
}
assert.deepEqual({ ...current, items: null, runs: null }, { ...previous, items: null, runs: null });
console.log(JSON.stringify({ record: process.env.ORG_DIR, baseline,
  events: events.length, last_seq: events.at(-1)?.seq,
  snapshot_sha256: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
  items: current.items.size, runs: current.runs.size,
  outcome_changes: outcomeChanges, late_changes: lateChanges,
  other_fold_fields_unchanged: true,
}, null, 2));
