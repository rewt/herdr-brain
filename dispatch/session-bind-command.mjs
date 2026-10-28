import fs from '../lib/record-observation.mjs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findOrgDir, planTransaction, UserError, writer } from '../lib/store.mjs';
import { gitProject } from '../lib/project.mjs';
import { effectiveWorkerIdentity, validSessionBind, sharesWorker, sameReceipt } from '../lib/worker-identity.mjs';
import { bindCloseoutSources, publishCloseoutEvents } from '../lib/closeout.mjs';
import { validResumeDelivery } from './resume-delivery.mjs';
import { protectRecordMutation } from '../lib/record-guard.mjs';
const fields = ['type', 'run', 'dispatch', 'receipt', 'process', 'prompted_at', 'deadline', 'observed_at', 'session'];

// Dispatch is the sole caller/writer. This command consumes its saved proposal,
// never discovers a session or backfills an old run. Saved input and the entire
// record are fenced before append; replay only rederives this read-only plan.
export function sessionBindCommand(argv) {
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: { journal: { type: 'string' } } });
  if (positionals.length || !opt.journal) throw new UserError('usage: record session-bind --journal DISPATCH-JOURNAL');
  const org = fs.realpathSync(findOrgDir()), journal = fs.realpathSync(opt.journal), who = writer();
  const result = planTransaction(org, (events, state) => {
    const job = JSON.parse(fs.readFileSync(journal, 'utf8')), binding = job.sessionBinding, proposed = binding?.proposed;
    const run = state.runs.get(job.run);
    if (!run || job.org !== org || job.common !== gitProject(job.repo).identity ||
        fs.realpathSync(job.repo) !== job.repo || fs.realpathSync(job.workspace) !== run.workspace ||
        path.dirname(journal) !== path.join(org, 'dispatch') || job.stage !== 'complete' ||
        !['observing', 'bound', 'unbound'].includes(binding?.status) ||
        !proposed || Object.keys(proposed).some(k => !fields.includes(k)) || proposed.type !== 'run.session_bound' ||
        proposed.dispatch?.journal !== journal || proposed.dispatch.attempt !== job.token ||
        proposed.dispatch.project !== job.common || proposed.dispatch.record !== org ||
        proposed.prompted_at !== binding.prompted_at || proposed.deadline !== binding.deadline ||
        !sameReceipt(proposed.receipt, binding.receipt) ||
        JSON.stringify(proposed.process) !== JSON.stringify(binding.process) ||
        !validResumeDelivery(job, proposed) || !validSessionBind(run, proposed, state)) throw new UserError('session bind does not match the original dispatch and launch receipt');
    const prior = state.sessionBindings.get(run.id) ?? [];
    if (prior.length) {
      if (prior.length !== 1 || effectiveWorkerIdentity(run, state).identity_conflict ||
          Object.keys(proposed).some(k => JSON.stringify(proposed[k]) !== JSON.stringify(prior[0][k])))
        throw new UserError('run already has a different or conflicting session bind');
      return { add: [] }; // Lost reply remains recoverable after completion/deadline.
    }
    // validSessionBind checks the saved observation against the original window.
    // Record-lock/CLI latency must not turn a timely observation into a refusal.
    if ([...state.runs.values()].some(other => other.started.seq > run.started.seq &&
        (sharesWorker(run, other, state) || effectiveWorkerIdentity(other, state).agent_session_id === proposed.session)))
      throw new UserError('a newer run holds the worker occupant');
    return bindCloseoutSources({ cwd: job.repo, org, events, mutation:
      protectRecordMutation({ org, events, state, command: 'session-bind', mutation: { add: [proposed] } }) });
  }, { actor: who.actor, unattributed: who.unattributed, replaySafe: true });
  publishCloseoutEvents({ cwd: process.cwd(), org, added: result.added });
  process.stdout.write(JSON.stringify({ recorded: result.added.length > 0 }) + '\n');
  return 0;
}
