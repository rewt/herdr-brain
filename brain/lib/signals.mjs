// Foreground, model-free distillation input. Record reads only; cursor and
// pending pass receipts belong to Brain, never to events.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadEvents, writeFileAtomic } from '../../lib/store.mjs';
import { fold, lessonState } from '../../lib/state.mjs';

// Brain's own state directory; never the record.
const STATE = process.env.BRAIN_STATE ?? path.join(os.homedir(), '.local', 'state', 'herdr-brain');

const hash = value => createHash('sha256').update(value).digest('hex');
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
const cut = (value, n) => {
  const text = clean(value);
  if (text.length <= n) return text;
  return text.slice(0, n - 2).replace(/[\uD800-\uDBFF]$/, '') + '…';
};
const ref = evidence => evidence.kind === 'event' ? `event:${evidence.seq}` : evidence.id;
const strings = value => Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];
const start = () => ({ seq: 0, offset: 0, hash: hash('') });

function fingerprints(events) {
  const hashes = new Map([[0, hash('')]]), digest = createHash('sha256');
  let last = 0;
  for (const e of events) {
    if (!Number.isSafeInteger(e.seq) || e.seq <= last) throw new Error('record event sequence must increase');
    last = e.seq;
    digest.update(JSON.stringify(e) + '\n');
    hashes.set(e.seq, digest.copy().digest('hex'));
  }
  return hashes;
}
function validateCursor(cursor, hashes) {
  if (!Number.isSafeInteger(cursor?.seq) || cursor.seq < 0 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 ||
      hashes.get(cursor.seq) !== cursor.hash) throw new Error('record changed or distillation cursor is invalid; inspect Brain state');
}
function selectors(text, item, run) {
  // Literal relative paths only. Scope comes from explicit metadata, the signal,
  // then report artifacts; titles and filesystem contents never infer relevance.
  const extract = value => (String(value ?? '').match(/(?:\.?\/?[\w.-]+\/)+[\w.-]+/g) ?? [])
    .filter(p => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('://'));
  const paths = [...new Set(extract(text))];
  if (!paths.length) {
    for (const p of [...strings(item?.meta?.paths), ...strings(run?.meta?.paths), ...strings(run?.report?.artifacts).flatMap(extract)]) {
      if (typeof p === 'string' && !p.startsWith('/') && !p.split('/').includes('..')) paths.push(p);
    }
  }
  const bounded = [...new Set(paths)].slice(0, 4).map(p => cut(p, 120));
  const modules = [...new Set([...strings(item?.meta?.modules), ...strings(run?.meta?.modules)])];
  return { paths: bounded, module: cut(modules[0] ?? bounded[0]?.split('/')[0] ?? 'record', 80) };
}

