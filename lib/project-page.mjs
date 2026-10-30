// Foreground, display-only record projection. No model, native probe or effects.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadRecordReader, readConfig, DEFAULT_CONFIG } from './store.mjs';
import { statusMap, blockersOf, releases, isResolved, openRuns, truthy } from './state.mjs';
import { todayJson } from './today.mjs';
import { roleIs } from './roles.mjs';
import { sanitizeTerminal } from './sanitize.mjs';
import { readInbox, inboxPath } from '../messages/inbox-read.mjs';
import { operatorDigestFrom, pushId } from '../messages/operator-inbox.mjs';

export const PAGE_SCHEMA = 'local-project-page/v1';
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const idPattern = /^[A-Z][A-Z0-9]*-\d+$/;
const id = value => typeof value === 'string' && idPattern.test(value) ? value : null;
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
export function displayText(value, limit = 400) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return null;
  const text = sanitizeTerminal(String(value)).replace(/\s+/g, ' ').trim();
  if (/-----BEGIN|\b(?:password|passwd|secret|token|api[_ -]?key|credential|authorization)\s*[:=]|\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}/i.test(text)) return '[redacted]';
  return text.slice(0, limit) || null;
}
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const age = (value, now) => stamp(value) ? Math.max(0, Math.floor((now - new Date(value)) / 86400000)) : null;
const planNote = n => n.kind === 'plan' || /^\s*(?:#+\s*)?plan\s*:/im.test(n.text) || /^\s*#+\s+plan\s*$/im.test(n.text);

// Preserve the inputs used by status/today, but discard report prose, old plans,
// revisions and arbitrary metadata. At most one folded subject is decoded at a
// time; these retained current facts scale with work, not the event archive.
export function selectPageState(source) {
  const state = { items: new Map(), runs: new Map(), links: source.links, categoryFlags: [], eventCount: source.eventCount };
  const notes = all => [...new Set([all.find(n => n.kind === 'why'), all.findLast(planNote)].filter(Boolean))];
  const metaKeys = ['stage_ref', 'stage', 'owner', 'next_action', 'hold', 'hold_reason', 'operator_reserved',
    'delegation', 'authority', 'authority_reason', 'category', 'recommend', 'answer', 'answered_by', 'stage_now',
    'proposal_intake', 'proposal_lapse', 'queue_selected', 'decision_request', 'review_source_item',
    'review_source_run', 'review_fix_of', 'review_owner_run', 'review_finding_keys'];
  for (const item of source.items.values()) {
    const selected = pick(item, ['id', 'kind', 'title', 'role', 'parent', 'priority', 'created', 'closed', 'outcome', 'runs', 'budget', 'decision_disposition']);
    selected.meta = pick(item.meta, metaKeys);
    if (selected.meta.decision_request) selected.meta.decision_request = true;
    if (item.meta.review_target) selected.meta.review_target = pick(item.meta.review_target, ['head', 'base']);
    selected.notes = notes(item.notes);
    state.items.set(item.id, selected);
  }
  for (const run of source.runs.values()) {
    const selected = pick(run, ['id', 'item', 'started', 'abandoned', 'owner', 'owner_generation']);
    selected.meta = pick(run.meta, ['agent', 'lane', 'owner', 'next_action', 'escalation']);
    selected.notes = notes(run.notes);
    selected.report = run.report ? { ...pick(run.report, ['outcome', 'at', 'seq', 'late', 'blockers']),
      file: '', extra: pick(run.report.extra, ['verdict']) } : null;
    state.runs.set(run.id, selected);
  }
  return state;
}

// A stage is an explicit stable item reference, never a title/number heuristic.
// --stage declares roots for old records without stage_ref metadata. A nested
// distinct declaration is a conflict, rather than silently overriding ancestry.
export function stageFor(state, itemId, stageRoots = []) {
  const seen = new Set(), refs = new Set(); let current = itemId, invalid = false;
  while (current) {
    if (seen.has(current)) { invalid = true; break; }
    seen.add(current);
    const item = state.items.get(current);
    if (!item) { invalid = true; break; }
    if (stageRoots.includes(current)) refs.add(current);
    for (const field of ['stage_ref', 'stage']) {
      const ref = item.meta[field];
      if (ref == null || ref === '') continue;
      if (!id(ref) || !state.items.has(ref)) invalid = true;
      else refs.add(ref);
    }
    current = item.parent;
  }
  if (invalid || refs.size > 1) return { ref: null, label: 'Unknown', reason: invalid ? 'invalid reference or ancestry' : 'conflicting stage references' };
  if (!refs.size) return { ref: null, label: 'Unassigned', reason: 'no stage reference recorded or explicitly selected' };
  const ref = [...refs][0];
  return { ref, label: displayText(state.items.get(ref).title), reason: 'explicit reference or inherited ancestry' };
}

// Auxiliary files are separate observations. Capture and verify each source;
// changed/missing files never lend current delivery/config claims to the page.
function signature(file) {
  try { const s = fs.statSync(file, { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function observe(file, read) {
  let before;
  try {
    before = signature(file);
    if (before === null) return { status: 'missing', value: null, verify: () => signature(file) === null };
    const value = read();
    return { status: 'available', value, signature: before, verify: () => signature(file) === before };
  } catch { return { status: 'unavailable', value: null, verify: () => false }; }
}
const link = (org, target) => `${pathToFileURL(path.join(org, 'events.jsonl')).href}#${encodeURIComponent(target)}`;

export function buildProjectPage({ reader, org, project, config = DEFAULT_CONFIG, now = new Date(), stageRoots = [], inbox = null }) {
  const state = selectPageState(reader.state), statuses = statusMap(state);
  const today = todayJson(state, { orgDir: org, config, now });
  const landings = new Map(), judgments = new Map();
  // Stream once. Keep only latest source/review facts and the digest's bounded
  // selection. Complete payloads/logs do not enter the output document.
  function* messages() {
    for (const event of reader.events()) {
      if (event.type === 'change.landed' && event.project === project.identity && state.runs.get(event.run)?.item === event.item)
        landings.set(`${event.item}:${event.run}`, { item: id(event.item), run: id(event.run), head: commit(event.head), base: commit(event.base), seq: event.seq, at: stamp(event.at), landed_at: stamp(event.landed_at) });
      if (event.type === 'change.reviewed') judgments.set(`${event.item}:${event.head}`, { item: id(event.item), head: commit(event.head), verdict: displayText(event.verdict, 40), review_item: id(event.review_item), review_run: id(event.review_run), seq: event.seq, at: stamp(event.at) });
      if (event.type === 'session.message.v1' && event.envelope) yield event;
    }
  }
  const digest = operatorDigestFrom(messages(), org, { state, entries: inbox });
  const questions = today.waiting.map(q => {
    const item = state.items.get(q.id), entry = inbox?.find(e => e.id === pushId(org, q.id));
    return { id: q.id, question: displayText(q.title), category: displayText(q.category), recommendation: displayText(q.recommend),
      authority_reason: displayText(item.meta.authority_reason ?? q.why), authority: displayText(item.meta.authority ?? item.meta.delegation),
      audience: item.meta.operator_reserved === true ? 'reserved operator question' : item.meta.operator_reserved === false || item.meta.delegation != null ? 'delegated project judgment' : 'unknown',
      status: q.status, created_at: stamp(q.created.at), age_days: age(q.created.at, now), parked: q.parked,
      affected_work: q.blocks.map(b => ({ id: b.id, title: displayText(b.title) })), blocked_work: q.blocked_work,
      answer: displayText(item.meta.answer), answered_by: displayText(item.meta.answered_by),
      delivery: inbox === null ? 'unknown' : entry?.state ?? 'no delivery recorded', record_link: link(org, q.id) };
  });
  const rows = [];
  for (const item of state.items.values()) {
    const status = statuses.get(item.id), active = openRuns(state, item.id);
    const latest = state.runs.get(item.runs.at(-1));
    const source = latest ? landings.get(`${item.id}:${latest.id}`) ?? null : null;
    const reviews = [...state.items.values()].filter(q => roleIs(q, 'REV') &&
      (q.meta.review_source_item === item.id || q.parent === item.id));
    const corrections = [...state.items.values()].filter(q => q.meta.review_fix_of && q.meta.review_source_item === item.id && !isResolved(statuses.get(q.id)));
    const pendingReviews = reviews.filter(q => !isResolved(statuses.get(q.id)));
    const judgment = source ? judgments.get(`${item.id}:${source.head}`) : null;
    // Keep completed producers visible while their independent review or formal
    // correction is outstanding. Accepted rows remain available in the JSON.
    const holds = []; let parent = item;
    const seen = new Set();
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      if (truthy(parent.meta.hold)) holds.push({ item: parent.id, reason: displayText(parent.meta.hold_reason) });
      parent = state.items.get(parent.parent);
    }
    const runFacts = (item.runs ?? []).map(r => state.runs.get(r)).filter(Boolean).map(r => ({
      id: r.id, lane: displayText(r.meta.lane, 160), agent: displayText(r.meta.agent, 160),
      owner: displayText(r.meta.owner) ?? displayText(r.meta.agent), claim_controller: displayText(r.owner?.controller),
      native_liveness: 'unknown', started_at: stamp(r.started.at), open: !r.report && !r.abandoned,
      abandoned: Boolean(r.abandoned), report_ingested: r.report ? { at: stamp(r.report.at), seq: r.report.seq, outcome: displayText(r.report.outcome), late: r.report.late } : null,
      source_landed: landings.get(`${item.id}:${r.id}`) ?? null,
    }));
    rows.push({ id: item.id, title: displayText(item.title), role: displayText(item.role), stage: stageFor(state, item.id, stageRoots),
      status, work_state: holds.length ? 'held' : active.length ? 'active (recorded run; native liveness unknown)' : status,
      open: !isResolved(status) || pendingReviews.length > 0 || corrections.length > 0,
      owner: displayText(item.meta.owner), next_action: displayText(item.meta.next_action ?? latest?.meta.next_action),
      blockers: blockersOf(state, item.id).filter(b => !releases(state, b, statuses.get(b))).map(b => ({ id: b, status: statuses.get(b) ?? 'unknown', title: displayText(state.items.get(b)?.title) })),
      holds, runs: runFacts, source_landed: source, report_ingested: latest?.report ? { run: latest.id, at: stamp(latest.report.at), seq: latest.report.seq, outcome: displayText(latest.report.outcome) } : null,
      review: { status: corrections.length ? 'correction pending' : pendingReviews.length ? 'review pending' : judgment ? displayText(judgment.verdict) : 'unknown',
        items: reviews.map(q => ({ id: q.id, status: statuses.get(q.id) })), corrections: corrections.map(q => q.id), judgment: judgment ?? null },
      completion: status === 'done' && judgment?.verdict === 'PASS' && !pendingReviews.length && !corrections.length ? 'accepted completion (recorded PASS)' : status === 'done' ? 'derived done; acceptance unknown' : status === 'dropped' ? 'dropped' : 'pending',
      record_link: link(org, item.id) });
  }
  reader.verify();
  return { schema: PAGE_SCHEMA, generated_at: now.toISOString(), project: { name: path.basename(project.canonical), canonical: project.canonical, identity: project.identity, record: org },
    record: { status: reader.tornTail ? 'incomplete' : 'current at captured cutoff', position: reader.position, torn_tail: Boolean(reader.tornTail) },
    stage_roots: stageRoots.map(ref => ({ ref, status: state.items.has(ref) ? 'available' : 'invalid' })),
    needs_your_decision: questions, work: rows,
    messages: { ...digest, messages: digest.messages.map(m => ({ id: displayText(m.id, 200), seq: m.seq, kind: displayText(m.kind), summary: displayText(m.summary),
      correlation: displayText(m.correlation, 200), reply_to: displayText(m.reply_to, 200), push: m.push,
      refs: m.refs.filter(r => r.orgRef === org).map(r => ({ item: id(r.item), run: id(r.run) })) })) },
    unknowns: ['Native liveness is not observed.', 'Missing recorded owner or next action is unknown.'],
    freshness: { observed_at: now.toISOString(), stale_after_seconds: 300, status: 'captured', indicators: reader.tornTail ? ['record-tail-incomplete'] : [] } };
}

export function collectProjectPage({ org, project, now = new Date(), stageRoots = [], openReader = loadRecordReader }) {
  let reader;
  const config = observe(path.join(org, 'config.json'), () => readConfig(org));
  const inbox = observe(inboxPath({ org }), () => readInbox(inboxPath({ org })).map(e => ({ id: e.id, state: e.state })));
  try {
    reader = openReader(org);
    const doc = buildProjectPage({ reader, org, project, now, stageRoots, config: config.value ?? DEFAULT_CONFIG, inbox: inbox.value });
    const configFresh = config.verify(), inboxFresh = inbox.verify();
    doc.auxiliary = { config: { status: configFresh ? config.status : 'stale', signature: config.signature ?? null },
      delivery: { status: inboxFresh ? inbox.status : 'stale', signature: inbox.signature ?? null } };
    if (!inboxFresh) {
      for (const question of doc.needs_your_decision) question.delivery = 'unknown';
      for (const message of doc.messages.messages) message.push = 'unknown';
    }
    for (const [name, observation] of Object.entries(doc.auxiliary)) if (observation.status !== 'available') doc.freshness.indicators.push(`${name}-${observation.status}`);
    reader.verify();
    return doc;
  } catch (error) {
    const status = error.code === 'RECORD_READER_STALE' ? 'stale' : error.code === 'ENOENT' ? 'missing' : 'unavailable';
    return { schema: PAGE_SCHEMA, generated_at: now.toISOString(), project: { name: path.basename(project.canonical), canonical: project.canonical, identity: project.identity, record: org },
      record: { status, position: reader?.position ?? null }, needs_your_decision: null, work: null, messages: null,
      freshness: { status, stale_after_seconds: 300, observed_at: now.toISOString(), indicators: [`record-${status}`] } };
  } finally { reader?.close(); }
}

const escape = value => String(value ?? 'unknown').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function renderProjectPage(doc) {
  const e = escape;
  const recordLink = row => `<a class="ref" href="${e(row.record_link)}">${e(row.id)} · owning record</a>`;
  const facts = (name, value) => `<dt>${e(name)}</dt><dd>${e(value)}</dd>`;
  const questions = doc.needs_your_decision?.map(q => `<article><h3>${e(q.question)}</h3><p>${e(q.audience)} · ${e(q.age_days)} days old${q.parked ? ' · parked' : ''}</p><dl>${facts('Recommendation', q.recommendation)}${facts('Authority / reason', q.authority_reason ?? q.authority)}${facts('Affected work', q.affected_work.map(w => `${w.id}: ${w.title}`).join('; ') || 'none recorded')}${facts('Delivery', q.delivery)}${facts('Answer', q.answer)}</dl>${recordLink(q)}</article>`).join('') ?? '<p>Questions unavailable. This does not mean there are no questions.</p>';
  const groups = new Map();
  for (const row of doc.work ?? []) {
    if (!row.open) continue;
    const key = row.stage.ref ?? row.stage.label;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const work = [...groups].map(([key, rows]) => `<section><h2>${e(key)}${rows[0].stage.ref ? ` · ${e(rows[0].stage.label)}` : ''}</h2>${rows.map(w => `<article><h3>${e(w.title)}</h3><p>${e(w.work_state)} · ${e(w.completion)}</p><dl>${facts('Owner', w.owner)}${facts('Next action', w.next_action)}${facts('Blockers', w.blockers.map(b => `${b.id}: ${b.title} (${b.status})`).join('; ') || 'none recorded')}${facts('Holds', w.holds.map(h => `${h.item}: ${h.reason ?? 'reason unknown'}`).join('; ') || 'none recorded')}${facts('Source landed', w.source_landed ? `${w.source_landed.head} · ${w.source_landed.landed_at ?? w.source_landed.at}` : 'unknown')}${facts('Report ingested', w.report_ingested ? `${w.report_ingested.run} · ${w.report_ingested.outcome} · ${w.report_ingested.at}` : 'unknown')}${facts('Review / correction', `${w.review.status} · ${w.review.items.map(r => r.id).join(', ')} · ${w.review.corrections.join(', ')}`)}${facts('Recorded runs / lanes', w.runs.map(r => `${r.id} / ${r.lane ?? 'unknown'} · ${r.open ? 'open' : r.abandoned ? 'abandoned' : 'report ingested'} · owner ${r.owner ?? 'unknown'} · native liveness unknown`).join('; ') || 'unknown')}</dl>${recordLink(w)}</article>`).join('')}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${e(doc.project.name)} · Project record</title><style>body{font:16px/1.55 system-ui,sans-serif;background:#f4f2ed;color:#202c32;max-width:1100px;margin:auto;padding:32px}h1{font-size:2.4rem;line-height:1.1}h2{margin-top:2rem}article{background:white;border:1px solid #c9d0cf;border-radius:6px;padding:20px;margin:14px 0}h3{margin:0}.decision{border-top:5px solid #996010}.banner{background:#e4ebe8;padding:16px;border-left:5px solid #426256}.ref,footer{font-size:12px;overflow-wrap:anywhere;color:#506168}dl{display:grid;grid-template-columns:170px 1fr;gap:5px}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}a{color:#244f61}@media(max-width:600px){body{padding:16px}dl{display:block}dd{margin-bottom:8px}}</style></head><body><header><p>LOCAL PROJECT RECORD · READ ONLY</p><h1>${e(doc.project.name)}</h1><p>${e(doc.project.canonical)}</p><div class="banner"><strong>${e(doc.record.status)}</strong><br>Record sequence ${e(doc.record.position?.lastSeq)} · cutoff ${e(doc.record.position?.lastAt)}<br>Generated ${e(doc.generated_at)}. Static snapshot: regenerate to check freshness; treat as stale after 300 seconds.<br>${e(doc.freshness.indicators.join('; ') || 'No missing source indicators at generation.')}</div></header><section class="decision"><h2>Needs your decision (${e(doc.needs_your_decision?.length ?? 'unknown')})</h2>${questions || '<p>No unresolved human questions at this cutoff.</p>'}</section><main><h2>Open work</h2>${doc.work === null ? '<p>Work unavailable.</p>' : work || '<p>No open work recorded at this cutoff.</p>'}</main><section><h2>Messages digest</h2>${doc.messages?.messages.map(m => `<article><h3>${e(m.summary)}</h3><p>${e(m.kind)} · delivery ${e(m.push)}</p><span class="ref">${e(m.id)} · sequence ${e(m.seq)}</span></article>`).join('') || '<p>No messages available.</p>'}</section><footer><p>Identity: ${e(doc.project.identity)} · record: ${e(doc.project.record)} · digest: ${e(doc.record.position?.digest)}</p><p>Record locators identify owning facts. Fetch details with record show ID; this page sends, retries and acknowledges nothing. Native liveness and missing recorded owners/actions are unknown. Machine-readable facts: <a href="project.json">project.json</a> (includes completed work).</p></footer></body></html>\n`;
}

// Publish one generation in a new directory, so existing output/record files can
// never be overwritten. Both representations come from exactly the same facts.
export function writeProjectPage(directory, doc) {
  fs.mkdirSync(directory, { mode: 0o700 });
  const json = JSON.stringify(doc, null, 2) + '\n';
  fs.writeFileSync(path.join(directory, 'project.json'), json, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'index.html'), renderProjectPage(doc), { flag: 'wx', mode: 0o600 });
  return { directory, sha256: createHash('sha256').update(json).digest('hex'), record_status: doc.record.status, sequence: doc.record.position?.lastSeq ?? null };
}
