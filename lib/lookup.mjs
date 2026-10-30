// Disposable projection of one record. No inferred decisions, confirmations or
// cross-record reads: relationships come from explicit source annotations.
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { findOrgDir, isOrgDir, loadRecordReader, UserError } from './store.mjs';
import { sanitizeTerminal } from './sanitize.mjs';

const kinds = ['decision', 'mistake', 'challenge', 'lesson', 'learning', 'note'];
const list = value => Array.isArray(value) ? value : value == null ? [] : [value];
const string = value => typeof value === 'string' ? value : '';
const refs = value => list(value).map(v => typeof v === 'string' ? v : v?.kind === 'event' ? `event:${v.seq}` : v?.id).filter(v => typeof v === 'string' && v.length);
const textOf = value => typeof value === 'string' ? value : string(value?.text) || JSON.stringify(value);

export function buildLookup(events, { at } = {}) {
  if (at != null && (!Number.isSafeInteger(at) || at < 0)) throw new UserError('--at must be a nonnegative safe sequence');
  const rows = [], byRef = new Map(), entities = new Set(), sequences = new Set(), runs = new Map(), lessons = new Map();
  const hash = createHash('sha256');
  let cutoff = 0, timestamp = null;
  function add(e, ref, kind, text, extra = {}, contract = {}) {
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) contract = {};
    const row = { ref, kind, text, item: runs.get(e.run ?? e.id) ?? e.id, run: e.run ?? (runs.has(e.id) ? e.id : null),
      source: { seq: e.seq, at: e.at, by: e.by, ...extra }, state: 'current',
      premise: string(contract.premise) || null, correction: string(contract.correction) || null,
      scope: string(contract.scope) || null, evidence_refs: refs(contract.evidence),
      failure_refs: refs(contract.failure_evidence), supersedes: refs(contract.supersedes), superseded_by: [],
      confirmation_requested: contract.confirmed_mistake === true, diagnostics: [] };
    rows.push(row); byRef.set(ref, row); return row;
  }
  for (const e of events) {
    if (at != null && e.seq > at) break;
    cutoff = e.seq; timestamp = e.at;
    hash.update(JSON.stringify(e) + '\n'); sequences.add(e.seq);
    if (['item.added', 'run.started', 'lesson.proposed'].includes(e.type)) entities.add(e.id);
    if (e.type === 'run.started') runs.set(e.id, e.item);
    if (e.type === 'note.added') {
      // An optional final line annotates an EXISTING note; it creates no new
      // ledger or event type, and malformed annotations remain visible.
      const match = /(?:^|\n)\[lookup\] (.+)\s*$/.exec(e.text ?? '');
      let contract = {}, error;
      if (match) {
        try { contract = JSON.parse(match[1]); if (!contract || typeof contract !== 'object' || Array.isArray(contract)) throw Error(); }
        catch { contract = {}; error = 'invalid lookup annotation'; }
      }
      {
        const row = add(e, `event:${e.seq}`, e.decision ? 'decision' : 'note', match ? e.text.slice(0, match.index) : e.text, {}, contract);
        if (error) row.diagnostics.push(error);
      }
    }
    if (e.type === 'report.ingested') {
      for (const [field, kind] of [['decisions', 'decision'], ['challenges', 'challenge'], ['learnings', 'learning']]) {
        const entries = field === 'learnings' ? e.report?.learnings : e.report?.extra?.[field];
        list(entries).forEach((entry, index) => {
          const row = add(e, `event:${e.seq}/${field}/${index}`, kind, textOf(entry),
            { file: e.file ?? null, sha256: e.sha256 ?? null, archive_status: 'not-checked', field, index }, entry?.lookup ?? {});
          if (entry && typeof entry === 'object') {
            const { lookup, ...context } = entry;
            row.context = context;
          }
        });
      }
    }
    if (e.type === 'lesson.proposed') {
      const row = add(e, e.id, 'lesson', e.text, {}, { evidence: e.evidence, scope: e.scope });
      row.state = 'proposed'; row.paths = e.paths ?? []; row.modules = e.modules ?? []; row.item = null;
      lessons.set(e.id, row);
    }
    const lesson = lessons.get(e.id);
    if (lesson && e.type === 'lesson.activated' && !lesson.superseded_by.length) lesson.state = 'current';
    if (lesson && e.type === 'lesson.retired') { lesson.state = 'retired'; lesson.retirement = { ref: `event:${e.seq}`, reason: e.reason }; }
    if (lesson && e.type === 'lesson.superseded') {
      lesson.superseded_by.push(e.by_lesson); lesson.state = 'superseded';
      lesson.supersession = { ref: `event:${e.seq}`, reason: e.reason };
    }
  }
  if (at != null && cutoff !== at) throw new UserError(`sequence ${at} is not present in this record`);
  const resolve = ref => ({ ref, status: byRef.has(ref) || entities.has(ref) ||
    (/^event:[1-9]\d*$/.test(ref) && sequences.has(Number(ref.slice(6)))) ? 'present' :
    /^(?:event:\d+(?:\/\w+\/\d+)?|[A-Z]+-\d+)$/.test(ref) ? 'missing' : 'external-unverified' });
  for (const row of rows) {
    row.evidence = row.evidence_refs.map(resolve); row.failure_evidence = row.failure_refs.map(resolve);
    delete row.evidence_refs; delete row.failure_refs;
    if (!row.evidence.length && !row.failure_evidence.length) row.diagnostics.push('no explicit evidence references');
    // An ordinary challenge, red test or lesson is never itself confirmation.
    // This is the source author's explicit assertion, not a proof of causality.
    if (row.confirmation_requested) {
      if (['decision', 'challenge'].includes(row.kind) && row.premise && row.correction && row.scope &&
          row.failure_evidence.length && row.failure_evidence.every(r => r.status === 'present')) row.kind = 'mistake';
      else row.diagnostics.push('confirmation incomplete: require premise, correction, scope and present failure evidence');
    }
    delete row.confirmation_requested;
    row.supersedes = row.supersedes.map(ref => {
      const target = byRef.get(ref);
      const valid = target && target.source.seq < row.source.seq;
      if (valid) { target.superseded_by.push(row.ref); target.state = 'superseded'; }
      return { ref, status: valid ? 'present' : 'missing-or-not-earlier' };
    });
  }
  for (const row of rows) row.superseded_by = row.superseded_by.map(ref => ({ ...resolve(ref),
    ...(byRef.has(ref) ? { kind: byRef.get(ref).kind } : {}) }));
  return { version: 1, cutoff, timestamp, source_sha256: hash.digest('hex'), rows };
}

