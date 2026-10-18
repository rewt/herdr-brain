import { workerReceipt } from '../../lib/worker-identity.mjs';

export function sessionBindFact(run, { session = 'session', at = Date.now(), ...extra } = {}) {
  return { type: 'run.session_bound', run: run.id,
    dispatch: { journal: run.meta.dispatch_journal, attempt: run.meta.dispatch_attempt,
      project: run.meta.dispatch_project, record: run.meta.dispatch_record },
    receipt: workerReceipt(run), process: { pid: 123, identity: 'native birth' },
    prompted_at: new Date(at - 1000).toISOString(), deadline: new Date(at + 59000).toISOString(),
    observed_at: new Date(at).toISOString(), session, ...extra };
}
