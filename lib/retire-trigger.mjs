// Coalesced foreground hint. This is a request to re-observe authority, never
// stored eligibility/status, a schedule, or permission to replay an effect.
import fs from 'node:fs';
import path from 'node:path';
import { findOrgDir, writeFileAtomic } from './store.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';

export function requestRetirement({ org, cwd = process.cwd(), source, eventSeq, key } = {}) {
  org ??= findOrgDir({ cwd });
  if (!org) return;
  if (!(Number.isSafeInteger(eventSeq) && eventSeq > 0) && !key) throw Error('retirement request needs an event sequence or completion key');
  const file = path.join(org, 'retirement/request.json');
  const release = acquireLock(path.join(org, 'retirement/request.lock'), { waitMs: 1000 });
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
export function consumeRetirement({ org, retirement, output = () => {} }) {
  const file = path.join(org, 'retirement/request.json');
  if (!fs.existsSync(file)) return { handled: false };
  const release = acquireLock(path.join(org, 'retirement/consume.lock'));
  try {
    const hint = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (hint.schema !== 'retirement-request/v1' || !Number.isSafeInteger(hint.revision) || hint.revision < 1) throw Error('invalid retirement request');
    const handledFile = path.join(org, 'retirement/handled.json');
    const prior = fs.existsSync(handledFile) ? JSON.parse(fs.readFileSync(handledFile, 'utf8')) : null;
    if (prior?.revision >= hint.revision) return { handled: false, revision: hint.revision };
    const adapter = retirement();
    const plan = adapter.plan(), results = adapter.apply(plan);
    const receipt = { schema: 'retirement-handled/v1', revision: hint.revision, keep: plan.keep, results, diagnostics: plan.diagnostics };
    writeFileAtomic(handledFile, JSON.stringify(receipt) + '\n');
    output(receipt);
    return { handled: true, ...receipt };
  } finally { release(); }
}
