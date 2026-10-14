// Organizational completion is one guarded event transaction. Git and gate
// verification belong to the supervisor; these facts are opaque to the core.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { UserError } from './store.mjs';
import { fold, extendFold, itemStatus, openQuestionsFor, openRuns, releases, wouldCycleBlock } from './state.mjs';

export const stable = value => JSON.stringify(value, function (key, v) {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v;
});
export const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const text = v => typeof v === 'string' && v.trim().length > 0 && !v.includes('\0');
const hash = v => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v ?? '');
const sha = v => /^[a-f0-9]{64}$/.test(v ?? '');
const refuse = message => { throw new UserError(message); };

export function completionFingerprint(state, id) {
  const item = state.items.get(id);
  if (!item) refuse(`unknown item ${id}`);
  const links = state.links.filter(l => l.blocked === id || l.blocker === id);
  return digest({ item, runs: item.runs.map(id => {
    // Harness/model/session metadata is display-only, never completion evidence.
    const { meta, ...run } = state.runs.get(id); return run;
  }), links,
    blockers: links.filter(l => l.blocked === id).map(l => ({ id: l.blocker,
      item: state.items.get(l.blocker), status: itemStatus(state, l.blocker) })) });
}

function validatePlan(plan, org) {
  if (!plan || plan.version !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(plan.batch ?? '') ||
      plan.org !== org || !path.isAbsolute(plan.identity ?? '') || !hash(plan.base) || !hash(plan.tip) ||
      plan.gate?.exit_code !== 0 || !path.isAbsolute(plan.gate?.log ?? '') || !sha(plan.gate?.sha256) ||
      !Array.isArray(plan.items) || !plan.items.length || !Array.isArray(plan.excluded)) refuse('invalid batch completion receipt');
}

// Fingerprints remain strict. A sequence boundary lets us explain current
// changes, including questions that are not part of the item's fingerprint.
// Older v1 receipts can recover their boundary from the retained event history.
export function completionDelta(state, events, plan) {
  const entries = [...plan.items, ...plan.excluded].filter(e => e.disposition !== 'historical');
  const matches = s => entries.every(e => s.items.has(e.item) && completionFingerprint(s, e.item) === e.expected) &&
    plan.items.every(e => !openQuestionsFor(s, e.item).length);
  let boundary = -1;
  if (plan.prepared_seq !== undefined) {
    if (!Number.isSafeInteger(plan.prepared_seq) || plan.prepared_seq < 0) refuse('invalid preparation sequence');
    boundary = events.findLastIndex(e => e.seq <= plan.prepared_seq) + 1;
    if ((events[boundary - 1]?.seq ?? 0) !== plan.prepared_seq || !matches(fold(events.slice(0, boundary))))
      refuse('preparation sequence does not match the original record fingerprints');
  } else {
    // Normal older receipts need no historical scan. Their existing question
    // guard still applies; recovery only scans when something actually changed.
    if (matches(state)) return { batch: plan.batch, fingerprint: digest(plan), items: [] };
    const historical = fold([]);
    for (let i = 0; i < events.length; i++) {
      extendFold(historical, [events[i]]);
      if (matches(historical)) boundary = i + 1;
    }
  }
  const delta = { batch: plan.batch, fingerprint: digest(plan),
    prepared_seq: boundary < 0 ? null : (events[boundary - 1]?.seq ?? 0), items: [] };
  if (boundary < 0) {
    delta.items = entries.filter(e => completionFingerprint(state, e.item) !== e.expected)
      .map(e => ({ item: e.item, expected: e.expected, current: completionFingerprint(state, e.item), events: [] }));
    return delta;
  }
  const cursor = fold(events.slice(0, boundary));
  const signature = (s, e) => digest({ fingerprint: completionFingerprint(s, e.item),
    questions: plan.items.includes(e) ? openQuestionsFor(s, e.item) : [] });
  const preparedSignatures = new Map(entries.map(e => [e.item, signature(cursor, e)]));
  const changes = new Map(entries.map(e => [e.item, []]));
  for (const event of events.slice(boundary)) {
    const before = entries.map(e => signature(cursor, e));
    extendFold(cursor, [event]);
    entries.forEach((entry, i) => {
      if (signature(cursor, entry) === before[i]) return;
      const plain = event.type === 'note.added' && !event.decision && !event.kind;
      changes.get(entry.item).push({ seq: event.seq, type: event.type, by: event.by,
        acceptance_relevant: !plain, event });
    });
  }
  delta.items = entries.filter(e => signature(state, e) !== preparedSignatures.get(e.item)).map(e => ({ item: e.item,
    expected: e.expected, current: completionFingerprint(state, e.item), events: changes.get(e.item) }));
  return delta;
}

