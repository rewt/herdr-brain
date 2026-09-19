import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  boardSnapshotDocument,
  collectReportStates,
  joinBoardRows,
  parseVerdict,
} from "../board/board.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE = resolve(process.env.LANE_TEST_CLI ?? join(HERE, "..", "lane.mjs"));
const HERDR_CLIENT = resolve(HERE, "..", "board", "herdr-client.mjs");
const CLI_CLIENT = resolve(HERE, "..", "board", "cli-client.mjs");
const PROCESS_LIFETIME = resolve(HERE, "..", "board", "process-lifetime.mjs");
const GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const HEAD = execFileSync("/bin/sh", ["-c", "command -v head"], { encoding: "utf8" }).trim();
const HAS_HERDR = spawnSync("/bin/sh", ["-c", "command -v herdr"], { stdio: "ignore" }).status === 0;
const NEGATIVE_CONTROL = process.env.LANE_TEST_NEGATIVE_CONTROL === "1";
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

test("git helpers isolate the operator's global excludes file", () => {
  const fixture = makeFixture();
  try {
    mkdirSync(join(fixture.repo, ".lane"));
    writeFileSync(join(fixture.repo, ".lane", "state.json"), "{}\n");
    const operatorIgnored = spawnSync(GIT, ["-C", fixture.repo, "check-ignore", ".lane/state.json"], {
      env: OPERATOR_GIT_ENV,
      encoding: "utf8",
    });
    assert.equal(operatorIgnored.status, 0, operatorIgnored.stderr);
    const ignored = spawnSync(GIT, ["-C", fixture.repo, "check-ignore", ".lane/state.json"], {
      env: hermeticGitEnvironment(),
      encoding: "utf8",
    });
    assert.equal(ignored.status, 1, ignored.stderr);
    negativeControl("operator global excludes isolation");
  } finally {
    fixture.cleanup();
  }
});

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

