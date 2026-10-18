// Read-only projection. Deliberately does not import queueFor (which mkdirs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitProject } from '../lib/project.mjs';
import { parseLog } from '../promote/metrics.mjs';
import { errorDocument, safeLog, WITHHELD } from './rows.mjs';
import { runCommand, sourceEnvironment } from './source.mjs';

const RECORD = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value) && value !== '.' && value !== '..';
function localJSON(file, common) {
  if (safeLog(file, [common]) === WITHHELD) return null;
  try { return read(file); } catch { return null; }
}
export function discoverProject(cwd) {
  const project = gitProject(cwd, { timeoutMs: 3000 });
  return { ...project, name: path.basename(project.canonical), paths: [project.canonical, project.checkout], worktrees: [] };
}
export function refreshProject(project) {
  const r = spawnSync('git', ['-C', project.canonical, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 });
  const worktrees = r.status === 0 ? r.stdout.split('\n\n').map(entry => ({
    cwd: entry.split('\n').find(l => l.startsWith('worktree '))?.slice(9),
    topic: entry.split('\n').find(l => l.startsWith('branch refs/heads/lane/'))?.slice(23),
  })).filter(w => w.cwd) : [];
  return { ...project, name: path.basename(project.canonical), worktrees, paths: [...new Set([project.canonical, project.checkout, ...worktrees.map(w => w.cwd)])] };
}
async function recordShow(project, job, value) {
  if (!/^(?:R-\d+|[A-Z][A-Z0-9]*-\d+)$/.test(value ?? '')) return null;
  const localCLI = path.join(project.canonical, 'bin/org.mjs');
  const r = await runCommand(process.execPath, [fs.existsSync(localCLI) ? localCLI : RECORD, 'show', value, '--json'], {
    cwd: project.canonical, env: { ...sourceEnvironment(), ...(typeof job.org === 'string' ? { ORG_DIR: job.org } : {}) }, timeout: 3000,
  });
  if (r.code) return null;
  try { const data = JSON.parse(r.text); return data.id === value ? data : null; } catch { return null; }
}
export function brainPhase({ job, result, train, attempt, gate }) {
  if (result?.outcome === 'promoted' || job.phase === 'promoted') return result?.reconciliation?.state && result.reconciliation.state !== 'complete' ? 'reconcile' : 'landed';
  if (result?.outcome === 'interrupted' || result?.outcome === 'timeout') return 'interrupted';
  if (['refused', 'failed'].includes(result?.outcome)) return 'failed';
  if (job.phase === 'pending') return 'queued';
  if (['batch-delivering', 'completed'].includes(job.phase) || ['validated', 'integrated', 'complete'].includes(attempt?.phase)) return 'reconcile';
  if (gate && !gate.finished_at) return gate.slot_receipt && !gate.command_started_at ? 'admission' : 'stage';
  if (['red', 'invalid'].includes(attempt?.phase)) {
    const waiting = !result && train && (train.phase !== 'complete' || train.groups?.some(group => group.includes(job.id)));
    return waiting ? 'admission' : 'failed';
  }
  if (['interrupted', 'timeout'].includes(attempt?.phase)) return 'interrupted';
  if (['batching', 'promoting'].includes(job.phase) || train?.phase === 'pending' || ['preparing', 'prepared', 'rebasing'].includes(attempt?.phase)) return 'admission';
  return 'unknown';
}
// Shared synchronous projection; the drivers below supply either cached async
// record reads or an already observed fold. Selection and phase facts stay here.
function* brainProjection(project, { now = Date.now(), recentMs = 86400000, limit = 20, logClocks = true } = {}) {
  const common = project.identity, directory = path.join(common, 'promote'), queuePath = path.join(directory, 'queue.json');
  if (!fs.existsSync(queuePath)) return null;
  try {
    const queue = read(queuePath);
    if (!queue || queue.identity !== common || !Array.isArray(queue.pending) || !Array.isArray(queue.results)) return errorDocument(project.name, 'source-schema');
    const members = current => current?.jobs ? current.jobs.map(j => ({ ...j, phase: current.phase, batch: current.id,
      result: current.results?.find(r => r.job?.id === j.id)?.result })) : current ? [current] : [];
    const jobs = new Map();
    const recent = queue.results.filter(j => Date.parse(j.finished) >= now - recentMs).slice(-limit);
    for (const j of [...recent, ...(queue.interrupted ?? []).flatMap(members), ...members(queue.current), ...queue.pending.map(j => ({ ...j, phase: 'pending' }))]) jobs.set(j.id, j);
    const rows = [];
    for (const job of jobs.values()) {
      const batch = id(job.batch) ? path.join(directory, 'batches', job.batch) : null;
      const loaded = batch ? localJSON(path.join(batch, 'train.json'), common) : null;
      const train = loaded?.schema === 'promotion-train/v1' && loaded.identity === common && loaded.id === job.batch && loaded.jobs?.some(j => j.id === job.id) ? loaded : null;
      const attempt = train?.attempts?.findLast(a => a.ids?.includes(job.id));
      const result = job.result ?? (job.outcome ? job : train?.results?.[job.id]);
      let gate = result?.gate ?? attempt?.gate;
      if (gate?.key && /^[a-f0-9]{64}$/.test(gate.key)) {
        const receipt = localJSON(path.join(common, 'lane-validation', `${gate.key}.json`), common);
        if (receipt?.schema === 'lane-validation/v1' && receipt.key === gate.key && receipt.tree === gate.tree && receipt.head === gate.head) gate = { ...gate, ...receipt };
      }
      if (gate?.execution_receipt && gate.execution_receipt === `${gate.log}.execution.json`) {
        const execution = localJSON(gate.execution_receipt, common);
        if (execution?.command_started === true) gate = { ...gate, command_started_at: execution.started_at };
      }
      const phase = brainPhase({ job, result, train, attempt, gate });
      const finished = ['landed', 'failed', 'interrupted'].includes(phase) && Boolean(result);
      const run = yield { job, key: job.run, finished };
      const item = run?.item ? yield { job, key: run.item, finished } : null;
      const log = result?.log ?? (batch ? path.join(batch, 'train.log') : id(job.id) ? path.join(directory, `${job.id}.log`) : null);
      const clocks = [];
      if (Number.isFinite(result?.report_to_main_s) && result.report_to_main_s >= 0) clocks.push({ label: 'report to main', seconds: Math.floor(result.report_to_main_s), legacy: false });
      if (Number.isFinite(gate?.duration_s) && gate.duration_s >= 0) clocks.push({ label: 'gate', seconds: Math.floor(gate.duration_s), legacy: false });
      // Only numeric timing leaves parseLog; neither text nor log completions classify a job.
      if (logClocks && safeLog(log, [common]) !== WITHHELD) {
        try {
          if (fs.statSync(log).size <= 1024 * 1024) {
            const parsed = parseLog(fs.readFileSync(log, 'utf8'));
            if (parsed.steps.length) clocks.push({ label: 'test time', seconds: Math.floor(parsed.steps.reduce((sum, step) => sum + step.duration_s, 0)), legacy: false });
          }
        } catch { /* Logs can disappear between reads. */ }
      }
      const original = train?.jobs?.find(j => j.id === job.id);
      rows.push({ id: job.id, item: item?.id ?? null, lane: job.topic ?? null, kind: 'promotion', phase,
        stage: phase === 'stage' ? { n: 1, m: 1 } : null,
        startedAt: train?.started_at ?? (typeof job.queued === 'string' ? job.queued : original?.queued) ?? gate?.started_at ?? null,
        phaseAt: gate?.command_started_at ?? gate?.started_at ?? attempt?.prepare?.started_at ?? train?.started_at ?? null,
        endedAt: job.finished ?? result?.integrated_at ?? null, clocks,
        status: { code: `brain-${phase}`, text: phase === 'stage' ? 'validation running' : phase },
        result: { exit: gate?.exit_code ?? null,
          // tip on a promoted result is the dedicated integrated main; gate.head is only a candidate.
          main: result?.outcome === 'promoted' ? result.tip ?? null : null,
          candidate: result?.source_head ?? job.expectedHead ?? null },
        where: { pane: run?.meta?.pane, log },
        worktree: result?.workspace ?? attempt?.scratch ?? run?.workspace ?? project.worktrees?.find(w => w.topic === job.topic)?.cwd ?? null,
      });
    }
    return { schema: 'board-rows/v1', project: project.name, generatedAt: new Date(now).toISOString(), rows };
  } catch { return errorDocument(project.name, 'source-read'); }
}

