#!/usr/bin/env node
// Read-only train measurements. No record writes, model calls or gate execution.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const git = (project, args) => {
  const r = spawnSync('git', ['-C', project, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw Error((r.stderr || r.error?.message || 'Git read failed').trim());
  return r.stdout.trim();
};
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function stats(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b), n = sorted.length;
  return { samples: n, total: sorted.reduce((a, b) => a + b, 0),
    median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    max: n ? sorted[n - 1] : null };
}
const rate = (green, completed, unknown = 0) => ({ green, completed, unknown, rate: completed ? green / completed : null });
const status = gate => !gate.finished_at ? 'unfinished' : gate.signal ? 'interrupted' :
  gate.exit_code === 0 ? 'green' : Number.isInteger(gate.exit_code) && gate.exit_code > 0 ? 'red' : 'unknown';
const gateObservations = attempt => [...(attempt.gate_history ?? []), ...(attempt.gate ? [attempt.gate] : [])];
function executionEvidence(observation) {
  const gate = observation.execution ?? observation;
  if (!gate.execution_receipt || gate.finished_at && gate.exit_code !== undefined) return gate;
  try {
    const started = JSON.parse(fs.readFileSync(gate.execution_receipt, 'utf8'));
    if (started.command_started === true) return { ...gate, executed: true, ...started,
      duration_s: started.finished_at ? Math.max(0, (Date.parse(started.finished_at) - Date.parse(started.started_at)) / 1000) : gate.duration_s };
  } catch { /* Old clocks without execution evidence remain unknown. */ }
  return gate;
}
const testPath = /(?:[^\s'"():]+\/)*[^\s'"():]+\.(?:test|spec)\.[cm]?[jt]sx?/g;
function normalizeFile(file, roots) {
  for (const root of roots.filter(Boolean)) {
    if (file.startsWith(root + '/')) return file.slice(root.length + 1);
  }
  return file.replace(/^\.\//, '');
}

// TAP stream totals measure test time, not the time between npm/pnpm markers.
// Multi-file TAP streams have no per-file identity; keep them as groups.
export function parseLog(text, roots = []) {
  const steps = [], files = [], groups = [], failing = new Set(), failingSteps = new Set();
  let step = '(unmarked gate)', commandFiles = [], failed = false, pendingFile = null, pendingFailed = false, stream = false, labeledFiles = false;
  for (const raw of text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n')) {
    const marker = raw.match(/^> \S+@\S+ ((?:test|validate):\S+)(?:\s|$)/);
    if (marker) { step = marker[1]; commandFiles = []; }
    if (/^> (?:node|.*\bnode)\b/.test(raw)) commandFiles = [...raw.matchAll(testPath)].map(m => normalizeFile(m[0], roots));
    if (raw === 'TAP version 13') { failed = false; stream = true; labeledFiles = false; }
    if (/^not ok\b/.test(raw)) { failed = true; if (pendingFile) pendingFailed = true; failingSteps.add(step); }
    const subtest = raw.match(/^# Subtest: (.+\.(?:test|spec)\.[cm]?[jt]sx?)$/);
    if (subtest) { pendingFile = normalizeFile(subtest[1], roots); pendingFailed = false; }
    const duration = raw.match(/^  duration_ms: ([\d.]+)$/);
    if (duration && pendingFile) { files.push({ name: pendingFile, duration_s: Number(duration[1]) / 1000, step, failed: pendingFailed }); pendingFile = null; labeledFiles = true; }
    if (/^\s+location:|^not ok\b|^\s*(?:FAIL|❯|×)\s|error TS\d+/.test(raw)) {
      for (const m of raw.matchAll(testPath)) failing.add(normalizeFile(m[0], roots));
      if (/error TS\d+/.test(raw)) {
        const m = raw.match(/^(.+\.[cm]?[jt]sx?)\(\d+,\d+\): error/);
        if (m) failing.add(normalizeFile(m[1], roots));
      }
      failingSteps.add(step);
    }
    const total = raw.match(/^# duration_ms ([\d.]+)$/);
    if (total && stream) {
      const row = { name: step, duration_s: Number(total[1]) / 1000, failed, source: 'TAP stream total (test time)' };
      steps.push(row);
      if (!labeledFiles && commandFiles.length === 1 && !/[*?\[\]{}]/.test(commandFiles[0])) files.push({ ...row, name: commandFiles[0], step });
      else if (!labeledFiles && commandFiles.length) groups.push({ ...row, name: commandFiles.join(' + '), step });
      stream = false; pendingFile = null;
    }
    const vitest = raw.match(/^\s*[✓✔❯×]\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+.*?\s([\d.]+)(ms|s)\s*$/);
    if (vitest) files.push({ name: normalizeFile(vitest[1], roots), duration_s: Number(vitest[2]) / (vitest[3] === 'ms' ? 1000 : 1), step, failed: /^\s*[❯×]/.test(raw) });
    const vtotal = raw.match(/^\s*Duration\s+([\d.]+)(ms|s)\b/);
    if (vtotal) steps.push({ name: step, duration_s: Number(vtotal[1]) / (vtotal[2] === 'ms' ? 1000 : 1), failed: failingSteps.has(step), source: 'Vitest duration (test time)' });
  }
  return { steps, files, groups, failing_files: [...failing], failing_steps: [...failingSteps] };
}
function sumSteps(rows) {
  const totals = new Map();
  for (const row of rows) {
    const total = totals.get(row.name) ?? { name: row.name, duration_s: 0, failed: false };
    total.duration_s += row.duration_s; total.failed ||= row.failed;
    totals.set(row.name, total);
  }
  return [...totals.values()];
}
function ranked(rows) {
  const buckets = new Map();
  for (const row of rows) {
    if (!finite(row.duration_s)) continue;
    const bucket = buckets.get(row.name) ?? [];
    bucket.push(row); buckets.set(row.name, bucket);
  }
  return [...buckets].map(([name, values]) => ({ name, ...stats(values.map(v => v.duration_s)),
    failures: values.filter(v => v.failed).length })).sort((a, b) => b.median - a.median || a.name.localeCompare(b.name));
}
function attribution(project, attempt, files) {
  const changes = attempt.jobs.map(job => {
    try { return { lane: job.topic, files: git(project, ['diff', '--name-only', `${attempt.base}...${job.sourceHead}`]).split('\n') }; }
    catch { return { lane: job.topic, files: null }; }
  });
  return files.map(file => ({ file, lanes: changes.filter(c => c.files?.includes(file)).map(c => c.lane),
    unavailable: changes.filter(c => c.files === null).map(c => c.lane),
    basis: 'changed-file overlap; a hint, not proof of causation' }));
}
export function collectMetrics({ project = process.cwd(), since, until, now = new Date().toISOString() } = {}) {
  const identity = fs.realpathSync(git(project, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const bound = (value, name) => {
    if (value === undefined) return null;
    if (!/^\d{4}-\d{2}-\d{2}(?:$|T.*(?:Z|[+-]\d{2}:\d{2})$)/.test(value) || !Number.isFinite(Date.parse(value))) throw Error(`${name} requires an ISO date or timestamp with timezone`);
    return Date.parse(value);
  };
  const lower = bound(since, '--since'), upper = bound(until, '--until');
  if (lower !== null && upper !== null && lower >= upper) throw Error('--since must precede --until');
  const directory = path.join(identity, 'promote/batches'), warnings = [], batches = [], gates = [], red = [];
  const stepRows = [], fileRows = [], groupRows = [], seen = new Set(), parsed = new Set();
  const names = fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
  for (const name of names) {
    const receipt = path.join(directory, name, 'train.json');
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      if (plan.schema !== 'promotion-train/v1' || plan.identity !== identity || !Array.isArray(plan.jobs) || !Array.isArray(plan.attempts ?? [])) throw Error('unsupported or foreign receipt');
      if (!plan.jobs.every(j => j && typeof j.id === 'string' && typeof j.topic === 'string') ||
          !(plan.attempts ?? []).every(a => a && Array.isArray(a.jobs ?? []) && (a.jobs ?? []).every(j => j && typeof j.topic === 'string') && (!a.gate || typeof a.gate === 'object') &&
            Array.isArray(a.gate_history ?? []) && (a.gate_history ?? []).every(g => g && typeof g === 'object')) ||
          !Object.values(plan.results ?? {}).every(r => r && typeof r === 'object')) throw Error('malformed train receipt');
    } catch (error) { warnings.push(`${receipt}: ${error.message}`); continue; }
    const started = Date.parse(plan.started_at);
    if ((lower !== null || upper !== null) && !Number.isFinite(started)) { warnings.push(`${receipt}: no batch start; excluded from window`); continue; }
    if (lower !== null && started < lower || upper !== null && started >= upper) continue;
    const attempts = plan.attempts ?? [], observations = attempts.flatMap(gateObservations);
    const first = observations[0] ? status(executionEvidence(observations[0])) : 'no-gate';
    const results = Object.values(plan.results ?? {});
    batches.push({ id: plan.id, receipt, started_at: plan.started_at ?? null, phase: plan.phase,
      lanes: plan.jobs.map(j => j.topic), first_gate: first,
      bisected: attempts.some(a => a.phase === 'red' && a.ids?.length > 1),
      promoted: results.filter(r => r.outcome === 'promoted').length,
      refused: results.filter(r => r.outcome === 'refused').length });
    for (const [index, attempt] of attempts.entries()) {
      for (const [executionIndex, observation] of gateObservations(attempt).entries()) {
        const g = executionEvidence(observation), outcome = status(g), jobs = attempt.jobs ?? [];
        const fingerprint = JSON.stringify([g.log, g.started_at, g.finished_at, g.command]);
        const duplicate = !g.reused && seen.has(fingerprint);
        if (!g.reused) seen.add(fingerprint);
        const row = { batch: plan.id, attempt: index, execution: executionIndex, command: g.command, status: outcome, executed: g.executed === true,
          lanes: jobs.map(j => j.topic), lane_count: jobs.length, reused: g.reused === true, duplicate,
          started_at: g.started_at, finished_at: g.finished_at ?? null,
          duration_s: g.finished_at && finite(g.duration_s) ? g.duration_s : null,
          elapsed_s: !g.finished_at && Number.isFinite(Date.parse(g.started_at)) ? Math.max(0, (Date.parse(now) - Date.parse(g.started_at)) / 1000) : null,
          integrated: observation === attempt.gate && !observation.execution && ['integrated', 'complete'].includes(attempt.phase) && outcome === 'green' };
        gates.push(row);
        let log = { failing_files: [], failing_steps: [] };
        // Prefer the exact gate log; train.log may mix several bisection attempts.
        if (g.log) {
          try {
            const contents = fs.readFileSync(g.log, 'utf8');
            if (g.log_hash && createHash('sha256').update(JSON.stringify(contents)).digest('hex') !== g.log_hash) throw Error('gate log hash mismatch');
            log = parseLog(contents, [attempt.scratch, project]);
            if (!row.reused && !duplicate && !parsed.has(fingerprint)) {
              stepRows.push(...sumSteps(log.steps)); fileRows.push(...log.files); groupRows.push(...log.groups); parsed.add(fingerprint);
            }
          } catch (error) { warnings.push(`${plan.id} attempt ${index}: ${error.message}`); }
        } else if (outcome === 'red') warnings.push(`${plan.id} attempt ${index}: no exact gate log; combined train.log cannot identify an attempt's failures`);
        if (outcome === 'red') red.push({ ...row, failing_steps: log.failing_steps,
          attribution: attribution(project, { ...attempt, jobs }, log.failing_files),
          isolated_lane: jobs.length === 1 ? jobs[0].topic : null,
          reason: attempt.error ?? null });
      }
    }
  }
  const observed = gates.filter(g => !g.reused && !g.duplicate);
  const executed = observed.filter(g => g.executed || ['green', 'red', 'interrupted'].includes(g.status));
  const completed = executed.filter(g => ['green', 'red'].includes(g.status));
  const firstCompleted = batches.filter(b => ['green', 'red'].includes(b.first_gate));
  const landed = executed.filter(g => g.integrated);
  return { schema: 'train-metrics/v1', identity, window: { since: since ?? null, until: until ?? null, basis: 'batch started_at; lower inclusive, upper exclusive' },
    summary: { batches: batches.length, complete_batches: batches.filter(b => b.phase === 'complete').length,
      bisected_batches: batches.filter(b => b.bisected).length, gates_observed: observed.length, gates_executed: executed.length,
      gates_completed: completed.length, green: completed.filter(g => g.status === 'green').length,
      red: completed.filter(g => g.status === 'red').length, unfinished: observed.filter(g => g.status === 'unfinished').length,
      interrupted: executed.filter(g => g.status === 'interrupted').length, unknown: observed.filter(g => g.status === 'unknown').length,
      reused: gates.filter(g => g.reused).length, duplicate_evidence: gates.filter(g => g.duplicate).length,
      lanes_per_gate: stats(executed.map(g => g.lane_count)),
      lanes_landed_per_green_executed_gate: landed.length ? landed.reduce((n, g) => n + g.lane_count, 0) / landed.length : null,
      first_pass: rate(firstCompleted.filter(b => b.first_gate === 'green').length, firstCompleted.length,
        batches.filter(b => !['green', 'red', 'no-gate'].includes(b.first_gate)).length),
      batches_without_gate: batches.filter(b => b.first_gate === 'no-gate').length,
      gate_time_s: stats(completed.map(g => g.duration_s)),
      executed_gate_time_s: stats(executed.map(g => g.duration_s)),
      gate_profiles: [...new Set(executed.map(g => g.command))].map(command => ({ command,
        time_s: stats(executed.filter(g => g.command === command).map(g => g.duration_s)),
        gates: executed.filter(g => g.command === command).length })) },
    slowest_steps: ranked(stepRows), slowest_test_files: ranked(fileRows), slowest_test_groups: ranked(groupRows),
    red_attribution: red, batches, gates, warnings,
    limitations: [
      'Executed gates require an exit, signal or durable command-start receipt; old unfinished clocks remain observations with execution unknown.',
      'First-pass rate is the first retained gate per batch, including cached evidence; unfinished/unknown and batches without a gate are excluded.',
      'Resumed attempts retain gate history; executions overwritten by older versions cannot be reconstructed or counted.',
      'Step durations sum test-stream totals per gate, not wall time: builds, slot waits and unmarked work are excluded.',
      'Multi-file TAP streams without file labels cannot supply individual file durations; these are shown as groups when the command names files.',
      'Only exact gate logs are attributed; combined train.log is not assigned to bisection attempts.',
    ] };
}

const duration = value => {
  let total = 0, found = false;
  for (const m of value.matchAll(/([\d.]+)(h|m|s)/g)) { total += Number(m[1]) * ({ h: 3600, m: 60, s: 1 })[m[2]]; found = true; }
  if (!found) throw Error(`unrecognized baseline duration: ${value}`);
  return total;
};
// Import the archived summary, never execute bch-cloak's CLI or backfill writer.
export function importBaseline(report) {
  report = path.resolve(report);
  const markdown = fs.readFileSync(report, 'utf8');
  if (!markdown.includes('## First baseline:')) throw Error('baseline report has no First baseline section');
  const evidence = path.join(report.replace(/\.md$/, '-evidence'), 'backfill-report.txt');
  const text = fs.readFileSync(evidence, 'utf8');
  const runs = text.match(/^gate report: (\d+) runs \((\d+) recorded, (\d+) backfilled\)/m);
  const gates = text.match(/^gates run .*: (\d+) .*; (\d+) narrow\)/m);
  const timing = text.match(/^gate time, backfilled full gates .*: median (\S+), total (\S+) over (\d+) gates/m);
  if (!runs || !gates || !timing) throw Error('unsupported archived baseline format');
  const table = heading => {
    const section = text.split(heading)[1]?.split(/\n\n/)[0] ?? '';
    return [...section.matchAll(/^\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(.+)$/gm)]
      .filter(m => /^\d/.test(m[1])).map(m => ({ name: m[6], median_s: duration(m[1]), max_s: duration(m[2]), total_s: duration(m[3]), samples: Number(m[4]), failures: Number(m[5]) }));
  };
  return { source: report, evidence, window: '2026-09-28 through 2026-10-04 (archived summary; separate from train window)',
    runs: Number(runs[1]), backfilled: Number(runs[3]), gates: Number(gates[1]), narrow_gates: Number(gates[2]),
    full_gate_time_s: { median: duration(timing[1]), total: duration(timing[2]), samples: Number(timing[3]) },
    first_pass_rate: null, lanes_per_gate: 1,
    slowest_steps: table('slowest 15 steps by median'), slowest_test_files: table('slowest 15 test files by median'),
    limitations: ['Only successful promotion logs were archived; 54/54 green is archive selection, not a measurable first-pass rate.',
      'Times are rounded, in-log lower bounds; builds, typechecks and slot wait are absent. These are not comparable wall-clock gate times.'] };
}
const seconds = value => value === null ? 'unavailable' : `${value.toFixed(2)}s`;
export function renderMetrics(data) {
  const s = data.summary;
  const lines = [`Train metrics: ${data.identity}`, `Window: ${data.window.since ?? 'all'} to ${data.window.until ?? 'now'} (${data.window.basis})`,
    `Batches: ${s.batches}; complete ${s.complete_batches}; bisected ${s.bisected_batches}; without gate ${s.batches_without_gate}`,
    `Gates executed: ${s.gates_executed}; green ${s.green}; red ${s.red}; interrupted ${s.interrupted}; observations ${s.gates_observed}; unfinished ${s.unfinished}; unknown ${s.unknown}; reused ${s.reused}; duplicate evidence ${s.duplicate_evidence}`,
    `Gate wall time: median ${seconds(s.gate_time_s.median)}; total ${seconds(s.gate_time_s.total)}; ${s.gate_time_s.samples} timed completed gates`,
    `All executed gate wall time: median ${seconds(s.executed_gate_time_s.median)}; total ${seconds(s.executed_gate_time_s.total)}; ${s.executed_gate_time_s.samples} timed gates including interruptions`,
    `Lanes per executed gate: mean ${s.lanes_per_gate.samples ? (s.lanes_per_gate.total / s.lanes_per_gate.samples).toFixed(2) : 'unavailable'}; median ${s.lanes_per_gate.median ?? 'unavailable'}; max ${s.lanes_per_gate.max ?? 'unavailable'}; landed per green executed gate ${s.lanes_landed_per_green_executed_gate ?? 'unavailable'}`,
    `First-pass green (first retained gate per batch): ${s.first_pass.green}/${s.first_pass.completed} = ${s.first_pass.rate === null ? 'unavailable' : (100 * s.first_pass.rate).toFixed(1) + '%'}; ${s.first_pass.unknown} unknown`,
    'Gate profiles:'];
  for (const p of s.gate_profiles) lines.push(`  ${p.command}: ${p.gates} executions, median ${seconds(p.time_s.median)}`);
  for (const [label, rows] of [['Slowest steps (test time)', data.slowest_steps], ['Slowest test files', data.slowest_test_files], ['Slowest multi-file test groups', data.slowest_test_groups]]) {
    lines.push(`${label}:`);
    if (!rows.length) lines.push('  unavailable in retained logs');
    for (const row of rows.slice(0, 15)) lines.push(`  ${seconds(row.median)} median; ${seconds(row.max)} max; ${row.samples} samples: ${row.name}`);
  }
  lines.push(`Red attribution: ${data.red_attribution.length}`);
  for (const red of data.red_attribution) {
    lines.push(`  ${red.batch} attempt ${red.attempt}: lanes ${red.lanes.join(', ')}; steps ${red.failing_steps.join(', ') || 'unavailable'}; isolated lane ${red.isolated_lane ?? 'none'}`);
    if (!red.attribution.length) lines.push('    failing files unavailable');
    for (const a of red.attribution) lines.push(`    ${a.file}: ${a.lanes.join(', ') || 'unattributed'} (${a.basis}${a.unavailable.length ? '; Git evidence unavailable for ' + a.unavailable.join(', ') : ''})`);
  }
  if (data.baseline) {
    const b = data.baseline;
    lines.push(`Baseline: ${b.source}`, `  ${b.window}`, `  ${b.runs} archived runs; ${b.narrow_gates} narrow; ${b.full_gate_time_s.samples} full gates; median ${seconds(b.full_gate_time_s.median)} in-log lower bound; lanes per gate ${b.lanes_per_gate}; first-pass rate unavailable`);
    for (const [label, rows] of [['steps', b.slowest_steps], ['files', b.slowest_test_files]]) {
      lines.push(`  Baseline slowest ${label}:`);
      for (const r of rows.slice(0, 5)) lines.push(`    ${seconds(r.median_s)} median: ${r.name}`);
    }
    lines.push(...b.limitations.map(l => `  ${l}`));
  }
  lines.push(...data.limitations.map(l => `Note: ${l}`));
  if (data.warnings.length) {
    lines.push(`Warnings: ${data.warnings.length}`, ...data.warnings.slice(0, 5).map(w => `  ${w}`));
    if (data.warnings.length > 5) lines.push(`  ${data.warnings.length - 5} additional warnings; --json includes every excluded receipt and missing log.`);
  }
  return lines.join('\n') + '\n';
}
export function main(args = process.argv.slice(2)) {
  const options = {}; let json = false, baseline;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') {
      process.stdout.write('Usage: node promote/metrics.mjs [--project PATH] [--since ISO] [--until ISO] [--baseline ARCHIVED_REPORT.md] [--json]\nReads canonical Git common-directory receipts. Window selects batch starts. Baseline uses the report and sibling -evidence/backfill-report.txt, read-only.\n'); return;
    }
    if (arg === '--json') { json = true; continue; }
    if (!['--project', '--since', '--until', '--baseline'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error(`unknown option or missing value: ${arg}`);
    const value = args[++i];
    if (arg === '--baseline') baseline = value; else options[arg.slice(2)] = value;
  }
  const data = collectMetrics(options);
  if (baseline) data.baseline = importBaseline(baseline);
  process.stdout.write(json ? JSON.stringify(data, null, 2) + '\n' : renderMetrics(data));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`train metrics: ${error.message}\n`); process.exitCode = 1; }
}
