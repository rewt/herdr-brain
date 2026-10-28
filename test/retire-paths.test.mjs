import { checkSessionIsolation } from './helpers/session-isolation-check.mjs';
import boundedTest from './helpers/bounded-test.mjs';
import { setImmediate as yieldToReporter } from 'node:timers/promises';
import os from 'node:os';
import { spawnScenarioChild, waitForExit } from './helpers/child.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRetirement } from '../supervisor/retire.mjs';
import { finishCleanup, retryCleanup, drain } from '../promote/promote.mjs';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { copyProduct } from '../lib/product-files.mjs';
import { requestRetirement, consumeRetirement } from '../lib/retire-trigger.mjs';
import { retirementDeadline, retirementLock } from '../lib/retire-lock.mjs';
import { stopFixtureInbox } from './helpers/inbox.mjs';
import { createHousekeeping, tidyFinishedTabs } from '../housekeeping/housekeeping.mjs';
import { recordStandardSlot, slotReceiptFile } from '../sessions/receipts.mjs';
import { classifyRetirement } from '../lib/retire-status.mjs';
import { initialShellDirectory } from '../lib/initial-shell.mjs';
import { fixture, hold, heldReason, isolatedEnv, RETIREMENT_ENV_KEYS, assertNoRemoval, completionFixture, traceLane } from './helpers/retire-fixture.mjs';

// Synchronous Git/native fixtures otherwise keep node:test's IPC queued across
// dozens of completed tests. Let the previous result and teardown reach the
// reporter before starting another fixture, including under suite cancellation.
function test(name, body) {
  return boundedTest(name, async t => { await yieldToReporter(); return body(t); });
}

const root = fileURLToPath(new URL('../', import.meta.url));
const laneCLI = path.join(root, 'lanes/lane.mjs'), recordCLI = path.join(root, 'bin/org.mjs');

async function checkRetirementRestoration(t, body) {
  const snapshot = () => Object.fromEntries(RETIREMENT_ENV_KEYS.map(key => [key, process.env[key]]));
  const before = snapshot();
  await t.test('fixture lifecycle', body);
  assert.deepEqual(snapshot(), before, 'completed child restores the caller environment');
}

function adoptStandard(f) {
  return recordStandardSlot({ cwd: f.lane, action: 'adopt', uid: 'fixture-chat', actor: 'fixture', why: 'offline proven binding',
    slot: { server: 'default', workspace: 'w', checkout: f.lane, tab: 'w:t', standardSlot: 'chat', panes: [{ pane: 'w:p', paneSlot: 'primary' }] } });
}

function nativeExit(f, kind = 'codex') {
  f.state.agents[0].agent = kind;
  f.state.agents[0].agent_status = 'idle';
  f.state.exitMode = 'exit';
  f.state.screen = fs.readFileSync(path.join(root, `supervisor/test/fixtures/${kind === 'claude' ? 'claude' : 'codex'}-empty.ansi`), 'utf8');
  f.state.info = { shell_pid: 1, foreground_processes: [{ name: kind, pid: 2 }], process_tree_complete: true,
    process_tree: [{ pid: 1, identity: 'shell', state: 'S', command: '[zsh]' },
      { pid: 2, ppid: 1, identity: 'native', state: 'S', command: `[${kind}]` },
      { pid: 3, ppid: 2, identity: 'helper', state: 'S', command: '[codex-code-mode-host]' },
      { pid: 4, ppid: 3, identity: 'repl', state: 'S', command: '[node]' }] };
  f.save();
}

for (const kind of ['occupants', 'exits', 'initial-shells']) test(`retirement ignores non-JSON entries and directories in ${kind} without deleting them`, t => {
  const f = fixture(t, { occupied: false });
  const directory = kind === 'initial-shells' ? initialShellDirectory(f.common) : path.join(f.org, 'retirement', kind);
  fs.mkdirSync(path.join(directory, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'unexpected.json'));
  if (kind === 'initial-shells') fs.mkdirSync(path.join(directory, `${'a'.repeat(64)}.json`));
  fs.writeFileSync(path.join(directory, '.claude/.cc-writes'), '');
  for (const name of ['notes.txt', '.hidden.json']) fs.writeFileSync(path.join(directory, name), '{');
  fs.symlinkSync('notes.txt', path.join(directory, 'link.json'));
  const before = fs.readdirSync(directory).sort(), retirement = f.retirement();
  assert.deepEqual(retirement.observe(f.lane).errors, []);
  const r = f.close(); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(f.lane), false);
  assert.deepEqual(fs.readdirSync(directory).sort(), before);
  assert.equal(fs.readFileSync(path.join(directory, 'notes.txt'), 'utf8'), '{');
});

for (const kind of ['occupants', 'exits']) for (const contents of ['{', '{}']) test(`retirement keeps a malformed ${kind} JSON receipt: ${contents}`, t => {
  const f = fixture(t, { occupied: false }), file = path.join(f.org, 'retirement', kind, 'bad.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents);
  const r = f.close(); assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /receipts unreadable.*project kept/);
  assert.ok(fs.existsSync(f.lane)); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.equal(fs.readFileSync(file, 'utf8'), contents);
});

for (const [kind, command] of [['codex', '/quit'], ['claude', '/exit']]) test(`native ${kind} exits once through route data, then closes only its unchanged bare shell`, t => {
  const f = fixture(t); nativeExit(f, kind);
  const retirement = f.retirement(), plan = retirement.plan();
  assert.equal(plan.close[0].decision, 'exit'); assert.equal(plan.close[0].exit, command);
  assert.equal(classifyRetirement(plan.close[0]).class, 'TERMINAL');
  assert.equal(retirement.apply(plan)[0].action, 'closed');
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', command], ['tab', 'close', 'w:t']]);
  assert.equal(retirement.apply(plan)[0].action, 'already-gone');
  // Reuse the native IDs after close: the old token cannot touch a new session.
  f.state.agents[0].terminal_id = 'new-terminal'; f.state.agents[0].agent_session.value = 'new-session'; f.save();
  assert.equal(retirement.apply(plan)[0].action, 'skip-close');
  assert.deepEqual(f.read().actions, []); assert.equal(f.read().tabs.length, 1);
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), f.eventBytes);
});

