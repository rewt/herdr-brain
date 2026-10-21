// Native worker and reviewer launch, delivery and session metadata.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from '../../test/helpers/bounded-test.mjs';
import { spawnChild, spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { createRetirement } from '../../lib/retire-runtime.mjs';
import { planRetirement } from '../../lib/retire.mjs';
import { ownerProcess } from '../../lib/process-owner.mjs';
import { initialShellFile } from '../../lib/initial-shell.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import {
  HERE,
  LANE,
  HERDR_CLIENT,
  HEAD,
  parseVerdict,
  negativeControl,
  hermeticGitEnvironment,
  git,
  makeFixture,
  writeConfig,
  lane,
  waitForCondition,
  lanePath,
  openLane,
  ignoreLaneState,
  repositoryIdentity,
  writeFakeHerdr,
  registryApi,
  runRegistryChild,
  expectUnsafeDispatchRefusal,
  makeReviewFixture,
  privateReviewDelivery,
} from "./lane-fixture.mjs";

// Assert fixture targets here so one-hop planning sees both indirect CLI dependencies.
assert.equal(LANE, resolve(process.env.LANE_TEST_CLI ?? join(HERE, "..", "lane.mjs")));
assert.equal(HERDR_CLIENT, resolve(HERE, "..", "board", "herdr-client.mjs"));

test("dispatch refreshes Herdr workspaces before accepting newly visible metadata", () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    const path = openLane(fixture, "dispatch-refresh");
    const fake = writeFakeHerdr(fixture, {
      lanePath: path,
      branch: "lane/dispatch-refresh",
      initiallyOpened: true,
      hideOpenedOnFirstList: true,
    });
    const dispatched = lane(fixture, ["dispatch", "dispatch-refresh", "review this"]);
    assert.equal(dispatched.status, 0, dispatched.stderr);
    assert.match(dispatched.stdout, /dispatched 'lane-dispatch-refr-/);
    assert.equal(
      fake.calls().filter((args) => args[0] === "worktree" && args[1] === "open").length,
      0,
    );
    negativeControl("dispatch workspace refresh");
  } finally {
    fixture.cleanup();
  }
});

test("dispatch checks the captured Codex hooks screen before direct brief delivery and retains blocked workers", async () => {
  const screen = readFileSync(new URL('../../dispatch/test/fixtures/codex-0.160.0-hooks-screen.txt', import.meta.url), 'utf8');
  const scenarios = [
    { kind: 'codex', blocked: true },
    { kind: 'codex', profile: 'claude-mem-bastian', blocked: true },
    { kind: 'codex', screen: 'Hooks need review\n1 hook is new or changed.', blocked: true },
    { kind: 'codex', screen: screen.split('\n').map(line => `> ${line}`).join('\n'), blocked: false },
    { kind: 'claude', blocked: false },
    { kind: 'codex', screenFail: true, blocked: true },
  ];
  for (const scenario of scenarios) {
    const fixture = makeFixture({ main: 'main', validate: 'true', routes: {
      engineer: { kind: scenario.kind, args: scenario.profile ? ['-p', scenario.profile] : [] },
    } });
    try {
      ignoreLaneState(fixture);
      const path = openLane(fixture, 'hook-screen');
      const fake = writeFakeHerdr(fixture, { lanePath: path, branch: 'lane/hook-screen', initiallyOpened: true });
      fixture.env.FAKE_HERDR_SCREEN = scenario.screen ?? screen;
      fixture.env.FAKE_HERDR_SCREEN_FAIL = scenario.screenFail ? '1' : '0';
      const brief = join(fixture.root, 'brief.md');
      writeFileSync(brief, 'Deliver this brief once');
      const result = lane(fixture, ['dispatch', 'hook-screen', '--route', 'engineer', `@${brief}`]);
      assert.equal(result.status, scenario.blocked ? 1 : 0, result.stderr);
      const calls = fake.calls();
      assert.equal(calls.filter(args => args[0] === 'agent' && args[1] === 'prompt').length, scenario.blocked ? 0 : 1);
      const reads = calls.filter(args => args[0] === 'pane' && args[1] === 'read' && args.includes('visible'));
      assert.equal(reads.length, scenario.kind === 'codex' ? 1 : 0);
      if (reads.length) assert.deepEqual(reads[0], ['pane', 'read', fake.state().agentPane, '--source', 'visible', '--format', 'text']);
      if (scenario.blocked) {
        assert.match(result.stderr, /brief not sent/);
        assert.ok(result.stderr.includes(fake.state().agent));
        assert.ok(result.stderr.includes(fake.state().agentPane));
        if (!scenario.screenFail) {
          assert.match(result.stderr, /Open \/hooks/);
          assert.ok(result.stderr.includes(scenario.profile ?? 'configured default profile'));
          assert.match(result.stderr, /Hook trust is the operator's decision/);
        }
        assert.ok(!calls.some(args => args[1] === 'close' || args[1] === 'send-keys'));
        const { loadRegistry } = await registryApi();
        assert.equal(loadRegistry(fixture.repo).sessions.length, 0);
      } else if (reads.length) {
        assert.ok(calls.indexOf(reads[0]) < calls.findIndex(args => args[1] === 'prompt'));
      }
    } finally {
      fixture.cleanup();
    }
  }
});

for (const nativeCreate of [true, false]) test(`lane open records its invocation-owned initial shell after ${nativeCreate ? 'native create' : 'open repair'}`, () => {
  const fixture = makeFixture();
  try {
    const path = lanePath(fixture, 'initial-receipt');
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: 'lane/initial-receipt' });
    fixture.env.FAKE_HERDR_INITIAL_RECEIPT = '1';
    if (nativeCreate) fixture.env.FAKE_HERDR_CREATE_RECEIPT = '1';
    const opened = lane(fixture, ['open', 'initial-receipt']);
    assert.equal(opened.status, 0, opened.stderr);
    const common = repositoryIdentity(fixture.repo), file = initialShellFile(common, 'w-lane:t1');
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(receipt, { schema: 'initial-shell/v1', common, cwd: path,
      workspace: 'w-lane', tab: 'w-lane:t1', pane: 'w-lane:p1', terminal: 'fixture-terminal-1',
      shell: { pid: 123456789, identity: 'initial-shell-birth', command: '[zsh]' } });
    assert.equal(fake.calls().filter(args => args[0] === 'worktree' && args[1] === 'open').length, nativeCreate ? 0 : 1);
    assert.ok(!fake.calls().some(args => args[0] === 'agent' || args[1] === 'focus' || args[1] === 'close'));
  } finally { fixture.cleanup(); }
});

test('a fresh git-only lane initial shell stays open without a recorded terminal chain', () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    const path = lanePath(fixture, 'fresh-shell');
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: 'lane/fresh-shell', initiallyOpened: true });
    fixture.env.FAKE_HERDR_INITIAL_INVENTORY = '1'; fixture.env.FAKE_HERDR_INITIAL_RECEIPT = '1';
    fixture.env.ORG_DIR = join(fixture.root, 'record'); mkdirSync(fixture.env.ORG_DIR);
    writeFileSync(join(fixture.env.ORG_DIR, 'events.jsonl'), '');
    const opened = lane(fixture, ['open', 'fresh-shell', '--git-only']); assert.equal(opened.status, 0, opened.stderr);
    const retirement = createRetirement({ cwd: fixture.repo, org: fixture.env.ORG_DIR, env: fixture.env,
      herdr: join(fixture.bin, 'herdr'), selfTab: null });
    const plan = retirement.plan();
    assert.equal(plan.close.length, 0); assert.match(plan.keep.find(row => row.tab_id === 'w-lane:t1').why, /no terminal chain/);
    retirement.apply(plan);
    assert.ok(!fake.calls().some(args => args[1] === 'close'));
  } finally { fixture.cleanup(); }
});

test('dispatch retains the initial pane and falls back when its receipt is missing', () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    const path = lanePath(fixture, 'receipt-fallback');
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: 'lane/receipt-fallback' });
    fixture.env.FAKE_HERDR_INITIAL_RECEIPT = '1';
    fixture.env.FAKE_HERDR_INITIAL_FILE = initialShellFile(repositoryIdentity(fixture.repo), 'w-lane:t1');
    fixture.env.FAKE_HERDR_DROP_INITIAL_RECEIPT = '1';
    const opened = lane(fixture, ['open', 'receipt-fallback', '--git-only']); assert.equal(opened.status, 0, opened.stderr);
    const dispatched = lane(fixture, ['dispatch', 'receipt-fallback', '--json']);
    assert.equal(dispatched.status, 0, dispatched.stderr); assert.equal(JSON.parse(dispatched.stdout).pane, 'w-lane:p2');
    assert.match(dispatched.stderr, /receipt is missing/);
    assert.ok(!fake.calls().some(args => args[1] === 'close'));
  } finally { fixture.cleanup(); }
});

test('dispatch reuses the initial pane when no initial-shell receipt was recorded', async () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    const topic = 'no-initial-receipt', path = lanePath(fixture, topic);
    // The native opener owns p1, but the fake's incomplete process observation
    // cannot supply the shell birth identity required by a retirement receipt.
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: `lane/${topic}` });
    const file = initialShellFile(repositoryIdentity(fixture.repo), 'w-lane:t1');
    const opened = lane(fixture, ['open', topic, '--git-only']); assert.equal(opened.status, 0, opened.stderr);
    const dispatched = lane(fixture, ['dispatch', topic, '--json', 'Implement once']);
    assert.equal(dispatched.status, 0, dispatched.stderr);
    const result = JSON.parse(dispatched.stdout);
    assert.equal(result.pane, 'w-lane:p1'); assert.equal(result.tabId, 'w-lane:t1');
    assert.match(dispatched.stderr, /initial shell receipt unavailable/);
    assert.doesNotMatch(dispatched.stderr, /receipt is missing|separate tab/);
    assert.equal(existsSync(file), false, 'reuse must not create or claim a retirement receipt');
    assert.equal(fake.state().tabCount || 1, 1);
    const calls = fake.calls();
    for (const verb of ['run', 'start', 'prompt', 'rename']) assert.equal(calls.filter(args => args[1] === verb).length, 1);
    assert.ok(!calls.some(args => args[1] === 'create' || args[1] === 'close' || args[1] === 'focus'));
    const { loadRegistry } = await registryApi();
    const sessions = loadRegistry(fixture.repo).sessions;
    assert.equal(sessions.length, 1); assert.equal(sessions[0].pane, 'w-lane:p1');
  } finally { fixture.cleanup(); }
});

