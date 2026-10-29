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

// Reference spelling is not finding identity. Body intake removes severity
// labels, and reviewers may quote inline code or paraphrase a source citation.
// Keep the original text/key; a citation can resolve only one retained finding.
const reference = value => {
  const label = /^\[(major|minor)\]\s*/i.exec(text(value));
  const content = text(text(value).slice(label?.[0].length ?? 0).replace(/`+/g, ''));
  return { severity: label?.[1].toLowerCase(), content,
    location: /^([^\s:]+:\d+(?::\d+)?(?:-\d+(?::\d+)?)?)\s+[-–—]\s+\S/.exec(content)?.[1] };
};

function referencedFindings(rows, ref) {
  const values = [...rows.values()];
  const exact = values.filter(row => row.key === ref || text(row.text) === text(ref));
  if (exact.length) return exact;
  const parsed = reference(ref);
  const candidates = values.filter(row => !parsed.severity || row.severity === parsed.severity);
  const matching = candidates.filter(row => reference(row.text).content === parsed.content);
  if (matching.length) return matching;
  return parsed.location ? candidates.filter(row => reference(row.text).location === parsed.location) : [];
}

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
    else if (finding.correction_check) {
      const row = rows.get(key);
      if (row.correction_check && row.correction_check !== finding.correction_check)
        throw Error('one immutable finding has contradictory correction checks');
      row.correction_check = finding.correction_check;
    }
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
      item.meta.review_source_item && item.meta.review_source_item !== source ||
      ['review_source_run', 'review_owner_run'].some(key => item.meta[key] && item.meta[key] !== review.meta.review_source_run))
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
      // Old consumers created ordinary proposals before finding intake. Match
      // their immutable creation, never mutable display, parent or metadata.
      const creations = proposal ? events.filter(event => event.type === 'item.added' && roleIs(event, 'ENG') &&
        event.from_run === run.id && event.parent === review.id && event.title === proposal.title &&
        (event.why ?? null) === (proposal.why ?? null) &&
        JSON.stringify(event.accept ?? []) === JSON.stringify(proposal.accept ?? []) &&
        Object.entries(proposal.extra ?? {}).every(([key, value]) => JSON.stringify(event.meta?.[key]) === JSON.stringify(value))) : [];
      for (const event of creations) {
        const item = state.items.get(event.id);
        requireCorrection({ ...event, meta: event.meta ?? {} });
        requireCorrection(item);
        if (item.created.seq !== event.seq || item.created.run !== event.from_run)
          throw Error('legacy correction ownership is missing/ambiguous; retain historical items and attempts');
      }
      // Historical duplicates remain untouched. A retained finding binding
      // selects its original owner; otherwise use the earliest exact creation.
      const owners = new Set(keys.filter(key => linked.has(key)).map(key => linked.get(key)));
      let historical;
      if (creations.length) {
        if (owners.size > 1 || owners.size === 1 && !creations.some(event => owners.has(event.id)))
          throw Error('legacy correction has conflicting finding ownership; retain historical items and attempts');
        const creation = creations.find(event => owners.has(event.id)) ?? creations.reduce((a, b) => a.seq < b.seq ? a : b);
        historical = state.items.get(creation.id);
      }
      const selected = missing.map(key => rows.get(key)), severity = selected.some(row => row.severity === 'major') ? 'major' : 'minor';
      const id = historical?.id ?? nextItemId(state, { kind: 'work', role: 'engineer' }, taken);
      const meta = { review_fix_of: reviewKey, review_source_item: source,
        review_source_run: review.meta.review_source_run, review_owner_run: review.meta.review_source_run,
        review_round_cap: 1, severity, review_finding_keys: missing };
      meta.review_correction_checks = Object.fromEntries(selected.filter(row => row.severity === 'major').map(row =>
        [row.key, row.correction_check ?? proposal?.extra?.review_correction_checks?.[row.key] ??
          proposal?.extra?.review_correction_checks?.[row.text] ?? proposal?.extra?.correction_check ??
          `Selection required before editing: reproduce this exact Major trigger and assert its corrected behavior: ${row.text}`]));
      if (!historical) {
        taken.add(id);
        add.push({ type: 'item.added', id, kind: 'work', role: proposal?.role ?? 'engineer',
          capability: proposal?.capability ?? null,
          title: proposal?.title ?? `${severity === 'major' ? 'Fix' : 'Follow up'} ${source} at ${target.head.slice(0, 10)}: ${selected[0].text.slice(0, 120)}`,
          parent: review.id, from_run: run.id, accept: proposal?.accept ?? selected.map(row => row.text),
          why: proposal?.why ?? selected.map(row => row.text).join('\n'), meta: { ...proposal?.extra, ...meta, queue_selected:true } });
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
        const matches = referencedFindings(rows, ref);
        if (matches.length !== 1) throw Error('correction proposal review_findings reference is missing/ambiguous');
        return matches[0].key;
      });
    }
    if (!keys) {
      // The established single formal correction covers the report's findings,
      // even if its prose quotes only one. Narrower coverage needs explicit refs.
      keys = proposals.length === 1 || rows.size === 1 ? [...rows.keys()] : [];
    }
    if (!keys.length) throw Error('multiple correction proposals need explicit review_findings links to their immutable findings');
    create([...new Set(keys)], proposal);
  }
  for (const key of rows.keys()) create([key]);
  return { add, findings: [...rows.values()].filter(row => declared.has(row.key)) };
}