for (const state of ['Z', 'X']) test(`ordinary bare shell still releases with an unreaped ${state} row`, t => {
  const f = fixture(t); nativeExit(f);
  f.state.info.foreground_processes = [{ pid: 1, name: 'zsh' }];
  f.state.info.process_tree = [f.state.info.process_tree[0], { pid: 3, ppid: 1, identity: 'gone', state, command: '[helper]' }];
  f.save();
  const retirement = f.retirement(), snapshot = retirement.observe();
  assert.equal(snapshot.panes[0].process_info.process_tree.length, 1);
  assert.equal(snapshot.panes[0].process_info.process_tree_raw.length, 2);
  const plan = retirement.plan(); assert.equal(plan.close[0].decision, 'release');
  assert.equal(retirement.apply(plan)[0].action, 'closed');
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

test('working native agent with helper descendants is ACTIVE, while a shell sibling stays UNKNOWN', t => {
  const f = fixture(t); nativeExit(f); f.state.agents[0].agent_status = 'working'; f.save();
  const retirement = f.retirement(), plan = retirement.plan();
  assert.match(plan.keep[0].why, /^occupant worker is working$/);
  assert.equal(classifyRetirement(plan.keep[0]).class, 'ACTIVE');
  retirement.apply(plan); assert.deepEqual(f.read().actions, []);
  f.state.info.process_tree[2].ppid = 1; f.save();
  const sibling = retirement.plan().keep[0];
  assert.match(sibling.why, /background or unknown pane process remains/);
  assert.equal(classifyRetirement(sibling).class, 'UNKNOWN');
  retirement.apply(retirement.plan()); assert.deepEqual(f.read().actions, []);
});

for (const guard of ['sibling', 'missing-parent', 'cycle', 'stopped', 'zombie', 'dead', 'incomplete', 'unknown-kind', 'reference', 'test-slot', 'HOLD', 'standard-slot', 'focus', 'open-chain']) test(`native exit retains ${guard} without sending input`, t => {
  const f = fixture(t, { merged: guard !== 'open-chain' }); nativeExit(f, guard === 'unknown-kind' ? 'unknown' : 'codex');
  if (guard === 'sibling') f.state.info.process_tree[2].ppid = 1;
  if (guard === 'missing-parent') f.state.info.process_tree[2].ppid = 99;
  if (guard === 'cycle') f.state.info.process_tree[2].ppid = 4;
  if (guard === 'stopped') f.state.info.process_tree[2].state = 'T';
  if (guard === 'zombie') f.state.info.process_tree[3].state = 'Z';
  if (guard === 'dead') f.state.info.process_tree[3].state = 'X';
  if (guard === 'incomplete') f.state.info.process_tree_complete = false;
  if (guard === 'focus') f.state.tabs[0].focused = true;
  if (guard === 'reference') fs.writeFileSync(path.join(f.org, 'references/job.json'), JSON.stringify({ schema: 'herdr-reference/v1', state: 'running',
    owner: 'fixture', kind: 'live fixture', job: 'job', item: 'ENG-1', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() }));
  if (guard === 'test-slot') fs.writeFileSync(f.env.MONITOR_TEST_SLOT_PATH, JSON.stringify({ pid: process.pid, cwd: f.lane, label: f.lane }));
  if (guard === 'HOLD') hold(f);
  if (guard === 'standard-slot') adoptStandard(f);
  if (guard === 'open-chain') fs.writeFileSync(f.eventFile, loadEvents(f.org).events.filter(e => e.type !== 'item.closed').map(e => JSON.stringify(e) + '\n').join(''));
  f.save();
  const retirement = f.retirement(), plan = retirement.plan();
  assert.equal(plan.close.length, 0); assert.ok(plan.keep[0].why);
  if (guard === 'unknown-kind') assert.match(plan.keep[0].why, /no declared exit command/);
  retirement.apply(plan); assert.deepEqual(f.read().actions, []);
});

for (const guard of ['typed', 'not-ready', 'new-session', 'new-test-slot-occupancy', 'new-reference', 'new-HOLD']) test(`native exit rechecks ${guard} after planning and sends no input`, t => {
  const f = fixture(t); nativeExit(f);
  const retirement = f.retirement(), plan = retirement.plan();
  assert.equal(plan.close[0].decision, 'exit');
  if (guard === 'typed') f.state.screen = fs.readFileSync(path.join(root, 'supervisor/test/fixtures/codex-typed.ansi'), 'utf8');
  if (guard === 'not-ready') f.state.agents[0].interactive_ready = false;
  if (guard === 'new-session') f.state.agents[0].agent_session.value = 'new-session';
  if (guard === 'new-HOLD') hold(f);
  if (guard === 'new-test-slot-occupancy') fs.writeFileSync(f.env.MONITOR_TEST_SLOT_PATH, JSON.stringify({ pid: process.pid, cwd: f.lane, label: f.lane }));
  if (guard === 'new-reference') fs.writeFileSync(path.join(f.org, 'references/job.json'), JSON.stringify({ schema: 'herdr-reference/v1', state: 'running',
    owner: 'fixture', kind: 'live fixture', job: 'job', item: 'ENG-1', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() }));
  f.save(); const result = retirement.apply(plan);
  if (guard === 'new-reference') assert.match(result[0].why, /live fixture reference/);
  assert.deepEqual(f.read().actions, []);
});

for (const outcome of ['success', 'timeout']) test(`late native exit disarms its deadline before final observation and tab close ${outcome}`, t => {
  const f = fixture(t); nativeExit(f);
  const now = Date.now, start = now(), budgets = {};
  let elapsed = 0, prompted = false, sawShell = false;
  try {
    Date.now = () => start + elapsed;
    const retirement = f.retirement({ command: (exe, args, options) => {
      if (exe === f.job.herdr && prompted) {
        if (args[0] === 'workspace' && args[1] === 'list' && sawShell) budgets.finalObservation = options.timeout;
        if (args[0] === 'pane' && args[1] === 'process-info' && !sawShell) { elapsed = 59000; sawShell = true; }
        if (args[0] === 'tab' && args[1] === 'close') {
          budgets.close = options.timeout; elapsed = 61000;
          if (outcome === 'timeout') return { status: null, stdout: '', stderr: '', error: Object.assign(Error('injected tab close timeout'), { code: 'ETIMEDOUT' }) };
        }
      }
      const result = spawnSync(exe, args, options);
      if (exe === f.job.herdr && args[0] === 'agent' && args[1] === 'prompt') prompted = true;
      return result;
    } });
    const result = retirement.apply(retirement.plan())[0];
    assert.ok(budgets.finalObservation > 1000, `final observation allowance: ${budgets.finalObservation}`);
    assert.ok(budgets.close > 1000, `close allowance: ${budgets.close}`);
    if (outcome === 'success') {
      assert.equal(result.action, 'closed');
      assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
    } else {
      assert.equal(result.action, 'skip-close');
      assert.match(result.why, /tab close: injected tab close timeout/);
      assert.doesNotMatch(result.why, /agent did not exit/);
      assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit']]);
    }
  } finally { Date.now = now; }
});

test('native exit timeout keeps the tab and lane with a concrete refusal and no force fallback', t => {
  const f = fixture(t); nativeExit(f); f.state.exitMode = 'stay'; f.save();
  const retirement = f.retirement({ exitTimeoutMs: 0 });
  const result = retirement.apply(retirement.plan());
  assert.equal(result[0].decision, 'keep'); assert.equal(result[0].why, 'agent did not exit through its exit command');
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit']]);
  assert.equal(f.read().tabs.length, 1);
  assert.throws(() => retirement.removeLane({ lane: f.lane, branch: 'lane/topic', expectedTip: f.head, gitOnly: true }), /occupied lane/);
  assert.equal(fs.existsSync(f.lane), true);
});

test('receipt-identified settle agent exits before the ordinary process_gone callback close', t => {
  const f = fixture(t); nativeExit(f);
  const retirement = f.retirement({ readOwner: owner => f.read().info.process_tree.some(row => row.pid === owner.pid && row.identity === owner.identity) });
  retirement.recordCallback({ kind: 'settle', pane: 'w:p', pid: 2, run: 'R-1', agent: 'worker' });
  const events = loadEvents(f.org).events; delete events[1].meta.agent;
  fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  const plan = retirement.plan(); assert.equal(plan.close[0].decision, 'exit');
  assert.equal(retirement.apply(plan)[0].action, 'closed');
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
  assert.deepEqual(fs.readdirSync(path.join(f.org, 'retirement/occupants')), []);
});

test('a working receipt-identified native agent with its helpers stays ACTIVE without input', t => {
  const f = fixture(t); nativeExit(f);
  const retirement = f.retirement({ readOwner: owner => f.read().info.process_tree.some(row => row.pid === owner.pid && row.identity === owner.identity) });
  retirement.recordCallback({ kind: 'settle', pane: 'w:p', pid: 2, run: 'R-1', agent: 'worker' });
  f.state.agents[0].agent_status = 'working'; f.save();
  const plan = retirement.plan(); assert.equal(plan.close.length, 0);
  assert.equal(plan.keep[0].why, 'occupant worker is working');
  assert.equal(classifyRetirement(plan.keep[0]).class, 'ACTIVE');
  retirement.apply(plan); assert.deepEqual(f.read().actions, []);
});

test('concurrent native retirement holds the tab lock across prompt and close', t => {
  const f = fixture(t); nativeExit(f);
  const retirement = f.retirement(), plan = retirement.plan();
  const unlock = retirementLock(path.join(f.common, 'retirement/tabs', createHash('sha256').update('w:t').digest('hex')));
  try { assert.match(retirement.apply(plan)[0].why, /locked/); assert.deepEqual(f.read().actions, []); }
  finally { unlock(); }
  assert.equal(retirement.apply(plan)[0].action, 'closed');
});
test('standard-slot runtime rechecks canonical lane receipts before tab, workspace and guarded lane removal', t => {
  const f = fixture(t), retirement = f.retirement(), plan = retirement.plan(); assert.equal(plan.close.length, 1);
  adoptStandard(f);
  const blocked = retirement.apply(plan); assert.equal(blocked[0].action, 'skip-close'); assert.match(blocked[0].why, /adopted standard slot/);
  assert.match(createRetirement({ cwd: f.lane, org: f.org, herdr: f.job.herdr, env: f.env }).plan(f.lane).keep[0].why, /adopted/);
  assert.throws(() => retirement.removeLane({ lane: f.lane, branch: 'lane/topic', expectedTip: f.head }), /adopted/);
  assertNoRemoval(f);
  recordStandardSlot({ cwd: f.repo, action: 'withdraw', uid: 'fixture-chat', actor: 'fixture', why: 'explicit offline disposition' });
  assert.equal(retirement.apply(retirement.plan())[0].action, 'closed');
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), f.eventBytes);
});
test('standard-slot runtime preserves an enclosing workspace after tabs disappear and keeps unreadable evidence', t => {
  const f = fixture(t, { occupied: false }), retirement = f.retirement(); adoptStandard(f);
  assert.throws(() => retirement.assertVacant(f.lane), /adopted/);
  for (const bytes of ['{', JSON.stringify({ schema: 'standard-slot-history/v1', common: '/foreign/.git', operations: [] })]) {
    fs.writeFileSync(slotReceiptFile(f.common), bytes);
    assert.throws(() => retirement.assertVacant(f.lane), /protection evidence unreadable/);
  }
  assertNoRemoval(f);
});
test('STOP during an unreviewed or needs-human chain retains the warm worker without launching anything', t => {
  const f = fixture(t, { merged: false }); fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.lane/supervisor/STOP'), 'stop dispatch');
  const events = loadEvents(f.org).events.filter(e => e.type !== 'item.closed');
  fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  assert.match(f.retirement().plan().keep[0].why, /chain is still open/);
  events.find(e => e.type === 'report.ingested').report.outcome = 'needs_human';
  fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  assert.match(f.retirement().plan().keep[0].why, /disposition/); assertNoRemoval(f);
});

test('CLI dry plan reads the fold and shared executor refuses a concurrent native-session replacement', t => {
  const f = fixture(t), retirement = f.retirement(), plan = retirement.plan(); assert.equal(plan.close.length,1);
  f.state.agents[0].agent_session.value = 'replacement'; f.save();
  const result = retirement.apply(plan); assert.equal(result[0].action,'skip-close'); assert.match(result[0].why,/identity/);
  assert.deepEqual(f.read().actions,[]); assert.equal(fs.readFileSync(f.eventFile,'utf8'),f.eventBytes);
  const cli = spawnSync(process.execPath,[path.join(root,'supervisor/retire.mjs'),'plan','--repo',f.repo,'--org',f.org,'--herdr',f.job.herdr],{env:f.env,encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr); assert.equal(JSON.parse(cli.stdout).keep.length,1);
});

for (const kind of ['file', 'directory', 'symlink']) test(`retirement hold: ${kind} in the canonical checkout keeps every tab and receipt`, t => {
  const f = fixture(t), logs = [];
  const retirement = createRetirement({ cwd: f.lane, org: f.org, herdr: f.job.herdr, env: f.env, log: row => logs.push(row) });
  retirement.recordCallback({ kind: 'executive', pane: 'w:p', pid: 2, agent: 'worker' });
  const directory = path.join(f.org, 'retirement/occupants'), original = fs.readdirSync(directory)[0];
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, original)));
  fs.writeFileSync(path.join(directory, original), JSON.stringify({ ...receipt, tab: 'another-gone' }));
  fs.writeFileSync(path.join(directory, 'absent.json'), JSON.stringify({ ...receipt, tab: 'gone' }));
  const release = hold(f, kind), plan = retirement.plan();
  const results = retirement.apply(plan);
  assertNoRemoval(f); assert.equal(plan.close.length, 0); assert.equal(plan.keep[0].why, heldReason);
  assert.equal(results[0].action, 'held'); assert.ok(logs.some(r => r.action === 'held' && r.tab_id === 'w:t'));
  assert.equal(fs.readdirSync(directory).length, 2);
  release(); retirement.apply(retirement.plan());
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]); assert.deepEqual(fs.readdirSync(directory), []);
});

