#!/usr/bin/env node
// Read-only run timing view. The train's separate receipts remain in promote/metrics.mjs.
import { isMain } from '../lib/cli-help.mjs';
import { findOrgDir, loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { timingEvent, waitKinds } from '../lib/run-timing.mjs';

function splitWait(events, kind) {
  let entry = null, seconds = 0, entries = 0, grants = 0, stopped = 0, failed = 0, invalid = false;
  for (const event of events.filter(e => e.kind === kind)) {
    if (event.outcome === 'entry') {
      if (entry !== null) invalid = true;
      entry = Date.parse(event.at); entries++;
    } else {
      const end = Date.parse(event.at);
      if (entry === null || end < entry) invalid = true;
      else seconds += (end - entry) / 1000;
      entry = null;
      if (event.outcome === 'granted') grants++;
      if (event.outcome === 'stopped') stopped++;
      if (event.outcome === 'failed') failed++;
    }
  }
  const pending = entry !== null;
  return { seconds: entries && grants && !pending && !invalid ? seconds : null, entries, grants, stopped, failed, pending, invalid };
}
const summarize = values => {
  const sorted = values.filter(v => v !== null).sort((a, b) => a - b), n = sorted.length;
  return { samples: n, missing: values.length - n, total: n ? sorted.reduce((a, b) => a + b, 0) : null,
    median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    max: n ? sorted[n - 1] : null };
};
const bound = value => {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T.*(?:Z|[+-]\d{2}:\d{2})$)/.test(value) || !Number.isFinite(Date.parse(value))) throw Error('window requires an ISO date or timestamp with timezone');
  return Date.parse(value);
};

export function runMetrics(runs, { since, until } = {}) {
  const lower = bound(since), upper = bound(until);
  if (lower !== null && upper !== null && lower >= upper) throw Error('--since must precede --until');
  let invalidMetadata = 0, missingStart = 0;
  const rows = [];
  for (const run of runs) {
    const start = Date.parse(run.started?.at);
    if (!Number.isFinite(start)) { missingStart++; if (lower !== null || upper !== null) continue; }
    if (lower !== null && start < lower || upper !== null && start >= upper) continue;
    let events = [], end = null, invalid = false;
    const matches = e => e.run === run.id && e.item === run.item && e.lane === (run.meta?.lane ?? null);
    try {
      if (run.meta?.dispatch_waits) {
        const raw = JSON.parse(run.meta.dispatch_waits);
        if (!Array.isArray(raw)) throw Error('invalid waits');
        events = raw.map(timingEvent);
        if (!events.every(e => matches(e) && waitKinds.includes(e.kind))) throw Error('foreign wait metadata');
      }
    } catch { invalid = true; events = []; }
    try {
      if (run.meta?.process_end) {
        end = timingEvent(JSON.parse(run.meta.process_end));
        if (!matches(end) || end.kind !== 'process_end' || Number.isFinite(start) && Date.parse(end.at) < start) throw Error('invalid process end');
      }
    } catch { invalid = true; end = null; }
    const waits = Object.fromEntries(waitKinds.map(kind => [kind, splitWait(events, kind)]));
    invalid ||= Object.values(waits).some(w => w.invalid);
    if (invalid) invalidMetadata++;
    const totals = Object.values(waits).map(w => w.seconds);
    rows.push({ run: run.id, item: run.item,
      lane: /^[a-z0-9][a-z0-9-]{1,60}$/.test(run.meta?.lane ?? '') ? run.meta.lane : null,
      waits, dispatch_wait_s: totals.every(t => t !== null) ? totals.reduce((a, b) => a + b, 0) : null,
      process_end: end, process_end_after_run_start_s: end && Number.isFinite(start) ? (Date.parse(end.at) - start) / 1000 : null });
  }
  return { schema: 'run-timing-metrics/v1', window: { since: since ?? null, until: until ?? null, basis: 'run started.at; lower inclusive, upper exclusive' },
    summary: { runs: rows.length, invalid_metadata: invalidMetadata, missing_run_start: missingStart,
      waits_s: Object.fromEntries(waitKinds.map(kind => [kind, summarize(rows.map(r => r.waits[kind].seconds))])),
      dispatch_wait_s: summarize(rows.map(r => r.dispatch_wait_s)),
      process_end_missing: rows.filter(r => !r.process_end).length,
      process_end_after_run_start_s: summarize(rows.map(r => r.process_end_after_run_start_s)) }, runs: rows,
    limitations: [
      'All record runs in the window are counted, including legacy and manual runs; missing clocks are null, never zero.',
      'Memory gates include the probe and any pressure wait. Resolved stopped/failed attempts are included after a later grant; unfinished gates remain missing.',
      'The project session cap and recovery locks refuse. The final admission lock waits up to 60000 ms (scaled by loadTimeout); admission_lock measures that acquisition, including immediate grants. There is no fleet session limit or capacity wait clock. Reused workers do not acquire this lock and have no admission_lock sample.',
      'Process end is watch\'s idle/done/gone terminal decision after startup and idle report grace or with a valid report; later observed work lets the next terminal decision supersede it. Unavailable/blocked states are excluded. It is not report time or an OS exit timestamp.',
      'Run start precedes worker launch; process_end_after_run_start_s includes the worker memory gate and setup.',
      'Train slot and prepare splits are reported by promote/metrics.mjs from train receipts.',
    ] };
}

export function collectRunMetrics({ org = findOrgDir(), ...options } = {}) {
  if (!org) throw Error('a record is required: --org DIR or ORG_DIR');
  const { events, tornTail } = loadEvents(org);
  return { ...runMetrics([...fold(events).runs.values()], options), torn_record_tail: tornTail };
}
export function renderRunMetrics(data) {
  const s = data.summary, seconds = v => v === null ? 'unavailable' : `${v.toFixed(3)}s`;
  const lines = [`Run timing: ${s.runs} runs; ${s.invalid_metadata} invalid metadata; ${s.process_end_missing} missing process ends`];
  for (const [kind, values] of Object.entries({ ...s.waits_s, dispatch_total: s.dispatch_wait_s, process_end_after_run_start: s.process_end_after_run_start_s })) {
    lines.push(`${kind}: median ${seconds(values.median)}; total ${seconds(values.total)}; ${values.samples} measured; ${values.missing} missing`);
  }
  return [...lines, ...data.limitations.map(line => `Note: ${line}`)].join('\n') + '\n';
}
export function main(args = process.argv.slice(2)) {
  const options = {}; let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { process.stdout.write('Usage: node dispatch/metrics.mjs [--org DIR] [--since ISO] [--until ISO] [--json]\nRead-only run metadata; use promote/metrics.mjs for train waits.\n'); return; }
    if (args[i] === '--json') { json = true; continue; }
    if (!['--org', '--since', '--until'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('unknown option or missing value');
    options[args[i].slice(2)] = args[++i];
  }
  const data = collectRunMetrics(options);
  process.stdout.write(json ? JSON.stringify(data, null, 2) + '\n' : renderRunMetrics(data));
}
if (isMain(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`run metrics: ${error.message}\n`); process.exitCode = 1; }
}
