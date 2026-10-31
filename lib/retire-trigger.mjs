// Coalesced foreground hint. This is a request to re-observe authority, never
// stored eligibility/status, a schedule, or permission to replay an effect.
import fs from 'node:fs';
import path from 'node:path';
import { findOrgDir, writeFileAtomic } from './store.mjs';
import { retirementLock, retirementDeadline } from './retire-lock.mjs';
import { lookupProcess } from './processes.mjs';
import { closeoutPolicy, kickCloseout } from './closeout.mjs';

export function requestRetirement({ org, cwd = process.cwd(), source, eventSeq, key } = {}) {
  org ??= findOrgDir({ cwd });
  if (!org) return;
  if (!(Number.isSafeInteger(eventSeq) && eventSeq > 0) && !key) throw Error('retirement request needs an event sequence or completion key');
  const file = path.join(org, 'retirement/request.json');
  const release = retirementLock(path.join(org, 'retirement/request.lock'), { waitMs: 1000 });
  try {
    let prior;
    try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (key ? prior?.key === key : (prior?.event_seq ?? prior?.revision ?? 0) >= eventSeq) return;
    const revision = Math.max((prior?.revision ?? 0) + 1, eventSeq ?? 0);
    writeFileAtomic(file, JSON.stringify({ schema: 'retirement-request/v1', revision,
      event_seq: Math.max(prior?.event_seq ?? 0, eventSeq ?? 0), source, ...(key ? { key } : {}) }) + '\n');
  } finally { release(); }
}

// Finite foreground catch-up. The handled receipt acknowledges an observation,
// never eligibility. A newer hint written during apply remains pending.
export function consumeRetirement({ org, retirement, output = () => {}, deadline = Infinity }) {
  const file = path.join(org, 'retirement/request.json');
  if (!fs.existsSync(file)) return { handled: false };
  const readProcess = pid => lookupProcess(pid, { identityOnly: true,
    allowance: ms => Math.min(ms, Math.max(1, deadline - Date.now())), pause: () => {},
  });
  let release, hint;
  try {
    release = retirementLock(path.join(org, 'retirement/consume.lock'), { deadline, readProcess });
    hint = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (hint.schema !== 'retirement-request/v1' || !Number.isSafeInteger(hint.revision) || hint.revision < 1) throw Error('invalid retirement request');
    const handledFile = path.join(org, 'retirement/handled.json');
    const prior = fs.existsSync(handledFile) ? JSON.parse(fs.readFileSync(handledFile, 'utf8')) : null;
    if (prior?.revision >= hint.revision) return { handled: false, revision: hint.revision };
    if (Date.now() >= deadline) throw retirementDeadline();
    const adapter = retirement({ deadline });
    if (adapter.canonical && closeoutPolicy(adapter.canonical, undefined, { requireServiceSource: false })) {
      kickCloseout({ canonical: adapter.canonical, identity: adapter.common }, org);
      return { handled: false, owner: 'closeout-queue' };
    }
    const plan = adapter.plan(), results = adapter.apply(plan);
    const diagnostics = [...(plan.diagnostics ?? []), ...(adapter.diagnostics ?? [])];
    const held = adapter.hold?.() ?? plan.held ?? results.find(row => row.action === 'held')?.why;
    if (held) {
      const receipt = { handled: false, pending: true, action: 'held', reason: held, revision: hint.revision, results, keep: plan.keep, diagnostics };
      output(receipt);
      return receipt;
    }
    const deadlineDiagnostic = row => row.code === 'RETIREMENT_DEADLINE' || /retirement deadline reached/.test(row.reason ?? row.why ?? row.error ?? '');
    if (Date.now() >= deadline || results.some(result => result.action === 'deferred') || [...diagnostics, ...results].some(deadlineDiagnostic))
      return { handled: false, pending: true, revision: hint.revision, results, keep: plan.keep, diagnostics };
    const receipt = { schema: 'retirement-handled/v1', revision: hint.revision, keep: plan.keep, results, diagnostics };
    writeFileAtomic(handledFile, JSON.stringify(receipt) + '\n');
    output(receipt);
    return { handled: true, ...receipt };
  } catch (e) {
    if (e.code !== 'RETIREMENT_DEADLINE') throw e;
    return { handled: false, pending: true, revision: hint?.revision, reason: e.message };
  } finally { release?.(); }
}