test('retirement hold: appearing between plan and apply stops the stale close', t => {
  const f = fixture(t), retirement = f.retirement(), plan = retirement.plan(); assert.equal(plan.close.length, 1);
  const release = hold(f), result = retirement.apply(plan);
  assertNoRemoval(f); assert.equal(result[0].action, 'held'); assert.equal(result[0].why, heldReason);
  release(); retirement.apply(plan); assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

for (const code of ['EACCES', 'ENOTDIR', 'EIO']) test(`retirement hold: indeterminate lstat ${code} fails closed without reading contents`, t => {
  const f = fixture(t), retirement = f.retirement(), original = fs.lstatSync, read = fs.readFileSync;
  const file = path.join(f.repo, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE');
  fs.lstatSync = function(target, ...args) { if (target === file) throw Object.assign(Error('injected hold lookup failure'), { code }); return original(target, ...args); };
  fs.readFileSync = function(target, ...args) { assert.notEqual(target, file, 'hold contents must not be read'); return read(target, ...args); };
  try { const plan = retirement.plan(), result = retirement.apply(plan); assertNoRemoval(f); assert.equal(plan.keep[0].why, heldReason); assert.equal(result[0].action, 'held'); }
  finally { fs.lstatSync = original; fs.readFileSync = read; }
  retirement.apply(retirement.plan()); assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

test('retirement hold: rechecked after the final observation immediately before a close', t => {
  const f = fixture(t), plan = f.retirement().plan(); let release;
  const command = (exe, args, options) => {
    const result = spawnSync(exe, args, options);
    if (exe === f.job.herdr && args[0] === 'agent' && args[1] === 'list') release ??= hold(f);
    return result;
  };
  const retirement = createRetirement({ cwd: f.repo, org: f.org, herdr: f.job.herdr, env: f.env, command });
  const result = retirement.apply(plan); assertNoRemoval(f); assert.equal(result[0].action, 'held');
  release(); f.retirement().apply(plan); assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

test('retirement hold: an empty workspace stays open and logs held before any close', t => {
  const f = fixture(t, { occupied: false }), logs = [];
  f.git(['worktree', 'remove', f.lane]);
  const retirement = createRetirement({ cwd: f.repo, org: f.org, herdr: f.job.herdr, env: f.env, log: row => logs.push(row) });
  const release = hold(f); assert.throws(() => retirement.closeEmptyWorkspace('w', f.lane), /retirement held/);
  assertNoRemoval(f); assert.equal(logs[0].action, 'held');
  release(); retirement.closeEmptyWorkspace('w', f.lane); assert.deepEqual(f.read().actions, [['workspace', 'close', 'w']]);
});

test('only a canonical hold can brake retirement; a lane-local lookalike has no authority', t => {
  const f = fixture(t), file = path.join(f.lane, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE');
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n.lane/\n'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'lane-local');
  f.retirement().apply(f.retirement().plan()); assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

for (const mode of ['tidy', 'housekeeping-fast', 'housekeeping-strict', 'plan', 'apply', 'consume']) test(`retirement hold: ${mode} keeps tabs and logs the hold, then resumes`, t => {
  const f = fixture(t); isolatedEnv(t, f); const logs = [], release = hold(f);
  if (mode === 'consume') requestRetirement({ org: f.org, eventSeq: 4, source: 'held test' });
  const run = () => {
    if (mode === 'housekeeping-fast') {
      assert.equal(tidyFinishedTabs({ cwd: f.lane, org: f.org, herdr: f.job.herdr, record: [process.execPath, recordCLI], log: r => logs.push(r) }), true);
      return JSON.stringify(logs);
    }
    if (mode === 'housekeeping-strict') {
      createHousekeeping({ cwd: f.lane, org: f.org, herdr: f.job.herdr, log: r => logs.push(r) }).tick({ resume: false });
      return JSON.stringify(logs);
    }
    const args = mode === 'tidy' ? [path.join(root, 'supervisor/tidy-tabs.mjs'), '--cwd', f.lane, '--org', f.org, '--herdr', f.job.herdr]
      : [path.join(root, 'supervisor/retire.mjs'), mode, '--repo', f.lane, '--org', f.org, '--herdr', f.job.herdr];
    const r = spawnSync(process.execPath, args, { env: f.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout + r.stderr;
  };
  const held = run(); assertNoRemoval(f); assert.ok(held.includes(heldReason), held);
  if (mode !== 'plan') assert.match(held, /held/);
  if (mode === 'consume') assert.equal(fs.existsSync(path.join(f.org, 'retirement/handled.json')), false);
  release(); const resumed = run();
  if (mode === 'plan') { assert.equal(JSON.parse(resumed).close.length, 1); assertNoRemoval(f); }
  else assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

test('retirement hold: drain catch-up acknowledges ready first and leaves the hint pending at both boundaries', async t => {
  const f = fixture(t); isolatedEnv(t, f); const queue = f.queue(), release = hold(f), outputs = [], messages = [];
  const send = process.send, write = process.stderr.write;
  process.send = m => { messages.push(m); return true; };
  process.stderr.write = function(chunk, ...args) { outputs.push({ text: String(chunk), ready: messages.some(m => m.ready) }); return write.call(this, chunk, ...args); };
  t.after(() => { process.send = send; process.stderr.write = write; });
  requestRetirement({ org: f.org, eventSeq: 4, source: 'completion' }); await drain(queue);
  assertNoRemoval(f); assert.deepEqual(messages, [{ ready: true }]);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/handled.json')), false);
  const held = outputs.filter(row => row.text.includes('"action":"held"')); assert.ok(held.length >= 2, JSON.stringify(outputs));
  assert.ok(held.every(row => row.ready));
  release(); await drain(queue); assert.equal(JSON.parse(fs.readFileSync(path.join(f.org, 'retirement/handled.json'))).revision, 4);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

test('retirement hold: promotion cleanup never invokes git-only close and stays promoted until bounded retry', t => {
  const f = fixture(t, { occupied: false }); isolatedEnv(t, f); const queue = f.queue(), release = hold(f);
  const { calls, job } = traceLane(f);
  const result = finishCleanup(job, { outcome: 'promoted', tip: f.head, workspace: f.lane }, queue, { now: 1000 });
  assertNoRemoval(f); assert.equal(fs.existsSync(calls), false); assert.equal(result.outcome, 'promoted');
  assert.equal(result.cleanup.state, 'pending'); assert.equal(result.cleanup.outcome, 'held'); assert.match(result.reason, /retirement held/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(queue.directory, 'job-cleanup.jsonl'), 'utf8').trim()).action, 'held');
  assert.equal(fs.existsSync(f.lane), true); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  queue.transaction(data => data.results.push({ ...job, ...result }));
  retryCleanup(queue, { now: result.cleanup.next_attempt_at }); assertNoRemoval(f); assert.equal(fs.existsSync(calls), false);
  release(); retryCleanup(queue, { now: queue.load().results[0].cleanup.next_attempt_at });
  assert.equal(queue.load().results[0].outcome, 'promoted'); assert.equal(queue.load().results[0].cleanup.state, 'complete');
  assert.equal(fs.existsSync(f.lane), false); assert.match(fs.readFileSync(calls, 'utf8'), /--git-only/);
});

for (const gitOnly of [false, true]) test(`retirement hold: lane close ${gitOnly ? 'git-only' : 'normal'} retains worktree and branch before lifecycle mutations`, t => {
  const f = fixture(t, { occupied: !gitOnly }), release = hold(f);
  const r = f.close(gitOnly); assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /retirement held/);
  assertNoRemoval(f); assert.equal(fs.existsSync(f.lane), true); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  release(); const resumed = f.close(gitOnly); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(fs.existsSync(f.lane), false); assert.ok(f.gitCalls().some(a => a.includes('worktree') && a.includes('remove')));
});

test('retirement hold: standalone settle-watch self-retirement preserves its tab and receipt', t => {
  const f = fixture(t), installed = path.join(f.scratch, 'standalone'); copyProduct(root, installed); fs.rmSync(path.join(installed, 'supervisor'), { recursive: true });
  f.state.watcherMode = true; f.state.workspaces.push({ workspace_id: 'main', worktree: { checkout_path: f.repo, repo_key: f.common, repo_root: f.repo, is_linked_worktree: false } });
  f.state.tabs.push({ tab_id: 'main:watch', workspace_id: 'main' }); f.state.panes.push({ pane_id: 'main:watch:p', tab_id: 'main:watch', workspace_id: 'main' }); f.save();
  fs.writeFileSync(path.join(f.scratch, 'org'), `#!/bin/sh\nexec '${process.execPath}' '${recordCLI}' "$@"\n`, { mode: 0o755 });
  const config = path.join(f.scratch, 'lane.json'), checklist = path.join(f.scratch, 'checklist'); fs.writeFileSync(config, '{}'); fs.writeFileSync(checklist, 'fixture');
  const run = () => spawnSync(process.execPath, [path.join(installed, 'contrib/settle-watch.mjs'), 'R-1', '--close-tab-on-exit', '--org', f.org, '--cwd', f.repo,
    '--lane-config', config, '--checklist', checklist, '--model', 'opaque-model', '--effort', 'opaque-effort'], { env: { ...f.env, HERDR_TAB_ID: 'main:watch', HERDR_PANE_ID: 'main:watch:p' }, encoding: 'utf8' });
  const release = hold(f), r = run(); assert.equal(r.status, 0, r.stdout + r.stderr); assertNoRemoval(f); assert.match(r.stdout, /held/);
  assert.equal(fs.readdirSync(path.join(f.org, 'retirement/occupants')).length, 1);
  release(); const resumed = run(); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'main:watch']]);
});

test('retirement hold: settle-watch worker pruning keeps eligible workers then closes after release', t => {
  const f = fixture(t), config = path.join(f.scratch, 'lane.json'), checklist = path.join(f.scratch, 'checklist'), count = path.join(f.scratch, 'org-count');
  fs.writeFileSync(config, '{}'); fs.writeFileSync(checklist, 'fixture');
  const run = fold(loadEvents(f.org).events).runs.get('R-1');
  fs.writeFileSync(path.join(f.scratch, 'org'), `#!${process.execPath}\nconst fs=require('node:fs'),file=${JSON.stringify(count)},n=fs.existsSync(file)?Number(fs.readFileSync(file)):0;fs.writeFileSync(file,String(n+1));console.log(JSON.stringify(n?${JSON.stringify(run)}:${JSON.stringify({ ...run, report: null })}));\n`, { mode: 0o755 });
  const watch = () => spawnSync(process.execPath, [path.join(root, 'contrib/settle-watch.mjs'), 'R-1', '--org', f.org, '--cwd', f.repo,
    '--lane-config', config, '--checklist', checklist, '--model', 'opaque-model', '--effort', 'opaque-effort'], { env: f.env, encoding: 'utf8' });
  const release = hold(f), r = watch(); assert.equal(r.status, 0, r.stdout + r.stderr); assertNoRemoval(f); assert.match(r.stdout, /held/);
  release(); fs.unlinkSync(count); const resumed = watch(); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

for (const stage of ['pruneSessionTabs', 'closeWorkerTab']) test(`retirement hold: settle-watch ${stage} honors the brake during a real CLI handoff`, t => {
  const f = fixture(t), config = path.join(f.scratch, 'lane.json'), checklist = path.join(f.scratch, 'checklist');
  fs.writeFileSync(config, '{}'); fs.writeFileSync(checklist, 'fixture');
  const reported = fold(loadEvents(f.org).events).runs.get('R-1'), report = path.join(f.scratch, 'report.md'); fs.writeFileSync(report, 'legacy report');
  fs.writeFileSync(path.join(f.scratch, 'org'), `#!${process.execPath}\nconst a=process.argv.slice(2);console.log(JSON.stringify(a[0]==='show'?${JSON.stringify({ ...reported, report: null, report_path: report })}:{}));\n`, { mode: 0o755 });
  const launcher = path.join(f.scratch, 'launcher'), memory = path.join(f.scratch, 'memory'), clock = path.join(f.scratch, 'no-delays.mjs');
  fs.writeFileSync(launcher, `#!/bin/sh\necho CLAUDE_CONFIG_DIR=${f.scratch}/fake-account\n`, { mode: 0o755 }); fs.writeFileSync(memory, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // Omit fixed UI launch sleeps in this fake-only CLI fixture.
  fs.writeFileSync(clock, 'Atomics.wait = () => "timed-out";\n');
  const reset = () => {
    f.state.sessionMode = true; f.state.tabs = [{ tab_id: 'w:t', workspace_id: 'w' }]; f.state.panes = [{ pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w' }];
    f.state.agents[0].agent_status = stage === 'closeWorkerTab' ? 'working' : 'done'; f.save();
  };
  f.state.workspaces.push({ workspace_id: 'main', worktree: { checkout_path: f.repo, repo_key: f.common, repo_root: f.repo, is_linked_worktree: false } });
  const watch = () => spawnSync(process.execPath, ['--import', clock, path.join(root, 'contrib/settle-watch.mjs'), 'R-1', '--org', f.org, '--cwd', f.repo,
    '--lane-config', config, '--checklist', checklist, '--launcher', launcher, '--cmem-domain', memory, '--model', 'opaque-model', '--effort', 'opaque-effort'], { env: f.env, encoding: 'utf8' });
  reset(); const release = hold(f), held = watch(); assert.equal(held.status, 0, held.stdout + held.stderr); assertNoRemoval(f); assert.match(held.stdout, /"action":"held"/);
  release(); reset(); const resumed = watch(); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.deepEqual(f.read().actions.filter(a => a[1] === 'close'), [['tab', 'close', 'w:t']]);
});

test('lane close --git-only keeps the worktree beneath even an eligible pane', t => {
  const f = fixture(t); assert.equal(f.retirement().plan().close.length,1);
  const r = f.close(); assert.notEqual(r.status,0); assert.match(r.stderr,/occupied lane/);
  assert.equal(fs.existsSync(f.lane),true); assert.equal(f.git(['rev-parse','lane/topic']),f.head); assert.deepEqual(f.read().actions,[]);
});

test('lane close uses the executor then proves vacancy before Git and empty workspace close', t => {
  const f = fixture(t); const r = f.close(false); assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(fs.existsSync(f.lane),false); assert.deepEqual(f.read().actions,[['tab','close','w:t'],['workspace','close','w']]);
  assert.equal(fs.readFileSync(f.eventFile,'utf8'),f.eventBytes);
});

test('an empty unmerged lane retains its recoverable archive and immutable record', t => {
  const f = fixture(t,{merged:false,occupied:false}); const r = f.close(); assert.equal(r.status,0,r.stderr);
  assert.equal(f.git(['rev-parse','archive/lane/topic']),f.head); assert.equal(fs.readFileSync(f.eventFile,'utf8'),f.eventBytes);
});

test('dropped blocked lane closes its tab and unmerged work only after a verified archive', t => {
  const f = fixture(t, { merged: false });
  const events = loadEvents(f.org).events;
  events.find(e => e.type === 'report.ingested').report.outcome = 'blocked';
  events.find(e => e.type === 'item.closed').as = 'dropped';
  const bytes = events.map(e => JSON.stringify(e) + '\n').join('');
  fs.writeFileSync(f.eventFile, bytes);
  assert.match(f.retirement().plan().keep[0].why, /not clean and integrated or archived/);
  f.git(['tag', 'archive/lane/topic', 'main']);
  const collision = f.close(false);
  assert.notEqual(collision.status, 0); assert.match(collision.stderr, /archive tag collision/);
  assert.equal(fs.existsSync(f.lane), true); assertNoRemoval(f);
  f.git(['tag', '-d', 'archive/lane/topic']);
  f.git(['tag', 'archive/lane/topic', f.head]);
  const closed = f.close(false); assert.equal(closed.status, 0, closed.stdout + closed.stderr);
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['rev-parse', 'archive/lane/topic']), f.head);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t'], ['workspace', 'close', 'w']]);
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), bytes);
});

test('promotion keeps integrated success on a live reference and retries cleanup only after it disappears', t => {
  const f = fixture(t), queue = f.queue(), ref = path.join(f.org,'references/host.json');
  fs.writeFileSync(ref,JSON.stringify({schema:'herdr-reference/v1',owner:'tool',kind:'host-job',job:'pending',state:'pending',item:'ENG-1',created_at:'2026-01-01T00:00:00Z',expires_at:'2999-01-01T00:00:00Z'}));
  const result = finishCleanup(f.job,{outcome:'promoted',tip:f.head,workspace:f.lane},queue);
  assert.equal(result.outcome,'promoted'); assert.equal(result.cleanup.state,'pending'); assert.match(result.reason,/integrated-but-cleanup-pending.*host-job/);
  assert.equal(fs.existsSync(f.lane),true); assert.deepEqual(f.read().actions,[]);
  queue.transaction(data => data.results.push({...f.job,...result})); fs.unlinkSync(ref);
  requestRetirement({ org:f.org, key:'host completed', source:'host completion' });
  // Product helpers inherit the fixture's source declarations, never the live host slot.
  isolatedEnv(t, f, ['MONITOR_TEST_SLOT_PATH', 'MONITOR_TEST_SLOT_COMPAT_PATH', 'XDG_STATE_HOME']);
  retryCleanup(queue); assert.equal(queue.load().results[0].cleanup.state,'complete'); assert.equal(fs.existsSync(f.lane),false);
  const actions = f.read().actions; retryCleanup(queue); assert.deepEqual(f.read().actions,actions);
  assert.equal(fs.readFileSync(f.eventFile,'utf8'),f.eventBytes);
});

test('a tab-close failure stays cleanup-pending and never turns promotion into a gate failure', t => {
  const f = fixture(t); f.state.failClose=true;f.save();
  const result=finishCleanup(f.job,{outcome:'promoted',tip:f.head,workspace:f.lane},f.queue());
  assert.equal(result.outcome,'promoted');assert.equal(result.cleanup.state,'pending');assert.match(result.reason,/injected tab failure/);assert.equal(fs.existsSync(f.lane),true);
});

test('record handoff is confirmed, idempotent, ignored by older fold, and never rewrites reports', t => {
  const f=fixture(t), events=loadEvents(f.org).events;
  events.push({type:'run.started',id:'R-2',item:'ENG-1',workspace:f.lane,seq:5,at:'2026-01-01T01:00:00Z',meta:{...events[1].meta,agent:'successor',pane:'w:q',terminal_id:'new-terminal',agent_session_id:'new-session'}});
  fs.writeFileSync(f.eventFile,events.map(e=>JSON.stringify(e)+'\n').join(''));
  const run=args=>spawnSync(process.execPath,[recordCLI,'handoff','R-1','--to','R-2','--why','retained successor',...args],{cwd:f.repo,env:f.env,encoding:'utf8'});
  assert.notEqual(run([]).status,0); const accepted=run(['--confirm']);assert.equal(accepted.status,0,accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).recorded,true);assert.equal(JSON.parse(run(['--confirm']).stdout).recorded,false);
  const loaded=loadEvents(f.org).events;assert.equal(loaded.filter(e=>e.type==='retirement.handoff').length,1);
  assert.deepEqual(fold(loaded).runs.get('R-1').report,fold(events).runs.get('R-1').report);
  assert.deepEqual(Object.keys(fold(loaded)),Object.keys(fold(events)));
  const request=JSON.parse(fs.readFileSync(path.join(f.org,'retirement/request.json')));assert.equal(request.source,'record handoff');
});

const releaseArgs = f => ['pane-release', 'R-1', '--session', 'session', '--terminal', 'term', '--pane', 'w:p', '--head', f.head,
  '--authority', 'owner ruling', '--next', 'reviewer after correction', '--unresolved', 'review and integration',
  '--evidence', '/evidence/report.md', '--evidence', '/evidence/review.md', '--confirm', '--why', 'idle context recorded'];
const recordRelease = (f, args = releaseArgs(f)) => spawnSync(process.execPath, [recordCLI, ...args], { cwd: f.repo, env: f.env, encoding: 'utf8' });
const writeEvents = (f, events) => fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));

test('native helper descendants on an open chain exit only after an exact record pane-release', t => {
  const f = fixture(t, { merged: false }); nativeExit(f);
  writeEvents(f, loadEvents(f.org).events.filter(e => e.type !== 'item.closed'));
  const retirement = f.retirement();
  assert.match(retirement.plan().keep[0].why, /chain is still open/);
  retirement.apply(retirement.plan()); assert.deepEqual(f.read().actions, []);
  const release = recordRelease(f); assert.equal(release.status, 0, release.stdout + release.stderr);
  const planned = retirement.plan(); assert.equal(planned.close[0].decision, 'exit');
  assert.equal(retirement.apply(planned)[0].action, 'closed');
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(fold(loadEvents(f.org).events).items.get('ENG-1').closed, null);
  assert.throws(() => retirement.removeLane({ lane: f.lane, branch: 'lane/topic', gitOnly: true }), /chain is still open/);
});

test('record pane-release leaves the legacy release command unavailable', t => {
  const f = fixture(t), before = fs.readFileSync(f.eventFile, 'utf8');
  for (const args of [['release', 'cut'], ['release', 'R-1'], ['release', ...releaseArgs(f).slice(1)]]) {
    const result = recordRelease(f, args); assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown command "release"/i);
  }
  const usage = recordRelease(f, ['pane-release', 'R-1']); assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: record pane-release R-n/);
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), before); assert.deepEqual(f.read().actions, []);
});

test('record pane-release atomically records continuation, is idempotent, refuses conflicts and never rewrites reports', t => {
  const f = fixture(t), before = fs.readFileSync(f.eventFile, 'utf8'), oldReport = fold(loadEvents(f.org).events).runs.get('R-1').report;
  const reportFile = path.join(f.org, 'reports/R-1.md'); fs.mkdirSync(path.dirname(reportFile)); fs.writeFileSync(reportFile, 'immutable report bytes');
  const accepted = recordRelease(f); assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { run: 'R-1', recorded: true });
  const loaded = loadEvents(f.org).events, [note, release] = loaded.slice(-2);
  assert.equal(note.type, 'note.added'); assert.equal(note.id, 'ENG-1'); assert.equal(note.kind, 'release'); assert.equal(note.decision, true);
  for (const value of ['R-1', 'session', 'term', 'w:p', f.head, '/evidence/report.md', '/evidence/review.md', 'reviewer after correction',
    'review and integration', 'owner ruling', 'idle context recorded']) assert.ok(note.text.includes(value), value);
  assert.deepEqual(Object.fromEntries(Object.keys(release).filter(key => !['seq', 'at', 'by', 'unattributed'].includes(key)).map(key => [key, release[key]])),
    { type: 'retirement.release', run: 'R-1', item: 'ENG-1', pane: 'w:p', terminal: 'term', session: 'session', workspace: 'w',
      cwd: f.lane, head: f.head, authority: 'owner ruling', confirmed: true, why: 'idle context recorded' });
  const bytes = fs.readFileSync(f.eventFile, 'utf8'); assert.ok(bytes.startsWith(before));
  const requestFile = path.join(f.org, 'retirement/request.json'), requestBytes = fs.readFileSync(requestFile, 'utf8');
  assert.equal(JSON.parse(requestBytes).source, 'record pane-release'); assert.equal(JSON.parse(requestBytes).event_seq, release.seq);
  assert.deepEqual(JSON.parse(recordRelease(f).stdout), { run: 'R-1', recorded: false });
  for (const flag of ['--head', '--authority', '--why', '--next', '--unresolved', '--evidence']) {
    const args = releaseArgs(f); args[args.indexOf(flag) + 1] = flag === '--head' ? 'b'.repeat(40) : 'different';
    const result = recordRelease(f, args); assert.equal(result.status, 1); assert.match(result.stderr, /different release/);
  }
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), bytes); assert.equal(fs.readFileSync(requestFile, 'utf8'), requestBytes);
  assert.deepEqual(fold(loadEvents(f.org).events).runs.get('R-1').report, oldReport);
  assert.equal(fs.readFileSync(reportFile, 'utf8'), 'immutable report bytes'); assert.deepEqual(f.read().actions, []);
});

test('record pane-release refuses incomplete or mismatched confirmation without appending either event', t => {
  const f = fixture(t), before = fs.readFileSync(f.eventFile, 'utf8');
  for (const flag of ['--session', '--terminal', '--pane', '--head', '--authority', '--next', '--unresolved', '--evidence', '--why', '--confirm']) {
    const args = releaseArgs(f), at = args.indexOf(flag);
    if (flag === '--confirm') args.splice(at, 1);
    else args[at + 1] = ['--session', '--terminal', '--pane'].includes(flag) ? 'wrong' : '   ';
    const result = recordRelease(f, args); assert.equal(result.status, 1, flag + result.stderr);
    assert.equal(fs.readFileSync(f.eventFile, 'utf8'), before);
  }
  const args = releaseArgs(f).filter((value, i, all) => value !== '--evidence' && all[i - 1] !== '--evidence');
  assert.equal(recordRelease(f, args).status, 1);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/request.json')), false);
});

test('record pane-release requires an existing non-abandoned ingested run and complete launch receipt', t => {
  const f = fixture(t), original = loadEvents(f.org).events;
  for (const variant of ['unknown', 'abandoned', 'report-file-only', 'session', 'terminal', 'pane', 'workspace', 'worker_workspace']) {
    const events = structuredClone(original), args = releaseArgs(f);
    if (variant === 'unknown') args[1] = 'R-99';
    if (variant === 'abandoned') events.push({ type: 'run.abandoned', id: 'R-1', seq: 5 });
    if (variant === 'report-file-only') { events.splice(2, 1); events[1].report_path = '/exists/report.md'; }
    if (variant === 'workspace') delete events[1].workspace;
    if (['session', 'terminal', 'pane', 'worker_workspace'].includes(variant)) delete events[1].meta[{ session: 'agent_session_id', terminal: 'terminal_id' }[variant] ?? variant];
    writeEvents(f, events); const bytes = fs.readFileSync(f.eventFile, 'utf8');
    const result = recordRelease(f, args); assert.equal(result.status, 1, variant + result.stderr);
    assert.equal(fs.readFileSync(f.eventFile, 'utf8'), bytes);
  }
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/request.json')), false);
});

for (const binding of ['pane', 'agent_session_id']) test(`record pane-release refuses newer ${binding} continuation before and after recording`, t => {
  const f = fixture(t), events = loadEvents(f.org).events;
  const newer = { type: 'run.started', id: 'R-2256', item: 'ENG-1', workspace: f.lane, seq: 5,
    meta: { ...events[1].meta, agent: 'continuation', pane: 'w:q', agent_session_id: 'new-session', [binding]: events[1].meta[binding] } };
  writeEvents(f, [...events, newer]); const bytes = fs.readFileSync(f.eventFile, 'utf8');
  const refused = recordRelease(f); assert.equal(refused.status, 1); assert.match(refused.stderr, /newer run uses the same pane or native session/);
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), bytes);
  writeEvents(f, events); const accepted = recordRelease(f); assert.equal(accepted.status, 0, accepted.stderr);
  fs.appendFileSync(f.eventFile, JSON.stringify({ ...newer, seq: 7 }) + '\n');
  assert.equal(recordRelease(f).status, 1);
  assert.equal(f.retirement().plan().close.length, 0);
});

