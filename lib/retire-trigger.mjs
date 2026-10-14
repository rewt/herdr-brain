// Coalesced foreground hint. This is a request to re-observe authority, never
// stored eligibility/status, a schedule, or permission to replay an effect.
import fs from 'node:fs';
import path from 'node:path';
import { findOrgDir, loadEvents, writeFileAtomic } from './store.mjs';

export function requestRetirement({ org, cwd = process.cwd(), source } = {}) {
  org ??= findOrgDir({ cwd });
  if (!org) return;
  const loaded = loadEvents(org);
  if (loaded.tornTail) throw Error('incomplete record tail; retirement request deferred');
  const revision = loaded.events.at(-1)?.seq ?? 0;
  const file = path.join(org, 'retirement/request.json');
  let prior;
  try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (prior?.revision > revision || (prior?.revision === revision && prior.source === source)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ schema: 'retirement-request/v1', revision, source }) + '\n');
}
