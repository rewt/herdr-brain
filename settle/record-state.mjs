// Settle reads derived item/run views but needs recorded links for waiting reports.
import { fold } from '../lib/state.mjs';

export function snapshotState(snapshot, events) {
  return { items: new Map(snapshot.items.map(i => [i.id, i])), runs: new Map(snapshot.runs.map(r => [r.id, r])),
    // Match the snapshot's append-only prefix; derived child holds are not recorded links.
    links: fold(events.slice(0, snapshot.events)).links };
}

export function waitingOutcome(state, item) {
  return item.outcome?.value === 'needs_human'
    || (item.outcome?.value === 'blocked' && !state.links.some(l => l.blocked === item.id));
}