test("dispatch opens a single agent tab in the initial pane and keeps fix rounds background", async () => {
  const values = { NORMAL: "plain", QUOTED: "spaces ' \" $HOME $(exit 99) `exit 99`;\nsecond line", EMPTY: "" };
  const fixture = makeFixture({ main: "main", validate: "true", routes: {
    engineer: { kind: "codex", model: "initial-model", effort: "high",
      env: Object.entries(values).map(([key, value]) => `${key}=${value}`) },
  } });
  try {
    ignoreLaneState(fixture);
    const path = lanePath(fixture, "initial-pane");
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: "lane/initial-pane" });
    fixture.env.FAKE_HERDR_INITIAL_RECEIPT = '1';
    fixture.env.FAKE_HERDR_INITIAL_FILE = initialShellFile(repositoryIdentity(fixture.repo), 'w-lane:t1');
    fixture.env.FAKE_HERDR_INITIAL_LOCK = join(repositoryIdentity(fixture.repo), 'retirement/tabs', createHash('sha256').update('w-lane:t1').digest('hex'));
    const opened = lane(fixture, ["open", "initial-pane", "--git-only"]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, /deferred until dispatch/u);
    assert.deepEqual(fake.calls(), [], 'Git-only opening must not create a Herdr shell');
    const extraValue = 'private-cli-credential';
    const first = lane(fixture, ["dispatch", "initial-pane", "--route", "engineer", "--env", `NORMAL=${extraValue}`, "--json", "Implement this"]);
    assert.equal(first.status, 0, first.stderr);
    const firstResult = JSON.parse(first.stdout);
    assert.equal(firstResult.pane, "w-lane:p1");
    assert.equal(firstResult.tabId, "w-lane:t1");
    assert.equal(fake.state().initialClaimBeforeStart, true);
    assert.equal(fake.state().initialLockDuringCapture, true);
    assert.equal(fake.state().initialClaimAtSupports, false, 'the compatibility check precedes the claim');
    assert.equal(fake.state().initialLockAtSupports, true, 'the tab lock protects the receipt during the compatibility check');
    assert.equal(existsSync(fixture.env.FAKE_HERDR_INITIAL_LOCK), false, 'successful dispatch releases its tab lock');
    const shellReceipt = JSON.parse(readFileSync(fixture.env.FAKE_HERDR_INITIAL_FILE, 'utf8'));
    assert.equal(shellReceipt.cwd, path); assert.equal(shellReceipt.shell.identity, 'initial-shell-birth');
    let calls = fake.calls();
    assert.equal(calls.filter(args => args[0] === "tab" && args[1] === "create").length, 0);
    assert.deepEqual(calls.find(args => args[0] === "tab" && args[1] === "rename"),
      ["tab", "rename", "w-lane:t1", "agent:initial-pane"]);
    const exportIndex = calls.findIndex(args => args[0] === "pane" && args[1] === "run");
    const startIndex = calls.findIndex(args => args[0] === "agent" && args[1] === "start");
    assert.ok(exportIndex >= 0 && exportIndex < startIndex);
    assert.equal(calls[exportIndex][2], "w-lane:p1");
    assert.equal(calls[startIndex][calls[startIndex].indexOf("--pane") + 1], "w-lane:p1");
    assert.ok(calls[startIndex].includes("initial-model"));
    const exported = fake.state().preparedEnv;
    for (const [key, value] of Object.entries({ ...values, NORMAL: extraValue })) assert.equal(exported[key], value);
    assert.equal(fake.state().environmentMode, 0o600);
    assert.equal(fake.state().environmentDirectoryMode, 0o700);
    assert.ok(!existsSync(fake.state().environmentFile));
    assert.ok(!existsSync(dirname(fake.state().environmentFile)));
    const paneRuns = calls.filter(args => args[0] === 'pane' && args[1] === 'run');
    for (const value of [...Object.values(values).filter(Boolean), extraValue]) {
      assert.ok(!paneRuns.some(args => args.some(arg => arg.includes(value))), 'env values must not be pane input');
    }
    assert.equal(fake.state().environmentReads, 3);
    const readIndex = calls.findLastIndex(args => args[0] === 'pane' && args[1] === 'read' && args.includes('recent-unwrapped'));
    assert.ok(readIndex > exportIndex && readIndex < startIndex);
    assert.equal(fake.state().initialLabel, 'agent:initial-pane');
    assert.equal(fake.state().renamedAfterStart, true);
    assert.equal(fake.state().renamedAfterVerification, true);
    assert.equal(fake.state().tabCount || 1, 1);
    const { loadRegistry } = await registryApi();
    const [metadata] = loadRegistry(fixture.repo).sessions;
    assert.equal(metadata.pane, "w-lane:p1");
    const fix = lane(fixture, ["dispatch", "initial-pane", "--route", "engineer", "--json"]);
    assert.equal(fix.status, 0, fix.stderr);
    assert.equal(JSON.parse(fix.stdout).tabId, "w-lane:t2");
    calls = fake.calls();
    assert.equal(calls.filter(args => args[0] === "worktree" && args[1] === "open").length, 1);
    assert.equal(calls.filter(args => args[0] === "pane" && args[1] === "run").length, 1);
    const created = calls.filter(args => args[0] === "tab" && args[1] === "create");
    assert.equal(created.length, 1);
    assert.ok(created[0].includes("--no-focus"));
    assert.equal(fake.state().tabCount, 2);
    assert.ok(!calls.some(args => args[1] === "focus" || args.includes("--focus") || args[1] === "close"));
    negativeControl("initial-pane dispatch and reused fix round");
  } finally { fixture.cleanup(); }
});

test('dispatch fallback leaves an unsupported initial shell unclaimed and retireable', t => {
  const fixture = makeFixture(); fixtureFleet(t, fixture.root);
  try {
    ignoreLaneState(fixture);
    fixture.env.HERDR_MONITOR_FLEET = process.env.HERDR_MONITOR_FLEET;
    const topic = 'unused-fish', path = lanePath(fixture, topic);
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: `lane/${topic}` });
    const common = repositoryIdentity(fixture.repo), file = initialShellFile(common, 'w-lane:t1');
    Object.assign(fixture.env, { FAKE_HERDR_INITIAL_RECEIPT: '1', FAKE_HERDR_INITIAL_FILE: file,
      FAKE_HERDR_PANE_SHELL: '/opt/homebrew/bin/fish',
      FAKE_HERDR_INITIAL_LOCK: join(common, 'retirement/tabs', createHash('sha256').update('w-lane:t1').digest('hex')) });
    assert.equal(lane(fixture, ['open', topic, '--git-only']).status, 0);
    const dispatched = lane(fixture, ['dispatch', topic, '--json']);
    assert.equal(dispatched.status, 0, dispatched.stderr); assert.equal(JSON.parse(dispatched.stdout).pane, 'w-lane:p2');
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(receipt.claimed, undefined); assert.equal(receipt.shell.command, '[fish]');
    assert.equal(fake.state().initialLockAtSupports, true);
    assert.equal(existsSync(fixture.env.FAKE_HERDR_INITIAL_LOCK), false);
    assert.ok(!fake.calls().some(args => args[1] === 'run' || args[1] === 'rename' || args[1] === 'close'));
    // After the worker finishes and its work is integrated, the untouched
    // fallback shell can retire using the actual dispatch-created receipt.
    writeFileSync(join(path, 'shared.txt'), 'finished work\n'); git(path, ['commit', '-am', 'finished work']);
    git(fixture.repo, ['merge', '--ff-only', `lane/${topic}`]);
    const state = fake.state(); delete state.agent; writeFileSync(fixture.env.FAKE_HERDR_STATE, JSON.stringify(state));
    fixture.env.FAKE_HERDR_INITIAL_INVENTORY = '1';
    fixture.env.ORG_DIR = join(fixture.root, 'record'); mkdirSync(fixture.env.ORG_DIR); writeFileSync(join(fixture.env.ORG_DIR, 'events.jsonl'), '');
    const retirement = createRetirement({ cwd: fixture.repo, org: fixture.env.ORG_DIR, env: fixture.env,
      herdr: join(fixture.bin, 'herdr'), selfTab: null });
    const plan = retirement.plan(); assert.equal(plan.close.length, 1, JSON.stringify(plan.keep));
    assert.equal(plan.close[0].rule, 'initial-shell/v1');
    assert.equal(retirement.apply(plan)[0].action, 'closed');
    assert.ok(fake.calls().some(args => args[0] === 'tab' && args[1] === 'close' && args[2] === 'w-lane:t1'));
  } finally { fixture.cleanup(); }
});

for (const linkedCaller of [false, true]) test(`dispatch opens a one-tab lane without a project workspace (linked caller: ${linkedCaller})`, async () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    const topic = "no-parent", path = lanePath(fixture, topic);
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: `lane/${topic}` });
    fixture.env.FAKE_HERDR_NO_PARENT = "1";
    fixture.env.FAKE_HERDR_COMPLETE_SHELL = '1';
    assert.equal(lane(fixture, ["open", topic, "--git-only"]).status, 0);
    if (linkedCaller) assert.equal(lane(fixture, ["open", "caller", "--git-only"]).status, 0);
    const caller = linkedCaller ? lanePath(fixture, "caller") : fixture.repo;
    const run = lane(fixture, ["dispatch", topic, "--json", "Implement this"], { cwd: caller });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).pane, "w-lane:p1");
    const calls = fake.calls();
    assert.deepEqual(calls.find(args => args[0] === "worktree" && args[1] === "open"),
      ["worktree", "open", "--cwd", fixture.repo, "--path", path, "--label", fake.state().label, "--no-focus"]);
    assert.match(fake.state().label, /:lane-no-parent$/);
    assert.equal(calls.filter(args => args[0] === "agent" && args[1] === "start").length, 1);
    assert.equal(calls.filter(args => args[0] === "agent" && args[1] === "prompt").length, 1);
    assert.ok(!calls.some(args => args[1] === "create" || args[1] === "focus" || args.includes("--focus")));
    assert.equal(fake.state().initialLabel, `agent:${topic}`);
    assert.equal(fake.state().tabCount || 1, 1);
    const { loadRegistry } = await registryApi();
    assert.equal(loadRegistry(fixture.repo).sessions.length, 1);
  } finally { fixture.cleanup(); }
});