function makeFixture(config = { main: "main", validate: "true" }, { repoParts = ["repo"] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-lanes-test-")));
  const repo = join(root, ...repoParts);
  const worktrees = join(root, "worktrees");
  const configPath = join(root, "lane.json");
  const bin = join(root, "bin");
  mkdirSync(repo, { recursive: true });
  mkdirSync(bin);
  symlinkSync(GIT, join(bin, "git"));
  symlinkSync(HEAD, join(bin, "head"));
  gitExec(["init", "-b", "main", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git(repo, ["add", "shared.txt"]);
  git(repo, ["commit", "-m", "initial"], { stdio: "ignore" });

  const fixture = {
    root,
    repo,
    worktrees,
    configPath,
    bin,
    env: {
      ...hermeticGitEnvironment(),
      PATH: bin,
      LANE_CONFIG: configPath,
      LANE_WORKTREE_ROOT: worktrees,
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
  return spawnSync(process.execPath, [options.executable ?? LANE, ...args], {
    cwd: options.cwd ?? fixture.repo,
    env: hermeticGitEnvironment(options.env ?? fixture.env),
    encoding: "utf8",
  });
}

function laneProcess(fixture, args, options = {}) {
  const child = spawn(process.execPath, [options.executable ?? LANE, ...args], {
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
    completed: once(child, "close").then(([status, signal]) => ({ status, signal, stdout, stderr })),
  };
}

async function waitForCondition(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function fakeBoardServer(fixture, handleRequest) {
  const socketPath = join(fixture.root, "board.sock");
  const requests = [];
  const sockets = new Set();
  let connectionCount = 0;
  const server = createServer((socket) => {
    connectionCount += 1;
    const connection = connectionCount;
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        const request = JSON.parse(line);
        requests.push(request);
        handleRequest({ socket, request, connection, requests });
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolvePromise);
  });
  return {
    socketPath,
    requests,
    sockets,
    connections: () => connectionCount,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

function boardSnapshotResult({ status = "working", cwd = "/ignored/live/path" } = {}) {
  return {
    type: "session_snapshot",
    snapshot: {
      protocol: 20,
      version: "test",
      agents: [{
        agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "fixture-board-session" },
        name: "board-agent",
        workspace_id: "workspace-1",
        pane_id: "pane-1",
        cwd,
        agent_status: status,
        terminal_id: "fixture-board-terminal",
      }],
      panes: [],
      workspaces: [{ workspace_id: "workspace-1", label: "workspace-1" }],
    },
  };
}

function writeBoardSession(fixture, overrides = {}) {
  const sessionId = overrides.session_id ?? "12345678-1234-4123-8123-123456789abc";
  const directory = join(fixture.repo, ".lane", "sessions.json.d");
  mkdirSync(directory, { recursive: true });
  const session = {
    session_id: sessionId,
    repo_id: repositoryIdentity(fixture.repo),
    root_id: fixture.root,
    repo: fixture.repo,
    topic: "board-action",
    name: "board-agent",
    workspace: "workspace-1",
    pane: "pane-1",
    server: join(fixture.root, "board.sock"),
    lane: "lane/board-action",
    role: "engineer",
    brief: null,
    goal: "Exercise board actions",
    report: "docs/reports/board-action.md",
    deadline: null,
    done: false,
    created_at: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
  const path = join(directory, `${sessionId}.json`);
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`);
  return { directory, path, session };
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const workspace = (id, label, path, linked, repoKey = process.env.FAKE_HERDR_REPO_KEY) => ({
  active_tab_id: id + ":t1", agent_status: "idle", focused: false, label,
  number: 1, pane_count: 1, tab_count: 1, workspace_id: id,
  worktree: {
    checkout_path: path, is_linked_worktree: linked, repo_key: repoKey,
    repo_name: process.env.FAKE_HERDR_REPO_NAME, repo_root: process.env.FAKE_HERDR_REPO_ROOT,
  },
});
if (args[0] === "workspace" && args[1] === "list") {
  state.workspaceLists = (state.workspaceLists || 0) + 1;
  save();
  const workspaces = [workspace("w-parent", "repository", process.env.FAKE_HERDR_REPO_ROOT, false)];
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
  if (process.env.FAKE_HERDR_FAILED_CREATE_OPENED === "1") {
    state.opened = true;
    state.label = args[args.indexOf("--label") + 1];
    save();
  }
  process.exit(1);
} else if (args[0] === "worktree" && args[1] === "open") {
  if (process.env.FAKE_HERDR_NO_REPAIR !== "1") {
    state.opened = true;
    state.label = args[args.indexOf("--label") + 1];
    save();
  }
  result("cli:worktree:open", { type: "worktree_open", workspace_id: "w-lane" });
} else if (args[0] === "worktree" && args[1] === "remove") {
  result("cli:worktree:remove", { type: "worktree_remove", workspace_id: args[3] });
} else if (args[0] === "tab" && args[1] === "create") {
  result("cli:tab:create", {
    type: "tab_create", tab: { tab_id: "w-lane:t2", workspace_id: "w-lane" },
    root_pane: { pane_id: "w-lane:p2", tab_id: "w-lane:t2", workspace_id: "w-lane" },
  });
} else if (args[0] === "pane" && args[1] === "get") {
  result("cli:pane:get", { type: "pane_get", pane: {
    pane_id: "w-lane:p2", foreground_cwd: process.env.FAKE_HERDR_LANE_PATH,
  } });
} else if (args[0] === "agent" && args[1] === "start") {
  if (process.env.FAKE_HERDR_START_FAIL === "1") process.exit(3);
  state.agent = args[2];
  save();
  result("cli:agent:start", { type: "agent_start", name: state.agent, pane_id: "w-lane:p2" });
} else if (args[0] === "agent" && args[1] === "list") {
  result("cli:agent:list", { type: "agent_list", agents: state.agent ? [{
    agent_status: "idle", cwd: process.env.FAKE_HERDR_AGENT_CWD || process.env.FAKE_HERDR_LANE_PATH, name: state.agent,
    pane_id: "w-lane:p2", workspace_id: "w-lane", terminal_id: "fixture-terminal-1",
    agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: state.agentSession || "fixture-session-1" },
  }] : [] });
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
  if (process.env.FAKE_HERDR_PROMPT_FAIL === "1") process.exit(4);
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
    mkdirSync(dirname(privatePath), { recursive: true });
    writeFileSync(privatePath, process.env.FAKE_REVIEW_MODE === "oversized" ? "x".repeat(1024 * 1024 + 1) : record);
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
      ], { detached: true, stdio: "ignore" }).unref();
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
      rmSync(process.env.FAKE_HERDR_LANE_PATH, { recursive: true, force: true });
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
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source, ...args], {
      env: hermeticGitEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectChild);
    child.on("close", (status) => resolveChild({ status, stdout, stderr }));
  });
}

test("open creates a lane and refuses duplicate, invalid, and unresolved inputs", () => {
  const fixture = makeFixture();
  try {
    const opened = lane(fixture, ["open", "alpha-topic"]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, /lane open: lane\/alpha-topic/);
    assert.ok(existsSync(lanePath(fixture, "alpha-topic")));
    assert.ok(refExists(fixture.repo, "refs/heads/lane/alpha-topic"));

    const duplicate = lane(fixture, ["open", "alpha-topic"]);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already exists/);

    const invalid = lane(fixture, ["open", "Bad_Name"]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /short kebab-case/);

    const unresolved = lane(fixture, ["open", "missing-base", "does-not-exist"]);
    assert.equal(unresolved.status, 1);
    assert.match(unresolved.stderr, /base ref does not resolve/);
    negativeControl("open guards");
  } finally {
    fixture.cleanup();
  }
});

test("status reports distance, dirtiness, and files shared by lanes", () => {
  const fixture = makeFixture();
  try {
    const alpha = openLane(fixture, "alpha-topic");
    const beta = openLane(fixture, "beta-topic");
    commitFile(alpha, "shared.txt", "alpha\n", "alpha change");
    commitFile(beta, "shared.txt", "beta\n", "beta change");
    commitFile(fixture.repo, "main-only.txt", "main\n", "move main");
    appendFileSync(join(alpha, "dirty.txt"), "uncommitted\n");

    const run = lane(fixture, ["status"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /lane\/alpha-topic\s+\+1\/-1 vs main.*DIRTY/);
    assert.match(run.stdout, /lane\/beta-topic\s+\+1\/-1 vs main/);
    assert.match(run.stdout, /shared files: lane\/alpha-topic × lane\/beta-topic: shared\.txt/);
    negativeControl("status reporting");
  } finally {
    fixture.cleanup();
  }
});

test("promote refuses a dirty lane worktree", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "dirty-topic");
    writeFileSync(join(path, "dirty.txt"), "dirty\n");
    const before = git(fixture.repo, ["rev-parse", "main"]);
    const run = lane(fixture, ["promote", "dirty-topic"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /lane worktree is not clean/);
    assert.equal(git(fixture.repo, ["rev-parse", "main"]), before);
    negativeControl("dirty promotion refusal");
  } finally {
    fixture.cleanup();
  }
});

test("promote leaves main unchanged when validation fails", () => {
  const fixture = makeFixture({ main: "main", validate: "false" });
  try {
    const path = openLane(fixture, "red-topic");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    const before = git(fixture.repo, ["rev-parse", "main"]);
    const run = lane(fixture, ["promote", "red-topic"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /validation failed \(exit 1\); nothing merged/);
    assert.equal(git(fixture.repo, ["rev-parse", "main"]), before);
    negativeControl("validation gate");
  } finally {
    fixture.cleanup();
  }
});

test("promote rebases a clean lane behind main and fast-forwards", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "green-topic");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    commitFile(fixture.repo, "main.txt", "main\n", "main change");
    const before = git(fixture.repo, ["rev-parse", "main"]);

    const run = lane(fixture, ["promote", "green-topic"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /rebased lane\/green-topic onto main/);
    assert.match(run.stdout, /promoted lane\/green-topic/);
    assert.notEqual(git(fixture.repo, ["rev-parse", "main"]), before);
    assert.equal(
      git(fixture.repo, ["rev-parse", "main"]),
      git(fixture.repo, ["rev-parse", "lane/green-topic"]),
    );
    assert.equal(readFileSync(join(fixture.repo, "lane.txt"), "utf8"), "lane\n");
    negativeControl("rebase and fast-forward");
  } finally {
    fixture.cleanup();
  }
});

test("promote accepts a gitignored lane board registry in the canonical checkout", () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    writeFileSync(
      join(fixture.repo, ".gitignore"),
      readFileSync(resolve(HERE, "..", ".gitignore"), "utf8"),
    );
    git(fixture.repo, ["add", ".gitignore"]);
    git(fixture.repo, ["commit", "-m", "add ignore rules"], { stdio: "ignore" });
    const path = openLane(fixture, "board-registry");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    mkdirSync(join(fixture.repo, ".lane"));
    writeFileSync(join(fixture.repo, ".lane", "sessions.json"), "[]\n");

    const run = lane(fixture, ["promote", "board-registry"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /promoted lane\/board-registry/);
    negativeControl("gitignored board registry promotion");
  } finally {
    fixture.cleanup();
  }
});

test("promote refuses a conflicting rebase and names the file", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "conflict-topic");
    commitFile(path, "shared.txt", "lane\n", "lane conflict");
    commitFile(fixture.repo, "shared.txt", "main\n", "main conflict");
    const before = git(fixture.repo, ["rev-parse", "main"]);

    const run = lane(fixture, ["promote", "conflict-topic"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /does not rebase cleanly; conflicts in: shared\.txt/);
    assert.equal(git(fixture.repo, ["rev-parse", "main"]), before);
    negativeControl("conflicting rebase refusal");
  } finally {
    fixture.cleanup();
  }
});

test("promote refuses when main moves during validation", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "moving-main");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    writeConfig(fixture, {
      main: "main",
      validate: `git -C '${fixture.repo}' commit --allow-empty -m validation-moved-main`,
    });
    const laneHead = git(fixture.repo, ["rev-parse", "lane/moving-main"]);

    const run = lane(fixture, ["promote", "moving-main"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /main moved during validation; re-run promote/);
    assert.notEqual(git(fixture.repo, ["rev-parse", "main"]), laneHead);
    negativeControl("main movement guard");
  } finally {
    fixture.cleanup();
  }
});

test("close deletes a merged branch", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "merged-topic");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    assert.equal(lane(fixture, ["promote", "merged-topic"]).status, 0);

    const run = lane(fixture, ["close", "merged-topic"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /deleted merged branch lane\/merged-topic/);
    assert.ok(!existsSync(path));
    assert.ok(!refExists(fixture.repo, "refs/heads/lane/merged-topic"));
    negativeControl("merged close");
  } finally {
    fixture.cleanup();
  }
});

test("close archive-tags an unmerged branch", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "unmerged-topic");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    const laneHead = git(fixture.repo, ["rev-parse", "lane/unmerged-topic"]);

    const run = lane(fixture, ["close", "unmerged-topic"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /archived unmerged lane as tag archive\/lane\/unmerged-topic/);
    assert.ok(!refExists(fixture.repo, "refs/heads/lane/unmerged-topic"));
    assert.equal(git(fixture.repo, ["rev-parse", "archive/lane/unmerged-topic"]), laneHead);
    negativeControl("unmerged archive");
  } finally {
    fixture.cleanup();
  }
});

test("close refuses a dirty worktree", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "dirty-close");
    writeFileSync(join(path, "dirty.txt"), "dirty\n");
    const run = lane(fixture, ["close", "dirty-close"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /lane worktree is not clean/);
    assert.ok(existsSync(path));
    assert.ok(refExists(fixture.repo, "refs/heads/lane/dirty-close"));
    negativeControl("dirty close refusal");
  } finally {
    fixture.cleanup();
  }
});

test("rebase-check exits zero when clean and one with files on conflict", () => {
  const fixture = makeFixture();
  try {
    const clean = openLane(fixture, "clean-check");
    const conflict = openLane(fixture, "conflict-check");
    commitFile(clean, "clean.txt", "clean\n", "clean lane");
    commitFile(conflict, "shared.txt", "lane\n", "conflicting lane");
    commitFile(fixture.repo, "shared.txt", "main\n", "conflicting main");

    const cleanRun = lane(fixture, ["rebase-check", "clean-check"]);
    assert.equal(cleanRun.status, 0, cleanRun.stderr);
    assert.match(cleanRun.stdout, /clean$/m);
    const conflictRun = lane(fixture, ["rebase-check", "conflict-check"]);
    assert.equal(conflictRun.status, 1);
    assert.match(conflictRun.stdout, /CONFLICT shared\.txt/);
    negativeControl("rebase-check exits");
  } finally {
    fixture.cleanup();
  }
});

test("prepare runs needed steps and skips steps whose unless path exists", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "prepare-topic");
    writeFileSync(join(path, "already.marker"), "present\n");
    writeConfig(fixture, {
      main: "main",
      validate: "true",
      prepare: [
        { unless: "ready.marker", run: "printf 'ran\\n' >> prepare.log; printf 'ready\\n' > ready.marker" },
        { unless: "already.marker", run: "printf 'unexpected\\n' >> skipped.log" },
      ],
    });

    const first = lane(fixture, ["prepare", "prepare-topic"]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(join(path, "prepare.log"), "utf8"), "ran\n");
    assert.ok(!existsSync(join(path, "skipped.log")));
    const second = lane(fixture, ["prepare", "prepare-topic"]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(join(path, "prepare.log"), "utf8"), "ran\n");
    negativeControl("prepare unless guards");
  } finally {
    fixture.cleanup();
  }
});

test("check records configured validation against the current HEAD", () => {
  const fixture = makeFixture({ main: "main", validate: "gate-pass configured" });
  try {
    ignoreLaneState(fixture);
    writeExecutable(fixture, "gate-pass", "exit 0");
    const path = openLane(fixture, "checked-topic");
    const head = git(path, ["rev-parse", "HEAD"]);

    const run = spawnSync(process.execPath, [LANE, "check"], {
      cwd: path,
      env: fixture.env,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`^GATE ${head} exit=0 \\(\\d+(?:\\.\\d+)?s\\)\\n$`));
    const gate = JSON.parse(readFileSync(join(path, ".lane", "gate.json"), "utf8"));
    assert.equal(gate.head, head);
    assert.equal(gate.branch, "lane/checked-topic");
    assert.equal(gate.command, "gate-pass configured");
    assert.equal(gate.exit_code, 0);
    assert.equal(gate.signal, null);
    assert.equal(new Date(gate.started_at).toISOString(), gate.started_at);
    assert.equal(new Date(gate.finished_at).toISOString(), gate.finished_at);
    assert.ok(Date.parse(gate.finished_at) >= Date.parse(gate.started_at));
    assert.equal(typeof gate.duration_s, "number");
    assert.ok(gate.duration_s >= 0);
    negativeControl("check configured validation record");
  } finally {
    fixture.cleanup();
  }
});

test("check honors LANE_VALIDATE and --cmd precedence and returns a failed gate exit", () => {
  const fixture = makeFixture({ main: "main", validate: "gate-configured" });
  try {
    ignoreLaneState(fixture);
    writeExecutable(fixture, "gate-configured", "exit 2");
    writeExecutable(fixture, "gate-environment", "exit 0");
    writeExecutable(fixture, "gate-override", "exit 7");

    fixture.env.LANE_VALIDATE = "gate-environment";
    const environment = lane(fixture, ["check"]);
    assert.equal(environment.status, 0, environment.stderr);
    assert.equal(
      JSON.parse(readFileSync(join(fixture.repo, ".lane", "gate.json"), "utf8")).command,
      "gate-environment",
    );

    const command = "gate-override --record-verbatim";
    const override = lane(fixture, ["check", "--cmd", command]);
    assert.equal(override.status, 7, override.stderr);
    assert.match(override.stdout, /GATE [0-9a-f]{40} exit=7/);
    const gate = JSON.parse(readFileSync(join(fixture.repo, ".lane", "gate.json"), "utf8"));
    assert.equal(gate.command, command);
    assert.equal(gate.exit_code, 7);
    negativeControl("check validation precedence and failed exit");
  } finally {
    fixture.cleanup();
  }
});

test("check defaults to npm test and refuses a dirty current worktree", () => {
  const fixture = makeFixture({ main: "main" });
  try {
    ignoreLaneState(fixture);
    writeExecutable(fixture, "npm", "[ \"$1\" = test ] || exit 9\nexit 0");
    const clean = lane(fixture, ["check"]);
    assert.equal(clean.status, 0, clean.stderr);
    const gatePath = join(fixture.repo, ".lane", "gate.json");
    const gate = JSON.parse(readFileSync(gatePath, "utf8"));
    assert.equal(gate.command, "npm test");

    const previous = readFileSync(gatePath, "utf8");
    writeFileSync(join(fixture.repo, "dirty.txt"), "dirty\n");
    const dirty = lane(fixture, ["check"]);
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /current worktree is not clean/);
    assert.equal(readFileSync(gatePath, "utf8"), previous);
    negativeControl("check default and dirty refusal");
  } finally {
    fixture.cleanup();
  }
});

test("check runs configured prepare steps before validation", () => {
  const fixture = makeFixture({
    main: "main",
    validate: "gate-needs-prepare",
    prepare: [{ unless: ".ready.marker", run: ": > .ready.marker" }],
  });
  try {
    ignoreLaneState(fixture);
    writeExecutable(fixture, "gate-needs-prepare", "[ -f .ready.marker ] || exit 6\nexit 0");

    const run = lane(fixture, ["check"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /preparing .*: : > \.ready\.marker/);
    assert.ok(existsSync(join(fixture.repo, ".ready.marker")));
    assert.equal(
      JSON.parse(readFileSync(join(fixture.repo, ".lane", "gate.json"), "utf8")).exit_code,
      0,
    );
    negativeControl("check prepare parity");
  } finally {
    fixture.cleanup();
  }
});

test("check records signal termination using the shell exit convention", () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    const run = lane(fixture, ["check", "--cmd", "kill -9 $$"]);
    assert.equal(run.status, 137, run.stderr);
    assert.match(run.stdout, /GATE [0-9a-f]{40} exit=137/);
    const gate = JSON.parse(readFileSync(join(fixture.repo, ".lane", "gate.json"), "utf8"));
    assert.equal(gate.exit_code, 137);
    assert.equal(gate.signal, "SIGKILL");
    negativeControl("check signal gate");
  } finally {
    fixture.cleanup();
  }
});

test("check refuses a detached HEAD without replacing an existing gate", () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    mkdirSync(join(fixture.repo, ".lane"));
    const gatePath = join(fixture.repo, ".lane", "gate.json");
    writeFileSync(gatePath, "existing gate\n");
    git(fixture.repo, ["switch", "--detach"]);

    const run = lane(fixture, ["check"]);
    assert.equal(run.status, 1);
    assert.equal(run.stderr, "lane: current checkout is detached; check requires a branch\n");
    assert.equal(readFileSync(gatePath, "utf8"), "existing gate\n");
    negativeControl("check detached HEAD refusal");
  } finally {
    fixture.cleanup();
  }
});

test("check rejects unknown options and missing or empty --cmd values", () => {
  const fixture = makeFixture();
  try {
    const unknown = lane(fixture, ["check", "--unknown"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown option: --unknown/);

    const missing = lane(fixture, ["check", "--cmd"]);
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr, "lane: usage: lane check [--cmd <validate command>]\n");

    const empty = lane(fixture, ["check", "--cmd", ""]);
    assert.equal(empty.status, 1);
    assert.equal(empty.stderr, "lane: usage: lane check [--cmd <validate command>]\n");
    negativeControl("check argument refusals");
  } finally {
    fixture.cleanup();
  }
});

test("routes prints configured routes with resolved dispatch defaults", () => {
  const fixture = makeFixture({
    main: "main",
    validate: "true",
    dispatch: {
      kind: "claude",
      model: "default-model",
      args: ["--default-flag"],
    },
    routes: {
      review: { kind: "reviewer" },
      engineer: {
        kind: "codex",
        model: "engineer-model",
        args: ["--profile", "implementation"],
        use: "Complex implementation lanes",
      },
    },
  });
  try {
    const run = lane(fixture, ["routes"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      run.stdout,
      "engineer\tkind=codex\tmodel=engineer-model\targs=[\"--profile\",\"implementation\"]\tuse=Complex implementation lanes\n" +
        "review\tkind=reviewer\tmodel=default-model\targs=[\"--default-flag\"]\tuse=(none)\n",
    );

    writeConfig(fixture, { main: "main", validate: "true" });
    const empty = lane(fixture, ["routes"]);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /lane: no routes configured/);
    negativeControl("routes output");
  } finally {
    fixture.cleanup();
  }
});

test("config layers the nearest parent and canonical repository with attributed replacement semantics", () => {
  const fixture = makeFixture(undefined, { repoParts: ["home", "projects", "team", "repo"] });
  try {
    const home = join(fixture.root, "home");
    const grandparent = join(home, "projects");
    const parent = join(grandparent, "team");
    const parentConfig = join(parent, ".lane.json");
    const repoConfig = join(fixture.repo, ".lane.json");
    const shouldNotRun = join(fixture.root, "config-command-ran");
    writeFileSync(join(home, ".lane.json"), `${JSON.stringify({ main: "home-main" })}\n`);
    writeFileSync(join(grandparent, ".lane.json"), `${JSON.stringify({
      main: "grandparent-main",
      seams_doc: "grandparent-seams.md",
    })}\n`);
    writeFileSync(parentConfig, `${JSON.stringify({
      main: "parent-main",
      registry: "parent-sessions.json",
      worktree_root: "parent-trees",
      prepare: [{ unless: "parent.marker", run: `touch '${shouldNotRun}'` }],
      dispatch: { kind: "claude", env: ["PARENT=1"], args: ["--parent"] },
      routes: {
        engineer: { kind: "claude", env: ["PARENT_ROUTE=1"] },
        reviewer: { kind: "claude", model: "review-model", args: ["--review"] },
      },
    }, null, 2)}\n`);
    writeFileSync(repoConfig, `${JSON.stringify({
      main: "main",
      validate: `touch '${shouldNotRun}'`,
      worktree_root: "../repo-trees",
      prepare: [{ unless: "repo.marker", run: `touch '${shouldNotRun}'` }],
      dispatch: { kind: "codex", env: ["REPO=1"], args: ["--repo"] },
      routes: {
        engineer: { kind: "codex", model: "engineer-model", args: ["--engineer"] },
      },
    }, null, 2)}\n`);

    const run = lane(fixture, ["config"], {
      env: discoveredEnv(fixture, { HOME: home }),
    });
    assert.equal(run.status, 0, run.stderr);
    const rows = configRows(run.stdout);
    assert.deepEqual(rows.get("main"), { value: "main", source: repoConfig });
    assert.deepEqual(rows.get("registry"), { value: "parent-sessions.json", source: parentConfig });
    assert.deepEqual(rows.get("seams_doc"), { value: null, source: "default" });
    assert.deepEqual(rows.get("prepare"), {
      value: [{ unless: "repo.marker", run: `touch '${shouldNotRun}'` }],
      source: repoConfig,
    });
    assert.deepEqual(rows.get("dispatch"), {
      value: { kind: "codex", env: ["REPO=1"], args: ["--repo"] },
      source: repoConfig,
    });
    assert.deepEqual(rows.get("routes.engineer"), {
      value: { kind: "codex", model: "engineer-model", args: ["--engineer"] },
      source: repoConfig,
    });
    assert.deepEqual(rows.get("routes.reviewer"), {
      value: { kind: "claude", model: "review-model", args: ["--review"] },
      source: parentConfig,
    });
    assert.deepEqual(rows.get("worktree_root"), {
      value: join(dirname(fixture.repo), "repo-trees", "repo"),
      source: repoConfig,
    });
    assert.ok(!existsSync(shouldNotRun));
    const opened = lane(fixture, ["open", "repository-root-lane"], {
      env: discoveredEnv(fixture, { HOME: home }),
    });
    assert.equal(opened.status, 0, opened.stderr);
    assert.ok(existsSync(join(dirname(fixture.repo), "repo-trees", "repo", "lane-repository-root-lane")));
    negativeControl("layered config attribution and replacement");
  } finally {
    fixture.cleanup();
  }
});

test("config escapes route names so every TSV record remains one line with three fields", () => {
  const fixture = makeFixture({
    routes: {
      "review\tline\nnext\\path": { kind: "claude" },
    },
  });
  try {
    const run = lane(fixture, ["config"]);
    assert.equal(run.status, 0, run.stderr);
    const routeRows = run.stdout.trim().split("\n").filter((line) => line.startsWith("routes."));
    assert.deepEqual(routeRows, [
      `routes.review\\tline\\nnext\\\\path\t{"kind":"claude"}\t${fixture.configPath}`,
    ]);
    negativeControl("config TSV route-key escaping");
  } finally {
    fixture.cleanup();
  }
});

test("worktree roots honor parent-relative, parent-default, legacy, and caller-relative environment precedence", () => {
  const cases = [
    {
      name: "parent-relative",
      parent: { worktree_root: "shared-trees" },
      expected(fixture) { return join(fixture.root, "home", "projects", "shared-trees", "repo"); },
    },
    {
      name: "parent-default",
      parent: { validate: "true" },
      expected(fixture) { return join(fixture.root, "home", "projects", ".worktrees", "repo"); },
    },
    {
      name: "legacy-default",
      expected(fixture) { return join(fixture.root, "home", ".herdr", "worktrees", "repo"); },
    },
  ];
  for (const item of cases) {
    const fixture = makeFixture(undefined, { repoParts: ["home", "projects", "repo"] });
    try {
      const home = join(fixture.root, "home");
      const parent = join(home, "projects");
      if (item.parent !== undefined) {
        writeFileSync(join(parent, ".lane.json"), `${JSON.stringify(item.parent)}\n`);
      }
      const env = discoveredEnv(fixture, { HOME: home });
      const explained = lane(fixture, ["config"], { env });
      assert.equal(explained.status, 0, explained.stderr);
      assert.deepEqual(configRows(explained.stdout).get("worktree_root"), {
        value: item.expected(fixture),
        source: item.parent === undefined ? "default" : join(parent, ".lane.json"),
      });
      const run = lane(fixture, ["open", `${item.name}-lane`], { env });
      assert.equal(run.status, 0, run.stderr);
      assert.ok(existsSync(join(item.expected(fixture), `lane-${item.name}-lane`)));
    } finally {
      fixture.cleanup();
    }
  }

  const fixture = makeFixture();
  try {
    const caller = join(fixture.repo, "caller");
    mkdirSync(caller);
    const env = discoveredEnv(fixture, { LANE_WORKTREE_ROOT: "environment-trees" });
    const explained = lane(fixture, ["config"], { cwd: caller, env });
    assert.equal(explained.status, 0, explained.stderr);
    assert.deepEqual(configRows(explained.stdout).get("worktree_root"), {
      value: join(caller, "environment-trees"),
      source: "env",
    });
    const run = lane(fixture, ["open", "environment-lane"], { cwd: caller, env });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /unsafe worktree path.*canonical checkout/);
    assert.ok(!existsSync(join(caller, "environment-trees", "lane-environment-lane")));
    assert.ok(!existsSync(join(caller, "environment-trees", "repo")));
    negativeControl("worktree root precedence matrix");
  } finally {
    fixture.cleanup();
  }
});

test("home is a configuration discovery boundary", () => {
  const fixture = makeFixture(undefined, { repoParts: ["home", "repo"] });
  try {
    const home = join(fixture.root, "home");
    writeFileSync(join(home, ".lane.json"), `${JSON.stringify({
      main: "must-not-cross-home",
      worktree_root: "must-not-use",
    })}\n`);
    const run = lane(fixture, ["config"], { env: discoveredEnv(fixture, { HOME: home }) });
    assert.equal(run.status, 0, run.stderr);
    const rows = configRows(run.stdout);
    assert.deepEqual(rows.get("main"), { value: "main", source: "default" });
    assert.deepEqual(rows.get("worktree_root"), {
      value: join(home, ".herdr", "worktrees", "repo"),
      source: "default",
    });
    negativeControl("home discovery boundary");
  } finally {
    fixture.cleanup();
  }
});

test("LANE_CONFIG selects one caller-relative file and bypasses discovered layers", () => {
  const fixture = makeFixture();
  try {
    const caller = join(fixture.repo, "caller");
    const home = join(fixture.root, "home");
    mkdirSync(caller);
    mkdirSync(home);
    const parentConfig = join(fixture.root, ".lane.json");
    const repoConfig = join(fixture.repo, ".lane.json");
    const selected = join(caller, "selected.json");
    writeFileSync(parentConfig, `${JSON.stringify({ main: "parent-main", validate: "parent" })}\n`);
    writeFileSync(repoConfig, `${JSON.stringify({ main: "repo-main", validate: "repo" })}\n`);
    writeFileSync(selected, `${JSON.stringify({ validate: "selected", worktree_root: "selected-trees" })}\n`);
    const env = discoveredEnv(fixture, { HOME: home, LANE_CONFIG: "selected.json" });
    const run = lane(fixture, ["config"], { cwd: caller, env });
    assert.equal(run.status, 0, run.stderr);
    const rows = configRows(run.stdout);
    assert.deepEqual(rows.get("main"), { value: "main", source: "default" });
    assert.deepEqual(rows.get("validate"), { value: "selected", source: selected });
    assert.deepEqual(rows.get("worktree_root"), {
      value: join(caller, "selected-trees", "repo"),
      source: selected,
    });
    const validateOverride = lane(fixture, ["config"], {
      cwd: caller,
      env: { ...env, LANE_VALIDATE: "environment-validate" },
    });
    assert.equal(validateOverride.status, 0, validateOverride.stderr);
    assert.deepEqual(configRows(validateOverride.stdout).get("validate"), {
      value: "environment-validate",
      source: "env",
    });
    writeFileSync(selected, `${JSON.stringify({ validate: "selected" })}\n`);
    const legacyRoot = lane(fixture, ["config"], { cwd: caller, env });
    assert.equal(legacyRoot.status, 0, legacyRoot.stderr);
    const worktreeRoot = configRows(legacyRoot.stdout).get("worktree_root");
    assert.equal(worktreeRoot.value, join(home, ".herdr", "worktrees", "repo"));
    assert.equal(worktreeRoot.source, "default");
    negativeControl("explicit config bypass");
  } finally {
    fixture.cleanup();
  }
});

test("linked invocations use canonical repository config for explanation, check, and promote", () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    writeExecutable(fixture, "canonical-check", "exit 0");
    const linked = join(fixture.root, "linked");
    git(fixture.repo, ["worktree", "add", "-b", "lane/linked-config", linked], { stdio: "ignore" });
    const canonicalConfig = join(fixture.repo, ".lane.json");
    writeFileSync(canonicalConfig, `${JSON.stringify({ validate: "canonical-check", worktree_root: "canonical-trees" })}\n`);
    git(fixture.repo, ["add", ".lane.json"]);
    git(fixture.repo, ["commit", "-m", "add canonical config"], { stdio: "ignore" });

    const run = lane(fixture, ["config"], { cwd: linked, env: discoveredEnv(fixture) });
    assert.equal(run.status, 0, run.stderr);
    const rows = configRows(run.stdout);
    assert.deepEqual(rows.get("validate"), { value: "canonical-check", source: canonicalConfig });
    assert.deepEqual(rows.get("worktree_root"), {
      value: join(fixture.repo, "canonical-trees", "repo"),
      source: canonicalConfig,
    });
    const check = lane(fixture, ["check"], { cwd: linked, env: discoveredEnv(fixture) });
    assert.equal(check.status, 0, check.stderr);
    const promote = lane(fixture, ["promote", "linked-config"], { env: discoveredEnv(fixture) });
    assert.equal(promote.status, 0, promote.stderr);
    negativeControl("canonical config from linked worktree");
  } finally {
    fixture.cleanup();
  }
});

test("bare repositories with only linked worktrees allow reads and refuse mutations clearly", () => {
  const fixture = makeFixture();
  try {
    const bare = join(fixture.root, "repository.git");
    const linked = join(fixture.root, "linked-checkout");
    gitExec(["clone", "--bare", fixture.repo, bare], { stdio: "ignore" });
    gitExec(["--git-dir", bare, "worktree", "add", linked, "main"], { stdio: "ignore" });
    const linkedFixture = { ...fixture, repo: linked };

    const explained = lane(linkedFixture, ["config"]);
    assert.equal(explained.status, 0, explained.stderr);
    assert.deepEqual(configRows(explained.stdout).get("main"), { value: "main", source: fixture.configPath });
    const listed = lane(linkedFixture, ["status"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /no open lanes/);

    const opened = lane(linkedFixture, ["open", "needs-primary"]);
    assert.equal(opened.status, 1);
    assert.match(opened.stderr, /cannot resolve canonical non-linked checkout.*open requires a canonical checkout/);
    assert.ok(!refExists(linked, "refs/heads/lane/needs-primary"));
    negativeControl("bare linked reads and mutation refusal");
  } finally {
    fixture.cleanup();
  }
});

test("same-named repositories in equal-labeled roots keep distinct paths, labels, agents, and git identities", () => {
  const fixtures = [
    makeFixture(undefined, { repoParts: ["development-a", "same-root", "same-repo"] }),
    makeFixture(undefined, { repoParts: ["development-b", "same-root", "same-repo"] }),
  ];
  try {
    const records = [];
    for (const [index, fixture] of fixtures.entries()) {
      const rootIdentity = realpathSync(join(fixture.root, `development-${index === 0 ? "a" : "b"}`, "same-root"));
      writeFileSync(join(rootIdentity, ".lane.json"), `${JSON.stringify({ validate: "true" })}\n`);
      fixture.env = discoveredEnv(fixture, { HOME: join(fixture.root, `development-${index === 0 ? "a" : "b"}`) });
      ignoreLaneState(fixture);
      const path = join(rootIdentity, ".worktrees", "same-repo", "lane-shared-topic");
      const identity = repositoryIdentity(fixture.repo);
      const readableLabel = "same-root/same-repo:lane-shared-topic";
      const fake = writeFakeHerdr(fixture, {
        lanePath: path,
        branch: "lane/shared-topic",
        extraWorkspaces: [{
          active_tab_id: "w-foreign:t1",
          agent_status: "idle",
          focused: false,
          label: readableLabel,
          number: 8,
          pane_count: 1,
          tab_count: 1,
          workspace_id: "w-foreign",
          worktree: {
            checkout_path: "/foreign/worktree",
            is_linked_worktree: true,
            repo_key: "/foreign/repository.git",
            repo_name: "same-repo",
            repo_root: "/foreign/same-repo",
          },
        }],
      });
      git(fixture.repo, ["config", "user.name", `Lane Identity ${index + 1}`]);
      git(fixture.repo, ["config", "user.email", `identity-${index + 1}@example.invalid`]);
      const before = git(fixture.repo, ["config", "--local", "--list"]);
      const opened = lane(fixture, ["open", "shared-topic"]);
      assert.equal(opened.status, 0, opened.stderr);
      assert.ok(existsSync(path));
      assert.match(opened.stdout, new RegExp(`repository identity: ${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(opened.stdout, new RegExp(`root identity: ${rootIdentity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      const dispatched = lane(fixture, ["dispatch", "shared-topic", "implement the task"]);
      assert.equal(dispatched.status, 0, dispatched.stderr);
      const calls = fake.calls();
      const create = calls.find((args) => args[0] === "worktree" && args[1] === "create");
      const label = create[create.indexOf("--label") + 1];
      const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
      const agent = start[2];
      const firstAgentList = calls.findIndex((args) => args[0] === "agent" && args[1] === "list");
      const firstAgentStart = calls.findIndex((args) => args[0] === "agent" && args[1] === "start");
      assert.ok(firstAgentList >= 0 && firstAgentList < firstAgentStart);
      assert.match(label, /^same-root\/same-repo:lane-shared-topic~[0-9a-f]{8}$/);
      assert.ok(label.endsWith(identityDigest(rootIdentity, identity, "shared-topic")));
      assert.match(agent, /^[a-z][a-z0-9_-]{0,31}$/);
      assert.ok(agent.includes(identityDigest(rootIdentity, identity, "shared-topic", 6)));
      assert.equal(git(fixture.repo, ["config", "--local", "--list"]), before);
      assert.equal(git(path, ["config", "user.name"]), `Lane Identity ${index + 1}`);
      records.push({ agent, identity, label, path });
    }
    assert.notEqual(records[0].path, records[1].path);
    assert.notEqual(records[0].identity, records[1].identity);
    assert.notEqual(records[0].label, records[1].label);
    assert.notEqual(records[0].agent, records[1].agent);
    negativeControl("root/repository identity labels and agent names");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("long Unicode workspace labels retain graphemes and fragments within 64 code points", () => {
  const accent = "e\u0301";
  const family = "👨‍👩‍👧‍👦";
  const fixtures = ["a", "b"].map((suffix) => makeFixture(undefined, {
    repoParts: [`${accent.repeat(12)}-root-${suffix}`, `${family.repeat(3)}-repository-${suffix}`],
  }));
  try {
    const labels = [];
    for (const [index, fixture] of fixtures.entries()) {
      const rootIdentity = realpathSync(dirname(fixture.repo));
      writeFileSync(join(rootIdentity, ".lane.json"), `${JSON.stringify({ validate: "true" })}\n`);
      fixture.env = discoveredEnv(fixture, { HOME: fixture.root });
      const topic = `${"common-prefix-".repeat(4)}${index === 0 ? "a" : "b"}`;
      const path = join(rootIdentity, ".worktrees", fixture.repo.split("/").at(-1), `lane-${topic}`);
      const fake = writeFakeHerdr(fixture, { lanePath: path, branch: `lane/${topic}` });
      const opened = lane(fixture, ["open", topic]);
      assert.equal(opened.status, 0, opened.stderr);
      const create = fake.calls().find((args) => args[0] === "worktree" && args[1] === "create");
      const label = create[create.indexOf("--label") + 1];
      assert.ok([...label].length <= 64, `${[...label].length} code points: ${label}`);
      assert.match(label, new RegExp(`^(?:${accent})+…/`));
      assert.ok(label.includes(`${family}${family}…:lane-common-prefix-`));
      assert.match(label, /~[0-9a-f]{8,}$/);
      assert.ok(label.endsWith(identityDigest(rootIdentity, repositoryIdentity(fixture.repo), topic)));
      labels.push(label);
    }
    assert.notEqual(labels[0], labels[1]);
    negativeControl("bounded grapheme-safe identity labels");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("open refuses symlink escapes and destinations inside repository checkouts before mutation", () => {
  const fixtures = [];
  try {
    const escaped = makeFixture();
    fixtures.push(escaped);
    const selectedBase = join(escaped.root, "selected-base");
    const outside = join(escaped.root, "outside-base");
    mkdirSync(selectedBase);
    mkdirSync(outside);
    symlinkSync(outside, join(selectedBase, "repo"));
    writeConfig(escaped, { main: "main", validate: "true", worktree_root: selectedBase });
    delete escaped.env.LANE_WORKTREE_ROOT;
    const escape = lane(escaped, ["open", "symlink-escape"]);
    assert.equal(escape.status, 1);
    assert.match(escape.stderr, /unsafe worktree path.*outside selected base/);
    assert.ok(!existsSync(join(outside, "lane-symlink-escape")));
    assert.ok(!refExists(escaped.repo, "refs/heads/lane/symlink-escape"));

    const canonical = makeFixture();
    fixtures.push(canonical);
    canonical.env.LANE_WORKTREE_ROOT = join(canonical.repo, "nested-worktrees");
    const descendant = lane(canonical, ["open", "checkout-descendant"]);
    assert.equal(descendant.status, 1);
    assert.match(descendant.stderr, /unsafe worktree path.*canonical checkout/);
    assert.ok(!refExists(canonical.repo, "refs/heads/lane/checkout-descendant"));

    const registered = makeFixture();
    fixtures.push(registered);
    const host = openLane(registered, "registered-host");
    registered.env.LANE_WORKTREE_ROOT = join(host, "nested-worktrees");
    const nested = lane(registered, ["open", "registered-descendant"]);
    assert.equal(nested.status, 1);
    assert.match(nested.stderr, /unsafe worktree path.*registered checkout/);
    assert.ok(!refExists(registered.repo, "refs/heads/lane/registered-descendant"));

    const foreign = makeFixture();
    fixtures.push(foreign);
    const other = join(foreign.root, "other-repository");
    gitExec(["init", "-b", "main", other], { stdio: "ignore" });
    foreign.env.LANE_WORKTREE_ROOT = join(other, "nested-worktrees");
    const otherRepo = lane(foreign, ["open", "foreign-descendant"]);
    assert.equal(otherRepo.status, 1);
    assert.match(otherRepo.stderr, /unsafe worktree path.*another repository/);
    assert.ok(!refExists(foreign.repo, "refs/heads/lane/foreign-descendant"));
    negativeControl("realpath and checkout descendant guards");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("registered paths are rejected when their on-disk repository identity changes", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "swapped-owner");
    const original = `${path}-original`;
    execFileSync("mv", [path, original]);
    const foreign = join(fixture.root, "foreign-checkout");
    gitExec(["init", "-b", "main", foreign], { stdio: "ignore" });
    symlinkSync(foreign, path);
    const run = lane(fixture, ["status"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /registered worktree .* does not belong to canonical git common directory/);
    negativeControl("registered worktree ownership verification");
  } finally {
    fixture.cleanup();
  }
});

test("a missing registered worktree names git worktree prune", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "missing-registration");
    renameSync(path, `${path}-moved`);
    const run = lane(fixture, ["status"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /registered worktree .* is missing; run git worktree prune/);
    assert.doesNotMatch(run.stderr, /does not belong to canonical git common directory/);
    negativeControl("missing registered worktree guidance");
  } finally {
    fixture.cleanup();
  }
});

test("stale Herdr checkout metadata is not used for dispatch or close", () => {
  const dispatchFixture = makeFixture();
  const closeFixture = makeFixture();
  try {
    ignoreLaneState(dispatchFixture);
    const dispatchPath = openLane(dispatchFixture, "stale-dispatch");
    const dispatchFake = writeFakeHerdr(dispatchFixture, {
      lanePath: dispatchPath,
      branch: "lane/stale-dispatch",
      staleId: "w-stale",
      staleLabel: "root/repo:lane-stale-dispatch",
      foreignRepoKey: join(dispatchFixture.root, "foreign.git"),
      noRepair: true,
    });
    const dispatched = lane(dispatchFixture, ["dispatch", "stale-dispatch", "do not send"]);
    assert.equal(dispatched.status, 1);
    assert.match(dispatched.stderr, /Herdr workspace w-stale.*repository identity mismatch/);
    assert.ok(!dispatchFake.calls().some((args) => args[0] === "tab" && args[1] === "create"));

    const closePath = openLane(closeFixture, "stale-close");
    const closeFake = writeFakeHerdr(closeFixture, {
      lanePath: closePath,
      branch: "lane/stale-close",
      staleId: "w-stale",
      staleLabel: "root/repo:lane-stale-close",
      foreignRepoKey: join(closeFixture.root, "foreign.git"),
      noRepair: true,
    });
    const closed = lane(closeFixture, ["close", "stale-close"]);
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(
      closed.stderr,
      `lane: note: Herdr metadata for ${closePath} does not match this repository; removed the worktree with git only\n`,
    );
    assert.ok(!closeFake.calls().some((args) => args[0] === "worktree" && args[1] === "remove"));
    assert.ok(!existsSync(closePath));
    negativeControl("stale Herdr path identity refusal");
  } finally {
    dispatchFixture.cleanup();
    closeFixture.cleanup();
  }
});

test("linked invocation creates labeled children under the canonical repository workspace", () => {
  const fixture = makeFixture(undefined, { repoParts: ["repo", "repo"] });
  try {
    const caller = join(fixture.root, "caller-lane");
    git(fixture.repo, ["worktree", "add", "-b", "lane/caller", caller], { stdio: "ignore" });
    const path = lanePath(fixture, "child-topic");
    const fake = writeFakeHerdr(fixture, {
      callerPath: caller,
      lanePath: path,
      branch: "lane/child-topic",
    });
    const opened = lane(fixture, ["open", "child-topic"], { cwd: caller });
    assert.equal(opened.status, 0, opened.stderr);
    const controls = fake.calls().filter((args) => args[0] === "worktree" && ["create", "open"].includes(args[1]));
    assert.ok(controls.length >= 2);
    for (const args of controls) {
      assert.equal(args[args.indexOf("--workspace") + 1], "w-parent");
      assert.notEqual(args[args.indexOf("--workspace") + 1], "w-caller");
      assert.equal(args[args.indexOf("--label") + 1], "repo/repo:lane-child-topic");
    }
    assert.equal(
      fake.calls().filter((args) => args[0] === "workspace" && args[1] === "list").length,
      2,
    );
    negativeControl("canonical Herdr parent and labeled child");
  } finally {
    fixture.cleanup();
  }
});

test("open refreshes Herdr workspaces after a failed create before accepting fallback metadata", () => {
  const fixture = makeFixture();
  try {
    const path = lanePath(fixture, "fallback-refresh");
    const fake = writeFakeHerdr(fixture, {
      lanePath: path,
      branch: "lane/fallback-refresh",
      failedCreateOpened: true,
    });
    const opened = lane(fixture, ["open", "fallback-refresh"]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, /herdr workspace: w-lane/);
    assert.equal(
      fake.calls().filter((args) => args[0] === "worktree" && args[1] === "open").length,
      0,
    );
    assert.equal(
      fake.calls().filter((args) => args[0] === "workspace" && args[1] === "list").length,
      2,
    );
    negativeControl("failed-create workspace refresh");
  } finally {
    fixture.cleanup();
  }
});

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
      routes: { engineer: { kind: "codex", model: "engineer-model" } },
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
    const dispatched = lane(fixture, ["dispatch", "occupant-evidence", "Brief text"], { cwd: path });
    assert.equal(dispatched.status, 0, dispatched.stderr);
    const { loadRegistry } = await registryApi();
    const [session] = loadRegistry(fixture.repo, { registry: ".lane/sessions.json" }).sessions;
    assert.equal(session.agent_session_id, "fixture-session-1");
    assert.equal(session.terminal_id, "fixture-terminal-1");
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

test("one exported Herdr socket-path helper supplies the board client and dispatch records", async () => {
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

test("board completion refuses unignored and external registry writes", async () => {
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

test("close warns and succeeds when registry policy refuses automated metadata", () => {
  const scenarios = [
    {
      topic: "external-close-registry",
      configure(fixture) {
        const registry = join(fixture.root, "external-sessions.json");
        writeConfig(fixture, { main: "main", validate: "true", registry });
        writeFileSync(registry, "[]\n");
      },
      expected: /repository-local registry/u,
    },
    {
      topic: "unignored-close-registry",
      configure(fixture) {
        mkdirSync(join(fixture.repo, ".lane"), { recursive: true });
        writeFileSync(join(fixture.repo, ".lane", "sessions.json"), "[]\n");
      },
      expected: /registry.*gitignored/u,
    },
    {
      topic: "tracked-close-registry",
      configure(fixture) {
        ignoreLaneState(fixture);
        mkdirSync(join(fixture.repo, ".lane"), { recursive: true });
        writeFileSync(join(fixture.repo, ".lane", "sessions.json"), "[]\n");
        git(fixture.repo, ["add", "-f", ".lane/sessions.json"]);
        git(fixture.repo, ["commit", "-m", "track registry"], { stdio: "ignore" });
      },
      expected: /registry.*tracked/u,
    },
  ];
  for (const scenario of scenarios) {
    const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
    try {
      scenario.configure(fixture);
      const path = openLane(fixture, scenario.topic);
      const closed = lane(fixture, ["close", scenario.topic]);
      assert.equal(closed.status, 0, closed.stderr);
      assert.match(closed.stderr, /warning: session registry/u);
      assert.match(closed.stderr, scenario.expected);
      assert.doesNotMatch(closed.stderr, /lane closed; metadata update failed/u);
      assert.ok(!existsSync(path));
      assert.ok(!refExists(fixture.repo, `refs/heads/lane/${scenario.topic}`));
    } finally {
      fixture.cleanup();
    }
  }
  negativeControl("close policy refusal warning boundary");
});

test("close marks exact repository topic sessions done only after git close succeeds", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    ignoreLaneState(fixture);
    const path = openLane(fixture, "close-sessions");
    const otherPath = openLane(fixture, "other-topic");
    writeFakeHerdr(fixture, { lanePath: path, branch: "lane/close-sessions", initiallyOpened: true });
    assert.equal(lane(fixture, ["dispatch", "close-sessions", "first"]).status, 0);
    assert.equal(lane(fixture, ["dispatch", "close-sessions", "second"]).status, 0);
    writeFakeHerdr(fixture, { lanePath: otherPath, branch: "lane/other-topic", initiallyOpened: true });
    assert.equal(lane(fixture, ["dispatch", "other-topic", "other"]).status, 0);
    const { loadRegistry } = await registryApi();
    writeFileSync(join(fixture.repo, ".lane", "sessions.json.d", "unrelated-malformed.json"), "{\n");
    writeFileSync(join(path, "dirty.txt"), "dirty\n");
    const refused = lane(fixture, ["close", "close-sessions"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /lane worktree is not clean/u);
    assert.ok(loadRegistry(fixture.repo, { registry: ".lane/sessions.json" }).sessions.every((session) => !session.done));
    rmSync(join(path, "dirty.txt"));
    writeFakeHerdr(fixture, { lanePath: path, branch: "lane/close-sessions", initiallyOpened: true });
    const closed = lane(fixture, ["close", "close-sessions"]);
    assert.equal(closed.status, 0, closed.stderr);
    assert.match(closed.stderr, /warning: session registry.*unrelated-malformed\.json/u);
    const sessions = loadRegistry(fixture.repo, { registry: ".lane/sessions.json" }).sessions;
    assert.ok(sessions.filter((session) => session.topic === "close-sessions").every((session) => session.done));
    assert.ok(sessions.filter((session) => session.topic === "other-topic").every((session) => !session.done));
    assert.ok(!refExists(fixture.repo, "refs/heads/lane/close-sessions"));
    negativeControl("close completion ordering");
  } finally {
    fixture.cleanup();
  }
});

test("failed archive and post-close metadata writes preserve honest completion state", async () => {
  const archiveFixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  const metadataFixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    ignoreLaneState(archiveFixture);
    const archivePath = openLane(archiveFixture, "archive-failure");
    commitFile(archivePath, "lane-change.txt", "unmerged\n", "leave lane unmerged");
    writeFakeHerdr(archiveFixture, { lanePath: archivePath, branch: "lane/archive-failure", initiallyOpened: true });
    assert.equal(lane(archiveFixture, ["dispatch", "archive-failure", "archive me"]).status, 0);
    git(archiveFixture.repo, ["tag", "archive/lane/archive-failure", "lane/archive-failure"]);
    const archiveClose = lane(archiveFixture, ["close", "archive-failure"]);
    assert.equal(archiveClose.status, 1);
    assert.ok(refExists(archiveFixture.repo, "refs/heads/lane/archive-failure"));
    const { loadRegistry } = await registryApi();
    assert.ok(loadRegistry(archiveFixture.repo).sessions.every((session) => !session.done));

    ignoreLaneState(metadataFixture);
    const metadataPath = openLane(metadataFixture, "metadata-failure");
    commitFile(metadataPath, "lane-change.txt", "unmerged\n", "leave lane unmerged");
    writeFakeHerdr(metadataFixture, {
      lanePath: metadataPath,
      branch: "lane/metadata-failure",
      initiallyOpened: true,
    });
    assert.equal(lane(metadataFixture, ["dispatch", "metadata-failure", "record me"]).status, 0);
    const metadataRegistry = join(metadataFixture.repo, ".lane", "sessions.json");
    const [metadataSession] = loadRegistry(metadataFixture.repo).sessions;
    mkdirSync(join(`${metadataRegistry}.d`, `${metadataSession.session_id}.done.json`));
    const metadataClose = lane(metadataFixture, ["close", "metadata-failure"]);
    assert.equal(metadataClose.status, 1);
    assert.match(metadataClose.stderr, /lane closed; metadata update failed/u);
    assert.ok(!existsSync(metadataPath));
    assert.ok(!refExists(metadataFixture.repo, "refs/heads/lane/metadata-failure"));
    assert.ok(refExists(metadataFixture.repo, "refs/tags/archive/lane/metadata-failure"));
    assert.equal(loadRegistry(metadataFixture.repo).sessions[0].done, false);
    negativeControl("archive and post-close metadata failure boundaries");
  } finally {
    archiveFixture.cleanup();
    metadataFixture.cleanup();
  }
});

test("relative reports resolve in the lane checkout before canonical post-close fallback", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "report-resolution");
    const report = "docs/reports/report-resolution.md";
    mkdirSync(join(path, "docs", "reports"), { recursive: true });
    mkdirSync(join(fixture.repo, "docs", "reports"), { recursive: true });
    writeFileSync(join(path, report), "**PASS**\n");
    writeFileSync(join(fixture.repo, report), "**FAIL**\n");
    const sessions = [{ lane: "lane/report-resolution", report }];
    assert.equal(collectReportStates(fixture.repo, sessions).get(report).verdict, "PASS");
    rmSync(join(path, report));
    assert.equal(collectReportStates(fixture.repo, sessions).get(report).verdict, "FAIL");
    negativeControl("lane-first report resolution");
  } finally {
    fixture.cleanup();
  }
});

test("git-only close with no registry creates no metadata store", () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    const path = openLane(fixture, "no-registry-close");
    const closed = lane(fixture, ["close", "no-registry-close"]);
    assert.equal(closed.status, 0, closed.stderr);
    assert.ok(!existsSync(path));
    assert.ok(!existsSync(join(fixture.repo, ".lane")));
    negativeControl("close without registry metadata");
  } finally {
    fixture.cleanup();
  }
});

test("a repository with a separate git directory retains its canonical checkout identity", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-lanes-separate-test-")));
  const repo = join(root, "working", "repository");
  const gitDirectory = join(root, "metadata", "repository.git");
  const bin = join(root, "bin");
  const configPath = join(root, "lane.json");
  const worktrees = join(root, "worktrees");
  mkdirSync(dirname(repo), { recursive: true });
  mkdirSync(dirname(gitDirectory), { recursive: true });
  mkdirSync(bin);
  symlinkSync(GIT, join(bin, "git"));
  symlinkSync(HEAD, join(bin, "head"));
  gitExec(["init", "-b", "main", "--separate-git-dir", gitDirectory, repo], { stdio: "ignore" });
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git(repo, ["add", "shared.txt"]);
  git(repo, ["commit", "-m", "initial"], { stdio: "ignore" });
  writeFileSync(configPath, `${JSON.stringify({ main: "main", validate: "true" })}\n`);
  const fixture = {
    root, repo, bin, configPath, worktrees,
    env: { ...hermeticGitEnvironment(), PATH: bin, LANE_CONFIG: configPath, LANE_WORKTREE_ROOT: worktrees },
  };
  try {
    const opened = lane(fixture, ["open", "separate-directory"]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, new RegExp(`canonical checkout: ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(opened.stdout, new RegExp(`repository identity: ${realpathSync(gitDirectory).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.ok(existsSync(join(worktrees, "lane-separate-directory")));
    negativeControl("separate git directory canonical checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected malformed, unreadable, and wrongly typed config files fail before mutation", () => {
  const fixtures = [];
  try {
    const malformed = makeFixture();
    fixtures.push(malformed);
    const malformedPath = join(malformed.repo, ".lane.json");
    writeFileSync(malformedPath, "{ malformed\n");
    const malformedRun = lane(malformed, ["open", "malformed-config"], { env: discoveredEnv(malformed) });
    assert.equal(malformedRun.status, 1);
    assert.match(malformedRun.stderr, new RegExp(`invalid lane config .*${malformedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.ok(!refExists(malformed.repo, "refs/heads/lane/malformed-config"));

    const typed = makeFixture();
    fixtures.push(typed);
    const typedPath = join(typed.repo, ".lane.json");
    writeFileSync(typedPath, `${JSON.stringify({ prepare: "npm ci" })}\n`);
    const typedRun = lane(typed, ["open", "typed-config"], { env: discoveredEnv(typed) });
    assert.equal(typedRun.status, 1);
    assert.match(typedRun.stderr, /invalid lane config .*prepare must be an array/);
    assert.ok(!refExists(typed.repo, "refs/heads/lane/typed-config"));

    const unreadable = makeFixture();
    fixtures.push(unreadable);
    const directory = join(unreadable.repo, "config-directory");
    mkdirSync(directory);
    const unreadableRun = lane(unreadable, ["open", "unreadable-config"], {
      env: discoveredEnv(unreadable, { LANE_CONFIG: directory }),
    });
    assert.equal(unreadableRun.status, 1);
    assert.match(unreadableRun.stderr, /cannot read lane config/);
    assert.ok(!refExists(unreadable.repo, "refs/heads/lane/unreadable-config"));

    const missing = makeFixture();
    fixtures.push(missing);
    const missingPath = join(missing.repo, "missing.json");
    const missingRun = lane(missing, ["config"], {
      env: discoveredEnv(missing, { LANE_CONFIG: missingPath }),
    });
    assert.equal(missingRun.status, 1);
    assert.match(missingRun.stderr, /cannot read lane config/);
    negativeControl("invalid selected config refusal");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("open refuses ordinary and foreign-worktree destinations without creating branches", () => {
  const fixture = makeFixture();
  try {
    const ordinaryPath = lanePath(fixture, "occupied-directory");
    mkdirSync(ordinaryPath, { recursive: true });
    const sentinel = join(ordinaryPath, "keep.txt");
    writeFileSync(sentinel, "preserve\n");
    const ordinary = lane(fixture, ["open", "occupied-directory"]);
    assert.equal(ordinary.status, 1);
    assert.match(ordinary.stderr, /worktree path already exists/);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve\n");
    assert.ok(!refExists(fixture.repo, "refs/heads/lane/occupied-directory"));

    writeConfig(fixture, {
      main: "main",
      validate: "true",
      worktree_root: join(fixture.root, "shared-base"),
    });
    delete fixture.env.LANE_WORKTREE_ROOT;
    const foreignRepo = join(fixture.root, "foreign-repo");
    const foreignPath = join(fixture.root, "shared-base", "repo", "lane-foreign-worktree");
    gitExec(["init", "-b", "main", foreignRepo], { stdio: "ignore" });
    writeFileSync(join(foreignRepo, "foreign.txt"), "foreign\n");
    git(foreignRepo, ["add", "foreign.txt"]);
    git(foreignRepo, ["commit", "-m", "foreign initial"], { stdio: "ignore" });
    git(foreignRepo, ["worktree", "add", "-b", "foreign-lane", foreignPath], { stdio: "ignore" });
    const foreignHead = git(foreignPath, ["rev-parse", "HEAD"]);
    const foreign = lane(fixture, ["open", "foreign-worktree"]);
    assert.equal(foreign.status, 1);
    assert.match(foreign.stderr, new RegExp(`worktree path belongs to another repository: ${foreignPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(foreign.stderr, /choose distinct worktree bases/);
    assert.equal(git(foreignPath, ["rev-parse", "HEAD"]), foreignHead);
    assert.ok(!refExists(fixture.repo, "refs/heads/lane/foreign-worktree"));
    negativeControl("occupied foreign path refusal");
  } finally {
    fixture.cleanup();
  }
});

test("registered legacy lane paths remain authoritative after worktree_root changes", () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    const originalPath = openLane(fixture, "legacy-location");
    writeConfig(fixture, { main: "main", validate: "true", worktree_root: join(fixture.root, "new-root") });
    delete fixture.env.LANE_WORKTREE_ROOT;

    const status = lane(fixture, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(originalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const dispatch = lane(fixture, ["dispatch", "legacy-location"]);
    assert.equal(dispatch.status, 1);
    assert.match(dispatch.stderr, /herdr is unavailable/);
    assert.doesNotMatch(dispatch.stderr, /has no worktree/);
    const check = lane(fixture, ["check", "--cmd", "true"], { cwd: originalPath });
    assert.equal(check.status, 0, check.stderr);
    commitFile(originalPath, "lane.txt", "lane\n", "legacy lane change");
    const promote = lane(fixture, ["promote", "legacy-location"]);
    assert.equal(promote.status, 0, promote.stderr);
    const close = lane(fixture, ["close", "legacy-location"]);
    assert.equal(close.status, 0, close.stderr);
    assert.ok(!existsSync(originalPath));
    negativeControl("registered legacy paths remain authoritative");
  } finally {
    fixture.cleanup();
  }
});

test("board --once renders a plain registered-session table without Herdr", () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    mkdirSync(join(fixture.repo, ".lane"));
    writeFileSync(join(fixture.repo, ".lane", "sessions.json"), `${JSON.stringify([{
      name: "offline-agent",
      workspace: "lane-offline",
      lane: "offline",
      role: "reviewer",
      report: "reports/offline.md",
      deadline: null,
      done: false,
    }], null, 2)}\n`);
    fixture.env.HERDR_SOCKET_PATH = join(fixture.root, "missing.sock");
    const run = lane(fixture, ["board", "--once"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /NAME\s+ROLE\s+LANE\s+STATUS\s+PANE/);
    assert.match(run.stdout, /offline-agent\s+reviewer\s+offline\s+offline/);
    assert.match(run.stdout, /load .* workers/);
    negativeControl("plain lane board");
  } finally {
    fixture.cleanup();
  }
});

test("board --once names the missing registry path", () => {
  const fixture = makeFixture();
  try {
    fixture.env.HERDR_SOCKET_PATH = join(fixture.root, "missing.sock");
    const run = lane(fixture, ["board", "--once"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /registry not found: .*\.lane\/sessions\.json/);
    negativeControl("missing board registry hint");
  } finally {
    fixture.cleanup();
  }
});

test("board uses inherited canonical registry configuration from a linked worktree", () => {
  const fixture = makeFixture(undefined, { repoParts: ["projects", "repo"] });
  try {
    writeFileSync(join(fixture.root, "projects", ".lane.json"), `${JSON.stringify({
      registry: ".lane/inherited-sessions.json",
    })}\n`);
    const registryDirectory = join(fixture.repo, ".lane");
    mkdirSync(registryDirectory);
    writeFileSync(join(registryDirectory, "inherited-sessions.json"), `${JSON.stringify([{
      name: "inherited-agent",
      workspace: "inherited-workspace",
      lane: "linked-board",
      role: "engineer",
      report: "reports/inherited.md",
      deadline: null,
      done: false,
    }])}\n`);
    const linked = join(fixture.root, "linked-board");
    git(fixture.repo, ["worktree", "add", "-b", "lane/linked-board", linked], { stdio: "ignore" });
    const env = discoveredEnv(fixture, { HERDR_SOCKET_PATH: join(fixture.root, "missing.sock") });
    const run = lane(fixture, ["board", "--once"], { cwd: linked, env });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /inherited-agent\s+engineer\s+linked-board\s+offline/);
    negativeControl("board canonical inherited config");
  } finally {
    fixture.cleanup();
  }
});

test("plain and JSON board projections resolve the same session context", () => {
  const reportTime = "2026-09-09T12:00:00.000Z";
  const head = "a".repeat(40);
  const session = {
    session_id: "12345678-1234-4123-8123-123456789abc",
    lane: "shared-context",
    name: "shared-agent",
    workspace: "shared-workspace",
    report: "reports/shared.md",
    role: "engineer",
    deadline: null,
    done: false,
  };
  const snapshot = {
    workspaces: [{
      workspace_id: "workspace-1",
      label: "shared-workspace",
      worktree: { checkout_path: "/repository/lane" },
    }],
    agents: [{
      name: "shared-agent",
      workspace_id: "workspace-1",
      pane_id: "pane-1",
      agent_status: "working",
    }],
    panes: [{ pane_id: "pane-1", tab_id: "tab-1" }],
  };
  const runtime = new Map([["pane-1", {
    messageText: "shared output",
    messageSource: "assistant-preview",
    messageKind: "codex",
    messageAvailable: true,
    tripwire: "shared tripwire",
    messageObservedAt: reportTime,
  }]]);
  const gitStates = new Map([["shared-context", {
    head,
    ahead: 2,
    behind: 1,
    dirty: true,
    available: true,
    gate: `exit=1 @${head.slice(0, 7)}`,
    gateColor: "red",
    gateState: "fail",
    gateHead: head,
    gateExitCode: 1,
    gateSignal: null,
  }]]);
  const reportStates = new Map([["reports/shared.md", {
    path: "/repository/reports/shared.md",
    mtime: reportTime,
    mtimeIso: reportTime,
    verdict: "PASS",
    reviewedHead: head,
  }]]);
  const state = {
    sessions: [session],
    snapshot,
    runtime,
    gitStates,
    reportStates,
    exists: true,
    errors: [],
    stats: { load: 0, freeMemoryBytes: 0, workers: {} },
  };
  const [plain] = joinBoardRows({
    registry: state.sessions,
    snapshot,
    runtime,
    gitStates,
    reportStates,
  });
  const [json] = boardSnapshotDocument({
    state,
    repoId: "repo-1",
    rootId: "root-1",
    repoRoot: "/repository",
    rootLabel: "root",
    repositoryLabel: "repository",
    laneBase: "/lanes/repository",
    capturedAt: new Date(reportTime),
  }).rows;
  assert.deepEqual({
    workspace: plain.workspace,
    pane: plain.pane,
    status: plain.status,
    output: plain.output,
    tripwire: plain.tripwire,
    git: plain.git,
    gate: plain.gate,
    report: plain.report,
    branch: plain.lane.startsWith("lane/") ? plain.lane : `lane/${plain.lane}`,
    tab_id: "tab-1",
  }, {
    workspace: json.workspace_id,
    pane: json.pane_id,
    status: json.status,
    output: json.last_message.text,
    tripwire: json.tripwire,
    git: `+${json.git.ahead}${json.git.dirty ? " DIRTY" : ""}`,
    gate: `exit=${json.gate.exit_code} @${json.gate.head.slice(0, 7)}`,
    report: `${json.report.verdict}@${json.report.mtime}`,
    branch: json.branch,
    tab_id: json.tab_id,
  });
  negativeControl("shared board session context");
});

test("board JSON snapshots expose schema v1 from canonical --repo config without UI dependencies or writes", async () => {
  const fixture = makeFixture(undefined, { repoParts: ["projects", "repo"] });
  let server;
  try {
    writeFileSync(join(fixture.repo, ".gitignore"), ".lane/\n");
    writeFileSync(join(fixture.repo, ".lane.json"), `${JSON.stringify({
      main: "main",
      registry: ".lane/board-sessions.json",
      worktree_root: "../worktrees",
    })}\n`);
    git(fixture.repo, ["add", ".gitignore", ".lane.json"]);
    git(fixture.repo, ["commit", "-m", "configure board fixture"], { stdio: "ignore" });
    const lanePath = join(fixture.root, "board-json-lane");
    git(fixture.repo, ["worktree", "add", "-b", "lane/board-json", lanePath], { stdio: "ignore" });
    mkdirSync(join(lanePath, "docs", "reviews"), { recursive: true });
    const reportPath = join(lanePath, "docs", "reviews", "board-json.md");
    const reviewedHead = "a".repeat(40);
    writeFileSync(reportPath, `**PASS**\nReviewed commit: ${reviewedHead}\n`);
    git(lanePath, ["add", "docs/reviews/board-json.md"]);
    git(lanePath, ["commit", "-m", "add board report"], { stdio: "ignore" });
    const finalHead = git(lanePath, ["rev-parse", "HEAD"]);
    mkdirSync(join(lanePath, ".lane"));
    writeFileSync(join(lanePath, ".lane", "gate.json"), `${JSON.stringify({
      head: finalHead,
      exit_code: 0,
      signal: null,
    })}\n`);
    const registryDirectory = join(fixture.repo, ".lane", "board-sessions.json.d");
    mkdirSync(registryDirectory, { recursive: true });
    const registryPath = join(registryDirectory, "12345678-1234-4123-8123-123456789abc.json");
    writeFileSync(registryPath, `${JSON.stringify({
      session_id: "12345678-1234-4123-8123-123456789abc",
      repo_id: repositoryIdentity(fixture.repo),
      root_id: join(fixture.root, "projects"),
      repo: fixture.repo,
      topic: "board-json",
      name: "board-agent",
      workspace: "workspace-1",
      pane: "pane-1",
      server: "local",
      agent_session_id: "fixture-board-session",
      terminal_id: "fixture-board-terminal",
      lane: "lane/board-json",
      role: "engineer",
      brief: "/source/board-json.md",
      goal: "Expose scriptable board observations",
      report: "docs/reviews/board-json.md",
      deadline: "2026-09-10T00:00:00.000Z",
      done: false,
      created_at: "2026-09-09T00:00:00.000Z",
      tripwires: ["TRIPWIRE"],
    })}\n`);
    const beforeRegistry = readFileSync(registryPath, "utf8");
    const beforeStatus = git(fixture.repo, ["status", "--porcelain=v1"]);

    server = await fakeBoardServer(fixture, ({ socket, request }) => {
      if (request.method === "session.snapshot") {
        socket.write(`${JSON.stringify({ id: request.id, result: boardSnapshotResult({ cwd: lanePath }) })}\n`);
      }
    });
    const env = discoveredEnv(fixture, { HERDR_SOCKET_PATH: server.socketPath });
    const run = laneProcess(fixture, ["board", "--json", "--repo", join("projects", "repo")], {
      cwd: fixture.root,
      env,
    });
    const result = await run.completed;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.schema_version, 1);
    assert.match(snapshot.captured_at, /^\d{4}-\d{2}-\d{2}T.*Z$/u);
    assert.deepEqual(snapshot.scope, {
      kind: "repository",
      repo_id: repositoryIdentity(fixture.repo),
      include_history: false,
    });
    assert.equal(snapshot.coverage.herdr, "connected");
    assert.equal(snapshot.coverage.registry, "available");
    assert.equal(snapshot.coverage.messages, "unavailable");
    assert.equal(snapshot.repositories.length, 1);
    assert.equal(snapshot.repositories[0].path, realpathSync(fixture.repo));
    assert.equal(snapshot.repositories[0].repo_id, repositoryIdentity(fixture.repo));
    assert.equal(snapshot.repositories[0].root_id, realpathSync(join(fixture.root, "projects")));
    assert.equal(snapshot.repositories[0].root_label, "projects");
    assert.equal(snapshot.repositories[0].repository_label, "repo");
    assert.equal(snapshot.repositories[0].lane_base, join(fixture.root, "projects", "worktrees", "repo"));
    assert.equal(snapshot.rows.length, 1);
    const [row] = snapshot.rows;
    assert.equal(row.row_id, "12345678-1234-4123-8123-123456789abc");
    assert.equal(row.repo_id, repositoryIdentity(fixture.repo));
    assert.equal(row.root_id, realpathSync(join(fixture.root, "projects")));
    assert.equal(row.server_id, "local");
    assert.equal(row.name, "board-agent");
    assert.equal(row.pane_id, "pane-1");
    assert.equal(row.workspace_id, "workspace-1");
    assert.equal(row.registered, true);
    assert.equal(row.topic, "board-json");
    assert.equal(row.branch, "lane/board-json");
    assert.equal(row.role, "engineer");
    assert.equal(row.goal, "Expose scriptable board observations");
    assert.deepEqual(row.brief, { path: "/source/board-json.md", excerpt: "Expose scriptable board observations" });
    assert.equal(row.status, "working");
    assert.equal(row.done, false);
    assert.deepEqual(row.git, { head: finalHead, ahead: 1, behind: 0, dirty: false, available: true });
    assert.deepEqual(row.gate, { state: "pass", head: finalHead, exit_code: 0, signal: null });
    assert.equal(row.report.path, reportPath);
    assert.match(row.report.mtime, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(row.report.verdict, "PASS");
    assert.equal(row.report.reviewed_head, reviewedHead);
    assert.equal(row.deadline, "2026-09-10T00:00:00.000Z");
    assert.equal(typeof row.overdue, "boolean");
    assert.deepEqual(row.last_message, {
      text: null,
      source: "unavailable",
      kind: null,
      observed_at: null,
      revision: null,
      truncated: false,
      stale: false,
      available: false,
      raw_excerpt: null,
      limitation: null,
    });
    assert.equal(row.tripwire, null);
    assert.equal(row.stale, false);
    assert.equal(typeof snapshot.host.load_1m, "number");
    assert.equal(typeof snapshot.host.free_memory_bytes, "number");
    assert.equal(snapshot.coverage.discovery, "partial");
    assert.deepEqual(snapshot.errors[0], {
      source: "discovery",
      message: "cannot enumerate local Herdr sessions: ENOENT",
    });
    assert.ok(snapshot.errors.some((error) =>
      error.source === "repository" && /cannot map Herdr worktrees: ENOENT/u.test(error.message)));
    assert.deepEqual(server.requests.map((request) => request.method), ["session.snapshot"]);
    assert.equal(readFileSync(registryPath, "utf8"), beforeRegistry);
    assert.equal(git(fixture.repo, ["status", "--porcelain=v1"]), beforeStatus);

    const second = laneProcess(fixture, ["board", "--json", "--repo", join("projects", "repo")], {
      cwd: fixture.root,
      env,
    });
    const secondResult = await second.completed;
    assert.equal(secondResult.status, 0, secondResult.stderr);
    assert.equal(JSON.parse(secondResult.stdout).rows[0].row_id, row.row_id);
    const reference = readFileSync(join(HERE, "..", "docs", "REFERENCE.md"), "utf8");
    assert.doesNotMatch(
      reference,
      /`last_message` and `tripwire` are unavailable outside `lane board --watch --json`/u,
    );
    assert.match(
      reference,
      /`tripwire` is unavailable outside `lane board --watch --json`/u,
    );
    negativeControl("board JSON schema, canonical repo, and observation-only behavior");
  } finally {
    if (server !== undefined) await server.close();
    fixture.cleanup();
  }
});

test("board one-shot and watch reads share bounded substantive message previews", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  let server;
  let watch;
  try {
    mkdirSync(join(fixture.repo, ".lane"));
    writeFileSync(join(fixture.repo, ".lane", "sessions.json"), `${JSON.stringify([{
      name: "board-agent",
      workspace: "workspace-1",
      lane: "board-message",
      role: "engineer",
      report: "docs/reports/board-message.md",
      deadline: null,
      done: false,
    }])}\n`);
    const firstText = [
      "• The parser keeps this substantive response.",
      "  It also keeps the wrapped detail.",
      "",
      "────────────────────────",
      "› Ask Codex to do anything",
      "model-name high · example",
    ].join("\n");
    const updatedText = [
      "• The parser keeps this updated response.",
      "",
      "────────────────────────",
      "› Ask Codex to do anything",
    ].join("\n");
    let readCount = 0;
    server = await fakeBoardServer(fixture, ({ socket, request }) => {
      if (request.method === "session.snapshot") {
        socket.write(`${JSON.stringify({ id: request.id, result: {
          type: "session_snapshot",
          snapshot: {
            protocol: 20,
            version: "test",
            agents: [{
              agent: "codex",
              agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "session-1" },
              agent_status: "working",
              cwd: fixture.repo,
              name: "board-agent",
              pane_id: "pane-1",
              revision: 7,
              tab_id: "tab-1",
              terminal_id: "terminal-1",
              workspace_id: "workspace-1",
            }],
            panes: [],
            workspaces: [{ workspace_id: "workspace-1", label: "workspace-1" }],
          },
        } })}\n`);
      } else if (request.method === "pane.read") {
        readCount += 1;
        const response = `${JSON.stringify({ id: request.id, result: {
          type: "pane_read",
          read: {
            pane_id: "pane-1",
            workspace_id: "workspace-1",
            tab_id: "tab-1",
            source: "recent_unwrapped",
            format: "text",
            text: readCount >= 4 ? updatedText : firstText,
            revision: 40 + readCount,
            truncated: false,
          },
        } })}\n`;
        setTimeout(() => socket.write(response), 650);
      } else if (request.method === "events.subscribe") {
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
        setTimeout(() => {
          socket.write(`${JSON.stringify({
            event: "pane.output_changed",
            data: { type: "pane_output_changed", pane_id: "pane-1", workspace_id: "workspace-1", revision: 99 },
          })}\n`);
          socket.write(`${JSON.stringify({
            event: "pane.output_changed",
            data: { type: "pane_output_changed", pane_id: "pane-1", workspace_id: "workspace-1", revision: 100 },
          })}\n`);
        }, 50);
      }
    });
    const env = { ...fixture.env, HERDR_SOCKET_PATH: server.socketPath };

    const plain = await laneProcess(fixture, ["board", "--once"], { env }).completed;
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /LAST MESSAGE/);
    assert.match(plain.stdout, /The parser keeps this subst/);
    assert.doesNotMatch(plain.stdout, /Ask Codex/);

    const oneShot = await laneProcess(fixture, ["board", "--json"], { env }).completed;
    assert.equal(oneShot.status, 0, oneShot.stderr);
    const oneShotMessage = JSON.parse(oneShot.stdout).rows[0].last_message;
    assert.deepEqual(oneShotMessage, {
      text: "The parser keeps this substantive response.\nIt also keeps the wrapped detail.",
      source: "assistant-preview",
      kind: "codex",
      observed_at: oneShotMessage.observed_at,
      revision: 42,
      truncated: false,
      stale: false,
      available: true,
      raw_excerpt: null,
      limitation: null,
    });

    watch = laneProcess(fixture, ["board", "--watch", "--json"], { env });
    await waitForCondition(
      () => watch.stdout().trim().split("\n").filter(Boolean).length >= 2,
      "updated substantive preview frame",
      8_000,
    );
    watch.child.kill("SIGTERM");
    const watched = await watch.completed;
    assert.equal(watched.status, 0, watched.stderr);
    const frames = watched.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(
      { ...frames[0].rows[0].last_message, observed_at: null, revision: null },
      { ...oneShotMessage, observed_at: null, revision: null },
    );
    assert.equal(frames.at(-1).rows[0].last_message.text, "The parser keeps this updated response.");
    const { rowsFromBoardDocument } = await import("../board/view.mjs");
    assert.equal(
      rowsFromBoardDocument(frames.at(-1))[0].output,
      "The parser keeps this updated response.",
    );
    const readRequests = server.requests.filter((request) => request.method === "pane.read");
    assert.equal(readRequests.length, 4);
    assert.ok(readRequests.every((request) => request.params.lines === 200));
    assert.ok(readRequests.every((request) => request.params.source === "recent_unwrapped"));
    assert.ok(readRequests.every((request) => request.params.format === "text"));
    assert.ok(readRequests.every((request) => request.params.strip_ansi === true));
    assert.equal(
      server.requests.filter((request) => request.method === "events.subscribe").length,
      1,
    );
    negativeControl("bounded one-shot and watch message parity");
  } finally {
    if (watch !== undefined) {
      if (watch.child.exitCode === null && watch.child.signalCode === null) watch.child.kill("SIGTERM");
      await watch.completed;
    }
    if (server !== undefined) await server.close();
    fixture.cleanup();
  }
});

test("machine watch status-only events emit status then coalesce a preview read", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  let server;
  let watch;
  try {
    let reads = 0;
    server = await fakeBoardServer(fixture, ({ socket, request }) => {
      if (request.method === "session.snapshot") {
        const result = boardSnapshotResult({ cwd: fixture.repo });
        Object.assign(result.snapshot.agents[0], {
          agent: "codex",
          agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "status-session" },
          terminal_id: "status-terminal",
        });
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      } else if (request.method === "pane.read") {
        reads += 1;
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "pane_read", read: {
          pane_id: "pane-1", source: "recent_unwrapped", format: "text",
          text: reads === 1 ? "• Before the status change\n" : "• After the status change\n",
          revision: reads, truncated: false,
        } } })}\n`);
      } else if (request.method === "events.subscribe") {
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
        for (const status of ["idle", "done"]) {
          socket.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: {
            pane_id: "pane-1", agent_status: status,
          } })}\n`);
        }
      }
    });
    watch = laneProcess(fixture, ["board", "--watch", "--json"], {
      env: { ...fixture.env, HERDR_SOCKET_PATH: server.socketPath },
    });
    await waitForCondition(() => reads >= 2, "status-triggered pane read", 4_500);
    await waitForCondition(() => watch.stdout().includes("After the status change"),
      "refreshed preview after status frame", 4_500);
    const frames = watch.stdout().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(frames[0].rows[0].last_message.text, "Before the status change");
    assert.ok(frames.some((frame) => frame.rows[0].status === "done" &&
      frame.rows[0].last_message.text === "Before the status change"));
    assert.equal(frames.at(-1).rows[0].last_message.text, "After the status change");
    assert.equal(reads, 2);
    negativeControl("status-only coalesced pane preview read");
  } finally {
    if (watch !== undefined) {
      if (watch.child.exitCode === null && watch.child.signalCode === null) watch.child.kill("SIGTERM");
      await watch.completed;
    }
    if (server !== undefined) await server.close();
    fixture.cleanup();
  }
});

test("machine watch drains a coalesced status preview after a delayed collection", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  let server;
  let watch;
  let delayedTimer;
  try {
    let reads = 0;
    let delayedReadPending = false;
    let overlappingCollections = 0;
    let statusSent = false;
    let currentStatus = "working";
    let subscriptionSocket;
    const paneReadResponse = (request, text) => `${JSON.stringify({ id: request.id, result: {
      type: "pane_read", read: {
        pane_id: "pane-1", source: "recent_unwrapped", format: "text",
        text: `• ${text}\n`, revision: reads, truncated: false,
      },
    } })}\n`;
    server = await fakeBoardServer(fixture, ({ socket, request }) => {
      if (request.method === "session.snapshot") {
        if (delayedReadPending) overlappingCollections += 1;
        const result = boardSnapshotResult({ status: currentStatus, cwd: fixture.repo });
        Object.assign(result.snapshot.agents[0], {
          agent: "codex",
          agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "delayed-session" },
          terminal_id: "delayed-terminal",
        });
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      } else if (request.method === "pane.read") {
        reads += 1;
        if (reads === 2) {
          delayedReadPending = true;
          statusSent = true;
          currentStatus = "done";
          subscriptionSocket.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: {
            pane_id: "pane-1", agent_status: "done",
          } })}\n`);
          delayedTimer = setTimeout(() => {
            delayedReadPending = false;
            socket.write(paneReadResponse(request, "Old answer"));
          }, 1_600);
        } else {
          socket.write(paneReadResponse(request, reads >= 3 ? "New answer" : "Old answer"));
        }
      } else if (request.method === "events.subscribe") {
        subscriptionSocket = socket;
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
        socket.write(`${JSON.stringify({ event: "pane.output_changed", data: { pane_id: "pane-1" } })}\n`);
      }
    });
    watch = laneProcess(fixture, ["board", "--watch", "--json"], {
      env: { ...fixture.env, HERDR_SOCKET_PATH: server.socketPath },
    });
    await waitForCondition(() => statusSent, "status event during a delayed collection", 4_000);
    await waitForCondition(() => reads >= 3 && watch.stdout().includes("New answer"),
      "drained status preview before the periodic refresh", 3_300);
    const frames = watch.stdout().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(frames.some((frame) => frame.rows[0].status === "done" &&
      frame.rows[0].last_message.text === "Old answer"));
    assert.equal(frames.at(-1).rows[0].last_message.text, "New answer");
    assert.equal(reads, 3);
    assert.equal(overlappingCollections, 0);
    negativeControl("status preview demand drains after delayed collection without overlap");
  } finally {
    if (delayedTimer !== undefined) clearTimeout(delayedTimer);
    if (watch !== undefined) {
      if (watch.child.exitCode === null && watch.child.signalCode === null) watch.child.kill("SIGTERM");
      await watch.completed;
    }
    if (server !== undefined) await server.close();
    fixture.cleanup();
  }
});

test("plain board output reports localized message read notices", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  let server;
  try {
    mkdirSync(join(fixture.repo, ".lane"));
    writeFileSync(join(fixture.repo, ".lane", "sessions.json"), `${JSON.stringify([{
      name: "board-agent",
      workspace: "workspace-1",
      lane: "board-message-error",
      role: "engineer",
      report: "docs/reports/board-message-error.md",
      deadline: null,
      done: false,
    }])}\n`);
    server = await fakeBoardServer(fixture, ({ socket, request }) => {
      if (request.method === "session.snapshot") {
        socket.write(`${JSON.stringify({ id: request.id, result: {
          type: "session_snapshot",
          snapshot: {
            protocol: 20,
            version: "test",
            agents: [{
              agent: "codex",
              name: "board-agent",
              pane_id: "pane-1",
              workspace_id: "workspace-1",
              agent_status: "working",
            }],
            panes: [],
            workspaces: [{ workspace_id: "workspace-1", label: "workspace-1" }],
          },
        } })}\n`);
      } else if (request.method === "pane.read") {
        socket.write(`${JSON.stringify({
          id: request.id,
          error: { code: "unsupported", message: "pane.read unavailable" },
        })}\n`);
      }
    });
    const env = { ...fixture.env, HERDR_SOCKET_PATH: server.socketPath };
    const plain = await laneProcess(fixture, ["board", "--once"], { env }).completed;
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /message notice: pane-1: Herdr unsupported: pane\.read unavailable/);
    const json = await laneProcess(fixture, ["board", "--json"], { env }).completed;
    assert.equal(json.status, 0, json.stderr);
    const errors = JSON.parse(json.stdout).errors;
    assert.deepEqual(errors[0], {
      source: "message",
      server_id: errors[0].server_id,
      message: "pane-1: Herdr unsupported: pane.read unavailable",
    });
    assert.match(errors[0].server_id, /^local-[0-9a-f]{12}$/u);
    assert.deepEqual(errors[1], {
      source: "discovery",
      message: "cannot enumerate local Herdr sessions: ENOENT",
    });
    negativeControl("plain message error notices");
  } finally {
    if (server !== undefined) await server.close();
    fixture.cleanup();
  }
});

test("message report and handoff record measurements at the reviewed commit", () => {
  const report = readFileSync(join(HERE, "..", "docs", "reports", "board-messages.md"), "utf8");
  const handoff = readFileSync(join(HERE, "..", "HANDOFF.md"), "utf8");
  assert.match(report, /reviewed commit[^.]*134\/134[^.]*134 deliberate/isu);
  assert.match(handoff, /reviewed commit[^.]*134\/134[^.]*134 deliberate/isu);
  negativeControl("reviewed-commit message counts");
});

test("plain and JSON board reads run from an isolated built-ins-only tool copy", () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    mkdirSync(join(fixture.repo, ".lane"));
    writeFileSync(join(fixture.repo, ".lane", "sessions.json"), "[]\n");
    const tool = join(fixture.root, "tool");
    mkdirSync(join(tool, "board"), { recursive: true });
    copyFileSync(LANE, join(tool, "lane.mjs"));
    for (const file of [
      "actions.mjs",
      "board.mjs",
      "herdr-client.mjs",
      "inventory.mjs",
      "message-preview.mjs",
      "registry.mjs",
      "view.mjs",
    ]) {
      copyFileSync(resolve(HERE, "..", "board", file), join(tool, "board", file));
    }
    assert.equal(existsSync(join(tool, "board", "node_modules")), false);
    const options = {
      executable: join(tool, "lane.mjs"),
      env: { ...fixture.env, HERDR_SOCKET_PATH: join(fixture.root, "missing.sock") },
    };
    const plain = lane(fixture, ["board", "--once"], options);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /^lane board \(offline\)/u);
    const json = lane(fixture, ["board", "--json"], options);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).schema_version, 1);
    negativeControl("dependency-free board reads");
  } finally {
    fixture.cleanup();
  }
});

test("board read modes reject contradictory, duplicate, unknown, extra, and missing options before observation", () => {
  const fixture = makeFixture();
  try {
    const invalid = [
      ["--once", "--json"],
      ["--once", "--once"],
      ["--watch"],
      ["--watch", "--json", "--once"],
      ["--json", "--json"],
      ["--watch", "--json", "--watch"],
      ["--json", "--unknown"],
      ["--json", "extra"],
      ["--json", "--repo"],
      ["--json", "--repo", "--watch"],
      ["--json", "--repo", fixture.repo, "--repo", fixture.repo],
    ];
    for (const args of invalid) {
      const run = lane(fixture, ["board", ...args]);
      assert.equal(run.status, 1, `${args.join(" ")}\n${run.stderr}`);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /^lane: usage: lane board/u);
    }
    const notRepository = join(fixture.root, "not-a-repository");
    mkdirSync(notRepository);
    const invalidRepo = lane(fixture, ["board", "--json", "--repo", notRepository]);
    assert.equal(invalidRepo.status, 1);
    assert.equal(invalidRepo.stdout, "");
    assert.equal(invalidRepo.stderr, "lane: not inside a git repository\n");

    const malformedGitfile = join(fixture.root, "malformed-gitfile");
    mkdirSync(malformedGitfile);
    writeFileSync(join(malformedGitfile, ".git"), "not a gitfile\n");
    const malformed = lane(fixture, ["board", "--json", "--repo", malformedGitfile]);
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stdout, "");
    assert.match(
      malformed.stderr,
      /^lane: not inside a git repository\nfatal: invalid gitfile format:/u,
    );
    negativeControl("board read option validation");
  } finally {
    fixture.cleanup();
  }
});