const plainDelta = delta => delta.prepared_seq !== null && delta.items.length > 0 &&
  delta.items.every(item => item.events.length && item.events.every(e => !e.acceptance_relevant));
const acceptedDelta = (events, plan, delta) => events.find(e => e.type === 'promotion.delta-accepted' &&
  e.identity === plan.identity && e.batch === plan.batch && e.fingerprint === digest(plan) && e.delta_digest === digest(delta));

function describeDelta(delta) {
  const lines = delta.items.flatMap(item => [
    `${item.item} changed since batch preparation; inspect before refreshing evidence`,
    ...item.events.map(e => `  seq ${e.seq}: ${e.type} by ${e.by} [${e.acceptance_relevant ? 'acceptance-relevant' : 'plain note'}] ${stable(e.event)}`),
  ]);
  if (!delta.items.length) lines.push('No record delta to accept.');
  if (delta.prepared_seq === null) lines.push('Original record boundary unavailable; retain the receipts and inspect the event history.');
  lines.push(`delta digest: ${digest(delta)}`);
  lines.push(plainDelta(delta) ? 'After inspection, refresh with --accept-delta DIGEST --why TEXT, then retry the same finish.' :
    'Acceptance-relevant changes cannot be refreshed as plain notes; inspect and resolve completion evidence.');
  return lines.join('\n');
}
const refuseDelta = delta => refuse(describeDelta(delta));

export function refreshCompletionEvents(state, events, plan, org, accepted, why) {
  validatePlan(plan, org);
  if (!sha(accepted) || !text(why)) refuse('refresh needs --accept-delta SHA256 and --why TEXT');
  if (events.some(e => e.type === 'promotion.reconciled' && e.identity === plan.identity && e.batch === plan.batch))
    refuse('batch already reconciled; retry finish');
  const delta = completionDelta(state, events, plan);
  if (digest(delta) !== accepted) refuse(`delta changed since inspection; inspect again\n${describeDelta(delta)}`);
  if (!plainDelta(delta)) refuseDelta(delta);
  const previous = acceptedDelta(events, plan, delta);
  const event = { type: 'promotion.delta-accepted', batch: plan.batch, identity: plan.identity,
    fingerprint: digest(plan), delta_digest: accepted, prepared_seq: delta.prepared_seq,
    items: delta.items, why };
  // Apply every completion guard under the same record lock before accepting.
  // This derives completion only; refresh never closes an item or retires a run.
  completionEvents(state, [...events, event], plan, org);
  return { add: previous ? [] : [event], result: { batch: plan.batch, refreshed: true,
    replayed: Boolean(previous), delta_digest: accepted, items: delta.items.map(e => e.item) } };
}

