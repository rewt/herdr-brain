// Report intake and explicit supervisor re-filing share immutable source keys.
// Call under the record transaction; never retain a prepared allocation.
import { createHash } from 'node:crypto';
import { nextItemId, openRuns, children, wouldCycleBlock, fold } from './state.mjs';
import { roleIs } from './roles.mjs';

export const proposalKey = (run, index) => `report-proposal/v1:${run}:${index}`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reserved = item => roleIs(item, 'HUM') || item.meta?.reserved || item.meta?.operator_reserved ||
  ['security', 'funds-and-chain', 'publish', 'delete-data', 'licensing', 'priorities'].includes(item.meta?.category);
export const proposalSelection = item => item?.meta?.proposal_intake !== 'report-proposal/v1' ? null :
  item.meta.queue_selected === true ? 'selected' : item.meta.proposal_lapse ? 'lapsed' : 'unselected';

function sameCreation(event, proposal, run) {
  return event.type === 'item.added' && event.from_run === run.id && event.parent === run.item &&
    event.title === proposal.title && (event.role ?? null) === (proposal.role ?? null) &&
    (event.capability ?? null) === (proposal.capability ?? null) && (event.why ?? null) === (proposal.why ?? null) &&
    JSON.stringify(event.accept ?? []) === JSON.stringify(proposal.accept ?? []) &&
    Object.entries(proposal.extra ?? {}).every(([key, value]) => JSON.stringify(event.meta?.[key]) === JSON.stringify(value));
}

export function proposalIntakeEvents({ state, events, run, report, sha256, usedIds = [], indices }) {
  const review = state.items.get(run.item), queuedReview = review?.meta.review_key && roleIs(review, 'REV');
  const formal = queuedReview && review.meta.review_target && review.meta.review_source_item;
  const taken = new Set(usedIds), add = [], rows = [], bindings = [];
  for (const [index, proposal] of (report.proposals ?? []).entries()) {
    if (queuedReview && roleIs(proposal, 'REV')) throw Error('a landed-change review cannot propose another review; retain cap1 and use linked engineer correction');
    if (formal && roleIs(proposal, 'ENG')) continue; // ENG673 owns finding identity/cardinality.
    const source = { key: proposalKey(run.id, index), run: run.id, index, report_sha256: sha256, proposal };
    const owners = new Set(events.filter(e => e.type === 'proposal.recorded' && e.source.key === source.key).map(e => e.item));
    for (const item of state.items.values()) if (item.meta.proposal_sources?.some(s => s.key === source.key)) owners.add(item.id);
    if (owners.size > 1) throw Error('proposal source has conflicting owners; retain items and UNKNOWN attempts');
    let id = [...owners][0];
    if (id) {
      const creation = events.find(e => e.type === 'item.added' && e.id === id);
      const item = state.items.get(id);
      const saved = events.find(e => e.type === 'proposal.recorded' && e.source.key === source.key)?.source ??
        creation?.meta?.proposal_sources?.find(s => s.key === source.key);
      if (!item || item.created.seq !== creation?.seq || !saved || hash(saved) !== hash(source))
        throw Error('proposal source/creation changed or UNKNOWN; retain original ownership');
    } else {
      // One-release recovery for pre-key intake: full immutable creation plus
      // source run and occurrence, never current title or incidental prose.
      const occurrences = report.proposals.slice(0, index + 1).filter(p => sameCreation({ type: 'item.added',
        from_run: run.id, parent: run.item, title: p.title, role: p.role, capability: p.capability,
        why: p.why, accept: p.accept, meta: p.extra }, proposal, run)).length;
      const creations = events.filter(e => !e.meta?.proposal_intake && sameCreation(e, proposal, run));
      const legacy = creations[occurrences - 1];
      if (legacy) {
        const item = state.items.get(legacy.id);
        if (!item || item.created.seq !== legacy.seq || item.created.run !== run.id)
          throw Error('legacy proposal creation ownership changed; retain original attempt');
        id = legacy.id;
        bindings.push({ type: 'proposal.recorded', item: id, source });
      }
    }
    const blocking = proposal.blocking ?? report.outcome === 'blocked';
    const ordinary = !blocking && !roleIs(proposal, 'REV') && !reserved({ ...proposal, meta: proposal.extra }) &&
      String(proposal.extra?.severity ?? '').toLowerCase() !== 'major' && !proposal.extra?.review_finding_keys && !proposal.extra?.review_findings;
    rows.push({ source, proposal, id, blocking, ordinary });
  }
  if (indices && indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= (report.proposals ?? []).length))
    throw Error('proposal index is missing from the immutable report');
  // Compute grouping from the whole report even when filing just one index.
  const ordinary = rows.filter(r => r.ordinary), group = ordinary.length > 3 ? ordinary.filter(r => !r.id) : [];
  const groups = [...rows.filter(r => !group.includes(r)).map(r => [r]), ...(group.length ? [group] : [])];
  for (const members of groups) {
    if (indices && !members.some(r => indices.includes(r.source.index))) continue;
    let id = members[0].id;
    const sources = members.map(r => r.source), p = members[0].proposal;
    if (!id) {
      id = nextItemId(state, { kind: 'work', role: members.length > 1 ? 'architect' : p.role }, taken); taken.add(id);
      const reshape = members.length > 1;
      add.push({ type: 'item.added', id, kind: 'work', role: reshape ? 'architect' : p.role ?? null,
        capability: reshape ? null : p.capability ?? null, parent: run.item, from_run: run.id,
        title: reshape ? `Reshape ${members.length} follow-ups from ${run.id}` : p.title,
        why: reshape ? 'Select and reshape the retained follow-ups before commissioning work.' : p.why ?? null,
        accept: reshape ? members.map(r => `[${r.source.index}] ${r.proposal.title}`) : p.accept ?? [],
        meta: { ...(reshape ? {} : p.extra), proposal_intake: 'report-proposal/v1', proposal_sources: sources,
          queue_selected: false } });
      for (const source of sources) add.push({ type: 'proposal.recorded', item: id, source });
    }
    for (const row of members) if (row.blocking && ![...state.links, ...add].some(e => e.blocker === id && e.blocked === run.item))
      add.push({ type: 'link.added', blocker: id, blocked: run.item, from_run: run.id });
  }
  return [...bindings.filter(e => !indices || indices.includes(e.source.index)), ...add];
}