test("dispatch retains the recorded session after a rejected final rename without replay", async () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    const path = openLane(fixture, "rename-refused");
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: "lane/rename-refused" });
    fixture.env.FAKE_HERDR_RENAME_FAIL = "1";
    const run = lane(fixture, ["dispatch", "rename-refused", "Implement once"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /partial success: live agent .* was recorded.*could not be renamed; do not replay dispatch/);
    const { loadRegistry } = await registryApi();
    const sessions = loadRegistry(fixture.repo).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].name, fake.state().agent);
    assert.equal(sessions[0].pane, "w-lane:p1");
    const calls = fake.calls();
    for (const verb of ["start", "prompt", "rename"]) assert.equal(calls.filter(args => args[1] === verb).length, 1);
    assert.equal(fake.state().initialLabel, undefined);
    assert.ok(!calls.some(args => args[1] === "close" || args[1] === "focus" || args.includes("--focus")));
  } finally { fixture.cleanup(); }
});

for (const rcChild of [false, true]) test(`dispatch uses the pane POSIX shell despite SHELL=fish (rc child: ${rcChild})`, async t => {
  const fixture = makeFixture();
  // An actual sh pid exercises /bin/ps while the foreground list contains only
  // an rc child. Keep stdin open so the process remains alive through dispatch.
  const shell = rcChild ? spawnChild(t, "/bin/sh", [], { stdio: ["pipe", "ignore", "ignore"] }) : undefined;
  try {
    if (rcChild) {
      const probe = spawnSync('/bin/ps', ['-p', String(shell.pid), '-o', 'comm='], { encoding: 'utf8' });
      if (probe.status !== 0 || !probe.stdout.trim()) { t.skip('host /bin/ps cannot observe the POSIX shell for this native fixture'); return; }
    }
    ignoreLaneState(fixture);
    const path = openLane(fixture, "pane-shell");
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: "lane/pane-shell" });
    fixture.env.FAKE_HERDR_COMPLETE_SHELL = '1';
    fixture.env.SHELL = "/opt/homebrew/bin/fish";
    fixture.env.FAKE_HERDR_PANE_SHELL = "sh";
    if (rcChild) {
      fixture.env.FAKE_HERDR_RC_CHILD = "1";
      fixture.env.FAKE_HERDR_SHELL_PID = String(shell.pid);
    }
    const run = lane(fixture, ["dispatch", "pane-shell", "--json"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).pane, "w-lane:p1");
    assert.equal(fake.state().tabCount || 1, 1);
    assert.equal(fake.state().renamedAfterStart, true);
    assert.ok(!fake.calls().some(args => args[1] === "create" || args[1] === "focus" || args.includes("--focus")));
  } finally {
    shell?.stdin.end();
    if (shell) await waitForExit(shell);
    fixture.cleanup();
  }
});

test("dispatch leaves earlier and concurrently opened workspace shells untouched", () => {
  for (const race of [false, true]) {
    const fixture = makeFixture();
    try {
      ignoreLaneState(fixture);
      const path = openLane(fixture, "existing-shell");
      const fake = writeFakeHerdr(fixture, { lanePath: path, branch: "lane/existing-shell", initiallyOpened: !race });
      if (race) fixture.env.FAKE_HERDR_OPEN_RACE = "1";
      const run = lane(fixture, ["dispatch", "existing-shell", "--json"]);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).pane, "w-lane:p2");
      const calls = fake.calls();
      assert.ok(calls.some(args => args[0] === "tab" && args[1] === "create" && args.includes("--no-focus")));
      assert.ok(!calls.some(args => args[1] === "run" || args[1] === "rename" || args[1] === "close" || args[1] === "focus"));
      assert.equal(existsSync(initialShellFile(repositoryIdentity(fixture.repo), 'w-lane:t1')), false, 'no receipt backfill for a prior or concurrent opener');
    } finally { fixture.cleanup(); }
  }
  negativeControl("initial pane requires an invocation-owned creation receipt");
});

test('retirement hold: failed dispatch keeps its newly created tab', () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    const path = openLane(fixture, 'held-dispatch');
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: 'lane/held-dispatch', initiallyOpened: true, startFail: true });
    const hold = join(fixture.repo, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE'); mkdirSync(dirname(hold), { recursive: true }); writeFileSync(hold, 'hold');
    const held = lane(fixture, ['dispatch', 'held-dispatch', '--json']);
    assert.equal(held.status, 1); assert.match(held.stderr, /retirement held/);
    assert.ok(!fake.calls().some(a => ['close', 'remove'].includes(a[1])));
    rmSync(hold); const resumed = lane(fixture, ['dispatch', 'held-dispatch', '--json']);
    assert.equal(resumed.status, 1); assert.ok(fake.calls().some(a => a[0] === 'tab' && a[1] === 'close'));
  } finally { fixture.cleanup(); }
});

test("dispatch retains initial tabs on environment and agent cwd failures", () => {
  for (const failure of ['send', 'dropped', 'wrong', 'start', 'cwd', 'prompt']) {
    const fixture = makeFixture();
    try {
      ignoreLaneState(fixture);
      const path = openLane(fixture, "initial-failure");
      const fake = writeFakeHerdr(fixture, { lanePath: path, branch: "lane/initial-failure",
        ...(failure === 'cwd' ? { agentCwd: fixture.repo } : {}) });
      fixture.env.FAKE_HERDR_COMPLETE_SHELL = '1';
      if (failure === 'send') fixture.env.FAKE_HERDR_EXPORT_FAIL = "1";
      if (failure === 'dropped') fixture.env.FAKE_HERDR_EXPORT_DROP = "1";
      if (failure === 'wrong') fixture.env.FAKE_HERDR_EXPORT_WRONG = "1";
      if (failure === 'start') fixture.env.FAKE_HERDR_START_FAIL = "1";
      if (failure === 'prompt') fixture.env.FAKE_HERDR_PROMPT_FAIL = "1";
      const run = lane(fixture, ["dispatch", "initial-failure", "--env", "CHECK_ENV=expected", "do not send"]);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /initial tab retained|prompt command failed/u);
      assert.equal(fake.state().initialLabel, undefined, 'a failed dispatch must keep the initial shell label');
      assert.ok(!fake.calls().some(args => args[0] === 'tab' && args[1] === 'rename'));
      assert.ok(!fake.calls().some(args => args[1] === "close" || (args[1] === "prompt" && failure !== 'prompt') || args[1] === "focus"));
      if (['send', 'dropped', 'wrong'].includes(failure)) assert.ok(!fake.calls().some(args => args[1] === "start"));
      assert.ok(!existsSync(fake.state().environmentFile));
      assert.ok(!existsSync(dirname(fake.state().environmentFile)));
    } finally { fixture.cleanup(); }
  }
  negativeControl("failed initial-pane dispatch preserves its tab");
});

test("dispatch waits for shell readiness beyond five seconds", () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    const path = openLane(fixture, "slow-shell");
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: "lane/slow-shell" });
    fixture.env.FAKE_HERDR_ENV_DELAY = "6000";
    const preload = join(fixture.root, 'no-load.mjs');
    writeFileSync(preload, "import os from 'node:os';os.loadavg=()=>[0,0,0];");
    fixture.env.NODE_OPTIONS = `${fixture.env.NODE_OPTIONS ?? ''} --import=${preload}`;
    const run = lane(fixture, ["dispatch", "slow-shell", "--json"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).pane, "w-lane:p1");
    assert.equal(fake.state().tabCount || 1, 1);
    assert.equal(fake.state().renamedAfterVerification, true);
    assert.ok(!fake.calls().some(args => args[1] === "focus" || args.includes("--focus")));
  } finally { fixture.cleanup(); }
});

for (const shell of ["/opt/homebrew/bin/fish", "/opt/homebrew/bin/nu"]) {
  test(`dispatch falls back to a separate agent tab for ${shell}`, () => {
    const fixture = makeFixture({ main: "main", validate: "true", routes: {
      engineer: { kind: "codex", env: ["PRIVATE_VALUE=from-route"] },
    } });
    try {
      ignoreLaneState(fixture);
      const path = openLane(fixture, "non-posix");
      const fake = writeFakeHerdr(fixture, { lanePath: path, branch: "lane/non-posix" });
      fixture.env.FAKE_HERDR_PANE_SHELL = shell;
      fixture.env.SHELL = "/bin/zsh";
      const run = lane(fixture, ["dispatch", "non-posix", "--route", "engineer", "--json"]);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).pane, "w-lane:p2");
      assert.equal(fake.state().tabCount, 2);
      assert.equal(fake.state().initialLabel, undefined);
      const created = fake.calls().find(args => args[0] === "tab" && args[1] === "create");
      assert.ok(created.includes("--no-focus"));
      assert.ok(created.includes("PRIVATE_VALUE=from-route"));
      assert.ok(!fake.calls().some(args => args[1] === "run" || args[1] === "rename" || args[1] === "close" || args[1] === "focus" || args.includes("--focus")));
    } finally { fixture.cleanup(); }
  });
}

