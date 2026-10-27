// Called by both report intake and the current service, inside the record commit.
// Finding identity describes immutable source and content, never a proposal title,
// intake attempt, current status or severity-wide bucket.
import { createHash } from 'node:crypto';
import { nextItemId } from '../lib/state.mjs';
import { roleIs } from '../lib/roles.mjs';
import { capturedReviewCommits } from './review-group.mjs';

const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];

export function reviewFindingKey(review, finding) {
  const target = review.meta.review_target;
  return `review-finding/v1:${digest([review.meta.review_source_item, target.base, target.head,
    target.reportHash ?? null, target.diff_sha256 ?? null, capturedReviewCommits(target).sort(),
    finding.severity, text(finding.text)])}`;
}

export function reviewCorrectionEvents({ state, events, run, review, report, findings, verdict, sha256, usedIds = [] }) {
  const target = review.meta.review_target, source = review.meta.review_source_item;
  const reviewKey = `${source}:${target.head}`, add = [], taken = new Set(usedIds);
  const rows = new Map(), linked = new Map();
  for (const finding of findings) {
    const key = reviewFindingKey(review, finding);
    if (!rows.has(key)) rows.set(key, { ...finding, key });
  }
  const declared = new Set(rows.keys());
  const proposals = (report.proposals ?? []).filter(p => roleIs(p, 'ENG'));
  // When no structured finding is supplied, the immutable proposal itself is
  // the finding. A bare failed judgment still needs one visible correction.
  const proposalRows = new Map();
  if (!rows.size) {
    for (const p of proposals) {
      const severity = String(p.extra?.severity ?? '').toLowerCase();
      const finding = { severity: ['major', 'minor'].includes(severity) ? severity : verdict === 'PASS' ? 'minor' : 'major',
        text: JSON.stringify([p.title, p.why ?? null, p.accept ?? [], p.extra ?? {}]) };
      const key = reviewFindingKey(review, finding);
      rows.set(key, { ...finding, key }); proposalRows.set(p, [key]);
    }
    if (!rows.size && verdict !== 'PASS') {
      const finding = { severity: 'major', text: `Review ${verdict}; resolve its findings without a second review.` };
      const key = reviewFindingKey(review, finding); rows.set(key, { ...finding, key });
    }
  }
  const bind = (key, id) => {
    if (linked.has(key) && linked.get(key) !== id) throw Error('immutable finding has conflicting corrections; retain historical items and attempts');
    linked.set(key, id);
  };
  const requireCorrection = item => {
    if (!roleIs(item, 'ENG') || item.meta.review_fix_of && item.meta.review_fix_of !== reviewKey ||
      item.meta.review_source_item && item.meta.review_source_item !== source)
      throw Error('immutable finding correction source is missing/UNKNOWN or changed; retain its binding');
  };
  // Recheck committed bindings regardless of open/closed/active/UNKNOWN state.
  for (const event of events) if (event.type === 'review.finding-linked' && rows.has(event.finding_key)) {
    requireCorrection(state.items.get(event.correction_item));
    bind(event.finding_key, event.correction_item);
  }
  for (const item of state.items.values()) if (roleIs(item, 'ENG')) {
    for (const key of item.meta.review_finding_keys ?? []) if (rows.has(key)) { requireCorrection(item); bind(key, item.id); }
  }
  const link = (row, id) => {
    bind(row.key, id);
    add.push({ type: 'review.finding-linked', item: id, correction_item: id, finding_key: row.key,
      finding: { severity: row.severity, text: row.text }, source_item: source,
      head: target.head, base: target.base, review_item: review.id, review_run: run.id, report_sha256: sha256 });
  };
  const create = (keys, proposal) => {
    const missing = keys.filter(key => !linked.has(key));
    if (missing.length) {
      // Old selected consumers already created ordinary proposals. Reuse their
      // exact immutable proposal rather than generating a second correction.
      const historical = proposal && [...state.items.values()].filter(item => roleIs(item, 'ENG') &&
        item.created.run === run.id && item.parent === review.id && item.title === proposal.title &&
        (item.created.why ?? null) === (proposal.why ?? null) &&
        JSON.stringify(item.accept) === JSON.stringify(proposal.accept ?? []) &&
        Object.entries(proposal.extra ?? {}).every(([key, value]) => JSON.stringify(item.meta[key]) === JSON.stringify(value)))
        .sort((a, b) => a.created.seq - b.created.seq)[0];
      if (historical) requireCorrection(historical);
      const selected = missing.map(key => rows.get(key)), severity = selected.some(row => row.severity === 'major') ? 'major' : 'minor';
      const id = historical?.id ?? nextItemId(state, { kind: 'work', role: 'engineer' }, taken);
      const meta = { review_fix_of: reviewKey, review_source_item: source,
        review_source_run: review.meta.review_source_run, review_owner_run: review.meta.review_source_run,
        review_round_cap: 1, severity, review_finding_keys: missing };
      if (!historical) {
        taken.add(id);
        add.push({ type: 'item.added', id, kind: 'work', role: proposal?.role ?? 'engineer',
          capability: proposal?.capability ?? null,
          title: proposal?.title ?? `${severity === 'major' ? 'Fix' : 'Follow up'} ${source} at ${target.head.slice(0, 10)}: ${selected[0].text.slice(0, 120)}`,
          parent: review.id, from_run: run.id, accept: proposal?.accept ?? selected.map(row => row.text),
          why: proposal?.why ?? selected.map(row => row.text).join('\n'), meta: { ...proposal?.extra, ...meta } });
      } else if (!historical.meta.review_fix_of) {
        add.push({ type: 'item.updated', id, fields: { meta } });
      }
      for (const row of selected) link(row, id);
    }
    if (proposal && (proposal.blocking ?? report.outcome === 'blocked')) {
      for (const id of new Set(keys.map(key => linked.get(key)))) {
        if (![...state.links, ...add.filter(e => e.type === 'link.added')].some(e => e.blocker === id && e.blocked === review.id))
          add.push({ type: 'link.added', blocker: id, blocked: review.id, from_run: run.id });
      }
    }
  };
  for (const proposal of proposals) {
    const refs = list(proposal.extra?.review_findings);
    let keys = proposalRows.get(proposal);
    if (!keys && refs.length) {
      keys = refs.map(ref => {
        const matches = [...rows.values()].filter(row => row.key === ref || text(row.text) === text(ref));
        if (matches.length !== 1) throw Error('correction proposal review_findings reference is missing/ambiguous');
        return matches[0].key;
      });
    }
    if (!keys) {
      const content = [proposal.title, proposal.why, ...(proposal.accept ?? [])].map(text);
      keys = [...rows.values()].filter(row => content.some(value => value.includes(text(row.text)))).map(row => row.key);
      // The established single formal correction covers the report's findings,
      // including Minor findings. Multiple proposals need actual finding links.
      if (!keys.length && (proposals.length === 1 || rows.size === 1)) keys = [...rows.keys()];
    }
    if (!keys.length) throw Error('multiple correction proposals need explicit review_findings links to their immutable findings');
    create([...new Set(keys)], proposal);
  }
  for (const key of rows.keys()) create([key]);
  return { add, findings: [...rows.values()].filter(row => declared.has(row.key)) };
}
