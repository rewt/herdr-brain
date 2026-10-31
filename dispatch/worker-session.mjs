// A foreground, read-only first action for new line workers. The saved proposal
// and journal status are diagnostics; only committed record identity is ready.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { loadRecord } from '../lib/store.mjs';
import { assertOwner, requireController } from '../lib/run-owner-guard.mjs';
import { dispatchSourceBinding } from '../lib/source-provenance.mjs';
import { effectiveWorkerIdentity, workerReceipt, WORKER_KEYS } from '../lib/worker-identity.mjs';
import { nativeSender } from '../messages/operator-inbox.mjs';
import { sourceConflict } from './journal-save.mjs';

export function workerSessionState({ id, journal, org, job, binding, events, state }) {
  const run = state.runs.get(id), project = binding.project, native = binding.native;
  if (!run || job.run !== id || job.org !== org || binding.org !== org ||
      job.common !== project.identity || job.workspace !== project.checkout ||
      path.dirname(journal) !== path.join(org, 'dispatch') || path.basename(journal) !== `${job.token}.json`)
    throw Error('worker session wait original project/record/run/journal differs');
  requireController(run, 'brain'); assertOwner(run, job.ownership);
  const source = dispatchSourceBinding({ run, events, identity: project.identity, org, workspace: project.checkout });
  if (source.journal !== journal || source.attempt !== job.token) throw Error('worker session wait original dispatch differs');
  const item = state.items.get(run.item);
  if (!item || item.closed || run.report || run.abandoned || item.runs.findLast(r => !state.runs.get(r)?.abandoned) !== id)
    throw Error('worker session wait run is no longer active');
  for (let current = item; current; current = state.items.get(current.parent))
    if (current.meta.hold) throw Error(`worker session wait HOLD on ${current.id}`);
  for (const marker of ['STOP', 'HOLD'])
    if (fs.existsSync(path.join(project.canonical, '.lane/supervisor', marker))) throw Error(`worker session wait ${marker}`);
  const receipt = workerReceipt(run, state), worker = effectiveWorkerIdentity(run, state);
  if (!receipt || WORKER_KEYS.some(k => (receipt[k] ?? null) !== (run.meta[k] ?? null)) || worker.identity_conflict ||
      !native.agent_session?.value ||
      worker.agent !== native.name || worker.agent !== job.worker?.agentName ||
      worker.pane !== native.pane_id || worker.pane !== job.worker.pane ||
      worker.worker_workspace !== native.workspace_id || worker.worker_workspace !== job.worker.workspaceId ||
      worker.terminal_id !== native.terminal_id || worker.terminal_id !== job.worker.terminalId)
    throw Error('worker session wait native worker or immutable launch receipt differs');
  const anchor = { ...source, agent: worker.agent, pane: worker.pane, terminal: worker.terminal_id,
    session: native.agent_session.value, receipt_seq: receipt.seq };
  if (job.sessionBinding?.record_refusal) throw Error(`worker session wait original binding stopped: ${job.sessionBinding.reason ?? 'record refusal'}`);
  if (worker.agent_session_id) {
    if (worker.agent_session_id !== native.agent_session.value) throw Error('worker session wait native session changed');
    const event = state.sessionBindings.get(id)?.[0];
    if (event || job.workerSessionWaitProtocol !== 2)
      return { status: 'ready', run: id, session: worker.agent_session_id,
        event_seq: event?.seq ?? receipt.seq, anchor };
  }
  if (job.sessionBinding?.status === 'unbound')
    throw Error(`worker session wait original binding stopped: ${job.sessionBinding.reason ?? 'unbound'}`);
  return { status: 'pending', run: id, anchor };
}

export function readWorkerSession({ id, journal, org, cwd = process.cwd(), env = process.env, call }) {
  org = fs.realpathSync(org); journal = fs.realpathSync(journal);
  const binding = nativeSender(org, { cwd, env, ...(call ? { call } : {}) });
  const job = JSON.parse(fs.readFileSync(journal, 'utf8')), loaded = loadRecord(org);
  if (loaded.tornTail) throw Error('worker session wait record has an incomplete tail');
  return workerSessionState({ id, journal, org, job, binding, ...loaded });
}

export async function waitForWorkerSession({ inspect, timeoutMs = 60000, now = () => performance.now(),
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const deadline = now() + timeoutMs;
  let anchor, result = { status: 'pending' };
  do {
    try {
      result = inspect();
      if (anchor && JSON.stringify(result.anchor) !== anchor) throw Error('worker session wait original binding changed while waiting');
      anchor ??= JSON.stringify(result.anchor);
      if (result.status === 'ready') return result;
    } catch (error) {
      if (!sourceConflict(error)) throw error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) return result;
    await pause(Math.min(1000, remaining));
  } while (true);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: {
      run: { type: 'string' }, journal: { type: 'string' }, org: { type: 'string' },
    } });
    if (positionals.length || !opt.run || !opt.journal || !opt.org) throw Error('usage: worker-session.mjs --run R-n --journal FILE --org DIR');
    const result = await waitForWorkerSession({ inspect: () => readWorkerSession({ id: opt.run, journal: opt.journal, org: opt.org }) });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.status === 'ready' ? 0 : 3;
  } catch (error) { process.stderr.write(`worker-session: ${error.message}\n`); process.exitCode = 1; }
}
