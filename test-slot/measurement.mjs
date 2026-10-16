// Foreground, best-effort observations. No admission, signalling or lock writes.
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { lookupProcess } from '../lib/processes.mjs';
import { readMemory } from '../lib/memory.mjs';
import { workerSettings } from './resources.mjs';
import { writeFileAtomic } from '../lib/files.mjs';

export const SAMPLE_INTERVAL_MS = 2000;
export const TELEMETRY_ROWS = 256;

// One writer is shared across retries. Aggregate measurements still cover every
// observation; only the raw diagnostic tail is truncated.
export function boundedTelemetry(file, rowLimit = TELEMETRY_ROWS) {
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1) throw Error('invalid telemetry row limit');
  const rows = [];
  let observed = 0, retained = 0, writeFailures = 0;
  return {
    write(row) {
      observed++;
      rows.push(JSON.stringify(row) + '\n');
      if (rows.length > rowLimit) rows.shift();
      try { writeFileAtomic(file, rows.join(''), 0o600); retained = rows.length; }
      catch (error) { writeFailures++; throw error; }
    },
    summary: () => ({ policy: 'last rows across all attempts', row_limit: rowLimit, rows_observed: observed,
      rows_retained: retained, rows_dropped: Math.max(0, observed - rowLimit), truncated: observed > rowLimit, write_failures: writeFailures }),
  };
}
export function readOwnedRss(pids, execute = spawnSync) {
  if (!pids.length) return new Map();
  if (pids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw Error('invalid owned PID');
  // Request only proven family PIDs. Never collect other holders' RSS.
  const result = execute('/bin/ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.error || result.signal || ![0, 1].includes(result.status) || result.stderr?.trim()) throw Error(`owned RSS unavailable: ${result.error?.message ?? result.stderr?.trim() ?? result.signal ?? result.status}`);
  const rows = new Map(), wanted = new Set(pids);
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    const pid = Number(match?.[1]), rss = Number(match?.[2]) * 1024;
    if (!match || !wanted.has(pid) || rows.has(pid) || !Number.isSafeInteger(rss)) throw Error('invalid owned RSS output');
    rows.set(pid, rss);
  }
  return rows;
}

export function measureFamily({ pid, identity, intervalMs = SAMPLE_INTERVAL_MS, telemetryPath, notes = 'cold/warm unknown; no cache preparation performed',
  telemetry = telemetryPath ? boundedTelemetry(telemetryPath) : null,
  lookup = lookupProcess, rss = readOwnedRss, memory = readMemory, workers = workerSettings, load = () => os.loadavg()[0], now = () => new Date().toISOString() }) {
  const known = new Map(), peaks = new Map();
  const evidence = { schema: 'test-slot-measurement/v1', kind: 'execution evidence; not a PASS', phase_started_at: now(), phase_finished_at: null,
    sampling_interval_ms: intervalMs, notes, samples: 0, rss_samples: 0, incomplete_rss_samples: 0, omitted_process_observations: 0, host_samples: 0, failures: [], failure_count: 0,
    sampled_sum_owned_rss_peak_bytes: null, individual_peak_rss_bytes: null, per_process_peak_rss: [],
    host_available_start_bytes: null, host_available_min_bytes: null, host_available_drawdown_bytes: null,
    load1_max: null, worker_settings: workers(), telemetry_path: telemetryPath ?? null, telemetry_file: telemetryPath?.split('/').at(-1) ?? null };
  const fail = (component, error) => {
    evidence.failure_count++;
    if (evidence.failures.length < 8) evidence.failures.push({ component, at: now(), message: String(error.message ?? error) });
  };
  const sample = () => {
    const failuresBefore = evidence.failure_count;
    const row = { phase_started_at: evidence.phase_started_at, command_pid: pid, command_identity: identity, at: now(), load1: load(), worker_settings: workers(), processes: [], sampled_sum_owned_rss_bytes: null, host_available_bytes: null };
    evidence.samples++;
    evidence.load1_max = Math.max(evidence.load1_max ?? 0, row.load1);
    try {
      const host = memory();
      row.host_memory_source = host.source;
      // Advisory fallback free memory must not masquerade as MemAvailable.
      if (!Number.isFinite(host.available) || !['/proc/meminfo', 'vm_stat + vm.swapusage', 'vm_stat (swap unavailable)'].includes(host.source)) throw Error(host.warning ?? 'validated host availability unavailable');
      row.host_available_bytes = host.available;
      evidence.host_samples++;
      evidence.host_available_start_bytes ??= host.available;
      evidence.host_available_min_bytes = Math.min(evidence.host_available_min_bytes ?? Infinity, host.available);
      evidence.host_available_drawdown_bytes = Math.max(0, evidence.host_available_start_bytes - evidence.host_available_min_bytes);
    } catch (error) { fail('host-available', error); }
    try {
      const before = lookup(undefined, { identityOnly: true });
      if (!before.ok) throw Error(before.error);
      if (!identity) throw Error('command birth identity unavailable');
      const rows = before.value, root = rows.get(pid);
      if (root && root.identity !== identity) throw Error('command PID birth changed');
      const liveRoot = root?.identity === identity;
      // After leader exit, a retained birth-confirmed group member is needed to
      // extend group ownership. A recycled PGID can never enroll new processes.
      const retained = [...known.values()].map(saved => rows.get(saved.pid)).filter(current => current && known.get(current.pid).identity === current.identity);
      const liveGroup = liveRoot || retained.some(current => current.pgid === pid);
      const family = new Map(retained.map(current => [current.pid, current]));
      if (liveRoot) family.set(pid, root);
      const children = new Map();
      for (const value of rows.values()) {
        if (!children.has(value.ppid)) children.set(value.ppid, []);
        children.get(value.ppid).push(value);
        if (liveGroup && value.pgid === pid) family.set(value.pid, value);
      }
      // Walk once from all birth-confirmed roots, including retained escapees.
      // Avoid rewalking the full host table for every process ever observed.
      const pending = [...family.keys()];
      for (let index = 0; index < pending.length; index++) for (const value of children.get(pending[index]) ?? []) {
        if (family.has(value.pid)) continue;
        family.set(value.pid, value); pending.push(value.pid);
      }
      known.clear();
      for (const [child, value] of family) known.set(child, value);
      const values = rss([...family.keys()]);
      const after = lookup(undefined, { identityOnly: true });
      if (!after.ok) throw Error(after.error);
      for (const [child, value] of family) {
        if (after.value.get(child)?.identity !== value.identity || !values.has(child)) continue;
        const bytes = values.get(child), key = `${child}/${value.identity}`;
        const peak = peaks.get(key) ?? { pid: child, identity: value.identity, peak_rss_bytes: 0 };
        peak.peak_rss_bytes = Math.max(peak.peak_rss_bytes, bytes); peaks.set(key, peak);
        row.processes.push({ pid: child, identity: value.identity, rss_bytes: bytes });
      }
      // An exited family is a valid empty sample, never a peak of invented zero.
      if (row.processes.length) {
        row.sampled_sum_owned_rss_bytes = row.processes.reduce((sum, value) => sum + value.rss_bytes, 0);
        evidence.rss_samples++;
        evidence.sampled_sum_owned_rss_peak_bytes = Math.max(evidence.sampled_sum_owned_rss_peak_bytes ?? 0, row.sampled_sum_owned_rss_bytes);
      }
      row.disappeared_or_changed_processes = family.size - row.processes.length;
      if (row.disappeared_or_changed_processes) evidence.incomplete_rss_samples++;
      evidence.omitted_process_observations += row.disappeared_or_changed_processes;
    } catch (error) { fail('owned-rss', error); }
    row.failure_count = evidence.failure_count - failuresBefore;
    row.failures = evidence.failures.filter(failure => failure.at >= row.at);
    if (telemetry) try { telemetry.write(row); }
    catch (error) { fail('telemetry-write', error); }
  };
  const safeSample = () => { try { sample(); } catch (error) { fail('sampling', error); } };
  safeSample();
  const timer = setInterval(safeSample, intervalMs);
  return { stop() { clearInterval(timer); }, finish() {
    clearInterval(timer); safeSample();
    evidence.phase_finished_at = now();
    evidence.telemetry = telemetry?.summary() ?? null;
    evidence.per_process_peak_rss = [...peaks.values()];
    evidence.individual_peak_rss_bytes = peaks.size ? [...peaks.values()].reduce((maximum, row) => Math.max(maximum, row.peak_rss_bytes), 0) : null;
    evidence.status = evidence.failure_count ? 'partial-or-unavailable' : 'observed';
    return evidence;
  } };
}
