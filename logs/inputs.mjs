// Explicit read-only adapters. Event paths are retained as references, never opened.
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { stateDirectory, readJournal } from '../messages/journal.mjs';
import { digest, canonical } from '../messages/schema.mjs';
import { inputOf } from './journal.mjs';

export async function shadowInput(scope) {
  const result = await readJournal(stateDirectory(scope));
  const events = result.entries.filter(e => e.shadow.disposition === 'accepted').map(entry => {
    const { shadow, ...event } = inputOf(entry);
    return event;
  });
  // The stable source identity makes a repeated loss observation append-once.
  const gaps = result.tornTail ? [{ source: path.join(stateDirectory(scope), 'shadow.jsonl'),
    reason: 'incomplete shadow tail; source bytes preserved', ...result.tornTail }] : [];
  return { events, gaps };
}

// The record's selected receipts have no single text format. Never interpret a
// note body or infer a result from a tag. Copy only these typed fields.
const fields = ['outcome', 'verdict', 'reviewScope', 'lane', 'causeKey', 'reviewChain', 'round', 'findingKey',
  'process', 'report', 'openRun', 'idleSince', 'parkedReview', 'state', 'attempt', 'expectedHold', 'holdOwner',
  'admission', 'resource', 'requestId', 'jobId', 'queueState', 'pendingSince', 'channel', 'route'];
const select = data => Object.fromEntries(fields.filter(k => ['string', 'number', 'boolean'].includes(typeof data?.[k])).map(k => [k, data[k]]));
const receipts = new Map([['dispatch.receipt', 'record.dispatch.receipt'], ['watch.receipt', 'record.watch.receipt'],
  ['dispatch.delivery.receipt', 'record.dispatch.receipt'], ['watch.observation', 'record.watch.receipt'], ['review.verdict', 'review.verdict']]);

export async function recordInput({ org, identity, commonDir }) {
  org = await fs.realpath(org);
  const { events: record, tornTail } = loadEvents(org), state = fold(record), events = [];
  const epoch = digest(org);
  for (const source of record) {
    const runId = source.run ?? (source.type.startsWith('run.') ? source.id : null), run = state.runs.get(runId);
    const itemId = source.item ?? run?.item, item = state.items.get(itemId);
    let type, payload;
    if (source.type === 'report.ingested' && run && item) {
      type = 'run.report.available';
      payload = { ...select(source.report), reportRef: source.file ?? run.report_path ?? null, reportDigest: source.sha256 ?? null };
      if (source.report?.verdict) payload.verdict = source.report.verdict;
    } else if (source.type === 'run.started' && run && item) {
      type = 'record.dispatch.receipt'; payload = { outcome: 'started', ...select(source.meta), reportRef: source.report_path ?? null };
    } else if (receipts.has(source.type) && run && item) {
      type = receipts.get(source.type); payload = { ...select(source), ...select(source.receipt) };
    } else continue;
    events.push({ schema: 'brain.log/v1', eventId: `record:${epoch}:${source.seq}`,
      producer: { id: 'record-mirror', epoch, sequence: source.seq }, occurredAt: source.at,
      type, level: 'info', identity, project: { commonDir }, run: runId, item: itemId, orgRef: org,
      source: { kind: 'record', ref: `${path.join(org, 'events.jsonl')}#${source.seq}` }, payload: { validated: true, ...payload } });
  }
  return { events, gaps: tornTail ? [{ source: path.join(org, 'events.jsonl'), reason: 'record reader reports torn tail; authoritative source unchanged' }] : [] };
}
export function sourceGap(gap, { identity, commonDir }, occurredAt) {
  const id = digest(canonical(gap));
  return { schema: 'brain.log/v1', eventId: `source-gap:${id}`, producer: { id: 'source-gap', epoch: id, sequence: 1 },
    occurredAt, type: 'service.source.gap', level: 'warn', identity, project: { commonDir },
    source: { kind: 'source-loss', ref: gap.source }, payload: gap };
}

export async function replay(journal, inputs) {
  let accepted = 0, duplicates = 0;
  // Ordering across independent sources is a deterministic replay convenience,
  // never a claim of global causal order or authority.
  const events = inputs.flatMap(i => i.events).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId));
  const at = events.at(-1)?.occurredAt ?? '1970-01-01T00:00:00Z';
  events.push(...inputs.flatMap(i => i.gaps).map(g => sourceGap(g, journal, at)));
  for (const event of events) {
    const result = await journal.appendRaw(event);
    result.disposition === 'accepted' ? accepted++ : duplicates++;
  }
  // Rebuild on every foreground replay, including an all-duplicate retry after
  // a crash between acceptance and the detector pass.
  await journal.reconcileDetectors();
  await journal.retain();
  return { accepted, duplicates };
}
