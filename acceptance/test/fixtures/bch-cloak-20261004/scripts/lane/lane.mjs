#!/usr/bin/env node
// BCH Cloak R&D lane manager — a thin layer over git worktrees, herdr-aware.
//
// Lifecycle: open -> work -> promote -> close.
//
// Promotion is always the same move: clean worktree, branch rebased onto
// current main, deterministic validation green, then a fast-forward-only
// merge into local main. No merge commits, no push, no policy gates —
// deterministic tests decide acceptance and git truth decides everything
// else. See "Concurrent R&D lanes" in AGENTS.md.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { loadRoutingConfig, nativeAgentArgs, resolveRouting, routingRows } from "./routing.mjs";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// The checkout this script runs from may itself be a lane worktree; herdr
// worktree actions must be addressed to the repository root's workspace.
const REPO_ROOT = (() => {
  try {
    const common = execFileSync("git", ["-C", REPO, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    return resolve(common, "..");
  } catch {
    return REPO;
  }
})();
const LANE_PREFIX = "lane/";
const WORKTREE_ROOT = join(homedir(), ".herdr", "worktrees", "bch-cloak");
const DEFAULT_VALIDATE = "pnpm validate:all-safe";

function fail(message) {
  process.stderr.write(`lane: ${message}\n`);
  process.exit(1);
}

function git(args, options = {}) {
  return execFileSync("git", ["-C", options.cwd ?? REPO, ...args], {
    encoding: "utf8",
  }).trim();
}

function tryGit(args, options = {}) {
  try {
    return git(args, options);
  } catch {
    return undefined;
  }
}

function laneBranch(topic) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/u.test(topic)) {
    fail(`topic must be short kebab-case, got: ${topic}`);
  }
  return `${LANE_PREFIX}${topic}`;
}

function branchExists(branch) {
  return tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== undefined;
}

function worktreeFor(branch) {
  const entries = git(["worktree", "list", "--porcelain"]).split("\n\n");
  for (const entry of entries) {
    if (entry.includes(`branch refs/heads/${branch}`)) {
      const line = entry.split("\n").find((l) => l.startsWith("worktree "));
      if (line !== undefined) return line.slice("worktree ".length);
    }
  }
  return undefined;
}

// herdr helpers. Every herdr CLI call prints one JSON document; a failure is a
// missing server, a refusal, or malformed output, and callers decide whether
// that is fatal.
function herdrJson(args) {
  const run = spawnSync("herdr", args, { encoding: "utf8" });
  if (run.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(run.stdout);
    return parsed.error === undefined ? parsed.result : undefined;
  } catch {
    return undefined;
  }
}

function parentWorkspaceId() {
  const listed = herdrJson(["workspace", "list"]);
  return listed?.workspaces.find(
    (w) => w.worktree?.repo_root === REPO_ROOT && w.worktree?.is_linked_worktree === false,
  )?.workspace_id;
}

function openWorkspaceIdFor(path) {
  const listed = herdrJson(["worktree", "list", "--cwd", REPO]);
  if (listed === undefined) return undefined;
  return listed.worktrees.find((w) => w.path === path)?.open_workspace_id;
}

// herdr refuses `worktree create`/`open` when the CLI runs inside a linked
// worktree ("New and open worktree actions start from the repo parent
// workspace"), so a lane opened from another lane gets a git worktree and no
// herdr workspace. Repair that by opening from the parent workspace explicitly.
function ensureHerdrWorkspace(path) {
  let id = openWorkspaceIdFor(path);
  if (id !== undefined) return id;
  const parent = parentWorkspaceId();
  if (parent === undefined) return undefined;
  herdrJson(["worktree", "open", "--workspace", parent, "--path", path, "--no-focus"]);
  return openWorkspaceIdFor(path);
}

function agentRecord(agentName) {
  const listed = herdrJson(["agent", "list"]);
  return listed?.agents?.find((a) => a.name === agentName);
}

