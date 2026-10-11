// Native queue completion uses the existing guarded record transaction. No
// model, event-log append, validation, integration or lane cleanup happens here.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findOrgDir, loadEvents } from '../lib/store.mjs';
import { writeFileAtomic, readPlainFile } from '../lib/files.mjs';
import { fold } from '../lib/state.mjs';
import { completionFingerprint, completionEvents, digest, stable } from '../lib/completion.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { verifyTrainResult } from './evidence.mjs';

const RECORD = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
function git(canonical, args) {
  const r = spawnSync('git', ['--no-optional-locks', '-C', canonical, ...args], { encoding: 'utf8', timeout: 30000 });
  if (r.error || r.status !== 0) throw Error(r.stderr || r.error?.message || 'completion Git proof refused');
  return r.stdout.trim();
}
function recordFor(canonical, org) {
  const discovered = findOrgDir({ cwd: canonical, env: { ...process.env, ORG_DIR: '' } });
  if (!discovered || fs.realpathSync(discovered) !== fs.realpathSync(org)) throw Error('queue record differs from canonical project record');
  return fs.realpathSync(org);
}
export function captureCompletionMember({ canonical, identity, job, prepared, excluded = [] }) {
  if (!job.run || !job.org || !job.expectedHead) throw Error('recorded member needs an explicit run, record and reviewed head');
  const org = recordFor(canonical, job.org);
  if (prepared.org && prepared.org !== org) throw Error('native completion requires one canonical project record');
  const { events, tornTail } = loadEvents(org);
  if (tornTail) throw Error('incomplete record tail before batch preparation');
  const state = fold(events), run = state.runs.get(job.run), item = state.items.get(run?.item);
  if (!run || !item) throw Error('unknown or missing batch item/run');
  if (prepared.jobs.some(b => b.job !== job.id && b.item === item.id)) throw Error('duplicate batch item/run');
  const prior = prepared.jobs.find(b => b.job === job.id);
  const binding = prior ?? { job: job.id, item: item.id, run: run.id,
    expected: completionFingerprint(state, item.id), superseded: job.superseded ?? [] };
  prepared.org = org;
  if (!prior) prepared.jobs.push(binding);
  // Derive the real transaction before a gate. Placeholder Git/gate values are
  // opaque to the core; original fingerprints are never refreshed on retry.
  completionEvents(state, events, { version: 1, batch: `native-prepare-${job.id}`, org, identity,
    base: prepared.base, tip: job.expectedHead,
    gate: { exit_code: 0, log: path.join(canonical, '.lane/native-preparation.log'), sha256: '0'.repeat(64) },
    items: [{ ...binding, head: job.expectedHead, why: `Queue-bound reviewed head for ${job.id}.` }], excluded }, org);
  return binding;
}

// A later manual transaction may resolve an interrupted native receipt after
// inspection. Require exact run/head coverage, explicit superseded attempts and
// historical exclusions, never merely a closed item or an ancestor commit.
function recoveryMarker(events, payload) {
  const original = events.find(e => e.type === 'promotion.reconciled' && e.identity === payload.identity && e.batch === payload.batch);
  return events.find(e => e.type === 'promotion.reconciled' && e.identity === payload.identity &&
    e.batch !== payload.batch && (!original || e.seq > original.seq) && e.gate?.exit_code === 0 &&
    payload.items.every(item => e.heads?.some(h => h.item === item.item && h.run === item.run && h.head === item.head) &&
      item.superseded.every(id => e.superseded?.includes(id))) &&
    payload.excluded.every(item => e.historical_exclusions?.some(h => h.item === item.item && h.run === item.run)));
}

