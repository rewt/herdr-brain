import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE = resolve(HERE, "..", "lane.mjs");
const INVENTORY = new URL("../board/inventory.mjs", import.meta.url);
const GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function negativeControl(label) {
  if (process.env.LANE_TEST_NEGATIVE_CONTROL === "1") {
    assert.fail(`deliberate negative control: ${label}`);
  }
}

function git(cwd, args) {
  return execFileSync(GIT, ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: tmpdir(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
}

function makeRepository(root, segment, { registry = ".lane/sessions.json" } = {}) {
  const developmentRoot = join(root, segment, "team");
  const repo = join(developmentRoot, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]);
  writeFileSync(join(developmentRoot, ".lane.json"), `${JSON.stringify({
    main: "main",
    worktree_root: "../worktrees",
    registry,
  }, null, 2)}\n`);
  return {
    repo: realpathSync(repo),
    root: realpathSync(developmentRoot),
    repoId: realpathSync(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
  };
}

function writeSession(repository, session, registry = ".lane/sessions.json") {
  const directory = join(repository.repo, `${registry}.d`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${session.session_id}.json`), `${JSON.stringify({
    session_id: session.session_id,
    repo_id: repository.repoId,
    root_id: repository.root,
    repo: repository.repo,
    topic: session.topic,
    name: session.name,
    workspace: session.workspace,
    pane: session.pane,
    server: session.server,
    lane: session.lane ?? `lane/${session.topic}`,
    ...(session.omitOccupantEvidence ? {} : {
      agent_session_id: session.agent_session_id ?? `${session.pane}-session`,
      terminal_id: session.terminal_id ?? `${session.pane}-terminal`,
    }),
    role: "engineer",
    brief: null,
    goal: session.goal ?? session.topic,
    report: `docs/reports/${session.topic}.md`,
    ...(session.tripwires === undefined ? {} : { tripwires: session.tripwires }),
    deadline: null,
    done: session.done ?? false,
    created_at: "2026-09-11T12:00:00.000Z",
    ...(session.repo_id === undefined ? {} : { repo_id: session.repo_id }),
    ...(session.repo === undefined ? {} : { repo: session.repo }),
  }, null, 2)}\n`);
}

function liveAgent({
  agent = "codex",
  name,
  status = "working",
  cwd,
  workspace,
  pane,
  terminal = `${pane}-terminal`,
  title = "Fixture agent title",
  session = `${pane}-session`,
}) {
  return {
    agent,
    agent_session: { agent, kind: "id", source: `herdr:${agent}`, value: session },
    agent_status: status,
    cwd,
    foreground_cwd: cwd,
    ...(name === undefined ? {} : { name }),
    pane_id: pane,
    revision: 1,
    state_change_seq: 1,
    tab_id: `${workspace}:t1`,
    terminal_id: terminal,
    terminal_title: title,
    terminal_title_stripped: title,
    workspace_id: workspace,
  };
}

function workspace(repository, id, checkout, linked) {
  return {
    active_tab_id: `${id}:t1`,
    focused: false,
    label: "repo",
    pane_count: 1,
    tab_count: 1,
    workspace_id: id,
    worktree: {
      checkout_path: checkout,
      is_linked_worktree: linked,
      repo_key: repository.repoId,
      repo_name: "repo",
      repo_root: repository.repo,
    },
  };
}

function snapshot(agents, workspaces) {
  return {
    protocol: 20,
    version: "fixture",
    agents,
    panes: agents.map((agent) => ({
      pane_id: agent.pane_id,
      tab_id: agent.tab_id,
      workspace_id: agent.workspace_id,
      terminal_id: agent.terminal_id,
    })),
    workspaces,
  };
}

function worktreeList(repository, entries) {
  return {
    source: {
      repo_key: repository.repoId,
      repo_name: "repo",
      repo_root: repository.repo,
      source_checkout_path: repository.repo,
      source_workspace_id: entries[0].open_workspace_id,
    },
    type: "worktree_list",
    worktrees: entries,
  };
}

test("local Herdr endpoint inventory deduplicates real paths and reports enumeration coverage", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-endpoints-")));
  try {
    const current = join(root, "current.sock");
    const second = join(root, "second.sock");
    writeFileSync(current, "");
    symlinkSync(current, join(root, "current-alias.sock"));
    const { enumerateLocalHerdrEndpoints } = await import(INVENTORY);
    const complete = enumerateLocalHerdrEndpoints({
      currentSocketPath: current,
      listSessions: () => ({ sessions: [
        { default: true, name: "default", running: false, socket_path: join(root, "current-alias.sock") },
        { default: false, name: "second", running: true, socket_path: second },
        { default: false, name: "remote", running: true, socket_path: second, remote: true },
      ] }),
    });
    assert.equal(complete.coverage, "complete");
    assert.equal(complete.endpoints.length, 2);
    assert.equal(complete.endpoints[0].path, realpathSync(current));
    assert.ok(complete.endpoints.every((endpoint) => /^local-[0-9a-f]{12}$/u.test(endpoint.server_id)));
    assert.deepEqual(complete.errors, []);

    const fallback = enumerateLocalHerdrEndpoints({
      currentSocketPath: current,
      listSessions: () => { throw new Error("session enumeration unavailable"); },
    });
    assert.equal(fallback.coverage, "partial");
    assert.equal(fallback.endpoints.length, 1);
    assert.match(fallback.errors[0].message, /session enumeration unavailable/u);
    negativeControl("local endpoint coverage and deduplication");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("machine inventory joins canonical repositories while preserving every live agent", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-machine-")));
  try {
    const first = makeRepository(root, "first", { registry: ".lane/anchor.json" });
    const second = makeRepository(root, "second", { registry: ".lane/other.json" });
    const firstLane = join(root, "first-lane");
    const secondLane = join(root, "second-lane");
    git(first.repo, ["worktree", "add", "-b", "lane/first-task", firstLane]);
    git(second.repo, ["worktree", "add", "-b", "lane/second-task", secondLane]);
    const firstSocket = join(root, "first.sock");
    const secondSocket = join(root, "second.sock");
    const missingSocket = join(root, "missing.sock");
    const registeredId = "11111111-1111-4111-8111-111111111111";
    writeSession(first, {
      session_id: registeredId,
      topic: "first-task",
      name: "registered-agent",
      workspace: "first-lane",
      pane: "first-pane",
      server: firstSocket,
    }, ".lane/anchor.json");
    writeSession(first, {
      session_id: "22222222-2222-4222-8222-222222222222",
      topic: "foreign-task",
      name: "same-agent",
      workspace: "first-main",
      pane: "facilitator-pane",
      server: firstSocket,
      repo_id: second.repoId,
      repo: second.repo,
    }, ".lane/anchor.json");

    const snapshots = new Map([
      [firstSocket, snapshot([
        liveAgent({ name: "registered-agent", cwd: firstLane, workspace: "first-lane", pane: "first-pane" }),
        liveAgent({ cwd: firstLane, workspace: "first-lane", pane: "unnamed-pane" }),
        liveAgent({ name: "same-agent", status: "done", cwd: first.repo, workspace: "first-main", pane: "facilitator-pane" }),
        liveAgent({ name: "outside-agent", cwd: join(root, "not-git"), workspace: "outside", pane: "outside-pane" }),
      ], [
        workspace(first, "first-main", first.repo, false),
        workspace(first, "first-lane", firstLane, true),
        { workspace_id: "outside", label: "outside" },
      ])],
      [secondSocket, snapshot([
        liveAgent({ name: "same-agent", cwd: secondLane, workspace: "second-lane", pane: "second-pane" }),
      ], [
        workspace(second, "second-main", second.repo, false),
        workspace(second, "second-lane", secondLane, true),
      ])],
    ]);
    const worktrees = new Map([
      [`${firstSocket}\0${first.repoId}`, worktreeList(first, [
        { branch: "main", is_bare: false, is_detached: false, is_linked_worktree: false, is_prunable: false, label: "repo", open_workspace_id: "first-main", path: first.repo },
        { branch: "lane/first-task", is_bare: false, is_detached: false, is_linked_worktree: true, is_prunable: false, label: "first-task", open_workspace_id: "first-lane", path: firstLane },
      ])],
      [`${secondSocket}\0${second.repoId}`, worktreeList(second, [
        { branch: "main", is_bare: false, is_detached: false, is_linked_worktree: false, is_prunable: false, label: "repo", open_workspace_id: "second-main", path: second.repo },
        { branch: "lane/second-task", is_bare: false, is_detached: false, is_linked_worktree: true, is_prunable: false, label: "second-task", open_workspace_id: "second-lane", path: secondLane },
      ])],
    ]);
    const { collectMachineBoardDocument } = await import(INVENTORY);
    const options = {
      anchor: {
        path: first.repo,
        config: { main: "main", registry: ".lane/anchor.json" },
        root_id: first.root,
        lane_base: join(root, "anchor-worktrees", "repo"),
      },
      currentSocketPath: firstSocket,
      listSessions: () => ({ sessions: [
        { default: true, name: "first", running: true, socket_path: firstSocket },
        { default: false, name: "duplicate", running: false, socket_path: firstSocket },
        { default: false, name: "second", running: true, socket_path: secondSocket },
        { default: false, name: "missing", running: true, socket_path: missingSocket },
      ] }),
      clientFactory: ({ path }) => ({
        snapshot: async () => {
          if (!snapshots.has(path)) throw new Error("fixture endpoint inaccessible");
          return snapshots.get(path);
        },
        close() {},
      }),
      listWorktrees: ({ endpoint, repository }) => worktrees.get(`${endpoint.path}\0${repository.repo_id}`),
      stats: { load: 0, freeMemoryBytes: 1024, workers: {} },
      now: new Date("2026-09-11T13:00:00.000Z"),
    };
    const machine = await collectMachineBoardDocument(options);
    assert.deepEqual(machine.scope, { kind: "machine", repo_id: null, include_history: false });
    assert.equal(machine.coverage.discovery, "partial");
    assert.equal(machine.coverage.servers.length, 3);
    assert.equal(machine.coverage.servers.filter((server) => server.available).length, 2);
    assert.equal(machine.repositories.length, 2);
    assert.ok(machine.repositories.every((repository) => /^[0-9a-f]{8}$/u.test(repository.display_suffix)));
    assert.notEqual(machine.repositories[0].display_suffix, machine.repositories[1].display_suffix);
    assert.equal(machine.rows.length, 5);
    assert.equal(machine.rows.filter((row) => row.registered).length, 1);
    assert.equal(machine.rows.filter((row) => row.name === null).length, 1);
    assert.equal(machine.rows.filter((row) => row.repo_id === null).length, 1);
    assert.equal(machine.rows.find((row) => row.row_id === registeredId).status, "working");
    const facilitator = machine.rows.find((row) => row.name === "same-agent" && row.repo_id === first.repoId);
    assert.equal(facilitator.group.kind, "facilitator");
    assert.equal(facilitator.status, "done");
    assert.equal(facilitator.goal_source, "terminal-title");
    assert.ok(machine.errors.some((error) => error.source === "herdr" && error.server_id));
    assert.ok(machine.errors.some((error) => error.source === "registry" && /foreign/u.test(error.message)));

    const filtered = await collectMachineBoardDocument({ ...options, repoFilter: first.repo });
    assert.deepEqual(filtered.scope, { kind: "repository", repo_id: first.repoId, include_history: false });
    assert.equal(filtered.repositories.length, 1);
    assert.ok(filtered.rows.every((row) => row.repo_id === first.repoId));
    assert.deepEqual(filtered.rows.map((row) => row.group.kind), ["facilitator", "lane", "lane"]);
    negativeControl("canonical machine joins and visible unregistered agents");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history filtering distinguishes metadata completion from live Herdr done", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-history-")));
  try {
    const repository = makeRepository(root, "history");
    const socket = join(root, "history.sock");
    const definitions = [
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "offline-done", "offline-pane", true],
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "working-after-done", "working-pane", true],
      ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "idle-done", "idle-pane", true],
      ["dddddddd-dddd-4ddd-8ddd-dddddddddddd", "herdr-done", "herdr-done-pane", false],
    ];
    const checkouts = new Map();
    for (const [sessionId, topic, pane, done] of definitions) {
      if (topic !== "offline-done") {
        const checkout = join(root, `${topic}-checkout`);
        git(repository.repo, ["worktree", "add", "-b", `lane/${topic}`, checkout]);
        checkouts.set(topic, checkout);
      }
      writeSession(repository, {
        session_id: sessionId,
        topic,
        name: topic,
        workspace: `${topic}-workspace`,
        pane,
        server: socket,
        done,
      });
    }
    writeFileSync(join(repository.repo, ".lane", "sessions.json.d", "malformed.json"), "{\n");
    const agents = [
      liveAgent({ name: "working-after-done", status: "working", cwd: checkouts.get("working-after-done"), workspace: "working-after-done-workspace", pane: "working-pane" }),
      liveAgent({ name: "idle-done", status: "idle", cwd: checkouts.get("idle-done"), workspace: "idle-done-workspace", pane: "idle-pane" }),
      liveAgent({ name: "herdr-done", status: "done", cwd: checkouts.get("herdr-done"), workspace: "herdr-done-workspace", pane: "herdr-done-pane" }),
    ];
    const liveSnapshot = snapshot(agents, [...checkouts].map(([topic, checkout]) =>
      workspace(repository, `${topic}-workspace`, checkout, true)));
    const { collectMachineBoardDocument } = await import(INVENTORY);
    const options = {
      anchor: { path: repository.repo },
      currentSocketPath: socket,
      listSessions: () => ({ sessions: [] }),
      clientFactory: () => ({ snapshot: async () => liveSnapshot, close() {} }),
      listWorktrees: () => worktreeList(repository, [...checkouts].map(([topic, checkout]) => ({
        branch: `lane/${topic}`, is_bare: false, is_detached: false, is_linked_worktree: true,
        is_prunable: false, label: topic, open_workspace_id: `${topic}-workspace`, path: checkout,
      }))),
      stats: { load: 0, freeMemoryBytes: 1024, workers: {} },
    };
    const current = await collectMachineBoardDocument(options);
    assert.deepEqual(current.rows.map((row) => row.name), ["herdr-done", "working-after-done"]);
    assert.equal(current.rows.find((row) => row.name === "herdr-done").done, false);
    assert.equal(current.rows.find((row) => row.name === "working-after-done").active_after_done, true);
    assert.ok(current.errors.some((error) => error.source === "registry" && /malformed/u.test(error.message)));

    const history = await collectMachineBoardDocument({ ...options, includeHistory: true });
    assert.equal(history.rows.length, 4);
    assert.equal(history.scope.include_history, true);
    negativeControl("history filtering independent of Herdr agent status");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("board starts outside Git and supports repository filtering plus all-history syntax", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-outside-")));
  try {
    const outside = join(root, "outside");
    const bin = join(root, "bin");
    mkdirSync(outside);
    mkdirSync(bin);
    symlinkSync(GIT, join(bin, "git"));
    const herdr = join(bin, "herdr");
    writeFileSync(herdr, "#!/bin/sh\nif [ \"$1 $2 $3\" = \"session list --json\" ]; then\n  printf '%s\\n' '{\"sessions\":[{\"default\":true,\"name\":\"default\",\"running\":false,\"socket_path\":\"/missing/default.sock\"}]}'\n  exit 0\nfi\nexit 1\n");
    chmodSync(herdr, 0o755);
    const env = {
      PATH: bin,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      HERDR_SOCKET_PATH: join(root, "missing-current.sock"),
    };
    const machine = spawnSync(process.execPath, [LANE, "board", "--json", "--all"], {
      cwd: outside,
      env,
      encoding: "utf8",
    });
    assert.equal(machine.status, 0, machine.stderr);
    const document = JSON.parse(machine.stdout);
    assert.deepEqual(document.scope, { kind: "machine", repo_id: null, include_history: true });
    assert.equal(document.coverage.discovery, "unavailable");
    assert.deepEqual(document.rows, []);
    assert.ok(document.errors.every((error) => error.source !== "agent"));

    const explicitConfig = join(root, "lane.json");
    writeFileSync(explicitConfig, "{}\n");
    const refused = spawnSync(process.execPath, [LANE, "board", "--json"], {
      cwd: outside,
      env: { ...env, LANE_CONFIG: explicitConfig },
      encoding: "utf8",
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /LANE_CONFIG.*outside.*--repo/u);

    const repository = makeRepository(root, "selected");
    const filtered = spawnSync(process.execPath, [LANE, "board", "--json", "--repo", repository.repo], {
      cwd: outside,
      env,
      encoding: "utf8",
    });
    assert.equal(filtered.status, 0, filtered.stderr);
    const selected = JSON.parse(filtered.stdout);
    assert.deepEqual(selected.scope, { kind: "repository", repo_id: repository.repoId, include_history: false });
    assert.equal(selected.repositories[0].repo_id, repository.repoId);
    negativeControl("outside-Git machine board and filter syntax");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("machine evidence never crosses repositories with the same lane and report names", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-isolation-")));
  try {
    const first = makeRepository(root, "first");
    const second = makeRepository(root, "second");
    const checkout = join(root, "shared-checkout");
    git(first.repo, ["worktree", "add", "-b", "lane/shared", checkout]);
    mkdirSync(join(checkout, "docs", "reports"), { recursive: true });
    writeFileSync(join(checkout, "docs", "reports", "shared.md"), "**PASS**\n");
    mkdirSync(join(checkout, ".lane"));
    writeFileSync(join(checkout, ".lane", "gate.json"), `${JSON.stringify({
      head: git(checkout, ["rev-parse", "HEAD"]), exit_code: 0, signal: null,
    })}\n`);
    const socket = join(root, "board.sock");
    for (const repository of [first, second]) {
      writeSession(repository, {
        session_id: repository === first
          ? "11111111-1111-4111-8111-111111111111"
          : "22222222-2222-4222-8222-222222222222",
        topic: "shared", name: `worker-${repository === first ? "first" : "second"}`,
        workspace: repository === first ? "first-main" : "second-main",
        pane: repository === first ? "first-pane" : "second-pane", server: socket,
      });
    }
    const { collectMachineBoardDocument } = await import(INVENTORY);
    const document = await collectMachineBoardDocument({
      currentSocketPath: socket,
      listSessions: () => ({ sessions: [] }),
      clientFactory: () => ({
        snapshot: async () => snapshot([], [
          workspace(first, "first-main", first.repo, false),
          workspace(second, "second-main", second.repo, false),
        ]),
        close() {},
      }),
      listWorktrees: ({ repository }) => worktreeList(repository, [{
        branch: "main", open_workspace_id: repository === first ? "first-main" : "second-main",
        path: repository.repo,
      }]),
      stats: { load: 0, freeMemoryBytes: 1024, workers: {} },
    });
    const firstRow = document.rows.find((row) => row.repo_id === first.repoId);
    const secondRow = document.rows.find((row) => row.repo_id === second.repoId);
    assert.equal(firstRow.git.dirty, true);
    assert.equal(firstRow.gate.state, "pass");
    assert.equal(firstRow.report.verdict, "PASS");
    assert.equal(secondRow.git.available, false);
    assert.equal(secondRow.git.dirty, null);
    assert.equal(secondRow.gate.state, "missing");
    assert.equal(secondRow.report.path, null);
    negativeControl("cross-repository evidence isolation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live provenance comes from verified cwd rather than a workspace's repository or branch", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-cwd-")));
  try {
    const first = makeRepository(root, "first");
    const second = makeRepository(root, "second");
    const firstLane = join(root, "first-lane");
    const otherLane = join(root, "other-lane");
    git(first.repo, ["worktree", "add", "-b", "lane/first", firstLane]);
    git(first.repo, ["worktree", "add", "-b", "lane/other", otherLane]);
    const socket = join(root, "board.sock");
    const agents = [
      liveAgent({ name: "outside", cwd: join(root, "outside"), workspace: "lane-workspace", pane: "outside-pane" }),
      liveAgent({ name: "moved", cwd: otherLane, workspace: "lane-workspace", pane: "moved-pane" }),
      liveAgent({ name: "foreign", cwd: second.repo, workspace: "lane-workspace", pane: "foreign-pane" }),
    ];
    const { collectMachineBoardDocument } = await import(INVENTORY);
    const document = await collectMachineBoardDocument({
      currentSocketPath: socket,
      listSessions: () => ({ sessions: [] }),
      clientFactory: () => ({ snapshot: async () => snapshot(agents, [
        workspace(first, "lane-workspace", firstLane, true),
      ]), close() {} }),
      listWorktrees: ({ repository }) => worktreeList(repository, [{
        branch: "lane/first", open_workspace_id: "lane-workspace", path: firstLane,
      }]),
      stats: { load: 0, freeMemoryBytes: 1024, workers: {} },
    });
    const byName = (name) => document.rows.find((row) => row.name === name);
    assert.equal(byName("outside").repo_id, null);
    assert.equal(byName("outside").branch, null);
    assert.equal(byName("moved").repo_id, first.repoId);
    assert.equal(byName("moved").branch, "lane/other");
    assert.equal(byName("foreign").repo_id, second.repoId);
    assert.equal(byName("foreign").branch, "main");
    assert.ok(document.errors.some((error) => error.source === "repository" && /workspace/u.test(error.message)));
    negativeControl("cwd repository and branch provenance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry joins require a verified workspace and a unique occupant claim", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-claims-")));
  try {
    const repository = makeRepository(root, "claims");
    const socket = join(root, "board.sock");
    const checkouts = new Map();
    for (const name of ["valid", "missing", "stale", "duplicate"]) {
      const checkout = join(root, `${name}-checkout`);
      git(repository.repo, ["worktree", "add", "-b", `lane/${name}`, checkout]);
      checkouts.set(name, checkout);
    }
    const agentFor = (name) => liveAgent({
      name, cwd: checkouts.get(name), workspace: `${name}-workspace`, pane: `${name}-pane`,
    });
    let agents = [agentFor("valid")];
    let workspaces = [workspace(repository, "valid-workspace", checkouts.get("valid"), true)];
    const worktrees = worktreeList(repository, [...checkouts].map(([name, checkout]) => ({
      branch: `lane/${name}`, open_workspace_id: `${name}-workspace`, path: checkout,
    })));
    const { collectMachineBoardDocument } = await import(INVENTORY);
    const options = {
      currentSocketPath: socket,
      listSessions: () => ({ sessions: [] }),
      clientFactory: () => ({ snapshot: async () => snapshot(agents, workspaces), close() {} }),
      listWorktrees: () => worktrees,
      stats: { load: 0, freeMemoryBytes: 1024, workers: {} },
    };
    const validId = "11111111-1111-4111-8111-111111111111";
    writeSession(repository, {
      session_id: validId, topic: "valid", name: "valid",
      workspace: "valid-workspace", pane: "valid-pane", server: socket,
    });
    const baseline = await collectMachineBoardDocument(options);
    assert.equal(baseline.rows.length, 1);
    assert.equal(baseline.rows[0].row_id, validId);
    assert.equal(baseline.rows[0].registered, true);
    assert.equal(baseline.rows[0].status, "working");
    assert.equal(baseline.rows[0].branch, "lane/valid");

    for (const [session_id, name, selectedWorkspace] of [
      ["22222222-2222-4222-8222-222222222222", "missing", "absent-workspace"],
      ["33333333-3333-4333-8333-333333333333", "stale", "expected-workspace"],
      ["44444444-4444-4444-8444-444444444444", "duplicate", "duplicate-workspace"],
      ["55555555-5555-4555-8555-555555555555", "duplicate", "duplicate-workspace"],
    ]) {
      writeSession(repository, {
        session_id, topic: name, name, workspace: selectedWorkspace,
        pane: `${name}-pane`, server: socket,
      });
    }
    agents = ["valid", "missing", "stale", "duplicate"].map(agentFor);
    workspaces = [
      ...["valid", "missing", "stale", "duplicate"].map((name) =>
        workspace(repository, `${name}-workspace`, checkouts.get(name), true)),
      workspace(repository, "expected-workspace", checkouts.get("stale"), true),
    ];
    const document = await collectMachineBoardDocument(options);
    assert.equal(document.rows.filter((row) => row.registered).length, 5);
    assert.equal(document.rows.filter((row) => !row.registered).length, 3);
    assert.equal(document.rows.find((row) => row.row_id === validId).status, "working");
    assert.ok(document.rows.filter((row) => row.registered && row.row_id !== validId)
      .every((row) => row.status === "offline"));
    assert.deepEqual(document.rows.filter((row) => !row.registered).map((row) => row.name).sort(),
      ["duplicate", "missing", "stale"]);
    negativeControl("eligible join before missing stale and duplicate claims");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("machine preview state survives a matching occupant's later read failure", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-preview-")));
  try {
    const repository = makeRepository(root, "preview");
    const socket = join(root, "board.sock");
    const agent = liveAgent({ name: "preview", cwd: repository.repo, workspace: "main", pane: "preview-pane" });
    let reads = 0;
    const runtime = new Map();
    const { collectMachineBoardDocument } = await import(INVENTORY);
    const options = {
      currentSocketPath: socket,
      listSessions: () => ({ sessions: [] }),
      clientFactory: () => ({
        snapshot: async () => snapshot([agent], [workspace(repository, "main", repository.repo, false)]),
        readPane: async () => {
          reads += 1;
          if (reads > 1) throw new Error("fixture read failed");
          return { pane_id: "preview-pane", source: "recent_unwrapped", format: "text",
            text: "• Preview survives\n", revision: 1, truncated: false };
        },
        close() {},
      }),
      listWorktrees: () => worktreeList(repository, [{
        branch: "main", open_workspace_id: "main", path: repository.repo,
      }]),
      runtime,
      stats: { load: 0, freeMemoryBytes: 1024, workers: {} },
    };
    const first = await collectMachineBoardDocument(options);
    assert.equal(first.rows[0].last_message.text, "Preview survives");
    const second = await collectMachineBoardDocument(options);
    assert.equal(second.rows[0].last_message.text, "Preview survives");
    assert.equal(second.rows[0].last_message.stale, true);
    assert.match(second.rows[0].last_message.limitation, /retaining the previous preview/u);
    negativeControl("watch-lifetime preview retention");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new terminal with the same agent-session value cannot inherit preview or tripwire", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-terminal-swap-")));
  try {
    const repository = makeRepository(root, "terminal-swap");
    const checkout = join(root, "lane-checkout");
    git(repository.repo, ["worktree", "add", "-b", "lane/terminal-swap", checkout]);
    const socket = join(root, "board.sock");
    let agent = liveAgent({
      name: "same-name", cwd: checkout, workspace: "lane-workspace", pane: "lane-pane",
      terminal: "old-terminal", session: "shared-session", title: "Old terminal",
    });
    let replaced = false;
    const runtime = new Map();
    const { collectMachineBoardDocument } = await import(INVENTORY);
    const options = {
      currentSocketPath: socket,
      listSessions: () => ({ sessions: [] }),
      clientFactory: () => ({
        snapshot: async () => snapshot([agent], [workspace(repository, "lane-workspace", checkout, true)]),
        readPane: async () => {
          if (replaced) throw new Error("replacement read unavailable");
          return { pane_id: "lane-pane", source: "recent_unwrapped", format: "text",
            text: "• Answer from old terminal\n", revision: 1, truncated: false };
        },
        close() {},
      }),
      listWorktrees: () => worktreeList(repository, [{
        branch: "lane/terminal-swap", open_workspace_id: "lane-workspace", path: checkout,
      }]),
      runtime,
      stats: { load: 0, freeMemoryBytes: 1024, workers: {} },
    };
    const initial = await collectMachineBoardDocument(options);
    assert.equal(initial.rows.length, 1);
    assert.equal(initial.rows[0].registered, false);
    assert.equal(initial.rows[0].last_message.text, "Answer from old terminal");
    const oldLiveId = initial.rows[0].row_id;
    const [[runtimeKey, previous]] = [...runtime.entries()];
    runtime.set(runtimeKey, { ...previous, tripwire: "OLD", observedAt: "2026-09-13T12:00:00.000Z" });

    writeSession(repository, {
      session_id: "66666666-6666-4666-8666-666666666666", topic: "terminal-swap",
      name: "same-name", workspace: "lane-workspace", pane: "lane-pane", server: socket,
      agent_session_id: "shared-session", terminal_id: "old-terminal",
    });
    const registered = await collectMachineBoardDocument(options);
    assert.equal(registered.rows.length, 1);
    assert.equal(registered.rows[0].registered, true);
    assert.equal(registered.rows[0].last_message.text, "Answer from old terminal");
    assert.equal(registered.rows[0].tripwire, "OLD");

    replaced = true;
    agent = liveAgent({
      name: "same-name", cwd: checkout, workspace: "lane-workspace", pane: "lane-pane",
      terminal: "new-terminal", session: "shared-session", title: "New terminal",
    });
    const changed = await collectMachineBoardDocument(options);
    assert.equal(changed.rows.length, 2);
    assert.equal(changed.rows.find((row) => row.registered).status, "offline");
    const live = changed.rows.find((row) => !row.registered);
    assert.equal(live.goal, "New terminal");
    assert.equal(live.last_message.text, null);
    assert.equal(live.last_message.available, false);
    assert.equal(live.tripwire, null);
    assert.notEqual(live.row_id, oldLiveId);
    negativeControl("same-session terminal replacement drops runtime evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a match after the first of two pane reads survives the pending collection", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-tripwire-race-")));
  try {
    const repository = makeRepository(root, "tripwire-race");
    const checkout = join(root, "lane-checkout");
    git(repository.repo, ["worktree", "add", "-b", "lane/race", checkout]);
    const socket = join(root, "board.sock");
    const agents = ["first", "second"].map((name) => liveAgent({
      name, cwd: checkout, workspace: "race-workspace", pane: `${name}-pane`,
    }));
    for (const [index, name] of ["first", "second"].entries()) {
      writeSession(repository, {
        session_id: `77777777-7777-4777-8777-77777777777${index}`,
        topic: "race", name, workspace: "race-workspace", pane: `${name}-pane`,
        server: socket, tripwires: name === "first" ? ["OLD", "LATEST"] : [],
      });
    }
    let round = 1;
    let releaseSecond;
    let secondStarted;
    const secondPending = new Promise((resolvePromise) => { releaseSecond = resolvePromise; });
    const secondRequested = new Promise((resolvePromise) => { secondStarted = resolvePromise; });
    const runtime = new Map();
    const response = (pane) => ({
      pane_id: pane, source: "recent_unwrapped", format: "text",
      text: `• ${pane} round ${round}\n`, revision: round, truncated: false,
    });
    const { collectMachineBoardDocument } = await import(INVENTORY);
    const options = {
      currentSocketPath: socket,
      listSessions: () => ({ sessions: [] }),
      clientFactory: () => ({
        snapshot: async () => snapshot(agents, [workspace(repository, "race-workspace", checkout, true)]),
        readPane: (pane) => {
          if (round === 2 && pane === "second-pane") {
            secondStarted();
            return secondPending;
          }
          return Promise.resolve(response(pane));
        },
        close() {},
      }),
      listWorktrees: () => worktreeList(repository, [{
        branch: "lane/race", open_workspace_id: "race-workspace", path: checkout,
      }]),
      runtime,
      stats: { load: 0, freeMemoryBytes: 1024, workers: {} },
    };
    const baseline = await collectMachineBoardDocument(options);
    assert.equal(baseline.rows.filter((row) => row.registered).length, 2);
    const firstKey = [...runtime.keys()].find((key) => key.endsWith("\0first-pane"));
    assert.ok(firstKey);
    const oldMatchAt = "2026-09-13T12:00:00.000Z";
    const latestMatchAt = "2026-09-13T12:00:01.000Z";
    runtime.set(firstKey, { ...runtime.get(firstKey), tripwire: "OLD", observedAt: oldMatchAt });

    round = 2;
    const collecting = collectMachineBoardDocument(options);
    await secondRequested;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(runtime.get(firstKey).tripwire, "OLD");
    runtime.set(firstKey, { ...runtime.get(firstKey), tripwire: "LATEST", observedAt: latestMatchAt });
    releaseSecond(response("second-pane"));
    const completed = await collecting;
    assert.equal(completed.rows.find((row) => row.name === "first").tripwire, "LATEST");
    assert.equal(runtime.get(firstKey).tripwire, "LATEST");
    assert.equal(runtime.get(firstKey).observedAt, latestMatchAt);
    assert.equal(completed.rows.find((row) => row.name === "first").last_message.text, "first-pane round 2");
    negativeControl("same-occupant match timestamp survives pending second pane read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a recorded lane never claims a switched branch or detached live checkout", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-branch-drift-")));
  try {
    const repository = makeRepository(root, "branch-drift");
    const checkout = join(root, "lane-checkout");
    git(repository.repo, ["worktree", "add", "-b", "lane/original", checkout]);
    const socket = join(root, "board.sock");
    const sessionId = "77777777-7777-4777-8777-777777777777";
    writeSession(repository, {
      session_id: sessionId, topic: "original", name: "worker",
      workspace: "lane-workspace", pane: "lane-pane", server: socket,
      goal: "Original task brief",
    });
    const agent = liveAgent({ name: "worker", cwd: checkout, workspace: "lane-workspace", pane: "lane-pane" });
    const { collectMachineBoardDocument } = await import(INVENTORY);
    const read = () => collectMachineBoardDocument({
      currentSocketPath: socket,
      listSessions: () => ({ sessions: [] }),
      clientFactory: () => ({ snapshot: async () => snapshot([agent], [
        workspace(repository, "lane-workspace", checkout, true),
      ]), close() {} }),
      listWorktrees: () => worktreeList(repository, [{
        branch: (() => {
          try { return git(checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"]); }
          catch { return null; }
        })(),
        open_workspace_id: "lane-workspace", path: checkout,
      }]),
      stats: { load: 0, freeMemoryBytes: 1024, workers: {} },
    });
    const original = await read();
    assert.equal(original.rows.length, 1);
    assert.equal(original.rows[0].row_id, sessionId);
    assert.equal(original.rows[0].status, "working");

    git(checkout, ["switch", "-c", "lane/replacement"]);
    const switched = await read();
    assert.equal(switched.rows.length, 2);
    assert.equal(switched.rows.find((row) => row.registered).status, "offline");
    assert.equal(switched.rows.find((row) => !row.registered).branch, "lane/replacement");
    assert.equal(switched.rows.find((row) => !row.registered).goal_source, "terminal-title");

    git(checkout, ["switch", "--detach"]);
    const detached = await read();
    assert.equal(detached.rows.length, 2);
    assert.equal(detached.rows.find((row) => row.registered).status, "offline");
    assert.equal(detached.rows.find((row) => !row.registered).branch, null);
    assert.equal(detached.rows.find((row) => !row.registered).git.available, false);
    negativeControl("recorded lane versus live branch and detached HEAD");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replacement occupants cannot inherit a registry claim or its done history", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-replacement-")));
  try {
    const repository = makeRepository(root, "replacement");
    const checkout = join(root, "lane-checkout");
    git(repository.repo, ["worktree", "add", "-b", "lane/replacement", checkout]);
    const socket = join(root, "board.sock");
    const sessionId = "88888888-8888-4888-8888-888888888888";
    writeSession(repository, {
      session_id: sessionId, topic: "replacement", name: "same-name",
      workspace: "lane-workspace", pane: "lane-pane", server: socket,
      goal: "Retired task", done: true, agent_session_id: "former-session",
    });
    const replacement = liveAgent({
      name: "same-name", status: "idle", cwd: checkout,
      workspace: "lane-workspace", pane: "lane-pane",
      session: "new-session", terminal: "lane-pane-terminal", title: "New occupant title",
    });
    const { collectMachineBoardDocument } = await import(INVENTORY);
    const options = {
      currentSocketPath: socket,
      listSessions: () => ({ sessions: [] }),
      clientFactory: () => ({ snapshot: async () => snapshot([replacement], [
        workspace(repository, "lane-workspace", checkout, true),
      ]), close() {} }),
      listWorktrees: () => worktreeList(repository, [{
        branch: "lane/replacement", open_workspace_id: "lane-workspace", path: checkout,
      }]),
      stats: { load: 0, freeMemoryBytes: 1024, workers: {} },
    };
    const current = await collectMachineBoardDocument(options);
    assert.equal(current.rows.length, 1);
    assert.equal(current.rows[0].registered, false);
    assert.equal(current.rows[0].goal, "New occupant title");
    assert.equal(current.rows[0].done, false);
    const history = await collectMachineBoardDocument({ ...options, includeHistory: true });
    assert.equal(history.rows.length, 2);
    assert.equal(history.rows.find((row) => row.registered).status, "offline");
    assert.equal(history.rows.find((row) => !row.registered).role, null);

    writeSession(repository, {
      session_id: "99999999-9999-4999-8999-999999999999", topic: "replacement",
      name: "same-name", workspace: "lane-workspace", pane: "lane-pane", server: socket,
      omitOccupantEvidence: true,
    });
    const oldFormat = await collectMachineBoardDocument({ ...options, includeHistory: true });
    assert.equal(oldFormat.rows.filter((row) => row.registered).length, 2);
    assert.equal(oldFormat.rows.filter((row) => !row.registered).length, 1);
    negativeControl("same-name same-pane replacement and unverifiable legacy record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a title-only unregistered goal never fabricates a brief excerpt", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-title-")));
  try {
    const repository = makeRepository(root, "title");
    const socket = join(root, "board.sock");
    const agent = liveAgent({
      name: "manual-agent", cwd: repository.repo, workspace: "main-workspace",
      pane: "manual-pane", title: "Manual terminal title",
    });
    const { collectMachineBoardDocument } = await import(INVENTORY);
    const document = await collectMachineBoardDocument({
      currentSocketPath: socket,
      listSessions: () => ({ sessions: [] }),
      clientFactory: () => ({ snapshot: async () => snapshot([agent], [
        workspace(repository, "main-workspace", repository.repo, false),
      ]), close() {} }),
      listWorktrees: () => worktreeList(repository, [{
        branch: "main", open_workspace_id: "main-workspace", path: repository.repo,
      }]),
      stats: { load: 0, freeMemoryBytes: 1024, workers: {} },
    });
    assert.equal(document.rows.length, 1);
    assert.equal(document.rows[0].registered, false);
    assert.equal(document.rows[0].goal, "Manual terminal title");
    assert.equal(document.rows[0].goal_source, "terminal-title");
    assert.deepEqual(document.rows[0].brief, { path: null, excerpt: null });
    negativeControl("unregistered title is not a brief excerpt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unregistered agent without a title has no goal provenance", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-board-no-title-")));
  try {
    const repository = makeRepository(root, "no-title");
    const socket = join(root, "board.sock");
    const agent = liveAgent({
      name: "manual-agent", cwd: repository.repo, workspace: "main-workspace",
      pane: "manual-pane", title: "",
    });
    const { collectMachineBoardDocument } = await import(INVENTORY);
    const document = await collectMachineBoardDocument({
      currentSocketPath: socket,
      listSessions: () => ({ sessions: [] }),
      clientFactory: () => ({ snapshot: async () => snapshot([agent], [
        workspace(repository, "main-workspace", repository.repo, false),
      ]), close() {} }),
      listWorktrees: () => worktreeList(repository, [{
        branch: "main", open_workspace_id: "main-workspace", path: repository.repo,
      }]),
      stats: { load: 0, freeMemoryBytes: 1024, workers: {} },
    });
    assert.equal(document.rows.length, 1);
    assert.equal(document.rows[0].registered, false);
    assert.equal(document.rows[0].goal, null);
    assert.equal(document.rows[0].goal_source, null);
    assert.deepEqual(document.rows[0].brief, { path: null, excerpt: null });
    negativeControl("no-title unregistered goal provenance stays null");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