function agentOnPane(pane) {
  const listed = herdrJson(["agent", "list"]);
  return listed?.agents?.find((a) => a.pane_id === pane);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// `herdr agent start` inherits whatever directory the pane's shell is in at
// that instant; started during shell init the agent lands in the wrong
// directory and runs its brief there. Refuse to prompt unless herdr reports
// the agent's cwd as the lane worktree.
function verifyAgentCwd(agentName, path) {
  const record = agentRecord(agentName);
  if (record === undefined) return { ok: false, cwd: undefined };
  return { ok: record.cwd === path, cwd: record.cwd };
}

// Dry-run a rebase of `branch` onto `against` with merge-tree (no worktree
// touched). Conflicts are returned by file so the implementer sees them.
function rebaseCheck(branch, against = "main") {
  const [ahead, behind] = git(["rev-list", "--left-right", "--count", `${branch}...${against}`]).split("\t");
  if (ahead === "0") return { ahead, behind, clean: true, conflicts: [] };
  const run = spawnSync("git", ["-C", REPO, "merge-tree", "--write-tree", against, branch], { encoding: "utf8" });
  const conflicts = `${run.stdout}${run.stderr}`
    .split("\n")
    .filter((l) => l.startsWith("CONFLICT"))
    .map((l) => l.replace(/^CONFLICT \([^)]*\):\s*/, "").replace(/^Merge conflict in\s*/, ""));
  return { ahead, behind, clean: run.status === 0 && conflicts.length === 0, conflicts };
}

function changedFiles(branch) {
  return git(["diff", "--name-only", `main...${branch}`]).split("\n").filter((f) => f !== "");
}

function requireClean(path, what) {
  if (git(["status", "--porcelain=v1"], { cwd: path }) !== "") {
    fail(`${what} is not clean (${path}); commit or stash first`);
  }
}