test("dispatch records canonical session metadata with fenced-heading, prose, inline, and empty fallbacks", async () => {
  const scenarios = [
    {
      topic: "file-heading",
      brief: "```md\n# Not the goal\n```\n\n## Actual session goal ##\nBody\n",
      expectedGoal: "Actual session goal",
    },
    {
      topic: "file-prose",
      brief: "```\nfenced text\n```\n\nFirst prose line\nSecond line\n",
      expectedGoal: "First prose line",
    },
    { topic: "inline-goal", prompt: "Inline session goal\nignored", expectedGoal: "Inline session goal" },
    { topic: "inline-heading", prompt: "# Review session goal #\nignored", expectedGoal: "Review session goal" },
    {
      topic: "inline-fenced",
      prompt: "```md\n# Not the goal\n```\n\nFirst inline prose\n## Later heading\n",
      expectedGoal: "First inline prose",
    },
    {
      topic: "inline-prose-first",
      prompt: "Operator instruction\n\n## Later heading\n",
      expectedGoal: "Operator instruction",
    },
    {
      topic: "inline-only-fenced",
      prompt: "~~~md\n# Not the goal\n~~~\n",
      expectedGoal: "inline-only-fenced",
    },
    { topic: "bounded-goal", prompt: "x".repeat(205), expectedGoal: "x".repeat(200) },
    { topic: "empty-goal", expectedGoal: "empty-goal" },
  ];
  for (const scenario of scenarios) {
    const fixture = makeFixture({
      main: "main",
      validate: "true",
      registry: ".lane/sessions.json",
      routes: { engineer: { kind: "codex", model: "engineer-model", effort: "high" } },
    });
    try {
      ignoreLaneState(fixture);
      const path = openLane(fixture, scenario.topic);
      const briefPath = scenario.brief === undefined ? undefined : join(fixture.root, `${scenario.topic}.md`);
      if (briefPath !== undefined) writeFileSync(briefPath, scenario.brief);
      fixture.env.HERDR_SOCKET_PATH = join(fixture.root, "herdr.sock");
      const fake = writeFakeHerdr(fixture, {
        lanePath: path,
        branch: `lane/${scenario.topic}`,
        initiallyOpened: true,
      });
      const operand = briefPath === undefined
        ? (scenario.prompt === undefined ? [] : [scenario.prompt])
        : [`@${briefPath}`];
      const dispatched = lane(fixture, ["dispatch", scenario.topic, "--route", "engineer", ...operand], { cwd: path });
      assert.equal(dispatched.status, 0, dispatched.stderr);
      const { loadRegistry } = await registryApi();
      const loaded = loadRegistry(fixture.repo, { registry: ".lane/sessions.json" });
      assert.equal(loaded.errors.length, 0);
      assert.equal(loaded.sessions.length, 1);
      const [session] = loaded.sessions;
      assert.match(session.session_id, /^[0-9a-f-]{36}$/u);
      assert.equal(session.repo_id, repositoryIdentity(fixture.repo));
      assert.equal(session.root_id, realpathSync(dirname(fixture.repo)));
      assert.equal(session.repo, fixture.repo);
      assert.equal(session.topic, scenario.topic);
      assert.match(session.name, /^lane-/u);
      assert.equal(session.workspace, "w-lane");
      assert.equal(session.pane, "w-lane:p2");
      assert.equal(session.server, fixture.env.HERDR_SOCKET_PATH);
      assert.equal(session.lane, `lane/${scenario.topic}`);
      assert.equal(session.role, "engineer");
      assert.equal(session.route, "engineer");
      assert.equal(session.harness, "codex");
      assert.equal(session.model, "engineer-model");
      assert.equal(session.effort, "high");
      assert.equal(session.brief, briefPath ?? null);
      assert.equal(session.goal, scenario.expectedGoal);
      assert.equal(session.report, `docs/reports/${scenario.topic}.md`);
      assert.equal(session.deadline, null);
      assert.equal(session.done, false);
      assert.match(session.created_at, /^\d{4}-\d\d-\d\dT/u);
      assert.ok(existsSync(join(fixture.repo, ".lane", "sessions.json.d", `${session.session_id}.json`)));
      assert.ok(!existsSync(join(path, ".lane", "sessions.json.d")));
      assert.equal(git(fixture.repo, ["status", "--porcelain=v1"]), "");
      assert.equal(fake.calls().filter((args) => args[0] === "agent" && args[1] === "prompt").length,
        scenario.prompt === undefined && scenario.brief === undefined ? 0 : 1);
      const start = fake.calls().find((args) => args[0] === "agent" && args[1] === "start");
      assert.deepEqual(start.slice(start.indexOf("--") + 1), [
        "--model", "engineer-model", "-c", "model_reasoning_effort=high",
      ]);
      negativeControl(`dispatch metadata ${scenario.topic}`);
    } finally {
      fixture.cleanup();
    }
  }
});

test("dispatch persists immutable occupant evidence as display-only optional metadata", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    ignoreLaneState(fixture);
    const path = openLane(fixture, "occupant-evidence");
    writeFakeHerdr(fixture, {
      lanePath: path, branch: "lane/occupant-evidence", initiallyOpened: true,
    });
    const routeConfig = join(fixture.root, "pinned-routes.json");
    writeFileSync(routeConfig, JSON.stringify({ routes: { pinned: { kind: "codex", model: "pinned-model", effort: "high" } } }));
    const dispatched = lane(fixture, ["dispatch", "occupant-evidence", "--route", "pinned", "--route-config", routeConfig, "--json"], { cwd: path });
    assert.equal(dispatched.status, 0, dispatched.stderr);
    const result = JSON.parse(dispatched.stdout);
    assert.equal(result.cwd, path);
    assert.equal(result.agentSessionId, "fixture-session-1");
    assert.equal(result.terminalId, "fixture-terminal-1");
    const { loadRegistry } = await registryApi();
    const [session] = loadRegistry(fixture.repo, { registry: ".lane/sessions.json" }).sessions;
    assert.equal(session.agent_session_id, "fixture-session-1");
    assert.equal(session.terminal_id, "fixture-terminal-1");
    assert.equal(session.name, result.agentName);
    assert.equal(session.pane, result.pane);
    assert.equal(session.model, "pinned-model");
    assert.equal(session.effort, "high");
    assert.equal(session.lane, "lane/occupant-evidence");
    negativeControl("dispatch immutable display-only occupant metadata");
  } finally {
    fixture.cleanup();
  }
});

test("dispatch does not write a claim when the prompted occupant is replaced", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    ignoreLaneState(fixture);
    const path = openLane(fixture, "post-prompt-replacement");
    const fake = writeFakeHerdr(fixture, {
      lanePath: path, branch: "lane/post-prompt-replacement", initiallyOpened: true,
    });
    fixture.env.FAKE_HERDR_REPLACE_AFTER_PROMPT = "1";
    const dispatched = lane(fixture, ["dispatch", "post-prompt-replacement", "Brief text"], { cwd: path });
    assert.equal(dispatched.status, 1);
    assert.match(dispatched.stderr, /partial success.*immutable occupant identity changed/u);
    assert.equal(fake.calls().filter((args) => args[0] === "agent" && args[1] === "prompt").length, 1);
    const { loadRegistry } = await registryApi();
    assert.deepEqual(loadRegistry(fixture.repo, { registry: ".lane/sessions.json" }).sessions, []);
    negativeControl("post-prompt replacement cannot gain a dispatch record");
  } finally {
    fixture.cleanup();
  }
});

test("one exported Herdr socket-path helper supplies the Herdr client and dispatch records", async () => {
  const { HerdrClient, herdrSocketPath } = await import(HERDR_CLIENT);
  assert.equal(typeof herdrSocketPath, "function");
  const previous = process.env.HERDR_SOCKET_PATH;
  const expected = join(tmpdir(), "herdr-lanes-shared-socket.sock");
  try {
    process.env.HERDR_SOCKET_PATH = expected;
    assert.equal(herdrSocketPath(), expected);
    const client = new HerdrClient();
    assert.equal(client.socketPath, expected);
    client.close();
    const source = readFileSync(LANE, "utf8");
    assert.match(source, /server:\s*herdrSocketPath\(\)/u);
    assert.doesNotMatch(source, /server:\s*process\.env\.HERDR_SOCKET_PATH/u);
    negativeControl("shared Herdr socket-path helper");
  } finally {
    if (previous === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previous;
  }
});

test("dispatch refuses unsafe registries and unreadable briefs before every Herdr call", () => {
  const scenarios = [
    {
      topic: "unignored-registry",
      setup() {},
      expected: /registry.*gitignored.*\.gitignore/u,
    },
    {
      topic: "tracked-registry",
      setup(fixture) {
        ignoreLaneState(fixture);
        mkdirSync(join(fixture.repo, ".lane"), { recursive: true });
        writeFileSync(join(fixture.repo, ".lane", "sessions.json"), "[]\n");
        git(fixture.repo, ["add", "-f", ".lane/sessions.json"]);
        git(fixture.repo, ["commit", "-m", "track unsafe registry"], { stdio: "ignore" });
      },
      expected: /registry.*tracked/u,
    },
    {
      topic: "tracked-sidecar",
      setup(fixture) {
        ignoreLaneState(fixture);
        const directory = join(fixture.repo, ".lane", "sessions.json.d");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "tracked.json"), "{}\n");
        git(fixture.repo, ["add", "-f", ".lane/sessions.json.d/tracked.json"]);
        git(fixture.repo, ["commit", "-m", "track unsafe sidecar"], { stdio: "ignore" });
      },
      expected: /registry.*tracked/u,
    },
    {
      topic: "external-registry",
      configure(fixture) {
        writeConfig(fixture, { main: "main", validate: "true", registry: join(fixture.root, "external.json") });
      },
      setup(fixture) { writeFileSync(join(fixture.root, "external.json"), "[]\n"); },
      expected: /repository-local registry/u,
    },
    {
      topic: "missing-brief",
      setup(fixture) { ignoreLaneState(fixture); },
      operand(fixture) { return `@${join(fixture.root, "missing.md")}`; },
      expected: /cannot read dispatch brief/u,
    },
  ];
  for (const scenario of scenarios) {
    const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
    try {
      scenario.configure?.(fixture);
      scenario.setup(fixture);
      const path = openLane(fixture, scenario.topic);
      scenario.afterOpen?.(fixture);
      const fake = writeFakeHerdr(fixture, {
        lanePath: path,
        branch: `lane/${scenario.topic}`,
        initiallyOpened: true,
      });
      const operand = scenario.operand?.(fixture) ?? "do the work";
      const run = lane(fixture, ["dispatch", scenario.topic, operand], {
        cwd: scenario.fromLane ? path : fixture.repo,
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, scenario.expected);
      assert.deepEqual(fake.calls(), []);
    } finally {
      fixture.cleanup();
    }
  }
  negativeControl("unsafe dispatch registry preflight");
});

test("dispatch checks tracked registry state in the canonical checkout from a lane", () => {
  expectUnsafeDispatchRefusal({
    topic: "canonical-tracked-registry",
    setup(fixture) { ignoreLaneState(fixture); },
    afterOpen(fixture) {
      mkdirSync(join(fixture.repo, ".lane"), { recursive: true });
      writeFileSync(join(fixture.repo, ".lane", "sessions.json"), "[]\n");
      git(fixture.repo, ["add", "-f", ".lane/sessions.json"]);
      git(fixture.repo, ["commit", "-m", "track registry only on main"], { stdio: "ignore" });
    },
    fromLane: true,
    expected: /registry.*tracked/u,
  });
  negativeControl("canonical registry tracked-state preflight");
});

