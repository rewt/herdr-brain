import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  boardSnapshotDocument,
  buildSubscriptions,
  collectGitStates,
  collectReportStates,
  joinBoardRows,
  systemStats,
} from "./board.mjs";
import { HerdrClient, herdrSocketPath } from "./herdr-client.mjs";
import { messageOccupantId, refreshMessagePreviews } from "./message-preview.mjs";
import { loadRegistry } from "./registry.mjs";

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function samePath(left, right) {
  return typeof left === "string" && typeof right === "string" &&
    canonicalPath(left) === canonicalPath(right);
}

function serverIdentity(path) {
  return `local-${createHash("sha256").update(path).digest("hex").slice(0, 12)}`;
}

function normalizeSessionList(value) {
  const body = value?.result ?? value;
  if (!Array.isArray(body?.sessions)) throw new Error("Herdr session list did not contain a sessions array");
  return body.sessions;
}

function defaultListSessions() {
  const run = spawnSync("herdr", ["session", "list", "--json"], { encoding: "utf8" });
  if (run.error !== undefined) throw new Error(`cannot enumerate local Herdr sessions: ${run.error.code ?? run.error.message}`);
  if (run.status !== 0) throw new Error(`cannot enumerate local Herdr sessions: exit ${run.status}`);
  try {
    return JSON.parse(run.stdout);
  } catch (error) {
    throw new Error(`cannot parse local Herdr session list: ${error.message}`);
  }
}

export function enumerateLocalHerdrEndpoints({
  currentSocketPath = herdrSocketPath(),
  listSessions = defaultListSessions,
} = {}) {
  const errors = [];
  const candidates = [{
    path: currentSocketPath,
    labels: ["current"],
    current: true,
    running: undefined,
  }];
  let coverage = "complete";
  try {
    for (const session of normalizeSessionList(listSessions())) {
      if (session?.remote === true) continue;
      if (typeof session?.socket_path !== "string" || !isAbsolute(session.socket_path)) {
        errors.push({ source: "discovery", message: "ignored a local Herdr session with an invalid socket path" });
        coverage = "partial";
        continue;
      }
      candidates.push({
        path: session.socket_path,
        labels: [typeof session.name === "string" && session.name !== "" ? session.name : "unnamed"],
        current: false,
        running: typeof session.running === "boolean" ? session.running : undefined,
      });
    }
  } catch (error) {
    coverage = "partial";
    errors.push({ source: "discovery", message: error.message });
  }
  const byPath = new Map();
  for (const candidate of candidates) {
    if (typeof candidate.path !== "string" || !isAbsolute(candidate.path)) continue;
    const path = canonicalPath(candidate.path);
    const previous = byPath.get(path);
    if (previous === undefined) {
      byPath.set(path, {
        path,
        server_id: serverIdentity(path),
        labels: [...candidate.labels],
        current: candidate.current,
        running: candidate.running,
      });
    } else {
      previous.current ||= candidate.current;
      previous.running = previous.running === true || candidate.running === true
        ? true
        : previous.running ?? candidate.running;
      for (const label of candidate.labels) {
        if (!previous.labels.includes(label)) previous.labels.push(label);
      }
    }
  }
  return { endpoints: [...byPath.values()], coverage, errors };
}

