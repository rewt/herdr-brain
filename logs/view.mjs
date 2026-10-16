import { canonical, digest } from '../messages/schema.mjs';
import { route, directShadow } from './rules.mjs';

const sorted = map => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));
const increment = (map, key, value = 1) => map.set(key, (map.get(key) ?? 0) + value);
export function measure(state) {
  const byType = new Map(), byKind = new Map(), byPath = new Map(), days = new Map(), bursts = [], hits = new Map();
  let unknown = 0, gaps = 0, coalesced = 0;
  for (const e of state.entries) {
    const bytes = Buffer.byteLength(JSON.stringify(e) + '\n'), day = e.occurredAt.slice(0, 10);
    const daily = days.get(day) ?? { bytes: 0, events: 0 }; daily.bytes += bytes; daily.events++; days.set(day, daily);
    bursts.push({ at: Date.parse(e.occurredAt), bytes });
    increment(byType, e.type); increment(byKind, e.type === 'session.message.v1' ? e.payload.kind : 'non-message'); increment(byPath, route(e));
    if (e.type === 'service.source.gap') gaps++;
    if (e.type === 'service.events.coalesced') coalesced += e.payload.count;
    if (e.type === 'detector.hit') { increment(hits, `${e.payload.rule}/v${e.payload.version}`); if (e.payload.status === 'unknown') unknown++; }
  }
  const maximumBurst = { windowMs: 1000, events: 0, bytes: 0 };
  bursts.sort((a, b) => a.at - b.at);
  let start = 0, burstBytes = 0;
  for (let end = 0; end < bursts.length; end++) {
    burstBytes += bursts[end].bytes;
    while (bursts[end].at - bursts[start].at >= 1000) burstBytes -= bursts[start++].bytes;
    maximumBurst.events = Math.max(maximumBurst.events, end - start + 1); maximumBurst.bytes = Math.max(maximumBurst.bytes, burstBytes);
  }
  return { schema: 'brain.logs-report/v1', events: state.entries.length, bytes: state.segments.reduce((n, s) => n + s.bytes, 0),
    days: sorted(days), maximumBurst, byType: sorted(byType), byKind: sorted(byKind), byPath: sorted(byPath),
    wouldRoute: { direct: byPath.get('direct') ?? 0, rule: byPath.get('rule') ?? 0, triage: byPath.get('triage') ?? 0, telemetry: byPath.get('telemetry') ?? 0, unknown: byPath.get('unknown') ?? 0 },
    detectorHits: sorted(hits), detectorUnknown: unknown, directShadowLines: directShadow(state.entries).length,
    sourceGaps: gaps, coalesced, floorSequence: state.floor?.sequence ?? null, tornTail: state.tornTail };
}
export function selectEntries(entries, { since, workspace, session } = {}) {
  if (since !== undefined && (!since.endsWith('Z') || !Number.isFinite(Date.parse(since)))) throw Error('--since must be a UTC timestamp');
  const selected = entries.filter(e => (!since || Date.parse(e.occurredAt) >= Date.parse(since)) && (!workspace || e.workspaceUid === workspace) && (!session || e.sessionUid === session));
  const ids = new Set(selected.map(e => e.eventId));
  return entries.filter(e => ids.has(e.eventId) || (e.type === 'detector.hit' && (!since || Date.parse(e.occurredAt) >= Date.parse(since)) && e.payload.sourceIds.some(id => ids.has(id))));
}
export function render(entries) {
  return entries.map(e => `${e.cursor.epoch}:${e.cursor.sequence} ${e.occurredAt} ${e.type} path=${route(e)} ${e.type === 'detector.hit' ? `${e.payload.rule}/v${e.payload.version} ${e.payload.status} recurrence=${e.payload.recurrence} ${e.payload.detail}` : e.payload.summary ?? ''} source=${e.source?.ref ?? e.eventId}`
    .replace(/[\p{Cc}\u2028\u2029]/gu, c => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`)).join('\n') + (entries.length ? '\n' : '');
}

// Lossless progress coalescing: annotate five-second windows, retain originals
// for detectors/replay. No critical message, unknown or control is coalesced.
export async function coalesce(journal) {
  const { entries } = await journal.read(), windows = new Map(), windowMs = journal.limits.progressMs;
  const covered = entries.filter(e => e.type === 'service.events.coalesced' && e.producer.id === 'logs-control').flatMap(e => e.payload.sequenceRanges);
  for (const e of entries) if (!covered.some(([start, end]) => e.cursor.sequence >= start && e.cursor.sequence <= end) && e.type === 'session.message.v1' && e.sessionUid && e.payload.kind === 'notice' && e.payload.evidence?.validated === true && e.payload.evidence.channel === 'operational' && e.payload.evidence.outcome === 'progress') {
    const id = canonical([e.sessionUid, e.incarnation, Math.floor(Date.parse(e.occurredAt) / windowMs)]);
    const group = windows.get(id) ?? []; group.push(e); windows.set(id, group);
  }
  let count = 0;
  for (const [id, group] of windows) if (group.length > 1) {
    const sequences = group.map(e => e.cursor.sequence).sort((a, b) => a - b), ranges = [];
    for (const seq of sequences) {
      const last = ranges.at(-1);
      if (last && last[1] === seq - 1) last[1] = seq; else ranges.push([seq, seq]);
    }
    const input = journal.control('service.events.coalesced', { count: group.length, sequenceRanges: ranges, windowMs, sessionUid: group[0].sessionUid }, digest(id + canonical(sequences)));
    // Control IDs remain bounded even for a busy five-second window.
    input.eventId = `coalesced:${digest(id + canonical(sequences))}`;
    input.producer.epoch = input.eventId;
    input.occurredAt = group.at(-1).occurredAt;
    const result = await journal.appendRaw(input, true);
    if (result.disposition === 'accepted') count++;
  }
  return count;
}