test("board JSON localizes observation errors without corrupting documents and fails closed on registry service errors", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  let server;
  try {
    mkdirSync(join(fixture.repo, ".lane"));
    writeFileSync(join(fixture.repo, ".lane", "sessions.json"), "[]\n");
    server = await fakeBoardServer(fixture, ({ socket, request }) => {
      socket.write(`${JSON.stringify({
        id: request.id,
        error: { code: "unavailable", message: "snapshot refused" },
      })}\n`);
    });
    const liveError = laneProcess(fixture, ["board", "--json"], {
      env: { ...fixture.env, HERDR_SOCKET_PATH: server.socketPath },
    });
    const liveResult = await liveError.completed;
    assert.equal(liveResult.status, 0, liveResult.stderr);
    assert.equal(liveResult.stdout.trim().split("\n").length, 1);
    const snapshot = JSON.parse(liveResult.stdout);
    assert.equal(snapshot.coverage.herdr, "unavailable");
    assert.deepEqual(snapshot.errors, [
      { source: "discovery", message: "cannot enumerate local Herdr sessions: ENOENT" },
      {
        source: "herdr",
        server_id: snapshot.coverage.servers[0].server_id,
        message: "Herdr unavailable: snapshot refused",
      },
    ]);

    writeFileSync(join(fixture.repo, ".lane", "sessions.json"), "{}\n");
    const registryError = lane(fixture, ["board", "--json"], {
      env: { ...fixture.env, HERDR_SOCKET_PATH: join(fixture.root, "missing.sock") },
    });
    assert.equal(registryError.status, 0, registryError.stderr);
    const isolated = JSON.parse(registryError.stdout);
    assert.equal(isolated.rows.length, 0);
    assert.ok(isolated.errors.some((error) =>
      error.source === "registry" && /registry must be a JSON array/u.test(error.message)));
    negativeControl("board read service errors");
  } finally {
    if (server !== undefined) await server.close();
    fixture.cleanup();
  }
});

