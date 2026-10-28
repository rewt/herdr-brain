// Structured record verdicts, with immutable receipt compatibility for older readers.
import fs from './record-observation.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadEvents } from './store.mjs';

export const reviewVerdictId = r => createHash('sha256').update(JSON.stringify([
  r.common, r.run, r.pane, r.terminal, r.session, r.workspace, r.cwd, r.agent,
])).digest('hex');
const validReview = r => r?.schema === 'retirement-review/v1' && ['PASS', 'NEEDS-WORK', 'FAIL'].includes(r.verdict) &&
  ['common', 'run', 'pane', 'terminal', 'session', 'workspace', 'cwd', 'agent', 'evidence'].every(k => typeof r[k] === 'string' && r[k]) &&
  Number.isSafeInteger(r.record_seq) && r.record_seq > 0 && Number.isFinite(Date.parse(r.at)) && /^[a-f\d]{40}$/i.test(r.head ?? '') &&
  /^[a-f\d]{64}$/i.test(r.sha256 ?? '') && r.id === reviewVerdictId(r);

export function readReviewVerdicts(org, common) {
  if (!org) return [];
  const directory = path.join(org, 'retirement/reviews');
  let files;
  try { files = fs.readdirSync(directory); } catch (e) { if (e.code === 'ENOENT') files = []; else throw e; }
  const legacy = files.filter(file => file.endsWith('.json')).map(file => {
    const r = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    if (!validReview(r) || file !== `${r.id}.json`)
      throw Error(`invalid reviewer verdict receipt ${file}`);
    return r;
  });
  let loaded;
  try { loaded = loadEvents(org); }
  catch (e) { if (e.code === 'ENOENT') loaded = { events: [], tornTail: false }; else throw e; }
  const { events, tornTail } = loaded;
  if (tornTail) throw Error('incomplete review verdict record');
  const recorded = events.filter(e => e.type === 'review.verdict' && e.common === common).map(e => {
    const r = e.review;
    if (!validReview(r) || r.common !== common || r.run !== e.run || r.head !== (e.reviewed_head ?? e.head) || r.record_seq !== e.seq ||
        typeof r.followup_expected !== 'boolean' || [r.process, r.shell].some(p => !Number.isSafeInteger(p?.pid) || p.pid < 1 ||
          ['identity', 'command'].some(k => typeof p[k] !== 'string' || !p[k]))) throw Error('invalid review.verdict event');
    const ended = events.findLast(event => event.type === 'review.followup-ended' && event.review_id === r.id && event.run === r.run && event.seq > e.seq);
    return ended ? { ...r, followup_expected: false, followup_ended_seq: ended.seq } : r;
  });
  return [...new Map([...legacy, ...recorded].filter(r => r.common === common).map(r => [r.id, r])).values()]
    .sort((a, b) => a.record_seq - b.record_seq || Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}