test("dispatch reports repository containment before an external symlink", () => {
  expectUnsafeDispatchRefusal({
    topic: "external-symlink-registry",
    configure(fixture) {
      writeConfig(fixture, { main: "main", validate: "true", registry: ".lane/registry-link/sessions.json" });
    },
    setup(fixture) {
      ignoreLaneState(fixture);
      mkdirSync(join(fixture.repo, ".lane"), { recursive: true });
      const outside = join(fixture.root, "outside-registry");
      mkdirSync(outside);
      symlinkSync(outside, join(fixture.repo, ".lane", "registry-link"));
    },
    expected: /repository-local registry.*configure registry inside/u,
  });
  negativeControl("registry containment before symlink refusal");
});

test("dispatch symlink refusal names the repository-local correction", () => {
  expectUnsafeDispatchRefusal({
    topic: "local-symlink-registry",
    configure(fixture) {
      writeConfig(fixture, { main: "main", validate: "true", registry: ".lane/registry-link/sessions.json" });
    },
    setup(fixture) {
      ignoreLaneState(fixture);
      mkdirSync(join(fixture.repo, ".lane", "real-registry"), { recursive: true });
      symlinkSync(join(fixture.repo, ".lane", "real-registry"), join(fixture.repo, ".lane", "registry-link"));
    },
    expected: /registry path uses a symlink.*replace.*real repository-local path/u,
  });
  negativeControl("registry symlink correction guidance");
});

test("dispatch unwritable-sidecar refusal names both corrections", () => {
  expectUnsafeDispatchRefusal({
    topic: "unwritable-registry",
    setup(fixture) {
      ignoreLaneState(fixture);
      mkdirSync(join(fixture.repo, ".lane"), { recursive: true });
      writeFileSync(join(fixture.repo, ".lane", "sessions.json.d"), "not a directory\n");
    },
    expected: /registry.*writable.*make the sidecar directory writable.*configure another ignored repository-local registry/u,
  });
  negativeControl("registry unwritable correction guidance");
});

test("dispatch writes no record on cwd, start, or prompt failure and reports post-prompt persistence as partial success", async () => {
  const scenarios = [
    { topic: "cwd-failure", options: (fixture) => ({ agentCwd: join(fixture.root, "wrong-cwd") }), expected: /brief NOT sent/u },
    { topic: "start-failure", options: () => ({ startFail: true }), expected: /agent start never succeeded/u },
    { topic: "prompt-failure", options: () => ({ promptFail: true }), expected: /prompt command failed/u },
    {
      topic: "record-failure",
      options: (fixture) => ({ breakRegistry: join(fixture.repo, ".lane", "sessions.json.d") }),
      expected: /partial success.*brief was already sent.*live agent/u,
      promptCount: 1,
    },
    {
      topic: "path-resolution-failure",
      options: (fixture) => ({
        breakRegistryLink: join(fixture.repo, ".lane", "sessions.json.d"),
        danglingTarget: join(fixture.root, "missing-registry-target"),
      }),
      expected: /partial success.*cannot resolve.*live agent/u,
      promptCount: 1,
    },
  ];
  for (const scenario of scenarios) {
    const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
    try {
      ignoreLaneState(fixture);
      const path = openLane(fixture, scenario.topic);
      const fake = writeFakeHerdr(fixture, {
        lanePath: path,
        branch: `lane/${scenario.topic}`,
        initiallyOpened: true,
        ...scenario.options(fixture),
      });
      const run = lane(fixture, ["dispatch", scenario.topic, "deliver this once"]);
      assert.equal(run.status, 1);
      assert.match(run.stderr, scenario.expected);
      const promptCalls = fake.calls().filter((args) => args[0] === "agent" && args[1] === "prompt");
      assert.equal(promptCalls.length, scenario.promptCount ?? (scenario.topic === "prompt-failure" ? 1 : 0));
      const { loadRegistry } = await registryApi();
      if (scenario.topic !== "record-failure") {
        assert.equal(loadRegistry(fixture.repo, { registry: ".lane/sessions.json" }).sessions.length, 0);
      }
      if (scenario.topic === "record-failure") {
        assert.ok(!fake.calls().some((args) => args[0] === "tab" && args[1] === "close"));
      }
    } finally {
      fixture.cleanup();
    }
  }
  negativeControl("honest dispatch failures and no replay");
});

test("independent record writes and simultaneous done markers retain all sessions", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-session-concurrency-test-")));
  const registryPath = join(root, ".lane", "sessions.json");
  const moduleUrl = new URL("../board/registry.mjs", import.meta.url).href;
  const record = (sessionId, topic) => ({
    session_id: sessionId,
    repo_id: join(root, "repo.git"),
    root_id: root,
    repo: join(root, "repo"),
    topic,
    name: `${topic}-agent`,
    workspace: `w-${topic}`,
    pane: `p-${topic}`,
    server: join(root, "herdr.sock"),
    lane: `lane/${topic}`,
    role: "engineer",
    brief: null,
    goal: topic,
    report: `docs/reports/${topic}.md`,
    deadline: null,
    done: false,
    created_at: "2026-09-09T12:00:00.000Z",
  });
  try {
    mkdirSync(dirname(registryPath), { recursive: true });
    const legacy = [{
      name: "legacy-agent", workspace: "legacy-workspace", lane: "legacy",
      role: "agent", report: "legacy.md", deadline: null, done: false,
    }];
    writeFileSync(registryPath, `${JSON.stringify(legacy)}\n`);
    const writeSource = `import { writeSessionRecord } from ${JSON.stringify(moduleUrl)}; writeSessionRecord(process.argv[1], JSON.parse(process.argv[2]));`;
    const records = [record("11111111-1111-4111-8111-111111111111", "alpha"), record("22222222-2222-4222-8222-222222222222", "beta")];
    const writes = await Promise.all(records.map((item) => runRegistryChild(writeSource, [registryPath, JSON.stringify(item)])));
    assert.deepEqual(writes.map((run) => run.status), [0, 0], writes.map((run) => run.stderr).join("\n"));
    const { loadRegistry } = await registryApi();
    let loaded = loadRegistry(root, { registry: registryPath });
    assert.deepEqual(
      loaded.sessions.map((session) => session.name).sort(),
      ["alpha-agent", "beta-agent", "legacy-agent"],
    );
    assert.deepEqual(JSON.parse(readFileSync(registryPath, "utf8")), legacy);

    const doneSource = `import { markSessionDone } from ${JSON.stringify(moduleUrl)}; markSessionDone(process.argv[1], process.argv[2]);`;
    const marks = await Promise.all([...records, records[0]].map((item) => runRegistryChild(doneSource, [registryPath, item.session_id])));
    assert.deepEqual(marks.map((run) => run.status), [0, 0, 0], marks.map((run) => run.stderr).join("\n"));
    loaded = loadRegistry(root, { registry: registryPath });
    assert.ok(loaded.sessions.filter((session) => session.topic).every((session) => session.done));
    assert.equal(loaded.sessions.find((session) => session.name === "legacy-agent").done, false);
    assert.equal(loaded.sessions.length, 3);
    negativeControl("concurrent session records and done markers");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry reads legacy arrays, sidecar records, done markers, and localized malformed entries", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-session-legacy-test-")));
  const registryPath = join(root, ".lane", "sessions.json");
  try {
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, `${JSON.stringify([{
      name: "legacy-agent",
      workspace: "legacy-workspace",
      lane: "legacy-topic",
      role: "reviewer",
      report: "legacy/report.md",
      deadline: null,
      done: false,
      tripwires: ["STOP"],
    }, { name: "broken-entry" }], null, 2)}\n`);
    const { loadRegistry, markSessionDone, writeSessionRecord } = await registryApi();
    const fresh = {
      session_id: "33333333-3333-4333-8333-333333333333",
      repo_id: join(root, "repo.git"), root_id: root, repo: root, topic: "fresh-topic",
      name: "fresh-agent", workspace: "fresh-workspace", pane: "fresh-pane", server: "local",
      lane: "lane/fresh-topic", role: "engineer", brief: null, goal: "Fresh", report: "docs/reports/fresh-topic.md",
      deadline: null, done: false, created_at: "2026-09-09T12:00:00.000Z",
    };
    writeSessionRecord(registryPath, fresh);
    writeFileSync(join(`${registryPath}.d`, "malformed.json"), "{\n");
    let loaded = loadRegistry(root, { registry: registryPath });
    assert.equal(loaded.sessions.length, 2);
    assert.equal(loaded.errors.length, 2);
    const legacy = loaded.sessions.find((session) => session.name === "legacy-agent");
    assert.match(legacy.session_id, /^legacy-[0-9a-f]{64}$/u);
    assert.deepEqual(legacy.tripwires, ["STOP"]);
    markSessionDone(registryPath, legacy.session_id);
    loaded = loadRegistry(root, { registry: registryPath });
    assert.equal(loaded.sessions.find((session) => session.name === "legacy-agent").done, true);
    assert.equal(loaded.sessions.find((session) => session.name === "fresh-agent").done, false);
    negativeControl("legacy and localized registry reads");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session completion refuses unignored and external registry writes", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  const externalRoot = realpathSync(mkdtempSync(join(tmpdir(), "lane-external-registry-test-")));
  const record = (repo, sessionId) => ({
    session_id: sessionId, repo_id: repositoryIdentity(repo), root_id: dirname(repo), repo,
    topic: "board-done", name: "board-agent", workspace: "board-workspace", pane: "board-pane",
    server: "local", lane: "lane/board-done", role: "agent", brief: null, goal: "Board done",
    report: "docs/reports/board-done.md", deadline: null, done: false,
    created_at: "2026-09-09T12:00:00.000Z",
  });
  try {
    const { markSessionDone, writeSessionRecord } = await registryApi();
    const local = join(fixture.repo, ".lane", "sessions.json");
    const first = record(fixture.repo, "44444444-4444-4444-8444-444444444444");
    writeSessionRecord(local, first);
    assert.throws(
      () => markSessionDone(local, first.session_id, { repoRoot: fixture.repo }),
      /registry must be gitignored/u,
    );
    assert.ok(!existsSync(join(`${local}.d`, `${first.session_id}.done.json`)));

    const external = join(externalRoot, "sessions.json");
    const second = record(fixture.repo, "55555555-5555-4555-8555-555555555555");
    writeSessionRecord(external, second);
    assert.throws(
      () => markSessionDone(external, second.session_id, { repoRoot: fixture.repo }),
      /repository-local registry/u,
    );
    assert.ok(!existsSync(join(`${external}.d`, `${second.session_id}.done.json`)));
    negativeControl("board completion registry safety");
  } finally {
    fixture.cleanup();
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("dispatch rejects an unknown route before checking Herdr", () => {
  const fixture = makeFixture({
    main: "main",
    validate: "true",
    routes: {
      unblock: { kind: "claude", model: "planner-model" },
      engineer: { kind: "codex", model: "engineer-model" },
      review: { kind: "claude", model: "review-model" },
    },
  });
  try {
    openLane(fixture, "alpha");
    const run = lane(fixture, ["dispatch", "alpha", "--route", "missing"]);
    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      /lane: unknown route: missing \(configured: engineer, review, unblock\)/,
    );
    assert.doesNotMatch(run.stderr, /herdr is unavailable/);

    writeConfig(fixture, { main: "main", validate: "true" });
    const noneConfigured = lane(fixture, ["dispatch", "alpha", "--route", "missing"]);
    assert.equal(noneConfigured.status, 1);
    assert.match(
      noneConfigured.stderr,
      /lane: unknown route: missing \(none configured\)/,
    );
    assert.doesNotMatch(noneConfigured.stderr, /herdr is unavailable/);
    negativeControl("unknown dispatch route");
  } finally {
    fixture.cleanup();
  }
});