test("board JSON watch frames event snapshots and stops pending refresh, reconnect, and closed consumers", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  let server;
  const boardWatches = [];
  try {
    mkdirSync(join(fixture.repo, ".lane"));
    const registryPath = join(fixture.repo, ".lane", "sessions.json");
    writeFileSync(registryPath, `${JSON.stringify([{
      name: "board-agent",
      workspace: "workspace-1",
      lane: "board-watch",
      role: "engineer",
      report: "docs/reports/board-watch.md",
      deadline: null,
      done: false,
    }])}\n`);
    const registryBefore = readFileSync(registryPath, "utf8");
    server = await fakeBoardServer(fixture, ({ socket, request }) => {
      if (request.method === "session.snapshot") {
        socket.write(`${JSON.stringify({ id: request.id, result: boardSnapshotResult({ cwd: fixture.repo }) })}\n`);
      } else if (request.method === "events.subscribe") {
        const frames = `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n` +
          `${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "pane-1", agent_status: "done" } })}\n` +
          `${JSON.stringify({ event: "pane.output_matched", data: { pane_id: "pane-1", matched_line: "finished" } })}\n`;
        socket.write(frames.slice(0, 11));
        setTimeout(() => socket.write(frames.slice(11)), 10);
      }
    });
    const watch = laneProcess(fixture, ["board", "--watch", "--json"], {
      env: { ...fixture.env, HERDR_SOCKET_PATH: server.socketPath },
    });
    boardWatches.push(watch);
    await waitForCondition(
      () => watch.stdout().trim().split("\n").filter(Boolean).length >= 3,
      "three JSON watch frames",
      8_000,
    );
    watch.child.kill("SIGTERM");
    const watched = await watch.completed;
    assert.equal(watched.status, 0, watched.stderr);
    assert.equal(watched.stderr, "");
    const frames = watched.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(frames.length >= 3);
    assert.ok(frames.every((frame) => frame.schema_version === 1));
    assert.equal(frames.at(-1).rows[0].status, "done");
    assert.deepEqual(frames.at(-1).rows[0].last_message, {
      text: null,
      source: "unavailable",
      kind: null,
      observed_at: null,
      revision: null,
      truncated: false,
      stale: false,
      available: false,
      raw_excerpt: null,
      limitation: null,
    });
    assert.deepEqual(server.requests.map((request) => request.method), [
      "session.snapshot",
      "events.subscribe",
    ]);
    assert.equal(readFileSync(registryPath, "utf8"), registryBefore);
    await server.close();
    server = undefined;

    let pendingSocketClosed = false;
    server = await fakeBoardServer(fixture, ({ socket, request }) => {
      if (request.method === "session.snapshot") socket.on("close", () => { pendingSocketClosed = true; });
    });
    const pending = laneProcess(fixture, ["board", "--watch", "--json"], {
      env: { ...fixture.env, HERDR_SOCKET_PATH: server.socketPath },
    });
    boardWatches.push(pending);
    await waitForCondition(() => server.requests.length === 1, "pending refresh request", 8_000);
    pending.child.kill("SIGINT");
    const pendingResult = await pending.completed;
    assert.equal(pendingResult.status, 0, pendingResult.stderr);
    await waitForCondition(() => pendingSocketClosed, "pending snapshot socket closure");
    assert.equal(server.connections(), 1);
    await server.close();
    server = undefined;

    let subscriptionClosed = false;
    server = await fakeBoardServer(fixture, ({ socket, request }) => {
      if (request.method === "session.snapshot") {
        socket.write(`${JSON.stringify({ id: request.id, result: boardSnapshotResult({ cwd: fixture.repo }) })}\n`);
      } else if (request.method === "events.subscribe") {
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
        setTimeout(() => {
          subscriptionClosed = true;
          socket.destroy();
        }, 10);
      }
    });
    const reconnect = laneProcess(fixture, ["board", "--watch", "--json"], {
      env: { ...fixture.env, HERDR_SOCKET_PATH: server.socketPath },
    });
    boardWatches.push(reconnect);
    await waitForCondition(() => subscriptionClosed, "subscription disconnect", 8_000);
    reconnect.child.kill("SIGTERM");
    const reconnectResult = await reconnect.completed;
    assert.equal(reconnectResult.status, 0, reconnectResult.stderr);
    const connectionsAtExit = server.connections();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
    assert.equal(server.connections(), connectionsAtExit);
    await server.close();
    server = undefined;

    server = await fakeBoardServer(fixture, ({ socket, request }) => {
      if (request.method === "session.snapshot") {
        socket.write(`${JSON.stringify({ id: request.id, result: boardSnapshotResult({ cwd: fixture.repo }) })}\n`);
      } else if (request.method === "events.subscribe") {
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
        setTimeout(() => socket.write(`${JSON.stringify({
          event: "pane.agent_status_changed",
          data: { pane_id: "pane-1", agent_status: "done" },
        })}\n`), 30);
      }
    });
    const closedConsumer = laneProcess(fixture, ["board", "--watch", "--json"], {
      env: { ...fixture.env, HERDR_SOCKET_PATH: server.socketPath },
    });
    boardWatches.push(closedConsumer);
    await waitForCondition(() => closedConsumer.stdout().includes("\n"), "initial consumer frame", 8_000);
    closedConsumer.child.stdout.destroy();
    const consumerResult = await closedConsumer.completed;
    assert.equal(consumerResult.status, 0, consumerResult.stderr);
    assert.equal(readFileSync(registryPath, "utf8"), registryBefore);
    negativeControl("board watch JSON framing and permanent teardown");
  } finally {
    for (const active of boardWatches) {
      if (active.child.exitCode === null && active.child.signalCode === null) active.child.kill("SIGTERM");
      await active.completed;
    }
    if (server !== undefined) await server.close();
    fixture.cleanup();
  }
});