function open(topic, base = "main") {
  const branch = laneBranch(topic);
  if (branchExists(branch)) fail(`branch ${branch} already exists; use status/promote/close`);
  if (tryGit(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === undefined) {
    fail(`base ref does not resolve: ${base}`);
  }
  const path = join(WORKTREE_ROOT, `lane-${topic}`);
  if (existsSync(path)) fail(`worktree path already exists: ${path}`);
  const parent = parentWorkspaceId();
  const herdr = spawnSync(
    "herdr",
    [
      "worktree", "create",
      ...(parent === undefined ? ["--cwd", REPO_ROOT] : ["--workspace", parent]),
      "--branch", branch, "--base", base, "--path", path,
    ],
    { encoding: "utf8" },
  );
  if (herdr.status !== 0 || !existsSync(path)) {
    git(["worktree", "add", "-b", branch, path, base]);
    process.stdout.write("(herdr refused or is unavailable; created via git worktree)\n");
  }
  const workspaceId = ensureHerdrWorkspace(path);
  process.stdout.write(`lane open: ${branch}\n  worktree: ${path}\n  base: ${git(["rev-parse", "--short", base])} (${base})\n`);
  process.stdout.write(
    workspaceId === undefined
      ? "  herdr workspace: none (herdr unavailable); dispatch will retry the repair\n"
      : `  herdr workspace: ${workspaceId}\n`,
  );
  if (base !== "main") {
    process.stdout.write("Resumed from a non-main base: rebase onto main before promoting (promote enforces it).\n");
  }
  process.stdout.write("Sessions started in the worktree inherit AGENTS.md and repo skills automatically.\n");
}

function status() {
  const mainHead = git(["rev-parse", "main"]);
  process.stdout.write(`main ${mainHead.slice(0, 7)}\n`);
  const branches = git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${LANE_PREFIX}`])
    .split("\n")
    .filter((b) => b !== "");
  if (branches.length === 0) {
    process.stdout.write("no open lanes\n");
    return;
  }
  for (const branch of branches) {
    const [ahead, behind] = git(["rev-list", "--left-right", "--count", `${branch}...main`])
      .split("\t");
    const path = worktreeFor(branch);
    const dirty = path !== undefined && git(["status", "--porcelain=v1"], { cwd: path }) !== "";
    const check = rebaseCheck(branch);
    const rebase = ahead === "0" ? "" : behind === "0" ? "  rebase: current" : check.clean ? "  rebase: clean" : `  rebase: CONFLICT ${check.conflicts.join(",")}`;
    process.stdout.write(
      `${branch}  +${ahead}/-${behind} vs main  ${path ?? "(no worktree)"}${dirty ? "  DIRTY" : ""}${rebase}\n`,
    );
  }
  // Two lanes editing the same file will collide at promotion; say so now.
  const files = new Map(branches.map((b) => [b, new Set(changedFiles(b))]));
  for (let i = 0; i < branches.length; i += 1) {
    for (let j = i + 1; j < branches.length; j += 1) {
      const shared = [...files.get(branches[i])].filter((f) => files.get(branches[j]).has(f));
      if (shared.length > 0) process.stdout.write(`shared files: ${branches[i]} × ${branches[j]}: ${shared.join(", ")}\n`);
    }
  }
}

function seams(pattern) {
  let rx;
  if (pattern !== undefined) {
    try {
      rx = new RegExp(pattern, "iu");
    } catch {
      fail(`invalid pattern: ${pattern}`);
    }
  }
  const section = (title, refs) => {
    const rows = refs
      .split("\n")
      .filter((line) => line !== "" && (rx === undefined || rx.test(line)));
    if (rows.length === 0) return;
    process.stdout.write(`${title}\n`);
    for (const row of rows) process.stdout.write(`  ${row}\n`);
  };
  section(
    "kept seams (unmerged branches):",
    git(["branch", "--no-merged", "main",
      "--format=%(refname:short)\t%(objectname:short)\t%(contents:subject)"]),
  );
  section(
    "archive tags (retired iterations):",
    git(["for-each-ref", "refs/tags/archive",
      "--format=%(refname:short)\t%(objectname:short)\t%(contents:subject)"]),
  );
  process.stdout.write(
    "\nContext and topic map: docs-internal/rd-seam-inventory.md\n" +
      "Resume one: node scripts/lane/lane.mjs open <topic> <ref>\n" +
      "Inherited work is unverified until its tests run green on current main.\n",
  );
}

// Dispatch a visible agent session into the lane's herdr workspace: a new
// tab in that workspace, an interactive Codex or Claude agent started in
// its pane, and the brief submitted as the first prompt. The session shows
// in the herdr console (watch: `herdr agent read lane-<topic>`; attach to
// steer). Rule inheritance: Codex reads AGENTS.md natively; Claude loads it
// via the tracked CLAUDE.md import.
function dispatch(topic, promptText, options = {}) {
  const branch = laneBranch(topic);
  if (options.route === undefined) fail("dispatch requires --route <name>");
  let resolvedRouting;
  try {
    resolvedRouting = resolveRouting(loadRoutingConfig(REPO), options);
  } catch (error) {
    fail(error.message);
  }
  if (herdrJson(["workspace", "list"]) === undefined) fail("herdr is unavailable; dispatch requires the herdr server");
  const path = worktreeFor(branch);
  if (path === undefined) fail(`lane ${branch} has no worktree; open it first`);
  const workspaceId = ensureHerdrWorkspace(path);
  if (workspaceId === undefined) {
    fail(`herdr shows no open workspace for ${path} and could not open one from the ${REPO_ROOT} workspace`);
  }
  const tabArgs = ["tab", "create", "--workspace", workspaceId, "--label", `agent:${topic}`];
  for (const pair of resolvedRouting.env) tabArgs.push("--env", pair);
  const created = JSON.parse(execFileSync("herdr", tabArgs, { encoding: "utf8" }));
  const pane = created.result.root_pane.pane_id;
  const tabId = created.result.tab.tab_id;
  let paneCwd;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    paneCwd = herdrJson(["pane", "get", pane])?.pane?.foreground_cwd;
    if (paneCwd === path) break;
    sleepMs(500);
  }
  if (paneCwd !== path) {
    spawnSync("herdr", ["tab", "close", tabId], { encoding: "utf8" });
    fail(`pane ${pane} shell never reached ${path} (last cwd: ${paneCwd}); tab closed, nothing started`);
  }
  // Unique per dispatch (a failed start can leave a name registered), and
  // capped: herdr agent names are limited to 32 characters.
  // herdr caps agent names at 32 chars: stem(22) + "-HHMMSS"(7) + "-N"(2) = 31.
  const stem = `lane-${topic}`.slice(0, 22);
  let agentName = `${stem}-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
  // Dispatch stays model-agnostic: model, effort, and selection criteria come
  // from the single structured route table. Direct CLI overrides are refused.
  const kind = resolvedRouting.kind;
  const agentArgs = nativeAgentArgs(resolvedRouting);
  const startArgsFor = (name) => {
    const args = ["agent", "start", name, "--kind", kind, "--pane", pane];
    if (agentArgs.length > 0) args.push("--", ...agentArgs);
    return args;
  };
  // The pane's shell needs a moment before it can host an agent; retry
  // instead of dying, and close the orphaned tab if the start never lands.
  let started = false;
  let lastError = "";
  for (let attempt = 0; attempt < 20 && !started; attempt += 1) {
    // A failed start can leave the name registered, and a start that herdr
    // reports as failed can still have launched the agent in the pane: use a
    // fresh name per attempt and adopt whatever is already running there.
    if (attempt > 0) agentName = `${stem}-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}-${attempt}`;
    const run = spawnSync("herdr", startArgsFor(agentName), { encoding: "utf8" });
    if (run.status === 0 && !`${run.stdout}${run.stderr}`.includes('"error"')) {
      started = true;
      break;
    }
    lastError = `${run.stdout}${run.stderr}`.trim();
    const running = agentOnPane(pane);
    if (running !== undefined) {
      agentName = running.name;
      started = true;
      break;
    }
    sleepMs(500);
  }
  if (!started) {
    spawnSync("herdr", ["tab", "close", tabId], { encoding: "utf8" });
    fail(`agent start never succeeded (tab ${tabId} closed); last error: ${lastError}`);
  }
  // codex asks to trust a directory it has not seen; accept the preselected
  // "Yes, continue" — the directory is this repository's own worktree.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const visible = spawnSync("herdr", ["agent", "read", agentName, "--source", "visible"], { encoding: "utf8" }).stdout ?? "";
    const status = agentRecord(agentName)?.agent_status;
    if (visible.includes("Do you trust the contents of this directory")) {
      spawnSync("herdr", ["agent", "send-keys", agentName, "Enter"], { encoding: "utf8" });
    } else if (status === "idle" || status === "done" || status === "working") {
      break;
    }
    sleepMs(1000);
  }
  const cwdCheck = verifyAgentCwd(agentName, path);
  if (!cwdCheck.ok) {
    spawnSync("herdr", ["tab", "close", tabId], { encoding: "utf8" });
    fail(`agent '${agentName}' is running in '${cwdCheck.cwd}', not the lane worktree ${path}; tab closed, brief NOT sent`);
  }
  if (promptText !== undefined && promptText.trim() !== "") {
    execFileSync("herdr", ["agent", "prompt", agentName, promptText], { stdio: "inherit" });
  }
  process.stdout.write(
    `dispatched '${agentName}' in herdr workspace ${workspaceId} (pane ${pane})\n` +
      `  watch:  herdr agent read ${agentName}\n` +
      `  steer:  herdr agent attach ${agentName}\n`,
  );
}

