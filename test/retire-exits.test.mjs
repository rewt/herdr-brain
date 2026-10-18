import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exitFixture } from './helpers/retire-exit-fixture.mjs';
import { hold, isolatedEnv } from './helpers/retire-fixture.mjs';
import { planRetirement, executeRetirement } from '../lib/retire.mjs';
import { finishCleanup, retryCleanup } from '../promote/promote.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { RETIREMENT_HOLD_PATH } from '../lib/retire-hold.mjs';

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
    ['no receipt', s => { s.exits = []; }, /inert shell/],
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
  const unlock = acquireLock(path.join(queue.directory, 'cleanup.lock'));
  try {
    assert.throws(() => retryCleanup(queue, { now: result.cleanup.next_attempt_at }), /locked:.*cleanup.lock/);
    assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit']], 'another retry owner excludes all cleanup effects');
    assert.equal(fs.existsSync(f.lane), true);
  } finally { unlock(); }
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
  assert.equal(result[0].action, 'skip-close'); assert.match(result[0].why, /inert shell/);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/exits')), false);
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit']]);
});

test('an observed exit survives a hold arriving after the agent exits and closes once it is lifted', t => {
  const f = exitFixture(t, { bound: true }); let clear;
  const retirement = f.retirement({ command: (exe, args, options) => {
    const result = spawnSync(exe, args, options);
    if (exe === f.job.herdr && args[0] === 'agent' && args[1] === 'prompt') clear = hold(f);
    return result;
  } });
  const result = retirement.apply(retirement.plan());
  assert.equal(result[0].action, 'skip-close'); assert.match(result[0].why, /retirement held/);
  assert.equal(fs.readdirSync(path.join(f.org, 'retirement/exits')).length, 1, 'a hold cannot discard the observed exit');
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit']]);
  clear();
  const next = f.retirement(); assert.equal(next.apply(next.plan())[0].action, 'closed');
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
});

test('an exit observed just as its retirement deadline expires remains available to the next pass', t => {
  const f = exitFixture(t), now = Date.now, lstat = fs.lstatSync, deadline = now() + 60000;
  let prompted = false, expired = false, result;
  const retirement = f.retirement({ deadline, command: (exe, args, options) => {
    const result = spawnSync(exe, args, options);
    if (exe === f.job.herdr && args[0] === 'agent' && args[1] === 'prompt') prompted = true;
    return result;
  } });
  const plan = retirement.plan();
  try {
    fs.lstatSync = function(file, ...args) {
      // This is the end of the first post-exit observation, after the shell and
      // record identities were read, with no more IO needed to save the receipt.
      if (prompted && !expired && file === path.join(f.repo, RETIREMENT_HOLD_PATH)) {
        expired = true; Date.now = () => deadline;
      }
      return lstat.call(this, file, ...args);
    };
    result = retirement.apply(plan);
  } finally { fs.lstatSync = lstat; Date.now = now; }
  assert.equal(expired, true); assert.equal(result[0].action, 'deferred');
  assert.equal(fs.readdirSync(path.join(f.org, 'retirement/exits')).length, 1);
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit']]);
  const next = f.retirement(); assert.equal(next.apply(next.plan())[0].action, 'closed');
});

test('exit receipt reads ignore stray temporary files and foreign projects while validating local JSON', t => {
  const f = exitFixture(t); f.state.failClose = true; f.save();
  const retirement = f.retirement(); retirement.apply(retirement.plan());
  const directory = path.join(f.org, 'retirement/exits');
  const temporary = path.join(directory, 'unfinished.json.tmp-12345'), foreign = path.join(directory, 'foreign.json');
  fs.writeFileSync(temporary, '{unfinished JSON');
  const foreignBytes = JSON.stringify({ common: path.join(f.scratch, 'another-project/.git'), schema: 'future-foreign-schema', tab: 'w:t' });
  fs.writeFileSync(foreign, foreignBytes);
  assert.equal(retirement.plan().close.length, 1, 'stray and foreign data cannot hold this project');
  const malformed = path.join(directory, 'local-malformed.json'); fs.writeFileSync(malformed, JSON.stringify({ common: f.common }));
  const kept = retirement.plan(); assert.equal(kept.close.length, 0); assert.match(kept.keep[0].why, /invalid agent exit receipt local-malformed.json/);
  fs.unlinkSync(malformed);
  const state = f.read(); state.failClose = false; fs.writeFileSync(f.file, JSON.stringify(state));
  assert.equal(retirement.apply(retirement.plan())[0].action, 'closed');
  assert.deepEqual(fs.readdirSync(directory).sort(), ['foreign.json', 'unfinished.json.tmp-12345']);
  assert.equal(fs.readFileSync(temporary, 'utf8'), '{unfinished JSON'); assert.equal(fs.readFileSync(foreign, 'utf8'), foreignBytes);
});
