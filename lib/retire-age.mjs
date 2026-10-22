// Display-only event history. Never stores age or feeds retirement authority.
import { fold, extendFold } from './state.mjs';
import { chainFor, terminalReason } from './retire.mjs';

export function terminalTimes(snapshot, runs) {
  const tracks = new Map();
  const gitFor = run => snapshot.git?.find(g => g.path === run.workspace);
  for (const run of runs) {
    const chain = chainFor(snapshot.record, run), key = chain.root?.id ?? run.item;
    if (!tracks.has(key)) tracks.set(key, { run, ids: chain.ids,
      runs: new Set(chain.runs.filter(r => chain.ids.has(r.item)).map(r => r.id)), terminal: false, at: null });
  }
  const state = fold([]);
  for (const event of snapshot.events ?? []) {
    extendFold(state, [event]);
    for (const track of tracks.values()) {
      if (!track.ids.has(event.id ?? event.item) && !track.runs.has(event.run ?? event.id) &&
          !['item.added', 'item.updated', 'link.added', 'link.removed'].includes(event.type)) continue;
      const run = state.runs.get(track.run.id);
      const terminal = Boolean(run && !terminalReason(chainFor(state, run), gitFor(track.run), snapshot));
      if (terminal && !track.terminal) track.at = event.at;
      if (!terminal) track.at = null;
      track.terminal = terminal;
    }
  }
  return new Map(runs.map(run => {
    const chain = chainFor(snapshot.record, run);
    return [run.id, terminalReason(chain, gitFor(run), snapshot) ? null : tracks.get(chain.root?.id ?? run.item)?.at ?? null];
  }));
}

export const ageMs = (at, now) => Number.isFinite(Date.parse(at)) && Number.isFinite(Date.parse(now)) ? Math.max(0, Date.parse(now) - Date.parse(at)) : null;
export function renderAge(ms) {
  if (ms === null || ms === undefined) return null;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ${Math.floor(ms % 3600000 / 60000)}m`;
  return `${Math.floor(ms / 86400000)}d ${Math.floor(ms % 86400000 / 3600000)}h`;
}