test('record pane-release closes only the fixture tab and preserves the open lane, worktree, branch, workspace and files', t => {
  const f = fixture(t, { merged: false }); writeEvents(f, loadEvents(f.org).events.filter(e => e.type !== 'item.closed'));
  fs.writeFileSync(path.join(f.lane, 'uncommitted'), 'keep these bytes'); f.traceGit();
  const retirement = f.retirement(); assert.match(retirement.plan().keep[0].why, /chain is still open/);
  const accepted = recordRelease(f); assert.equal(accepted.status, 0, accepted.stderr);
  const plan = retirement.plan(); assert.equal(plan.close.length, 1); assert.match(plan.close[0].why, /record release for R-1/);
  const unhold = hold(f); assert.equal(retirement.apply(plan)[0].action, 'held'); assertNoRemoval(f); unhold();
  assert.equal(retirement.apply(plan)[0].action, 'closed');
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]); assert.equal(f.read().workspaces.length, 1);
  assert.equal(fs.readFileSync(path.join(f.lane, 'uncommitted'), 'utf8'), 'keep these bytes');
  assert.equal(f.git(['rev-parse', 'HEAD'], f.lane), f.head); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.ok(f.git(['worktree', 'list', '--porcelain']).includes(f.lane));
  assert.throws(() => retirement.closeEmptyWorkspace('w', f.lane), /worktree removal is not confirmed/);
  assert.throws(() => retirement.assertVacant(f.lane), /chain is still open/);
  assert.throws(() => retirement.removeLane({ lane: f.lane, branch: 'lane/topic', expectedTip: f.head }), /lane worktree is not clean/);
  assert.deepEqual(f.gitCalls().filter(args => args.includes('worktree') && args.includes('remove')), []);
});