// A fresh worktree carries no gitignored state: no `node_modules`, no built
// `dist`. Validation then fails for environmental reasons that look like real
// failures — the classic symptom is many test FILES failing to load while every
// assertion that ran passed ("Failed to resolve entry for package ..."). Both
// installs resolve offline from the lockfile. Existing dependencies can be
// reused; dist is always rebuilt so package cleanup and guards run.
const WORKSPACE_FILTERS = [
  "@bch-cloak/protocol-runtime...",
  "@bch-cloak/reference-wallet...",
  "@bch-cloak/chain-io...",
  "@bch-cloak/wizardconnect-client...",
  "@bch-cloak/reference-aggregator...",
  "@bch-cloak/reference-cli...",
];
// Building reference-wallet cascades through its dependencies
// (protocol-runtime, chain-io, reference-aggregator) via their prebuild steps.
const BUILD_FILTERS = ["@bch-cloak/reference-wallet", "@bch-cloak/wizardconnect-client"];

function prepareWorktree(path, { quiet = false } = {}) {
  const say = (m) => { if (!quiet) process.stdout.write(m); };
  if (!existsSync(join(path, "node_modules"))) {
    say(`preparing ${path}: installing workspace dependencies (offline, from lockfile)\n`);
    const args = ["install", "--ignore-scripts"];
    for (const f of WORKSPACE_FILTERS) args.push("--filter", f);
    const run = spawnSync("pnpm", args, { cwd: path, stdio: "inherit" });
    if (run.status !== 0) fail("dependency install failed; cannot validate this worktree");
  }
  // Existence of one sibling's dist says nothing about retired outputs in another.
  // Run the package builds and their guards before either prepare or promote can proceed.
  say(`preparing ${path}: building dist (siblings resolve through dist)\n`);
  const args = [];
  for (const f of BUILD_FILTERS) args.push("--filter", f);
  args.push("build");
  const run = spawnSync("pnpm", args, { cwd: path, stdio: "inherit" });
  if (run.status !== 0) fail("dist build failed; cannot validate this worktree");
}