test("machine watch cancellation closes an in-flight snapshot and skips later endpoints", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  let first;
  let second;
  let watch;
  try {
    first = await fakeBoardServer(fixture, () => {});
    const secondPath = join(fixture.root, "second.sock");
    let secondConnections = 0;
    second = createServer((socket) => {
      secondConnections += 1;
      socket.destroy();
    });
    await new Promise((resolvePromise, reject) => {
      second.once("error", reject);
      second.listen(secondPath, resolvePromise);
    });
    const herdr = join(fixture.bin, "herdr");
    writeFileSync(herdr, `#!/bin/sh\nif [ "$1 $2 $3" = "session list --json" ]; then\n  printf '%s\\n' '${JSON.stringify({ sessions: [
      { name: "other", running: true, socket_path: secondPath },
    ] })}'\n  exit 0\nfi\nexit 1\n`);
    chmodSync(herdr, 0o755);
    watch = laneProcess(fixture, ["board", "--watch", "--json"], {
      env: { ...fixture.env, HERDR_SOCKET_PATH: first.socketPath },
    });
    await waitForCondition(() => first.requests.some((request) => request.method === "session.snapshot"),
      "in-flight machine snapshot", 8_000);
    watch.child.kill("SIGTERM");
    const result = await watch.completed;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(secondConnections, 0);
    await waitForCondition(() => first.sockets.size === 0, "cancelled snapshot socket closure");
    negativeControl("machine watch cancellation across endpoints");
  } finally {
    if (watch !== undefined) {
      if (watch.child.exitCode === null && watch.child.signalCode === null) watch.child.kill("SIGTERM");
      await watch.completed;
    }
    if (first !== undefined) await first.close();
    if (second !== undefined) await new Promise((resolvePromise) => second.close(resolvePromise));
    fixture.cleanup();
  }
});

test("machine watch reports only the configured tripwire substring", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  let server;
  let watch;
  try {
    const lanePath = join(fixture.root, "tripwire-checkout");
    git(fixture.repo, ["worktree", "add", "-b", "lane/tripwire", lanePath], { stdio: "ignore" });
    mkdirSync(join(fixture.repo, ".lane"));
    writeFileSync(join(fixture.repo, ".lane", "sessions.json"), `${JSON.stringify([{
      name: "board-agent", workspace: "workspace-1", lane: "tripwire", role: "engineer",
      agent_session_id: "fixture-board-session", terminal_id: "fixture-board-terminal",
      report: "docs/reports/tripwire.md", deadline: null, done: false, tripwires: ["STOP"],
    }])}\n`);
    server = await fakeBoardServer(fixture, ({ socket, request }) => {
      if (request.method === "session.snapshot") {
        socket.write(`${JSON.stringify({ id: request.id, result: boardSnapshotResult({ cwd: lanePath }) })}\n`);
      } else if (request.method === "events.subscribe") {
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
        socket.write(`${JSON.stringify({ event: "pane.output_matched", data: {
          pane_id: "pane-1", matched_line: "prefix STOP suffix", read: { text: "prefix STOP suffix" },
        } })}\n`);
        socket.write(`${JSON.stringify({ event: "pane.output_changed", data: { pane_id: "pane-1" } })}\n`);
      }
    });
    watch = laneProcess(fixture, ["board", "--watch", "--json"], {
      env: { ...fixture.env, HERDR_SOCKET_PATH: server.socketPath },
    });
    await waitForCondition(() => watch.stdout().trim().split("\n").filter(Boolean).length >= 3,
      "matched tripwire and refreshed frames", 8_000);
    watch.child.kill("SIGTERM");
    const result = await watch.completed;
    assert.equal(result.status, 0, result.stderr);
    const frames = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(frames[1].rows[0].tripwire, "STOP");
    assert.equal(frames.at(-1).rows[0].tripwire, "STOP");
    negativeControl("configured substring tripwire projection");
  } finally {
    if (watch !== undefined) {
      if (watch.child.exitCode === null && watch.child.signalCode === null) watch.child.kill("SIGTERM");
      await watch.completed;
    }
    if (server !== undefined) await server.close();
    fixture.cleanup();
  }
});

test("machine watch retains a match delivered between two pane read completions", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  let server;
  let watch;
  const timers = [];
  try {
    const checkout = join(fixture.root, "tripwire-race-checkout");
    git(fixture.repo, ["worktree", "add", "-b", "lane/tripwire-race", checkout], { stdio: "ignore" });
    for (const [index, name] of ["first-agent", "second-agent"].entries()) {
      writeBoardSession(fixture, {
        session_id: `88888888-8888-4888-8888-88888888888${index}`,
        topic: "tripwire-race", lane: "lane/tripwire-race", name,
        pane: `${index + 1}-pane`, agent_session_id: `${index + 1}-session`,
        terminal_id: `${index + 1}-terminal`,
        tripwires: index === 0 ? ["LATEST"] : [],
      });
    }
    let subscriptionSocket;
    let firstReads = 0;
    let secondReads = 0;
    let matchSent = false;
    const readResponse = (request, pane, count) => `${JSON.stringify({ id: request.id, result: {
      type: "pane_read", read: {
        pane_id: pane, source: "recent_unwrapped", format: "text",
        text: `• ${pane} preview ${count}\n`, revision: count, truncated: false,
      },
    } })}\n`;
    server = await fakeBoardServer(fixture, ({ socket, request }) => {
      if (request.method === "session.snapshot") {
        const result = boardSnapshotResult({ cwd: checkout });
        Object.assign(result.snapshot.agents[0], {
          agent: "codex", name: "first-agent", pane_id: "1-pane", terminal_id: "1-terminal",
          agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "1-session" },
        });
        result.snapshot.agents.push({ ...result.snapshot.agents[0],
          name: "second-agent", pane_id: "2-pane", terminal_id: "2-terminal",
          agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "2-session" },
        });
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      } else if (request.method === "pane.read") {
        const pane = request.params.pane_id;
        if (pane === "1-pane") {
          firstReads += 1;
          socket.write(readResponse(request, pane, firstReads));
        } else if (pane === "2-pane") {
          secondReads += 1;
          if (secondReads === 2) {
            timers.push(setTimeout(() => {
              matchSent = true;
              subscriptionSocket.write(`${JSON.stringify({ event: "pane.output_matched", data: {
                pane_id: "1-pane", matched_line: "LATEST", read: { text: "LATEST" },
              } })}\n`);
              timers.push(setTimeout(() => socket.write(readResponse(request, pane, secondReads)), 200));
            }, 50));
          } else {
            socket.write(readResponse(request, pane, secondReads));
          }
        }
      } else if (request.method === "events.subscribe") {
        subscriptionSocket = socket;
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
        socket.write(`${JSON.stringify({ event: "pane.output_changed", data: { pane_id: "1-pane" } })}\n`);
      }
    });
    watch = laneProcess(fixture, ["board", "--watch", "--json"], {
      env: { ...fixture.env, HERDR_SOCKET_PATH: server.socketPath },
    });
    try {
      await waitForCondition(() => matchSent && watch.stdout().trim().split("\n").length >= 3,
        "match frame and completed two-pane refresh", 4_500);
    } catch (error) {
      const frames = watch.stdout().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.fail(`${error.message}; reads=${firstReads}/${secondReads}; match=${matchSent}; ` +
        `frames=${frames.length}; rows=${JSON.stringify(frames[0]?.rows.map((row) => [row.name, row.registered, row.status]))}; ` +
        `requests=${JSON.stringify(server.requests.map((request) => request.method))}; stderr=${watch.stderr()}`);
    }
    await waitForCondition(() => secondReads === 2 &&
      watch.stdout().trim().split("\n").filter(Boolean).length >= 3,
    "second pane refresh frame", 1_500);
    const frames = watch.stdout().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const firstRow = (frame) => frame.rows.find((row) => row.name === "first-agent");
    assert.ok(frames.some((frame) => firstRow(frame)?.tripwire === "LATEST"));
    assert.equal(firstRow(frames.at(-1)).tripwire, "LATEST");
    assert.equal(firstReads, 2);
    assert.equal(secondReads, 2);
    negativeControl("matched watch frame survives delayed second pane completion");
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (watch !== undefined) {
      if (watch.child.exitCode === null && watch.child.signalCode === null) watch.child.kill("SIGTERM");
      await watch.completed;
    }
    if (server !== undefined) await server.close();
    fixture.cleanup();
  }
});

test("machine plain view exposes coverage, colliding repository identities, and active-after-done", async () => {
  const { renderMachineBoardPlain } = await import("../board/view.mjs");
  const document = {
    schema_version: 1,
    scope: { kind: "machine", repo_id: null, include_history: false },
    coverage: { discovery: "partial", registry: "available", herdr: "connected", servers: [
      { server_id: "local-111", labels: ["current"], current: true, running: true, available: true },
      { server_id: "local-222", labels: ["other"], current: false, running: false, available: false },
    ] },
    repositories: [
      { repo_id: "fixture-repo-one", root_id: "fixture-root-one", root_label: "team",
        repository_label: "repo", display_label: "repo #11111111", display_suffix: "11111111" },
      { repo_id: "fixture-repo-two", root_id: "fixture-root-two", root_label: "team",
        repository_label: "repo", display_label: "repo #22222222", display_suffix: "22222222" },
    ],
    rows: [
      { row_id: "one", repo_id: "fixture-repo-one", name: "worker", status: "working",
        branch: "lane/shared", topic: "shared", done: true, active_after_done: true,
        group: { kind: "lane", key: "lane/shared" } },
      { row_id: "two", repo_id: "fixture-repo-two", name: "worker", status: "working",
        branch: "lane/shared", topic: "shared", done: false, active_after_done: false,
        group: { kind: "lane", key: "lane/shared" } },
    ],
    host: { load_1m: 0, free_memory_bytes: 1024, workers: {} },
    errors: [{ source: "herdr", server_id: "local-222", message: "unavailable" }],
  };
  const plain = renderMachineBoardPlain(document);
  assert.match(plain, /scope machine.*history excluded/u);
  assert.match(plain, /discovery partial.*1\/2.*local-222/u);
  assert.match(plain, /repo #11111111/u);
  assert.match(plain, /repo #22222222/u);
  assert.match(plain, /active after done/u);
  negativeControl("machine plain identity and coverage");
});

test("board action arguments reject missing, extra, and unknown operands before observation", () => {
  const fixture = makeFixture();
  try {
    const expectedUsage = "lane: usage: lane board [--once | --json | --watch --json | focus <row-id> | done <row-id>] [--repo <path>] [--all]\n";
    for (const args of [
      ["focus"],
      ["focus", "row-1", "extra"],
      ["done"],
      ["done", "row-1", "extra"],
      ["retry", "row-1"],
      ["focus", "row-1", "--repo"],
    ]) {
      const run = lane(fixture, ["board", ...args]);
      assert.equal(run.status, 1, `${args.join(" ")}\n${run.stderr}`);
      assert.equal(run.stdout, "");
      assert.equal(run.stderr, expectedUsage);
    }
    negativeControl("board action argument validation");
  } finally {
    fixture.cleanup();
  }
});

test("focus target verification distinguishes unnamed, stale, replacement, and foreign occupants", async () => {
  const { verifyFocusSelection } = await import("../board/actions.mjs");
  const repoId = "/repository/.git";
  const repoRoot = "/repository";
  const checkout = "/lanes/lane-board-action";
  const session = {
    session_id: "12345678-1234-4123-8123-123456789abc",
    repo_id: repoId,
    repo: repoRoot,
    name: "board-agent",
    workspace: "workspace-1",
    pane: "pane-1",
    server: "/run/herdr.sock",
  };
  const snapshot = (agent, repoKey = repoId) => ({
    agents: agent === undefined ? [] : [agent],
    panes: [{ pane_id: "pane-1", tab_id: "tab-1", workspace_id: "workspace-1" }],
    workspaces: [{
      workspace_id: "workspace-1",
      worktree: {
        checkout_path: checkout,
        is_linked_worktree: true,
        repo_key: repoKey,
        repo_root: repoRoot,
      },
    }],
  });
  const named = { name: "board-agent", workspace_id: "workspace-1", pane_id: "pane-1", cwd: checkout };
  assert.deepEqual(verifyFocusSelection({ session, snapshot: snapshot(named), repoId, repoRoot, checkout }), {
    target: "board-agent",
    name: "board-agent",
    pane: "pane-1",
    server: "/run/herdr.sock",
  });
  const unnamed = { workspace_id: "workspace-1", pane_id: "pane-1", cwd: checkout };
  assert.equal(
    verifyFocusSelection({
      session: { ...session, name: null },
      snapshot: snapshot(unnamed),
      repoId,
      repoRoot,
      checkout,
    }).target,
    "pane-1",
  );
  assert.throws(
    () => verifyFocusSelection({ session, snapshot: snapshot(undefined), repoId, repoRoot, checkout }),
    /stale board selection.*no longer live/u,
  );
  assert.throws(
    () => verifyFocusSelection({
      session,
      snapshot: snapshot({ ...named, name: "replacement-agent" }),
      repoId,
      repoRoot,
      checkout,
    }),
    /stale board selection.*different agent/u,
  );
  assert.throws(
    () => verifyFocusSelection({ session, snapshot: snapshot(named, "/foreign/.git"), repoId, repoRoot, checkout }),
    /foreign board selection.*repository identity/u,
  );
  negativeControl("focus target verification");
});

test("board done verifies the registered canonical target and changes only its marker", () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    ignoreLaneState(fixture);
    const valid = writeBoardSession(fixture);
    const recordBefore = readFileSync(valid.path, "utf8");
    const gitBefore = git(fixture.repo, ["status", "--porcelain=v1"]);
    const run = lane(fixture, ["board", "done", valid.session.session_id]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `marked ${valid.session.session_id} done\n`);
    assert.equal(readFileSync(valid.path, "utf8"), recordBefore);
    assert.equal(git(fixture.repo, ["status", "--porcelain=v1"]), gitBefore);
    const marker = join(valid.directory, `${valid.session.session_id}.done.json`);
    const markerValue = JSON.parse(readFileSync(marker, "utf8"));
    assert.deepEqual(markerValue, {
      session_id: valid.session.session_id,
      done: true,
      completed_at: markerValue.completed_at,
    });

    const foreign = writeBoardSession(fixture, {
      session_id: "22345678-1234-4123-8123-123456789abc",
      repo_id: join(fixture.root, "foreign.git"),
      repo: join(fixture.root, "foreign"),
    });
    const refused = lane(fixture, ["board", "done", foreign.session.session_id]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /foreign session metadata/u);
    assert.ok(!existsSync(join(foreign.directory, `${foreign.session.session_id}.done.json`)));

    const missing = lane(fixture, ["board", "done", "32345678-1234-4123-8123-123456789abc"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /not a registered session.*done is unsupported/u);
    negativeControl("verified board done action");
  } finally {
    fixture.cleanup();
  }
});

test("board focus verifies the current pane occupant and stored server without retrying", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  let server;
  try {
    ignoreLaneState(fixture);
    const checkout = openLane(fixture, "board-action");
    const record = writeBoardSession(fixture);
    const fake = writeFakeHerdr(fixture);
    let mode = "named";
    server = await fakeBoardServer(fixture, ({ socket, request }) => {
      if (request.method !== "session.snapshot") return;
      const agent = mode === "missing" ? undefined : {
        ...(mode === "unnamed" ? {} : { name: mode === "replacement" ? "replacement-agent" : "board-agent" }),
        workspace_id: "workspace-1",
        pane_id: "pane-1",
        cwd: checkout,
        agent_status: "working",
      };
      const repoKey = mode === "foreign" ? join(fixture.root, "foreign.git") : repositoryIdentity(fixture.repo);
      socket.write(`${JSON.stringify({
        id: request.id,
        result: {
          type: "session_snapshot",
          snapshot: {
            protocol: 20,
            version: "test",
            agents: agent === undefined ? [] : [agent],
            panes: [{ pane_id: "pane-1", tab_id: "tab-1", workspace_id: "workspace-1" }],
            workspaces: [{
              workspace_id: "workspace-1",
              label: "lane-board-action",
              worktree: {
                checkout_path: checkout,
                is_linked_worktree: true,
                repo_key: repoKey,
                repo_name: "repo",
                repo_root: fixture.repo,
              },
            }],
          },
        },
      })}\n`);
    });
    record.session.server = server.socketPath;
    writeFileSync(record.path, `${JSON.stringify(record.session, null, 2)}\n`);
    const env = { ...fixture.env, HERDR_SOCKET_PATH: join(fixture.root, "wrong.sock") };

    const named = laneProcess(fixture, ["board", "focus", record.session.session_id], { env });
    const namedResult = await named.completed;
    assert.equal(namedResult.status, 0, namedResult.stderr);
    assert.match(namedResult.stdout, /^focused /u);
    assert.deepEqual(fake.calls().filter((args) => args[0] === "agent" && args[1] === "focus"), [
      ["agent", "focus", "board-agent"],
    ]);
    assert.equal(fake.state().focusSocket, server.socketPath);

    for (const [refusalMode, pattern] of [
      ["missing", /stale board selection.*no longer live/u],
      ["replacement", /stale board selection.*different agent/u],
      ["foreign", /foreign board selection.*repository identity/u],
    ]) {
      const before = fake.calls().filter((args) => args[0] === "agent" && args[1] === "focus").length;
      mode = refusalMode;
      const refused = laneProcess(fixture, ["board", "focus", record.session.session_id], { env });
      const result = await refused.completed;
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, pattern);
      assert.equal(
        fake.calls().filter((args) => args[0] === "agent" && args[1] === "focus").length,
        before,
      );
    }
    mode = "named";
    const beforeFailure = fake.calls().filter((args) => args[0] === "agent" && args[1] === "focus").length;
    const failed = laneProcess(fixture, ["board", "focus", record.session.session_id], {
      env: { ...env, FAKE_HERDR_FOCUS_FAIL: "1" },
    });
    const failedResult = await failed.completed;
    assert.equal(failedResult.status, 1);
    assert.match(failedResult.stderr, /Herdr focus failed.*focus refused by fake Herdr/u);
    assert.equal(
      fake.calls().filter((args) => args[0] === "agent" && args[1] === "focus").length,
      beforeFailure + 1,
    );

    for (const [flag, pattern] of [
      ["FAKE_HERDR_FOCUS_ERROR_DOCUMENT", /Herdr focus failed.*focus error document/u],
      ["FAKE_HERDR_FOCUS_MALFORMED", /Herdr focus failed.*malformed Herdr response/u],
    ]) {
      const before = fake.calls().filter((args) => args[0] === "agent" && args[1] === "focus").length;
      const refused = laneProcess(fixture, ["board", "focus", record.session.session_id], {
        env: { ...env, [flag]: "1" },
      });
      const result = await refused.completed;
      assert.equal(result.status, 1);
      assert.match(result.stderr, pattern);
      assert.equal(
        fake.calls().filter((args) => args[0] === "agent" && args[1] === "focus").length,
        before + 1,
      );
    }

    const noHerdrBin = join(fixture.root, "bin-without-herdr");
    mkdirSync(noHerdrBin);
    symlinkSync(GIT, join(noHerdrBin, "git"));
    const unavailable = laneProcess(fixture, ["board", "focus", record.session.session_id], {
      env: { ...env, PATH: noHerdrBin },
    });
    const unavailableResult = await unavailable.completed;
    assert.equal(unavailableResult.status, 1);
    assert.match(unavailableResult.stderr, /Herdr focus failed.*ENOENT/u);
    negativeControl("verified board focus action");
  } finally {
    if (server !== undefined) await server.close();
    fixture.cleanup();
  }
});

