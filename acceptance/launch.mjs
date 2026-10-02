// Verify observed launch behavior, independent of the command's exit status.
import assert from 'node:assert/strict';

export const launchCreations = (rows) => rows.filter((row) => row.code === 0 &&
  ['workspace', 'worktree', 'tab'].includes(row.args[0]) && ['create', 'open'].includes(row.args[1]))
  .map((row) => ({ args: row.args, result: JSON.parse(row.stdout).result }));

const ids = (rows, key) => rows.map((row) => row[key]).sort();
const appended = (before, after) => {
  assert.deepEqual(after.slice(0, before.length), before, 'launch receipts must be append-only');
  return after.slice(before.length);
};
const sameDestination = (before, after) => {
  assert.ok(before.workspace, 'launcher destination receipt missing');
  assert.equal(after.workspace, before.workspace, 'launcher destination changed');
};

export function assertLaunchRefused(before, after) {
  sameDestination(before, after);
  assert.deepEqual(appended(before.creations, after.creations), [], 'refused launch created a session');
  assert.deepEqual(ids(after.tabs, 'tab_id'), ids(before.tabs, 'tab_id'), 'refused launch changed destination tabs');
  assert.deepEqual(ids(after.panes, 'pane_id'), ids(before.panes, 'pane_id'), 'refused launch changed destination panes');
  assert.deepEqual(appended(before.prompts, after.prompts), [], 'refused launch delivered a prompt');
}

export function assertLaunchPrompted(before, after) {
  sameDestination(before, after);
  const created = appended(before.creations, after.creations);
  assert.equal(created.length, 1, 'retry must create exactly one session');
  const receipt = created[0];
  assert.equal(receipt.args[0], 'tab', 'retry must create a tab');
  assert.equal(receipt.args[1], 'create');
  const workspaceOption = receipt.args.indexOf('--workspace');
  assert.ok(workspaceOption >= 0);
  assert.equal(receipt.args[workspaceOption + 1], before.workspace, 'retry created outside launcher destination');
  const tab = receipt.result.tab?.tab_id, pane = receipt.result.root_pane?.pane_id;
  assert.ok(tab && pane, 'retry creation receipt missing tab/pane');
  assert.deepEqual(ids(after.tabs, 'tab_id'), [...ids(before.tabs, 'tab_id'), tab].sort(), 'retry must leave exactly one new destination tab');
  assert.deepEqual(ids(after.panes, 'pane_id'), [...ids(before.panes, 'pane_id'), pane].sort(), 'retry must leave exactly one new destination pane');
  const agents = after.agents.filter((agent) => agent.pane_id === pane);
  assert.equal(agents.length, 1, 'retry session must have one registered agent');
  const agent = agents[0];
  assert.equal(agent.workspace_id, before.workspace);
  assert.equal(agent.tab_id, tab);
  assert.match(agent.name, /^exec-/, 'retry must register the executive');
  const prompts = appended(before.prompts, after.prompts);
  assert.equal(prompts.length, 1, 'retry must deliver exactly one prompt');
  assert.equal(prompts[0].pane, pane, 'retry prompt reached another pane');
  assert.equal(prompts[0].name, agent.name, 'retry prompt reached another agent');
  assert.match(prompts[0].line, /^You are a fresh, short-lived orchestrator/);
  assert.match(prompts[0].line, /Mode: continue\./);
  return { workspace: before.workspace, tab, pane, agent: agent.name, prompt: prompts[0] };
}