// The token includes linked subjects: a new dependent or attempt invalidates a
// reviewed disposition, even if the proposal's own display fields did not move.
export function proposalToken(state, id) {
  const links = state.links.filter(l => l.blocker === id || l.blocked === id);
  return hash([state.items.get(id), links, links.map(l => state.items.get(l.blocker === id ? l.blocked : l.blocker)),
    [...state.runs.values()].filter(r => r.item === id), children(state, id)]);
}

function untouched(state, events, item, attempted) {
  if (!item || item.closed || item.runs.length || openRuns(state, item.id).length || reserved(item) || roleIs(item, 'REV') || item.meta.hold || item.meta.held ||
      item.meta.review_fix_of || item.meta.review_finding_keys?.length || String(item.meta.severity ?? '').toLowerCase() === 'major' ||
      item.meta.committed || item.meta.commit || item.meta.head || item.meta.landed || item.meta.unknown_attempt ||
      attempted.includes(item.id) || children(state, item.id).length ||
      events.some(e => ['change.landed', 'dispatch.prepared', 'dispatch.completed'].includes(e.type) && e.item === item.id))
    throw Error('active, committed, reserved, finding or attempted/UNKNOWN work must be retained');
}

export function proposalDisposition({ state, events, id, expect, cut, successor, successorExpect, key, why, authority, attempted = [] }) {
  if (!authority?.native_caller || !why?.trim()) throw Error('explicit owning authority and reason are required');
  if (proposalToken(state, id) !== expect) throw Error('proposal or dependencies changed before disposition');
  const item = state.items.get(id); untouched(state, events, item, attempted);
  if (!successor) {
    if (!['selection', 'release'].includes(cut) || proposalSelection(item) !== 'unselected' ||
        state.links.some(l => l.blocker === id || l.blocked === id))
      throw Error('only an unselected dependency-free proposal can lapse at an explicit selection/release cut');
    const lapse = { cut, why, ...authority };
    return { add: [{ type: 'item.updated', id, fields: { meta: { proposal_lapse: lapse, queue_selected: false } } },
      { type: 'proposal.lapsed', item: id, lapse }], result: { lapsed: id } };
  }
  const target = state.items.get(successor);
  if (id === successor || !target || target.closed || reserved(target) || proposalToken(state, successor) !== successorExpect)
    throw Error('canonical successor changed or is unavailable');
  const keys = subject => new Set([...events.filter(e => e.type === 'proposal.recorded' && e.item === subject.id).map(e => e.source.key),
    ...(subject.meta.proposal_sources ?? []).map(s => s.key), ...(subject.meta.review_finding_keys ?? [])]);
  if (!key || !keys(item).has(key) || !keys(target).has(key)) throw Error('duplicate closure requires a shared typed source/finding key');
  const links = state.links.filter(l => l.blocker === id || l.blocked === id), add = [];
  let working = state;
  for (const link of links) {
    const moved = { blocker: link.blocker === id ? successor : link.blocker, blocked: link.blocked === id ? successor : link.blocked };
    if (moved.blocker === moved.blocked || wouldCycleBlock(working, moved.blocker, moved.blocked)) throw Error('duplicate transfer would create a dependency cycle');
    if (!working.links.some(l => l.blocker === moved.blocker && l.blocked === moved.blocked)) {
      add.push({ type: 'link.added', ...moved }); working = { ...working, links: [...working.links, moved] };
    }
  }
  // Replacement blockers are visible before originals are removed or dropped.
  add.push(...links.map(l => ({ type: 'link.removed', blocker: l.blocker, blocked: l.blocked })),
    { type: 'item.updated', id, fields: { meta: { superseded_by: successor } } },
    { type: 'item.closed', id, as: 'dropped', note: `Typed duplicate of ${successor}: ${why}` },
    { type: 'proposal.duplicate', item: id, successor, key, why, ...authority });
  return { add, result: { dropped: id, successor, transferred: links.length } };
}

export function proposalMetrics(events) {
  const state = fold(events), days = new Map();
  for (const item of state.items.values()) {
    if (item.kind !== 'work') continue;
    const date = item.created.at?.slice(0, 10) ?? 'unknown';
    const row = days.get(date) ?? { date, filed: 0, ever_run: 0, report_filed: 0, report_ever_run: 0 };
    row.filed++; row.ever_run += Number(item.runs.length > 0);
    if (item.created.run) { row.report_filed++; row.report_ever_run += Number(item.runs.length > 0); }
    days.set(date, row);
  }
  return { at: new Date().toISOString(), event_seq: events.at(-1)?.seq, node: process.version,
    cohort: 'all work items; UTC creation date; ever_run means at least one run.started as of cutoff',
    days: [...days.values()].map(r => ({ ...r, ever_run_share: r.ever_run / r.filed,
      report_ever_run_share: r.report_filed ? r.report_ever_run / r.report_filed : null })) };
}