test("interactive board data and actions cross only the lane CLI process boundary", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-cli-client-")));
  const fakeLane = join(root, "lane.mjs");
  const log = join(root, "calls.jsonl");
  const repo = join(root, "repo");
  let client;
  mkdirSync(repo);
  writeFileSync(fakeLane, `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LANE_LOG, JSON.stringify(args) + "\\n");
if (args[1] === "--watch") {
  process.stdout.write("not-json\\n");
  const frames = [1, 2, 3].map((value) => JSON.stringify({
    schema_version: 1,
    captured_at: "2026-09-10T00:00:0" + value + ".000Z",
    coverage: { herdr: "connected" }, repositories: [], rows: [{
      row_id: "row-" + value,
      topic: "topic-" + value,
      branch: "lane/topic-" + value,
      pane_id: "pane-" + value,
      status: "offline",
    }],
    host: { load_1m: value, free_memory_bytes: value, workers: {} }, errors: [],
  }) + "\\n");
  process.stdout.write(frames[0].slice(0, 9));
  setTimeout(() => process.stdout.write(frames[0].slice(9) + frames[1] + frames[2]), 10);
  setInterval(() => {}, 1000);
} else if (args[1] === "focus" || args[1] === "done") {
  process.stdout.write((args[1] === "focus" ? "focused " : "marked ") + args[2] + (args[1] === "done" ? " done" : "") + "\\n");
} else {
  process.stderr.write("unexpected fake lane arguments\\n");
  process.exit(2);
}
`);
  try {
    const { LaneCliClient } = await import("../board/cli-client.mjs");
    const { stateFromBoardDocument } = await import("../board/view.mjs");
    const snapshots = [];
    const errors = [];
    client = new LaneCliClient({
      lanePath: fakeLane,
      repoRoot: repo,
      env: { ...process.env, FAKE_LANE_LOG: log },
      minBackoffMs: 10,
      maxBackoffMs: 20,
    });
    client.on("snapshot", (snapshot) => snapshots.push(snapshot));
    client.on("clientError", (error) => errors.push(error.message));
    client.start();
    await waitForCondition(() => snapshots.length === 3, "split and batched fake CLI snapshots");
    assert.deepEqual(snapshots.map((snapshot) => snapshot.rows[0].row_id), ["row-1", "row-2", "row-3"]);
    assert.deepEqual(stateFromBoardDocument(snapshots[2]).rows[0], {
      name: "(unnamed)", role: "-", lane: "lane/topic-3", status: "offline", pane: "-", git: "-", gate: "-",
      report: "-", deadline: "-", tripwire: "-", output: "-", done: "no", sessionId: "row-3",
    });
    assert.match(errors[0], /invalid JSON from lane board/u);
    assert.equal(await client.focus("row-2"), "focused row-2");
    assert.equal(await client.done("row-2"), "marked row-2 done");
    client.close();
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls, [
      ["board", "--watch", "--json", "--repo", repo],
      ["board", "focus", "row-2", "--repo", repo],
      ["board", "done", "row-2", "--repo", repo],
    ]);

    const appSource = readFileSync(resolve(HERE, "..", "board", "app.mjs"), "utf8");
    const assertProcessBoundary = (source) => {
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);
      assert.deepEqual(imports.sort(), [
        "./args.mjs", "./cli-client.mjs", "./process-lifetime.mjs", "./view.mjs", "ink", "react",
      ].sort());
      assert.doesNotMatch(source, /\bimport\s*\(/u);
      assert.doesNotMatch(
        source,
        /readFileSync|collectBoardState|HerdrClient|markSessionDone|registry\.mjs|execFileSync|spawnSync|node:fs|node:child_process/u,
      );
    };
    assertProcessBoundary(appSource);
    assert.throws(
      () => assertProcessBoundary(`${appSource}\nvoid import("node:child_process");\n`),
      /The input was expected to not match/u,
    );
    assert.throws(
      () => assertProcessBoundary(`${appSource}\nspawnSync("git", ["status"]);\n`),
      /The input was expected to not match/u,
    );
    assert.match(appSource, /key\.return \|\| input === "a"[\s\S]*runAction\("focus"\)/u);
    assert.match(appSource, /input === "d"[\s\S]*runAction\("done"\)/u);
    negativeControl("interactive board CLI process boundary");
  } finally {
    client?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive board signals synchronously terminate observer and action children", async () => {
  const { BOARD_TERMINAL_RESET } = await import(pathToFileURL(PROCESS_LIFETIME));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-signals-")));
  const fakeLane = join(root, "lane.mjs");
  writeFileSync(fakeLane, `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LANE_LOG, JSON.stringify({ args, pid: process.pid }) + "\\n");
setInterval(() => {}, 1000);
`);
  try {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const log = join(root, `${signal}.jsonl`);
      const harness = join(root, `${signal}.mjs`);
      writeFileSync(harness, `
import { LaneCliClient } from ${JSON.stringify(pathToFileURL(CLI_CLIENT).href)};
import { installBoardSignalHandlers } from ${JSON.stringify(pathToFileURL(PROCESS_LIFETIME).href)};
const client = new LaneCliClient({
  lanePath: ${JSON.stringify(fakeLane)},
  repoRoot: ${JSON.stringify(root)},
  env: { ...process.env, FAKE_LANE_LOG: ${JSON.stringify(log)} },
});
installBoardSignalHandlers(() => client);
client.start();
void client.focus("row-1").catch(() => {});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`);
      const board = spawn(process.execPath, [harness], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      board.stdout.setEncoding("utf8");
      board.stderr.setEncoding("utf8");
      board.stdout.on("data", (chunk) => { stdout += chunk; });
      board.stderr.on("data", (chunk) => { stderr += chunk; });
      await waitForCondition(
        () => existsSync(log) && readFileSync(log, "utf8").trim().split("\n").length === 2,
        `${signal} board children`,
      );
      const children = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
      const closed = once(board, "close");
      board.kill(signal);
      const [status, exitSignal] = await closed;
      assert.equal(status, null, stderr);
      assert.equal(exitSignal, signal, stderr);
      await waitForCondition(() => children.every(({ pid }) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return error.code === "ESRCH";
        }
      }), `${signal} child termination`);
      assert.ok(stdout.includes(BOARD_TERMINAL_RESET), `${signal} did not reset the terminal`);
    }
    negativeControl("interactive board synchronous signal teardown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closing the UI CLI client permanently stops pending observation and reconnect work", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-cli-close-")));
  const fakeLane = join(root, "lane.mjs");
  const log = join(root, "calls.jsonl");
  writeFileSync(fakeLane, `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_LANE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.FAKE_LANE_PENDING === "1") setInterval(() => {}, 1000);
`);
  try {
    const { LaneCliClient } = await import("../board/cli-client.mjs");
    const reconnecting = new LaneCliClient({
      lanePath: fakeLane,
      repoRoot: root,
      env: { ...process.env, FAKE_LANE_LOG: log },
      minBackoffMs: 30,
      maxBackoffMs: 30,
    });
    const observerErrors = [];
    reconnecting.on("clientError", (error) => observerErrors.push(error.message));
    reconnecting.start();
    await waitForCondition(() => existsSync(log), "first fake CLI observer");
    await waitForCondition(() => observerErrors.length === 1, "observer child exit error");
    assert.match(observerErrors[0], /lane board observer exited 0/u);
    reconnecting.close();
    const atClose = readFileSync(log, "utf8").trim().split("\n").length;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, atClose);

    const pendingLog = join(root, "pending.jsonl");
    const pending = new LaneCliClient({
      lanePath: fakeLane,
      repoRoot: root,
      env: { ...process.env, FAKE_LANE_LOG: pendingLog, FAKE_LANE_PENDING: "1" },
    });
    pending.start();
    await waitForCondition(() => existsSync(pendingLog), "pending fake CLI observer");
    const child = pending.observer;
    pending.refresh();
    pending.close();
    await once(child, "close");
    assert.equal(pending.closed, true);
    assert.equal(pending.observer, undefined);
    negativeControl("permanent UI CLI client close");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive board rejects non-TTY input with a concise --once hint", () => {
  const fixture = makeFixture();
  try {
    const run = lane(fixture, ["board"]);
    assert.equal(run.status, 1);
    assert.equal(
      run.stderr,
      "lane: interactive board requires a TTY; use `lane board --once`\n",
    );
    assert.equal(run.stdout, "");
    negativeControl("non-TTY board failure");
  } finally {
    fixture.cleanup();
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

function makeReviewFixture(topic, options = {}) {
  const fixture = makeFixture({
    main: "main",
    validate: "true",
    routes: {
      review: { kind: "codex", model: "review-model", use: "Independent review" },
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
    assert.ok(Date.now() - started >= 2_300, "review returned before the rewritten record settled");
    negativeControl("completed private record settle window");
  } finally {
    review.fixture.cleanup();
  }
});

test("review preserves a final finding immediately before the next section heading", () => {
  const findings = [
    "- [Major] first.txt:1 - first issue; Fix: fix the first issue",
    "- [Moderate] second.txt:2 - second issue; Fix: fix the second issue",
  ].join("\n");
  const review = makeReviewFixture("review-compact-findings", {
    verdict: "NEEDS-WORK", mode: "compact-findings", payload: { findings },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-compact-findings", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 1, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-compact-findings", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.match(publicRecord, /first\.txt:1 - first issue/);
    assert.match(publicRecord, /second\.txt:2 - second issue/);
    negativeControl("compact finding section boundary");
  } finally {
    review.fixture.cleanup();
  }
});

test("review completion admits representative validator-accepted record boundaries", () => {
  const boundaries = [
    ["record-start", 1],
    ["record-start", 2],
    ["after-Findings", 1],
    ["before-Unverified", 0],
    ["after-marker", 2],
  ];
  const findings = [
    "- [Major] first.txt:1 - first issue; Fix: fix the first issue",
    "- [Moderate] second.txt:2 - second issue; Fix: fix the second issue",
  ].join("\n");
  const fixtures = [];
  const failures = [];
  try {
    for (const [boundaryIndex, [boundary, blankLines]] of boundaries.entries()) {
      const topic = `review-spacing-${boundaryIndex}-${blankLines}`;
      const review = makeReviewFixture(topic, {
        verdict: "NEEDS-WORK", payload: { findings, spacing: { boundary, blankLines } },
      });
      fixtures.push(review.fixture);
      const run = lane(review.fixture, [
        "review", topic, "--round", "1", "--brief", review.brief, "--timeout", "4",
      ]);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      const publicPath = join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`);
      const publicRecord = existsSync(publicPath) ? readFileSync(publicPath, "utf8") : "";
      if (run.status !== 1 || !publicRecord.includes("first.txt:1 - first issue") ||
          !publicRecord.includes("second.txt:2 - second issue")) {
        failures.push({ boundary, blankLines, status: run.status, stderr: run.stderr });
      }
    }
    assert.deepEqual(failures, []);
    negativeControl("completion admits representative validator-accepted boundary fixtures");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review requires consecutive finding entries across the blank-line matrix", () => {
  const fixtures = [];
  const outcomes = [];
  try {
    for (const blankLines of [0, 1, 2]) {
      const topic = `review-finding-gap-${blankLines}`;
      const findings = [
        "- [Major] first.txt:1 - first issue; Fix: fix the first issue",
        ...Array(blankLines).fill(""),
        "- [Moderate] second.txt:2 - second issue; Fix: fix the second issue",
      ].join("\n");
      const review = makeReviewFixture(topic, { verdict: "NEEDS-WORK", payload: { findings } });
      fixtures.push(review.fixture);
      const run = lane(review.fixture, [
        "review", topic, "--round", "1", "--brief", review.brief,
      ]);
      outcomes.push({
        blankLines,
        status: run.status,
        emptyStdout: run.stdout === "",
        spacingDiagnostic: /Findings spacing/.test(run.stderr),
        findingDiagnostic: /each finding/.test(run.stderr),
      });
    }
    assert.deepEqual(outcomes, [
      { blankLines: 0, status: 1, emptyStdout: false, spacingDiagnostic: false, findingDiagnostic: false },
      { blankLines: 1, status: 2, emptyStdout: true, spacingDiagnostic: true, findingDiagnostic: false },
      { blankLines: 2, status: 2, emptyStdout: true, spacingDiagnostic: true, findingDiagnostic: false },
    ]);
    negativeControl("consecutive finding entry spacing");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review projects repository-relative finding locations containing spaces", () => {
  const review = makeReviewFixture("review-spaced-location", {
    verdict: "PASS",
    payload: { findings: "- [Minor] docs/with space.md:7 - wording issue; Fix: clarify the wording" },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-spaced-location", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-spaced-location", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.match(publicRecord, /docs\/with space\.md:7 - wording issue; Fix: clarify the wording/);
    negativeControl("spaced repository-relative finding location");
  } finally {
    review.fixture.cleanup();
  }
});

test("review sanitizes deterministic aliases and path forms in a bounded public projection", () => {
  const review = makeReviewFixture("review-sanitize", { verdict: "PASS" });
  try {
    const username = userInfo().username;
    const homeName = homedir().split("/").filter(Boolean).at(-1);
    const host = hostname();
    review.fixture.env.FAKE_REVIEW_PAYLOAD = JSON.stringify({
      findings: `- [Moderate] shared.txt:1 - User ${username} inspected ${review.path}/shared.txt; Fix: ask ${homeName} to use a relative path`,
      reexecuted: [{
        command: `node scripts/check.mjs ${review.path}/shared.txt ${review.path}/other.txt --user ${username}`,
        cwd: "scratch",
        exit_code: 1,
        result: `host ${host}; posix /opt/tools/check; drive C:\\Temp\\check.exe; unc \\\\server\\share\\check; url file:///var/tmp/check; prefix ${review.path}-private/secret`,
        tests_pass: false,
        witness: null,
      }],
      nonclaims: "- SECRETNAME was not independently authenticated.",
      unverified: "- annex behavior remains unverified.",
      identifiers: ["SecretName"],
      analysis: `Private analysis keeps ${username}, ${host}, and /private/source/path.`,
    });
    const run = lane(review.fixture, ["review", "review-sanitize", "--round", "1", "--brief", review.brief]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicPath = join(review.path, "docs", "reviews", "review-sanitize", `${head.slice(0, 7)}-r1.md`);
    const publicRecord = readFileSync(publicPath, "utf8");
    assert.match(publicRecord, /User \[USER\] inspected shared\.txt; Fix: ask \[USER\] to use a relative path/);
    assert.match(publicRecord, /node scripts\/check\.mjs shared\.txt other\.txt --user \[USER\]/);
    assert.match(publicRecord, /host \[HOST\]; posix \[ABS_PATH\]; drive \[ABS_PATH\]; unc \[ABS_PATH\]; url \[ABS_PATH\]; prefix \[ABS_PATH\]/);
    assert.match(publicRecord, /- \[PRIVATE\] was not independently authenticated\./);
    assert.match(publicRecord, /- annex behavior remains unverified\./);
    assert.match(publicRecord, /- absolute-path: 5\n- user: 3\n- host: 1\n- private: 1\n- relative-path: 3/);
    assert.match(publicRecord, /- redacted execution fields: 0\.command, 0\.result/);
    assert.doesNotMatch(publicRecord, /Private identifiers|## Analysis|Private analysis|private\/source/);
    assert.ok(Buffer.byteLength(publicRecord) <= 64 * 1024);
    assert.ok(publicRecord.split("\n").length <= 120);
    negativeControl("sanitized public projection");
  } finally {
    review.fixture.cleanup();
  }
});

test("review redacts syntax-shaped slash prose while retaining alias safeguards", () => {
  const fixtures = [];
  try {
    const accepted = makeReviewFixture("review-slash-prose", {
      verdict: "PASS",
      payload: {
        findings: "- [Minor] shared.txt:1 - Patterns /tmp/gimu, /tmp/gimu/private, C:/tmp/gimu, and /alpha/beta/ were reported; Fix: spell patterns in words",
        reexecuted: [{
          command: "printf '%s\\n' $(cat /var/tmp/input.txt) $(type C:\\Temp\\input.txt) $(type \\\\server\\share\\input.txt)",
          cwd: "scratch",
          exit_code: 0,
          result: "Command-substitution path content was inspected without execution.",
          tests_pass: false,
          witness: null,
        }],
        nonclaims: "- The external fixture at /opt/review/input.js was not re-executed.",
      },
    });
    fixtures.push(accepted.fixture);
    const acceptedRun = lane(accepted.fixture, [
      "review", "review-slash-prose", "--round", "1", "--brief", accepted.brief,
    ]);
    assert.equal(acceptedRun.status, 0, acceptedRun.stderr);
    const acceptedHead = git(accepted.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      accepted.path, "docs", "reviews", "review-slash-prose", `${acceptedHead.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.match(publicRecord, /Patterns \[ABS_PATH\], \[ABS_PATH\], \[ABS_PATH\], and \[ABS_PATH\] were reported; Fix: spell patterns in words/);
    assert.doesNotMatch(publicRecord, /tmp\/gimu|alpha\/beta/);
    assert.match(publicRecord, /The external fixture at \[ABS_PATH\] was not re-executed\./);
    const executions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
    assert.equal(executions[0].command, "printf '%s\\n' $(cat [ABS_PATH]) $(type [ABS_PATH]) $(type [ABS_PATH])");

    const refused = makeReviewFixture("review-slash-alias", {
      verdict: "PASS",
      payload: {
        findings: "- [Minor] shared.txt:1 - Private ReviewerAlias found an issue; Fix: remove the alias",
        identifiers: ["ReviewerAlias"],
      },
    });
    fixtures.push(refused.fixture);
    const refusedRun = lane(refused.fixture, [
      "review", "review-slash-alias", "--round", "1", "--brief", refused.brief,
    ]);
    assert.equal(refusedRun.status, 2, refusedRun.stderr);
    assert.equal(refusedRun.stdout, "");
    assert.match(refusedRun.stderr, /finding description contains a declared private identifier/);
    negativeControl("syntax-shaped slash prose redaction");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review redacts an absolute path inside a regex-like character class", () => {
  const review = makeReviewFixture("review-regex-class-path", {
    verdict: "PASS",
    payload: {
      findings: "- [Minor] shared.txt:1 - Pattern /[open /var/tmp/private.txt]/g was inspected; Fix: spell the pattern in words",
    },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-regex-class-path", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-regex-class-path", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.ok(publicRecord.includes("Pattern /\\[open [ABS_PATH]\\][ABS_PATH] was inspected"));
    assert.doesNotMatch(publicRecord, /var\/tmp\/private/);
    negativeControl("regex-like character class path redaction");
  } finally {
    review.fixture.cleanup();
  }
});

for (const [field, topic, payload, verify] of [
  [
    "finding prose",
    "review-flag-attached-prose-path",
    { findings: "- [Moderate] shared.txt:1 - Flag -x/var/tmp/private.txt was observed; Fix: use a public-safe path" },
    (publicRecord) => {
      assert.match(publicRecord, /Flag -x\[ABS_PATH\] was observed/);
      assert.doesNotMatch(publicRecord, /var\/tmp\/private/);
    },
  ],
  [
    "finding location",
    "review-flag-attached-location-path",
    { findings: "- [Moderate] -x/var/tmp/private.txt:1 - issue; Fix: use a repository-relative location" },
    null,
  ],
  [
    "command string",
    "review-flag-attached-command-path",
    { reexecuted: [{
      command: "inspect -x/var/tmp/private.txt",
      cwd: "scratch",
      exit_code: 0,
      result: "The command was inspected without execution.",
      tests_pass: false,
      witness: null,
    }] },
    (publicRecord) => {
      const executions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
      assert.equal(executions[0].command, "inspect -x[ABS_PATH]");
    },
  ],
]) {
  test("review sanitizes a flag-attached absolute path in " + field, () => {
    const review = makeReviewFixture(topic, { verdict: "PASS", payload });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      const publicPath = join(review.path, "docs", "reviews", topic, head.slice(0, 7) + "-r1.md");
      if (field === "finding location") {
        assert.equal(run.status, 2, run.stderr);
        assert.equal(run.stdout, "");
        assert.match(
          run.stderr,
          /finding location contains a private alias or absolute path and cannot be rewritten safely/u,
        );
        assert.ok(!existsSync(publicPath));
      } else {
        assert.equal(run.status, 0, run.stderr);
        assert.ok(existsSync(publicPath));
        verify(readFileSync(publicPath, "utf8"));
      }
      negativeControl("flag-attached absolute path in " + field);
    } finally {
      review.fixture.cleanup();
    }
  });
}

for (const [field, topic, payload, verify] of [
  [
    "backtick-quoted finding prose",
    "review-delimited-flag-prose-path",
    { findings: "- [Moderate] shared.txt:1 - Flag `-I/var/tmp/private.h` was observed; Fix: use a public-safe path" },
    (publicRecord) => {
      assert.ok(publicRecord.includes("Flag \\`-I[ABS_PATH]\\` was observed"));
      assert.doesNotMatch(publicRecord, /var\/tmp\/private/);
    },
  ],
  [
    "assigned command string",
    "review-delimited-flag-command-path",
    { reexecuted: [{
      command: "CFLAGS=-I/var/tmp/private.h compile",
      cwd: "scratch",
      exit_code: 0,
      result: "The command was inspected without execution.",
      tests_pass: false,
      witness: null,
    }] },
    (publicRecord) => {
      const executions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
      assert.equal(executions[0].command, "CFLAGS=-I[ABS_PATH] compile");
    },
  ],
  [
    "double-quoted finding location",
    "review-delimited-flag-location-path",
    { findings: "- [Moderate] \"-I/var/tmp/private.h\":1 - issue; Fix: use a repository-relative location" },
    null,
  ],
]) {
  test("review sanitizes a delimiter-prefixed flag-attached absolute path in " + field, () => {
    const review = makeReviewFixture(topic, { verdict: "PASS", payload });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      const publicPath = join(review.path, "docs", "reviews", topic, head.slice(0, 7) + "-r1.md");
      if (field === "double-quoted finding location") {
        assert.equal(run.status, 2, run.stderr);
        assert.equal(run.stdout, "");
        assert.match(
          run.stderr,
          /finding location contains a private alias or absolute path and cannot be rewritten safely/u,
        );
        assert.ok(!existsSync(publicPath));
      } else {
        assert.equal(run.status, 0, run.stderr);
        assert.ok(existsSync(publicPath));
        verify(readFileSync(publicPath, "utf8"));
      }
      negativeControl("delimiter-prefixed flag-attached absolute path in " + field);
    } finally {
      review.fixture.cleanup();
    }
  });
}

for (const [description, topic, command, projected] of [
  [
    "forward-separator UNC path",
    "review-forward-unc-path",
    "inspect //server/share/private.txt",
    "inspect [ABS_PATH]",
  ],
  [
    "hosted file URL",
    "review-hosted-file-url",
    "inspect file://server/share/private.txt",
    "inspect [ABS_PATH]",
  ],
]) {
  test("review redacts a " + description, () => {
    const review = makeReviewFixture(topic, {
      verdict: "PASS",
      payload: {
        reexecuted: [{
          command,
          cwd: "scratch",
          exit_code: 0,
          result: "The command was inspected without execution.",
          tests_pass: false,
          witness: null,
        }],
      },
    });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      assert.equal(run.status, 0, run.stderr);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      const publicRecord = readFileSync(join(
        review.path, "docs", "reviews", topic, head.slice(0, 7) + "-r1.md",
      ), "utf8");
      const executions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
      assert.equal(executions[0].command, projected);
      assert.ok(!publicRecord.includes(command.split(" ").at(-1)));
      negativeControl(description);
    } finally {
      review.fixture.cleanup();
    }
  });
}

for (const [field, topic, payload, diagnostic] of [
  [
    "finding prose",
    "review-escaped-prose-path",
    { findings: "- [Moderate] shared.txt:1 - Escaped path \\/var/tmp/private.txt was observed; Fix: remove it" },
    /projected payload retains private path or alias content/u,
  ],
  [
    "finding location",
    "review-escaped-location-path",
    { findings: "- [Moderate] scope)\\/var/tmp/private.txt:1 - issue; Fix: remove it" },
    /finding location contains a private alias or absolute path and cannot be rewritten safely/u,
  ],
  [
    "command string",
    "review-escaped-command-path",
    { reexecuted: [{
      command: "inspect \\/var/tmp/private.txt",
      cwd: "scratch",
      exit_code: 0,
      result: "The command was inspected without execution.",
      tests_pass: false,
      witness: null,
    }] },
    /projected payload retains private path or alias content/u,
  ],
]) {
  test(`review refuses an escaped absolute path in ${field}`, () => {
    const review = makeReviewFixture(topic, { verdict: "PASS", payload });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      assert.equal(run.status, 2, run.stderr);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, diagnostic);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      assert.ok(!existsSync(join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`)));
      negativeControl(`escaped absolute path in ${field}`);
    } finally {
      review.fixture.cleanup();
    }
  });
}

test("review refuses a relative-looking protected location embedding an absolute path", () => {
  const topic = "review-location-relative-looking";
  const review = makeReviewFixture(topic, {
    verdict: "PASS",
    payload: { findings: "- [Major] scope)/tmp/gimu:1 - issue; Fix: change it" },
  });
  try {
    const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(
      run.stderr,
      /finding location contains a private alias or absolute path and cannot be rewritten safely/u,
    );
    negativeControl("relative-looking protected absolute path");
  } finally {
    review.fixture.cleanup();
  }
});