test('record pane-release canonicalizes a symlinked lane cwd and keeps an unresolvable disposition', t => {
  const f = fixture(t, { merged: false }), alias = path.join(f.scratch, 'lane-alias');
  fs.symlinkSync(f.lane, alias, 'dir');
  const events = loadEvents(f.org).events.filter(e => e.type !== 'item.closed');
  events.find(e => e.type === 'run.started').workspace = alias; writeEvents(f, events);
  const accepted = recordRelease(f); assert.equal(accepted.status, 0, accepted.stderr);
  const recorded = loadEvents(f.org).events, release = recorded.find(e => e.type === 'retirement.release');
  assert.equal(release.cwd, alias); assert.notEqual(alias, f.lane);
  const retirement = f.retirement(), plan = retirement.plan();
  assert.equal(plan.close.length, 1, JSON.stringify(plan.keep));
  assert.match(plan.close[0].why, /record release for R-1/);
  const snapshot = retirement.observe();
  assert.equal(snapshot.record.runs[0].workspace, f.lane); assert.equal(snapshot.releases[0].cwd, f.lane);

  const loop = path.join(f.scratch, 'loop'); fs.symlinkSync(loop, loop);
  release.cwd = loop; writeEvents(f, recorded);
  const kept = retirement.plan(); assert.equal(kept.close.length, 0); assert.match(kept.keep[0].why, /chain is still open/);
  assert.equal(retirement.observe().releases[0].cwd, null);
  release.cwd = alias; writeEvents(f, recorded);
  assert.equal(retirement.apply(plan)[0].action, 'closed');
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

test('Git-only lane without a workspace still keeps queued lane and run references', t => {
  const f=fixture(t,{occupied:false});f.state.workspaces=[];f.save();
  const queue=f.queue();queue.transaction(data=>data.pending.push({...f.job}));
  const r=f.close();assert.notEqual(r.status,0);assert.match(r.stderr,/promote reference/);assert.equal(fs.existsSync(f.lane),true);
});
test('installed distribution ships the adoption CLI and compatibility surfaces with no dependencies', t => {
  const f=fixture(t),installed=path.join(f.scratch,'installed');copyProduct(root,installed);
  for(const file of ['supervisor/retire.mjs','contrib/settle-watch.mjs','lib/cli-help.mjs','lib/state.mjs']) assert.ok(fs.existsSync(path.join(installed,file)));
  const r=spawnSync(process.execPath,[path.join(installed,'supervisor/retire.mjs'),'plan','--repo',f.repo,'--org',f.org,'--herdr',f.job.herdr],{env:f.env,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).close.length,1);assert.deepEqual(f.read().actions,[]);
});

test('installed settle-watch flags keep an ingested worker while its chain is open', t => {
  const f=fixture(t,{merged:false});const events=loadEvents(f.org).events.filter(e=>e.type!=='item.closed');
  fs.writeFileSync(f.eventFile,events.map(e=>JSON.stringify(e)+'\n').join(''));
  fs.writeFileSync(path.join(f.scratch,'org'),`#!/bin/sh\nexec '${process.execPath}' '${recordCLI}' "$@"\n`,{mode:0o755});
  const config=path.join(f.scratch,'lane.json'),checklist=path.join(f.scratch,'CHECKLIST.md');fs.writeFileSync(config,'{}');fs.writeFileSync(checklist,'fixture');
  const r=spawnSync(process.execPath,[path.join(root,'contrib/settle-watch.mjs'),'R-1','--org',f.org,'--cwd',f.repo,
    '--lane-config',config,'--checklist',checklist,'--model','opaque-model','--effort','opaque-effort','--close-tab-on-exit'],{env:f.env,encoding:'utf8'});
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(f.retirement().plan().keep[0].why,/chain is still open/);assert.deepEqual(f.read().actions,[]);
});

test('a disposition trigger gets a fresh foreground plan once, and the repeated hint is a no-op', t => {
  const f=fixture(t,{merged:false}), events=loadEvents(f.org).events.filter(e=>e.type!=='item.closed');
  fs.writeFileSync(f.eventFile,events.map(e=>JSON.stringify(e)+'\n').join(''));
  assert.equal(f.retirement().plan().close.length,0);
  f.git(['merge','--ff-only',f.head]);
  const r=spawnSync(process.execPath,[recordCLI,'close','ENG-1'],{cwd:f.repo,env:f.env,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const hint=JSON.parse(fs.readFileSync(path.join(f.org,'retirement/request.json')));
  assert.equal(hint.event_seq,loadEvents(f.org).events.at(-1).seq);
  let observations=0;
  const consume=()=>consumeRetirement({org:f.org,retirement:()=>{observations++;return f.retirement();}});
  assert.equal(consume().handled,true);assert.deepEqual(f.read().actions,[['tab','close','w:t']]);
  requestRetirement({org:f.org,eventSeq:hint.event_seq,source:'repeated disposition'});
  assert.equal(consume().handled,false);assert.equal(observations,1);
  // Hint writing needs no log read; the event owner supplied the sequence.
  fs.writeFileSync(f.eventFile,'invalid event log');
  requestRetirement({org:f.org,eventSeq:hint.event_seq+1,source:'known appended sequence'});
});

test('the consume CLI reaches its own deadline cleanly, retaining the hint and releasing its lock', t => {
  const f = fixture(t); f.state.delayWorkspace = 1000; f.save();
  requestRetirement({ org: f.org, eventSeq: 4, source: 'completion' });
  const r = spawnSync(process.execPath, [path.join(root, 'supervisor/retire.mjs'), 'consume', '--repo', f.repo, '--org', f.org,
    '--herdr', f.job.herdr, '--budget-ms', '100'], { env: f.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr); const result = JSON.parse(r.stdout);
  assert.equal(result.pending, true); assert.equal(result.handled, false);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/consume.lock')), false);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/handled.json')), false);
  assert.deepEqual(f.read().actions, []);
});

test('promote drain consumes requests at both foreground boundaries without running a gate', t => checkRetirementRestoration(t, async t => {
  const f=fixture(t);f.state.triggerOnClose=true;f.save();const queue=f.queue();
  isolatedEnv(t, f);
  requestRetirement({org:f.org,eventSeq:4,source:'disposition'});await drain(queue);
  const handled=JSON.parse(fs.readFileSync(path.join(f.org,'retirement/handled.json')));
  assert.equal(handled.revision,5);assert.deepEqual(f.read().actions,[['tab','close','w:t']]);assert.deepEqual(queue.load().results,[]);
}));

test('promote sends its ready acknowledgment before observing a pending retirement hint', t => checkRetirementRestoration(t, async t => {
  const f = fixture(t), queue = f.queue(), marker = path.join(f.scratch, 'ready');
  f.state.readyMarker = marker; f.save();
  isolatedEnv(t, f);
  const send = process.send, write = process.stderr.write, messages = [], earlyErrors = [];
  let ready = false;
  process.send = message => { messages.push(message); if (message.ready) { ready = true; fs.writeFileSync(marker, 'acknowledged'); } return true; };
  process.stderr.write = function(chunk, ...args) { if (!ready && String(chunk).includes('retirement catch-up')) earlyErrors.push(String(chunk)); return write.call(this, chunk, ...args); };
  t.after(() => { process.send = send; process.stderr.write = write; });
  requestRetirement({ org: f.org, eventSeq: 4, source: 'completion' });
  await drain(queue);
  assert.equal(f.read().preReadyObservation ?? false, false, 'retirement observed before ready');
  assert.deepEqual(earlyErrors, [], 'retirement catch-up error preceded ready');
  assert.deepEqual(messages, [{ ready: true }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.org, 'retirement/handled.json'))).revision, 4);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
}));

