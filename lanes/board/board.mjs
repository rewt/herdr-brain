import { execFileSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  statSync,
} from "node:fs";
import { freemem, loadavg } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

import { HerdrClient } from "./herdr-client.mjs";
import {
  messageOccupantId,
  refreshMessagePreviews,
  supportsMessagePreview,
} from "./message-preview.mjs";
import { loadRegistry } from "./registry.mjs";
import {
  renderPlainBoard,
} from "./view.mjs";

export { loadRegistry, markSessionDone } from "./registry.mjs";
export {
  footerLine,
  interactiveMessage,
  renderPlainBoard,
  tableLineEntries,
  tableLines,
} from "./view.mjs";

export function parseVerdict(text) {
  const matches = [...text.matchAll(/\*\*(PASS|NEEDS-WORK|FAIL)\*\*/gu)];
  return matches.at(-1)?.[1] ?? "-";
}

function workspaceFor(session, snapshot) {
  if (session.inventory_scoped === true) return session.inventory_workspace ?? undefined;
  return snapshot?.workspaces?.find(
    (workspace) =>
      (workspace.workspace_id === session.workspace || workspace.label === session.workspace) &&
      (session.server === undefined || workspace.server_id === undefined || workspace.server_id === session.server),
  );
}

function agentFor(session, workspace, snapshot) {
  if (session.inventory_scoped === true) return session.inventory_agent ?? undefined;
  const candidates = snapshot?.agents?.filter((candidate) =>
    (session.server === undefined || candidate.server_id === undefined || candidate.server_id === session.server) &&
    (session.pane === undefined || candidate.pane_id === session.pane) &&
    (session.name === undefined || session.name === null || candidate.name === session.name)) ?? [];
  const agent = candidates.length === 1 ? candidates[0] : undefined;
  return workspace === undefined || agent?.workspace_id === workspace.workspace_id ? agent : undefined;
}

function branchForSession(session) {
  if (typeof session.branch === "string") return session.branch;
  if (typeof session.lane !== "string") return null;
  return session.lane.startsWith("lane/") ? session.lane : `lane/${session.lane}`;
}

function observationKey(session) {
  return session.inventory_scoped === true
    ? JSON.stringify([session.repo_id, session.session_id])
    : session.session_id;
}

function liveRuntimeFor(session, agent, runtime) {
  const cached = runtime.get(session.runtime_key) ?? runtime.get(agent?.pane_id) ?? {};
  if (session.inventory_scoped === true &&
      cached.inventoryOccupantId !== session.inventory_occupant_id) return {};
  return cached.occupantId === undefined || cached.occupantId === messageOccupantId(agent)
    ? cached
    : {};
}

function resolveSessionContext(session, state) {
  const workspace = workspaceFor(session, state.snapshot);
  const agent = agentFor(session, workspace, state.snapshot);
  const live = liveRuntimeFor(session, agent, state.runtime);
  return {
    workspace,
    agent,
    live,
    git: state.gitStates.get(observationKey(session)) ??
      (session.inventory_scoped === true ? undefined : state.gitStates.get(session.lane)) ?? {},
    report: state.reportStates.get(observationKey(session)) ??
      (session.inventory_scoped === true ? undefined : state.reportStates.get(session.report)) ?? {},
    branch: branchForSession(session),
  };
}

function paneIdFor(session, snapshot) {
  const workspace = workspaceFor(session, snapshot);
  return agentFor(session, workspace, snapshot)?.pane_id;
}

function tabIdFor(agent, snapshot) {
  if (agent === undefined) return null;
  return agent.tab_id
    ?? snapshot?.panes?.find((pane) => pane.pane_id === agent.pane_id)?.tab_id
    ?? null;
}