function promote(topic) {
  const branch = laneBranch(topic);
  if (!branchExists(branch)) fail(`no such lane branch: ${branch}`);
  const path = worktreeFor(branch);
  if (path === undefined) fail(`lane ${branch} has no worktree; open one before promoting`);
  requireClean(path, "lane worktree");
  requireClean(REPO, "canonical main checkout");
  let mainHead = git(["rev-parse", "main"]);
  if (git(["merge-base", "main", branch]) !== mainHead) {
    // A promotion elsewhere moved main. Rebasing is mechanical when the dry
    // run is clean, and the gate below validates the rebased tree; conflicts
    // go back to the implementer with the file list.
    const check = rebaseCheck(branch);
    if (!check.clean) fail(`lane is behind main and does not rebase cleanly; conflicts in: ${check.conflicts.join(", ")}`);
    const before = git(["rev-parse", "--short", branch]);
    git(["rebase", "main"], { cwd: path });
    process.stdout.write(`rebased ${branch} onto main (${before} -> ${git(["rev-parse", "--short", branch])}, clean replay)\n`);
    mainHead = git(["rev-parse", "main"]);
  }
  prepareWorktree(path);
  const validate = process.env.LANE_VALIDATE ?? DEFAULT_VALIDATE;
  process.stdout.write(`validating in ${path}: ${validate}\n`);
  const run = spawnSync(validate, { cwd: path, shell: true, stdio: "inherit" });
  if (run.status !== 0) fail(`validation failed (exit ${run.status}); nothing merged`);
  if (git(["rev-parse", "main"]) !== mainHead) {
    fail("main moved during validation; re-run promote");
  }
  // Guard (2026-09-10): the fast-forward lands on whatever branch the canonical checkout has
  // checked out. Refuse unless that is `main`, or a promotion silently advances another branch.
  const checkedOut = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (checkedOut !== "main") fail(`canonical checkout is on '${checkedOut}', not main; switch it before promoting`);
  git(["merge", "--ff-only", branch]);
  process.stdout.write(
    `promoted ${branch}: main ${mainHead.slice(0, 7)} -> ${git(["rev-parse", "--short", "main"])} (fast-forward)\n`,
  );
  process.stdout.write("No push performed. Close the lane with: node scripts/lane/lane.mjs close " + topic + "\n");
}


