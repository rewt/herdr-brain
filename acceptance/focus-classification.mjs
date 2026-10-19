// Wall-clock evidence windows, not load-scaled command deadlines. Calls win
// over operator activity; ownership alone cannot identify the focus source.
export const ATTRIBUTION_WINDOW_MS = 5000;
export const OPERATOR_ACTIVITY_WINDOW_MS = 60_000;

export function targetsDestination(call, pane, workspace) {
  if (call.targets?.panes?.includes(pane) || call.targets?.workspaces?.includes(workspace)) return true;
  if (call.created?.panes?.includes(pane) || call.created?.workspaces?.includes(workspace)) return true;
  return [call.args, call.requested].some((argv = []) => {
    const args = argv.slice(0, argv.includes('--') ? argv.indexOf('--') : argv.length);
    if (['pane', 'agent'].includes(args[0]) && args[2] === pane) return true;
    if (workspace && args[0] === 'workspace' && args[2] === workspace) return true;
    return args.some((arg, index) =>
      (arg === '--pane' && args[index + 1] === pane) ||
      (workspace && arg === '--workspace' && args[index + 1] === workspace));
  });
}

export function focusCallContext(rows, at) {
  const active = new Map(), completed = [], history = new Map();
  for (const row of rows) {
    if (row.at > at) continue;
    if (row.type === 'start') { active.set(row.id, row); history.set(row.id, row); }
    else if (row.type === 'end') {
      const call = active.get(row.id);
      active.delete(row.id);
      if (call) {
        const ended = { ...call, created: row.created, completedAt: row.at };
        history.set(row.id, ended);
        if (at - row.at <= ATTRIBUTION_WINDOW_MS) completed.push(ended);
      }
    }
  }
  const nearestCalls = {};
  for (const origin of ['harness', 'product']) nearestCalls[origin] = [...history.values()]
    .filter(call => call.origin === origin)
    .sort((a, b) => (b.completedAt ?? b.at) - (a.completedAt ?? a.at))[0];
  return { nearestCalls, nearbyCalls: [...active.values(), ...completed.sort((a, b) => b.completedAt - a.completedAt)] };
}

// Called only for a changed destination, after native identity and late creation
// receipts resolve. The same classifier consumes synthetic offline traces.
export function recordFocusChange(summary, row) {
  const matching = row.nearbyCalls.filter(call => targetsDestination(call, row.panes[0], row.workspaces[0]));
  row.calls = matching.some(call => call.completedAt === undefined)
    ? matching.filter(call => call.completedAt === undefined) : matching.slice(0, 1);
  const activity = summary.operatorActivity;
  const operatorActive = activity && row.at >= activity.at && row.at - activity.at <= OPERATOR_ACTIVITY_WINDOW_MS;
  if (row.calls.length || (row.owned && !operatorActive)) {
    row.classification = 'harness';
    summary.changes.push(row);
    return;
  }
  if (row.owned) {
    row.classification = 'not-attributable';
    row.operatorActivity = { ...activity, ageMs: row.at - activity.at, windowMs: OPERATOR_ACTIVITY_WINDOW_MS };
    summary.notAttributableChanges.push(row);
  } else {
    row.classification = 'external';
    summary.externalChanges.push(row);
    // Only a distinct move between two non-harness panes is evidence of
    // operator activity. Returning from a harness pane cannot start a window.
    if (row.previousOwnership === 'operator' && row.previousPane !== row.panes[0]) {
      summary.operatorActivity = { at: row.at, from: row.previousPane, to: row.panes[0] };
    }
  }
  summary.currentBaseline = row.panes[0];
  row.rebaseline = row.panes[0];
}