test("review archival refuses an occupied destination and retains delivered evidence", () => {
  const topic = 'review-archive-collision';
  const review = makeReviewFixture(topic, { verdict: 'PASS', mode: 'archive-collision' });
  try {
    const head = git(review.path, ['rev-parse', 'HEAD']);
    const run = lane(review.fixture, ['review', topic, '--round', '1', '--brief', review.brief]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /private review output already exists/);
    const archive = join(review.fixture.repo, '.lane', 'reviews', topic, `${head.slice(0, 7)}-r1.md`);
    assert.equal(readFileSync(archive, 'utf8'), 'concurrent archive sentinel\n');
    assert.match(readFileSync(privateReviewDelivery(review), 'utf8'), /^\*\*PASS\*\*/u);
    assert.ok(!existsSync(join(review.path, 'docs', 'reviews', topic, `${head.slice(0, 7)}-r1.md`)));
  } finally { review.fixture.cleanup(); }
});

test("review archival preserves accepted raw UTF-8 bytes", () => {
  const topic = 'review-raw-utf8';
  const review = makeReviewFixture(topic, { verdict: 'PASS', mode: 'utf8-bom' });
  try {
    const head = git(review.path, ['rev-parse', 'HEAD']);
    const run = lane(review.fixture, ['review', topic, '--round', '1', '--brief', review.brief]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'PASS\n');
    const archived = readFileSync(join(review.fixture.repo, '.lane', 'reviews', topic, `${head.slice(0, 7)}-r1.md`));
    assert.deepEqual([...archived.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.match(archived.toString('utf8'), /## Analysis\nFixture review evidence/);
    assert.equal(existsSync(privateReviewDelivery(review)), false);
  } finally { review.fixture.cleanup(); }
});

test("review timeout retains late delivery and reserves the round before the file arrives", async () => {
  const topic = 'review-late-delivery';
  const review = makeReviewFixture(topic, { verdict: 'PASS', mode: 'late-complete' });
  try {
    const head = git(review.path, ['rev-parse', 'HEAD']);
    const first = lane(review.fixture, ['review', topic, '--round', '1', '--brief', review.brief, '--timeout', '3']);
    assert.equal(first.status, 2, first.stderr);
    assert.equal(first.stdout, '');
    assert.match(first.stderr, /may still write late evidence/);
    const delivery = privateReviewDelivery(review);
    assert.ok(first.stderr.includes(delivery));
    const prompts = () => review.fake.calls().filter(args => args[0] === 'agent' && args[1] === 'prompt');
    const repeat = lane(review.fixture, ['review', topic, '--round', '1', '--brief', review.brief]);
    assert.equal(repeat.status, 2, repeat.stderr);
    assert.match(repeat.stderr, /private review delivery directory already exists/);
    assert.equal(prompts().length, 1);
    await waitForCondition(() => existsSync(delivery) && readFileSync(delivery, 'utf8').includes('<!-- lane-review-complete -->'),
      'late review delivery', 8000);
    const late = readFileSync(delivery, 'utf8');
    assert.equal(git(review.path, ['status', '--porcelain']), '', 'late delivery stays private and ignored');
    assert.ok(!existsSync(join(review.fixture.repo, '.lane', 'reviews', topic, `${head.slice(0, 7)}-r1.md`)));
    delete review.fixture.env.FAKE_REVIEW_MODE;
    const second = lane(review.fixture, ['review', topic, '--round', '2', '--brief', review.brief]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, 'PASS\n');
    assert.equal(readFileSync(delivery, 'utf8'), late, 'later round leaves late evidence intact');
    assert.match(readFileSync(join(review.fixture.repo, '.lane', 'reviews', topic, `${head.slice(0, 7)}-r2.md`), 'utf8'), /^Round: 2$/mu);
    assert.equal(prompts().length, 2);
  } finally { review.fixture.cleanup(); }
});

test("review preflight refuses a redirected delivery directory before dispatch", () => {
  const topic = 'review-delivery-symlink';
  const review = makeReviewFixture(topic, { verdict: 'PASS' });
  try {
    const outside = join(review.fixture.root, 'outside-delivery');
    mkdirSync(outside);
    // Ignore this fixture's symlink to reach the delivery preflight rather than
    // the ordinary clean-tree check. This is not a product ignore mutation.
    writeFileSync(join(review.path, '.gitignore'), '.lane/\n.ready.marker\n.lane-review-*\n');
    git(review.path, ['add', '.gitignore']); git(review.path, ['commit', '-qm', 'Ignore delivery fixture']);
    const currentHead = git(review.path, ['rev-parse', 'HEAD']);
    symlinkSync(outside, join(review.path, `.lane-review-${currentHead}-r1`));
    const run = lane(review.fixture, ['review', topic, '--round', '1', '--brief', review.brief]);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /private review delivery directory already exists/);
    assert.equal(review.fake.calls().filter(args => args[0] === 'agent' && args[1] === 'prompt').length, 0);
    assert.ok(!existsSync(join(outside, 'record.md')));
  } finally { review.fixture.cleanup(); }
});

test("review preflight preserves abbreviation collision safety for pending delivery", () => {
  const topic = 'review-delivery-prefix';
  const review = makeReviewFixture(topic, { verdict: 'PASS' });
  try {
    const head = git(review.path, ['rev-parse', 'HEAD']);
    const other = head.slice(0, 7) + (head.endsWith('0'.repeat(33)) ? '1' : '0').repeat(33);
    const pending = join(review.path, `.lane-review-${other}-r4`);
    mkdirSync(pending);
    writeFileSync(join(pending, '.gitignore'), '*\n');
    const run = lane(review.fixture, ['review', topic, '--round', '1', '--brief', review.brief]);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /review abbreviation .* is ambiguous with an existing delivery/);
    assert.equal(review.fake.calls().filter(args => args[0] === 'agent' && args[1] === 'prompt').length, 0);
    assert.equal(readFileSync(join(pending, '.gitignore'), 'utf8'), '*\n');
  } finally { review.fixture.cleanup(); }
});

test("review requires explicit source, round, route, and bounded unique flags with exit 2", () => {
  const { fixture, brief } = makeReviewFixture("review-flags");
  try {
    const cases = [
      ["review-flags", "--brief", brief],
      ["review-flags", "--round", "1"],
      ["review-flags", "--round", "0", "--brief", brief],
      ["review-flags", "--round", "1", "--brief", brief, "--timeout", "0"],
      ["review-flags", "--round", "1", "--brief", brief, "--route", "missing"],
      ["review-flags", "--round", "1", "--round", "2", "--brief", brief],
      ["review-flags", "--round", "1", "--brief", brief, "--unknown", "value"],
      ["review-flags", "--round", "1", "--brief", brief, "--run", "invalid"],
      ["review-flags", "--round", "1", "--brief", brief, "--run"],
      ["review-flags", "--round", "1", "--brief", brief, "--run", "R-1", "--run", "R-2"],
    ];
    for (const args of cases) {
      const run = lane(fixture, ["review", ...args]);
      assert.equal(run.status, 2, `${args.join(" ")}\n${run.stderr}`);
      assert.equal(run.stdout, "");
    }
    for (const timeout of ["1", "2"]) {
      const run = lane(fixture, [
        "review", "review-flags", "--round", "1", "--brief", brief, "--timeout", timeout,
      ]);
      assert.equal(run.status, 2, run.stderr);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /--timeout must be an integer from 3 through 7200 seconds/);
    }
    negativeControl("review flag refusals use exit 2");
  } finally {
    fixture.cleanup();
  }
});

for (const reads of ['0', '3']) test(`review binds a fresh Codex session after ${reads} observations and the planner releases it`, async () => {
  const topic = `review-fresh-session-${reads}`, review = makeReviewFixture(topic, { verdict: 'PASS' });
  const { fixture } = review;
  try {
    const org = join(fixture.root, 'record'); mkdirSync(org);
    fixture.env.ORG_DIR = org;
    // Keep the real PID/birth for callback liveness; the native tree is scripted.
    fixture.env.FAKE_RETIREMENT_OWNER = JSON.stringify({ ...ownerProcess(process.pid), command: '[codex]', ppid: 123456789 });
    fixture.env.FAKE_HERDR_SESSION_AFTER_PROMPT_READS = reads;
    fixture.env.FAKE_HERDR_SESSION_DETAIL_ONLY = '1';
    const events = [
      { type: 'item.added', id: 'ENG-1', role: 'engineer', kind: 'work' },
      { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: review.path, meta: {} },
      { type: 'report.ingested', run: 'R-1', report: { outcome: 'done' } },
    ].map((event, index) => ({ ...event, seq: index + 1, at: '2026-01-01T00:00:00Z', by: 'fixture' }));
    writeFileSync(join(org, 'events.jsonl'), events.map(event => JSON.stringify(event) + '\n').join(''));
    const run = lane(fixture, ['review', topic, '--round', '1', '--brief', review.brief, '--run', 'R-1']);
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout, 'PASS\n');
    assert.doesNotMatch(run.stderr, /warning:/);
    assert.equal(review.fake.state().receiptBeforePrompt, false);
    assert.ok(review.fake.state().sessionReads >= Math.max(1, Number(reads)));
    assert.equal(review.fake.calls().filter(args => args[0] === 'agent' && args[1] === 'prompt').length, 1);
    const { loadRegistry } = await registryApi();
    const [launch] = loadRegistry(fixture.repo).sessions;
    assert.equal(launch.harness, 'codex');
    assert.equal(launch.agent_session_id, 'fixture-session-1');
    assert.equal(launch.terminal_id, 'fixture-terminal-1');
    git(review.path, ['add', 'docs/reviews']); git(review.path, ['commit', '-m', 'Record fixture review']);
    const runtime = createRetirement({ cwd: fixture.repo, org, env: fixture.env, herdr: join(fixture.bin, 'herdr') });
    const snapshot = runtime.observe(); // readReviewVerdicts reads the actual recorded verdict.
    assert.equal(snapshot.reviewVerdicts.length, 1);
    assert.equal(snapshot.reviewVerdicts[0].session, launch.agent_session_id);
    assert.equal(snapshot.callbacks[0].agent_session_id, launch.agent_session_id);
    const plan = planRetirement(snapshot);
    assert.equal(plan.sessionReleases?.length, 1, JSON.stringify(plan));
    assert.equal(plan.sessionReleases[0].release.session, launch.agent_session_id);
    assert.equal(plan.sessionReleases[0].release.terminal, launch.terminal_id);
    assert.equal(plan.sessionReleases[0].release.recipient, 'reviewer');
    for (const mismatch of ['session', 'terminal']) {
      const changed = structuredClone(snapshot);
      if (mismatch === 'session') changed.agents[0].agent_session.value = 'replacement';
      else changed.agents[0].terminal_id = 'replacement';
      assert.equal(planRetirement(changed).sessionReleases?.length ?? 0, 0, mismatch);
    }
  } finally { fixture.cleanup(); }
});

