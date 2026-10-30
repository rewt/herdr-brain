import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fold } from '../lib/state.mjs';

const source = process.env.RECORD_READER_MEASURE_SOURCE;
const evidence = process.env.RECORD_READER_MEASURE_OUTPUT;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function measure(mode, dir, ids, { group = true, verify = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./helpers/record-reader-worker.mjs', import.meta.url), [mode, dir, JSON.stringify(ids), group ? 'parent' : 'leaf', String(verify)],
      { execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, HERDR_MONITOR_FLEET: path.join(dir, 'no-fleet.json') } });
    let stderr = '', pids = [child.pid], peak = 0, samples = 0, result;
    child.stderr.on('data', bytes => { stderr += bytes; });
    const timer = setInterval(() => {
      try {
        const rows = execFileSync('/bin/ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
        const rss = rows.reduce((a, b) => a + b, 0) * 1024;
        if (Number.isFinite(rss)) { peak = Math.max(peak, rss); samples++; }
      } catch { /* Process startup/exit races do not imply a zero sample. */ }
    }, 20);
    child.on('error', error => { clearInterval(timer); reject(error); });
    child.on('message', message => {
      if (message.kind === 'pids') { pids = message.pids; return; }
      const readers = message.readers ?? [message];
      result = { readers, reader_count: readers.length, sampled_peak_rss_bytes: peak, rss_samples: samples,
        aggregate_idle_rss_bytes: readers.reduce((sum, r) => sum + r.idle_rss_bytes, 0),
        sum_process_high_water_rss_bytes: readers.reduce((sum, r) => sum + r.high_water_rss_bytes, 0),
        median_read_ms: median(readers.flatMap(r => r.read_ms)) };
      clearInterval(timer); child.disconnect();
    });
    child.on('exit', code => { clearInterval(timer); if (code || !result) reject(Error(`measurement failed: ${code}: ${stderr}`)); else resolve(result); });
  });
}

test('aggregate compact readers on real history and an equivalent-facts larger history meet the recorded target', { skip: !source || !evidence }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'record-reader-measure-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fleet = process.env.HERDR_MONITOR_FLEET;
  process.env.HERDR_MONITOR_FLEET = path.join(root, 'no-fleet.json');
  t.after(() => { if (fleet === undefined) delete process.env.HERDR_MONITOR_FLEET; else process.env.HERDR_MONITOR_FLEET = fleet; });
  const original = fs.readFileSync(source, 'utf8').trimEnd().split('\n').filter(line => line.trim()).map(JSON.parse);
  const state = fold(original);
  const ids = [...state.items.values()].filter(item => !item.closed && item.kind === 'work').slice(-5).map(item => item.id);
  assert.ok(ids.length, 'real active work is required');
  // Replay archived real payloads BEFORE their original creation/reset events.
  // These four event types leave no global receipt/binding/link side effects;
  // the original log then resets every subject. Both corpora have exactly the
  // same folded facts, except the intentionally larger event count.
  const resettable = new Set(['item.added', 'run.started', 'note.added', 'report.ingested']);
  const prelude = original.filter(e => resettable.has(e.type));
  const encode = rows => rows.map(e => JSON.stringify(e) + '\n').join('');
  const cases = [{ name: 'captured-project-history', rows: original },
    { name: 'expanded-real-payload-history', rows: [...prelude.map((e, i) => ({ ...e, seq: i - prelude.length })), ...original] }];
  const report = { schema: 'record-reader-measure/v1', node: process.version, source, source_sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
    active_subjects: ids, target: { aggregate_idle_ratio: 0.60, aggregate_peak_ratio: 0.60, median_latency_ratio: 1.25 },
    topology: 'one parent reader plus two simultaneous transient command readers; no watchers or finished sessions; test coordinator/runner excluded',
    method: 'three opens per warm reader, retained exact selected facts; forced GC between opens; 20ms external aggregate RSS samples plus sum of individual process high-water marks (conservative, not simultaneous). Cold single reader rebuild/fact-and-history verification measured separately. Expanded corpus replays real historical payloads then original log; not a live production census.', cases: [] };
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  try {
    let expectedFacts;
    for (const c of cases) {
      const dir = path.join(root, c.name); fs.mkdirSync(dir);
      const text = encode(c.rows); fs.writeFileSync(path.join(dir, 'events.jsonl'), text);
      const coldLegacy = await measure('legacy', dir, ids, { group: false, verify: true });
      const coldCompact = await measure('compact', dir, ids, { group: false, verify: true });
      const a = coldLegacy.readers[0], b = coldCompact.readers[0];
      assert.equal(b.all_facts, a.all_facts, 'every folded field agrees with full replay');
      assert.equal(b.events, a.events, 'every historical event agrees');
      if (expectedFacts) assert.equal(b.all_facts, expectedFacts, 'both sizes retain identical current facts and active work');
      expectedFacts = b.all_facts;
      const legacy = await measure('legacy', dir, ids), compact = await measure('compact', dir, ids);
      assert.equal(legacy.reader_count, 3); assert.equal(compact.reader_count, 3);
      assert.ok([...legacy.readers, ...compact.readers].every(r => r.facts === a.facts));
      const ratios = { idle: compact.aggregate_idle_rss_bytes / legacy.aggregate_idle_rss_bytes,
        peak: compact.sum_process_high_water_rss_bytes / legacy.sum_process_high_water_rss_bytes,
        sampled_peak: compact.sampled_peak_rss_bytes / legacy.sampled_peak_rss_bytes,
        latency: compact.median_read_ms / legacy.median_read_ms };
      report.cases.push({ name: c.name, bytes: Buffer.byteLength(text), events: c.rows.length, current_facts_sha256: b.all_facts,
        cold_legacy: coldLegacy, cold_compact: coldCompact, legacy, compact, ratios });
    }
    // Preserve both witnesses, including a target miss, before asserting.
    for (const c of report.cases) {
      assert.ok(c.ratios.idle <= 0.60, `${c.name} idle ratio ${c.ratios.idle}`);
      assert.ok(c.ratios.peak <= 0.60, `${c.name} conservative peak ratio ${c.ratios.peak}`);
      assert.ok(c.ratios.latency <= 1.25, `${c.name} latency ratio ${c.ratios.latency}`);
    }
  } finally { fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n'); }
});
