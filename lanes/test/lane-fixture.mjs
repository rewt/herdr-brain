// Shared fixture setup for the split lane CLI tests; no test cases register here.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { currentTest } from '../../test/helpers/bounded-test.mjs';
import { healthyMemoryEnvironment } from '../../test/helpers/promotion-memory-fixture.mjs';
import { repositorySeed } from '../../test/helpers/git-seed.mjs';

import { loadTimeout } from '../../lib/deadline.mjs';
import { spawnChild, spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { SCRIPT, PTY_SKIP_REASON } from '../../test/helpers/pty.mjs';
import { INHERITED_GATE_NON_CLAIM } from '../review-evidence.mjs';
import { createRetirement } from '../../lib/retire-runtime.mjs';
import { planRetirement } from '../../lib/retire.mjs';
import { ownerProcess } from '../../lib/process-owner.mjs';
import { initialShellFile } from '../../lib/initial-shell.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { scratchEnvironment, assertCloseScratch } from '../../test/helpers/scratch-fixture.mjs';
// Bounded evidence polling avoids the shared host's exhausted FSEvents pool.
async function waitForFile(file, predicate = () => true, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + loadTimeout(timeoutMs);
  for (;;) {
    let text; try { text = readFileSync(file, 'utf8'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
    if(text !== undefined && predicate(text)) return text || true;
    if(Date.now() >= deadline) throw Error(`timed out waiting for ${file}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE = resolve(process.env.LANE_TEST_CLI ?? join(HERE, "..", "lane.mjs"));
const HERDR_CLIENT = resolve(HERE, "..", "board", "herdr-client.mjs");
const GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const HEAD = execFileSync("/bin/sh", ["-c", "command -v head"], { encoding: "utf8" }).trim();
const NEGATIVE_CONTROL = process.env.LANE_TEST_NEGATIVE_CONTROL === "1";
const parseVerdict = (text) => text.match(/^\*\*(PASS|NEEDS-WORK|FAIL)\*\*/u)?.[1];
const HERMETIC_GIT_ENV = "HERDR_LANES_TEST_HERMETIC_GIT_ENV";
const OPERATOR_GIT_ENV_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "herdr-lanes-operator-git-env-test-")));
const OPERATOR_HOME = join(OPERATOR_GIT_ENV_ROOT, "home");
const OPERATOR_XDG_CONFIG_HOME = join(OPERATOR_GIT_ENV_ROOT, "xdg");
mkdirSync(join(OPERATOR_XDG_CONFIG_HOME, "git"), { recursive: true });
writeFileSync(join(OPERATOR_XDG_CONFIG_HOME, "git", "ignore"), ".lane/\n");
const OPERATOR_GIT_ENV = {
  ...process.env,
  HOME: OPERATOR_HOME,
  XDG_CONFIG_HOME: OPERATOR_XDG_CONFIG_HOME,
};
for (const key of Object.keys(OPERATOR_GIT_ENV)) {
  if (key === "GIT_CONFIG" || key.startsWith("GIT_CONFIG_")) delete OPERATOR_GIT_ENV[key];
}
delete OPERATOR_GIT_ENV[HERMETIC_GIT_ENV];
OPERATOR_GIT_ENV.GIT_CONFIG_NOSYSTEM = "1";
const GIT_ENV_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "herdr-lanes-git-env-test-")));
const GIT_HOME = join(GIT_ENV_ROOT, "home");
const GIT_XDG_CONFIG_HOME = join(GIT_ENV_ROOT, "xdg");
const GIT_GLOBAL_CONFIG = join(GIT_ENV_ROOT, "global.gitconfig");
mkdirSync(GIT_HOME);
mkdirSync(GIT_XDG_CONFIG_HOME);
writeFileSync(GIT_GLOBAL_CONFIG, "[user]\n\tname = Lane Tests\n\temail = lane-tests@example.invalid\n");
test.after(() => {
  rmSync(OPERATOR_GIT_ENV_ROOT, { recursive: true, force: true });
  rmSync(GIT_ENV_ROOT, { recursive: true, force: true });
});

function negativeControl(name) {
  if (NEGATIVE_CONTROL) assert.fail(`deliberately broken expectation: ${name}`);
}

function hermeticGitEnvironment(source = OPERATOR_GIT_ENV) {
  const env = { ...source };
  const preserveTestHome = env[HERMETIC_GIT_ENV] === "1";
  for (const key of Object.keys(env)) {
    if (key === "GIT_CONFIG" || key.startsWith("GIT_CONFIG_") ||
        key.startsWith("GIT_AUTHOR_") || key.startsWith("GIT_COMMITTER_") || key === "EMAIL") {
      delete env[key];
    }
  }
  if (!preserveTestHome) {
    env.HOME = GIT_HOME;
    env.XDG_CONFIG_HOME = GIT_XDG_CONFIG_HOME;
  }
  env.GIT_CONFIG_GLOBAL = GIT_GLOBAL_CONFIG;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env[HERMETIC_GIT_ENV] = "1";
  return env;
}

const TEST_PROCESS_ENV = hermeticGitEnvironment();
for (const key of Object.keys(process.env)) {
  if (!(key in TEST_PROCESS_ENV)) delete process.env[key];
}
Object.assign(process.env, TEST_PROCESS_ENV);

function gitExec(args, options = {}) {
  const { env = process.env, ...rest } = options;
  return execFileSync(GIT, args, { ...rest, env: hermeticGitEnvironment(env) });
}

function git(cwd, args, options = {}) {
  const output = gitExec(["-C", cwd, ...args], {
    encoding: "utf8",
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

const copyInitialRepository = repositorySeed(GIT_ENV_ROOT, repo => {
  gitExec(['init', '-b', 'main', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'shared.txt'), 'base\n');
  git(repo, ['add', 'shared.txt']);
  git(repo, ['commit', '-m', 'initial'], { stdio: 'ignore' });
});

function makeFixture(config = { main: "main", validate: "true" }, { repoParts = ["repo"] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-lanes-test-")));
  const repo = join(root, ...repoParts);
  const worktrees = join(root, "worktrees");
  const configPath = join(root, "lane.json");
  const bin = join(root, "bin");
  mkdirSync(dirname(repo), { recursive: true });
  copyInitialRepository(repo);
  mkdirSync(bin);
  symlinkSync(GIT, join(bin, "git"));
  symlinkSync(HEAD, join(bin, "head"));

  const fixture = {
    root,
    repo,
    worktrees,
    configPath,
    bin,
    env: {
      ...healthyMemoryEnvironment(hermeticGitEnvironment()),
      ...scratchEnvironment(root),
      PATH: bin,
      LANE_CONFIG: configPath,
      LANE_WORKTREE_ROOT: worktrees,
      SHELL: "/bin/zsh",
      ORG_DIR: "",
      MONITOR_TEST_SLOT_PATH: join(root, "retire-slot"),
      MONITOR_TEST_SLOT_COMPAT_PATH: join(root, "retire-slot"),
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  writeConfig(fixture, config);
  return fixture;
}

function writeConfig(fixture, config) {
  writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function lane(fixture, args, options = {}) {
  // Git-only close fixtures explicitly prove an empty Herdr inventory. A
  // missing/unreadable live source now keeps the lane under the shared rule.
  const reader = join(fixture.bin, 'herdr');
  if (args[0] === 'close' && !existsSync(reader)) {
    writeFileSync(reader, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[1]==='list')console.log(JSON.stringify({result:{workspaces:[],agents:[],tabs:[],panes:[]}}));else process.exit(1);\n`);
    chmodSync(reader, 0o755);
  }
  const result = spawnSync(process.execPath, [options.executable ?? LANE, ...args], {
    cwd: options.cwd ?? fixture.repo,
    env: hermeticGitEnvironment(options.env ?? fixture.env),
    encoding: "utf8",
  });
  if (args[0] === 'close') assertCloseScratch(result, options.env ?? fixture.env);
  return result;
}

function laneProcess(fixture, args, options = {}) {
  const child = spawnChild(currentTest(), process.execPath, [options.executable ?? LANE, ...args], {
    cwd: options.cwd ?? fixture.repo,
    env: hermeticGitEnvironment(options.env ?? fixture.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    completed: waitForExit(child),
  };
}

async function waitForCondition(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + loadTimeout(timeoutMs);
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function discoveredEnv(fixture, overrides = {}) {
  const env = { ...fixture.env };
  delete env.LANE_CONFIG;
  delete env.LANE_WORKTREE_ROOT;
  return { ...env, ...overrides };
}

function configRows(output) {
  return new Map(output.trim().split("\n").map((line) => {
    const [key, value, source] = line.split("\t");
    return [key, { value: JSON.parse(value), source }];
  }));
}

function lanePath(fixture, topic) {
  return join(fixture.worktrees, `lane-${topic}`);
}

function openLane(fixture, topic, base) {
  const run = lane(fixture, ["open", topic, ...(base === undefined ? [] : [base])]);
  assert.equal(run.status, 0, run.stderr);
  return lanePath(fixture, topic);
}

function commitFile(cwd, file, content, message) {
  writeFileSync(join(cwd, file), content);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-m", message], { stdio: "ignore" });
}

function refExists(repo, ref) {
  return spawnSync(GIT, ["-C", repo, "rev-parse", "--verify", "--quiet", ref], {
    env: hermeticGitEnvironment(),
  }).status === 0;
}

function ignoreLaneState(fixture) {
  writeFileSync(join(fixture.repo, ".gitignore"), ".lane/\n.ready.marker\n");
  git(fixture.repo, ["add", ".gitignore"]);
  git(fixture.repo, ["commit", "-m", "ignore lane state"], { stdio: "ignore" });
}

function writeExecutable(fixture, name, body) {
  const path = join(fixture.bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function repositoryIdentity(repo) {
  return realpathSync(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
}

function identityDigest(root, repo, topic, length = 8) {
  return createHash("sha256").update(`${root}\0${repo}\0${topic}`).digest("hex").slice(0, length);
}

function writeFakeHerdr(fixture, options = {}) {
  const executable = join(fixture.bin, "herdr");
  const log = join(fixture.root, "herdr.jsonl");
  const state = join(fixture.root, "herdr-state.json");
const source = `#!${process.execPath}
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
const log = process.env.FAKE_HERDR_LOG;
const statePath = process.env.FAKE_HERDR_STATE;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {
  opened: process.env.FAKE_HERDR_INITIALLY_OPENED === "1",
};
appendFileSync(log, JSON.stringify(args) + "\\n");
const save = () => writeFileSync(statePath, JSON.stringify(state));
const result = (id, value) => process.stdout.write(JSON.stringify({ id, result: value }) + "\\n");
const stallObservation = stage => {
  if (!state.agent || !process.env.FAKE_RETIREMENT_OBSERVE_DELAY_MS) return;
  (state.retirementStalls ||= []).push(stage); save();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_RETIREMENT_OBSERVE_DELAY_MS));
  (state.retirementStallsCompleted ||= []).push(stage); save();
};
const workspace = (id, label, path, linked, repoKey = process.env.FAKE_HERDR_REPO_KEY) => ({
  active_tab_id: id + ":t1", agent_status: "idle", focused: false, label,
  number: 1, pane_count: id === "w-lane" ? (state.tabCount || 1) : 1,
  tab_count: id === "w-lane" ? (state.tabCount || 1) : 1, workspace_id: id,
  worktree: {
    checkout_path: path, is_linked_worktree: linked, repo_key: repoKey,
    repo_name: process.env.FAKE_HERDR_REPO_NAME, repo_root: process.env.FAKE_HERDR_REPO_ROOT,
  },
});
const nativeAgent = () => ({
    agent_status: "idle", cwd: process.env.FAKE_HERDR_AGENT_CWD || process.env.FAKE_HERDR_LANE_PATH, name: state.agent,
    pane_id: state.agentPane || "w-lane:p2", workspace_id: "w-lane", terminal_id: "fixture-terminal-1",
    ...(process.env.FAKE_RETIREMENT_OWNER ? { agent: JSON.parse(process.env.FAKE_RETIREMENT_OWNER).command.replace(/^\\[|\\]$/g, ''), tab_id: "w-lane:t2" } : {}),
    ...(!process.env.FAKE_HERDR_SESSION_AFTER_PROMPT_READS || (state.prompted &&
      (state.sessionReads || 0) >= Number(process.env.FAKE_HERDR_SESSION_AFTER_PROMPT_READS)) ? {
    agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: state.agentSession || "fixture-session-1" },
    } : {}),
    ...(state.prompted && state.sessionReads >= 2 ? JSON.parse(process.env.FAKE_HERDR_CHANGE_SESSION_OBSERVATION || '{}') : {}),
});
if (args[0] === "workspace" && args[1] === "list") {
  stallObservation('workspace');
  state.workspaceLists = (state.workspaceLists || 0) + 1;
  save();
  const workspaces = process.env.FAKE_HERDR_NO_PARENT === "1" ? [] : [workspace("w-parent", "repository", process.env.FAKE_HERDR_REPO_ROOT, false)];
  if (process.env.FAKE_HERDR_CALLER_PATH) {
    workspaces.push(workspace("w-caller", "caller-lane", process.env.FAKE_HERDR_CALLER_PATH, true));
  }
  if (state.opened && !(process.env.FAKE_HERDR_HIDE_OPENED_ON_FIRST_LIST === "1" && state.workspaceLists === 1)) {
    workspaces.push(workspace("w-lane", state.label, process.env.FAKE_HERDR_LANE_PATH, true));
  }
  if (process.env.FAKE_HERDR_STALE_ID) {
    workspaces.push(workspace(
      process.env.FAKE_HERDR_STALE_ID,
      process.env.FAKE_HERDR_STALE_LABEL || "stale-label",
      process.env.FAKE_HERDR_LANE_PATH,
      true,
      process.env.FAKE_HERDR_FOREIGN_REPO_KEY,
    ));
  }
  workspaces.push(...JSON.parse(process.env.FAKE_HERDR_EXTRA_WORKSPACES || "[]"));
  result("cli:workspace:list", { type: "workspace_list", workspaces });
} else if (args[0] === "tab" && args[1] === "list") {
  if (args.at(-1) === "w-lane") stallObservation('tab');
  result("cli:tab:list", { tabs: process.env.FAKE_HERDR_INITIAL_INVENTORY && args.at(-1) === 'w-lane'
    ? [{ tab_id: 'w-lane:t1', workspace_id: 'w-lane' }] : process.env.FAKE_RETIREMENT_OWNER && state.agent && args.at(-1) === "w-lane"
    ? [{ tab_id: "w-lane:t2", workspace_id: "w-lane" }] : [] });
} else if (args[0] === "pane" && args[1] === "list") {
  result("cli:pane:list", { panes: process.env.FAKE_HERDR_INITIAL_INVENTORY && args.at(-1) === 'w-lane'
    ? [{ pane_id: 'w-lane:p1', tab_id: 'w-lane:t1', workspace_id: 'w-lane', terminal_id: 'fixture-terminal-1', foreground_cwd: process.env.FAKE_HERDR_LANE_PATH }] : process.env.FAKE_RETIREMENT_OWNER && state.agent && args.at(-1) === "w-lane"
    ? [{ pane_id: state.agentPane, tab_id: "w-lane:t2", workspace_id: "w-lane" }] : [] });
} else if (args[0] === "worktree" && args[1] === "list") {
  const openId = state.opened ? "w-lane" : process.env.FAKE_HERDR_STALE_ID;
  const worktrees = [{
    branch: "main", is_bare: false, is_detached: false, is_linked_worktree: false,
    is_prunable: false, label: "repository", open_workspace_id: "w-parent",
    path: process.env.FAKE_HERDR_REPO_ROOT,
  }];
  if (process.env.FAKE_HERDR_LANE_PATH) worktrees.push({
    branch: process.env.FAKE_HERDR_LANE_BRANCH, is_bare: false, is_detached: false,
    is_linked_worktree: true, is_prunable: false, label: state.label || "lane",
    ...(openId ? { open_workspace_id: openId } : {}), path: process.env.FAKE_HERDR_LANE_PATH,
  });
  result("cli:worktree:list", {
    source: {
      repo_key: process.env.FAKE_HERDR_REPO_KEY,
      repo_name: process.env.FAKE_HERDR_REPO_NAME,
      repo_root: process.env.FAKE_HERDR_REPO_ROOT,
      source_checkout_path: process.env.FAKE_HERDR_REPO_ROOT,
      source_workspace_id: "w-parent",
    },
    type: "worktree_list", worktrees,
  });
} else if (args[0] === "worktree" && args[1] === "create") {
  if (process.env.FAKE_HERDR_CREATE_RECEIPT === "1") {
    execFileSync('git', ['-C', process.env.FAKE_HERDR_REPO_ROOT, 'worktree', 'add', '-b', args[args.indexOf('--branch') + 1], args[args.indexOf('--path') + 1]], { stdio: 'ignore' });
    state.opened = true; state.label = args[args.indexOf('--label') + 1]; save();
    result('cli:worktree:create', { type: 'worktree_created',
      workspace: workspace('w-lane', state.label, process.env.FAKE_HERDR_LANE_PATH, true),
      tab: { tab_id: 'w-lane:t1', workspace_id: 'w-lane' },
      root_pane: { pane_id: 'w-lane:p1', tab_id: 'w-lane:t1', workspace_id: 'w-lane' } });
    process.exit(0);
  }
  if (process.env.FAKE_HERDR_FAILED_CREATE_OPENED === "1") {
    state.opened = true;
    state.label = args[args.indexOf("--label") + 1];
    save();
  }
  process.exit(1);
} else if (args[0] === "worktree" && args[1] === "open") {
  if (process.env.FAKE_HERDR_NO_PARENT === "1" && (args.includes("--workspace") || args[args.indexOf("--cwd") + 1] !== process.env.FAKE_HERDR_REPO_ROOT)) process.exit(2);
  const alreadyOpen = state.opened || process.env.FAKE_HERDR_OPEN_RACE === "1";
  if (process.env.FAKE_HERDR_NO_REPAIR !== "1") {
    state.opened = true;
    state.label = args[args.indexOf("--label") + 1];
    save();
  }
  result("cli:worktree:open", {
    type: "worktree_opened", already_open: alreadyOpen,
    workspace: workspace("w-lane", state.label, process.env.FAKE_HERDR_LANE_PATH, true),
    tab: { tab_id: "w-lane:t1", workspace_id: "w-lane" },
    root_pane: { pane_id: "w-lane:p1", tab_id: "w-lane:t1", workspace_id: "w-lane" },
  });
} else if (args[0] === "worktree" && args[1] === "remove") {
  throw new Error("worktree.remove steals focus; use workspace.close and Git removal");
} else if (args[0] === "workspace" && args[1] === "close") {
  if (process.env.FAKE_HERDR_WORKSPACE_CLOSE_FAIL === "1") { process.stderr.write("injected workspace close failure\\n"); process.exit(1); }
  state.opened = false;
  save();
  result("cli:workspace:close", { type: "workspace_close", workspace_id: args[2] });
} else if (args[0] === "tab" && args[1] === "create") {
  state.tabCount = (state.tabCount || 1) + 1;
  save();
  result("cli:tab:create", {
    type: "tab_create", tab: { tab_id: "w-lane:t2", workspace_id: "w-lane" },
    root_pane: { pane_id: "w-lane:p2", tab_id: "w-lane:t2", workspace_id: "w-lane" },
  });
} else if (args[0] === "pane" && args[1] === "process-info") {
  const shellPid = Number(process.env.FAKE_HERDR_SHELL_PID || 123456789);
  if (process.env.FAKE_HERDR_INITIAL_RECEIPT === '1') {
    state.initialInfoReads = (state.initialInfoReads || 0) + 1;
    if (process.env.FAKE_HERDR_INITIAL_LOCK && state.initialInfoReads === 1) state.initialLockDuringCapture = existsSync(process.env.FAKE_HERDR_INITIAL_LOCK);
    if (state.initialInfoReads === 2 && process.env.FAKE_HERDR_INITIAL_FILE) {
      state.initialClaimAtSupports = JSON.parse(readFileSync(process.env.FAKE_HERDR_INITIAL_FILE, 'utf8')).claimed === true;
      if (process.env.FAKE_HERDR_INITIAL_LOCK) state.initialLockAtSupports = existsSync(process.env.FAKE_HERDR_INITIAL_LOCK);
      if (process.env.FAKE_HERDR_DROP_INITIAL_RECEIPT) rmSync(process.env.FAKE_HERDR_INITIAL_FILE);
    }
    save();
    const shell = process.env.FAKE_HERDR_PANE_SHELL || 'zsh';
    result('cli:pane:process-info', { process_info: { shell_pid: shellPid,
      foreground_processes: process.env.FAKE_HERDR_INITIAL_UNAVAILABLE ? [] : [{ pid: shellPid, name: shell }], process_tree_complete: true,
      process_tree: [{ pid: shellPid, identity: 'initial-shell-birth', command: '[' + shell.split('/').at(-1) + ']', state: 'S' }] } });
    process.exit(0);
  }
  if (process.env.FAKE_RETIREMENT_OWNER && state.agent) {
    const owner = JSON.parse(process.env.FAKE_RETIREMENT_OWNER);
    result("cli:pane:process-info", { process_info: { shell_pid: shellPid,
      foreground_processes: [{ pid: owner.pid, name: owner.command.replace(/^\\[|\\]$/g, '') }], process_tree_complete: true,
      process_tree: [{ pid: shellPid, identity: "fixture-shell", command: "[zsh]", state: "S" }, owner] } });
    process.exit(0);
  }
  const complete = process.env.FAKE_HERDR_COMPLETE_SHELL === '1';
  if (complete) { state.shellInfoReads = (state.shellInfoReads || 0) + 1; save(); }
  // Give reuse fixtures a native birth observation instead of looking up their
  // placeholder PID on the host. An rc child starts after creation is captured.
  const rcChild = process.env.FAKE_HERDR_RC_CHILD === "1" && (!complete || state.shellInfoReads > 1);
  const shell = process.env.FAKE_HERDR_PANE_SHELL || "zsh";
  result("cli:pane:process-info", { process_info: { shell_pid: shellPid,
    foreground_processes: rcChild ? [{ pid: 987654321, name: "rc-child" }] : [{ pid: shellPid, name: shell }],
    ...(complete ? { process_tree_complete: true, process_tree: [
      { pid: shellPid, identity: 'initial-shell-birth', command: '[' + shell.split('/').at(-1) + ']', state: 'S' },
      ...(rcChild ? [{ pid: 987654321, ppid: shellPid, identity: 'rc-child-birth', command: '[rc-child]', state: 'S' }] : []),
    ] } : {}) } });
} else if (args[0] === "pane" && args[1] === "get") {
  result("cli:pane:get", { type: "pane_get", pane: {
    pane_id: args[2], foreground_cwd: process.env.FAKE_HERDR_LANE_PATH, terminal_id: 'fixture-terminal-1',
  } });
} else if (args[0] === "tab" && args[1] === "rename") {
  if (process.env.FAKE_HERDR_RENAME_FAIL === "1") process.exit(3);
  state.initialLabel = args[3];
  state.renamedAfterStart = Boolean(state.agent);
  state.renamedAfterVerification = (state.environmentReads || 0) > 2;
  save();
  result("cli:tab:rename", { type: "tab_info", tab: { tab_id: args[2], label: args[3] } });
} else if (args[0] === "pane" && args[1] === "run") {
  state.environmentFile = args[3].match(/^ \\. '([^']+)'/)[1];
  state.environmentMode = statSync(state.environmentFile).mode & 0o777;
  state.environmentDirectoryMode = statSync(dirname(state.environmentFile)).mode & 0o777;
  save();
  if (process.env.FAKE_HERDR_EXPORT_FAIL === "1") process.exit(3);
  if (process.env.FAKE_HERDR_EXPORT_DROP !== "1") {
    if (process.env.FAKE_HERDR_EXPORT_WRONG === "1") {
      writeFileSync(state.environmentFile, readFileSync(state.environmentFile, 'utf8').replace('export ', ': '));
    }
    const node = ${JSON.stringify(process.execPath)};
    const output = execFileSync('/bin/sh', ['-c', args[3] + "\\n" + "'" + node.replaceAll("'", "'\\\\''") + "' -e 'process.stdout.write(JSON.stringify(process.env))'"], { encoding: 'utf8', env: {} });
    const split = output.lastIndexOf('\\n');
    state.preparedEnv = JSON.parse(output.slice(split + 1));
    state.environmentOutput = output.slice(0, split + 1);
  }
  state.environmentReadyAt = Date.now() + Number(process.env.FAKE_HERDR_ENV_DELAY || 0);
  state.prepareCommand = args[3]; save();
} else if (args[0] === "pane" && args[1] === "read") {
  if (args[args.indexOf("--source") + 1] === "visible") {
    if (process.env.FAKE_HERDR_SCREEN_FAIL === "1") process.exit(3);
    process.stdout.write(process.env.FAKE_HERDR_SCREEN || "› Ready for a task");
    process.exit(0);
  }
  state.environmentReads = (state.environmentReads || 0) + 1; save();
  // Model terminal echo and a shell still finishing initialization. Neither
  // is proof the source command has executed.
  process.stdout.write(state.prepareCommand + "\\n" +
    (state.environmentReads > 2 && Date.now() >= (state.environmentReadyAt || 0) ? (state.environmentOutput || '') : ''));
} else if (args[0] === "agent" && args[1] === "start") {
  if (process.env.FAKE_HERDR_INITIAL_RECEIPT === '1' && args.includes('w-lane:p1')) {
    const receipt = JSON.parse(readFileSync(process.env.FAKE_HERDR_INITIAL_FILE, 'utf8'));
    state.initialClaimBeforeStart = receipt.claimed === true; save();
  }
  if (process.env.FAKE_HERDR_START_FAIL === "1") process.exit(3);
  if (process.env.FAKE_ENTRY_BIN) {
    const binary = process.env.FAKE_ENTRY_BIN + '/' + args[args.indexOf('--kind') + 1];
    const native = args.slice(args.indexOf('--') + 1);
    execFileSync(process.execPath, [${JSON.stringify(resolve(HERE, '../../test/helpers/pty.mjs'))}, '--run', binary, ...native], { cwd: process.env.FAKE_HERDR_LANE_PATH, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  state.agent = args[2];
  state.agentPane = args[args.indexOf("--pane") + 1];
  save();
  result("cli:agent:start", { type: "agent_start", name: state.agent, pane_id: state.agentPane });
} else if (args[0] === "agent" && args[1] === "list") {
  const agent = nativeAgent();
  if (process.env.FAKE_HERDR_SESSION_DETAIL_ONLY === '1') delete agent.agent_session;
  result("cli:agent:list", { type: "agent_list", agents: state.agent ? [agent] : [] });
} else if (args[0] === "agent" && args[1] === "get") {
  if (state.prompted) { state.sessionReads = (state.sessionReads || 0) + 1; save(); }
  result("cli:agent:get", { agent: state.agent === args[2] ? nativeAgent() : undefined });
} else if (args[0] === "agent" && args[1] === "read") {
  process.stdout.write("");
} else if (args[0] === "agent" && args[1] === "focus") {
  state.focusSocket = process.env.HERDR_SOCKET_PATH;
  save();
  if (process.env.FAKE_HERDR_FOCUS_FAIL === "1") {
    process.stderr.write("focus refused by fake Herdr\\n");
    process.exit(5);
  }
  if (process.env.FAKE_HERDR_FOCUS_ERROR_DOCUMENT === "1") {
    process.stdout.write(JSON.stringify({ error: { code: "focus_refused", message: "focus error document" } }) + "\\n");
    process.exit(0);
  }
  if (process.env.FAKE_HERDR_FOCUS_MALFORMED === "1") {
    process.stdout.write("not-json\\n");
    process.exit(0);
  }
  result("cli:agent:focus", { type: "agent_focus", target: args[2] });
} else if (args[0] === "agent" && args[1] === "prompt") {
  if (process.env.FAKE_RETIREMENT_OWNER) {
    const directory = process.env.ORG_DIR + "/retirement/occupants";
    state.receiptBeforePrompt = existsSync(directory) && statSync(directory).isDirectory() && (await import('node:fs')).readdirSync(directory).length === 1;
    save();
  }
  if (process.env.FAKE_HERDR_PROMPT_FAIL === "1") process.exit(4);
  state.prompted = true; save();
  if (process.env.FAKE_HERDR_REPLACE_AFTER_PROMPT === "1") {
    state.agentSession = "replacement-session";
    save();
  }
  if (process.env.FAKE_REVIEW_VERDICT) {
    const prompt = args[3];
    const payload = JSON.parse(process.env.FAKE_REVIEW_PAYLOAD || "{}");
    const field = (label) => prompt.split("\\n").find((line) => line.startsWith(label + ": "))?.slice(label.length + 2);
    const privatePath = field("Private record file");
    const publicPath = field("Public record file (forbidden)");
    const reviewed = process.env.FAKE_REVIEW_MODE === "sha-mismatch" ? "0".repeat(40) : field("Reviewed commit");
    const reexecuted = payload.reexecuted || (process.env.FAKE_REVIEW_MODE === "bad-witness"
      ? [{ command: "node --test", cwd: "scratch", exit_code: 0, result: "passed", tests_pass: true, witness: null }]
      : []);
    const finding = payload.findings || (process.env.FAKE_REVIEW_MODE === "bad-finding"
      ? "- [Unknown] shared.txt:1 - unclear; Fix: change it"
      : "None");
    const marker = process.env.FAKE_REVIEW_MODE === "incomplete" ? "" : "\\n<!-- lane-review-complete -->";
    let record = [
      "**" + process.env.FAKE_REVIEW_VERDICT + "**",
      "Schema: lane-review/v1",
      "Reviewed commit: " + reviewed,
      "Topic: " + field("Topic"),
      "Round: " + field("Round"),
      "Review ID: " + (process.env.FAKE_REVIEW_MODE === "review-id-mismatch" ? "lr-wrong" : field("Review ID")),
      "Base branch: " + field("Base branch"),
      "Base commit: " + field("Base commit"),
      "",
      "## Findings",
      finding,
      ...(process.env.FAKE_REVIEW_MODE === "compact-findings" ? [] : [""]),
      "## Re-executed",
      "\`\`\`json",
      JSON.stringify(reexecuted),
      "\`\`\`",
      "",
      "## Non-claims",
      payload.nonclaims || "None",
      "",
      "## Unverified",
      payload.unverified || "- Live reviewer behavior was not exercised.",
      "",
      "## Private identifiers",
      "\`\`\`json",
      JSON.stringify(payload.identifiers || []),
      "\`\`\`",
      "",
      "## Analysis",
      (payload.analysis || "Fixture review evidence.") + marker,
      "",
    ].join("\\n");
    if (process.env.FAKE_REVIEW_RECORD_PATH) {
      record = readFileSync(process.env.FAKE_REVIEW_RECORD_PATH, "utf8")
        .replace(/^Reviewed commit: .*$/mu, "Reviewed commit: " + reviewed)
        .replace(/^Topic: .*$/mu, "Topic: " + field("Topic"))
        .replace(/^Round: .*$/mu, "Round: " + field("Round"))
        .replace(/^Review ID: .*$/mu, "Review ID: " + field("Review ID"))
        .replace(/^Base branch: .*$/mu, "Base branch: " + field("Base branch"))
        .replace(/^Base commit: .*$/mu, "Base commit: " + field("Base commit"));
    }
    if (payload.spacing) {
      const blankLines = (boundary, fallback) => Array(
        payload.spacing.boundary === boundary ? payload.spacing.blankLines : fallback,
      ).fill("");
      const sections = [
        ["Findings", finding.split("\\n")],
        ["Re-executed", ["\`\`\`json", JSON.stringify(reexecuted), "\`\`\`"]],
        ["Non-claims", (payload.nonclaims || "None").split("\\n")],
        ["Unverified", (payload.unverified || "- Live reviewer behavior was not exercised.").split("\\n")],
        ["Private identifiers", ["\`\`\`json", JSON.stringify(payload.identifiers || []), "\`\`\`"]],
        ["Analysis", [payload.analysis || "Fixture review evidence."]],
      ];
      const recordLines = [
        ...blankLines("record-start", 0),
        "**" + process.env.FAKE_REVIEW_VERDICT + "**",
        "Schema: lane-review/v1",
        "Reviewed commit: " + reviewed,
        "Topic: " + field("Topic"),
        "Round: " + field("Round"),
        "Review ID: " + (process.env.FAKE_REVIEW_MODE === "review-id-mismatch" ? "lr-wrong" : field("Review ID")),
        "Base branch: " + field("Base branch"),
        "Base commit: " + field("Base commit"),
        "",
      ];
      for (let index = 0; index < sections.length; index += 1) {
        const [name, body] = sections[index];
        recordLines.push("## " + name, ...blankLines("after-" + name, 0), ...body);
        if (index + 1 < sections.length) {
          recordLines.push(...blankLines("before-" + sections[index + 1][0], 1));
        }
      }
      if (process.env.FAKE_REVIEW_MODE !== "incomplete") recordLines.push("", "<!-- lane-review-complete -->");
      recordLines.push(...blankLines("after-marker", 0));
      record = recordLines.join("\\n") + "\\n";
    }
    if (process.env.FAKE_REVIEW_MODE === "trailing-space-line") record += " \\n";
    if (process.env.FAKE_REVIEW_MODE === "trailing-tab-line") record += "\\t\\n";
    if (process.env.FAKE_REVIEW_MODE === "crlf-record") record = record.replace(/\\n/gu, "\\r\\n");
    if (process.env.FAKE_REVIEW_MODE === "utf8-bom") record = "\uFEFF" + record;
    mkdirSync(dirname(privatePath), { recursive: true });
    if (process.env.FAKE_REVIEW_MODE === "late-complete") {
      spawn(process.execPath, [
        "--input-type=module", "--eval",
        "import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(process.argv[1], process.argv[2]), 3500);",
        privatePath, record,
      ], { stdio: "ignore" }).unref();
    } else {
      writeFileSync(privatePath, process.env.FAKE_REVIEW_MODE === "oversized" ? "x".repeat(1024 * 1024 + 1) : record);
    }
    if (process.env.FAKE_REVIEW_MODE === "archive-collision") {
      const archive = process.env.FAKE_HERDR_REPO_ROOT + "/.lane/reviews/" + field("Topic") + "/" + reviewed.slice(0, 7) + "-r" + field("Round") + ".md";
      mkdirSync(dirname(archive), { recursive: true });
      writeFileSync(archive, "concurrent archive sentinel\\n");
    }
    if (process.env.FAKE_REVIEW_MODE === "rewrite-complete") {
      const rewritten = record
        .replace(/^\\*\\*PASS\\*\\*$/mu, "**NEEDS-WORK**")
        .replace(
          "- Live reviewer behavior was not exercised.",
          "- Rewritten reviewer behavior was not exercised.",
        );
      spawn(process.execPath, [
        "--input-type=module",
        "--eval",
        "import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(process.argv[1], process.argv[2]), 500);",
        privatePath,
        rewritten,
      ], { stdio: "ignore" }).unref();
    }
    if (process.env.FAKE_REVIEW_MODE === "dirty-public") {
      mkdirSync(dirname(publicPath), { recursive: true });
      writeFileSync(publicPath, "reviewer wrote this\\n");
    } else if (process.env.FAKE_REVIEW_MODE === "dirty-tracked") {
      writeFileSync(process.env.FAKE_HERDR_LANE_PATH + "/shared.txt", "reviewer mutation\\n");
    } else if (process.env.FAKE_REVIEW_MODE === "dirty-index") {
      writeFileSync(process.env.FAKE_HERDR_LANE_PATH + "/indexed.txt", "indexed\\n");
      execFileSync("git", ["-C", process.env.FAKE_HERDR_LANE_PATH, "add", "indexed.txt"]);
    } else if (process.env.FAKE_REVIEW_MODE === "head-move") {
      writeFileSync(process.env.FAKE_HERDR_LANE_PATH + "/moved.txt", "moved\\n");
      execFileSync("git", ["-C", process.env.FAKE_HERDR_LANE_PATH, "add", "moved.txt"]);
      execFileSync("git", ["-C", process.env.FAKE_HERDR_LANE_PATH, "commit", "-m", "move review head"]);
    } else if (process.env.FAKE_REVIEW_MODE === "remove-worktree") {
      rmSync(process.env.FAKE_HERDR_LANE_PATH + "/.git");
    }
  }
  if (process.env.FAKE_HERDR_BREAK_REGISTRY) {
    rmSync(process.env.FAKE_HERDR_BREAK_REGISTRY, { recursive: true, force: true });
    writeFileSync(process.env.FAKE_HERDR_BREAK_REGISTRY, "not a directory\\n");
  }
  if (process.env.FAKE_HERDR_BREAK_REGISTRY_LINK) {
    rmSync(process.env.FAKE_HERDR_BREAK_REGISTRY_LINK, { recursive: true, force: true });
    symlinkSync(process.env.FAKE_HERDR_DANGLING_TARGET, process.env.FAKE_HERDR_BREAK_REGISTRY_LINK);
  }
  result("cli:agent:prompt", { type: "agent_prompt", name: args[2] });
} else if (args[0] === "tab" && args[1] === "close") {
  result("cli:tab:close", { type: "tab_close", tab_id: args[2] });
} else {
  process.stderr.write("unsupported fake Herdr command: " + args.join(" ") + "\\n");
  process.exit(2);
}
`;
  writeFileSync(executable, source);
  chmodSync(executable, 0o755);
  Object.assign(fixture.env, {
    FAKE_HERDR_LOG: log,
    FAKE_HERDR_STATE: state,
    FAKE_HERDR_REPO_KEY: repositoryIdentity(fixture.repo),
    FAKE_HERDR_REPO_NAME: options.repoName ?? fixture.repo.split("/").at(-1),
    FAKE_HERDR_REPO_ROOT: fixture.repo,
    FAKE_HERDR_LANE_PATH: options.lanePath,
    FAKE_HERDR_LANE_BRANCH: options.branch,
    FAKE_HERDR_CALLER_PATH: options.callerPath,
    FAKE_HERDR_EXTRA_WORKSPACES: JSON.stringify(options.extraWorkspaces ?? []),
    FAKE_HERDR_STALE_ID: options.staleId,
    FAKE_HERDR_STALE_LABEL: options.staleLabel,
    FAKE_HERDR_FOREIGN_REPO_KEY: options.foreignRepoKey,
    FAKE_HERDR_NO_REPAIR: options.noRepair ? "1" : undefined,
    FAKE_HERDR_FAILED_CREATE_OPENED: options.failedCreateOpened ? "1" : undefined,
    FAKE_HERDR_INITIALLY_OPENED: options.initiallyOpened ? "1" : undefined,
    FAKE_HERDR_HIDE_OPENED_ON_FIRST_LIST: options.hideOpenedOnFirstList ? "1" : undefined,
    FAKE_REVIEW_VERDICT: options.reviewVerdict,
    FAKE_REVIEW_MODE: options.reviewMode,
    FAKE_REVIEW_PAYLOAD: options.reviewPayload === undefined ? undefined : JSON.stringify(options.reviewPayload),
    FAKE_REVIEW_RECORD_PATH: options.reviewRecord,
    FAKE_HERDR_START_FAIL: options.startFail ? "1" : undefined,
    FAKE_HERDR_AGENT_CWD: options.agentCwd,
    FAKE_HERDR_PROMPT_FAIL: options.promptFail ? "1" : undefined,
    FAKE_HERDR_FOCUS_FAIL: options.focusFail ? "1" : undefined,
    FAKE_HERDR_BREAK_REGISTRY: options.breakRegistry,
    FAKE_HERDR_BREAK_REGISTRY_LINK: options.breakRegistryLink,
    FAKE_HERDR_DANGLING_TARGET: options.danglingTarget,
  });
  for (const [key, value] of Object.entries(fixture.env)) {
    if (value === undefined) delete fixture.env[key];
  }
  return {
    log,
    state() {
      return existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {};
    },
    calls() {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    },
  };
}

async function registryApi() {
  return import("../board/registry.mjs");
}

function runRegistryChild(source, args, env = process.env) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawnChild(currentTest(), process.execPath, ["--input-type=module", "--eval", source, ...args], {
      env: hermeticGitEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    waitForExit(child).then(resolveChild, rejectChild);
  });
}

function expectUnsafeDispatchRefusal({ topic, configure, setup, afterOpen, fromLane = false, expected }) {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    configure?.(fixture);
    setup(fixture);
    const path = openLane(fixture, topic);
    afterOpen?.(fixture);
    const fake = writeFakeHerdr(fixture, {
      lanePath: path,
      branch: `lane/${topic}`,
      initiallyOpened: true,
    });
    const run = lane(fixture, ["dispatch", topic, "do the work"], { cwd: fromLane ? path : fixture.repo });
    assert.equal(run.status, 1);
    assert.match(run.stderr, expected);
    assert.deepEqual(fake.calls(), []);
  } finally {
    fixture.cleanup();
  }
}

function makeReviewFixture(topic, options = {}) {
  const fixture = makeFixture({
    main: "main",
    validate: "true",
    routes: {
      review: { kind: "codex", model: "review-model", use: "Independent review" },
      "review-codex": { kind: "codex", model: "review-model" },
      alternate: { kind: "claude", model: "alternate-review-model" },
    },
  });
  ignoreLaneState(fixture);
  const path = openLane(fixture, topic);
  const brief = join(fixture.root, `${topic}-brief.md`);
  writeFileSync(brief, options.brief ?? "Review the requested behavior.\n");
  const fake = writeFakeHerdr(fixture, {
    lanePath: path,
    branch: `lane/${topic}`,
    initiallyOpened: true,
    reviewVerdict: options.verdict,
    reviewMode: options.mode,
    reviewPayload: options.payload,
    reviewRecord: options.record,
  });
  return { fixture, path, brief, fake };
}

function reviewPayloadFixture(path) {
  const record = readFileSync(path, "utf8");
  const section = (name, next) => {
    const match = record.match(new RegExp(`## ${name}\\n([\\s\\S]*?)\\n## ${next}`, "u"));
    assert.ok(match, `missing ${name} fixture section`);
    return match[1].trim();
  };
  const executionBlock = section("Re-executed", "Non-claims").split("\n");
  const identifiersBlock = section("Private identifiers", "Analysis").split("\n");
  return {
    findings: section("Findings", "Re-executed"),
    reexecuted: JSON.parse(executionBlock.slice(1, -1).join("\n")),
    nonclaims: section("Non-claims", "Unverified"),
    unverified: section("Unverified", "Private identifiers"),
    identifiers: JSON.parse(identifiersBlock.slice(1, -1).join("\n")),
    analysis: "Sanitized production-derived fixture evidence.",
  };
}

function privateReviewDelivery(review) {
  const prompt = review.fake.calls().find(args => args[0] === 'agent' && args[1] === 'prompt')?.[3];
  assert.ok(prompt, 'review prompt was delivered');
  return prompt.match(/^Private record file: (.+)$/mu)[1];
}


// Retain the 3367cd5 matcher and ambiguity heuristic as fixture data so the
// differential checks remain self-contained in shallow clones.
const HISTORICAL_REVIEW_ABSOLUTE_PATH_PATTERN =
  /file:\/\/\/[A-Za-z0-9._~!$&'()+=@%\/-]+|\\\\[^\\/\s]+[\\/][^\s"'<>`\[\],;:)]+|\b[A-Za-z]:[\\/][^\s"'<>`\[\],;:)]+|(?<![-\p{L}\p{M}\p{N}_.\/\\])\/(?!\/)[^\s"'<>`\[\],;:()]+/giu;
const HISTORICAL_REVIEW_AMBIGUOUS_PATH_PATTERN =
  /(?:file:\/\/\/|\b[A-Za-z]:[\\/]|\\\\|(?<![-\p{L}\p{M}\p{N}_.\/\\])\/(?!\/))[^,;\n]*\s+[^,;\n]*[\\/]/iu;


export {
  waitForFile,
  HERE,
  LANE,
  HERDR_CLIENT,
  GIT,
  HEAD,
  NEGATIVE_CONTROL,
  parseVerdict,
  HERMETIC_GIT_ENV,
  OPERATOR_GIT_ENV_ROOT,
  OPERATOR_HOME,
  OPERATOR_XDG_CONFIG_HOME,
  OPERATOR_GIT_ENV,
  GIT_ENV_ROOT,
  GIT_HOME,
  GIT_XDG_CONFIG_HOME,
  GIT_GLOBAL_CONFIG,
  negativeControl,
  hermeticGitEnvironment,
  TEST_PROCESS_ENV,
  gitExec,
  git,
  copyInitialRepository,
  makeFixture,
  writeConfig,
  lane,
  laneProcess,
  waitForCondition,
  discoveredEnv,
  configRows,
  lanePath,
  openLane,
  commitFile,
  refExists,
  ignoreLaneState,
  writeExecutable,
  repositoryIdentity,
  identityDigest,
  writeFakeHerdr,
  registryApi,
  runRegistryChild,
  expectUnsafeDispatchRefusal,
  makeReviewFixture,
  reviewPayloadFixture,
  privateReviewDelivery,
  HISTORICAL_REVIEW_ABSOLUTE_PATH_PATTERN,
  HISTORICAL_REVIEW_AMBIGUOUS_PATH_PATTERN,
};
