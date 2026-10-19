// Writer-side protection of the local promotion queue. Called under the record
// lock, before appending any proposed events. Queue/train snapshots are atomic;
// never take queue.lock here (enqueue takes it before reading the record).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitProject } from './project.mjs';
import { checkFleetRecord } from './fleet.mjs';
import { findOrgDir, UserError } from './store.mjs';
import { blockersOf } from './state.mjs';
import { sanitizeTerminal } from './sanitize.mjs';

const samePath = (a, b) => {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
};
const refused = message => { throw Object.assign(new UserError(message), { exitCode: 3 }); };
const advice = 'Write the information on an unguarded parent or in the supervisor digest meanwhile, and copy it to the member after landing and reconciliation.';

function recordProject(org) {
  const bound = checkFleetRecord(org);
  if (bound) {
    const project = gitProject(bound.checkout);
    if (project.identity !== bound.identity || project.canonical !== bound.checkout) throw Error('stale record project binding');
    return project;
  }
  // Standalone records need no Git. Explicit ORG_DIR from a different project
  // must never consult the caller's queue; prove ownership by record discovery.
  for (const cwd of [path.dirname(org), process.cwd()]) {
    let project;
    try { project = gitProject(cwd); } catch { continue; }
    const discovered = findOrgDir({ cwd: project.canonical, env: { ...process.env, ORG_DIR: '' } });
    if (discovered && samePath(discovered, org)) return project;
  }
  return null;
}

function affectedItems(state, add) {
  const ids = new Set();
  const include = id => {
    const item = state.items.get(id) ?? state.items.get(state.runs.get(id)?.item);
    if (item) {
      ids.add(item.id);
      // Child scope, review roles and unlinked questions affect readiness too.
      if (item.parent) ids.add(item.parent);
    }
  };
  for (const e of add) {
    for (const id of [e.id, e.item, e.run, e.blocker, e.blocked, e.parent, e.from, e.to]) include(id);
    if (e.type === 'item.updated' && Object.hasOwn(e.fields, 'parent')) {
      include(e.fields.parent); include(state.items.get(e.id)?.parent);
    }
  }
  return ids;
}

