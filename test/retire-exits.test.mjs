import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exitFixture } from './helpers/retire-exit-fixture.mjs';
import { hold, isolatedEnv } from './helpers/retire-fixture.mjs';
import { planRetirement, executeRetirement } from '../lib/retire.mjs';
import { finishCleanup, retryCleanup } from '../promote/promote.mjs';

test('an observed native exit records its terminal and shell before closing an unregistered worker', t => {
  const f = exitFixture(t, { bound: true }), logs = [], bytes = fs.readFileSync(f.eventFile);
  const retirement = f.retirement({ log: row => logs.push(row) }), plan = retirement.plan();
  assert.equal(plan.close[0].decision, 'exit');
  assert.equal(retirement.apply(plan)[0].action, 'closed');
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
  const receipt = logs.find(row => row.action === 'exit-observed');
  assert.equal(receipt.schema, 'retirement-exit/v1'); assert.equal(receipt.run, 'R-1');
  assert.equal(receipt.pane, 'w:p'); assert.equal(receipt.occupant.terminal_id, 'term');
  assert.equal(receipt.occupant.agent_session_id, 'session');
  assert.deepEqual(receipt.shell, { pid: 1, identity: 'shell', command: '[zsh]' });
  assert.ok(logs.indexOf(receipt) < logs.findIndex(row => row.action === 'closed'));
  assert.deepEqual(fs.readdirSync(path.join(f.org, 'retirement/exits')), [], 'successful close prunes its receipt');
  assert.deepEqual(fs.readFileSync(f.eventFile), bytes, 'exit evidence never changes the fold');
});

test('an exit receipt rechecks every ordinary guard and cannot close with a stale token', t => {
  const f = exitFixture(t); f.state.failClose = true; f.save();
  const retirement = f.retirement(), result = retirement.apply(retirement.plan());
  assert.match(result[0].why, /injected tab failure/);
  const snapshot = retirement.observe(), plan = planRetirement(snapshot);
  assert.equal(plan.close[0].decision, 'release'); assert.equal(snapshot.agents.length, 0);
  const cases = [
    ['shell birth', s => { s.panes[0].process_info.process_tree[0].identity = 'replacement'; }, /shell identity/],
    ['shell pid', s => { s.panes[0].process_info.shell_pid = 99; }, /shell identity/],
    ['terminal', s => { s.panes[0].terminal_id = 'replacement'; }, /terminal identity/],
    ['unknown terminal', s => { delete s.panes[0].terminal_id; }, /terminal identity/],
    ['second pane', s => { s.panes.push({ ...s.panes[0], pane_id: 'w:q' }); }, /topology/],
    ['background child', s => { s.panes[0].process_info.process_tree.push({ pid: 99, identity: 'child', state: 'S', command: '[node]' }); }, /another process/],
    ['foreground child', s => { s.panes[0].process_info.foreground_processes = [{ pid: 99, name: 'zsh' }]; }, /another process/],
    ['stopped shell', s => { s.panes[0].process_info.process_tree[0].state = 'T'; }, /shell identity/],
    ['incomplete processes', s => { s.panes[0].process_info.process_tree_complete = false; }, /shell identity/],
    ['working registry entry', s => { s.agents.push({ ...s.exits[0].occupant, tab_id: 'w:t', agent_status: 'working' }); }, /is working/],
    ['replacement occupant', s => { s.agents.push({ ...s.exits[0].occupant, tab_id: 'w:t', agent_status: 'idle', agent_session_id: 'replacement' }); }, /occupant identity/],
    ['changed record', s => { s.record.runs[0].meta.terminal_id = 'replacement'; }, /recorded launch identity/],
    ['unread record', s => { s.errors.push('record unavailable'); }, /record unavailable/],
    ['open chain', s => { s.record.items[0].closed = null; }, /chain is still open/],
    ['new open run', s => { s.record.runs.push({ id: 'R-2', item: 'ENG-1', workspace: f.lane, started: { seq: 5 }, meta: {} }); }, /open run/],
    ['job reference', s => { s.references.push({ cwd: f.lane, kind: 'new job' }); }, /new job reference/],
    ['dirty Git', s => { s.git[0].clean = false; }, /not clean and integrated/],
    ['unmerged Git', s => { s.git[0].integrated = false; }, /not clean and integrated/],
    ['focus', s => { s.tabs[0].focused = true; }, /focus/],
    ['hold', s => { s.retirementHold = 'operator hold'; }, /operator hold/],
    ['no receipt', s => { s.exits = []; }, /unrecorded shell/],
    ['duplicate receipts', s => { s.exits.push(structuredClone(s.exits[0])); }, /ambiguous/],
  ];
  for (const [name, change, expected] of cases) {
    const current = structuredClone(snapshot); change(current);
    const fresh = planRetirement(current);
    assert.equal(fresh.close.length, 0, name); assert.match(fresh.keep[0].why, expected, name);
    const executed = executeRetirement(plan, { observe: () => current, close: () => assert.fail(name) });
    assert.ok(['skip-close', 'held'].includes(executed[0].action), name);
  }
});

test('absent exit receipts are pruned only on apply and never through a hold', t => {
  const f = exitFixture(t); f.state.failClose = true; f.save();
  const retirement = f.retirement(); retirement.apply(retirement.plan());
  const directory = path.join(f.org, 'retirement/exits'), file = path.join(directory, fs.readdirSync(directory)[0]);
  const state = f.read(); state.tabs = []; state.panes = []; fs.writeFileSync(f.file, JSON.stringify(state));
  const clear = hold(f);
  const held = retirement.plan(); retirement.apply(held); assert.equal(fs.existsSync(file), true);
  clear(); const plan = retirement.plan(); assert.equal(fs.existsSync(file), true, 'observation is read-only');
  retirement.apply(plan); assert.equal(fs.existsSync(file), false);
});

test('the bounded queue retry closes an exited worker and removes its integrated lane without another exit', t => {
  const f = exitFixture(t, { bound: true }); isolatedEnv(t, f);
  f.state.failClose = true; f.save();
  const queue = f.queue(), bytes = fs.readFileSync(f.eventFile);
  const result = finishCleanup(f.job, { outcome: 'promoted', tip: f.head, workspace: f.lane }, queue, { now: 1000 });
  assert.equal(result.cleanup.state, 'pending'); assert.match(result.cleanup.last_refusal, /injected tab failure/);
  queue.transaction(data => data.results.push({ ...f.job, ...result }));
  const state = f.read(); state.failClose = false; fs.writeFileSync(f.file, JSON.stringify(state));
  retryCleanup(queue, { now: result.cleanup.next_attempt_at });
  const saved = queue.load().results[0];
  assert.equal(saved.outcome, 'promoted'); assert.equal(saved.cleanup.state, 'complete', saved.reason);
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t'], ['workspace', 'close', 'w']]);
  assert.equal(fs.existsSync(f.lane), false); assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  assert.deepEqual(fs.readFileSync(f.eventFile), bytes);
});

test('an unregistered shell without an observed terminal never receives exit authority', t => {
  const f = exitFixture(t); delete f.state.panes[0].terminal_id; f.save();
  const retirement = f.retirement(), result = retirement.apply(retirement.plan());
  assert.equal(result[0].action, 'skip-close'); assert.match(result[0].why, /unrecorded shell/);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/exits')), false);
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit']]);
});