for (const [description, topic, location] of [
  ["two-segment flag-letter path", "review-location-two-segment-flags", "/tmp/gimu"],
  ["deeper path with a flag-letter second segment", "review-location-deep-flags", "/tmp/gimu/private.txt"],
  ["drive path with a flag-letter segment", "review-location-drive-flags", "C:/tmp/gimu"],
]) {
  test(`review refuses a ${description} in a protected location`, () => {
    const review = makeReviewFixture(topic, {
      verdict: "PASS",
      payload: { findings: `- [Major] ${location}:1 - issue; Fix: change it` },
    });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      assert.equal(run.status, 2, run.stderr);
      assert.equal(run.stdout, "");
      const head = git(review.path, ["rev-parse", "HEAD"]);
      assert.ok(!existsSync(join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`)));
      negativeControl(`protected ${description}`);
    } finally {
      review.fixture.cleanup();
    }
  });
}

test("review preserves a command-substitution delimiter after file URL redaction", () => {
  const review = makeReviewFixture("review-file-url-delimiter", {
    verdict: "PASS",
    payload: {
      reexecuted: [{
        command: "printf '%s\\n' $(cat file:///var/tmp/input.txt)",
        cwd: "scratch",
        exit_code: 0,
        result: "The command syntax was inspected without execution.",
        tests_pass: false,
        witness: null,
      }],
    },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-file-url-delimiter", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-file-url-delimiter", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    const executions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
    assert.equal(executions[0].command, "printf '%s\\n' $(cat [ABS_PATH])");
    negativeControl("file URL command-substitution delimiter");
  } finally {
    review.fixture.cleanup();
  }
});

// Retain the 3367cd5 matcher and ambiguity heuristic as fixture data so the
// differential checks remain self-contained in shallow clones.
const HISTORICAL_REVIEW_ABSOLUTE_PATH_PATTERN =
  /file:\/\/\/[A-Za-z0-9._~!$&'()+=@%\/-]+|\\\\[^\\/\s]+[\\/][^\s"'<>`\[\],;:)]+|\b[A-Za-z]:[\\/][^\s"'<>`\[\],;:)]+|(?<![-\p{L}\p{M}\p{N}_.\/\\])\/(?!\/)[^\s"'<>`\[\],;:()]+/giu;
const HISTORICAL_REVIEW_AMBIGUOUS_PATH_PATTERN =
  /(?:file:\/\/\/|\b[A-Za-z]:[\\/]|\\\\|(?<![-\p{L}\p{M}\p{N}_.\/\\])\/(?!\/))[^,;\n]*\s+[^,;\n]*[\\/]/iu;

test("review refuses a closing-parenthesis file URL residue that the base matcher fully redacted", () => {
  const command = "inspect file:///var/tmp/archive)tail/input.txt";
  const payload = {
    reexecuted: [{
      command,
      cwd: "scratch",
      exit_code: 0,
      result: "The command was inspected without execution.",
      tests_pass: false,
      witness: null,
    }],
  };
  const current = makeReviewFixture("review-file-url-closing-current", { verdict: "PASS", payload });
  try {
    assert.equal(command.replace(HISTORICAL_REVIEW_ABSOLUTE_PATH_PATTERN, "[ABS_PATH]"), "inspect [ABS_PATH]");

    const currentRun = lane(current.fixture, [
      "review", "review-file-url-closing-current", "--round", "1", "--brief", current.brief,
    ]);
    assert.equal(currentRun.status, 2, currentRun.stderr);
    assert.equal(currentRun.stdout, "");
    assert.match(currentRun.stderr, /projected payload contains an ambiguous absolute path/u);
    const currentHead = git(current.path, ["rev-parse", "HEAD"]);
    assert.ok(!existsSync(join(
      current.path, "docs", "reviews", "review-file-url-closing-current", `${currentHead.slice(0, 7)}-r1.md`,
    )));
    negativeControl("closing-parenthesis file URL residue differential");
  } finally {
    current.fixture.cleanup();
  }
});

test("review publishes a standalone closing delimiter after file URL redaction", () => {
  const topic = "review-file-url-closing-delimiter";
  const review = makeReviewFixture(topic, {
    verdict: "PASS",
    payload: { unverified: "- Inspect file:///var/tmp/input.txt) before release." },
  });
  try {
    const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.ok(publicRecord.includes("- Inspect [ABS_PATH]) before release."));
    negativeControl("standalone closing delimiter after file URL redaction");
  } finally {
    review.fixture.cleanup();
  }
});

for (const [description, topic, terminator] of [
  ["closing parenthesis", "review-spaced-path-after-parenthesis", ")"],
  ["closing quote", "review-spaced-path-after-quote", '"'],
  ["closing bracket", "review-spaced-path-after-bracket", "]"],
]) {
  test(`review refuses a spaced-path continuation after a ${description}`, () => {
    const command = `inspect file:///var/tmp/private${terminator} folder/secret.txt`;
    assert.match(command, HISTORICAL_REVIEW_AMBIGUOUS_PATH_PATTERN);
    const review = makeReviewFixture(topic, {
      verdict: "PASS",
      payload: {
        reexecuted: [{
          command,
          cwd: "scratch",
          exit_code: 0,
          result: "The command was inspected without execution.",
          tests_pass: false,
          witness: null,
        }],
      },
    });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      assert.equal(run.status, 2, run.stderr);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /projected payload contains an ambiguous absolute path/u);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      assert.ok(!existsSync(join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`)));
      negativeControl(`spaced-path continuation after a ${description}`);
    } finally {
      review.fixture.cleanup();
    }
  });
}

for (const [description, topic, field, value] of [
  [
    "greater-than terminator",
    "review-spaced-path-after-greater-than",
    "command",
    "inspect <file:///var/tmp/private> folder/secret.txt",
  ],
  [
    "colon terminator",
    "review-spaced-path-after-colon",
    "prose",
    "Path /var/tmp/private: folder/secret.txt was observed; Fix: remove it",
  ],
  [
    "less-than terminator",
    "review-spaced-path-after-less-than",
    "command",
    "inspect file:///var/tmp/private< folder/secret.txt",
  ],
  [
    "opening-bracket terminator",
    "review-spaced-path-after-opening-bracket",
    "prose",
    "Path /var/tmp/private[ folder/secret.txt was observed; Fix: remove it",
  ],
  [
    "closing-brace terminator",
    "review-spaced-path-after-closing-brace",
    "command",
    "inspect file:///var/tmp/private} folder/secret.txt",
  ],
  [
    "arbitrary punctuation run",
    "review-spaced-path-after-punctuation-run",
    "prose",
    "Path /var/tmp/private>}:!? folder/secret.txt was observed; Fix: remove it",
  ],
]) {
  test(`review refuses a spaced-path continuation after any ${description}`, () => {
    assert.match(value, HISTORICAL_REVIEW_AMBIGUOUS_PATH_PATTERN);
    const payload = field === "command"
      ? {
          reexecuted: [{
            command: value,
            cwd: "scratch",
            exit_code: 0,
            result: "The command was inspected without execution.",
            tests_pass: false,
            witness: null,
          }],
        }
      : { findings: `- [Moderate] shared.txt:1 - ${value}` };
    const review = makeReviewFixture(topic, { verdict: "PASS", payload });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      assert.equal(run.status, 2, run.stderr);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /projected payload contains an ambiguous absolute path/u);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      assert.ok(!existsSync(join(
        review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`,
      )));
      negativeControl(`spaced-path continuation after any ${description}`);
    } finally {
      review.fixture.cleanup();
    }
  });
}

test("review refuses a spaced-path continuation with an embedded absolute-path match", () => {
  const topic = "review-spaced-path-embedded-absolute";
  const command = "inspect file:///var/tmp/private relative/path:/opt/other";
  assert.match(command, HISTORICAL_REVIEW_AMBIGUOUS_PATH_PATTERN);
  const review = makeReviewFixture(topic, {
    verdict: "PASS",
    payload: {
      reexecuted: [{
        command,
        cwd: "scratch",
        exit_code: 0,
        result: "The command was inspected without execution.",
        tests_pass: false,
        witness: null,
      }],
    },
  });
  try {
    const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /projected payload contains an ambiguous absolute path/u);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    assert.ok(!existsSync(join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`)));
    negativeControl("spaced-path continuation with an embedded absolute-path match");
  } finally {
    review.fixture.cleanup();
  }
});

test("review refuses a parenthesized file URL residue", () => {
  const topic = "review-file-url-parenthesis";
  const review = makeReviewFixture(topic, {
    verdict: "PASS",
    payload: {
      reexecuted: [{
        command: "inspect file:///var/tmp/(private)/input.txt",
        cwd: "scratch",
        exit_code: 0,
        result: "The command was inspected without execution.",
        tests_pass: false,
        witness: null,
      }],
    },
  });
  try {
    const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /projected payload contains an ambiguous absolute path/u);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    assert.ok(!existsSync(join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`)));
    negativeControl("parenthesized file URL residue");
  } finally {
    review.fixture.cleanup();
  }
});

test("review sanitization preserves unrelated words and fails closed on ambiguous or unsafe payloads", () => {
  const fixtures = [];
  try {
    const preserved = makeReviewFixture("review-boundary", { verdict: "PASS" });
    fixtures.push(preserved.fixture);
    const username = userInfo().username;
    preserved.fixture.env.FAKE_REVIEW_PAYLOAD = JSON.stringify({
      findings: "- [Minor] shared.txt:1 - Annex remains unchanged; Fix: keep annex unchanged",
      nonclaims: `- ANN met annex.\n- _Ann_ and _${username}_ are private aliases.`,
      identifiers: ["Ann"],
      analysis: "Private only.",
    });
    const preservedRun = lane(preserved.fixture, ["review", "review-boundary", "--round", "1", "--brief", preserved.brief]);
    assert.equal(preservedRun.status, 0, preservedRun.stderr);
    const preservedHead = git(preserved.path, ["rev-parse", "HEAD"]);
    const preservedPublic = readFileSync(join(
      preserved.path, "docs", "reviews", "review-boundary", `${preservedHead.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.match(preservedPublic, /Annex remains unchanged; Fix: keep annex unchanged/);
    assert.match(preservedPublic, /- \[PRIVATE\] met annex\./);
    assert.match(preservedPublic, /- \\_\[PRIVATE\]\\_ and \\_\[USER\]\\_ are private aliases\./);

    const cases = [
      ["alias-ambiguity", { identifiers: ["Ann", "Anna"] }],
      ["protected-location", { findings: "- [Major] shared.txt:1 - issue; Fix: change it", identifiers: ["shared"] }],
      ["location-backtick", { findings: "- [Major] `shared`.txt:1 - issue; Fix: change it" }],
      ["location-angle", { findings: "- [Major] <shared>.txt:1 - issue; Fix: change it" }],
      ["location-bracket", { findings: "- [Major] [shared].txt:1 - issue; Fix: change it" }],
      ["location-emphasis", { findings: "- [Major] **shared**.txt:1 - issue; Fix: change it" }],
      ["location-placeholder", { findings: "- [Major] [USER].txt:1 - issue; Fix: change it" }],
      ["location-encoded", { findings: "- [Major] shared%2Fsecret.txt:1 - issue; Fix: change it", identifiers: ["secret"] }],
      ["location-path-after-paren", { findings: "- [Major] wrapper)/var/tmp/private.txt:1 - issue; Fix: change it" }],
      ["location-path-after-bracket", { findings: "- [Major] wrapper]/var/tmp/private.txt:1 - issue; Fix: change it" }],
      ["location-path-after-brace", { findings: "- [Major] wrapper}/var/tmp/private.txt:1 - issue; Fix: change it" }],
      ["ambiguous-spaced-path", { nonclaims: "- The external record /var/tmp/private first second next/segment was not inspected." }],
      ["location-path-flag-segment", { findings: "- [Major] wrapper)/var/tmp/g:1 - issue; Fix: change it" }],
      ["percent-encoded-alias", { nonclaims: "- A%6En was not independently authenticated.", identifiers: ["Ann"] }],
      ["numeric-reference-alias", { nonclaims: "- A&#110;n was not independently authenticated.", identifiers: ["Ann"] }],
      ["non-ascii", { findings: "- [Minor] shared.txt:1 - caf\u00e9 issue; Fix: use ASCII" }],
      ["placeholder", { nonclaims: "- Existing [USER] marker." }],
    ];
    for (const [suffix, payload] of cases) {
      const topic = `review-${suffix}`;
      const refused = makeReviewFixture(topic, { verdict: "PASS", payload });
      fixtures.push(refused.fixture);
      const run = lane(refused.fixture, ["review", topic, "--round", "1", "--brief", refused.brief]);
      assert.equal(run.status, 2, `${suffix}\n${run.stderr}`);
      assert.equal(run.stdout, "");
      const head = git(refused.path, ["rev-parse", "HEAD"]);
      assert.ok(!existsSync(join(refused.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`)));
    }
    negativeControl("sanitization boundaries and refusals");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review projects command syntax verbatim while escaping the same characters in prose", () => {
  const fixtures = [];
  const machineSyntax = "env PATH=<node and system bin only> printf '`value` [item] ** %2F &amp; \\x41 \\u0041' > $VAR";
  try {
    const accepted = makeReviewFixture("review-command-syntax", {
      verdict: "NEEDS-WORK",
      payload: {
        findings: [
          "- [Minor] first.txt:1 - first issue; Fix: fix the first issue",
          "- [Moderate] second.txt:2 - second issue; Fix: fix the second issue",
        ].join("\n"),
        reexecuted: [{
          command: machineSyntax,
          cwd: "scratch",
          exit_code: 1,
          result: "The command exited with the expected diagnostic.",
          tests_pass: false,
          witness: {
            kind: "negative-control",
            command: `${machineSyntax} --negative-control`,
            cwd: "scratch",
            exit_code: 1,
            result: "The deliberate control failed.",
            observed_failure: "The expected failure was observed.",
          },
        }],
      },
    });
    fixtures.push(accepted.fixture);
    const acceptedRun = lane(accepted.fixture, [
      "review", "review-command-syntax", "--round", "1", "--brief", accepted.brief,
    ]);
    assert.equal(acceptedRun.status, 1, acceptedRun.stderr);
    const head = git(accepted.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      accepted.path, "docs", "reviews", "review-command-syntax", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.match(publicRecord, /first\.txt:1 - first issue/);
    assert.match(publicRecord, /second\.txt:2 - second issue/);
    const publicExecutions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
    assert.equal(publicExecutions[0].command, machineSyntax);
    assert.equal(publicExecutions[0].witness.command, `${machineSyntax} --negative-control`);

    const prose = makeReviewFixture("review-prose-syntax", {
      verdict: "PASS",
      payload: {
        findings: `- [Minor] shared.txt:1 - ${machineSyntax}; Fix: use plain prose`,
      },
    });
    fixtures.push(prose.fixture);
    const proseRun = lane(prose.fixture, [
      "review", "review-prose-syntax", "--round", "1", "--brief", prose.brief,
    ]);
    assert.equal(proseRun.status, 0, proseRun.stderr);
    const proseHead = git(prose.path, ["rev-parse", "HEAD"]);
    const prosePublic = readFileSync(join(
      prose.path, "docs", "reviews", "review-prose-syntax", `${proseHead.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.match(prosePublic, /PATH=\\<node and system bin only\\>/u);
    assert.ok(prosePublic.includes("'\\`value\\` \\[item\\] \\*\\* %2F &amp;"));

    const reserved = makeReviewFixture("review-command-placeholder", {
      verdict: "PASS",
      payload: {
        reexecuted: [{
          command: "printf [USER]",
          cwd: "scratch",
          exit_code: 0,
          result: "Command completed.",
          tests_pass: false,
          witness: null,
        }],
      },
    });
    fixtures.push(reserved.fixture);
    const reservedRun = lane(reserved.fixture, [
      "review", "review-command-placeholder", "--round", "1", "--brief", reserved.brief,
    ]);
    assert.equal(reservedRun.status, 2, reservedRun.stderr);
    assert.equal(reservedRun.stdout, "");
    assert.match(reservedRun.stderr, /reserved sanitizer placeholder/);

    const nonAscii = makeReviewFixture("review-command-non-ascii", {
      verdict: "PASS",
      payload: {
        reexecuted: [{
          command: "printf caf\u00e9",
          cwd: "scratch",
          exit_code: 0,
          result: "Command completed.",
          tests_pass: false,
          witness: null,
        }],
      },
    });
    fixtures.push(nonAscii.fixture);
    const nonAsciiRun = lane(nonAscii.fixture, [
      "review", "review-command-non-ascii", "--round", "1", "--brief", nonAscii.brief,
    ]);
    assert.equal(nonAsciiRun.status, 2, nonAsciiRun.stderr);
    assert.equal(nonAsciiRun.stdout, "");
    assert.match(nonAsciiRun.stderr, /projected payload contains unsupported non-ASCII text/);
    negativeControl("verbatim command projection and escaped prose");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review escapes prose punctuation after sanitizing the unescaped payload", () => {
  const findings = [
    "- [Minor] first.txt:1 - `git status` reported **fatal** for [draft] <path> and snake_case; Fix: quote `--` and keep __tokens__ literal",
    "- [Moderate] second.txt:2 - asterisk * underscore _ brackets [] and angles <> remain visible; Fix: preserve every quoted character",
  ].join("\n");
  const nonclaims = "- Quoted `usage [--flag] <path>` and **bold** __label__ text with a literal \\ separator is not a claim.";
  const unverified = "- Git said: `fatal: pathspec '[draft]_<name>.md' did not match any files`.";
  const review = makeReviewFixture("review-escaped-prose", {
    verdict: "NEEDS-WORK",
    payload: { findings, nonclaims, unverified },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-escaped-prose", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 1, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-escaped-prose", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    for (const escaped of [
      "\\`git status\\`", "\\*\\*fatal\\*\\*", "\\[draft\\]", "\\<path\\>", "snake\\_case",
      "\\`--\\`", "\\_\\_tokens\\_\\_", "asterisk \\*", "underscore \\_", "brackets \\[\\]",
      "angles \\<\\>", "\\`usage \\[--flag\\] \\<path\\>\\`", "\\*\\*bold\\*\\*",
      "\\_\\_label\\_\\_", "literal \\\\ separator", "pathspec '\\[draft\\]\\_\\<name\\>.md'",
    ]) assert.ok(publicRecord.includes(escaped), `missing escaped prose: ${escaped}\n${publicRecord}`);
    assert.equal((publicRecord.match(/^- \[(?:Major|Moderate|Minor)\]/gmu) || []).length, 2);
    const renderedLiteral = publicRecord.replace(/\\([\\`*_\[\]<>])/gu, "$1");
    assert.ok(renderedLiteral.includes(findings.split("\n")[0]));
    assert.ok(renderedLiteral.includes(findings.split("\n")[1]));
    assert.ok(renderedLiteral.includes(nonclaims));
    assert.ok(renderedLiteral.includes(unverified));
    negativeControl("escaped review prose projection");
  } finally {
    review.fixture.cleanup();
  }
});

test("review refuses an opening parenthesis after a concrete path match", () => {
  const review = makeReviewFixture("review-placeholder-parenthesis", {
    verdict: "PASS",
    payload: { unverified: "- Inspect /opt/review-tool(note) in a later check." },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-placeholder-parenthesis", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /projected payload contains an ambiguous absolute path/u);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    assert.ok(!existsSync(join(
      review.path, "docs", "reviews", "review-placeholder-parenthesis", `${head.slice(0, 7)}-r1.md`,
    )));
    negativeControl("parenthesized concrete path refusal");
  } finally {
    review.fixture.cleanup();
  }
});