test('a dequeued job is persisted before retirement catch-up and is never left current during it', t => checkRetirementRestoration(t, async t => {
  let inbox;
  t.after(async () => { if (inbox) await stopFixtureInbox(inbox, { script: path.join(root, 'supervisor/prompt-supervisor.mjs') }); });
  const f = fixture(t), queue = f.queue(), fakeLane = path.join(f.scratch, 'refused-lane.mjs');
  inbox = path.join(f.org, 'supervisor/inbox.log');
  fs.writeFileSync(fakeLane, "console.error('lane: fixture refusal');process.exit(1);\n");
  // A refused legacy job avoids per-job cleanup, so workspace reads identify
  // foreground catch-up rather than an integration or its scoped cleanup.
  queue.transaction(data => data.pending.push({ ...f.job, laneCLI: fakeLane, to: 'fixture', attempts: 1, retry: 0 }));
  f.state.currentQueue = queue.file; f.save();
  isolatedEnv(t, f);
  const send = process.send, messages = [];
  process.send = message => { messages.push(message); return true; };
  t.after(() => { process.send = send; });
  const cwd = process.cwd();
  try {
    // Notice binding uses the caller's real Git project as the production CLI
    // does. The record and queue here both belong to this disposable project.
    process.chdir(f.repo);
    requestRetirement({ org: f.org, eventSeq: 4, source: 'completion' }); await drain(queue);
  } finally { process.chdir(cwd); }
  const notice = JSON.parse(fs.readFileSync(inbox, 'utf8').trim().split('\n')[0]);
  assert.equal(notice.project.identity, f.common); assert.equal(notice.project.org, f.org);
  assert.deepEqual(messages, [{ ready: true }]);
  assert.equal(f.read().observedCurrent ?? false, false, 'catch-up observed the dequeued job as current');
  assert.equal(f.read().catchupCurrent, null); assert.equal(f.read().catchupPersisted, 1);
  assert.equal(queue.load().results[0].outcome, 'refused');
}));

test('the final re-observation crossing a deadline inside a callback owner lookup leaves its hint pending', t => {
  const f = fixture(t); f.retirement().recordCallback({ kind: 'executive', pane: 'w:p', pid: 2, agent: 'worker' });
  f.state.agents = []; f.state.info = { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'zsh' }], process_tree_complete: true,
    process_tree: [{ pid: 1, identity: 'shell', state: 'S', command: '[zsh]' }] }; f.save();
  requestRetirement({ org: f.org, eventSeq: 4, source: 'completion' });
  const now = Date.now, deadline = now() + 60000; let reads = 0;
  try {
    const result = consumeRetirement({ org: f.org, deadline, retirement: () => createRetirement({ cwd: f.repo, org: f.org, herdr: f.job.herdr, env: f.env, deadline,
      readOwner: () => { if (++reads === 3) { Date.now = () => deadline; throw retirementDeadline(); } return false; } }) });
    assert.equal(reads, 3); assert.equal(result.pending, true); assert.equal(result.handled, false);
    assert.equal(result.results.at(-1).action, 'deferred');
    assert.equal(fs.existsSync(path.join(f.org, 'retirement/handled.json')), false);
    assert.equal(fs.existsSync(path.join(f.org, 'retirement/consume.lock')), false); assert.deepEqual(f.read().actions, []);
  } finally { Date.now = now; }
});

test('cleanup retries are capped with backoff, record the refusal, and reset on a new request', t => {
  const f=fixture(t), queue=f.queue(); f.state.failClose=true;f.save();
  isolatedEnv(t, f, ['MONITOR_TEST_SLOT_PATH', 'MONITOR_TEST_SLOT_COMPAT_PATH', 'XDG_STATE_HOME']);
  const result=finishCleanup(f.job,{outcome:'promoted',tip:f.head,workspace:f.lane},queue,{now:1000});
  assert.match(result.cleanup.last_refusal,/injected tab failure/);queue.transaction(data=>data.results.push({...f.job,...result}));
  retryCleanup(queue,{now:1001});assert.equal(queue.load().results[0].cleanup.attempts,1);
  for(let attempt=2;attempt<=5;attempt++) {retryCleanup(queue,{now:queue.load().results[0].cleanup.next_attempt_at});assert.equal(queue.load().results[0].cleanup.attempts,attempt);}
  const capped=queue.load().results[0];retryCleanup(queue,{now:1e12});assert.deepEqual(queue.load().results[0],capped);
  requestRetirement({org:f.org,key:'new completion',source:'completion'});retryCleanup(queue,{now:1e12});
  assert.equal(queue.load().results[0].cleanup.attempts,1);assert.equal(queue.load().results[0].outcome,'promoted');
});

test('lane close permits an absent Herdr executable and refuses an unreadable installed server', t => {
  const f=fixture(t,{occupied:false});
  fs.writeFileSync(f.job.herdr,'#!/bin/sh\necho unreadable-server >&2\nexit 1\n',{mode:0o755});
  const unavailable=f.close();assert.notEqual(unavailable.status,0);assert.match(unavailable.stderr,/unreadable-server/);
  assert.equal(fs.existsSync(f.lane),true);
  fs.unlinkSync(f.job.herdr); const absent=f.close();assert.equal(absent.status,0,absent.stderr);assert.equal(fs.existsSync(f.lane),false);
});