export function searchLookup(index, { query, kind, item, limit = 10, allStates = false } = {}) {
  if (kind != null && !kinds.includes(kind)) throw new UserError(`--kind must be ${kinds.join(', ')}`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UserError('--limit must be 1..100');
  const words = string(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) throw new UserError('lookup needs a nonempty text query');
  const byRef = new Map(index.rows.map(row => [row.ref, row])), matches = new Map(), unresolved = new Map();
  function include(row, matched, seen = new Set()) {
    if (seen.has(row.ref)) return;
    seen.add(row.ref);
    if (!allStates && row.state === 'superseded') {
      for (const ref of row.superseded_by) {
        if (byRef.has(ref.ref)) include(byRef.get(ref.ref), matched, seen);
        else unresolved.set(row.ref, { ref: row.ref, missing_replacement: ref.ref });
      }
      return;
    }
    if ((!allStates && row.state !== 'current') || (kind && row.kind !== kind)) return;
    if (!matches.has(row.ref)) matches.set(row.ref, { ...row, matched_sources: [] });
    const sources = matches.get(row.ref).matched_sources;
    if (!sources.includes(matched)) sources.push(matched);
  }
  for (const row of index.rows) {
    if (item && row.item !== item && ![...row.evidence, ...row.failure_evidence].some(ref => ref.ref === item)) continue;
    const haystack = JSON.stringify(row).toLowerCase();
    if (words.every(word => haystack.includes(word))) include(row, row.ref);
  }
  const results = [...matches.values()].sort((a, b) => b.source.seq - a.source.seq || a.ref.localeCompare(b.ref));
  const { rows, ...provenance } = index;
  return { ...provenance, total: results.length, unresolved: [...unresolved.values()], results: results.slice(0, limit) };
}

export function lookupCommand(argv, { out }) {
  // Node treats a separate negative numeric option value as ambiguous. Keep
  // numeric-domain validation responsible for the same spelling as --at=-1.
  const normalized = [];
  for (let i = 0; i < argv.length; i++) {
    if (['--at', '--limit'].includes(argv[i]) && /^-\d+(?:\.\d+)?$/.test(argv[i + 1] ?? '')) normalized.push(`${argv[i++]}=${argv[i]}`);
    else normalized.push(argv[i]);
  }
  const { values, positionals } = parseArgs({ args: normalized, allowPositionals: true, options: {
    at: { type: 'string' }, kind: { type: 'string' }, item: { type: 'string' }, limit: { type: 'string' },
    json: { type: 'boolean' }, 'all-states': { type: 'boolean' },
  } });
  const dir = findOrgDir();
  if (!isOrgDir(dir)) throw new UserError('lookup needs an existing record');
  const reader = loadRecordReader(dir);
  try {
    const index = buildLookup(reader.events(), { at: values.at == null ? undefined : Number(values.at) });
    const result = { record: dir, torn_tail: reader.tornTail, ...searchLookup(index, {
      query: positionals.join(' '), kind: values.kind, item: values.item,
      limit: values.limit == null ? 10 : Number(values.limit), allStates: values['all-states'],
    }) };
    if (values.json) out(JSON.stringify(result, null, 2) + '\n');
    else out(sanitizeTerminal(`Record ${dir}; cutoff ${result.cutoff}; sha256 ${result.source_sha256}\n` +
      result.results.map(row => `${row.ref} [${row.kind}; ${row.state}] ${row.text}\n` +
        `  ${JSON.stringify({ source: row.source, premise: row.premise, correction: row.correction, scope: row.scope,
          evidence: row.evidence, failure_evidence: row.failure_evidence, supersedes: row.supersedes,
          superseded_by: row.superseded_by, matched_sources: row.matched_sources, diagnostics: row.diagnostics,
          context: row.context, retirement: row.retirement, supersession: row.supersession })}\n`).join('') +
      `${result.total} matches; showing ${result.results.length}. Unresolved: ${JSON.stringify(result.unresolved)}. Original authority remains in the source record.\n`));
    return 0;
  } finally { reader.close(); }
}