// Scratch policy (2026-09-09, operator): a lane's session scratch lives under
// /private/tmp/<topic>-* and goes with the lane at close. Durable results must
// already be in the external archive; a manifest of what was deleted is written
// there so provenance survives. Directories with open file handles are kept.
function sweepScratch(topic) {
  const tmp = "/private/tmp";
  const archive = process.env.LANE_SCRATCH_ARCHIVE ??
    `${process.env.HOME}/development/bastian/archive/scratch-manifests`;
  let entries = [];
  try { entries = readdirSync(tmp).filter((n) => n === topic || n.startsWith(`${topic}-`) || n.startsWith(`${topic}.`)); } catch { return; }
  for (const name of entries) {
    const full = `${tmp}/${name}`;
    const open = spawnSync("lsof", ["+D", full], { encoding: "utf8" });
    if (open.status === 0 && open.stdout.trim().split("\n").length > 1) {
      process.stdout.write(`kept scratch ${full} (open file handles)\n`);
      continue;
    }
    let size = "?";
    try { size = execFileSync("du", ["-sh", full], { encoding: "utf8" }).split("\t")[0]; } catch {}
    let tree = "";
    try { tree = execFileSync("find", [full, "-maxdepth", "2", "-type", "d"], { encoding: "utf8" }); } catch {}
    try {
      mkdirSync(archive, { recursive: true });
      writeFileSync(`${archive}/${name}.txt`,
        `# scratch manifest: ${full} — deleted at lane close (${topic}) ${new Date().toISOString()}\n${size}\n${tree}`);
    } catch {}
    rmSync(full, { recursive: true, force: true });
    process.stdout.write(`swept scratch ${full} (${size.trim()}), manifest in ${archive}\n`);
  }
}

function close(topic) {
  const branch = laneBranch(topic);
  if (!branchExists(branch)) fail(`no such lane branch: ${branch}`);
  const path = worktreeFor(branch);
  if (path !== undefined) {
    requireClean(path, "lane worktree");
    // Prefer herdr-native removal so the console workspace retires with the
    // worktree; a git-only removal leaves a ghost workspace behind.
    let removed = false;
    try {
      const listed = JSON.parse(
        execFileSync("herdr", ["worktree", "list", "--cwd", REPO], { encoding: "utf8" }),
      );
      const workspaceId = listed.result.worktrees.find((w) => w.path === path)?.open_workspace_id;
      if (workspaceId !== undefined) {
        const run = spawnSync("herdr", ["worktree", "remove", "--workspace", workspaceId], {
          encoding: "utf8",
        });
        removed = run.status === 0 && !existsSync(path);
      }
    } catch {
      // herdr unavailable; fall back to git below
    }
    if (!removed) git(["worktree", "remove", path]);
    process.stdout.write(`removed worktree ${path}\n`);
  }
  const merged = tryGit(["merge-base", "--is-ancestor", branch, "main"]) !== undefined;
  if (merged) {
    // `-d` judges "merged" against THIS worktree's HEAD, which may be behind
    // main; the ancestor check above already proved main contains the lane.
    git(["branch", "-D", branch]);
    process.stdout.write(`deleted merged branch ${branch}\n`);
  } else {
    const tag = `archive/${branch}`;
    git(["tag", tag, branch]);
    git(["branch", "-D", branch]);
    process.stdout.write(`archived unmerged lane as tag ${tag}, then deleted branch\n`);
  }
  sweepScratch(topic);
}