for(const kind of ['watcher','settle','executive','plan']) test(`tidy-tabs prunes an exited recorded ${kind} callback through the shared guard`,t=>{
  const f=fixture(t), retirement=f.retirement();
  retirement.recordCallback({kind,pane:'w:p',pid:2,...(['watcher','settle'].includes(kind)?{run:'R-1'}:{}),agent:'worker'});
  f.state.agents=[];f.state.info={shell_pid:1,foreground_processes:[{pid:1,name:'zsh'}],process_tree_complete:true,process_tree:[{pid:1,identity:'shell',state:'S',command:'[zsh]'}]};f.save();
  const cli=()=>spawnSync(process.execPath,[path.join(root,'supervisor/tidy-tabs.mjs'),'--cwd',f.repo,'--org',f.org,'--herdr',f.job.herdr,'--org-cli',process.execPath,'--org-cli-arg',recordCLI],{env:f.env,encoding:'utf8'});
  // A replacement shell never inherits the departed callback's authority.
  f.state.info.process_tree[0].identity='replacement';f.save();const kept=cli();assert.equal(kept.status,0,kept.stderr);assert.deepEqual(f.read().actions,[]);
  f.state.info.process_tree[0].identity='shell';f.save();const released=cli();assert.equal(released.status,0,released.stderr);
  assert.deepEqual(f.read().actions,[['tab','close','w:t']]);
  assert.deepEqual(fs.readdirSync(path.join(f.org, 'retirement/occupants')), []);
});

test('apply prunes an absent callback receipt without reading its owner; scoped reads retain other workspaces', t => {
  const f = fixture(t);
  f.retirement().recordCallback({ kind: 'watcher', pane: 'w:p', pid: 2, run: 'R-1' });
  const directory = path.join(f.org, 'retirement/occupants');
  f.state.tabs = []; f.state.panes = []; f.state.agents = []; f.save();
  const retirement = createRetirement({ cwd: f.repo, org: f.org, herdr: f.job.herdr, env: f.env, readOwner: () => assert.fail('absent receipt owner was inspected') });
  const scoped = retirement.plan(f.repo); retirement.apply(scoped, f.repo);
  assert.equal(fs.readdirSync(directory).length, 1, 'a scoped observation cannot prune another workspace');
  const preview = retirement.plan(); assert.equal(fs.readdirSync(directory).length, 1, 'preview remains read-only');
  retirement.apply(preview); assert.deepEqual(fs.readdirSync(directory), []);
});

test('a concurrently pruned absent receipt does not abort remaining tab closes', t => {
  const f = fixture(t); f.retirement().recordCallback({ kind: 'watcher', pane: 'w:p', pid: 2, run: 'R-1' });
  const directory = path.join(f.org, 'retirement/occupants'), file = path.join(directory, fs.readdirSync(directory)[0]);
  const receipt = JSON.parse(fs.readFileSync(file)); receipt.tab = 'already-gone'; fs.writeFileSync(file, JSON.stringify(receipt));
  const retirement = f.retirement(), plan = retirement.plan(), unlink = fs.unlinkSync;
  let raced = false;
  fs.unlinkSync = function(target) { if (target === file && !raced) { raced = true; unlink(target); return unlink(target); } return unlink(target); };
  try {
    const results = retirement.apply(plan); assert.equal(raced, true); assert.equal(results[0].action, 'closed');
    assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
  } finally { fs.unlinkSync = unlink; }
});

for (const code of ['ENOENT', 'EACCES']) test(`post-close receipt pruning ${code} preserves the successful close result`, t => {
  const f = fixture(t); f.retirement().recordCallback({ kind: 'executive', pane: 'w:p', pid: 2, agent: 'worker' });
  f.state.agents = []; f.state.info = { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'zsh' }], process_tree_complete: true,
    process_tree: [{ pid: 1, identity: 'shell', state: 'S', command: '[zsh]' }] }; f.save();
  const directory = path.join(f.org, 'retirement/occupants'), file = path.join(directory, fs.readdirSync(directory)[0]), logs = [];
  const retirement = createRetirement({ cwd: f.repo, org: f.org, herdr: f.job.herdr, env: f.env, readOwner: () => false, log: row => logs.push(row) });
  const plan = retirement.plan(), unlink = fs.unlinkSync;
  fs.unlinkSync = function(target) { if (target === file) { if (code === 'ENOENT') { unlink(target); return unlink(target); } throw Object.assign(Error('injected receipt pruning error'), { code }); } return unlink(target); };
  try {
    const results = retirement.apply(plan); assert.equal(results[0].action, 'closed');
    assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
    assert.equal(logs.some(row => row.action === 'close-failed'), false);
    assert.equal(logs.some(row => row.action === 'receipt-pruning-diagnostic'), code === 'EACCES');
  } finally { fs.unlinkSync = unlink; }
});

test('settle-watch --spawn keeps its flags and narrowly retires its own tab after ingestion',t=>{
  const f=fixture(t);f.state.watcherMode=true;
  f.state.workspaces.push({workspace_id:'main',worktree:{checkout_path:f.repo,repo_key:f.common,repo_root:f.repo,is_linked_worktree:false}});f.save();
  fs.writeFileSync(path.join(f.scratch,'org'),`#!/bin/sh\nexec '${process.execPath}' '${recordCLI}' "$@"\n`,{mode:0o755});
  const config=path.join(f.scratch,'lane.json'),checklist=path.join(f.scratch,'CHECKLIST.md');fs.writeFileSync(config,'{}');fs.writeFileSync(checklist,'fixture');
  const r=spawnSync(process.execPath,[path.join(root,'contrib/settle-watch.mjs'),'R-1','--spawn','--org',f.org,'--cwd',f.repo,
    '--lane-config',config,'--checklist',checklist,'--model','opaque-model','--effort','opaque-effort'],{env:f.env,encoding:'utf8'});
  assert.equal(r.status,0,r.stdout+r.stderr);const state=f.read();assert.ok(state.actions.some(a=>a[0]==='tab'&&a[1]==='create'));
  assert.deepEqual(state.actions.filter(a=>a[1]==='close'),[['tab','close','main:watch']]);
  assert.ok(state.tabs.some(t=>t.tab_id==='w:t'));assert.equal(fs.readFileSync(f.eventFile,'utf8'),f.eventBytes);
});

test('a foreground watcher without close-tab-on-exit never adopts an ordinary operator tab', t => {
  const f = fixture(t); f.state.watcherMode = true;
  f.state.workspaces.push({ workspace_id: 'main', worktree: { checkout_path: f.repo, repo_key: f.common, repo_root: f.repo, is_linked_worktree: false } });
  f.state.tabs.push({ tab_id: 'main:watch', workspace_id: 'main' });
  f.state.panes.push({ pane_id: 'main:watch:p', tab_id: 'main:watch', workspace_id: 'main' }); f.save();
  fs.writeFileSync(path.join(f.scratch, 'org'), `#!/bin/sh\nexec '${process.execPath}' '${recordCLI}' "$@"\n`, { mode: 0o755 });
  const config = path.join(f.scratch, 'lane.json'), checklist = path.join(f.scratch, 'CHECKLIST.md'); fs.writeFileSync(config, '{}'); fs.writeFileSync(checklist, 'fixture');
  const r = spawnSync(process.execPath, [path.join(root, 'contrib/settle-watch.mjs'), 'R-1', '--org', f.org, '--cwd', f.repo,
    '--lane-config', config, '--checklist', checklist, '--model', 'opaque-model', '--effort', 'opaque-effort'], {
    env: { ...f.env, HERDR_TAB_ID: 'main:watch', HERDR_PANE_ID: 'main:watch:p' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/occupants')), false);
  const plan = f.retirement().plan(); assert.ok(plan.keep.some(tab => tab.tab_id === 'main:watch'));
  f.retirement().apply({ ...plan, close: [] }); assert.ok(f.read().tabs.some(tab => tab.tab_id === 'main:watch')); assert.deepEqual(f.read().actions, []);
});

test('standalone contrib retires only its owned watcher with no supervisor directory', t => {
  const f = fixture(t), installed = path.join(f.scratch, 'standalone');
  copyProduct(root, installed);
  fs.rmSync(path.join(installed, 'supervisor'), { recursive: true });
  f.state.watcherMode = true;
  f.state.workspaces.push({ workspace_id: 'main', worktree: {
    checkout_path: f.repo, repo_key: f.common, repo_root: f.repo, is_linked_worktree: false } });
  f.save();
  fs.writeFileSync(path.join(f.scratch, 'org'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(installed, 'bin/org.mjs')}' "$@"\n`, { mode: 0o755 });
  const config = path.join(f.scratch, 'lane.json'), checklist = path.join(f.scratch, 'CHECKLIST.md');
  fs.writeFileSync(config, '{}'); fs.writeFileSync(checklist, 'fixture');
  const result = spawnSync(process.execPath, [path.join(installed, 'contrib/settle-watch.mjs'), 'R-1', '--spawn',
    '--org', f.org, '--cwd', f.repo, '--lane-config', config, '--checklist', checklist,
    '--model', 'opaque-model', '--effort', 'opaque-effort'], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = f.read();
  assert.ok(state.actions.some(action => action[0] === 'tab' && action[1] === 'create'));
  assert.deepEqual(state.actions.filter(action => action[1] === 'close'), [['tab', 'close', 'main:watch']]);
  assert.ok(state.tabs.some(tab => tab.tab_id === 'w:t'));
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), f.eventBytes);
});

for (const keep of [true, false]) test(`composed promotion then native completion reconcile then cleanup: ${keep ? 'KEEP protects lane and evidence' : 'release closes workspace after verified preservation'}`, t => {
  const f = completionFixture(t), { scratchFile: scratch, bytes, manifest, prepared, gate, config, run } = f;
  const completion = [path.join(root, 'supervisor/reconcile.mjs')];
  const options = ['--repo', f.repo, '--org', f.org, '--role', 'supervisor', '--prepared', prepared];
  run([...completion, 'prepare', ...options, '--manifest', manifest, '--gate-log', gate]);
  const promoted = run([laneCLI, 'promote', 'topic']); fs.writeFileSync(gate, promoted.stdout + promoted.stderr);
  assert.equal(f.git(['rev-parse', 'main']), f.head);
  assert.equal(Boolean(fold(loadEvents(f.org).events).items.get('ENG-1').closed), false);
  const reconciled = run([...completion, 'finish', ...options, '--gate-exit', '0', '--tip', f.head]);
  assert.equal(JSON.parse(reconciled.stdout).result, 'reconciled');
  assert.ok(fold(loadEvents(f.org).events).items.get('ENG-1').closed);
  if (keep) {
    // The default shell pane is an occupant even after the native worker's
    // report and chain become terminal. No callback receipt releases it.
    f.state.tabs.push({ tab_id: 'w:shell', workspace_id: 'w' });
    f.state.panes.push({ pane_id: 'w:shell:p', tab_id: 'w:shell', workspace_id: 'w' }); f.save();
  }
  const queue = f.queue(), job = { ...f.job, laneConfig: config };
  const result = finishCleanup(job, { outcome: 'promoted', tip: f.head, workspace: f.lane }, queue);
  assert.equal(result.outcome, 'promoted');
  const receipt = fs.readFileSync(path.join(queue.directory, 'job-cleanup.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  if (keep) {
    assert.equal(result.cleanup.state, 'pending'); assert.match(result.reason, /unknown occupant|shell/);
    assert.deepEqual(fs.readFileSync(scratch), bytes); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
    assert.ok(f.read().workspaces.some(w => w.workspace_id === 'w'));
    assert.ok(receipt.some(r => r.action === 'keep' && r.tab_id === 'w:shell'));
    assert.equal(receipt.some(r => r.action === 'lane-removed'), false);
  } else {
    assert.equal(result.cleanup.state, 'complete', result.reason); assert.equal(fs.existsSync(f.lane), false);
    assert.equal(f.git(['branch', '--list', 'lane/topic']), ''); assert.equal(f.read().workspaces.length, 0);
    const proof = receipt.find(r => r.action === 'lane-preflight'); assert.ok(proof?.evidence?.sha256);
    assert.deepEqual(fs.readFileSync(path.join(proof.evidence.directory, 'files/.lane/review-and-scratch')), bytes);
    const manifestBytes = fs.readFileSync(proof.evidence.manifest);
    assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), proof.evidence.sha256);
    assert.ok(receipt.findIndex(r => r.action === 'lane-preflight') < receipt.findIndex(r => r.action === 'lane-removed'));
    assert.ok(f.read().actions.some(a => a[0] === 'workspace' && a[1] === 'close'));
  }
});


test('workspace close failure retries only the empty workspace after Git removal', t => {
  const f = fixture(t, { occupied: false }); isolatedEnv(t, f);
  f.state.failWorkspace = true; f.save();
  const queue = f.queue(), result = finishCleanup(f.job, { outcome: 'promoted', tip: f.head, workspace: f.lane }, queue);
  assert.equal(result.outcome, 'promoted'); assert.equal(result.cleanup.state, 'pending');
  assert.match(result.reason, /workspace.*failure/); assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['branch', '--list', 'lane/topic']), ''); assert.equal(f.read().workspaces.length, 1);
  const state = f.read(); state.failWorkspace = false; fs.writeFileSync(f.file, JSON.stringify(state));
  const retried = finishCleanup(f.job, result, queue);
  assert.equal(retried.cleanup.state, 'complete', retried.reason); assert.equal(f.read().workspaces.length, 0);
  assert.equal(retried.reason, 'green fast-forward; cleanup complete'); assert.deepEqual(retried.warnings, []);
});