export function buildSubscriptions(registry, snapshot) {
  const subscriptions = [];
  for (const session of registry) {
    const workspace = workspaceFor(session, snapshot);
    const agent = agentFor(session, workspace, snapshot);
    const paneId = agent?.pane_id;
    if (paneId === undefined) continue;
    subscriptions.push({ type: "pane.agent_status_changed", pane_id: paneId });
    if (supportsMessagePreview(agent.agent)) {
      subscriptions.push({
        type: "pane.output_changed",
        pane_id: paneId,
      });
    }
    for (const pattern of session.tripwires ?? []) {
      subscriptions.push({
        type: "pane.output_matched",
        pane_id: paneId,
        source: "recent_unwrapped",
        lines: 20,
        strip_ansi: true,
        match: { type: "substring", value: pattern },
      });
    }
  }
  return subscriptions;
}

export function matchingTripwire(patterns, event) {
  const text = `${event.data?.matched_line ?? event.data?.read?.text ?? ""}`;
  return patterns.find((pattern) => text.includes(pattern));
}

export function applyHerdrEvent(snapshot, runtime, registry, event) {
  const data = event.data ?? {};
  if (event.event === "pane.agent_status_changed") {
    const agent = snapshot?.agents?.find((candidate) => candidate.pane_id === data.pane_id);
    if (agent !== undefined) agent.agent_status = data.agent_status;
    return;
  }
  if (event.event !== "pane.output_matched") return;
  const previous = runtime.get(data.pane_id) ?? {};
  const session = registry.find((candidate) => paneIdFor(candidate, snapshot) === data.pane_id);
  const tripwire = matchingTripwire(session?.tripwires ?? [], event) ?? previous.tripwire;
  runtime.set(data.pane_id, {
    ...previous,
    tripwire,
    observedAt: new Date().toISOString(),
  });
}

function messageSummary(live) {
  if (live.messageSource === "assistant-preview" && typeof live.messageText === "string") {
    return live.messageText.split("\n").find((line) => line.trim() !== "") ?? "message unavailable";
  }
  if (live.messageRawExcerpt?.text) {
    const excerpt = live.messageRawExcerpt.text.split("\n").find((line) => line.trim() !== "") ?? "";
    return `message unavailable; pane output: ${excerpt}`;
  }
  return live.messageSource === "unavailable" ? "message unavailable" : "-";
}

export function joinBoardRows({
  registry,
  snapshot,
  gitStates = new Map(),
  reportStates = new Map(),
  runtime = new Map(),
  now = new Date(),
}) {
  return registry.map((session) => {
    const { workspace, agent, live, git, report, branch } = resolveSessionContext(session, {
      snapshot,
      gitStates,
      reportStates,
      runtime,
    });
    let deadline = "-";
    if (session.done) deadline = "done";
    else if (session.deadline) {
      const date = new Date(session.deadline);
      deadline = Number.isNaN(date.valueOf()) ? "invalid" : date < now ? "OVERDUE" : session.deadline.slice(0, 10);
    }
    return {
      name: session.name,
      role: session.role,
      lane: session.lane ?? branch ?? "-",
      status: agent?.agent_status ?? "offline",
      pane: agent?.pane_id ?? "-",
      git: git.ahead === undefined ? "-" : `+${git.ahead}${git.dirty ? " DIRTY" : ""}`,
      gate: git.gate ?? "-",
      gateColor: git.gateColor,
      report: report.verdict === undefined
        ? "-"
        : report.verdict === "-" ? report.mtime : `${report.verdict}@${report.mtime}`,
      deadline,
      tripwire: live.tripwire ?? "-",
      output: messageSummary(live),
      done: session.done ? "yes" : "no",
      sessionId: session.session_id,
      workspace: workspace?.workspace_id,
      checkoutPath: workspace?.worktree?.checkout_path,
    };
  });
}

