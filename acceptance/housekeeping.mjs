import assert from 'node:assert/strict';

// Housekeeping may close a finished worker during auto-tidy or its later scan.
// Match the worker's tab, never an unrelated closure or a dry-run plan.
export function assertHousekeepingActions(text, { closedTab, keptTabs }) {
  const actions = text.split('\n').filter(Boolean).map(JSON.parse);
  const closed = (tab) => actions.some((entry) => entry.dryRun !== true && (
    (entry.action === 'closed' && entry.tab_id === tab) ||
    (entry.action === 'tidy-tabs' && entry.output?.split('\n').some((line) => line.startsWith(`closed ${tab} "`)))
  ));
  assert.ok(closed(closedTab), `housekeeping must log closure of eligible worker tab ${closedTab}`);
  for (const tab of keptTabs) {
    assert.ok(!closed(tab), `housekeeping must not close ineligible worker tab ${tab}`);
    assert.ok(actions.some((entry) => entry.action === 'keep' && entry.tab_id === tab),
      `housekeeping must keep ineligible worker tab ${tab}`);
  }
}
