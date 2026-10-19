// Immutable evidence for a validated lane review, independent of the event log.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const reviewVerdictId = r => createHash('sha256').update(JSON.stringify([
  r.common, r.run, r.pane, r.terminal, r.session, r.workspace, r.cwd, r.agent,
])).digest('hex');

export function readReviewVerdicts(org, common) {
  if (!org) return [];
  const directory = path.join(org, 'retirement/reviews');
  let files;
  try { files = fs.readdirSync(directory); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return files.filter(file => file.endsWith('.json')).map(file => {
    const r = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    if (r?.schema !== 'retirement-review/v1' || !['PASS', 'NEEDS-WORK', 'FAIL'].includes(r.verdict) ||
        ['common', 'run', 'pane', 'terminal', 'session', 'workspace', 'cwd', 'agent', 'evidence'].some(k => typeof r[k] !== 'string' || !r[k]) ||
        !Number.isSafeInteger(r.record_seq) || r.record_seq < 1 || !Number.isFinite(Date.parse(r.at)) || !/^[a-f\d]{40}$/i.test(r.head ?? '') ||
        !/^[a-f\d]{64}$/i.test(r.sha256 ?? '') || r.id !== reviewVerdictId(r) || file !== `${r.id}.json`)
      throw Error(`invalid reviewer verdict receipt ${file}`);
    return r;
  }).filter(r => r.common === common).sort((a, b) => a.record_seq - b.record_seq || Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}