function gitOutput(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function worktrees(repoRoot) {
  const output = gitOutput(repoRoot, ["worktree", "list", "--porcelain"]);
  if (output === undefined) return [];
  return output.split("\n\n").map((entry) => {
    const lines = entry.split("\n");
    return {
      path: lines.find((line) => line.startsWith("worktree "))?.slice(9),
      branch: lines.find((line) => line.startsWith("branch refs/heads/"))?.slice(18),
    };
  });
}

function gateState(checkout, head) {
  if (checkout === undefined || head === undefined) return {};
  try {
    const report = JSON.parse(readFileSync(resolve(checkout, ".lane", "gate.json"), "utf8"));
    if (typeof report.head !== "string") return {};
    if (report.head !== head) {
      return {
        gate: "STALE",
        gateState: "stale",
        gateHead: report.head,
        gateExitCode: Number.isInteger(report.exit_code) ? report.exit_code : null,
        gateSignal: typeof report.signal === "string" ? report.signal : null,
      };
    }
    if (!Number.isInteger(report.exit_code)) return {};
    return {
      gate: `exit=${report.exit_code} @${head.slice(0, 7)}`,
      gateColor: report.exit_code === 0 ? "green" : "red",
      gateState: report.exit_code === 0 ? "pass" : "fail",
      gateHead: report.head,
      gateExitCode: report.exit_code,
      gateSignal: typeof report.signal === "string" ? report.signal : null,
    };
  } catch {
    return {};
  }
}

export function collectGitStates(repoRoot, main, registry, snapshot) {
  const states = new Map();
  const trees = worktrees(repoRoot);
  for (const session of registry) {
    const branch = branchForSession(session);
    if (branch === null) continue;
    const checkout = trees.find((tree) => tree.branch === branch)?.path;
    const counts = gitOutput(repoRoot, ["rev-list", "--left-right", "--count", `${branch}...${main}`]);
    if (counts === undefined) continue;
    const [ahead, behind] = counts.split(/\s+/u).map(Number);
    const dirty = checkout === undefined
      ? null
      : (gitOutput(checkout, ["status", "--porcelain=v1"]) ?? "") !== "";
    const head = gitOutput(checkout ?? repoRoot, ["rev-parse", checkout === undefined ? branch : "HEAD"]);
    const state = {
      ahead,
      behind,
      dirty,
      checkout,
      head,
      available: head !== undefined,
      ...gateState(checkout, head),
    };
    if (session.inventory_scoped !== true && session.lane !== undefined) states.set(session.lane, state);
    if (session.session_id !== undefined) states.set(observationKey(session), state);
  }
  return states;
}

export function collectReportStates(repoRoot, registry) {
  const states = new Map();
  const trees = worktrees(repoRoot);
  for (const session of registry) {
    if (typeof session.report !== "string" || session.report === "") continue;
    const branch = branchForSession(session);
    const checkout = branch === null ? undefined : trees.find((tree) => tree.branch === branch)?.path;
    const candidates = isAbsolute(session.report)
      ? [session.report]
      : [...(checkout === undefined ? [] : [resolve(checkout, session.report)]), resolve(repoRoot, session.report)];
    for (const path of candidates) {
      try {
        const text = readFileSync(path, "utf8");
        const mtimeIso = statSync(path).mtime.toISOString();
        const mtime = mtimeIso.slice(5, 16).replace("T", " ");
        const reviewedHead = text.match(/^Reviewed commit:\s*([0-9a-f]{40})\s*$/imu)?.[1] ?? null;
        const state = {
          verdict: parseVerdict(text),
          mtime,
          mtimeIso,
          path,
          reviewedHead,
        };
        if (session.inventory_scoped !== true) states.set(session.report, state);
        if (session.session_id !== undefined) states.set(observationKey(session), state);
        break;
      } catch {
        // Try the canonical checkout after the lane; a missing report is normal.
      }
    }
  }
  return states;
}

export function systemStats() {
  const command = spawnSync("ps", ["-Ao", "command="], { encoding: "utf8" }).stdout ?? "";
  const freeMemoryBytes = freemem();
  return {
    load: loadavg()[0],
    freeMemory: `${(freeMemoryBytes / (1024 ** 3)).toFixed(1)} GiB`,
    freeMemoryBytes,
    workers: countWorkers(command),
  };
}

export function countWorkers(command) {
  const workers = { vitest: 0, cargo: 0, go: 0, rustc: 0 };
  for (const line of command.split("\n")) {
    const argv = line.trim().split(/\s+/u);
    const executable = basename(argv[0] ?? "");
    const candidates = [executable];
    if (/^(?:node(?:js)?|python(?:\d+(?:\.\d+)?)?|ruby|perl|php|bash|sh|zsh|deno|bun)$/u.test(executable)) {
      candidates.push(basename(argv[1] ?? ""));
    }
    const worker = candidates
      .map((candidate) => candidate.replace(/\.(?:[cm]?js|py|rb)$/u, ""))
      .find((candidate) => Object.hasOwn(workers, candidate));
    if (worker !== undefined) workers[worker] += 1;
  }
  return workers;
}

export async function collectBoardState({ repoRoot, config = {}, client, runtime = new Map(), now = new Date() }) {
  const loaded = loadRegistry(repoRoot, config);
  let snapshot = { protocol: undefined, version: undefined, agents: [], panes: [], workspaces: [] };
  let connection = "offline";
  let snapshotError;
  let messageErrors = [];
  try {
    snapshot = await client.snapshot();
    connection = `Herdr ${snapshot.version ?? "?"} / protocol ${snapshot.protocol ?? "?"}`;
    const previews = await refreshMessagePreviews({
      registry: loaded.sessions,
      snapshot,
      runtime,
      client,
      now,
    });
    messageErrors = previews.errors;
  } catch (error) {
    snapshotError = error.message;
    // Git and report state remain useful when Herdr is unavailable.
  }
  const gitStates = collectGitStates(repoRoot, config.main ?? "main", loaded.sessions, snapshot);
  const reportStates = collectReportStates(repoRoot, loaded.sessions);
  return {
    ...loaded,
    snapshot,
    rows: joinBoardRows({
      registry: loaded.sessions,
      snapshot,
      gitStates,
      reportStates,
      runtime,
      now,
    }),
    gitStates,
    reportStates,
    stats: systemStats(),
    connection,
    snapshotError,
    messageErrors,
    runtime,
  };
}

function structuredGitState(git = {}) {
  return {
    head: git.head ?? null,
    ahead: Number.isInteger(git.ahead) ? git.ahead : null,
    behind: Number.isInteger(git.behind) ? git.behind : null,
    dirty: typeof git.dirty === "boolean" ? git.dirty : null,
    available: git.available === true,
  };
}

function structuredGateState(git = {}) {
  return {
    state: git.gateState ?? "missing",
    head: git.gateHead ?? null,
    exit_code: Number.isInteger(git.gateExitCode) ? git.gateExitCode : null,
    signal: git.gateSignal ?? null,
  };
}

function structuredReportState(report = {}) {
  return {
    path: report.path ?? null,
    mtime: report.mtimeIso ?? null,
    verdict: report.verdict === undefined || report.verdict === "-" ? null : report.verdict,
    reviewed_head: report.reviewedHead ?? null,
  };
}

function structuredLastMessage(runtime = {}, agent) {
  const available = runtime.messageSource === "assistant-preview"
    && typeof runtime.messageText === "string"
    && runtime.messageText !== "";
  return {
    text: available ? runtime.messageText : null,
    source: available ? "assistant-preview" : "unavailable",
    kind: runtime.messageKind ?? agent?.agent ?? null,
    observed_at: runtime.messageObservedAt ?? null,
    revision: Number.isInteger(runtime.messageRevision) ? runtime.messageRevision : null,
    truncated: runtime.messageTruncated === true,
    stale: runtime.messageStale === true,
    available,
    raw_excerpt: runtime.messageRawExcerpt ?? null,
    limitation: runtime.messageLimitation ?? null,
  };
}

function messageCoverage(state) {
  if (state.snapshotError !== undefined) return "unavailable";
  const readable = state.sessions
    .map((session) => ({
      session,
      agent: agentFor(session, workspaceFor(session, state.snapshot), state.snapshot),
    }))
    .filter(({ agent }) => supportsMessagePreview(agent?.agent) && typeof agent.pane_id === "string");
  if (readable.length === 0) return "unavailable";
  const messages = readable.map(({ session, agent }) => structuredLastMessage(
    liveRuntimeFor(session, agent, state.runtime),
    agent,
  ));
  if ((state.messageErrors ?? []).length > 0 || messages.some((message) => !message.available)) return "partial";
  return "assistant-preview";
}

export function boardSnapshotDocument({
  state,
  repoId,
  rootId,
  repoRoot,
  rootLabel,
  repositoryLabel,
  laneBase,
  capturedAt = new Date(),
}) {
  const rows = state.sessions.map((session) => {
    const { workspace, agent, live, git, report, branch } = resolveSessionContext(session, {
      snapshot: state.snapshot,
      gitStates: state.gitStates,
      reportStates: state.reportStates,
      runtime: state.runtime,
    });
    const deadlineTime = session.deadline === null || session.deadline === undefined
      ? null
      : new Date(session.deadline).valueOf();
    return {
      row_id: session.session_id,
      repo_id: Object.hasOwn(session, "repo_id") ? session.repo_id : repoId,
      root_id: Object.hasOwn(session, "root_id") ? session.root_id : rootId,
      server_id: session.reported_server ?? session.server ?? null,
      name: session.name ?? null,
      pane_id: agent?.pane_id ?? session.pane ?? null,
      tab_id: tabIdFor(agent, state.snapshot),
      workspace_id: workspace?.workspace_id ?? session.workspace ?? null,
      registered: session.registered !== false,
      topic: session.topic ?? (branch?.startsWith("lane/") ? branch.slice("lane/".length) : null),
      branch,
      role: session.role ?? null,
      goal: session.goal ?? null,
      goal_source: session.goal_source !== undefined ? session.goal_source
        : session.registered === false || session.goal == null ? null : "registry",
      brief: {
        path: session.brief ?? null,
        excerpt: session.goal_source === "terminal-title" ? null : session.goal ?? null,
      },
      status: agent?.agent_status ?? "offline",
      done: session.done === true,
      active_after_done: session.active_after_done === true,
      group: session.group ?? {
        kind: branch?.startsWith("lane/") ? "lane" : "facilitator",
        key: branch?.startsWith("lane/") ? branch : "facilitator",
      },
      git: structuredGitState(git),
      gate: structuredGateState(git),
      report: structuredReportState(report),
      deadline: session.deadline ?? null,
      overdue: Number.isFinite(deadlineTime) ? !session.done && deadlineTime < capturedAt.valueOf() : false,
      last_message: structuredLastMessage(live, agent),
      tripwire: live.tripwire ?? null,
      stale: session.stale === true || state.snapshotError !== undefined,
    };
  });
  const registryCoverage = !state.exists
    ? "missing"
    : state.errors.length > 0 ? "partial" : "available";
  const defaultRepository = {
    repo_id: repoId,
    root_id: rootId,
    path: repoRoot,
    root_label: rootLabel,
    repository_label: repositoryLabel,
    lane_base: laneBase,
  };
  return {
    schema_version: 1,
    captured_at: capturedAt.toISOString(),
    scope: state.inventory?.scope ?? { kind: "repository", repo_id: repoId },
    coverage: {
      repository: "complete",
      registry: registryCoverage,
      herdr: state.snapshotError === undefined ? "connected" : "unavailable",
      messages: messageCoverage(state),
      ...(state.inventory?.coverage ?? {}),
    },
    repositories: state.inventory?.repositories ?? [defaultRepository],
    rows,
    host: {
      load_1m: state.stats.load,
      free_memory_bytes: state.stats.freeMemoryBytes,
      workers: state.stats.workers,
    },
    errors: [
      ...state.errors.map((message) => ({ source: "registry", message })),
      ...(state.snapshotError === undefined ? [] : [{ source: "herdr", message: state.snapshotError }]),
      ...(state.inventory?.messageErrors ??
        (state.messageErrors ?? []).map((message) => ({ source: "message", message }))),
      ...(state.inventory?.errors ?? []),
    ],
  };
}

export async function runOnce({ repoRoot, config = {} }) {
  const client = new HerdrClient({ requestTimeoutMs: 500, paneReadTimeoutMs: 2_000 });
  try {
    const state = await collectBoardState({ repoRoot, config, client });
    process.stdout.write(renderPlainBoard(state.rows, state.stats, {
      connection: state.connection,
      missingRegistry: state.exists ? undefined : state.path,
      registryErrors: state.errors,
      messageErrors: state.messageErrors,
    }));
  } finally {
    client.close();
  }
}
