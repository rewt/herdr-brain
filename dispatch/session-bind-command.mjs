import fs from '../lib/record-observation.mjs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findOrgDir, planTransaction, UserError, writer } from '../lib/store.mjs';
import { gitProject } from '../lib/project.mjs';
import { effectiveWorkerIdentity, validSessionBind, sharesWorker, sameReceipt } from '../lib/worker-identity.mjs';
import { bindCloseoutSources, publishCloseoutEvents } from '../lib/closeout.mjs';
import { validResumeDelivery } from './resume-delivery.mjs';
import { protectRecordMutation } from '../lib/record-guard.mjs';
import { assertOwner, readOwnedRun } from '../lib/run-owner-guard.mjs';
import { requiresLaunchSessionBinding } from './session-bind.mjs';
const fields = ['type', 'run', 'dispatch', 'receipt', 'process', 'prompted_at', 'deadline', 'observed_at', 'session'];
const refuse = message => { throw Object.assign(new UserError(message), { sessionBindRefusal: true }); };

// Dispatch and line replay consume only the original saved proposal. This command
// never discovers a session or backfills an old run. Saved input and the entire
// record are fenced before append; replay only rederives this read-only plan.
export function sessionBindCommand(argv) {
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: { journal: { type: 'string' } } });
  if (positionals.length || !opt.journal) throw new UserError('usage: record session-bind --journal DISPATCH-JOURNAL');
  const org = fs.realpathSync(findOrgDir()), journal = fs.realpathSync(opt.journal), who = writer();
  let result;
  try {
    result = planTransaction(org, (events, state) => {
      const job = JSON.parse(fs.readFileSync(journal, 'utf8')), binding = job.sessionBinding, proposed = binding?.proposed;
      const run = state.runs.get(job.run);
      if (job.ownership) assertOwner(readOwnedRun(org, job.run, events), job.ownership);
      if (binding?.record_refusal) refuse('original session bind refusal is final');
      if (!run || job.org !== org || job.common !== gitProject(job.repo).identity ||
          fs.realpathSync(job.repo) !== job.repo || fs.realpathSync(job.workspace) !== run.workspace ||
          path.dirname(journal) !== path.join(org, 'dispatch') ||
          !(job.stage === 'complete' || job.stage === 'prompt' && requiresLaunchSessionBinding(job) && proposed?.session === job.worker.agentSessionId) ||
          !['observing', 'bound', 'unbound'].includes(binding?.status) ||
          !proposed || Object.keys(proposed).some(k => !fields.includes(k)) || proposed.type !== 'run.session_bound' ||
          proposed.dispatch?.journal !== journal || proposed.dispatch.attempt !== job.token ||
          proposed.dispatch.project !== job.common || proposed.dispatch.record !== org ||
          proposed.prompted_at !== binding.prompted_at || proposed.deadline !== binding.deadline ||
          !sameReceipt(proposed.receipt, binding.receipt) ||
          JSON.stringify(proposed.process) !== JSON.stringify(binding.process) ||
          !validResumeDelivery(job, proposed) || !validSessionBind(run, proposed, state)) refuse('session bind does not match the original dispatch and launch receipt');
      const prior = state.sessionBindings.get(run.id) ?? [];
      if (prior.length) {
        if (prior.length !== 1 || effectiveWorkerIdentity(run, state).identity_conflict ||
            Object.keys(proposed).some(k => JSON.stringify(proposed[k]) !== JSON.stringify(prior[0][k])))
          refuse('run already has a different or conflicting session bind');
        return { add: [], result: prior[0] }; // Exact lost reply after completion/deadline.
      }
      // validSessionBind checks the saved observation against the original window.
      // Record-lock/CLI latency must not turn a timely observation into a refusal.
      if ([...state.runs.values()].some(other => other.started.seq > run.started.seq &&
          (sharesWorker(run, other, state) || effectiveWorkerIdentity(other, state).agent_session_id === proposed.session)))
        refuse('a newer run holds the worker occupant');
      return bindCloseoutSources({ cwd: job.repo, org, events, mutation:
        protectRecordMutation({ org, events, state, command: 'session-bind', mutation: { add: [proposed] } }) });
    }, { actor: who.actor, unattributed: who.unattributed, replaySafe: true });
  } catch (error) {
    if (error.sessionBindRefusal || ['RUN_OWNED_ELSEWHERE', 'RUN_OWNER_UNCLAIMED', 'RUN_CLAIM_INVALID'].includes(error.code))
      process.stdout.write(JSON.stringify({ schema: 'dispatch-session-binding/v1', outcome: 'refused', code: 'SESSION_BIND_REFUSED' }) + '\n');
    throw error;
  }
  publishCloseoutEvents({ cwd: process.cwd(), org, added: result.added });
  const bound = result.added.find(e => e.type === 'run.session_bound') ?? result.result;
  process.stdout.write(JSON.stringify({ schema: 'dispatch-session-binding/v1', outcome: 'bound',
    run: bound.run, journal, attempt: bound.dispatch.attempt, session: bound.session,
    event_seq: bound.seq, recorded: result.added.length > 0 }) + '\n');
  return 0;
}