export function completionEvents(state, events, plan, org) {
  validatePlan(plan, org);
  const fingerprint = digest(plan);
  const previous = events.find(e => e.type === 'promotion.reconciled' && e.identity === plan.identity && e.batch === plan.batch);
  if (previous) {
    if (previous.fingerprint !== fingerprint) refuse('batch already reconciled with different evidence');
    return { add: [], result: { batch: plan.batch, replayed: true, items: previous.items,
      current: previous.items.map(id => ({ id, status: itemStatus(state, id) })) } };
  }
  const historical = new Set(plan.excluded.filter(e => e?.disposition === 'historical'));
  if (plan.items.some(e => e?.disposition !== undefined)) refuse('included items cannot be historical exclusions');
  const entries = [...plan.items, ...plan.excluded], seen = new Set();
  for (const entry of entries) {
    if (!entry || seen.has(entry.item)) refuse('duplicate or missing batch item');
    seen.add(entry.item);
    const item = state.items.get(entry.item), run = state.runs.get(entry.run);
    if (!item || !run || run.item !== item.id) refuse('unknown or mismatched batch item/run');
    if (entry.disposition !== undefined && entry.disposition !== 'historical') refuse('unknown exclusion disposition');
    if (historical.has(entry)) {
      // This accounts for an earlier queue decision without touching the item's
      // current run, outcome, blockers or notes. Newer work is independent.
      if (!text(entry.reason) || !text(entry.next_action) || !Array.isArray(entry.superseded) ||
          entry.superseded.length || (entry.blocked_by !== undefined && (!Array.isArray(entry.blocked_by) || entry.blocked_by.length)) ||
          entry.resolution !== undefined) refuse('historical exclusion cannot mutate current work');
      continue;
    }
    if (!sha(entry.expected)) refuse(`${item.id} needs an original record fingerprint`);
  }
  const delta = completionDelta(state, events, plan);
  if (delta.items.length && !(plainDelta(delta) && acceptedDelta(events, plan, delta))) refuseDelta(delta);
  for (const entry of entries) {
    if (historical.has(entry)) continue;
    const item = state.items.get(entry.item), run = state.runs.get(entry.run);
    if (item.kind !== 'work' || item.role === 'human' || item.meta.operator_reserved) refuse(`${item.id} is not ordinary work`);
    if (item.closed || item.runs.at(-1) !== run.id || run.abandoned) refuse(`${item.id} changed completion or current run`);
  }
  const add = [];
  for (const entry of entries) {
    if (historical.has(entry)) continue;
    const run = state.runs.get(entry.run);
    if (!Array.isArray(entry.superseded) || new Set(entry.superseded).size !== entry.superseded.length) refuse(`${entry.item} needs explicit superseded runs`);
    for (const id of entry.superseded) {
      const old = state.runs.get(id);
      if (!old || old.item !== entry.item || old.started.seq >= run.started.seq || old.report || old.abandoned)
        refuse(`${id} is not an open superseded attempt of ${entry.item}`);
    }
    const omitted = openRuns(state, entry.item).filter(r => r.id !== run.id && !entry.superseded.includes(r.id));
    if (omitted.length) refuse(`${entry.item} has unaccounted open runs: ${omitted.map(r => r.id).join(', ')}`);
  }
  for (const entry of plan.items) {
    const item = state.items.get(entry.item), run = state.runs.get(entry.run);
    if (!hash(entry.head) || !text(entry.why) || !Array.isArray(entry.superseded) ||
        new Set(entry.superseded).size !== entry.superseded.length) refuse(`invalid completion for ${item.id}`);
    if (!run.report || !['done', 'blocked'].includes(run.report.outcome)) refuse(`${run.id} needs a recorded done or resolved blocked report`);
    const questions = run.report.questions ?? run.report.extra?.questions;
    if ((run.report.outcome !== 'done' || run.report.blockers?.length || questions?.length) && !text(entry.resolution))
      refuse(`${run.id} needs explicit supervisor resolution of its report blockers/questions`);
    const remaining = openRuns(state, item.id).filter(r => !entry.superseded.includes(r.id));
    if (remaining.length) refuse(`${item.id} still has unaccounted open runs: ${remaining.map(r => r.id).join(', ')}`);
    const note = `Batch ${plan.batch} promoted ${entry.head} into ${plan.tip}; gate ${plan.gate.log} (sha256 ${plan.gate.sha256}). ${entry.why}${entry.resolution ? ` Resolution: ${entry.resolution}` : ''}`;
    for (const id of entry.superseded) add.push({ type: 'run.abandoned', id,
      note: `Superseded by ${run.id}; ${note}` });
    add.push({ type: 'note.added', id: item.id, text: note, decision: true,
      summary: `Promoted and reconciled in batch ${plan.batch}.` });
    add.push({ type: 'item.closed', id: item.id, as: 'done', note });
  }
  // Evaluate dependencies against the complete batch, not its array order.
  const projected = fold([...events, ...add]);
  for (const entry of plan.excluded) {
    if (historical.has(entry)) continue;
    if (!text(entry.reason) || !text(entry.next_action) || !Array.isArray(entry.blocked_by) ||
        new Set(entry.blocked_by).size !== entry.blocked_by.length) refuse(`exclusion ${entry.item} needs a reason, next action and blocker list`);
    for (const blocker of entry.blocked_by) {
      if (!projected.items.has(blocker) || wouldCycleBlock(projected, blocker, entry.item))
        refuse(`invalid exclusion blocker ${blocker} for ${entry.item}`);
      if (!projected.links.some(l => l.blocker === blocker && l.blocked === entry.item)) {
        projected.links.push({ blocker, blocked: entry.item });
        add.push({ type: 'link.added', blocker, blocked: entry.item });
      }
    }
    const note = `Excluded from batch ${plan.batch}: ${entry.reason} Next action: ${entry.next_action}`;
    for (const id of entry.superseded) add.push({ type: 'run.abandoned', id,
      note: `Superseded by ${entry.run}; ${note}` });
    // A worker's done outcome must not leave an excluded item looking complete.
    if (state.items.get(entry.item).outcome?.value === 'done') add.push({ type: 'item.reopened', id: entry.item, note });
    add.push({ type: 'note.added', id: entry.item, text: note, decision: true,
      summary: `Excluded from batch ${plan.batch}; ${entry.next_action}` });
  }
  const final = fold([...events, ...add]);
  const historicalIds = new Set([...historical].map(e => e.item));
  for (const entry of plan.items) {
    const unresolved = final.links.filter(l => l.blocked === entry.item &&
      (!releases(final, l.blocker, itemStatus(final, l.blocker)) ||
        (historicalIds.has(l.blocker) && !final.items.get(l.blocker).closed)));
    if (unresolved.length) refuse(`${entry.item} has unresolved or declined blockers: ${unresolved.map(l => l.blocker).join(', ')}`);
    // The fingerprint covers links, not children: recheck questions raised after the fast-forward guard.
    const [question] = openQuestionsFor(final, entry.item);
    if (question) refuse(`${entry.item} has an open operator question ${question.id}`);
  }
  add.push({ type: 'promotion.reconciled', batch: plan.batch, identity: plan.identity,
    fingerprint, base: plan.base, tip: plan.tip, gate: plan.gate,
    heads: plan.items.map(({ item, run, head }) => ({ item, run, head })),
    items: plan.items.map(e => e.item), runs: plan.items.map(e => e.run),
    superseded: entries.flatMap(e => e.superseded), excluded: plan.excluded.map(e => e.item),
    historical_exclusions: [...historical].map(({ item, run, reason, next_action }) => ({ item, run, reason, next_action })) });
  return { add, result: { batch: plan.batch, replayed: false, items: plan.items.map(e => e.item),
    superseded: entries.flatMap(e => e.superseded), excluded: plan.excluded.map(e => e.item) } };
}

export function completeBatchCommand(argv, { openOrg, mutate, out }) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: { file: { type: 'string' }, 'accept-delta': { type: 'string' }, why: { type: 'string' } } });
  if (positionals.length || !values.file) refuse('usage: record complete-batch --file JSON');
  if (values.why !== undefined && values['accept-delta'] === undefined) refuse('--why needs --accept-delta');
  const plan = JSON.parse(fs.readFileSync(values.file, 'utf8')), ctx = openOrg({ readOnly: true });
  const org = fs.realpathSync(ctx.dir);
  const { result } = mutate(ctx, (state, events) => values['accept-delta'] !== undefined
    ? refreshCompletionEvents(state, events, plan, org, values['accept-delta'], values.why)
    : completionEvents(state, events, plan, org));
  out(JSON.stringify(result) + '\n');
}