test("review projects every finding from the sanitized production PASS fixture", () => {
  const fixturePath = process.env.LANE_BOARD_REVIEW_FIXTURE ?? join(
    HERE, "fixtures", "board-cli-pass-review.md",
  );
  const payload = reviewPayloadFixture(fixturePath);
  const review = makeReviewFixture("review-production-pass", { verdict: "PASS", record: fixturePath });
  try {
    const run = lane(review.fixture, [
      "review", "review-production-pass", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-production-pass", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    const sourceFindings = payload.findings.split("\n");
    assert.equal((publicRecord.match(/^- \[(?:Major|Moderate|Minor)\]/gmu) || []).length, sourceFindings.length);
    for (const finding of sourceFindings) assert.ok(publicRecord.includes(finding), `missing finding: ${finding}`);
    negativeControl("production PASS projection");
  } finally {
    review.fixture.cleanup();
  }
});

test("review refuses a finding description containing a declared private identifier", () => {
  const review = makeReviewFixture("review-private-description", {
    verdict: "PASS",
    payload: {
      findings: "- [Minor] shared.txt:1 - Reviewer_Secret appears in quoted prose; Fix: remove the private identifier",
      identifiers: ["Reviewer_Secret"],
    },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-private-description", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
    const head = git(review.path, ["rev-parse", "HEAD"]);
    assert.ok(!existsSync(join(
      review.path, "docs", "reviews", "review-private-description", `${head.slice(0, 7)}-r1.md`,
    )));
    negativeControl("declared private identifier in finding prose");
  } finally {
    review.fixture.cleanup();
  }
});

test("review allows private-only heading text inside a verbatim command", () => {
  const command = "printf '## Analysis and ## Private identifiers are quoted command text'";
  const review = makeReviewFixture("review-command-headings", {
    verdict: "PASS",
    payload: {
      reexecuted: [{
        command,
        cwd: "scratch",
        exit_code: 0,
        result: "Command text was inspected without execution.",
        tests_pass: false,
        witness: null,
      }],
    },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-command-headings", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-command-headings", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    const executions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
    assert.equal(executions[0].command, command);
    assert.equal((publicRecord.match(/^## Analysis$/gmu) || []).length, 0);
    assert.equal((publicRecord.match(/^## Private identifiers$/gmu) || []).length, 0);
    negativeControl("private heading text inside command");
  } finally {
    review.fixture.cleanup();
  }
});

test("review publishes exclusively, leaves normal clean-tree commands refusing, and blocks the occupied round", () => {
  const review = makeReviewFixture("review-public-boundary", { verdict: "PASS" });
  try {
    const first = lane(review.fixture, ["review", "review-public-boundary", "--round", "1", "--brief", review.brief]);
    assert.equal(first.status, 0, first.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicPath = join(review.path, "docs", "reviews", "review-public-boundary", `${head.slice(0, 7)}-r1.md`);
    assert.ok(existsSync(publicPath));
    const prompts = review.fake.calls().filter((args) => args[0] === "agent" && args[1] === "prompt").length;
    const second = lane(review.fixture, ["review", "review-public-boundary", "--round", "1", "--brief", review.brief]);
    assert.equal(second.status, 2);
    assert.equal(second.stdout, "");
    assert.equal(review.fake.calls().filter((args) => args[0] === "agent" && args[1] === "prompt").length, prompts);
    const check = lane(review.fixture, ["check", "--cmd", "true"], { cwd: review.path });
    assert.equal(check.status, 1);
    assert.match(check.stderr, /current worktree is not clean/);
    const promote = lane(review.fixture, ["promote", "review-public-boundary"]);
    assert.equal(promote.status, 1);
    assert.match(promote.stderr, /lane worktree is not clean/);
    negativeControl("exclusive publication and clean-tree refusal");
  } finally {
    review.fixture.cleanup();
  }
});

test("review late-publication mutation exits 2 and retains both evidence files", async () => {
  const review = makeReviewFixture("review-late-public", { verdict: "PASS" });
  try {
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const directory = join(review.path, "docs", "reviews", "review-late-public");
    const publicPath = join(directory, `${head.slice(0, 7)}-r1.md`);
    mkdirSync(directory, { recursive: true });
    let mutated = false;
    const mutator = setInterval(() => {
      if (!mutated && existsSync(publicPath)) {
        mutated = true;
        writeFileSync(join(review.path, "late-mutation.txt"), "late\n");
      }
    }, 1);
    const child = spawn(process.execPath, [
      LANE, "review", "review-late-public", "--round", "1", "--brief", review.brief,
    ], {
      cwd: review.fixture.repo,
      env: hermeticGitEnvironment(review.fixture.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const result = await new Promise((resolvePromise) => child.once("close", (code) => resolvePromise(code)));
    clearInterval(mutator);
    assert.equal(result, 2, stderr);
    assert.equal(stdout, "");
    assert.ok(mutated);
    assert.ok(existsSync(publicPath));
    assert.ok(existsSync(join(review.fixture.repo, ".lane", "reviews", "review-late-public", `${head.slice(0, 7)}-r1.md`)));
    assert.match(stderr, /mutation after public review creation|late publication/);
    negativeControl("late publication evidence retention");
  } finally {
    review.fixture.cleanup();
  }
});

test("review renders OpenSpec, supplemental literal input, gate, and captured commit metadata", () => {
  const review = makeReviewFixture("review-source", {
    verdict: "PASS",
    brief: "Review run budget:\n- command: printf '$HOME; $(touch nope)'\n  maximum runs: 1\nSecond line.\n",
  });
  try {
    const changeRoot = join(review.path, "openspec", "changes", "different-change");
    mkdirSync(join(changeRoot, "specs", "sample"), { recursive: true });
    for (const [name, text] of [
      ["proposal.md", "proposal sentinel"],
      ["design.md", "design sentinel"],
      ["tasks.md", "tasks sentinel"],
      [join("specs", "sample", "spec.md"), "delta sentinel"],
    ]) writeFileSync(join(changeRoot, name), `${text}\n`);
    mkdirSync(join(review.path, "openspec", "specs", "sample"), { recursive: true });
    writeFileSync(join(review.path, "openspec", "specs", "sample", "spec.md"), "current sentinel\n");
    git(review.path, ["add", "openspec"]);
    git(review.path, ["commit", "-m", "add review source"], { stdio: "ignore" });
    const head = git(review.path, ["rev-parse", "HEAD"]);
    mkdirSync(join(review.path, ".lane"), { recursive: true });
    writeFileSync(join(review.path, ".lane", "gate.json"), `${JSON.stringify({
      head,
      branch: "lane/review-source",
      command: "node --test",
      exit_code: 0,
      signal: null,
      started_at: "2026-09-09T00:00:00.000Z",
      finished_at: "2026-09-09T00:00:01.000Z",
      duration_s: 1,
    })}\n`);
    const run = lane(review.fixture, [
      "review", "review-source", "--round", "2", "--change", "different-change",
      "--brief", review.brief, "--route", "alternate", "--timeout", "5",
    ]);
    assert.equal(run.status, 0, run.stderr);
    const prompt = review.fake.calls().find((args) => args[0] === "agent" && args[1] === "prompt")?.[3] ?? "";
    for (const sentinel of ["proposal sentinel", "design sentinel", "tasks sentinel", "delta sentinel", "current sentinel"]) {
      assert.match(prompt, new RegExp(sentinel));
    }
    assert.match(prompt, /printf '\$HOME; \$\(touch nope\)'/);
    assert.match(prompt, new RegExp(`Reviewed commit: ${head}`));
    assert.match(prompt, /Gate at captured HEAD: exit=0/);
    assert.match(prompt, /Route: alternate/);
    assert.match(prompt, /Timeout seconds: 5/);
    negativeControl("review source and captured metadata rendering");
  } finally {
    review.fixture.cleanup();
  }
});

test("review keeps uppercase brace tokens literal in briefs and tracked source files", () => {
  const fixtures = [];
  try {
    const briefReview = makeReviewFixture("review-brief-token", {
      verdict: "PASS", brief: "Treat {{BRIEF_TOKEN}} as literal source text.\n",
    });
    fixtures.push(briefReview.fixture);
    const briefRun = lane(briefReview.fixture, [
      "review", "review-brief-token", "--round", "1", "--brief", briefReview.brief,
    ]);
    assert.equal(briefRun.status, 0, briefRun.stderr);
    const briefPrompt = briefReview.fake.calls().find((args) => args[0] === "agent" && args[1] === "prompt")?.[3] ?? "";
    assert.match(briefPrompt, /\{\{BRIEF_TOKEN\}\}/);

    const trackedReview = makeReviewFixture("review-tracked-token", { verdict: "PASS" });
    fixtures.push(trackedReview.fixture);
    writeFileSync(join(trackedReview.path, "AGENTS.md"), "Treat {{TRACKED_TOKEN}} as literal source text.\n");
    git(trackedReview.path, ["add", "AGENTS.md"]);
    git(trackedReview.path, ["commit", "-m", "add literal review source"], { stdio: "ignore" });
    const trackedRun = lane(trackedReview.fixture, [
      "review", "review-tracked-token", "--round", "1", "--brief", trackedReview.brief,
    ]);
    assert.equal(trackedRun.status, 0, trackedRun.stderr);
    const trackedPrompt = trackedReview.fake.calls().find((args) => args[0] === "agent" && args[1] === "prompt")?.[3] ?? "";
    assert.match(trackedPrompt, /\{\{TRACKED_TOKEN\}\}/);
    negativeControl("literal source brace tokens");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review accepts negated test-pass limits but still refuses affirmative prose claims", () => {
  const fixtures = [];
  try {
    const limited = makeReviewFixture("review-negated-claim", {
      verdict: "PASS",
      payload: {
        unverified: "- Tests passed was not claimed.\n- The tests passed witness is unavailable.",
        analysis: "Tests passed appears only in private analysis.",
      },
    });
    fixtures.push(limited.fixture);
    const limitedRun = lane(limited.fixture, [
      "review", "review-negated-claim", "--round", "1", "--brief", limited.brief,
    ]);
    assert.equal(limitedRun.status, 0, limitedRun.stderr);

    const affirmative = makeReviewFixture("review-affirmative-claim", {
      verdict: "PASS", payload: { unverified: "- Tests passed in the suite." },
    });
    fixtures.push(affirmative.fixture);
    const affirmativeRun = lane(affirmative.fixture, [
      "review", "review-affirmative-claim", "--round", "1", "--brief", affirmative.brief,
    ]);
    assert.equal(affirmativeRun.status, 2, affirmativeRun.stderr);
    assert.equal(affirmativeRun.stdout, "");
    negativeControl("negated and affirmative test-pass prose");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review refuses malformed private evidence, incomplete output, timeout, and lane mutation", () => {
  const cases = [
    ["sha-mismatch", "PASS", 2],
    ["review-id-mismatch", "PASS", 2],
    ["bad-witness", "PASS", 2],
    ["bad-finding", "PASS", 2],
    ["incomplete", "PASS", 2],
    ["oversized", "PASS", 2],
    ["dirty-public", "PASS", 2],
    ["dirty-tracked", "PASS", 2],
    ["dirty-index", "PASS", 2],
    ["head-move", "PASS", 2],
    ["missing", undefined, 2],
  ];
  const fixtures = [];
  try {
    for (const [mode, verdict, exit] of cases) {
      const topic = `review-${mode}`;
      const review = makeReviewFixture(topic, { verdict, mode });
      fixtures.push(review.fixture);
      const capturedHead = git(review.path, ["rev-parse", "HEAD"]);
      const timeout = ["incomplete", "missing"].includes(mode) ? "3" : "4";
      const run = lane(review.fixture, [
        "review", topic, "--round", "1", "--brief", review.brief, "--timeout", timeout,
      ]);
      assert.equal(run.status, exit, `${mode}\n${run.stderr}`);
      assert.equal(run.stdout, "");
      const privatePath = join(review.fixture.repo, ".lane", "reviews", topic, `${capturedHead.slice(0, 7)}-r1.md`);
      if (verdict !== undefined) assert.ok(existsSync(privatePath));
      if (mode === "missing") {
        assert.match(run.stderr, /review timed out; reviewer agent '[a-z0-9_-]+' in tab w-lane:t2/);
      }
      assert.ok(review.fake.calls().filter((args) => args[0] === "agent" && args[1] === "prompt").length === 1);
    }
    negativeControl("review evidence and unchanged-lane refusals");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review sends malformed completed endings to schema validation without waiting for timeout", () => {
  const cases = [
    ["trailing-space-line", /private review completion marker must be the last nonempty line/],
    ["trailing-tab-line", /private review completion marker must be the last nonempty line/],
    ["crlf-record", /private review must use LF line endings; CRLF is not supported/],
  ];
  const fixtures = [];
  const outcomes = [];
  try {
    for (const [mode, diagnostic] of cases) {
      const topic = `review-${mode}`;
      const review = makeReviewFixture(topic, { verdict: "PASS", mode });
      fixtures.push(review.fixture);
      const started = Date.now();
      const run = lane(review.fixture, [
        "review", topic, "--round", "1", "--brief", review.brief, "--timeout", "4",
      ]);
      outcomes.push({
        mode,
        status: run.status,
        emptyStdout: run.stdout === "",
        schemaDiagnostic: diagnostic.test(run.stderr),
        timedOut: /review timed out/.test(run.stderr),
        elapsedMs: Date.now() - started,
      });
    }
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 2, JSON.stringify(outcome));
      assert.equal(outcome.emptyStdout, true, JSON.stringify(outcome));
      assert.equal(outcome.schemaDiagnostic, true, JSON.stringify(outcome));
      assert.equal(outcome.timedOut, false, JSON.stringify(outcome));
      assert.ok(outcome.elapsedMs >= 2_000 && outcome.elapsedMs < 3_800, JSON.stringify(outcome));
    }
    negativeControl("malformed completed record fast schema refusal");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review contains unexpected errors when the target disappears after dispatch", () => {
  const review = makeReviewFixture("review-removed-worktree", {
    verdict: "PASS", mode: "remove-worktree",
  });
  try {
    const capturedHead = git(review.path, ["rev-parse", "HEAD"]);
    const run = lane(review.fixture, [
      "review", "review-removed-worktree", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /lane review: unexpected failure; private evidence may have been retained/);
    assert.doesNotMatch(run.stderr, /(?:Error:|\n\s+at )/);
    assert.doesNotMatch(run.stderr, new RegExp(review.fixture.root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.ok(existsSync(join(
      review.fixture.repo, ".lane", "reviews", "review-removed-worktree", `${capturedHead.slice(0, 7)}-r1.md`,
    )));
    negativeControl("unexpected review error boundary");
  } finally {
    review.fixture.cleanup();
  }
});

test("review unexpected failure after publication warns about retained public evidence", async () => {
  const review = makeReviewFixture("review-post-public-error", { verdict: "PASS" });
  try {
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicPath = join(
      review.path, "docs", "reviews", "review-post-public-error", `${head.slice(0, 7)}-r1.md`,
    );
    let injected = false;
    const mutator = setInterval(() => {
      if (!injected && existsSync(publicPath)) {
        injected = true;
        renameSync(join(review.path, ".git"), join(review.path, ".git-injected-failure"));
      }
    }, 1);
    const child = spawn(process.execPath, [
      LANE, "review", "review-post-public-error", "--round", "1", "--brief", review.brief,
    ], {
      cwd: review.fixture.repo,
      env: hermeticGitEnvironment(review.fixture.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const result = await new Promise((resolvePromise) => child.once("close", (code) => resolvePromise(code)));
    clearInterval(mutator);
    assert.equal(result, 2, stderr);
    assert.equal(stdout, "");
    assert.equal(injected, true);
    assert.ok(existsSync(publicPath));
    assert.match(stderr, /public record may also have been created/);
    assert.match(stderr, /must be inspected before recovery/);
    assert.doesNotMatch(stderr, /(?:Error:|\n\s+at )/);
    assert.doesNotMatch(stderr, new RegExp(review.fixture.root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    negativeControl("post-publication unexpected failure recovery diagnostic");
  } finally {
    review.fixture.cleanup();
  }
});

test("review interruption exits 2 without a verdict or follow-up lifecycle action", async () => {
  const review = makeReviewFixture("review-interrupt");
  try {
    const child = spawn(process.execPath, [
      LANE, "review", "review-interrupt", "--round", "1", "--brief", review.brief,
    ], {
      cwd: review.fixture.repo,
      env: hermeticGitEnvironment(review.fixture.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const started = Date.now();
    while ((!existsSync(review.fake.log) || !readFileSync(review.fake.log, "utf8").includes('["agent","prompt"')) && Date.now() - started < 5000) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    child.kill("SIGTERM");
    const result = await new Promise((resolvePromise) => child.once("close", (code, signal) => resolvePromise({ code, signal })));
    assert.equal(result.code, 2, `signal=${result.signal}\n${stderr}`);
    assert.equal(stdout, "");
    assert.match(stderr, /review interrupted; reviewer agent '[a-z0-9_-]+' in tab w-lane:t2 may still write late evidence/);
    const calls = review.fake.calls();
    assert.equal(calls.filter((args) => args[0] === "agent" && args[1] === "prompt").length, 1);
    assert.ok(!calls.some((args) => ["close", "remove"].includes(args[1])));
    negativeControl("review interruption cleanup");
  } finally {
    review.fixture.cleanup();
  }
});

test("review reference describes the shipped public path and protected-location policy", () => {
  const reference = readFileSync(join(HERE, "..", "docs", "REFERENCE.md"), "utf8");
  assert.doesNotMatch(reference, /even though this first slice does not write it/);
  assert.match(reference, /same command creates the public record after the\s+unchanged-lane check/);
  assert.match(reference, /reserved placeholders[^.]*finding locations/iu);
  negativeControl("review reference publication and location wording");
});

test("review protocol documents settled records, normalized boundaries, and consecutive findings", () => {
  const reference = readFileSync(join(HERE, "..", "docs", "REFERENCE.md"), "utf8");
  const template = readFileSync(join(HERE, "..", "docs", "REVIEW_TEMPLATE.md"), "utf8");
  const design = readFileSync(join(HERE, "..", "openspec", "changes", "review-cli", "design.md"), "utf8");
  const currentSpec = readFileSync(join(
    HERE, "..", "openspec", "specs", "foreground-lane-review", "spec.md",
  ), "utf8");
  const deltaSpec = readFileSync(join(
    HERE, "..", "openspec", "changes", "review-cli", "specs", "foreground-lane-review", "spec.md",
  ), "utf8");
  for (const document of [reference, template, design]) {
    assert.match(document, /leading and trailing (?:blank-line|newline)\s+runs/iu);
  }
  assert.match(design, /completion probe[^.]*more permissive than schema validation/iu);
  assert.match(design, /malformed but finished output reaches validation[^.]*settle interval/iu);
  assert.match(reference, /accepts 3 through 7200/iu);
  assert.match(design, /accepts integers 3 through 7200/iu);
  for (const document of [reference, design]) {
    assert.match(document, /size and\s+modification time[^.]*two continuous seconds/iu);
    assert.match(document, /re-reads?\s+(?:the\s+)?(?:record\s+)?bytes[^.]*immediately before validation/iu);
  }
  for (const document of [reference, template]) {
    assert.match(
      document,
      /Findings, Non-claims, and\s+Unverified entries each occupy\s+consecutive lines\s+with no blank\s+line/iu,
    );
  }
  assert.match(design, /Findings, Non-claims, and\s+Unverified entries[^.]*consecutive lines[^.]*no blank\s+line/iu);
  for (const document of [reference, template]) {
    assert.match(document, /LF line endings only/iu);
    assert.match(document, /command strings[^.]*verbatim/iu);
    assert.match(document, /prose may[^.]*quote/iu);
    assert.match(document, /backslash-escapes? every/iu);
    for (const characterName of ["backslash", "backtick", "asterisk", "underscore", "square bracket", "angle bracket"]) {
      assert.match(document, new RegExp(characterName, "iu"));
    }
    assert.match(document, /unescaped\s+payload/iu);
    assert.match(document, /refuses prose only[^.]*non-ASCII[^.]*control[^.]*unresolved\s+private identifiers[^.]*reserved placeholders[^.]*residual/iu);
    assert.match(document, /finding (?:file-and-line|file and line)[^.]*stricter[^.]*markup[^.]*encoding/iu);
  }
  assert.match(design, /underscore is therefore a boundary/iu);
  assert.match(design, /percent octets[^.]*numeric character references[^.]*scratch copy/iu);
  assert.doesNotMatch(design, /first physical line/iu);
  for (const spec of [currentSpec, deltaSpec]) {
    assert.match(spec, /boundary blank lines/iu);
    assert.match(spec, /first nonempty line/iu);
    assert.match(spec, /malformed completed record/iu);
    assert.match(spec, /record settle/iu);
  }
  negativeControl("review boundary protocol documentation");
});

test("review protocol documents asymmetric path redaction and spaced-path refusal", () => {
  const reference = readFileSync(join(HERE, "..", "docs", "REFERENCE.md"), "utf8");
  const template = readFileSync(join(HERE, "..", "docs", "REVIEW_TEMPLATE.md"), "utf8");
  const design = readFileSync(join(HERE, "..", "openspec", "changes", "review-cli", "design.md"), "utf8");
  const currentSpec = readFileSync(join(
    HERE, "..", "openspec", "specs", "foreground-lane-review", "spec.md",
  ), "utf8");
  const deltaSpec = readFileSync(join(
    HERE, "..", "openspec", "changes", "review-cli", "specs", "foreground-lane-review", "spec.md",
  ), "utf8");
  for (const document of [reference, design]) {
    assert.match(document, /regex literals and\s+slash-delimited phrases[^.]*may be replaced[^.]*absolute-path\s+placeholder/iu);
    assert.match(document, /- Ambiguous spaced path:/u);
    assert.match(document, /concrete matcher[^.]*never refuses[^.]*ambiguous spaced-path[^.]*still can/iu);
    assert.match(document, /opening parenthesis[^.]*refus/iu);
    assert.match(document, /closing parenthesis[^.]*non-whitespace[^.]*refus/iu);
    assert.match(
      document,
      /each\s+concrete\s+absolute-path match[^.]*next whitespace[^.]*regardless of any intervening non-whitespace/iu,
    );
    assert.match(document, /concrete matches[^.]*unmatched separator-bearing\s+prefix or suffix/iu);
  }
  assert.match(reference, /The path-specific refusals are:/u);
  for (const spec of [currentSpec, deltaSpec]) {
    assert.match(spec, /regex literals and\s+slash-delimited phrases[^.]*may be replaced[^.]*absolute-path\s+placeholder/iu);
    assert.match(spec, /opening parenthesis[^.]*refus/iu);
    assert.match(spec, /closing parenthesis[^.]*non-whitespace[^.]*refus/iu);
    assert.match(spec, /after (?:each|any) concrete (?:absolute-path )?match[^.]*next whitespace[^.]*intervening non-whitespace/iu);
    assert.match(spec, /concrete matches[^.]*unmatched separator-bearing prefix or suffix/iu);
  }
  for (const document of [reference, template]) {
    assert.match(
      document,
      /publication refuses prose only[^.]*ambiguous\s+spaced paths[^.]*parenthesized path residue/iu,
    );
  }
  assert.match(template, /opening parenthesis immediately after an absolute path/iu);
  assert.match(template, /ambiguous spaced path[^.]*public-safe words[^.]*separate\s+fields/iu);
  assert.match(template, /after (?:each|any) concrete absolute path[^.]*next whitespace[^.]*intervening non-whitespace/iu);
  negativeControl("asymmetric path-redaction documentation");
});

test("review preflight requires ignored private and trackable absent public paths", () => {
  const fixtures = [];
  try {
    const privateNotIgnored = makeFixture({ main: "main", routes: { review: { kind: "codex" } } });
    fixtures.push(privateNotIgnored);
    const lanePathValue = openLane(privateNotIgnored, "private-ignore");
    const brief = join(privateNotIgnored.root, "brief.md");
    writeFileSync(brief, "Review.\n");
    writeFakeHerdr(privateNotIgnored, {
      lanePath: lanePathValue, branch: "lane/private-ignore", initiallyOpened: true, reviewVerdict: "PASS",
    });
    const ignoredRun = lane(privateNotIgnored, ["review", "private-ignore", "--round", "1", "--brief", brief]);
    assert.equal(ignoredRun.status, 2, ignoredRun.stderr);
    assert.equal(ignoredRun.stdout, "");

    const publicIgnored = makeReviewFixture("public-ignore", { verdict: "PASS" });
    fixtures.push(publicIgnored.fixture);
    writeFileSync(join(publicIgnored.path, ".gitignore"), ".lane/\ndocs/reviews/\n");
    git(publicIgnored.path, ["add", ".gitignore"]);
    git(publicIgnored.path, ["commit", "-m", "ignore public reviews"], { stdio: "ignore" });
    const publicRun = lane(publicIgnored.fixture, ["review", "public-ignore", "--round", "1", "--brief", publicIgnored.brief]);
    assert.equal(publicRun.status, 2, publicRun.stderr);
    assert.equal(publicRun.stdout, "");

    const existing = makeReviewFixture("existing-round", { verdict: "PASS" });
    fixtures.push(existing.fixture);
    const existingHead = git(existing.path, ["rev-parse", "HEAD"]);
    const occupied = join(existing.fixture.repo, ".lane", "reviews", "existing-round", `${existingHead.slice(0, 7)}-r1.md`);
    mkdirSync(dirname(occupied), { recursive: true });
    writeFileSync(occupied, "existing private evidence\n");
    const occupiedRun = lane(existing.fixture, ["review", "existing-round", "--round", "1", "--brief", existing.brief]);
    assert.equal(occupiedRun.status, 2, occupiedRun.stderr);
    assert.equal(occupiedRun.stdout, "");

    const escaped = makeReviewFixture("symlink-private", { verdict: "PASS" });
    fixtures.push(escaped.fixture);
    const reviewsRoot = join(escaped.fixture.repo, ".lane", "reviews");
    const outside = join(escaped.fixture.root, "outside-private");
    mkdirSync(join(escaped.fixture.repo, ".lane"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, reviewsRoot);
    const escapedRun = lane(escaped.fixture, ["review", "symlink-private", "--round", "1", "--brief", escaped.brief]);
    assert.equal(escapedRun.status, 2, escapedRun.stderr);
    assert.equal(escapedRun.stdout, "");
    negativeControl("review output path preflight");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("usage exits one with no command and with an unknown command", () => {
  const fixture = makeFixture();
  try {
    const missing = lane(fixture, []);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /^usage:/);
    assert.match(missing.stdout, /check \[--cmd <validate command>\]/);
    assert.match(
      missing.stdout,
      /  check \[--cmd <validate command>\]\n                   validate this clean worktree/,
    );
    assert.match(
      missing.stdout,
      /  board \[--once \| --json \| --watch --json \| focus <row-id> \| done <row-id>\]\n        \[--repo <path>\] \[--all\]\n                   open the UI, observe sessions, focus a verified live row,/,
    );
    assert.match(missing.stdout, /  config           print resolved configuration as key, JSON value, and source/);
    const unknown = lane(fixture, ["not-a-command"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stdout, /^usage:/);
    const readme = readFileSync(resolve(HERE, "..", "README.md"), "utf8");
    assert.match(readme, /\| `lane config` \| Print resolved configuration values and sources \|/);
    assert.match(
      readme,
      /\| `lane board \[--once \\\| --json \\\| --watch --json \\\| focus <row-id> \\\| done <row-id>\] \[--repo <path>\] \[--all\]` \| Open the UI, inventory local sessions, focus one, or mark one done \|/,
    );
    negativeControl("usage exits");
  } finally {
    fixture.cleanup();
  }
});

test("status exits quietly when a downstream reader closes stdout", () => {
  const fixture = makeFixture();
  try {
    for (const topic of ["pipe-one", "pipe-two", "pipe-three", "pipe-four", "pipe-five"]) {
      git(fixture.repo, ["branch", `lane/${topic}`]);
    }
    const command = `"${process.execPath}" "${LANE}" status | head -n 1`;
    const run = spawnSync("/bin/bash", ["-o", "pipefail", "-c", command], {
      cwd: fixture.repo,
      env: fixture.env,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /EPIPE/);
    assert.match(run.stdout, /^main [0-9a-f]{7}\n$/);
    negativeControl("EPIPE handling");
  } finally {
    fixture.cleanup();
  }
});

test("verify-agent mismatch control is optional when herdr is absent", {
  skip: HAS_HERDR ? false : "herdr is absent; herdr-dependent tests are skipped",
}, () => {
  const fixture = makeFixture();
  try {
    const run = spawnSync(process.execPath, [LANE, "verify-agent", "missing-agent", "/wrong/path"], {
      cwd: fixture.repo,
      env: { ...fixture.env, PATH: process.env.PATH },
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /MISMATCH/);
    negativeControl("herdr cwd guard");
  } finally {
    fixture.cleanup();
  }
});
