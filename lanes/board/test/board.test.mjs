import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildSubscriptions,
  collectGitStates,
  countWorkers,
  interactiveMessage,
  joinBoardRows,
  loadRegistry,
  markSessionDone,
  parseVerdict,
  renderPlainBoard,
  tableLineEntries,
  tableLines,
} from "../board.mjs";
import { boardOptionsFromArgs } from "../args.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD_CLI = resolve(HERE, "..", "cli.mjs");
const NEGATIVE_CONTROL = process.env.LANE_TEST_NEGATIVE_CONTROL === "1";

function negativeControl(name) {
  if (NEGATIVE_CONTROL) assert.fail(`deliberately broken expectation: ${name}`);
}

function git(cwd, args, options = {}) {
  const output = execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

const registry = [{
  name: "api-agent",
  workspace: "lane-api",
  lane: "api",
  role: "engineer",
  report: "reports/api.md",
  deadline: "2026-09-08T10:00:00-05:00",
  done: false,
  tripwires: ["TRIPWIRE", "cargo prove"],
}];

const snapshot = {
  protocol: 20,
  version: "0.8.2",
  agents: [{
    agent: "codex",
    name: "api-agent",
    workspace_id: "w1",
    pane_id: "w1:p2",
    cwd: "/tmp/lane-api",
    agent_status: "working",
  }],
  panes: [],
  workspaces: [{
    workspace_id: "w1",
    label: "lane-api",
    worktree: { checkout_path: "/tmp/lane-api" },
  }],
};

test("registered sessions join live, git, report, deadline, and tripwire state", () => {
  const rows = joinBoardRows({
    registry,
    snapshot,
    gitStates: new Map([["api", {
      ahead: 2,
      dirty: true,
      gate: "exit=0 @abcdef0",
      gateColor: "green",
    }]]),
    reportStates: new Map([["reports/api.md", { verdict: "PASS", mtime: "09-08 09:30" }]]),
    runtime: new Map([["w1:p2", {
      messageText: "finished proof",
      messageSource: "assistant-preview",
      messageKind: "codex",
      messageAvailable: true,
      tripwire: "TRIPWIRE",
    }]]),
    now: new Date("2026-09-08T16:00:00Z"),
  });
  assert.equal(rows[0].status, "working");
  assert.equal(rows[0].pane, "w1:p2");
  assert.equal(rows[0].git, "+2 DIRTY");
  assert.equal(rows[0].gate, "exit=0 @abcdef0");
  assert.equal(rows[0].gateColor, "green");
  assert.equal(rows[0].report, "PASS@09-08 09:30");
  assert.equal(rows[0].deadline, "OVERDUE");
  assert.equal(rows[0].tripwire, "TRIPWIRE");
  assert.equal(rows[0].output, "finished proof");
  negativeControl("joined board row");
});

test("subscriptions include status, output changes, and configured tripwire matchers", () => {
  assert.deepEqual(buildSubscriptions(registry, snapshot), [
    { type: "pane.agent_status_changed", pane_id: "w1:p2" },
    {
      type: "pane.output_changed",
      pane_id: "w1:p2",
    },
    {
      type: "pane.output_matched",
      pane_id: "w1:p2",
      source: "recent_unwrapped",
      lines: 20,
      strip_ansi: true,
      match: { type: "substring", value: "TRIPWIRE" },
    },
    {
      type: "pane.output_matched",
      pane_id: "w1:p2",
      source: "recent_unwrapped",
      lines: 20,
      strip_ansi: true,
      match: { type: "substring", value: "cargo prove" },
    },
  ]);
  negativeControl("board subscriptions");
});

test("plain rendering exposes the same board fields without ANSI", () => {
  const [row] = joinBoardRows({
    registry,
    snapshot,
    gitStates: new Map([["api", { gate: "exit=0 @abcdef0", gateColor: "green" }]]),
    now: new Date("2026-09-08T16:00:00Z"),
  });
  const output = renderPlainBoard([row], {
    load: 1.25,
    freeMemory: "8.0 GiB",
    workers: { vitest: 1, cargo: 0, go: 2, rustc: 0 },
  }, {
    messageErrors: ["w1:p2: Herdr request timed out: pane.read"],
  });
  assert.match(output, /NAME\s+ROLE\s+LANE\s+STATUS\s+PANE/);
  assert.match(output, /GATE/);
  assert.match(output, /exit=0 @abcdef0/);
  assert.match(output, /api-agent\s+engineer\s+api\s+working\s+w1:p2/);
  assert.match(output, /load 1\.25.*free 8\.0 GiB.*vitest=1 cargo=0 go=2 rustc=0/);
  assert.match(output, /message notice: w1:p2: Herdr request timed out: pane\.read/);
  assert.doesNotMatch(output, /\u001b\[/);
  negativeControl("plain board rendering");
});

test("narrow pane rendering keeps every line within the terminal width", () => {
  const [row] = joinBoardRows({ registry, snapshot, now: new Date("2026-09-08T16:00:00Z") });
  assert.equal(row.gate, "-");
  const lines = tableLines([row], { width: 80 });
  assert.ok(lines.every((line) => line.length <= 78));
  assert.match(lines.join("\n"), /report /);
  assert.match(lines.join("\n"), /gate /);
  assert.match(lines.join("\n"), /deadline .*tripwire /);
  assert.match(lines.join("\n"), /message /);
  negativeControl("narrow board rendering");
});

test("wide layout uses its derived width and carries the exact gate offset", () => {
  const gate = "exit=137 @abcdef0";
  const [row] = joinBoardRows({
    registry: [{ ...registry[0], name: gate }],
    snapshot,
    gitStates: new Map([["api", { gate, gateColor: "red" }]]),
  });
  const almostWide = tableLines([row], { width: 182 });
  assert.ok(almostWide.every((line) => line.length <= 180));

  const wide = tableLineEntries([row], { width: 183 });
  assert.match(wide[0].text, /LAST MESSAGE/u);
  const body = wide.find((entry) => entry.rowIndex === 0);
  assert.equal(body.text.slice(body.gateStart, body.gateStart + body.gateText.length), gate);
  assert.notEqual(body.gateStart, body.text.indexOf(gate));
  negativeControl("derived board width and gate offset");
});

test("report verdicts are explicit and marking done updates the registry", () => {
  assert.equal(parseVerdict("notes\n**NEEDS-WORK**: retry\n"), "NEEDS-WORK");
  assert.equal(parseVerdict("ordinary prose"), "-");
  const [row] = joinBoardRows({
    registry,
    snapshot,
    reportStates: new Map([["reports/api.md", { verdict: "-", mtime: "09-08 09:30" }]]),
  });
  assert.equal(row.report, "09-08 09:30");

  const root = mkdtempSync(join(tmpdir(), "lane-board-registry-"));
  const registryPath = join(root, ".lane", "sessions.json");
  mkdirSync(join(root, ".lane"));
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  try {
    markSessionDone(registryPath, "api-agent");
    const updated = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(updated[0].done, false);
    assert.equal(loadRegistry(root).sessions[0].done, true);
    negativeControl("board registry updates");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marking done rejects a registry that is not an array", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-board-invalid-registry-"));
  const registryPath = join(root, "sessions.json");
  try {
    writeFileSync(registryPath, "{}\n");
    assert.throws(
      () => markSessionDone(registryPath, "api-agent"),
      /lane board registry must be a JSON array/,
    );
    negativeControl("invalid board registry update");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git and gate state use the repository worktree and its current HEAD", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-board-checkout-"));
  const repo = join(root, "repo");
  const lanePath = join(root, "lane-api");
  const unrelated = join(root, "unrelated");
  try {
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "Lane Tests"]);
    git(repo, ["config", "user.email", "lane-tests@example.invalid"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-m", "initial"], { stdio: "ignore" });
    git(repo, ["branch", "lane/api"]);
    git(repo, ["worktree", "add", lanePath, "lane/api"], { stdio: "ignore" });
    const head = git(lanePath, ["rev-parse", "HEAD"]);
    mkdirSync(join(lanePath, ".lane"));
    writeFileSync(join(lanePath, ".lane", "gate.json"), `${JSON.stringify({
      head,
      exit_code: 5,
    })}\n`);
    writeFileSync(join(lanePath, "dirty.txt"), "dirty\n");

    mkdirSync(unrelated);
    git(unrelated, ["init", "-b", "main"]);
    git(unrelated, ["config", "user.name", "Lane Tests"]);
    git(unrelated, ["config", "user.email", "lane-tests@example.invalid"]);
    writeFileSync(join(unrelated, "clean.txt"), "clean\n");
    git(unrelated, ["add", "clean.txt"]);
    git(unrelated, ["commit", "-m", "unrelated"], { stdio: "ignore" });

    const states = collectGitStates(repo, "main", registry, {
      ...snapshot,
      workspaces: [{
        workspace_id: "w1",
        label: "lane-api",
        worktree: {
          checkout_path: unrelated,
          is_linked_worktree: false,
          repo_key: "unrelated-key",
          repo_name: "unrelated",
          repo_root: unrelated,
        },
      }],
    });
    assert.equal(realpathSync(states.get("api").checkout), realpathSync(lanePath));
    assert.equal(states.get("api").dirty, true);
    assert.equal(states.get("api").gate, `exit=5 @${head.slice(0, 7)}`);
    assert.equal(states.get("api").gateColor, "red");

    writeFileSync(join(lanePath, ".lane", "gate.json"), `${JSON.stringify({
      head,
      exit_code: 0,
    })}\n`);
    const green = collectGitStates(repo, "main", registry, snapshot);
    assert.equal(green.get("api").gate, `exit=0 @${head.slice(0, 7)}`);
    assert.equal(green.get("api").gateColor, "green");

    writeFileSync(join(lanePath, ".lane", "gate.json"), `${JSON.stringify({
      head: "0".repeat(40),
      exit_code: 0,
    })}\n`);
    const stale = collectGitStates(repo, "main", registry, snapshot);
    assert.equal(stale.get("api").gate, "STALE");
    assert.equal(stale.get("api").gateColor, undefined);

    rmSync(join(lanePath, ".lane", "gate.json"));
    const absent = collectGitStates(repo, "main", registry, snapshot);
    const [absentRow] = joinBoardRows({ registry, snapshot, gitStates: absent });
    assert.equal(absentRow.gate, "-");
    assert.equal(absentRow.gateColor, undefined);
    negativeControl("repository worktree gate selection");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker counts include interpreter-launched worker scripts", () => {
  assert.deepEqual(
    countWorkers("node /example/tools/bin/vitest --run\n"),
    { vitest: 1, cargo: 0, go: 0, rustc: 0 },
  );
  negativeControl("interpreter-launched worker matching");
});

test("interactive status names a missing registry", () => {
  assert.equal(
    interactiveMessage({
      exists: false,
      path: "/example/repository/.lane/sessions.json",
    }, ""),
    "registry not found: /example/repository/.lane/sessions.json",
  );
  negativeControl("interactive missing registry hint");
});

test("worker counts match executable basenames instead of path segments", () => {
  assert.deepEqual(
    countWorkers([
      "/example/go/bin/gopls serve",
      "/opt/toolchain/go/pkg/tool/compile source.go",
      "/usr/bin/go test ./...",
      "/usr/bin/cargo test",
      "/usr/bin/rustc source.rs",
      "/usr/bin/vitest run",
    ].join("\n")),
    { vitest: 1, cargo: 1, go: 1, rustc: 1 },
  );
  negativeControl("worker executable matching");
});

test("board CLI reports a missing --repo value without a stack trace", () => {
  const run = spawnSync(process.execPath, [BOARD_CLI, "--repo"], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.equal(run.stderr, "lane board: --repo requires a path\n");
  assert.equal(run.stdout, "");
  negativeControl("board repo argument validation");
});

test("board application arguments expose only the repository root", () => {
  assert.deepEqual(
    boardOptionsFromArgs(["--repo", "target", "--main", "dead", "--registry", "dead"], "/caller"),
    { repoRoot: resolve("target") },
  );
  negativeControl("board application repository-only options");
});