test('an occupied workspace retry retains its reason in the cleanup receipt after the lane is gone', t => {
  const f = fixture(t, { occupied: false }); isolatedEnv(t, f);
  const queue = f.queue(), result = finishCleanup(f.job, { outcome: 'promoted', tip: f.head, workspace: f.lane }, queue);
  assert.equal(result.cleanup.state, 'complete', result.reason);
  f.state.tabs = [{ tab_id: 'w:shell', workspace_id: 'w' }];
  f.state.panes = [{ pane_id: 'w:shell:p', tab_id: 'w:shell', workspace_id: 'w' }]; f.save();
  const retried = finishCleanup(f.job, { ...result, cleanup: { state: 'pending' } }, queue);
  assert.equal(retried.outcome, 'promoted'); assert.equal(retried.cleanup.state, 'pending');
  assert.match(retried.reason, /occupied lane/); assert.equal(f.read().workspaces.length, 1);
  const receipt = fs.readFileSync(path.join(queue.directory, 'job-cleanup.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(receipt.some(r => r.action === 'keep' && r.workspace_id === 'w' && /occupied lane/.test(r.why)));
});

for (const gitOnly of [true, false]) test(`a planner KEEP refuses ${gitOnly ? 'git-only' : 'normal'} unmerged close before any evidence copy or tag`, t => {
  const f = fixture(t, { merged: false });
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n.lane/\n');
  fs.mkdirSync(path.join(f.lane, '.lane')); fs.writeFileSync(path.join(f.lane, '.lane/scratch'), 'unique scratch');
  f.state.agents[0].agent_status = 'working'; f.save();
  const refs = f.git(['for-each-ref', '--format=%(refname) %(objectname)']);
  const result = f.close(gitOnly); assert.notEqual(result.status, 0); assert.match(result.stderr, /occupant worker is working/);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
  assert.equal(f.git(['for-each-ref', '--format=%(refname) %(objectname)']), refs);
  assert.equal(fs.readFileSync(path.join(f.lane, '.lane/scratch'), 'utf8'), 'unique scratch'); assertNoRemoval(f);
});

test('retirement fixture isolates inherited session configuration and restores its caller', t =>
  checkSessionIsolation(t, child => {
    const f = fixture(child); isolatedEnv(child, f); adoptStandard(f); return f;
  }, Object.fromEntries(RETIREMENT_ENV_KEYS.filter(key => !['HOME', 'HERDR_MONITOR_FLEET'].includes(key))
    .map(key => [key, key === 'NODE_OPTIONS' ? '--no-warnings' : `/caller/${key}`]))));

function runnerEvidenceFixture(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-runner-evidence-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const file = (name, source) => {
    const target = path.join(scratch, `${name}.test.mjs`);
    fs.writeFileSync(target, `import test from 'node:test'; import fs from 'node:fs';\n${source}`);
    return target;
  };
  const run = async (files, extra = {}) => {
    const child = spawnScenarioChild(t, process.execPath, [path.join(root, 'test/helpers/run.mjs'), '--load-factor=1', ...files], {
      env: { ...process.env, MONITOR_TEST_TIMINGS_PATH: path.join(scratch, 'timings.jsonl'),
        MONITOR_TEST_CONCURRENCY: '2', MONITOR_TEST_FILE_TIMEOUT_MS: '0', ...extra },
    });
    const result = await waitForExit(child);
    const completions = [...result.stderr.matchAll(/^FILE_TAP_COMPLETE: (.*)$/gm)].map(match => JSON.parse(match[1]));
    for (const completion of completions) {
      assert.deepEqual(JSON.parse(fs.readFileSync(completion.completion_artifact, 'utf8')), completion);
    }
    return { ...result, completions };
  };
  return { file, run };
}

test('retirement runner retains raw stderr and a terminal receipt when a file dies before its first result', async t => {
  const f = runnerEvidenceFixture(t), diagnostic = `native crash: ${'é'.repeat(128 * 1024)} END\n`;
  const file = f.file('native-crash', `fs.writeSync(2, ${JSON.stringify(diagnostic)}); process.kill(process.pid, 'SIGTERM');`);
  const result = await f.run([file]);
  assert.equal(result.signal, null, result.stderr.slice(-1000));
  assert.equal(result.code, 1);
  assert.equal(result.completions.length, 1, result.stderr.slice(-1000));
  const completion = result.completions[0];
  assert.equal(completion.file, file);
  assert.equal(completion.exit_code, 1);
  assert.equal(completion.failure.signal, 'SIGTERM');
  assert.equal(fs.readFileSync(completion.stderr_artifact, 'utf8'), diagnostic);
  assert.ok(result.stdout.includes(diagnostic.trimEnd()), 'crash stderr must also reach the build log');
  assert.match(result.stdout, /not ok 1/);
  t.diagnostic(JSON.stringify({ file_crash_signal: completion.failure.signal, raw_stderr_bytes: Buffer.byteLength(diagnostic), exit_code: completion.exit_code }));
});

test('retirement runner records partial TAP and stderr for a peer cancelled by another file timeout', async t => {
  const f = runnerEvidenceFixture(t);
  const blocked = f.file('first-timeout', "fs.writeSync(2,'FIRST-TIMEOUT-DIAGNOSTIC\\n'); test('blocked first file',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0));");
  const peer = f.file('cancelled-peer', "fs.writeSync(2,'CANCELLED-PEER-DIAGNOSTIC\\n'); test('blocked peer file',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0));");
  const result = await f.run([blocked, peer], { MONITOR_TEST_FILE_TIMEOUT_MS: '5000' });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 1);
  assert.equal(result.completions.length, 2, result.stderr);
  assert.equal(new Set(result.completions.map(row => row.file)).size, 2, 'one completion per admission');
  const cancelled = result.completions.filter(row => row.observed_by === 'coordinator');
  assert.ok(cancelled.length >= 1, result.stderr);
  for (const completion of cancelled) {
    assert.equal(completion.exit_code, 1);
    assert.equal(completion.tap_complete, false);
    assert.equal(completion.signal, 'SIGKILL');
    assert.ok(['file-timeout', 'suite-cancelled'].includes(completion.reason));
    const diagnostic = fs.readFileSync(completion.stderr_artifact, 'utf8');
    assert.match(diagnostic, /(?:FIRST-TIMEOUT|CANCELLED-PEER)-DIAGNOSTIC/);
    assert.ok(result.stderr.includes(diagnostic), 'cancelled file stderr must reach the build log');
    assert.ok(result.stdout.includes(fs.readFileSync(completion.artifact, 'utf8')), 'partial TAP must reach the build log');
  }
  assert.ok(result.completions.some(row => row.reason === 'suite-cancelled'), result.stderr);
  t.diagnostic(JSON.stringify({ cancelled: cancelled.map(row => ({ reason: row.reason, signal: row.signal, tap_complete: row.tap_complete })), completions: result.completions.length }));
});