function gitOutput(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function inspectRepository(path) {
  try {
    const checkout = canonicalPath(gitOutput(path, ["rev-parse", "--show-toplevel"]));
    const repoId = canonicalPath(gitOutput(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    const listed = gitOutput(checkout, ["worktree", "list", "--porcelain"]);
    let canonicalCheckout;
    for (const entry of listed.split("\n\n")) {
      const worktree = entry.split("\n").find((line) => line.startsWith("worktree "))?.slice(9);
      if (worktree === undefined) continue;
      try {
        const candidate = canonicalPath(worktree);
        const common = canonicalPath(gitOutput(candidate, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
        const gitDirectory = canonicalPath(gitOutput(candidate, ["rev-parse", "--path-format=absolute", "--git-dir"]));
        if (common === repoId && gitDirectory === repoId) {
          canonicalCheckout = candidate;
          break;
        }
      } catch {
        // A prunable worktree cannot establish the canonical checkout.
      }
    }
    let observedBranch = null;
    try {
      observedBranch = gitOutput(checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    } catch {
      // Detached HEAD has no checked-out branch.
    }
    return {
      repo_id: repoId,
      path: canonicalCheckout ?? checkout,
      observed_checkout: checkout,
      observed_branch: observedBranch,
      repository_label: basename(canonicalCheckout ?? checkout),
    };
  } catch {
    return undefined;
  }
}

function within(path, boundary) {
  const offset = relative(boundary, path);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

function nearestParentConfig(repository) {
  const home = resolve(homedir());
  if (resolve(repository) === home) return undefined;
  const boundedByHome = within(repository, home);
  let directory = dirname(repository);
  while (dirname(directory) !== directory) {
    if (boundedByHome && (!within(directory, home) || directory === home)) break;
    const candidate = join(directory, ".lane.json");
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  return undefined;
}

function validateBoardConfig(config, file) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`invalid lane config ${file}: top level must be an object`);
  }
  for (const key of ["main", "registry", "worktree_root"]) {
    if (Object.hasOwn(config, key) && typeof config[key] !== "string") {
      throw new Error(`invalid lane config ${file}: ${key} must be a string`);
    }
  }
}

function readBoardConfig(file) {
  let config;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read lane config ${file}: ${error.message}`);
  }
  validateBoardConfig(config, file);
  return config;
}

function repositoryContext(repository, anchor) {
  if (anchor !== undefined && samePath(repository.repo_id, anchor.repo_id)) {
    return {
      ...repository,
      config: anchor.config ?? {},
      root_id: anchor.root_id ?? canonicalPath(dirname(repository.path)),
      root_label: basename(anchor.root_id ?? canonicalPath(dirname(repository.path))),
      lane_base: anchor.lane_base ?? join(homedir(), ".herdr", "worktrees", repository.repository_label),
    };
  }
  const parentFile = nearestParentConfig(repository.path);
  const repositoryFile = join(repository.path, ".lane.json");
  const layers = [];
  if (parentFile !== undefined) layers.push({ file: parentFile, config: readBoardConfig(parentFile) });
  if (existsSync(repositoryFile)) layers.push({ file: repositoryFile, config: readBoardConfig(repositoryFile) });
  const config = Object.assign({}, ...layers.map((layer) => layer.config));
  const rootId = canonicalPath(parentFile === undefined ? dirname(repository.path) : dirname(parentFile));
  const worktreeLayer = [...layers].reverse().find((layer) => Object.hasOwn(layer.config, "worktree_root"));
  const worktreeBase = worktreeLayer === undefined
    ? parentFile === undefined
      ? join(homedir(), ".herdr", "worktrees")
      : join(dirname(parentFile), ".worktrees")
    : resolve(dirname(worktreeLayer.file), worktreeLayer.config.worktree_root);
  return {
    ...repository,
    config,
    root_id: rootId,
    root_label: basename(rootId),
    lane_base: join(worktreeBase, repository.repository_label),
  };
}

function fallbackRepositoryContext(repository) {
  const rootId = canonicalPath(dirname(repository.path));
  return {
    ...repository,
    config: {},
    root_id: rootId,
    root_label: basename(rootId),
    lane_base: join(homedir(), ".herdr", "worktrees", repository.repository_label),
  };
}

function defaultListWorktrees({ endpoint, repository }) {
  const run = spawnSync("herdr", ["worktree", "list", "--cwd", repository.path], {
    encoding: "utf8",
    env: { ...process.env, HERDR_SOCKET_PATH: endpoint.path },
  });
  if (run.error !== undefined) throw new Error(run.error.code ?? run.error.message);
  if (run.status !== 0) throw new Error(`exit ${run.status}`);
  const parsed = JSON.parse(run.stdout);
  return parsed.result ?? parsed;
}

function agentIdentity(endpoint, agent) {
  const occupant = messageOccupantId(agent) ?? JSON.stringify([
    agent.workspace_id ?? null,
    agent.pane_id ?? null,
    agent.name ?? null,
    agent.terminal_id ?? null,
  ]);
  return `${endpoint.path}\0${occupant}`;
}

function liveRowId(endpoint, agent) {
  return `live-${createHash("sha256").update(agentIdentity(endpoint, agent)).digest("hex")}`;
}

function runtimeKey(endpoint, pane) {
  return `${endpoint.server_id}\0${pane}`;
}

function groupFor(branch, repositoryKnown) {
  if (typeof branch === "string" && branch.startsWith("lane/")) {
    return { kind: "lane", key: branch };
  }
  if (repositoryKnown) return { kind: "facilitator", key: "facilitator" };
  return { kind: "unknown", key: "unknown" };
}

function statusIsActiveAfterDone(status) {
  return status === "working" || status === "blocked" || status === "unknown";
}

function sortSessions(left, right, repositories) {
  const repositoryFor = (session) => repositories.get(session.repo_id);
  const leftRepo = repositoryFor(left);
  const rightRepo = repositoryFor(right);
  const keys = [
    [leftRepo?.root_label ?? "\uffff", rightRepo?.root_label ?? "\uffff"],
    [leftRepo?.root_id ?? "\uffff", rightRepo?.root_id ?? "\uffff"],
    [leftRepo?.repository_label ?? "\uffff", rightRepo?.repository_label ?? "\uffff"],
    [left.repo_id ?? "\uffff", right.repo_id ?? "\uffff"],
  ];
  for (const [a, b] of keys) {
    const compared = a.localeCompare(b);
    if (compared !== 0) return compared;
  }
  const order = { facilitator: 0, lane: 1, unknown: 2 };
  const group = (order[left.group.kind] ?? 3) - (order[right.group.kind] ?? 3);
  if (group !== 0) return group;
  const branch = (left.branch ?? "").localeCompare(right.branch ?? "");
  return branch !== 0 ? branch : left.session_id.localeCompare(right.session_id);
}

function repositoryRecord(context) {
  return {
    repo_id: context.repo_id,
    root_id: context.root_id,
    path: context.path,
    root_label: context.root_label,
    repository_label: context.repository_label,
    lane_base: context.lane_base,
    display_suffix: null,
    display_label: context.repository_label,
  };
}

function addDisplaySuffixes(records) {
  const counts = new Map();
  for (const record of records) {
    const key = `${record.root_label}\0${record.repository_label}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const record of records) {
    const key = `${record.root_label}\0${record.repository_label}`;
    if (counts.get(key) < 2) continue;
    record.display_suffix = createHash("sha256").update(record.repo_id).digest("hex").slice(0, 8);
    record.display_label = `${record.repository_label} #${record.display_suffix}`;
  }
}

function registryLiveMatch(session, endpointStates, agentRepositories, agentProvenance, verifiedAgents, repository) {
  const recordedBranch = typeof session.lane === "string"
    ? session.lane.startsWith("lane/") ? session.lane : `lane/${session.lane}`
    : null;
  // Names, pane IDs, and workspace labels can be reused by a later occupant.
  if (typeof session.agent_session_id !== "string" || session.agent_session_id === "" ||
      recordedBranch === null) return undefined;
  const endpointPath = typeof session.server === "string" && isAbsolute(session.server)
    ? canonicalPath(session.server)
    : undefined;
  const matches = [];
  for (const state of endpointStates) {
    if (!state.available || (endpointPath !== undefined && state.endpoint.path !== endpointPath)) continue;
    const matchingWorkspaces = state.snapshot.workspaces.filter((workspace) =>
      workspace.workspace_id === session.workspace || workspace.label === session.workspace);
    if (matchingWorkspaces.length !== 1) continue;
    const selectedWorkspace = matchingWorkspaces[0];
    for (const agent of state.snapshot.agents) {
      if (agent.name !== session.name) continue;
      if (agent.agent_session?.value !== session.agent_session_id) continue;
      if (session.terminal_id !== undefined && agent.terminal_id !== session.terminal_id) continue;
      if (typeof session.pane === "string" && agent.pane_id !== session.pane) continue;
      if (selectedWorkspace.workspace_id !== agent.workspace_id) continue;
      const identity = agentIdentity(state.endpoint, agent);
      if (!verifiedAgents.has(identity) || agentProvenance.get(identity)?.branch !== recordedBranch) continue;
      const agentRepository = agentRepositories.get(identity);
      if (agentRepository?.repo_id !== repository.repo_id) continue;
      matches.push({ state, agent, workspace: selectedWorkspace });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function scopeFor(filter, includeHistory) {
  return {
    kind: filter === undefined ? "machine" : "repository",
    repo_id: filter?.repo_id ?? null,
    include_history: includeHistory,
  };
}

export async function collectMachineBoardObservation({
  anchor,
  repoFilter,
  includeHistory = false,
  currentSocketPath = herdrSocketPath(),
  listSessions = defaultListSessions,
  clientFactory = (endpoint) => new HerdrClient({
    socketPath: endpoint.path,
    requestTimeoutMs: 500,
    paneReadTimeoutMs: 2_000,
  }),
  listWorktrees = defaultListWorktrees,
  runtime = new Map(),
  signal,
  stats = systemStats(),
  now = new Date(),
} = {}) {
  const activeClients = new Set();
  const abort = () => {
    for (const client of activeClients) client.close();
  };
  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error("board observation cancelled");
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
  throwIfAborted();
  const inventory = enumerateLocalHerdrEndpoints({ currentSocketPath, listSessions });
  const errors = [...inventory.errors];
  const endpointStates = [];
  for (const endpoint of inventory.endpoints) {
    throwIfAborted();
    const client = clientFactory(endpoint);
    activeClients.add(client);
    try {
      const snapshot = await client.snapshot();
      throwIfAborted();
      endpointStates.push({ endpoint, client, snapshot, available: true });
    } catch (error) {
      throwIfAborted();
      endpointStates.push({ endpoint, client, snapshot: { agents: [], panes: [], workspaces: [] }, available: false, error: error.message });
      errors.push({ source: "herdr", server_id: endpoint.server_id, message: error.message });
    }
  }

  const repositoryCache = new Map();
  const repositories = new Map();
  const inspect = (path) => {
    if (typeof path !== "string" || path === "") return undefined;
    const key = canonicalPath(path);
    if (!repositoryCache.has(key)) repositoryCache.set(key, inspectRepository(key));
    const repository = repositoryCache.get(key);
    if (repository !== undefined) repositories.set(repository.repo_id, repository);
    return repository;
  };
  const anchorRepository = anchor?.path === undefined ? undefined : inspect(anchor.path);
  const effectiveAnchor = anchorRepository === undefined ? undefined : {
    ...anchor,
    repo_id: anchorRepository.repo_id,
  };
  let filterRepository;
  if (repoFilter !== undefined) {
    filterRepository = inspect(repoFilter);
    if (filterRepository === undefined) throw new Error(`repository filter is not a Git repository: ${repoFilter}`);
  }

  const workspaceRepositories = new Map();
  const agentRepositories = new Map();
  const agentProvenance = new Map();
  for (const state of endpointStates.filter((candidate) => candidate.available)) {
    throwIfAborted();
    state.snapshot = {
      ...state.snapshot,
      agents: (state.snapshot.agents ?? []).map((agent) => ({ ...agent, server_id: state.endpoint.path })),
      panes: (state.snapshot.panes ?? []).map((pane) => ({ ...pane, server_id: state.endpoint.path })),
      workspaces: (state.snapshot.workspaces ?? []).map((workspace) => ({ ...workspace, server_id: state.endpoint.path })),
    };
    for (const workspace of state.snapshot.workspaces) {
      const repository = inspect(workspace.worktree?.checkout_path);
      if (repository !== undefined) {
        workspaceRepositories.set(`${state.endpoint.server_id}\0${workspace.workspace_id}`, repository);
      }
    }
    for (const agent of state.snapshot.agents) {
      const repository = inspect(agent.cwd);
      if (repository === undefined) continue;
      const identity = agentIdentity(state.endpoint, agent);
      agentRepositories.set(identity, repository);
      agentProvenance.set(identity, {
        repository,
        checkout: repository.observed_checkout,
        branch: repository.observed_branch,
      });
    }
  }

  const branchByWorkspace = new Map();
  for (const state of endpointStates.filter((candidate) => candidate.available)) {
    throwIfAborted();
    const relevant = new Map();
    for (const workspace of state.snapshot.workspaces) {
      const repository = workspaceRepositories.get(`${state.endpoint.server_id}\0${workspace.workspace_id}`);
      if (repository !== undefined) relevant.set(repository.repo_id, repository);
    }
    for (const agent of state.snapshot.agents) {
      const repository = agentRepositories.get(agentIdentity(state.endpoint, agent));
      if (repository !== undefined) relevant.set(repository.repo_id, repository);
    }
    for (const repository of relevant.values()) {
      throwIfAborted();
      try {
        const listed = await listWorktrees({ endpoint: state.endpoint, repository });
        throwIfAborted();
        if (!samePath(listed?.source?.repo_key, repository.repo_id) ||
            !samePath(listed?.source?.repo_root, repository.path) ||
            !samePath(listed?.source?.source_checkout_path, repository.path)) {
          throw new Error("worktree-list repository identity mismatch");
        }
        for (const worktree of listed.worktrees ?? []) {
          if (typeof worktree.open_workspace_id !== "string") continue;
          branchByWorkspace.set(`${state.endpoint.server_id}\0${worktree.open_workspace_id}`, {
            branch: typeof worktree.branch === "string" ? worktree.branch : null,
            path: worktree.path,
            repo_id: repository.repo_id,
          });
        }
      } catch (error) {
        errors.push({
          source: "repository",
          server_id: state.endpoint.server_id,
          repo_id: repository.repo_id,
          message: `cannot map Herdr worktrees: ${error.message}`,
        });
      }
    }
  }

  const verifiedAgents = new Set();
  for (const state of endpointStates.filter((candidate) => candidate.available)) {
    for (const agent of state.snapshot.agents) {
      const identity = agentIdentity(state.endpoint, agent);
      const provenance = agentProvenance.get(identity);
      const workspaces = state.snapshot.workspaces.filter(
        (workspace) => workspace.workspace_id === agent.workspace_id,
      );
      if (provenance === undefined || workspaces.length !== 1) continue;
      const workspace = workspaces[0];
      const worktree = workspace.worktree;
      const mapped = branchByWorkspace.get(`${state.endpoint.server_id}\0${agent.workspace_id}`);
      const verified = (typeof worktree?.checkout_path !== "string" ||
          samePath(worktree.checkout_path, provenance.checkout)) &&
        (typeof worktree?.repo_key !== "string" ||
          samePath(worktree.repo_key, provenance.repository.repo_id)) &&
        (typeof worktree?.repo_root !== "string" ||
          samePath(worktree.repo_root, provenance.repository.path)) &&
        (mapped === undefined || (
          mapped.repo_id === provenance.repository.repo_id &&
          samePath(mapped.path, provenance.checkout) &&
          mapped.branch === provenance.branch
        ));
      if (verified) verifiedAgents.add(identity);
      else errors.push({
        source: "repository", server_id: state.endpoint.server_id,
        repo_id: provenance.repository.repo_id,
        message: "agent cwd does not match its Herdr workspace checkout mapping",
      });
    }
  }

  const contexts = new Map();
  for (const repository of repositories.values()) {
    if (filterRepository !== undefined && repository.repo_id !== filterRepository.repo_id) continue;
    try {
      contexts.set(repository.repo_id, repositoryContext(repository, effectiveAnchor));
    } catch (error) {
      errors.push({ source: "repository", repo_id: repository.repo_id, message: error.message });
      contexts.set(repository.repo_id, fallbackRepositoryContext(repository));
    }
  }
  if (filterRepository !== undefined && !contexts.has(filterRepository.repo_id)) {
    contexts.set(filterRepository.repo_id, repositoryContext(filterRepository, effectiveAnchor));
  }

  const claimedAgents = new Set();
  const allSessions = [];
  const visibleSessions = [];
  const pendingRegistry = [];
  let anyRegistry = false;
  let registryPartial = false;
  for (const context of contexts.values()) {
    let loaded;
    try {
      loaded = loadRegistry(context.path, context.config);
      anyRegistry ||= loaded.exists;
      registryPartial ||= loaded.errors.length > 0;
      for (const message of loaded.errors) {
        errors.push({ source: "registry", repo_id: context.repo_id, message });
      }
    } catch (error) {
      registryPartial = true;
      errors.push({ source: "registry", repo_id: context.repo_id, message: error.message });
      loaded = { sessions: [], exists: false, errors: [] };
    }
    for (const session of loaded.sessions) {
      if ((typeof session.repo_id === "string" && !samePath(session.repo_id, context.repo_id)) ||
          (typeof session.repo === "string" && !samePath(session.repo, context.path))) {
        registryPartial = true;
        errors.push({
          source: "registry",
          repo_id: context.repo_id,
          message: `foreign registry session ignored: ${session.session_id}`,
        });
        continue;
      }
      pendingRegistry.push({ session, context, match: registryLiveMatch(
        session, endpointStates, agentRepositories, agentProvenance, verifiedAgents, context,
      ) });
    }
  }

  const claimCounts = new Map();
  for (const { match } of pendingRegistry) {
    if (match === undefined) continue;
    const identity = agentIdentity(match.state.endpoint, match.agent);
    claimCounts.set(identity, (claimCounts.get(identity) ?? 0) + 1);
  }
  for (const { session, context, match: candidate } of pendingRegistry) {
    const identity = candidate === undefined ? undefined : agentIdentity(candidate.state.endpoint, candidate.agent);
    const match = identity !== undefined && claimCounts.get(identity) === 1 ? candidate : undefined;
    if (identity !== undefined && match === undefined) {
      registryPartial = true;
      errors.push({
        source: "registry", repo_id: context.repo_id,
        message: `ambiguous live occupant claim ignored: ${session.session_id}`,
      });
    }
    const status = match?.agent.agent_status ?? "offline";
    const branch = typeof session.lane === "string"
      ? session.lane.startsWith("lane/") ? session.lane : `lane/${session.lane}`
      : null;
    const activeAfterDone = session.done === true && statusIsActiveAfterDone(status);
    const endpoint = match?.state.endpoint;
    const normalized = {
      ...session,
      inventory_scoped: true,
      inventory_agent: match?.agent ?? null,
      inventory_workspace: match?.workspace ?? null,
      inventory_occupant_id: match === undefined ? null : identity,
      registered: true,
      repo_id: context.repo_id,
      root_id: context.root_id,
      repo: context.path,
      branch,
      group: groupFor(branch, true),
      active_after_done: activeAfterDone,
      ...(endpoint === undefined ? {} : {
        reported_server: session.server,
        server: endpoint.path,
        pane: match.agent.pane_id,
        workspace: match.agent.workspace_id,
        runtime_key: runtimeKey(endpoint, match.agent.pane_id),
      }),
      stale: endpoint === undefined && typeof session.server === "string" &&
        endpointStates.some((state) => state.endpoint.path === canonicalPath(session.server) && !state.available),
    };
    allSessions.push(normalized);
    if (match !== undefined) claimedAgents.add(identity);
    if (includeHistory || session.done !== true || activeAfterDone) visibleSessions.push(normalized);
  }

  for (const state of endpointStates.filter((candidate) => candidate.available)) {
    for (const agent of state.snapshot.agents) {
      const identity = agentIdentity(state.endpoint, agent);
      if (claimedAgents.has(identity)) continue;
      const repository = agentRepositories.get(identity);
      if (filterRepository !== undefined && repository?.repo_id !== filterRepository.repo_id) continue;
      const context = repository === undefined ? undefined : contexts.get(repository.repo_id);
      const branch = agentProvenance.get(identity)?.branch ?? null;
      const title = typeof agent.terminal_title_stripped === "string" && agent.terminal_title_stripped !== ""
        ? agent.terminal_title_stripped
        : null;
      const session = {
        session_id: liveRowId(state.endpoint, agent),
        inventory_scoped: true,
        inventory_agent: agent,
        inventory_occupant_id: identity,
        inventory_workspace: state.snapshot.workspaces.find(
          (workspace) => workspace.workspace_id === agent.workspace_id,
        ) ?? null,
        registered: false,
        repo_id: context?.repo_id ?? null,
        root_id: context?.root_id ?? null,
        repo: context?.path ?? null,
        name: agent.name ?? null,
        workspace: agent.workspace_id ?? null,
        pane: agent.pane_id ?? null,
        server: state.endpoint.path,
        branch,
        lane: undefined,
        topic: branch?.startsWith("lane/") ? branch.slice(5) : null,
        role: null,
        brief: null,
        goal: title,
        goal_source: title === null ? null : "terminal-title",
        report: null,
        deadline: null,
        done: false,
        active_after_done: false,
        group: groupFor(branch, context !== undefined),
        runtime_key: runtimeKey(state.endpoint, agent.pane_id),
        stale: false,
      };
      allSessions.push(session);
      visibleSessions.push(session);
    }
  }

  const contextRecords = [...contexts.values()]
    .sort((left, right) => left.root_label.localeCompare(right.root_label) ||
      left.root_id.localeCompare(right.root_id) ||
      left.repository_label.localeCompare(right.repository_label) ||
      left.repo_id.localeCompare(right.repo_id))
    .map(repositoryRecord);
  addDisplaySuffixes(contextRecords);
  const contextsById = new Map(contextRecords.map((record) => [record.repo_id, record]));
  visibleSessions.sort((left, right) => sortSessions(left, right, contextsById));

  const combinedSnapshot = {
    protocol: endpointStates.find((state) => state.available)?.snapshot.protocol,
    version: endpointStates.find((state) => state.available)?.snapshot.version,
    agents: endpointStates.flatMap((state) => state.available ? state.snapshot.agents : []),
    panes: endpointStates.flatMap((state) => state.available ? state.snapshot.panes : []),
    workspaces: endpointStates.flatMap((state) => state.available ? state.snapshot.workspaces : []),
  };
  const messageErrors = [];
  const messageErrorDetails = [];
  for (const state of endpointStates.filter((candidate) => candidate.available)) {
    throwIfAborted();
    const sessions = visibleSessions.filter((session) => session.server === state.endpoint.path);
    if (sessions.length === 0) continue;
    const localRuntime = new Map();
    const startingRuntime = new Map();
    for (const session of sessions) {
      if (session.inventory_agent === null || typeof session.pane !== "string") continue;
      const previous = runtime.get(session.runtime_key);
      startingRuntime.set(session.runtime_key, previous);
      const identity = agentIdentity(state.endpoint, session.inventory_agent);
      if (previous?.inventoryOccupantId === identity) localRuntime.set(session.pane, previous);
    }
    const refreshed = typeof state.client.readPane === "function"
      ? await refreshMessagePreviews({
        registry: sessions,
        snapshot: state.snapshot,
        runtime: localRuntime,
        client: state.client,
        now,
      })
      : { errors: [] };
    throwIfAborted();
    for (const session of sessions) {
      if (session.inventory_agent === null || typeof session.pane !== "string") continue;
      const value = localRuntime.get(session.pane);
      if (value === undefined) continue;
      const identity = agentIdentity(state.endpoint, session.inventory_agent);
      if (typeof value.occupantId === "string" &&
          value.occupantId !== messageOccupantId(session.inventory_agent)) continue;
      const latest = runtime.get(session.runtime_key);
      if (latest !== startingRuntime.get(session.runtime_key) &&
          latest?.inventoryOccupantId !== identity) continue;
      runtime.set(session.runtime_key, {
        ...value,
        ...(latest?.inventoryOccupantId === identity ? {
          tripwire: latest.tripwire,
          observedAt: latest.observedAt,
        } : {}),
        inventoryOccupantId: identity,
      });
    }
    for (const message of refreshed.errors) {
      messageErrors.push(message);
      messageErrorDetails.push({ source: "message", server_id: state.endpoint.server_id, message });
    }
  }

  const gitStates = new Map();
  const reportStates = new Map();
  for (const context of contexts.values()) {
    const sessions = visibleSessions.filter((session) => session.repo_id === context.repo_id);
    for (const [key, value] of collectGitStates(
      context.path,
      context.config.main ?? "main",
      sessions,
      combinedSnapshot,
    )) gitStates.set(key, value);
    for (const [key, value] of collectReportStates(context.path, sessions)) reportStates.set(key, value);
  }

  const availableCount = endpointStates.filter((state) => state.available).length;
  const discoveryCoverage = availableCount === 0
    ? "unavailable"
    : inventory.coverage === "complete" && availableCount === endpointStates.length ? "complete" : "partial";
  const coverageServers = endpointStates.map((state) => ({
    server_id: state.endpoint.server_id,
    labels: state.endpoint.labels,
    current: state.endpoint.current,
    running: state.endpoint.running ?? null,
    available: state.available,
  }));
  const state = {
    sessions: visibleSessions,
    snapshot: combinedSnapshot,
    gitStates,
    reportStates,
    runtime,
    stats,
    exists: anyRegistry,
    errors: [],
    messageErrors,
    connection: availableCount === 0 ? "offline" : `${availableCount} local Herdr server${availableCount === 1 ? "" : "s"}`,
    inventory: {
      scope: scopeFor(filterRepository, includeHistory),
      coverage: {
        repository: filterRepository !== undefined ? "complete" : discoveryCoverage,
        registry: registryPartial ? "partial" : anyRegistry ? "available" : "missing",
        herdr: availableCount > 0 ? "connected" : "unavailable",
        discovery: discoveryCoverage,
        servers: coverageServers,
      },
      repositories: contextRecords,
      errors,
      messageErrors: messageErrorDetails,
    },
  };
  state.rows = joinBoardRows({
    registry: visibleSessions,
    snapshot: combinedSnapshot,
    gitStates,
    reportStates,
    runtime,
    now,
  });
  const fallback = contextRecords[0] ?? {};
  const document = boardSnapshotDocument({
    state,
    repoId: fallback.repo_id ?? null,
    rootId: fallback.root_id ?? null,
    repoRoot: fallback.path ?? null,
    rootLabel: fallback.root_label ?? "unknown",
    repositoryLabel: fallback.repository_label ?? "unknown",
    laneBase: fallback.lane_base ?? null,
    capturedAt: now,
  });
  const subscriptions = endpointStates
    .filter((candidate) => candidate.available)
    .map((candidate) => ({
      endpoint: candidate.endpoint,
      subscriptions: buildSubscriptions(
        allSessions.filter((session) => session.server === candidate.endpoint.path),
        candidate.snapshot,
      ),
    }));
  const occupants = new Map();
  const tripwires = new Map();
  const rowsByPane = new Map();
  for (const session of allSessions) {
    if (session.inventory_agent === null || typeof session.pane !== "string" ||
        typeof session.server !== "string") continue;
    const state = endpointStates.find((item) => item.endpoint.path === session.server);
    if (state === undefined || !state.available) continue;
    const key = runtimeKey(state.endpoint, session.pane);
    const identity = agentIdentity(state.endpoint, session.inventory_agent);
    occupants.set(key, identity);
    if (session.registered && (session.tripwires ?? []).length > 0) {
      tripwires.set(key, { identity, row_id: session.session_id, patterns: session.tripwires });
    }
  }
  for (const session of visibleSessions) {
    if (session.inventory_agent === null || typeof session.pane !== "string" ||
        typeof session.server !== "string") continue;
    const state = endpointStates.find((item) => item.endpoint.path === session.server);
    if (state?.available) rowsByPane.set(runtimeKey(state.endpoint, session.pane), session.session_id);
  }
  return { document, subscriptions, occupants, tripwires, rowsByPane };
  } finally {
    signal?.removeEventListener("abort", abort);
    abort();
  }
}

export async function collectMachineBoardDocument(options) {
  return (await collectMachineBoardObservation(options)).document;
}