// Keep only the fields the projection uses, never notes, reports or tokens.
const recordFacts = data => data ? { id: data.id, item: data.item, workspace: data.workspace, meta: { pane: data.meta?.pane } } : null;

export async function brainSource(project, { now = Date.now(), show = recordShow, records = new Map(), ...options } = {}) {
  const projection = brainProjection(project, { ...options, now }), retained = new Set();
  let step = projection.next();
  while (!step.done) {
    const { job, key, finished } = step.value;
    const cacheKey = JSON.stringify([project.identity, job.org ?? null, job.id, key]);
    retained.add(cacheKey);
    let entry = records.get(cacheKey);
    if (!entry || entry.finished !== finished || (!entry.finished && now - entry.at >= 5000)) {
      entry = { value: Promise.resolve().then(() => show(project, job, key)).then(recordFacts), at: now, finished };
      records.set(cacheKey, entry);
    }
    try { step = projection.next(await entry.value); }
    catch (error) { step = projection.throw(error); }
  }
  for (const key of records.keys()) if (!retained.has(key)) records.delete(key);
  return step.value;
}

export function brainSourceSync(project, { show, ...options } = {}) {
  const projection = brainProjection(project, options);
  let step = projection.next();
  while (!step.done) {
    const { job, key } = step.value;
    try { step = projection.next(recordFacts(show(project, job, key))); }
    catch (error) { step = projection.throw(error); }
  }
  return step.value;
}