const [command, topic, ...rest] = process.argv.slice(2);
switch (command) {
  case "open":
    if (topic === undefined) fail("usage: lane.mjs open <topic> [base-ref]");
    open(topic, rest[0]);
    break;
  case "status":
    status();
    break;
  case "seams":
    seams(topic);
    break;
  case "routes": {
    let config;
    try {
      config = loadRoutingConfig(REPO);
    } catch (error) {
      fail(error.message);
    }
    const rows = routingRows(config);
    if (topic === "--json") {
      process.stdout.write(`${JSON.stringify({ authority: config.authority, routes: rows }, null, 2)}\n`);
      break;
    }
    process.stdout.write(`${config.authority}\n`);
    for (const row of rows) {
      process.stdout.write(`${row.name}\t${row.kind}\t${row.model}\t${row.effort}\t${row.use}\n`);
    }
    break;
  }
  case "dispatch": {
    if (topic === undefined) {
      fail("usage: lane.mjs dispatch <topic> --route <name> [--env K=V ...] [--arg <raw> ...] [@brief-file | prompt text]");
    }
    const options = { env: [], args: [] };
    const positional = [];
    const laneOptions = new Set(["--route", "--env", "--arg"]);
    const valueAfter = (index, flag, { allowNativeOption = false } = {}) => {
      const value = rest[index + 1];
      if (value === undefined || (!allowNativeOption && value.startsWith("--")) || laneOptions.has(value)) {
        fail(`${flag} requires a value`);
      }
      return value;
    };
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "--route") {
        options.route = valueAfter(i, "--route");
        i += 1;
      }
      else if (rest[i] === "--env") { options.env.push(valueAfter(i, "--env")); i += 1; }
      else if (rest[i] === "--arg") {
        options.args.push(valueAfter(i, "--arg", { allowNativeOption: true }));
        i += 1;
      }
      else if (rest[i].startsWith("--")) fail(`unknown dispatch option: ${rest[i]}`);
      else positional.push(rest[i]);
    }
    let promptText;
    if (positional.length > 0) {
      promptText = positional[0].startsWith("@")
        ? readFileSync(positional[0].slice(1), "utf8")
        : positional.join(" ");
    }
    dispatch(topic, promptText, options);
    break;
  }
  case "rebase-check": {
    // Control for the promote auto-rebase: exit 0 iff <topic> rebases cleanly
    // onto --against (default main); prints the conflicting files otherwise.
    if (topic === undefined) fail("usage: lane.mjs rebase-check <topic> [--against <ref>]");
    const against = rest[0] === "--against" ? rest[1] : "main";
    const check = rebaseCheck(laneBranch(topic), against);
    process.stdout.write(`${laneBranch(topic)} vs ${against}: +${check.ahead}/-${check.behind} ${check.clean ? "clean" : `CONFLICT ${check.conflicts.join(",")}`}\n`);
    process.exit(check.clean ? 0 : 1);
  }
  case "verify-agent": {
    // Control for the dispatch cwd guard: exit 0 iff herdr reports the agent's
    // cwd as <path>. `verify-agent <name> /wrong/path` must exit 1.
    const [agentName, expectedPath] = [topic, rest[0]];
    if (agentName === undefined || expectedPath === undefined) fail("usage: lane.mjs verify-agent <agent-name> <worktree-path>");
    const check = verifyAgentCwd(agentName, resolve(expectedPath));
    process.stdout.write(`${check.ok ? "ok" : "MISMATCH"}: agent ${agentName} cwd=${check.cwd} expected=${resolve(expectedPath)}\n`);
    process.exit(check.ok ? 0 : 1);
  }
  case "prepare": {
    if (topic === undefined) fail("usage: lane.mjs prepare <topic>");
    const branch = laneBranch(topic);
    const path = worktreeFor(branch);
    if (path === undefined) fail(`lane ${branch} has no worktree`);
    prepareWorktree(path);
    process.stdout.write(`lane ready: ${path}\n`);
    break;
  }
  case "promote":
    if (topic === undefined) fail("usage: lane.mjs promote <topic>");
    promote(topic);
    break;
  case "close":
    if (topic === undefined) fail("usage: lane.mjs close <topic>");
    close(topic);
    break;
  default:
    process.stdout.write(
      "usage: node scripts/lane/lane.mjs <open|status|seams|routes|dispatch|prepare|rebase-check|verify-agent|promote|close> [topic] [base-ref]\n" +
        "  open <topic> [base]  cut lane/<topic> into a herdr worktree; base defaults to\n" +
        "                       main — pass a kept branch or archive/* tag to resume it\n" +
        "  seams [pattern]  list kept unfinished work (branches + archive tags);\n" +
        "                   topic map in docs-internal/rd-seam-inventory.md\n" +
        "  routes [--json]  print the authoritative named model/effort routes\n" +
        "  dispatch <topic> --route <name> [@brief-file | prompt]\n" +
        "                   start a visible Codex or Claude agent session in the\n" +
        "                   lane's workspace; routing.json governs route/kind/model/\n" +
        "                   effort, not environment, persona, account, memory, or plumbing\n" +
        "  prepare <topic>  install deps + build dist in the lane worktree; a\n" +
        "                   fresh worktree has neither, and validation then fails\n" +
        "                   for environmental reasons that look like real failures\n" +
        "  status           list open lanes vs main\n" +
        "  promote <topic>  validate then fast-forward main (clean + rebased + green only)\n" +
        "  close <topic>    remove worktree; delete merged branch or archive-tag unmerged\n",
    );
    process.exit(command === undefined ? 0 : 1);
}