function eventSignals(e, state, rounds, reviews) {
  const run = state.runs.get(e.run ?? e.id), item = state.items.get(run?.item ?? e.item ?? e.id);
  const rows = [];
  const add = (kind, text, extra = {}) => rows.push({ kind, text, ...extra });
  if (e.type === 'report.ingested') {
    for (const text of e.report?.learnings ?? []) if (typeof text === 'string' && text.trim()) add('learning', text);
  } else if (e.type === 'run.started' && rounds.get(e.seq) > 1) {
    add('rounds', `${e.item}: run ${e.id} is work round ${rounds.get(e.seq)} (run starts, not review rounds).`, { round: rounds.get(e.seq) });
  } else if (e.type === 'release.gate.finished' && e.gate?.result !== 'passed') {
    add('gate-failure', `${e.id}: ${e.gate?.result ?? 'unknown'} at ${e.gate?.stage ?? 'unknown stage'}; ${e.gate?.detail ?? 'cause not recorded'}`,
      { source: cut(e.gate?.log, 240), result: e.gate?.result ?? null });
  } else if (e.type === 'note.added') {
    const text = e.text ?? '';
    if (/(?:\bindependent review\b|\breview verdict\b|\bSettle:|\[(?:Major|Moderate|Minor)\])/i.test(text)) {
      const review = reviews.get(e.seq);
      add('review', review?.text ?? text, {
        verdict: review?.verdict ?? text.match(/\b(PASS|NEEDS-WORK|FAIL)\b/)?.[1] ?? null,
        ...(review?.source ? { source: review.source } : {}),
        ...(!review && /^Settle:/.test(text) ? { detail: 'Verified review body unavailable; inspect the recorded evidence before proposing.' } : {}),
      });
    }
    if (/\b(?:CI|gate|validation|preparation|prepare)\b[^\n]{0,100}\b(?:fail(?:ed|ure|ures)?|exited [1-9])\b/i.test(text) ||
        /\bfailed\b[^\n]{0,80}\b(?:CI|gate|validation)\b/i.test(text)) add('ci-failure', text);
    if (/\b(?:refus(?:ed|al)|rejected)\b/i.test(text)) add('refusal', text);
    if (/\b(?:retry|retries|retried)\b/i.test(text)) add('retry', text);
    if (/\boverrul(?:ing|e|ed)\b/i.test(text) && (e.kind === 'answer' || e.decision)) add('overrule', text);
  }
  return rows.map((row, i) => ({
    key: `${e.seq}:${i}`, seq: e.seq, at: e.at, kind: row.kind,
    evidence: [`event:${e.seq}`, ...(run ? [run.id] : []), ...(item ? [item.id] : [])],
    ...(run ? { run: run.id } : {}), ...(item ? { item: item.id } : {}),
    ...selectors(row.text, item, run), ...row, text: cut(row.text, 400),
    ...(clean(row.text).length > 400 ? { truncated: true } : {}),
  }));
}
function grouped(signals) {
  const groups = new Map();
  for (const signal of signals) {
    const key = `${signal.module}:${signal.kind}`;
    if (!groups.has(key)) groups.set(key, { module: signal.module, kind: signal.kind, signals: [] });
    groups.get(key).signals.push(signal);
  }
  return [...groups.values()];
}
function seal(digest) {
  const { pass: ignored, ...data } = digest;
  return { ...data, pass: hash(JSON.stringify(data)) };
}