test('review without a native session warns once and preserves the successful verdict', async () => {
  const topic = 'review-no-native-session', review = makeReviewFixture(topic, { verdict: 'PASS' });
  const { fixture } = review;
  try {
    fixture.env.FAKE_HERDR_SESSION_AFTER_PROMPT_READS = 'never';
    fixture.env.FAKE_HERDR_SESSION_DETAIL_ONLY = '1';
    const started = Date.now();
    const run = lane(fixture, ['review', topic, '--round', '1', '--brief', review.brief, '--timeout', '8']);
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout, 'PASS\n');
    assert.equal((run.stderr.match(/lane review: warning:/g) ?? []).length, 1);
    assert.match(run.stderr, /native session was not established.*tab retained/);
    assert.ok(Date.now() - started < 10000, 'session observation shares the review deadline');
    assert.ok(review.fake.state().sessionReads > 1, 'the missing session was polled');
    const { loadRegistry } = await registryApi();
    const [launch] = loadRegistry(fixture.repo).sessions;
    assert.equal(launch.agent_session_id, undefined);
    assert.equal(launch.terminal_id, 'fixture-terminal-1');
    assert.equal(review.fake.calls().some(args => args[1] === 'close'), false);
  } finally { fixture.cleanup(); }
});

for (const [key, value] of Object.entries({ name: 'replacement', pane_id: 'w-lane:other',
  workspace_id: 'other-workspace', cwd: '/other-cwd', terminal_id: 'other-terminal' })) {
  test(`review refuses a changed ${key} while observing a fresh session`, async () => {
    const topic = `review-session-${key}`, review = makeReviewFixture(topic, { verdict: 'PASS' });
    const { fixture } = review;
    try {
      fixture.env.FAKE_HERDR_SESSION_AFTER_PROMPT_READS = '2';
      fixture.env.FAKE_HERDR_SESSION_DETAIL_ONLY = '1';
      fixture.env.FAKE_HERDR_CHANGE_SESSION_OBSERVATION = JSON.stringify({ [key]: value });
      const run = lane(fixture, ['review', topic, '--round', '1', '--brief', review.brief]);
      assert.equal(run.status, 2, run.stderr);
      assert.match(run.stderr, /native agent detail identity changed/);
      const { loadRegistry } = await registryApi();
      assert.deepEqual(loadRegistry(fixture.repo).sessions, []);
      assert.equal(review.fake.calls().filter(args => args[0] === 'agent' && args[1] === 'prompt').length, 1);
      assert.equal(review.fake.calls().some(args => args[1] === 'close'), false);
    } finally { fixture.cleanup(); }
  });
}

test("review records one native launch identity before delivery and the planner recognises it", () => {
  const review = makeReviewFixture('review-occupant', { verdict: 'PASS' });
  const { fixture } = review;
  try {
    const org = join(fixture.root, 'record');
    mkdirSync(org);
    fixture.env.ORG_DIR = org;
    fixture.env.FAKE_RETIREMENT_OWNER = JSON.stringify(ownerProcess(process.pid));
    const events = [
      { type: 'item.added', id: 'ENG-1', role: 'engineer', kind: 'work' },
      { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: review.path, meta: {} },
      { type: 'report.ingested', run: 'R-1', report: { outcome: 'done' } },
      { type: 'item.closed', id: 'ENG-1', as: 'done' },
    ].map((event, index) => ({ ...event, seq: index + 1, at: '2026-01-01T00:00:00Z', by: 'fixture' }));
    const eventFile = join(org, 'events.jsonl'), eventBytes = events.map(event => JSON.stringify(event) + '\n').join('');
    writeFileSync(eventFile, eventBytes);
    const reviewedHead = git(review.path, ['rev-parse', 'HEAD']);
    const run = lane(fixture, ['review', 'review-occupant', '--round', '1', '--brief', review.brief, '--run', 'R-1']);
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout, 'PASS\n');
    assert.doesNotMatch(run.stderr, /launch identity could not be recorded/);
    assert.equal(review.fake.state().receiptBeforePrompt, true);
    const directory = join(org, 'retirement/occupants'), files = readdirSync(directory);
    assert.equal(files.length, 1);
    const receipt = JSON.parse(readFileSync(join(directory, files[0]), 'utf8'));
    const agent = review.fake.calls().find(args => args[0] === 'agent' && args[1] === 'start')[2];
    assert.deepEqual(receipt, { schema: 'retirement-occupant/v1', kind: 'settle',
      common: repositoryIdentity(fixture.repo), cwd: review.path, workspace: 'w-lane', tab: 'w-lane:t2', pane: 'w-lane:p2',
      shell: { pid: 123456789, identity: 'fixture-shell', command: '[zsh]' },
      process: { pid: process.pid, identity: ownerProcess(process.pid).identity, command: ownerProcess(process.pid).command },
      run: 'R-1', agent, terminal_id: 'fixture-terminal-1', agent_session_id: 'fixture-session-1' });
    const runtime = createRetirement({ cwd: fixture.repo, org, env: fixture.env, herdr: join(fixture.bin, 'herdr') });
    const snapshot = runtime.observe();
    assert.equal(snapshot.reviewVerdicts.length, 1);
    const [verdict] = snapshot.reviewVerdicts;
    const evidence = join(review.path, 'docs/reviews/review-occupant', `${reviewedHead.slice(0, 7)}-r1.md`);
    assert.deepEqual({ run: verdict.run, verdict: verdict.verdict, head: verdict.head,
      evidence: verdict.evidence, sha256: verdict.sha256 }, {
      run: 'R-1', verdict: 'PASS', head: reviewedHead, evidence,
      sha256: createHash('sha256').update(readFileSync(evidence)).digest('hex'),
    });
    assert.match(planRetirement({ ...snapshot, callbacks: [] }).keep[0].why, /unknown or mismatched recorded launch identity/);
    assert.equal(planRetirement(snapshot).keep[0].why, 'recorded callback process is still live or unknown');
    // An exited review on a clean, integrated terminal chain is recognised by
    // the unchanged planner. Exiting/closing a native agent is a separate slice.
    git(review.path, ['add', 'docs/reviews']); git(review.path, ['commit', '-m', 'Record fixture review']);
    git(fixture.repo, ['merge', '--ff-only', 'lane/review-occupant']);
    const finished = runtime.observe();
    finished.agents = []; finished.callbacks[0].process_gone = true;
    const pane = finished.panes[0], shell = pane.process_info.process_tree[0];
    pane.shellOnly = true;
    pane.process_info = { shell_pid: shell.pid, foreground_processes: [{ pid: shell.pid, name: 'zsh' }],
      process_tree_complete: true, process_tree: [shell] };
    assert.equal(planRetirement(finished).close[0].why, 'recorded settle callback complete; unchanged process and shell identity');
    // The fixture deliberately reuses the same tab. The existing live-owner
    // rule must preserve the first receipt, while review itself still succeeds.
    const bytes = readFileSync(join(directory, files[0]), 'utf8');
    const second = lane(fixture, ['review', 'review-occupant', '--round', '2', '--brief', review.brief, '--run', 'R-1']);
    assert.equal(second.status, 0, second.stderr); assert.equal(second.stdout, 'PASS\n');
    assert.equal((second.stderr.match(/lane review: warning: launch identity could not be recorded/g) ?? []).length, 1);
    assert.match(second.stderr, /receipt belongs to a live process/);
    assert.equal(readFileSync(join(directory, files[0]), 'utf8'), bytes);
    const after = readFileSync(eventFile, 'utf8');
    assert.equal(after.slice(0, eventBytes.length), eventBytes);
    const appended = after.slice(eventBytes.length).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(appended.length, 1);
    assert.ok(Number.isFinite(Date.parse(appended[0].at)));
    assert.deepEqual(appended, [{ seq: events.length + 1, at: appended[0].at, by: 'lane review',
      type: 'review.verdict', common: repositoryIdentity(fixture.repo), run: 'R-1', item: 'ENG-1',
      head: reviewedHead, review: verdict }]);
    assert.equal(review.fake.calls().some(args => ['close', 'send-keys'].includes(args[1])), false);
  } finally { fixture.cleanup(); }
});

