// Advisory only: derive warnings from the same record snapshot as closure.
// This neither validates an authority archive nor changes trial admission.
export function trialsAffectedByClose(state, events, item) {
  const notes = new Map(events.filter(e => e.type === 'note.added').map(e => [e.seq, e]));
  return events.filter(e => e.type === 'line-service.probation-authorized' &&
    !events.some(end => ['line-service.probation-withdrawn', 'line-service.probation-completed'].includes(end.type) &&
      end.id === e.id && end.project === e.project && end.org === e.org)).flatMap(trial => {
    const note = notes.get(trial.authority);
    if (!note?.decision) return [];
    const owner = state.runs.get(note.id)?.item ?? note.id, seen = new Set();
    for (let id = owner; id && !seen.has(id); id = state.items.get(id)?.parent) {
      if (id === item) return [{ id: trial.id, owner }];
      seen.add(id);
    }
    return [];
  });
}