export function reconcileBatchCompletion({ project, jobs, results }) {
  const promoted = results.filter(member => member.result.outcome === 'promoted');
  if (!promoted.length) return { results, pending: false };
  const file = promoted[0].result.receipt;
  try {
    const train = JSON.parse(readPlainFile(file)), prepared = train.completion;
    if (train.schema !== 'promotion-train/v1' || train.identity !== project.identity || train.phase !== 'complete') throw Error('train completion evidence is missing or incomplete');
    if (prepared?.git_only && jobs.every(j => !j.run)) return { results, pending: false };
    if (!prepared || prepared.version !== 1 || prepared.identity !== project.identity || prepared.canonical !== project.canonical || prepared.branch !== git(project.canonical, ['symbolic-ref', '--short', 'HEAD'])) throw Error('batch lacks original record preparation; use the guarded manual recovery path');
    const org = recordFor(project.canonical, prepared.org);
    if (new Set(jobs.map(j => j.id)).size !== jobs.length || results.length !== jobs.length || prepared.jobs.length + (prepared.refused?.length ?? 0) !== jobs.length || train.jobs.length !== jobs.length) throw Error('completion is missing a batch member');
    const entries = jobs.map(job => {
      const binding = prepared.jobs.find(b => b.job === job.id), captured = train.jobs.find(j => j.id === job.id);
      const member = results.filter(m => m.job.id === job.id);
      if (!binding && prepared.refused?.includes(job.id) && member.length === 1 && member[0].result.outcome === 'refused' && train.results[job.id]?.outcome === 'refused') return null;
      if (!binding || member.length !== 1 || captured?.run !== binding.run || job.run !== binding.run || captured.topic !== job.topic || captured.expectedHead !== job.expectedHead || fs.realpathSync(job.org) !== org) throw Error('batch member or run binding changed');
      return { job, binding, result: member[0].result };
    }).filter(Boolean);
    const release = acquireLock(path.join(project.identity, 'lane-promote.lock'));
    try {
      if (fs.existsSync(path.join(project.canonical, '.lane/supervisor/STOP'))) throw Error('supervisor STOP prevents completion');
      if (git(project.canonical, ['status', '--porcelain'])) throw Error('canonical checkout is dirty');
      const integrated = train.attempts.filter(a => ['integrated', 'complete'].includes(a.phase) && a.gate?.exit_code === 0);
      const tip = integrated.at(-1)?.tip;
      if (!tip) throw Error('no integrated green attempt');
      git(project.canonical, ['merge-base', '--is-ancestor', prepared.base, tip]);
      git(project.canonical, ['merge-base', '--is-ancestor', tip, 'HEAD']);
      const included = [], excluded = [];
      for (const { job, binding, result } of entries) {
        if (result.outcome !== 'promoted') {
          excluded.push({ item: binding.item, run: binding.run, superseded: [], disposition: 'historical',
            reason: result.reason || result.outcome, next_action: `Inspect retained lane ${job.topic}, resolve ${result.outcome}, then authorize a new queue request.` });
          continue;
        }
        if (result.receipt !== file || !verifyTrainResult({ ...result, id: job.id }, { project, saved: { head: job.expectedHead, run: job.run, org: job.org, lane: job.topic } })) throw Error(`integrated proof differs for ${job.topic}`);
        git(project.canonical, ['merge-base', '--is-ancestor', result.tip, tip]);
        included.push({ item: binding.item, run: binding.run, expected: binding.expected, superseded: binding.superseded,
          head: result.tip, why: `Native queue ${job.id}: queue-bound head ${job.expectedHead}; preserved diff and successful gate in train ${train.id}.` });
      }
      const bytes = fs.readFileSync(promoted[0].result.log);
      if (!bytes.length) throw Error('train log is empty');
      const payload = { version: 1, batch: train.id, org, identity: project.identity, base: prepared.base, tip,
        gate: { exit_code: 0, log: promoted[0].result.log, sha256: createHash('sha256').update(bytes).digest('hex'),
          attempts: integrated.map(a => ({ base: a.base, tip: a.tip, gate: a.gate, jobs: a.ids })) },
        items: included, excluded };
      const receipt = file + '.record.json';
      if (fs.existsSync(receipt) && stable(JSON.parse(readPlainFile(receipt))) !== stable(payload)) throw Error('completion evidence changed; retain the original receipt');
      if (!fs.existsSync(receipt)) writeFileAtomic(receipt, JSON.stringify(payload, null, 2) + '\n', 0o600);
      const loaded = loadEvents(org);
      if (loaded.tornTail) throw Error('incomplete record tail during completion');
      const recovered = recoveryMarker(loaded.events, payload);
      if (recovered) {
        git(project.canonical, ['merge-base', '--is-ancestor', payload.tip, recovered.tip]);
        git(project.canonical, ['merge-base', '--is-ancestor', recovered.tip, 'HEAD']);
        const reconciliation = { state: 'complete', batch: train.id, receipt, fingerprint: digest(payload),
          recovered: { batch: recovered.batch, fingerprint: recovered.fingerprint } };
        return { pending: false, results: results.map(member => member.result.outcome === 'promoted'
          ? { ...member, result: { ...member.result, reconciliation } } : member) };
      }
      const reply = spawnSync(process.execPath, [RECORD, 'complete-batch', '--file', receipt], {
        cwd: project.canonical, env: { ...process.env, ORG_DIR: org, ORG_ACTOR: 'promotion-queue' }, encoding: 'utf8', timeout: 30000 });
      if (reply.error || reply.status !== 0) throw Error(reply.stderr || reply.error?.message || reply.stdout || 'record completion refused');
      const accepted = JSON.parse(reply.stdout);
      const reconciliation = { state: 'complete', batch: train.id, receipt, fingerprint: digest(payload), replayed: accepted.replayed };
      return { results: results.map(member => member.result.outcome === 'promoted' ? { ...member, result: { ...member.result, reconciliation } } : member), pending: false };
    } finally { release(); }
  } catch (error) {
    const reason = `integrated; reconciliation pending: ${String(error.message).trim()}; lanes and successful gate retained; resume --drain for bookkeeping only`;
    return { pending: true, reason, results: results.map(member => member.result.outcome === 'promoted' ? { ...member,
      result: { ...member.result, reason, reconciliation: { state: 'pending', receipt: file + '.record.json', reason } } } : member) };
  }
}

export function recordedBatchCompletion({ result, project, run }) {
  const completion = result.reconciliation;
  if (completion?.state !== 'complete' || completion.receipt !== result.receipt + '.record.json') return false;
  const payload = JSON.parse(readPlainFile(completion.receipt));
  if (payload.identity !== project.identity || payload.org !== project.org || payload.batch !== result.batch || digest(payload) !== completion.fingerprint || !payload.items.some(e => e.run === run.id && e.item === run.item && e.head === result.tip)) return false;
  const { events, tornTail } = loadEvents(project.org);
  if (tornTail) return false;
  if (completion.recovered) {
    const marker = recoveryMarker(events, payload);
    return marker?.batch === completion.recovered.batch && marker?.fingerprint === completion.recovered.fingerprint;
  }
  return events.some(e => e.type === 'promotion.reconciled' && e.identity === project.identity && e.batch === payload.batch && e.fingerprint === completion.fingerprint);
}