function openMembers(project, org, state, events, file) {
  let queue;
  try { queue = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (queue.identity !== project.identity || !Array.isArray(queue.pending) || !Array.isArray(queue.results) ||
      (queue.interrupted !== undefined && !Array.isArray(queue.interrupted))) throw Error('invalid queue identity or contents');
  const rows = new Map(), trains = new Map();
  const put = (job, result, batch) => {
    if (!job || typeof job.id !== 'string') throw Error('invalid queue job');
    rows.set(job.id, { job, result, batch });
  };
  const batchRows = batch => {
    if (!batch) return;
    if (!Object.hasOwn(batch, 'jobs')) {
      put(batch, batch.result ?? (batch.phase === 'promoted' ? { ...batch, outcome: 'promoted' } : null));
      return;
    }
    if (!Array.isArray(batch.jobs) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(batch.id)) throw Error('invalid queue batch');
    for (const job of batch.jobs) put(job, batch.results?.find(r => r.job.id === job.id)?.result, batch.id);
  };
  for (const result of queue.results) put(result, result, result.batch);
  for (const batch of queue.interrupted ?? []) batchRows(batch);
  batchRows(queue.current);
  for (const job of queue.pending) put(job, null);
  const found = [];
  for (const row of rows.values()) {
    const { job, batch } = row;
    let result = row.result;
    if (['refused', 'timeout'].includes(result?.outcome) || result?.reconciliation?.state === 'complete') continue;
    // A committed reconciliation can precede the queue acknowledgement. Its
    // completed batch must not depend on old train files remaining readable.
    if (batch && events.some(e => e.type === 'promotion.reconciled' && e.identity === project.identity && e.batch === batch)) continue;
    if (!job.run) continue;
    if (typeof job.org !== 'string' || !path.isAbsolute(job.org)) throw Error('queued run lacks an absolute record binding');
    if (fs.realpathSync(job.org) !== fs.realpathSync(org)) continue;
    if (batch) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(batch)) throw Error('invalid queue batch id');
      if (!trains.has(batch)) {
        const receipt = path.join(project.identity, 'promote/batches', batch, 'train.json');
        let train;
        try { train = JSON.parse(fs.readFileSync(receipt, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw Error(`unreadable batch ${batch} receipt ${receipt}: ${error.message}`); }
        if (train && (train.schema !== 'promotion-train/v1' || train.identity !== project.identity || train.id !== batch || !Array.isArray(train.jobs))) throw Error(`invalid promotion-train/v1 receipt for batch ${batch} (${receipt})`);
        trains.set(batch, train);
      }
      const train = trains.get(batch);
      if (train && !train.jobs.some(j => j.id === job.id && j.run === job.run && samePath(j.org, org))) throw Error(`train job ${job.id} binding differs from queue batch ${batch}`);
      result = train?.results?.[job.id] ? { ...result, ...train.results[job.id] } : result;
    }
    // A red batch undergoing bisection still has queued work. Only a terminal
    // refusal/timeout releases that job; its siblings keep their own guard.
    if (['refused', 'timeout'].includes(result?.outcome) || result?.reconciliation?.state === 'complete') continue;
    const run = state.runs.get(job.run);
    if (!run) throw Error(`unknown queued run ${job.run}`);
    if (events.some(e => e.type === 'promotion.reconciled' && e.identity === project.identity &&
        ((batch && e.batch === batch) || (result?.tip && e.heads?.some(h => h.item === run.item && h.run === run.id && h.head === result.tip))))) continue;
    found.push({ ...row, result, item: run.item, id: batch ?? job.id });
  }
  return found;
}

function integratedClose(member, project, add, closeRun) {
  // Legacy single-job completion has no batch receipt. Authority comes from the
  // queue's durable promoted checkpoint and integrated, queue-bound exact head,
  // never ORG_ACTOR, --note text, or the presence of --if-current-run alone.
  if (member.batch || member.result?.outcome !== 'promoted' || member.job.run !== closeRun ||
      member.result.tip !== member.job.expectedHead || add.length !== 1 ||
      add[0].type !== 'item.closed' || add[0].id !== member.item || add[0].as !== 'done') return false;
  const r = spawnSync('git', ['-C', project.canonical, 'merge-base', '--is-ancestor', member.result.tip, 'HEAD'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

export function protectRecordMutation({ org, state, events, mutation, command, completion, closeRun }) {
  const add = mutation?.add ?? [];
  if (!add.length || add.some(e => e.type === 'report.ingested')) return mutation;
  const touched = affectedItems(state, add);
  if (!touched.size) return mutation;
  let project, file, members;
  try {
    project = recordProject(org);
    if (!project) return mutation;
    file = path.join(project.identity, 'promote/queue.json');
    members = openMembers(project, org, state, events, file);
  } catch (error) {
    refused(`promotion write guard REFUSED (fail-closed): cannot read the project's promotion queue${file ? ` ${file}` : ''}: ${error.message}. Stale entries never expire; repair/inspect the queue before writing. ${advice}`);
  }
  const hits = members.filter(m => [m.item, ...blockersOf(state, m.item)].some(id => touched.has(id)));
  const overridden = [];
  for (const member of hits) {
    // complete-batch has already validated the supervisor-attested receipt and
    // derived this exact transaction under the record lock. Scope the exemption
    // to its identity and item/run coverage, including inspected manual recovery.
    if (completion?.identity === project.identity && samePath(completion.org, org) &&
        [...completion.items, ...completion.excluded].some(e => e.item === member.item && e.run === member.job.run)) continue;
    if (integratedClose(member, project, add, closeRun)) continue;
    if (process.env.ORG_GUARD_OVERRIDE === member.id) { overridden.push(member); continue; }
    refused(`promotion write guard REFUSED: ${member.item} belongs to open promotion ${member.batch ? 'batch' : 'queue job'} ${member.id} (${file}). Policy: fail-closed; stale open entries never expire. ${advice} Recovery only: ORG_GUARD_OVERRIDE=${member.id} (stderr and record audit).`);
  }
  if (!overridden.length) return mutation;
  const batches = [...new Set(overridden.map(m => m.id))], items = [...new Set(overridden.map(m => m.item))];
  process.stderr.write(sanitizeTerminal(`record: promotion write guard OVERRIDE ${batches.join(',')} on ${items.join(',')} (${command})\n`));
  return { ...mutation, add: [...add, { type: 'promotion.write-overridden', batches, items, command,
    override: process.env.ORG_GUARD_OVERRIDE, identity: project.identity, queue: file }] };
}
