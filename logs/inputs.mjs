// Explicit read-only adapters. Event paths are retained as references, never opened.
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadEvents } from '../lib/store.mjs';
import { fold, extendFold } from '../lib/state.mjs';
import { roleIs } from '../lib/roles.mjs';
import { timingEvent, waitKinds } from '../lib/run-timing.mjs';
import { stateDirectory, readJournal } from '../messages/journal.mjs';
import { digest, canonical, parseJSON, MAX_BODY_BYTES } from '../messages/schema.mjs';
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
export async function recordInput({ org, identity, commonDir }) {
  org = await fs.realpath(org);
  const { events: record, tornTail } = loadEvents(org), state = fold([]), events = [], seenTiming = new Set();
  const epoch = digest(org);
  for (const source of record) {
    extendFold(state, [source]);
    const runId = source.run ?? (source.type.startsWith('run.') ? source.id : null), run = state.runs.get(runId);
    const itemId = source.item ?? run?.item, item = state.items.get(itemId);
    const envelope = (type, payload, id = String(source.seq), occurredAt = source.at) => ({
      schema: 'brain.log/v1', eventId: `record:${epoch}:${id}`,
      producer: id === String(source.seq) ? { id: 'record-mirror', epoch, sequence: source.seq }
        : { id: 'record-timing', epoch: digest(`${epoch}:${id}`), sequence: 1 },
      occurredAt, type, level: 'info', identity, project: { commonDir }, run: runId, item: itemId, orgRef: org,
      source: { kind: 'record', ref: `${path.join(org, 'events.jsonl')}#${source.seq}` }, payload: { validated: true, ...payload } });
    let type, payload;
    if (source.type === 'report.ingested' && run && item) {
      type = 'run.report.available';
      const extra = source.report?.extra ?? {};
      payload = { ...select(source.report), ...select(extra), reportRef: source.file ?? run.report_path ?? null, reportDigest: source.sha256 ?? null };
      if (extra.verdict !== undefined) payload.verdict = extra.verdict === null || ['string', 'number', 'boolean'].includes(typeof extra.verdict) ? String(extra.verdict).trim().toUpperCase() : 'UNKNOWN';
      const scope = extra.review_scope ?? extra.reviewScope;
      if (typeof scope === 'string') payload.reviewScope = scope.trim().toLowerCase();
      if (roleIs(item, 'REV') || extra.verdict !== undefined) {
        payload.channel = 'auto-review';
        payload.reviewChain ??= item.parent ?? item.id;
        payload.round ??= item.runs.indexOf(runId) + 1;
      }
    } else if (source.type === 'run.started' && run && item) {
      type = 'record.dispatch.receipt'; payload = { outcome: 'started', ...select(source.meta), reportRef: source.report_path ?? null };
    } else if (source.type === 'run.updated' && run && item) {
      for (const metadata of ['process_end', 'dispatch_waits']) if (Object.hasOwn(source.meta ?? {}, metadata)) {
        let observations;
        try {
          const value = parseJSON(source.meta[metadata], MAX_BODY_BYTES);
          observations = (metadata === 'process_end' ? [value] : value).map(timingEvent);
          if (!observations.every(e => e.run === runId && e.item === itemId && e.lane === (run.meta.lane ?? null) &&
            (metadata === 'process_end' ? e.kind === 'process_end' : waitKinds.includes(e.kind)))) throw Error('foreign timing metadata');
        } catch {
          events.push(envelope('record.watch.receipt', { metadata, status: 'unknown', reason: 'invalid or mismatched timing metadata' }, `invalid-${source.seq}-${metadata}`));
          continue;
        }
        for (const observation of observations) {
          const id = `timing-${digest(canonical(observation))}`;
          if (seenTiming.has(id)) continue;
          seenTiming.add(id);
          const payload = { metadata, kind: observation.kind, outcome: observation.outcome, lane: observation.lane };
          if (metadata === 'process_end') Object.assign(payload, { process: observation.outcome === 'idle' ? 'idle' : 'stopped',
            // A process-end receipt does not record the watcher's report-file
            // check. No ingested report is not proof that its file is absent.
            report: run.report ? 'present' : 'unknown', openRun: !run.report && !run.abandoned,
            ...(observation.outcome === 'idle' ? { idleSince: observation.at } : {}) });
          else Object.assign(payload, { resource: 'memory', admission: observation.outcome === 'entry' ? 'pending' : observation.outcome === 'granted' ? 'granted' : 'unknown' });
          // Generic failed/stopped waits carry no refusal cause. Keep the
          // result, but do not invent cause keys or admission-refusal hits.
          events.push(envelope('record.watch.receipt', payload, id, observation.at));
        }
      }
      continue;
    } else continue;
    events.push(envelope(type, payload));
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
