import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLaunchRefused, assertLaunchPrompted, launchCreations } from '../launch.mjs';
import { cutoverChecks, runCase } from '../cases.mjs';

const before = () => ({ workspace: 'existing-project', tabs: [{ tab_id: 'existing:tab' }],
  panes: [{ pane_id: 'existing:pane' }], agents: [], creations: [], prompts: [] });
function launched(initial) {
  const after = structuredClone(initial);
  after.tabs.push({ tab_id: 'executive:tab' }); after.panes.push({ pane_id: 'executive:pane' });
  after.creations.push({ args: ['tab', 'create', '--workspace', initial.workspace],
    result: { tab: { tab_id: 'executive:tab' }, root_pane: { pane_id: 'executive:pane' } } });
  after.agents.push({ workspace_id: initial.workspace, tab_id: 'executive:tab', pane_id: 'executive:pane', name: 'exec-0010' });
  after.prompts.push({ pane: 'executive:pane', name: 'exec-0010',
    line: 'You are a fresh, short-lived orchestrator for this project. Mode: continue. ORG_DIR=/scratch/record' });
  return after;
}

test('native creation envelopes retain their result once and exclude failed creates and reads', () => {
  const initial = before(), after = launched(initial), receipt = after.creations[0];
  after.creations = launchCreations([
    { args: ['tab', 'list', '--workspace', initial.workspace], code: 0, stdout: '{"result":{}}' },
    { args: receipt.args, code: 1, stdout: '{"error":{"code":"native-error"}}' },
    { args: receipt.args, code: 0, stdout: JSON.stringify({ result: receipt.result, id: 'cli:tab:create' }) },
  ]);
  assert.deepEqual(after.creations, [receipt]);
  assert.equal(assertLaunchPrompted(initial, after).pane, 'executive:pane');
});

test('a leaking refusal fails even when the separate configured workspace is unchanged', async () => {
  const initial = before(), after = launched(initial), configured = { tabs: ['configured:tab'] };
  const refused = { status: 1, configuredBefore: configured, configuredAfter: structuredClone(configured) };
  assert.deepEqual(refused.configuredAfter, refused.configuredBefore); // The old check would pass.
  const results = [];
  await runCase(results, cutoverChecks.retry, () => {
    assert.notEqual(refused.status, 0);
    assertLaunchRefused(initial, after);
  });
  assert.equal(results[0].status, 'FAIL'); assert.equal(results[0].origin, 'product');
  assert.match(results[0].detail, /refused launch created a session/);
  // Closing the leaked tab again must not erase its creation receipt.
  after.tabs = initial.tabs; after.panes = initial.panes; after.prompts = [];
  assert.throws(() => assertLaunchRefused(initial, after), /created a session/);
});

test('an exit-zero no-op retry fails the production busy-retry check', async () => {
  const initial = before(), noop = { status: 0, after: structuredClone(initial) }, results = [];
  await runCase(results, cutoverChecks.retry, () => {
    assert.equal(noop.status, 0); // The old success-only check would pass.
    assertLaunchPrompted(initial, noop.after);
  });
  assert.equal(results[0].status, 'FAIL'); assert.equal(results[0].origin, 'product');
  assert.match(results[0].detail, /retry must create exactly one session/);
});

test('a refusal with no effects and one registered, prompted retry session qualify', () => {
  const initial = before();
  assert.doesNotThrow(() => assertLaunchRefused(initial, structuredClone(initial)));
  assert.deepEqual(assertLaunchPrompted(initial, launched(initial)), {
    workspace: 'existing-project', tab: 'executive:tab', pane: 'executive:pane', agent: 'exec-0010',
    prompt: launched(initial).prompts[0],
  });
});

test('retry requires destination, native creation, live topology, registration and exact prompt attribution', () => {
  const initial = before();
  const controls = [
    [after => after.creations.push(structuredClone(after.creations[0])), /exactly one session/],
    [after => after.creations[0].args[3] = 'configured-project', /outside launcher destination/],
    [after => after.tabs.pop(), /exactly one new destination tab/],
    [after => after.panes.pop(), /exactly one new destination pane/],
    [after => after.agents = [], /one registered agent/],
    [after => after.prompts = [], /exactly one prompt/],
    [after => after.prompts.push(structuredClone(after.prompts[0])), /exactly one prompt/],
    [after => after.prompts[0].pane = 'existing:pane', /another pane/],
    [after => after.prompts[0].name = 'another-agent', /another agent/],
    [after => after.prompts[0].line = 'acceptance-state idle', /orchestrator/],
  ];
  for (const [mutate, expected] of controls) {
    const after = launched(initial); mutate(after);
    assert.throws(() => assertLaunchPrompted(initial, after), expected);
  }
});

test('refusal also rejects topology or prompt changes without a creation receipt', () => {
  const initial = before();
  for (const kind of ['tabs', 'panes', 'prompts']) {
    const after = launched(initial); after.creations = []; after.tabs = initial.tabs; after.panes = initial.panes; after.prompts = [];
    after[kind] = launched(initial)[kind];
    assert.throws(() => assertLaunchRefused(initial, after), /refused launch/);
  }
});