test("review recording failure warns once and preserves verdicts and review artifacts", () => {
  for (const [verdict, status] of [['PASS', 0], ['NEEDS-WORK', 1]]) {
    const topic = `review-record-failure-${status}`, review = makeReviewFixture(topic, { verdict });
    const { fixture } = review;
    try {
      fixture.env.ORG_DIR = join(fixture.root, 'record');
      fixture.env.FAKE_RETIREMENT_OWNER = JSON.stringify(ownerProcess(process.pid));
      const parent = join(fixture.env.ORG_DIR, 'retirement'); mkdirSync(parent, { recursive: true });
      writeFileSync(join(parent, 'occupants'), 'occupied by fixture');
      const run = lane(fixture, ['review', topic, '--round', '1', '--brief', review.brief, '--run', 'R-1']);
      assert.equal(run.status, status, run.stderr); assert.equal(run.stdout, `${verdict}\n`);
      assert.equal((run.stderr.match(/lane review: warning: launch identity could not be recorded/g) ?? []).length, 1);
      assert.match(run.stderr, /tab retained/);
      const head = git(review.path, ['rev-parse', 'HEAD']).slice(0, 7);
      assert.equal(parseVerdict(readFileSync(join(review.path, 'docs/reviews', topic, `${head}-r1.md`), 'utf8')), verdict);
      assert.ok(existsSync(join(fixture.repo, '.lane/reviews', topic, `${head}-r1.md`)));
      assert.equal(review.fake.calls().some(args => args[1] === 'close'), false);
    } finally { fixture.cleanup(); }
  }
});

test("review recording deadline interrupts a stalled observation and preserves the review", async t => {
  const topic = 'review-record-deadline', review = makeReviewFixture(topic, { verdict: 'PASS' });
  const { fixture } = review;
  try {
    fixture.env.ORG_DIR = join(fixture.root, 'record'); mkdirSync(fixture.env.ORG_DIR);
    writeFileSync(join(fixture.env.ORG_DIR, 'events.jsonl'), '');
    fixture.env.FAKE_RETIREMENT_OWNER = JSON.stringify(ownerProcess(process.pid));
    fixture.env.FAKE_RETIREMENT_OBSERVE_DELAY_MS = '6000';
    // Each observation command is below its ordinary ten-second allowance;
    // their combined twelve seconds must hit the recording's own deadline.
    const child = spawnScenarioChild(t, process.execPath, [LANE, 'review', topic, '--round', '1',
      '--brief', review.brief, '--run', 'R-1', '--timeout', '45'], {
      cwd: fixture.repo, env: hermeticGitEnvironment(fixture.env),
    }, 35000);
    const run = await waitForExit(child);
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout, 'PASS\n');
    assert.equal((run.stderr.match(/lane review: warning: launch identity could not be recorded/g) ?? []).length, 1);
    assert.match(run.stderr, /deadline.*tab retained/);
    assert.deepEqual(review.fake.state().retirementStalls, ['workspace', 'tab']);
    assert.deepEqual(review.fake.state().retirementStallsCompleted, ['workspace']);
    const directory = join(fixture.env.ORG_DIR, 'retirement/occupants');
    assert.deepEqual(existsSync(directory) ? readdirSync(directory) : [], []);
    assert.equal(review.fake.state().receiptBeforePrompt, false);
    assert.equal(review.fake.calls().filter(args => args[0] === 'agent' && args[1] === 'prompt').length, 1);
    const head = git(review.path, ['rev-parse', 'HEAD']).slice(0, 7);
    assert.equal(parseVerdict(readFileSync(join(review.path, 'docs/reviews', topic, `${head}-r1.md`), 'utf8')), 'PASS');
    assert.ok(existsSync(join(fixture.repo, '.lane/reviews', topic, `${head}-r1.md`)));
    assert.equal(review.fake.calls().some(args => args[1] === 'close'), false);
  } finally { fixture.cleanup(); }
});

test("review dispatches once and publishes all canonical verdicts after private validation", () => {
  const cases = [["PASS", 0], ["NEEDS-WORK", 1], ["FAIL", 1]];
  const fixtures = [];
  try {
    for (const [verdict, exit] of cases) {
      const topic = `review-${verdict.toLowerCase()}`;
      const review = makeReviewFixture(topic, { verdict });
      fixtures.push(review.fixture);
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      assert.equal(run.status, exit, run.stderr);
      assert.equal(run.stdout, `${verdict}\n`);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      const privatePath = join(review.fixture.repo, ".lane", "reviews", topic, `${head.slice(0, 7)}-r1.md`);
      const publicPath = join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`);
      assert.ok(existsSync(privatePath));
      assert.ok(existsSync(publicPath));
      assert.equal(parseVerdict(readFileSync(publicPath, "utf8")), verdict);
      assert.match(run.stderr, new RegExp(`public review: ${publicPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.equal(review.fake.calls().filter((args) => args[0] === "agent" && args[1] === "prompt").length, 1);
    }
    negativeControl("canonical private verdict outcomes");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review accepts a routing snapshot without replacing project lifecycle configuration", () => {
  const review = makeReviewFixture("review-route-config", { verdict: "PASS" });
  review.fixture.env.ORG_ACTOR = "lane-review-route-config-test";
  try {
    writeFileSync(join(review.fixture.root, "review-routes.json"), JSON.stringify({
      main: "not-the-project-base",
      validate: "false",
      worktree_root: "not-the-project-worktrees",
      routes: { pinned: { kind: "codex", model: "pinned-review-model" } },
    }));
    const run = lane(review.fixture, [
      "review", "review-route-config", "--round", "1", "--brief", review.brief,
      "--route", "pinned", "--route-config", "../review-routes.json", "--timeout", "12",
    ]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "PASS\n");
    const starts = review.fake.calls().filter((args) => args[0] === "agent" && args[1] === "start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0][starts[0].indexOf("--model") + 1], "pinned-review-model");
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const record = readFileSync(join(review.path, "docs", "reviews", "review-route-config", `${head.slice(0, 7)}-r1.md`), "utf8");
    assert.match(record, /^Base branch: main$/m);
  } finally {
    review.fixture.cleanup();
  }
});

test("review settles a completed private record before validating its final bytes", () => {
  const review = makeReviewFixture("review-settle", { verdict: "PASS", mode: "rewrite-complete" });
  try {
    const started = Date.now();
    const run = lane(review.fixture, [
      "review", "review-settle", "--round", "1", "--brief", review.brief, "--timeout", "5",
    ]);
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stdout, "NEEDS-WORK\n");
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-settle", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.equal(parseVerdict(publicRecord), "NEEDS-WORK");
    assert.match(publicRecord, /Rewritten reviewer behavior was not exercised/);
    const archived = readFileSync(join(
      review.fixture.repo, '.lane', 'reviews', 'review-settle', `${head.slice(0, 7)}-r1.md`,
    ), 'utf8');
    assert.equal(parseVerdict(archived), 'NEEDS-WORK');
    assert.match(archived, /Rewritten reviewer behavior was not exercised/);
    assert.equal(existsSync(privateReviewDelivery(review)), false);
    assert.ok(Date.now() - started >= 2_300, "review returned before the rewritten record settled");
    negativeControl("completed private record settle window");
  } finally {
    review.fixture.cleanup();
  }
});

test('hook-pull opt-in adds per-session settings to Claude worker and reviewer launches; disabled argv stays identical', () => {
  for (const enabled of [undefined, false, true]) {
    const fixture = makeFixture({ main: 'main', validate: 'true', registry: '.lane/sessions.json',
      routes: { engineer: { kind: 'claude', model: 'worker-model', effort: 'high', env: ['ORG_ACTOR=fixture-worker'] } } });
    try {
      ignoreLaneState(fixture);
      const path = openLane(fixture, 'hook-pull');
      if (enabled !== undefined) writeFileSync(join(fixture.repo, '.hook-pull.json'), JSON.stringify({ enabled }));
      fixture.env.HERDR_SOCKET_PATH = join(fixture.root, 'herdr.sock');
      const fake = writeFakeHerdr(fixture, { lanePath: path, branch: 'lane/hook-pull', initiallyOpened: true });
      const result = lane(fixture, ['dispatch', 'hook-pull', '--route', 'engineer']);
      assert.equal(result.status, 0, result.stderr);
      const start = fake.calls().find(a => a[0] === 'agent' && a[1] === 'start');
      const native = start.slice(start.indexOf('--') + 1), previous = ['--model', 'worker-model', '--effort', 'high'];
      assert.deepEqual(enabled ? native.slice(0, -2) : native, previous);
      if (enabled) {
        assert.equal(native.at(-2), '--settings');
        const settings = JSON.parse(readFileSync(native.at(-1), 'utf8'));
        assert.match(settings.hooks.Stop[0].hooks[0].command, /messages\/hook-pull.mjs/);
        assert.ok(native.at(-1).startsWith(join(repositoryIdentity(fixture.repo), 'sessions/hook-pull/')));
        const descriptor = JSON.parse(readFileSync(join(dirname(native.at(-1)), 'session.json'), 'utf8'));
        assert.equal(descriptor.address.identity, 'fixture-worker');
      }
    } finally { fixture.cleanup(); }
  }
});

test('hook-pull Claude reviewer uses the same opt-in launch owner', () => {
  const review = makeReviewFixture('hook-pull-review', { verdict: 'PASS' });
  try {
    writeFileSync(join(review.fixture.repo, '.hook-pull.json'), '{"enabled":true}\n');
    const result = lane(review.fixture, ['review', 'hook-pull-review', '--round', '1', '--route', 'alternate', '--brief', review.brief]);
    assert.equal(result.status, 0, result.stderr);
    const start = review.fake.calls().find(a => a[0] === 'agent' && a[1] === 'start');
    const settings = start[start.indexOf('--settings') + 1];
    const descriptor = JSON.parse(readFileSync(join(dirname(settings), 'session.json'), 'utf8'));
    assert.equal(descriptor.role, 'reviewer');
    assert.equal(descriptor.humanTyped, false);
  } finally { review.fixture.cleanup(); }
});

test('invalid enabled hook config is refused before creating a dispatch workspace or tab', () => {
  const fixture = makeFixture({ main: 'main', validate: 'true', registry: '.lane/sessions.json' });
  try {
    ignoreLaneState(fixture); const path = openLane(fixture, 'hook-invalid');
    writeFileSync(join(fixture.repo, '.hook-pull.json'), '{"enabled":true,"rendering":"invalid"}');
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: 'lane/hook-invalid', initiallyOpened: false });
    const result = lane(fixture, ['dispatch', 'hook-invalid']);
    assert.equal(result.status, 1); assert.match(result.stderr, /invalid hook-pull project config/);
    assert.equal(fake.calls().some(a => ['workspace', 'tab'].includes(a[0]) && a[1] === 'create'), false);
    assert.equal(fake.calls().some(a => a[0] === 'agent' && a[1] === 'start'), false);
    assert.equal(existsSync(join(fixture.root, 'herdr-state.json')), false);
  } finally { fixture.cleanup(); }
});
