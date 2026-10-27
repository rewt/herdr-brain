import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findOrgDir, transact, UserError, writer } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { gitProject } from '../lib/project.mjs';
import { effectiveWorkerIdentity, validSessionBind, sharesWorker, sameReceipt } from '../lib/worker-identity.mjs';
import { protectRecordMutation } from '../lib/record-guard.mjs';
export { recoverFinishedSessionBinding } from './session-bind-recovery.mjs';
import { recoverFinishedSessionBinding } from './session-bind-recovery.mjs';
const fields = ['type', 'run', 'dispatch', 'receipt', 'process', 'prompted_at', 'deadline', 'observed_at', 'session'];

// Ordinary dispatch consumes only its saved proposal. Explicit supervisor-only
// finished recovery has its own native/claim/source fences and immutable archive.
export function sessionBindCommand(argv) {
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: { journal: { type: 'string' }, 'recover-finished': { type: 'boolean' }, role: { type: 'string' },
      id: { type: 'string' }, 'decision-seq': { type: 'string' }, 'expected-head': { type: 'string' },
      'expected-source': { type: 'string' }, 'expected-session': { type: 'string' } } });
  if (positionals.length || !opt.journal) throw new UserError('usage: record session-bind --journal DISPATCH-JOURNAL');
  if (opt['recover-finished']) {
    const result = recoverFinishedSessionBinding({ org: findOrgDir(), journal: opt.journal, role: opt.role,
      id: opt.id, decisionSeq: Number(opt['decision-seq']), expectedHead: opt['expected-head'],
      expectedSource: opt['expected-source'], expectedSession: opt['expected-session'] });
    process.stdout.write(JSON.stringify(result) + '\n'); return 0;
  }
  if (Object.keys(opt).some(k => k !== 'journal')) throw new UserError('recovery options require --recover-finished');
  const org = fs.realpathSync(findOrgDir()), journal = fs.realpathSync(opt.journal), who = writer();
  const result = transact(org, events => {
    const job = JSON.parse(fs.readFileSync(journal, 'utf8')), binding = job.sessionBinding, proposed = binding?.proposed;
    const state = fold(events), run = state.runs.get(job.run);
    if (!run || job.org !== org || job.common !== gitProject(job.repo).identity ||
        fs.realpathSync(job.repo) !== job.repo || fs.realpathSync(job.workspace) !== run.workspace ||
        path.dirname(journal) !== path.join(org, 'dispatch') || job.stage !== 'complete' ||
        !['observing', 'bound'].includes(binding?.status) ||
        !proposed || Object.keys(proposed).some(k => !fields.includes(k)) || proposed.type !== 'run.session_bound' ||
        proposed.dispatch?.journal !== journal || proposed.dispatch.attempt !== job.token ||
        proposed.dispatch.project !== job.common || proposed.dispatch.record !== org ||
        proposed.prompted_at !== binding.prompted_at || proposed.deadline !== binding.deadline ||
        !sameReceipt(proposed.receipt, binding.receipt) ||
        JSON.stringify(proposed.process) !== JSON.stringify(binding.process) ||
        !validSessionBind(run, proposed, state)) throw new UserError('session bind does not match the original dispatch and launch receipt');
    const prior = state.sessionBindings.get(run.id) ?? [];
    if (prior.length) {
      if (prior.length !== 1 || effectiveWorkerIdentity(run, state).identity_conflict ||
          Object.keys(proposed).some(k => JSON.stringify(proposed[k]) !== JSON.stringify(prior[0][k])))
        throw new UserError('run already has a different or conflicting session bind');
      return { add: [] }; // Lost reply remains recoverable after completion/deadline.
    }
    if (run.report || run.abandoned) throw new UserError('session bind requires an open, unreported run');
    if (Date.now() > Date.parse(binding.deadline)) throw new UserError('dispatch session binding deadline expired');
    if ([...state.runs.values()].some(other => other.started.seq > run.started.seq &&
        (sharesWorker(run, other, state) || effectiveWorkerIdentity(other, state).agent_session_id === proposed.session)))
      throw new UserError('a newer run holds the worker occupant');
    return protectRecordMutation({ org, events, state, command: 'session-bind', mutation: { add: [proposed] } });
  }, { actor: who.actor, unattributed: who.unattributed });
  process.stdout.write(JSON.stringify({ recorded: result.added.length > 0 }) + '\n');
  return 0;
}