export function buildDigest(events, { cursor = start(), limit = 40, maxChars = 24000, record = '', reviews = new Map() } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
  if (!Number.isSafeInteger(maxChars) || maxChars < 2048 || maxChars > 64000) throw new Error('max-chars must be an integer from 2048 to 64000');
  const hashes = fingerprints(events);
  validateCursor(cursor, hashes);
  const state = fold(events), rounds = new Map(), counts = new Map();
  for (const e of events) if (e.type === 'run.started') {
    const n = (counts.get(e.item) ?? 0) + 1;
    counts.set(e.item, n); rounds.set(e.seq, n);
  }
  // Coverage is explicit provenance, never inferred from a shared path or topic.
  const coverage = new Set([...state.lessons.values()]
    .filter(l => ['proposed', 'active'].includes(lessonState(l)))
    .flatMap(l => (l.evidence ?? []).map(ref)));
  let to = cursor, covered = 0, more = false;
  const selected = [], headSeq = events.at(-1)?.seq ?? 0;
  const output = () => seal({ schema: 'brain-distill/v1', record, from: cursor, to,
    head: { seq: headSeq, hash: hashes.get(headSeq) }, count: selected.length, covered, more, groups: grouped(selected) });
  outer: for (const e of events) {
    if (e.seq < cursor.seq) continue;
    const rows = eventSignals(e, state, rounds, reviews);
    const offset = e.seq === cursor.seq ? cursor.offset : 0;
    if (offset > rows.length) throw new Error('distillation cursor offset no longer matches the record');
    for (let i = offset; i < rows.length; i++) {
      const signal = rows[i];
      const next = { seq: e.seq, offset: i + 1, hash: hashes.get(e.seq) };
      if (signal.evidence.some(r => coverage.has(r))) { covered++; to = next; continue; }
      if (selected.length >= limit) { more = true; break outer; }
      const prior = to;
      selected.push(signal); to = next;
      if (JSON.stringify(output(), null, 2).length > maxChars) {
        selected.pop(); to = prior; more = true;
        if (!selected.length) throw new Error('max-chars is too small for this signal and record identity');
        break outer;
      }
    }
    to = { seq: e.seq, offset: rows.length, hash: hashes.get(e.seq) };
  }
  const result = output();
  if (JSON.stringify(result, null, 2).length > maxChars) throw new Error('max-chars is too small for digest metadata');
  return result;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function reviewEvidence(events, orgDir) {
  const state = fold(events), reviews = new Map();
  for (const e of events) {
    if (e.type !== 'note.added' || !/^Settle:/.test(e.text ?? '') || !/^R-\d+$/.test(e.id)) continue;
    const file = path.join(orgDir, 'settle', `${e.id}.json`);
    try {
      const named = e.text.match(/Evidence: (.+)$/)?.[1];
      if (!named || fs.realpathSync(named) !== file) continue;
      // Do not follow arbitrary paths embedded in prose. Only the selected
      // record's named settle receipt can supplement its linked note.
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      const receipt = readJson(file), run = state.runs.get(e.id), review = receipt.review;
      if (receipt.run !== run?.id || receipt.item !== run.item || fs.realpathSync(receipt.org) !== orgDir ||
          receipt.settleDecision !== e.text ||
          !run.report?.sha256 || receipt.reportHash !== run.report.sha256 ||
          !['PASS', 'NEEDS-WORK', 'FAIL'].includes(review?.verdict) || typeof review.text !== 'string' ||
          hash(review.text) !== review.sha256) continue;
      const findings = review.text.match(/## Findings\r?\n([\s\S]*?)(?:\r?\n## |$)/)?.[1]?.trim();
      reviews.set(e.seq, { verdict: review.verdict, text: findings && findings !== 'None' ? findings : `Review ${review.verdict}: no recorded findings.`, source: cut(file, 240) });
    } catch { /* Retain the note and mark the missing enrichment explicitly. */ }
  }
  return reviews;
}

export function recordDigest({ orgDir, stateDir = STATE, limit, maxChars, ack } = {}) {
  if (!orgDir) throw new Error('usage: brain digest --org DIR [--limit N] [--max-chars N] [--json] [--ack PASS]');
  const record = fs.realpathSync(orgDir);
  const dir = path.join(stateDir, 'distill', hash(record));
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'lock');
  try { fs.mkdirSync(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`distillation state is busy; inspect ${lock}`); throw error; }
  try {
    const { events, tornTail } = loadEvents(record);
    if (tornTail) throw new Error('record has an incomplete event tail; retry after the record writer completes');
    const hashes = fingerprints(events), cursorFile = path.join(dir, 'cursor.json'), pendingFile = path.join(dir, 'pending.json');
    const cursor = readJson(cursorFile, start());
    validateCursor(cursor, hashes);
    if (ack) {
      const pending = readJson(pendingFile, null);
      if (!pending || pending.pass !== ack || seal(pending).pass !== ack || pending.record !== record ||
          ![pending.from, pending.to].some(c => JSON.stringify(c) === JSON.stringify(cursor))) throw new Error('ack does not match the current pending pass');
      if (hashes.get(pending.head.seq) !== pending.head.hash) throw new Error('record changed since the pending pass');
      validateCursor(pending.to, hashes);
      writeFileAtomic(cursorFile, JSON.stringify(pending.to) + '\n', 0o600);
      return { acknowledged: ack, cursor: pending.to };
    }
    const digest = buildDigest(events, { cursor, limit, maxChars, record, reviews: reviewEvidence(events, record) });
    writeFileAtomic(pendingFile, JSON.stringify(digest, null, 2) + '\n', 0o600);
    return digest;
  } finally { fs.rmdirSync(lock); }
}

export function renderDigest(d) {
  if (d.acknowledged) return `Acknowledged ${d.acknowledged}\n`;
  // Text is a concise view of the same bounded JSON payload.
  const lines = [`Record signal digest — ${d.count} signals; ${d.covered} covered; ${d.more ? 'more pending' : 'caught up'}`, `Pass: ${d.pass}`, `Record: ${d.record}`];
  for (const group of d.groups) {
    lines.push(`\n${group.module} / ${group.kind}`);
    for (const s of group.signals) lines.push(`- ${s.evidence.join(', ')}${s.verdict ? ` [${s.verdict}]` : ''}: ${s.text}${s.truncated ? ' [excerpt; read original]' : ''}${s.source ? ` (evidence: ${s.source})` : ''}${s.detail ? ` (${s.detail})` : ''}`);
  }
  lines.push('\nRead brain/distill.md with this digest. Propose only; acknowledge after supervisor review.');
  return lines.join('\n') + '\n';
}
