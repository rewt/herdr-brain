#!/usr/bin/env node
// herdr-lanes — isolated task lanes for coding agents: a thin layer over git
// worktrees with optional Herdr workspaces and sessions.
//
// Lifecycle: open -> (dispatch) -> work -> promote -> close.
//
// Promotion is always the same move: clean worktree, branch rebased onto the
// current main branch, deterministic validation green, then a fast-forward-only
// merge into local main. No merge commits, no push, no policy gates —
// deterministic tests decide acceptance and git truth decides everything
// else. Configuration is layered from parent and repository .lane.json files
// (see README).

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { constants as osConstants, homedir, hostname, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  loadRegistry,
  markSessionDone,
  markTopicSessionsDone,
  newSessionId,
  registryDirectoryFor,
  registryPathFor,
  writeSessionRecord,
} from "./board/registry.mjs";
import {
  applyHerdrEvent,
  boardSnapshotDocument,
  buildSubscriptions,
  collectBoardState,
  joinBoardRows,
  matchingTripwire,
  renderPlainBoard,
} from "./board/board.mjs";
import { verifyCanonicalSession, verifyFocusSelection } from "./board/actions.mjs";
import { HerdrClient, herdrSocketPath } from "./board/herdr-client.mjs";
import { collectMachineBoardObservation } from "./board/inventory.mjs";
import { refreshMessagePreviews } from "./board/message-preview.mjs";
import { renderMachineBoardPlain } from "./board/view.mjs";

const IS_REVIEW_COMMAND = process.argv[2] === "review";
const CALLER_CWD = process.cwd();
const BOARD_USAGE = "usage: lane board [--once | --json | --watch --json | focus <row-id> | done <row-id>] [--repo <path>] [--all]";
let stopBoardObservation;

function parseBoardArguments(args) {
  const seen = new Set();
  let repo;
  let action;
  let rowId;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "focus" || argument === "done") {
      if (action !== undefined || seen.size > 0) throw new Error(BOARD_USAGE);
      action = argument;
      continue;
    }
    if (action !== undefined && rowId === undefined && !argument.startsWith("--")) {
      rowId = argument;
      continue;
    }
    if (!["--once", "--json", "--watch", "--repo", "--all"].includes(argument)) {
      if (!argument.startsWith("--")) throw new Error(BOARD_USAGE);
      throw new Error(`${BOARD_USAGE} (unknown option or operand: ${argument})`);
    }
    if (seen.has(argument)) {
      if (action !== undefined) throw new Error(BOARD_USAGE);
      throw new Error(`${BOARD_USAGE} (duplicate option: ${argument})`);
    }
    seen.add(argument);
    if (argument === "--repo") {
      const value = args[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        if (action !== undefined) throw new Error(BOARD_USAGE);
        throw new Error(`${BOARD_USAGE} (--repo requires a path)`);
      }
      repo = value;
      index += 1;
    }
  }
  const once = seen.has("--once");
  const json = seen.has("--json");
  const watch = seen.has("--watch");
  const all = seen.has("--all");
  if (action !== undefined) {
    if (rowId === undefined || once || json || watch || all) throw new Error(BOARD_USAGE);
    return {
      mode: action,
      rowId,
      repo: repo === undefined ? undefined : resolve(CALLER_CWD, repo),
    };
  }
  if ((once && json) || (once && watch) || (watch && !json)) {
    throw new Error(`${BOARD_USAGE} (contradictory output modes)`);
  }
  return {
    mode: once ? "plain" : watch ? "watch-json" : json ? "json" : "interactive",
    repo: repo === undefined ? undefined : resolve(CALLER_CWD, repo),
    includeHistory: all,
  };
}

const EARLY_BOARD_OPTIONS = (() => {
  if (process.argv[2] !== "board") return undefined;
  try {
    return parseBoardArguments(process.argv.slice(3));
  } catch (error) {
    process.stderr.write(`lane: ${error.message}\n`);
    process.exit(1);
  }
})();

// Unix readers such as `head` routinely close a pipeline before the producer
// is finished. Treat that as successful early consumption, not a crash.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") {
    if (stopBoardObservation !== undefined) {
      stopBoardObservation();
      return;
    }
    process.exit(IS_REVIEW_COMMAND ? 2 : 0);
  }
  throw error;
});

const BOARD_MACHINE_READ = EARLY_BOARD_OPTIONS !== undefined &&
  ["plain", "json", "watch-json"].includes(EARLY_BOARD_OPTIONS.mode) &&
  EARLY_BOARD_OPTIONS.repo === undefined;

// The repository is whichever checkout the command runs in (any worktree of it).
// Machine board reads may start outside Git; every other command keeps the
// repository requirement.
const REPO = (() => {
  try {
    const start = EARLY_BOARD_OPTIONS?.repo ?? CALLER_CWD;
    return realpathSync(execFileSync("git", ["-C", start, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim());
  } catch (error) {
    if (BOARD_MACHINE_READ) return undefined;
    process.stderr.write(`${IS_REVIEW_COMMAND ? "lane review" : "lane"}: not inside a git repository\n`);
    const gitStderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const ordinaryNotRepository = /^fatal: not a git repository \(or any of the parent directories\): \.git$/u
      .test(gitStderr);
    if (gitStderr !== "" && !ordinaryNotRepository) {
      process.stderr.write(`${gitStderr}\n`);
    }
    process.exit(IS_REVIEW_COMMAND ? 2 : 1);
  }
})();
const REPO_IDENTITY = (() => {
  if (REPO === undefined) return undefined;
  try {
    const common = execFileSync("git", ["-C", REPO, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    return realpathSync(common);
  } catch {
    fail(`cannot resolve canonical git common directory for ${REPO}`);
  }
})();
const CURRENT_GIT_DIRECTORY = (() => {
  if (REPO === undefined) return undefined;
  try {
    const directory = execFileSync("git", ["-C", REPO, "rev-parse", "--path-format=absolute", "--git-dir"], { encoding: "utf8" }).trim();
    return realpathSync(directory);
  } catch {
    fail(`cannot resolve git directory for ${REPO}`);
  }
})();

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const canonical = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return canonical(left) === canonical(right);
}

function candidateIsCanonicalCheckout(path) {
  try {
    const checkout = realpathSync(execFileSync(
      "git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8" },
    ).trim());
    const common = realpathSync(execFileSync(
      "git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" },
    ).trim());
    const gitDirectory = realpathSync(execFileSync(
      "git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-dir"], { encoding: "utf8" },
    ).trim());
    return checkout === realpathSync(path) && common === REPO_IDENTITY && gitDirectory === REPO_IDENTITY;
  } catch {
    return false;
  }
}

// The checkout this script runs from may itself be a lane worktree. Resolve
// the primary checkout whose git directory is the common directory so every
// Herdr child is attached to the repository workspace, not the caller lane.
// Keep the missing-primary case non-fatal until an operation needs to mutate
// the repository; read-only commands can still inspect a bare-plus-linked
// layout from the invoking checkout.
let canonicalCheckoutResolved = false;
let canonicalCheckout;
function repositoryRoot({ requiredBy } = {}) {
  if (REPO === undefined) {
    if (requiredBy !== undefined) fail(`${requiredBy} requires --repo when started outside a Git repository`);
    return undefined;
  }
  if (canonicalCheckoutResolved) {
    if (canonicalCheckout === undefined && requiredBy !== undefined) {
      fail(`cannot resolve canonical non-linked checkout for git common directory ${REPO_IDENTITY}; ${requiredBy} requires a canonical checkout`);
    }
    return canonicalCheckout ?? REPO;
  }
  canonicalCheckoutResolved = true;
  if (CURRENT_GIT_DIRECTORY === REPO_IDENTITY) {
    canonicalCheckout = REPO;
    return canonicalCheckout;
  }
  let listed;
  try {
    listed = execFileSync(
      "git", ["-C", REPO, "worktree", "list", "--porcelain"],
      { encoding: "utf8" },
    );
  } catch {
    if (requiredBy !== undefined) {
      fail(`cannot list worktrees for canonical git common directory ${REPO_IDENTITY}; ${requiredBy} requires a canonical checkout`);
    }
    return REPO;
  }
  for (const entry of listed.split("\n\n")) {
    const line = entry.split("\n").find((value) => value.startsWith("worktree "));
    if (line === undefined) continue;
    const candidate = line.slice("worktree ".length);
    if (!samePath(candidate, REPO_IDENTITY) && candidateIsCanonicalCheckout(candidate)) {
      canonicalCheckout = realpathSync(candidate);
      return canonicalCheckout;
    }
  }
  if (requiredBy !== undefined) {
    fail(`cannot resolve canonical non-linked checkout for git common directory ${REPO_IDENTITY}; ${requiredBy} requires a canonical checkout`);
  }
  return REPO;
}

const REPO_ROOT = repositoryRoot();
// Configuration comes from the nearest eligible parent .lane.json followed by
// the canonical checkout's .lane.json. $LANE_CONFIG selects exactly one file.
// Every key is optional.
//   main      integration branch (default "main")
//   validate  shell command that must exit 0 before a fast-forward
//             (default "npm test"; $LANE_VALIDATE overrides at run time)
//   prepare   shell commands run in a fresh worktree before validation —
//             a worktree carries no gitignored state (no node_modules, no
//             built dist), so validation fails there for environmental
//             reasons that look like real failures. Each entry is
//             {"unless": "<path that proves the step is done>", "run": "<cmd>"}.
//   dispatch  {"kind", "model", "env": ["K=V"], "args": [...]} — global
//             defaults for dispatching a herdr agent session.
//   routes    {"name": {"kind", "model", "env": ["K=V"], "args": [...],
//             "use": "when to select it"}} — named dispatch defaults;
//             kind/model/args override dispatch, while env is appended. CLI
//             flags take final precedence; use is descriptive only.
//   registry  JSON session-registry path for `board` (default
//             ".lane/sessions.json", relative to the repository root)
//   seams_doc path of a topic map for kept unfinished work, shown by `seams`
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(config, key, file) {
  if (Object.hasOwn(config, key) && typeof config[key] !== "string") {
    fail(`invalid lane config ${file}: ${key} must be a string`);
  }
}

function requireStringArray(config, key, label, file) {
  if (!Object.hasOwn(config, key)) return;
  if (!Array.isArray(config[key]) || config[key].some((value) => typeof value !== "string")) {
    fail(`invalid lane config ${file}: ${label}.${key} must be an array of strings`);
  }
}

function validateDispatch(config, label, file, { route = false } = {}) {
  if (!isRecord(config)) fail(`invalid lane config ${file}: ${label} must be an object`);
  for (const key of ["kind", "model", ...(route ? ["use"] : [])]) {
    if (Object.hasOwn(config, key) && typeof config[key] !== "string") {
      fail(`invalid lane config ${file}: ${label}.${key} must be a string`);
    }
  }
  requireStringArray(config, "env", label, file);
  requireStringArray(config, "args", label, file);
}

function validateConfig(config, file) {
  if (!isRecord(config)) fail(`invalid lane config ${file}: top level must be an object`);
  for (const key of ["main", "validate", "registry", "seams_doc", "worktree_root"]) {
    requireString(config, key, file);
  }
  if (Object.hasOwn(config, "prepare")) {
    if (!Array.isArray(config.prepare)) {
      fail(`invalid lane config ${file}: prepare must be an array`);
    }
    for (const [index, step] of config.prepare.entries()) {
      if (!isRecord(step) || typeof step.run !== "string" ||
          (Object.hasOwn(step, "unless") && typeof step.unless !== "string")) {
        fail(`invalid lane config ${file}: prepare[${index}] must have string run and optional string unless`);
      }
    }
  }
  if (Object.hasOwn(config, "dispatch")) validateDispatch(config.dispatch, "dispatch", file);
  if (Object.hasOwn(config, "routes")) {
    if (!isRecord(config.routes)) fail(`invalid lane config ${file}: routes must be an object`);
    for (const [name, route] of Object.entries(config.routes)) {
      validateDispatch(route, `routes.${name}`, file, { route: true });
    }
  }
}

function readConfig(file, { required = false } = {}) {
  if (!required && !existsSync(file)) return undefined;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(`cannot read lane config ${file}: ${error.message}`);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    fail(`invalid lane config ${file}: ${error.message}`);
  }
  validateConfig(config, file);
  return config;
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
    if (boundedByHome && !within(directory, home)) break;
    if (boundedByHome && directory === home) break;
    const candidate = join(directory, ".lane.json");
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  return undefined;
}

const EXPLICIT_CONFIG = process.env.LANE_CONFIG !== undefined;
if (EXPLICIT_CONFIG && REPO_ROOT === undefined) {
  fail("LANE_CONFIG cannot anchor a machine board outside Git; supply --repo");
}
const REPOSITORY_CONFIG_FILE = REPO_ROOT === undefined ? undefined : join(REPO_ROOT, ".lane.json");
const PARENT_CONFIG_FILE = EXPLICIT_CONFIG || REPO_ROOT === undefined ? undefined : nearestParentConfig(REPO_ROOT);
const CONFIG_LAYERS = (() => {
  if (EXPLICIT_CONFIG) {
    const file = resolve(CALLER_CWD, process.env.LANE_CONFIG);
    return [{ file, config: readConfig(file, { required: true }) }];
  }
  const layers = [];
  if (PARENT_CONFIG_FILE !== undefined) {
    layers.push({ file: PARENT_CONFIG_FILE, config: readConfig(PARENT_CONFIG_FILE, { required: true }) });
  }
  const repository = REPOSITORY_CONFIG_FILE === undefined ? undefined : readConfig(REPOSITORY_CONFIG_FILE);
  if (repository !== undefined) layers.push({ file: REPOSITORY_CONFIG_FILE, config: repository });
  return layers;
})();
const { config: CONFIG, sources: CONFIG_SOURCES, routeSources: ROUTE_SOURCES } = (() => {
  const config = {};
  const sources = new Map();
  const routeSources = new Map();
  for (const layer of CONFIG_LAYERS) {
    for (const [key, value] of Object.entries(layer.config)) {
      if (key === "routes") {
        config.routes = { ...(config.routes ?? {}), ...value };
        for (const name of Object.keys(value)) routeSources.set(name, layer.file);
      } else {
        config[key] = value;
        sources.set(key, layer.file);
      }
    }
  }
  return { config, sources, routeSources };
})();
const MAIN = CONFIG.main ?? "main";
const LANE_PREFIX = "lane/";
const REPO_NAME = REPO_ROOT === undefined ? undefined : basename(REPO_ROOT);
const ROOT_IDENTITY = REPO_ROOT === undefined
  ? undefined
  : realpathSync(PARENT_CONFIG_FILE === undefined ? dirname(REPO_ROOT) : dirname(PARENT_CONFIG_FILE));
const { path: WORKTREE_ROOT, base: WORKTREE_BASE, source: WORKTREE_ROOT_SOURCE } = (() => {
  if (REPO_ROOT === undefined) return { path: undefined, base: undefined, source: "default" };
  if (process.env.LANE_WORKTREE_ROOT !== undefined) {
    const path = resolve(CALLER_CWD, process.env.LANE_WORKTREE_ROOT);
    return { path, base: path, source: "env" };
  }
  if (Object.hasOwn(CONFIG, "worktree_root")) {
    const source = CONFIG_SOURCES.get("worktree_root");
    const base = resolve(dirname(source), CONFIG.worktree_root);
    return { path: join(base, REPO_NAME), base, source };
  }
  if (!EXPLICIT_CONFIG && PARENT_CONFIG_FILE !== undefined) {
    const base = join(dirname(PARENT_CONFIG_FILE), ".worktrees");
    return {
      path: join(base, REPO_NAME),
      base,
      source: PARENT_CONFIG_FILE,
    };
  }
  const base = join(homedir(), ".herdr", "worktrees");
  return {
    path: join(base, REPO_NAME),
    base,
    source: "default",
  };
})();
const DEFAULT_VALIDATE = CONFIG.validate ?? "npm test";
const TOOL_ROOT = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  process.stderr.write(`${IS_REVIEW_COMMAND ? "lane review" : "lane"}: ${message}\n`);
  process.exit(IS_REVIEW_COMMAND ? 2 : 1);
}

function configuredRoutes() {
  return CONFIG.routes !== null && typeof CONFIG.routes === "object" && !Array.isArray(CONFIG.routes)
    ? CONFIG.routes
    : {};
}

function routeNames() {
  return Object.keys(configuredRoutes()).sort();
}

function resolveDispatch(options = {}) {
  const defaults = CONFIG.dispatch ?? {};
  let route = {};
  if (options.route !== undefined) {
    const routes = configuredRoutes();
    if (!Object.hasOwn(routes, options.route)) {
      const names = routeNames();
      fail(`unknown route: ${options.route} (${names.length > 0 ? `configured: ${names.join(", ")}` : "none configured"})`);
    }
    route = routes[options.route] ?? {};
  }
  return {
    kind: options.kind ?? route.kind ?? defaults.kind ?? "claude",
    model: options.model ?? route.model ?? defaults.model,
    args: options.args?.length > 0 ? options.args : (route.args ?? defaults.args ?? []),
    env: [...(defaults.env ?? []), ...(route.env ?? []), ...(options.env ?? [])],
    use: route.use,
  };
}

function routes() {
  const names = routeNames();
  if (names.length === 0) fail("no routes configured");
  for (const name of names) {
    const resolved = resolveDispatch({ route: name });
    process.stdout.write(
      `${name}\tkind=${resolved.kind}\tmodel=${resolved.model ?? "(none)"}\targs=${JSON.stringify(resolved.args)}` +
        `\tuse=${resolved.use ?? "(none)"}\n`,
    );
  }
}

function config() {
  const rows = [
    ["dispatch", CONFIG.dispatch ?? {}, CONFIG_SOURCES.get("dispatch") ?? "default"],
    ["main", MAIN, CONFIG_SOURCES.get("main") ?? "default"],
    ["prepare", CONFIG.prepare ?? [], CONFIG_SOURCES.get("prepare") ?? "default"],
    ["registry", CONFIG.registry ?? ".lane/sessions.json", CONFIG_SOURCES.get("registry") ?? "default"],
    ["seams_doc", CONFIG.seams_doc ?? null, CONFIG_SOURCES.get("seams_doc") ?? "default"],
    [
      "validate",
      process.env.LANE_VALIDATE ?? DEFAULT_VALIDATE,
      process.env.LANE_VALIDATE !== undefined ? "env" : (CONFIG_SOURCES.get("validate") ?? "default"),
    ],
    ["worktree_root", WORKTREE_ROOT, WORKTREE_ROOT_SOURCE],
  ];
  for (const name of routeNames()) {
    rows.push([`routes.${name}`, configuredRoutes()[name], ROUTE_SOURCES.get(name)]);
  }
  rows.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [key, value, source] of rows) {
    const escapedKey = key.replace(/[\\\t\r\n]/gu, (character) => ({
      "\\": "\\\\",
      "\t": "\\t",
      "\r": "\\r",
      "\n": "\\n",
    })[character]);
    process.stdout.write(`${escapedKey}\t${JSON.stringify(value)}\t${source}\n`);
  }
}

function git(args, options = {}) {
  const stdio = options.silent ? ["ignore", "pipe", "pipe"] : undefined;
  return execFileSync("git", ["-C", options.cwd ?? REPO, ...args], {
    encoding: "utf8",
    ...(stdio === undefined ? {} : { stdio }),
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

function worktreeEntries() {
  return git(["worktree", "list", "--porcelain"])
    .split("\n\n")
    .map((entry) => {
      const fields = new Map(entry.split("\n").filter(Boolean).map((line) => {
        const separator = line.indexOf(" ");
        return separator === -1 ? [line, true] : [line.slice(0, separator), line.slice(separator + 1)];
      }));
      return {
        path: fields.get("worktree"),
        branch: typeof fields.get("branch") === "string"
          ? fields.get("branch").replace(/^refs\/heads\//u, "")
          : undefined,
      };
    })
    .filter((entry) => typeof entry.path === "string");
}

function gitIdentityForPath(path) {
  try {
    const common = execFileSync(
      "git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return realpathSync(common);
  } catch {
    return undefined;
  }
}

function verifyRegisteredWorktree(path, branch) {
  if (!entryExists(path)) {
    fail(`registered worktree ${path} for ${branch} is missing; run git worktree prune`);
  }
  const identity = gitIdentityForPath(path);
  if (identity !== REPO_IDENTITY) {
    fail(`registered worktree ${path} for ${branch} does not belong to canonical git common directory ${REPO_IDENTITY}`);
  }
  const actual = tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path });
  if (actual !== branch) {
    fail(`registered worktree ${path} has branch ${actual ?? "(detached)"}, expected ${branch}`);
  }
  return path;
}

function worktreeFor(branch) {
  for (const entry of worktreeEntries()) {
    if (entry.branch === branch) return verifyRegisteredWorktree(entry.path, branch);
  }
  return undefined;
}

function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function futureRealPath(path) {
  const suffix = [];
  let ancestor = resolve(path);
  while (!entryExists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) fail(`unsafe worktree path has no resolvable ancestor: ${path}`);
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  let realAncestor;
  try {
    realAncestor = realpathSync(ancestor);
  } catch (error) {
    fail(`unsafe worktree path cannot resolve ${ancestor}: ${error.message}`);
  }
  return { path: resolve(realAncestor, ...suffix), ancestor: realAncestor };
}

function futureRegistryRealPath(path) {
  const suffix = [];
  let ancestor = resolve(path);
  while (!entryExists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`session registry path has no resolvable ancestor: ${path}`);
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  try {
    return resolve(realpathSync(ancestor), ...suffix);
  } catch (error) {
    throw new Error(`session registry path cannot resolve ${ancestor}: ${error.message}`);
  }
}

function assertNoRegistrySymlink(path) {
  const offset = relative(REPO_ROOT, path);
  let cursor = REPO_ROOT;
  for (const part of offset.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!entryExists(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(
        `registry path uses a symlink: ${cursor}; replace the symlinked component with a real repository-local path`,
      );
    }
  }
}

function registryIgnored(path) {
  return spawnSync("git", ["-C", REPO_ROOT, "check-ignore", "--quiet", "--no-index", "--", relative(REPO_ROOT, path)], {
    stdio: "ignore",
  }).status === 0;
}

class RegistryPolicyError extends Error {}

function preflightRegistryAutomation({ create = true } = {}) {
  const path = registryPathFor(REPO_ROOT, CONFIG);
  const directory = registryDirectoryFor(path);
  const resolvedPath = futureRegistryRealPath(path);
  const resolvedDirectory = futureRegistryRealPath(directory);
  if (!within(resolvedPath, REPO_ROOT) || !within(resolvedDirectory, REPO_ROOT)) {
    throw new RegistryPolicyError("automated session metadata requires a repository-local registry; configure registry inside the canonical checkout");
  }
  assertNoRegistrySymlink(path);
  assertNoRegistrySymlink(directory);
  const registryRelative = relative(REPO_ROOT, path);
  const directoryRelative = relative(REPO_ROOT, directory);
  const tracked = git(["ls-files", "--", registryRelative, `${directoryRelative}/`], { cwd: REPO_ROOT });
  if (tracked !== "") {
    throw new RegistryPolicyError(`session registry is tracked (${tracked.split("\n")[0]}); remove it from git and keep it as local display metadata`);
  }
  if (!registryIgnored(path) || !registryIgnored(directory) || !registryIgnored(join(directory, ".write-probe"))) {
    throw new RegistryPolicyError(
      `session registry must be gitignored before dispatch; add ${registryRelative} and ${directoryRelative}/ to .gitignore or configure another repository-local ignored registry`,
    );
  }
  if (existsSync(path)) loadRegistry(REPO_ROOT, CONFIG);
  if (!create) return path;
  try {
    mkdirSync(directory, { recursive: true });
    if (!lstatSync(directory).isDirectory()) throw new Error("sidecar path is not a directory");
    const probe = join(directory, `.write-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
  } catch (error) {
    throw new Error(
      `session registry sidecar directory is not writable: ${error.message}; ` +
      "make the sidecar directory writable or configure another ignored repository-local registry",
    );
  }
  return path;
}

function repositoryContaining(path) {
  try {
    const root = execFileSync(
      "git", ["-C", path, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return { root: realpathSync(root), identity: gitIdentityForPath(path) };
  } catch {
    return undefined;
  }
}

function assertSafeNewWorktreePath(path) {
  const selectedBase = futureRealPath(WORKTREE_BASE).path;
  const repositoryRoot = futureRealPath(WORKTREE_ROOT).path;
  const destination = futureRealPath(path);
  if (!within(repositoryRoot, selectedBase) || !within(destination.path, selectedBase)) {
    fail(`unsafe worktree path resolves outside selected base ${selectedBase}: ${path} -> ${destination.path}`);
  }

  for (const entry of worktreeEntries()) {
    let checkout;
    try {
      checkout = realpathSync(entry.path);
    } catch {
      continue;
    }
    if (within(destination.path, checkout)) {
      const kind = samePath(checkout, REPO_ROOT) ? "canonical checkout" : "registered checkout";
      fail(`unsafe worktree path is inside the ${kind} ${checkout}: ${path}`);
    }
  }

  if (entryExists(path)) {
    const occupant = gitIdentityForPath(path);
    if (occupant !== undefined && occupant !== REPO_IDENTITY) {
      fail(`worktree path belongs to another repository: ${path}; choose distinct worktree bases`);
    }
    fail(`worktree path already exists: ${path}`);
  }

  const containing = repositoryContaining(destination.ancestor);
  if (containing !== undefined && containing.identity !== REPO_IDENTITY && within(destination.path, containing.root)) {
    fail(`unsafe worktree path is inside another repository ${containing.root}: ${path}`);
  }
}

function assertCreatedWorktree(path, branch) {
  const destination = futureRealPath(path).path;
  assertSafeNewWorktreePathAfterCreation(destination);
  const identity = gitIdentityForPath(destination);
  if (identity !== REPO_IDENTITY) {
    fail(`created worktree ${destination} does not belong to canonical git common directory ${REPO_IDENTITY}`);
  }
  const actual = tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: destination });
  if (actual !== branch) fail(`created worktree ${destination} has branch ${actual ?? "(detached)"}, expected ${branch}`);
}

function assertSafeNewWorktreePathAfterCreation(path) {
  const selectedBase = futureRealPath(WORKTREE_BASE).path;
  if (!within(path, selectedBase)) {
    fail(`unsafe worktree path resolves outside selected base ${selectedBase}: ${path}`);
  }
  for (const entry of worktreeEntries()) {
    if (samePath(entry.path, path)) continue;
    let checkout;
    try {
      checkout = realpathSync(entry.path);
    } catch {
      continue;
    }
    if (within(path, checkout)) {
      const kind = samePath(checkout, REPO_ROOT) ? "canonical checkout" : "registered checkout";
      fail(`unsafe worktree path is inside the ${kind} ${checkout}: ${path}`);
    }
  }
}

// herdr helpers. Every herdr CLI call prints one JSON document; a failure is a
// missing server, a refusal, or malformed output, and callers decide whether
// that is fatal.
function herdrJson(args, { deadline } = {}) {
  const run = spawnSync("herdr", args, {
    encoding: "utf8",
    ...(deadline === undefined ? {} : { timeout: Math.max(1, deadline - Date.now()) }),
  });
  if (run.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(run.stdout);
    return parsed.error === undefined ? parsed.result : undefined;
  } catch {
    return undefined;
  }
}

function workspaceMatches(workspace, path, linked) {
  const worktree = workspace?.worktree;
  return worktree !== undefined &&
    samePath(worktree.repo_key, REPO_IDENTITY) &&
    samePath(worktree.repo_root, REPO_ROOT) &&
    samePath(worktree.checkout_path, path) &&
    worktree.is_linked_worktree === linked;
}

function parentWorkspaceId(workspaces) {
  return workspaces?.find((workspace) => workspaceMatches(workspace, REPO_ROOT, false))?.workspace_id;
}

function openWorkspaceIdFor(path, { refuseStale = true, onMismatch, workspaces, deadline } = {}) {
  const mismatch = (message) => {
    if (refuseStale) fail(message);
    onMismatch?.();
    return undefined;
  };
  const listed = herdrJson(["worktree", "list", "--cwd", REPO_ROOT], { deadline });
  if (listed === undefined) return undefined;
  if (!samePath(listed.source?.repo_key, REPO_IDENTITY) ||
      !samePath(listed.source?.repo_root, REPO_ROOT) ||
      !samePath(listed.source?.source_checkout_path, REPO_ROOT)) {
    return mismatch(`Herdr worktree source has a repository identity mismatch for ${REPO_ROOT}`);
  }
  const item = listed.worktrees.find((worktree) => samePath(worktree.path, path));
  if (item?.open_workspace_id === undefined) return undefined;
  const availableWorkspaces = workspaces ?? herdrJson(["workspace", "list"], { deadline })?.workspaces;
  const workspace = availableWorkspaces?.find((entry) => entry.workspace_id === item.open_workspace_id);
  if (!workspaceMatches(workspace, path, true)) {
    return mismatch(`Herdr workspace ${item.open_workspace_id} for ${path} has a repository identity mismatch; refusing stale metadata`);
  }
  return item.open_workspace_id;
}

// herdr refuses `worktree create`/`open` when the CLI runs inside a linked
// worktree ("New and open worktree actions start from the repo parent
// workspace"), so a lane opened from another lane gets a git worktree and no
// herdr workspace. Repair that by opening from the parent workspace explicitly,
// retaining opaque IDs and verifying the returned path and repository identity.
function ensureHerdrWorkspace(path, label, workspaces, deadline) {
  // Worktree creation/opening and workspace discovery are separate Herdr
  // snapshots. Refetch here so newly visible metadata is never judged against
  // the caller's pre-creation listing.
  let id = openWorkspaceIdFor(path, { deadline });
  if (id !== undefined) return id;
  const parent = parentWorkspaceId(workspaces);
  if (parent === undefined) return undefined;
  herdrJson(["worktree", "open", "--workspace", parent, "--path", path, "--label", label, "--no-focus"], { deadline });
  const refreshed = herdrJson(["workspace", "list"], { deadline })?.workspaces;
  return openWorkspaceIdFor(path, { workspaces: refreshed, deadline });
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

function codePointLength(value) {
  return [...value].length;
}

function graphemeFragment(value, budget) {
  if (codePointLength(value) <= budget) return value;
  let fragment = "";
  let used = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const length = codePointLength(segment);
    if (used + length > budget - 1) break;
    fragment += segment;
    used += length;
  }
  return `${fragment}…`;
}

function laneIdentityDigest(topic, length = 8) {
  return createHash("sha256")
    .update(`${ROOT_IDENTITY}\0${REPO_IDENTITY}\0${topic}`)
    .digest("hex")
    .slice(0, length);
}

function compactWorkspaceLabel(topic, digestLength) {
  let reduction = digestLength - 8;
  const budgets = { root: 12, repository: 16, topic: 20 };
  for (const key of ["topic", "repository", "root"]) {
    const amount = Math.min(reduction, budgets[key] - 4);
    budgets[key] -= amount;
    reduction -= amount;
  }
  return `${graphemeFragment(basename(ROOT_IDENTITY), budgets.root)}/` +
    `${graphemeFragment(REPO_NAME, budgets.repository)}:lane-${graphemeFragment(topic, budgets.topic)}` +
    `~${laneIdentityDigest(topic, digestLength)}`;
}

function workspaceLabel(topic, path, workspaces = []) {
  const readable = `${basename(ROOT_IDENTITY)}/${REPO_NAME}:lane-${topic}`;
  const collides = (label) => workspaces.some((workspace) =>
    workspace.label === label && !workspaceMatches(workspace, path, true));
  if (codePointLength(readable) <= 64 && !collides(readable)) return readable;
  for (let digestLength = 8; digestLength <= 44; digestLength += 1) {
    const label = compactWorkspaceLabel(topic, digestLength);
    if (codePointLength(label) <= 64 && !collides(label)) return label;
  }
  fail(`cannot produce a unique Herdr workspace label for ${path}`);
}

function newAgentName(topic, reserved = new Set()) {
  const identity = laneIdentityDigest(topic, 6);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const random = randomBytes(3).toString("hex");
    const available = 32 - identity.length - random.length - 2;
    const stem = `lane-${topic}`.slice(0, available);
    const name = `${stem}-${identity}-${random}`;
    if (!reserved.has(name)) return name;
  }
  fail(`cannot produce a unique Herdr agent name for ${topic}`);
}

function agentRecord(agentName, deadline) {
  const listed = herdrJson(["agent", "list"], { deadline });
  return listed?.agents?.find((a) => a.name === agentName);
}

function agentOnPane(pane, deadline) {
  const listed = herdrJson(["agent", "list"], { deadline });
  return listed?.agents?.find((a) => a.pane_id === pane);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// `herdr agent start` inherits whatever directory the pane's shell is in at
// that instant; started during shell init the agent lands in the wrong
// directory and runs its brief there. Refuse to prompt unless herdr reports
// the agent's cwd as the lane worktree.
function verifyAgentCwd(agentName, path, deadline) {
  const record = agentRecord(agentName, deadline);
  if (record === undefined) return { ok: false, cwd: undefined, record: undefined };
  return { ok: samePath(record.cwd, path), cwd: record.cwd, record };
}

// Dry-run a rebase of `branch` onto `against` with merge-tree (no worktree
// touched). Conflicts are returned by file so the implementer sees them.
function rebaseCheck(branch, against = MAIN) {
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
  return git(["diff", "--name-only", `${MAIN}...${branch}`]).split("\n").filter((f) => f !== "");
}

function requireClean(path, what) {
  if (git(["status", "--porcelain=v1"], { cwd: path }) !== "") {
    fail(`${what} is not clean (${path}); commit or stash first`);
  }
}

function open(topic, base = MAIN) {
  repositoryRoot({ requiredBy: "open" });
  const branch = laneBranch(topic);
  if (branchExists(branch)) fail(`branch ${branch} already exists; use status/promote/close`);
  if (tryGit(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === undefined) {
    fail(`base ref does not resolve: ${base}`);
  }
  const path = join(WORKTREE_ROOT, `lane-${topic}`);
  assertSafeNewWorktreePath(path);
  let workspaces = herdrJson(["workspace", "list"])?.workspaces ?? [];
  const label = workspaceLabel(topic, path, workspaces);
  const parent = parentWorkspaceId(workspaces);
  const herdr = spawnSync(
    "herdr",
    [
      "worktree", "create",
      ...(parent === undefined ? ["--cwd", REPO_ROOT] : ["--workspace", parent]),
      "--branch", branch, "--base", base, "--path", path, "--label", label,
    ],
    { encoding: "utf8" },
  );
  if (herdr.status !== 0 || !existsSync(path)) {
    git(["worktree", "add", "-b", branch, path, base]);
    process.stdout.write("(herdr refused or is unavailable; created via git worktree)\n");
  } else {
    workspaces = herdrJson(["workspace", "list"])?.workspaces ?? [];
  }
  assertCreatedWorktree(path, branch);
  const workspaceId = ensureHerdrWorkspace(path, label, workspaces);
  process.stdout.write(
    `lane open: ${branch}\n` +
    `  worktree: ${path}\n` +
    `  canonical checkout: ${REPO_ROOT}\n` +
    `  repository identity: ${REPO_IDENTITY}\n` +
    `  root identity: ${ROOT_IDENTITY}\n` +
    `  workspace label: ${label}\n` +
    `  base: ${git(["rev-parse", "--short", base])} (${base})\n`,
  );
  process.stdout.write(
    workspaceId === undefined
      ? "  herdr workspace: none (herdr unavailable); dispatch will retry the repair\n"
      : `  herdr workspace: ${workspaceId}\n`,
  );
  if (base !== MAIN) {
    process.stdout.write(`Resumed from a non-${MAIN} base: rebase onto ${MAIN} before promoting (promote enforces it).\n`);
  }
  process.stdout.write("Sessions started in the worktree see the repository's own agent instructions (AGENTS.md / CLAUDE.md) as any checkout would.\n");
}

function status() {
  const mainHead = git(["rev-parse", MAIN]);
  process.stdout.write(`${MAIN} ${mainHead.slice(0, 7)}\n`);
  const branches = git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${LANE_PREFIX}`])
    .split("\n")
    .filter((b) => b !== "");
  if (branches.length === 0) {
    process.stdout.write("no open lanes\n");
    return;
  }
  for (const branch of branches) {
    const [ahead, behind] = git(["rev-list", "--left-right", "--count", `${branch}...${MAIN}`])
      .split("\t");
    const path = worktreeFor(branch);
    const dirty = path !== undefined && git(["status", "--porcelain=v1"], { cwd: path }) !== "";
    const check = rebaseCheck(branch);
    const rebase = ahead === "0" ? "" : behind === "0" ? "  rebase: current" : check.clean ? "  rebase: clean" : `  rebase: CONFLICT ${check.conflicts.join(",")}`;
    process.stdout.write(
      `${branch}  +${ahead}/-${behind} vs ${MAIN}  ${path ?? "(no worktree)"}${dirty ? "  DIRTY" : ""}${rebase}\n`,
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
    git(["branch", "--no-merged", MAIN,
      "--format=%(refname:short)\t%(objectname:short)\t%(contents:subject)"]),
  );
  section(
    "archive tags (retired iterations):",
    git(["for-each-ref", "refs/tags/archive",
      "--format=%(refname:short)\t%(objectname:short)\t%(contents:subject)"]),
  );
  process.stdout.write(
    (CONFIG.seams_doc !== undefined ? `\nContext and topic map: ${CONFIG.seams_doc}\n` : "\n") +
      "Resume one: lane open <topic> <ref>\n" +
      `Inherited work is unverified until its tests run green on current ${MAIN}.\n`,
  );
}

// Dispatch a visible agent session into the lane's herdr workspace: a new
// tab in that workspace, an interactive agent (any herdr kind) started in
// its pane, and the brief submitted as the first prompt. The session shows
// in the herdr console (watch: `herdr agent read lane-<topic>`; attach to
// steer). Rule inheritance: codex reads AGENTS.md natively; claude reads
// CLAUDE.md (a one-line `@AGENTS.md` import keeps them one file); brief other
// kinds to read the repository's instructions.
function atxHeading(line) {
  return line.match(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/u)?.[1]?.trim();
}

function firstBriefHeading(text) {
  let fence;
  for (const line of text.split(/\r?\n/u)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = { character: marker[0], length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const heading = atxHeading(line);
    if (heading) return heading;
  }
  return undefined;
}

function firstProseLine(text) {
  let fence;
  for (const line of text.split(/\r?\n/u)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = { character: marker[0], length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence === undefined && line.trim() !== "") return line.trim();
  }
  return undefined;
}

function dispatchGoal(topic, promptText, briefPath) {
  const text = promptText ?? "";
  const firstContent = firstProseLine(text);
  const selected = briefPath === undefined
    ? (atxHeading(firstContent ?? "") ?? firstContent)
    : (firstBriefHeading(text) ?? firstContent);
  return [...(selected ?? topic)].slice(0, 200).join("");
}

function dispatch(topic, promptText, options = {}) {
  repositoryRoot({ requiredBy: "dispatch" });
  const branch = laneBranch(topic);
  const resolved = resolveDispatch(options);
  const path = worktreeFor(branch);
  if (path === undefined) fail(`lane ${branch} has no worktree; open it first`);
  let registryPath;
  try {
    registryPath = preflightRegistryAutomation();
  } catch (error) {
    fail(error.message);
  }
  const workspaces = herdrJson(["workspace", "list"], { deadline: options.deadline })?.workspaces;
  if (workspaces === undefined) fail("herdr is unavailable; dispatch requires the herdr server");
  const label = workspaceLabel(topic, path, workspaces);
  const workspaceId = ensureHerdrWorkspace(path, label, workspaces, options.deadline);
  if (workspaceId === undefined) {
    fail(`herdr shows no open workspace for ${path} and could not open one from the ${REPO_ROOT} workspace`);
  }
  const tabArgs = ["tab", "create", "--workspace", workspaceId, "--label", `agent:${topic}`];
  for (const pair of resolved.env) tabArgs.push("--env", pair);
  const created = JSON.parse(execFileSync("herdr", tabArgs, {
    encoding: "utf8",
    ...(options.deadline === undefined ? {} : { timeout: Math.max(1, options.deadline - Date.now()) }),
  }));
  const pane = created.result.root_pane.pane_id;
  const tabId = created.result.tab.tab_id;
  let paneCwd;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    paneCwd = herdrJson(["pane", "get", pane], { deadline: options.deadline })?.pane?.foreground_cwd;
    if (samePath(paneCwd, path)) break;
    sleepMs(Math.min(500, Math.max(1, (options.deadline ?? (Date.now() + 500)) - Date.now())));
  }
  if (!samePath(paneCwd, path)) {
    spawnSync("herdr", ["tab", "close", tabId], { encoding: "utf8" });
    fail(`pane ${pane} shell never reached ${path} (last cwd: ${paneCwd}); tab closed, nothing started`);
  }
  // The stem remains readable, while repository identity and random suffixes
  // keep names distinct across equal topics and retry leftovers. Herdr limits
  // names to 32 characters and [a-z][a-z0-9_-]*.
  const liveAgentNames = new Set(
    (herdrJson(["agent", "list"], { deadline: options.deadline })?.agents ?? []).map((agent) => agent.name),
  );
  let agentName = newAgentName(topic, liveAgentNames);
  // Dispatch is model-agnostic: the tier policy is the operator's, and the
  // operator-owned role->agent mappings live in .lane.json "routes". Flags
  // override a selected route and global dispatch defaults; extra agent-CLI
  // arguments pass through verbatim via --arg. No config: kind falls back to
  // claude, no model argument is sent.
  const agentArgs = [];
  if (resolved.model !== undefined) agentArgs.push("--model", resolved.model);
  agentArgs.push(...resolved.args);
  const startArgsFor = (name) => {
    const args = ["agent", "start", name, "--kind", resolved.kind, "--pane", pane];
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
    if (attempt > 0) agentName = newAgentName(topic, liveAgentNames);
    const run = spawnSync("herdr", startArgsFor(agentName), {
      encoding: "utf8",
      ...(options.deadline === undefined ? {} : { timeout: Math.max(1, options.deadline - Date.now()) }),
    });
    if (run.status === 0 && !`${run.stdout}${run.stderr}`.includes('"error"')) {
      started = true;
      break;
    }
    liveAgentNames.add(agentName);
    lastError = `${run.stdout}${run.stderr}`.trim();
    const running = agentOnPane(pane, options.deadline);
    if (running !== undefined) {
      agentName = running.name;
      started = true;
      break;
    }
    sleepMs(Math.min(500, Math.max(1, (options.deadline ?? (Date.now() + 500)) - Date.now())));
  }
  if (!started) {
    spawnSync("herdr", ["tab", "close", tabId], { encoding: "utf8" });
    fail(`agent start never succeeded (tab ${tabId} closed); last error: ${lastError}`);
  }
  // codex asks to trust a directory it has not seen; accept the preselected
  // "Yes, continue" — the directory is this repository's own worktree.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const visible = spawnSync("herdr", ["agent", "read", agentName, "--source", "visible"], { encoding: "utf8" }).stdout ?? "";
    const status = agentRecord(agentName, options.deadline)?.agent_status;
    if (visible.includes("Do you trust the contents of this directory")) {
      spawnSync("herdr", ["agent", "send-keys", agentName, "Enter"], { encoding: "utf8" });
    } else if (status === "idle" || status === "done" || status === "working") {
      break;
    }
    sleepMs(Math.min(1000, Math.max(1, (options.deadline ?? (Date.now() + 1000)) - Date.now())));
  }
  const cwdCheck = verifyAgentCwd(agentName, path, options.deadline);
  if (!cwdCheck.ok) {
    spawnSync("herdr", ["tab", "close", tabId], { encoding: "utf8" });
    fail(`agent '${agentName}' is running in '${cwdCheck.cwd}', not the lane worktree ${path}; tab closed, brief NOT sent`);
  }
  if (promptText !== undefined && promptText.trim() !== "") {
    try {
      execFileSync("herdr", ["agent", "prompt", agentName, promptText], {
        stdio: options.silent ? ["ignore", "ignore", "pipe"] : "inherit",
        ...(options.deadline === undefined ? {} : { timeout: Math.max(1, options.deadline - Date.now()) }),
      });
    } catch {
      fail(
        `prompt command failed for live agent '${agentName}' in workspace ${workspaceId} (pane ${pane}); ` +
        "delivery outcome is unknown and no session record was written; inspect the agent before deciding whether to resend",
      );
    }
  }
  const record = {
    session_id: newSessionId(),
    repo_id: REPO_IDENTITY,
    root_id: ROOT_IDENTITY,
    repo: REPO_ROOT,
    topic,
    name: agentName,
    workspace: workspaceId,
    pane,
    server: herdrSocketPath(),
    lane: branch,
    role: options.route ?? "agent",
    brief: options.briefPath ?? null,
    goal: dispatchGoal(topic, promptText, options.briefPath),
    report: `docs/reports/${topic}.md`,
    deadline: null,
    done: false,
    created_at: new Date().toISOString(),
  };
  try {
    const liveAfterDelivery = agentRecord(agentName, options.deadline);
    if (liveAfterDelivery === undefined || liveAfterDelivery.pane_id !== pane ||
        liveAfterDelivery.workspace_id !== workspaceId || !samePath(liveAfterDelivery.cwd, path)) {
      throw new Error("the delivered agent no longer occupies its verified lane pane");
    }
    const beforeSessionId = cwdCheck.record?.agent_session?.value;
    const afterSessionId = liveAfterDelivery.agent_session?.value;
    const beforeTerminalId = cwdCheck.record?.terminal_id;
    const afterTerminalId = liveAfterDelivery.terminal_id;
    if ((typeof beforeSessionId === "string" && beforeSessionId !== afterSessionId) ||
        (typeof beforeTerminalId === "string" && beforeTerminalId !== afterTerminalId)) {
      throw new Error("the delivered agent's immutable occupant identity changed");
    }
    if (typeof beforeSessionId === "string" && beforeSessionId !== "") {
      record.agent_session_id = beforeSessionId;
    }
    if (typeof beforeTerminalId === "string" && beforeTerminalId !== "") {
      record.terminal_id = beforeTerminalId;
    }
    registryPath = preflightRegistryAutomation();
    writeSessionRecord(registryPath, record);
  } catch (error) {
    const action = promptText !== undefined && promptText.trim() !== ""
      ? "the brief was already sent"
      : "the agent was already started and verified ready";
    fail(
      `partial success: ${action}, but session metadata could not be written (${error.message}); ` +
      `live agent '${agentName}' remains in workspace ${workspaceId} (pane ${pane}); do not replay dispatch`,
    );
  }
  if (!options.silent) {
    process.stdout.write(
      `dispatched '${agentName}' in herdr workspace ${workspaceId} (pane ${pane})\n` +
        `  watch:  herdr agent read ${agentName}\n` +
        `  steer:  herdr agent attach ${agentName}\n`,
    );
  }
  return { agentName, pane, tabId, workspaceId };
}

const REVIEW_MAX_PRIVATE_BYTES = 1024 * 1024;
const REVIEW_COMPLETE_MARKER = "<!-- lane-review-complete -->";
const REVIEW_SETTLE_MS = 2_000;
const REVIEW_MIN_TIMEOUT_SECONDS = Math.floor(REVIEW_SETTLE_MS / 1_000) + 1;
const REVIEW_SECTIONS = [
  "Findings", "Re-executed", "Non-claims", "Unverified", "Private identifiers", "Analysis",
];

function parseReviewOptions(args) {
  const options = { route: "review", timeout: 1800 };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--round", "--brief", "--change", "--route", "--timeout"].includes(flag)) {
      fail(`usage: lane review <topic> --round N [--brief <path>] [--change <name>] [--route <name>] [--timeout <seconds>] (unknown operand: ${flag})`);
    }
    if (seen.has(flag)) fail(`duplicate review option: ${flag}`);
    seen.add(flag);
    const value = args[(index += 1)];
    if (value === undefined || value === "" || value.startsWith("--")) fail(`missing value for ${flag}`);
    if (flag === "--round") options.round = Number(value);
    else if (flag === "--timeout") options.timeout = Number(value);
    else options[flag.slice(2)] = value;
  }
  if (!Number.isSafeInteger(options.round) || options.round < 1) fail("--round must be a positive safe integer");
  if (!Number.isInteger(options.timeout) || options.timeout < REVIEW_MIN_TIMEOUT_SECONDS || options.timeout > 7200) {
    fail(`--timeout must be an integer from ${REVIEW_MIN_TIMEOUT_SECONDS} through 7200 seconds`);
  }
  if (options.change === undefined && options.brief === undefined) fail("review requires --change or --brief");
  if (typeof options.route !== "string" || options.route === "") fail("--route must not be empty");
  return options;
}

function assertReviewOutputPath(root, relativePath, { ignored, label }) {
  const realRoot = realpathSync(root);
  const path = resolve(root, relativePath);
  if (!within(path, realRoot)) fail(`${label} escapes its repository checkout`);
  let cursor = dirname(path);
  while (cursor !== realRoot) {
    if (entryExists(cursor)) {
      const entry = lstatSync(cursor);
      if (entry.isSymbolicLink()) fail(`${label} has a symlink ancestor: ${cursor}`);
      if (!entry.isDirectory()) fail(`${label} has a non-directory ancestor: ${cursor}`);
      if (!within(realpathSync(cursor), realRoot)) fail(`${label} resolves outside its repository checkout`);
    }
    const parent = dirname(cursor);
    if (parent === cursor) fail(`${label} has no repository ancestor`);
    cursor = parent;
  }
  if (entryExists(path)) fail(`${label} already exists; refusing to overwrite round output`);
  const tracked = spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", relativePath], {
    stdio: "ignore",
  }).status === 0;
  if (tracked) fail(`${label} is already tracked; review records are never overwritten`);
  const isIgnored = spawnSync("git", ["-C", root, "check-ignore", "-q", "--no-index", "--", relativePath], {
    stdio: "ignore",
  }).status === 0;
  if (ignored && !isIgnored) fail(`${label} must be gitignored before review dispatch`);
  if (!ignored && isIgnored) fail(`${label} must be trackable and not gitignored`);
  return path;
}

function assertUnambiguousReviewPrefix(directory, head7, head) {
  if (!entryExists(directory)) return;
  const entry = lstatSync(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail("review output directory must be a real directory");
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(`${head7}-r`) || !name.endsWith(".md")) continue;
    const path = join(directory, name);
    if (!lstatSync(path).isFile()) fail("review prefix collision is not a regular file");
    const match = readFileSync(path, "utf8").match(/^Reviewed commit: ([0-9a-f]{40})$/mu);
    if (match !== null && match[1] !== head) {
      fail(`review abbreviation ${head7} is ambiguous with an existing record`);
    }
  }
}

function regularTextFile(path, label, maximum = REVIEW_MAX_PRIVATE_BYTES) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    fail(`${label} does not exist: ${path}`);
  }
  if (entry.isSymbolicLink() || !entry.isFile()) fail(`${label} must be a regular file: ${path}`);
  if (entry.size > maximum) fail(`${label} exceeds ${maximum} bytes`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

function collectMarkdownFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`review source contains a symlink: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function reviewSources(path, topic, options) {
  const sources = [];
  const add = (file, label = relative(path, file)) => {
    const content = regularTextFile(file, `review source ${label}`);
    sources.push(`### Source: ${label}\n${content.trimEnd()}`);
  };
  const agents = join(path, "AGENTS.md");
  if (entryExists(agents)) add(agents, "AGENTS.md");
  else sources.push("### Source: AGENTS.md\nAbsent.");
  const shared = join(path, "openspec", "README.md");
  if (entryExists(shared)) add(shared, "openspec/README.md");
  else sources.push("### Source: openspec/README.md\nAbsent.");

  if (options.change !== undefined) {
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/u.test(options.change)) fail(`invalid OpenSpec change name: ${options.change}`);
    const changeRoot = join(path, "openspec", "changes", options.change);
    if (!entryExists(changeRoot) || !lstatSync(changeRoot).isDirectory() || lstatSync(changeRoot).isSymbolicLink()) {
      fail(`OpenSpec change does not exist: ${options.change}`);
    }
    for (const required of ["proposal.md", "design.md", "tasks.md"]) add(join(changeRoot, required));
    const deltaRoot = join(changeRoot, "specs");
    if (!entryExists(deltaRoot) || !lstatSync(deltaRoot).isDirectory()) fail(`OpenSpec change has no delta specs: ${options.change}`);
    const deltas = collectMarkdownFiles(deltaRoot);
    if (deltas.length === 0) fail(`OpenSpec change has no delta specs: ${options.change}`);
    for (const delta of deltas) {
      add(delta);
      const capability = relative(deltaRoot, delta).split(sep)[0];
      const current = join(path, "openspec", "specs", capability, "spec.md");
      if (entryExists(current) && !sources.some((value) => value.startsWith(`### Source: ${relative(path, current)}\n`))) add(current);
    }
  }

  const report = join(path, "docs", "reports", `${topic}.md`);
  if (entryExists(report)) add(report);
  else sources.push("### Source: engineer report\nAbsent.");
  const handoff = join(path, "HANDOFF.md");
  if (entryExists(handoff)) {
    const text = regularTextFile(handoff, "HANDOFF.md");
    const start = text.lastIndexOf("\n## ");
    sources.push(`### Source: latest HANDOFF entry\n${(start === -1 ? text : text.slice(start + 1)).trimEnd()}`);
  } else {
    sources.push("### Source: latest HANDOFF entry\nAbsent.");
  }
  return sources.join("\n\n");
}

function reviewGate(path, head, branch) {
  const gatePath = join(path, ".lane", "gate.json");
  if (!entryExists(gatePath)) return { prompt: "No usable gate at captured HEAD (missing).", diagnostic: "missing" };
  try {
    const gate = JSON.parse(regularTextFile(gatePath, "lane gate"));
    if (gate.head !== head || gate.branch !== branch) {
      return { prompt: "No usable gate at captured HEAD (stale).", diagnostic: "stale" };
    }
    if (!Number.isInteger(gate.exit_code) || typeof gate.command !== "string" ||
        typeof gate.started_at !== "string" || typeof gate.finished_at !== "string") {
      return { prompt: "No usable gate at captured HEAD (unusable).", diagnostic: "unusable" };
    }
    return {
      prompt: `Gate at captured HEAD: exit=${gate.exit_code}; signal=${gate.signal ?? "none"}; command=${gate.command}; started=${gate.started_at}; finished=${gate.finished_at}`,
      diagnostic: `exit=${gate.exit_code}`,
    };
  } catch {
    return { prompt: "No usable gate at captured HEAD (unusable).", diagnostic: "unusable" };
  }
}

function replaceReviewTemplate(template, values) {
  let rendered = template;
  const literalSlots = new Map([
    ["SOURCE_MATERIAL", "\0lane-source-material\0"],
    ["SUPPLEMENTAL_BRIEF", "\0lane-supplemental-brief\0"],
  ]);
  for (const [name, slot] of literalSlots) {
    if (rendered.split(`{{${name}}}`).length !== 2) {
      fail(`review template must contain exactly one {{${name}}} placeholder`);
    }
    rendered = rendered.replace(`{{${name}}}`, slot);
  }
  for (const [name, value] of Object.entries(values)) {
    if (!literalSlots.has(name)) rendered = rendered.replaceAll(`{{${name}}}`, () => value);
  }
  if (/\{\{[A-Z_]+\}\}/u.test(rendered)) {
    fail("review template contains an unresolved metadata placeholder");
  }
  return rendered.replace(/\0lane-(source-material|supplemental-brief)\0/gu, (_, slot) =>
    values[slot === "source-material" ? "SOURCE_MATERIAL" : "SUPPLEMENTAL_BRIEF"]);
}

function exactObjectKeys(value, expected, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} has invalid fields`);
}

function parseJsonFence(content, label) {
  const match = content.match(/^```json\n([\s\S]+)\n```$/u);
  if (match === null) fail(`${label} must contain one JSON fenced block`);
  try {
    return JSON.parse(match[1]);
  } catch {
    fail(`${label} contains invalid JSON`);
  }
}

function normalizeReviewNewlineBoundaries(value) {
  return value.replace(/^\n+|\n+$/gu, "");
}

function privateReviewIsComplete(value) {
  return value.trimEnd().split("\n").at(-1) === REVIEW_COMPLETE_MARKER;
}

function validateReviewRecord(record, expected) {
  if (record.includes("\r\n")) fail("private review must use LF line endings; CRLF is not supported");
  const normalized = normalizeReviewNewlineBoundaries(record);
  const lines = normalized.split("\n");
  const verdictMatch = lines[0]?.match(/^\*\*(PASS|NEEDS-WORK|FAIL)\*\*$/u);
  if (verdictMatch === null) fail("private review first line must be **PASS**, **NEEDS-WORK**, or **FAIL**");
  const boldVerdicts = normalized.match(/\*\*(?:PASS|NEEDS-WORK|FAIL)\*\*/gu) ?? [];
  if (boldVerdicts.length !== 1) fail("private review contains an extra bold verdict token");
  const metadata = [
    ["Schema", "lane-review/v1"],
    ["Reviewed commit", expected.head],
    ["Topic", expected.topic],
    ["Round", String(expected.round)],
    ["Review ID", expected.reviewId],
    ["Base branch", expected.baseBranch],
    ["Base commit", expected.baseCommit],
  ];
  for (let index = 0; index < metadata.length; index += 1) {
    const [name, value] = metadata[index];
    if (lines[index + 1] !== `${name}: ${value}`) fail(`private review ${name} does not match the captured review`);
    if (lines.filter((line) => line.startsWith(`${name}:`)).length !== 1) fail(`private review has duplicate ${name}`);
  }
  if (lines[8] !== "") fail("private review metadata must be followed by a blank line");
  const lastNonemptyLine = lines.findLast((line) => line !== "");
  if (lastNonemptyLine !== REVIEW_COMPLETE_MARKER) {
    fail("private review completion marker must be the last nonempty line");
  }
  const headers = lines.map((line, index) => line.startsWith("## ") ? [line.slice(3), index] : undefined).filter(Boolean);
  if (JSON.stringify(headers.map(([name]) => name)) !== JSON.stringify(REVIEW_SECTIONS)) {
    fail("private review sections are missing, duplicated, unknown, or out of order");
  }
  const sections = new Map(headers.map(([name, index], position) => {
    const end = position + 1 < headers.length ? headers[position + 1][1] : lines.length - 1;
    return [name, normalizeReviewNewlineBoundaries(lines.slice(index + 1, end).join("\n"))];
  }));

  const findings = sections.get("Findings");
  if (findings !== "None") {
    const findingLines = findings.split("\n");
    if (findingLines.length === 0) fail("Findings must be None or tagged entries");
    if (findingLines.some((finding) => finding === "")) {
      fail("Findings spacing must not contain blank lines between entries");
    }
    for (const finding of findingLines) {
      const match = finding.match(/^- \[(Major|Moderate|Minor)\] (.+):([1-9][0-9]*) - (.+); Fix: (.+)$/u);
      if (match === null || isAbsolute(match[2]) || /^[A-Za-z]:[\\/]/u.test(match[2]) || match[2].split(/[\\/]/u).includes("..")) {
        fail("each finding must have an allowed tag, repository-relative file:line, and concrete Fix");
      }
    }
  }

  const executions = parseJsonFence(sections.get("Re-executed"), "Re-executed");
  if (!Array.isArray(executions)) fail("Re-executed JSON must be an array");
  const executionKeys = ["command", "cwd", "exit_code", "result", "tests_pass", "witness"];
  const witnessKeys = ["kind", "command", "cwd", "exit_code", "result", "observed_failure"];
  for (let index = 0; index < executions.length; index += 1) {
    const execution = executions[index];
    exactObjectKeys(execution, executionKeys, `Re-executed[${index}]`);
    if (typeof execution.command !== "string" || execution.command === "" ||
        !["lane", "scratch"].includes(execution.cwd) || !Number.isInteger(execution.exit_code) ||
        typeof execution.result !== "string" || execution.result === "" || typeof execution.tests_pass !== "boolean") {
      fail(`Re-executed[${index}] has invalid values`);
    }
    if (execution.witness !== null) {
      exactObjectKeys(execution.witness, witnessKeys, `Re-executed[${index}].witness`);
      const witness = execution.witness;
      if (!["negative-control", "mutation"].includes(witness.kind) || typeof witness.command !== "string" || witness.command === "" ||
          !["lane", "scratch"].includes(witness.cwd) || !Number.isInteger(witness.exit_code) || typeof witness.result !== "string" ||
          witness.result === "" || typeof witness.observed_failure !== "string" || witness.observed_failure === "") {
        fail(`Re-executed[${index}].witness has invalid values`);
      }
    }
    if (execution.tests_pass && (execution.exit_code !== 0 || execution.witness === null)) {
      fail(`Re-executed[${index}] tests_pass requires exit 0 and an observed witness`);
    }
  }

  for (const name of ["Non-claims", "Unverified"]) {
    const content = sections.get(name);
    if (content !== "None" && !content.split("\n").every((line) => /^- \S/u.test(line))) {
      fail(`${name} must be None or nonempty bullet entries`);
    }
  }
  const identifiers = parseJsonFence(sections.get("Private identifiers"), "Private identifiers");
  if (!Array.isArray(identifiers) || identifiers.some((value) => typeof value !== "string" || value === "")) {
    fail("Private identifiers must be an array of nonempty strings");
  }
  const prose = [findings, sections.get("Non-claims"), sections.get("Unverified")].join("\n");
  for (const line of prose.split("\n")) {
    for (const match of line.matchAll(/\btests? pass(?:ed|ing)?\b/giu)) {
      const before = line.slice(0, match.index);
      const after = line.slice(match.index + match[0].length);
      const negated = /\b(?:no|not|never)\s*$/iu.test(before) ||
        /^(?:(?![.;]).){0,80}\b(?:not|never)\s+(?:claimed|verified|supported)\b/iu.test(after) ||
        /^(?:(?![.;]).){0,80}\b(?:claim|witness)\b(?:(?![.;]).){0,40}\b(?:absent|missing|unavailable)\b/iu.test(after);
      if (!negated) fail("tests-pass claims are allowed only in witnessed Re-executed entries");
    }
  }
  return { verdict: verdictMatch[1], sections, executions, identifiers, record: normalized };
}

const REVIEW_PLACEHOLDERS = {
  "absolute-path": "[ABS_PATH]",
  user: "[USER]",
  host: "[HOST]",
  private: "[PRIVATE]",
};
const REVIEW_PLACEHOLDER_PATTERN = /(\[(?:ABS_PATH|USER|HOST|PRIVATE)\])/gu;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function reviewAliases(identifiers) {
  let username;
  let homeName;
  let host;
  try {
    username = userInfo().username;
    homeName = basename(homedir());
    host = hostname();
  } catch {
    fail("cannot read local user and host aliases for review sanitization");
  }
  const automatic = [
    [username, "user"],
    [homeName, "user"],
    [host, "host"],
    [host.split(".")[0], "host"],
  ];
  const byValue = new Map();
  for (const [value, category] of automatic) {
    if (typeof value !== "string" || value === "") continue;
    const key = value.toLocaleLowerCase("en-US");
    if (!byValue.has(key)) byValue.set(key, { value, category, automatic: true });
  }
  const declared = [];
  for (const value of identifiers) {
    const key = value.toLocaleLowerCase("en-US");
    if (byValue.has(key)) continue;
    if (!declared.some((entry) => entry.key === key)) declared.push({ key, value });
  }
  for (let left = 0; left < declared.length; left += 1) {
    for (let right = left + 1; right < declared.length; right += 1) {
      if (declared[left].key.includes(declared[right].key) || declared[right].key.includes(declared[left].key)) {
        fail("declared private identifiers are ambiguous by substring");
      }
    }
  }
  for (const entry of declared) byValue.set(entry.key, { value: entry.value, category: "private", automatic: false });
  const precedence = { user: 0, host: 1, private: 2 };
  return [...byValue.values()].sort((left, right) =>
    [...right.value].length - [...left.value].length || precedence[left.category] - precedence[right.category]);
}

function replaceOutsidePlaceholders(value, replace) {
  return value.split(REVIEW_PLACEHOLDER_PATTERN).map((part) =>
    Object.values(REVIEW_PLACEHOLDERS).includes(part) ? part : replace(part)).join("");
}

function aliasRegex(alias) {
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeRegex(alias)}(?![\\p{L}\\p{M}\\p{N}])`, "giu");
}

function containsAlias(value, aliases) {
  return aliases.some((alias) => aliasRegex(alias.value).test(value.replace(REVIEW_PLACEHOLDER_PATTERN, "")));
}

function absolutePathPattern() {
  return /file:\/\/(?:\/|[A-Za-z0-9._~!$&'+=@%-]+\/)[A-Za-z0-9._~!$&'+=@%\/-]+|\\\\[^\\/\s]+[\\/][^\s"'<>`\[\],;:)]+|(?<![-\p{L}\p{M}\p{N}_.\/\\:])\/\/[^\\/\s]+[\\/][^\s"'<>`\[\],;:)]+|\b[A-Za-z]:[\\/][^\s"'<>`\[\],;:)]+|(?<flag>(?<![-\p{L}\p{M}\p{N}_.\/\\])-[A-Za-z]+)(?<flagPath>\/(?!\/)[^\s"'<>`\[\],;:()]+)|(?<![-\p{L}\p{M}\p{N}_.\/\\])\/(?!\/)[^\s"'<>`\[\],;:()]+/giu;
}

function replaceConcreteAbsolutePaths(value, replace) {
  return replaceOutsidePlaceholders(value, (part) => part.replace(
    absolutePathPattern(),
    (match, _flag, flagPath, _offset, _value, groups) =>
      flagPath === undefined ? replace(match) : `${groups.flag}${replace(flagPath)}`,
  ));
}

function containsConcreteAbsolutePath(value) {
  let found = false;
  replaceConcreteAbsolutePaths(value, (match) => {
    found = true;
    return match;
  });
  return found;
}

function hasOnlyIndependentlySanitizablePathSeparators(value) {
  let matched = false;
  const residue = replaceConcreteAbsolutePaths(value, () => {
    matched = true;
    return "";
  });
  return matched && !/[\\/]/u.test(residue);
}

function containsAmbiguousAbsolutePath(value) {
  let found = false;
  replaceOutsidePlaceholders(value, (part) => {
    for (const match of part.matchAll(absolutePathPattern())) {
      let cursor = match.index + match[0].length;
      if (part[cursor] === "(" ||
          (part[cursor] === ")" && part[cursor + 1] !== undefined && !/\s/u.test(part[cursor + 1]))) {
        found = true;
        break;
      }
      while (cursor < part.length && !/\s/u.test(part[cursor])) cursor += 1;
      while (part[cursor] === " ") {
        while (part[cursor] === " ") cursor += 1;
        let end = cursor;
        while (end < part.length && !/\s/u.test(part[end])) end += 1;
        if (end === cursor) break;
        const token = part.slice(cursor, end);
        if (/[\\/]/u.test(token)) {
          if (!hasOnlyIndependentlySanitizablePathSeparators(token)) found = true;
          break;
        }
        cursor = end;
      }
    }
    return part;
  });
  return found;
}

function decodeReviewRescanText(input) {
  let value = input;
  while (true) {
    const decoded = value
      .replace(/\\\//gu, "/")
      .replace(/%([0-9A-Fa-f]{2})/gu, (_match, digits) => String.fromCharCode(Number.parseInt(digits, 16)))
      .replace(/&#(?:x([0-9A-Fa-f]+)|([0-9]+));/giu, (match, hexadecimal, decimal) => {
        const codePoint = Number.parseInt(hexadecimal ?? decimal, hexadecimal === undefined ? 10 : 16);
        return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? String.fromCodePoint(codePoint)
          : match;
      });
    if (decoded === value) return value;
    value = decoded;
  }
}

function assertPublicPayloadRestrictions(value, label, { allowGenerated = false } = {}) {
  if (!allowGenerated && REVIEW_PLACEHOLDER_PATTERN.test(value)) {
    REVIEW_PLACEHOLDER_PATTERN.lastIndex = 0;
    fail(`${label} contains a reserved sanitizer placeholder`);
  }
  REVIEW_PLACEHOLDER_PATTERN.lastIndex = 0;
  if (/[\u0000-\u001f\u007f\n\r]/u.test(value)) fail(`${label} must be single-line text`);
  const withoutPlaceholders = allowGenerated ? value.replace(REVIEW_PLACEHOLDER_PATTERN, "") : value;
  REVIEW_PLACEHOLDER_PATTERN.lastIndex = 0;
  if ([...withoutPlaceholders].some((character) => character.codePointAt(0) < 0x20 || character.codePointAt(0) > 0x7e)) {
    fail(`${label} contains unsupported non-ASCII text`);
  }
}

function sanitizePublicString(input, context, { allowGenerated = false } = {}) {
  let value = input.normalize("NFC");
  if (!allowGenerated && REVIEW_PLACEHOLDER_PATTERN.test(value)) fail("projected payload contains a reserved sanitizer placeholder");
  REVIEW_PLACEHOLDER_PATTERN.lastIndex = 0;
  if (/[\u0000-\u001f\u007f\n\r]/u.test(value)) fail("projected payload must be single-line text");

  const roots = [...new Set([context.path, REPO_ROOT].map((root) => realpathSync(root)))].sort((a, b) => b.length - a.length);
  for (const root of roots) {
    const pattern = new RegExp(
      `${escapeRegex(root)}(?=$|[\\/\\s"'<>\`\\[\\],;:)])(?:[\\/][^\\s"'<>\`\\[\\],;:)]*)?`,
      "gu",
    );
    value = replaceOutsidePlaceholders(value, (part) => part.replace(pattern, (match) => {
      const converted = relative(root, match).split(sep).join("/") || ".";
      context.counts["relative-path"] += 1;
      return converted;
    }));
  }
  if (containsAmbiguousAbsolutePath(value)) fail("projected payload contains an ambiguous absolute path");

  value = replaceConcreteAbsolutePaths(value, () => {
    context.counts["absolute-path"] += 1;
    return REVIEW_PLACEHOLDERS["absolute-path"];
  });
  for (const alias of context.aliases) {
    value = replaceOutsidePlaceholders(value, (part) => part.replace(aliasRegex(alias.value), () => {
      context.counts[alias.category] += 1;
      return REVIEW_PLACEHOLDERS[alias.category];
    }));
  }

  assertPublicPayloadRestrictions(value, "projected payload", { allowGenerated: true });
  const withoutPlaceholders = value.replace(REVIEW_PLACEHOLDER_PATTERN, "");
  REVIEW_PLACEHOLDER_PATTERN.lastIndex = 0;
  const rescanText = decodeReviewRescanText(withoutPlaceholders);
  if (containsConcreteAbsolutePath(rescanText) || containsAlias(rescanText, context.aliases)) {
    fail("projected payload retains private path or alias content");
  }
  return value;
}

function escapeReviewProse(value) {
  const escaped = replaceOutsidePlaceholders(value, (part) => part.replace(/[\\`*_\[\]<>]/gu, "\\$&"));
  return escaped.replace(/(\[(?:ABS_PATH|USER|HOST|PRIVATE)\])\(/gu, "$1\\(");
}

function assertProtectedPublicValue(value, aliases, label, { payload = false } = {}) {
  if (payload) {
    const normalized = value.normalize("NFC");
    assertPublicPayloadRestrictions(normalized, label);
    if (/[`<>\[\]]|\*\*|__|%[0-9A-Fa-f]{2}|&(?:#?[A-Za-z0-9]+);|\\x[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f]{4}/u.test(normalized)) {
      fail(`${label} contains unsupported markup or encoded text`);
    }
  }
  const inspectedValue = value.replace(/\\\//gu, "/");
  if (containsAlias(inspectedValue, aliases) || containsConcreteAbsolutePath(inspectedValue)) {
    fail(`${label} contains a private alias or absolute path and cannot be rewritten safely`);
  }
  if (![...value].every((character) => character.codePointAt(0) >= 0x20 && character.codePointAt(0) <= 0x7e)) {
    fail(`${label} contains unsupported non-ASCII text`);
  }
}

function sanitizeReviewProjection(parsed, expected) {
  const aliases = reviewAliases(parsed.identifiers);
  for (const [label, value] of [
    ["topic metadata", expected.topic],
    ["base branch metadata", expected.baseBranch],
  ]) assertProtectedPublicValue(value, aliases, label);
  const context = {
    path: expected.path,
    aliases,
    counts: { "absolute-path": 0, user: 0, host: 0, private: 0, "relative-path": 0 },
  };
  const modifiedExecutionFields = [];
  const sanitize = (value) => sanitizePublicString(value, context);
  const declaredAliases = aliases.filter((alias) => !alias.automatic);
  const findingPayloads = [];
  const findingLines = parsed.sections.get("Findings") === "None"
    ? ["None"]
    : parsed.sections.get("Findings").split("\n").map((line) => {
      const match = line.match(/^- \[(Major|Moderate|Minor)\] (.+):([1-9][0-9]*) - (.+); Fix: (.+)$/u);
      const location = `${match[2]}:${match[3]}`;
      assertProtectedPublicValue(location, aliases, "finding location", { payload: true });
      if (containsAlias(match[4].normalize("NFC"), declaredAliases)) {
        fail("finding description contains a declared private identifier");
      }
      const description = sanitize(match[4]);
      const fix = sanitize(match[5]);
      findingPayloads.push(description, fix);
      return `- [${match[1]}] ${location} - ${escapeReviewProse(description)}; Fix: ${escapeReviewProse(fix)}`;
    });
  const executions = parsed.executions.map((execution, index) => {
    const projected = { ...execution };
    for (const field of ["command", "result"]) {
      projected[field] = sanitize(execution[field]);
      if (projected[field] !== execution[field]) modifiedExecutionFields.push(`${index}.${field}`);
    }
    if (execution.witness !== null) {
      projected.witness = { ...execution.witness };
      for (const field of ["command", "result", "observed_failure"]) {
        projected.witness[field] = sanitize(execution.witness[field]);
        if (projected.witness[field] !== execution.witness[field]) modifiedExecutionFields.push(`${index}.witness.${field}`);
      }
    }
    return projected;
  });
  const bullets = (name) => parsed.sections.get(name) === "None"
    ? ["None"]
    : parsed.sections.get(name).split("\n").map((line) => `- ${sanitize(line.slice(2))}`);
  const nonClaims = bullets("Non-claims");
  const unverified = bullets("Unverified");

  const payloads = [
    ...findingPayloads,
    ...executions.flatMap((execution) => [
      execution.command,
      execution.result,
      ...(execution.witness === null ? [] : [
        execution.witness.command,
        execution.witness.result,
        execution.witness.observed_failure,
      ]),
    ]),
    ...nonClaims.filter((line) => line !== "None").map((line) => line.slice(2)),
    ...unverified.filter((line) => line !== "None").map((line) => line.slice(2)),
  ];
  const verification = {
    path: expected.path,
    aliases,
    counts: { "absolute-path": 0, user: 0, host: 0, private: 0, "relative-path": 0 },
  };
  for (let index = 0; index < payloads.length; index += 1) {
    const payload = payloads[index];
    const second = sanitizePublicString(payload, verification, { allowGenerated: true });
    if (second !== payload) {
      const categories = Object.entries(verification.counts).filter(([, count]) => count > 0).map(([name]) => name).join(",");
      fail(`review sanitization is not idempotent at projected field ${index} (${categories || "text"})`);
    }
  }
  if (Object.values(verification.counts).some((count) => count !== 0)) fail("review sanitization left a second-pass substitution");

  const record = [
    `**${parsed.verdict}**`,
    "Schema: lane-review/v1",
    `Reviewed commit: ${expected.head}`,
    `Topic: ${expected.topic}`,
    `Round: ${expected.round}`,
    `Review ID: ${expected.reviewId}`,
    `Base branch: ${expected.baseBranch}`,
    `Base commit: ${expected.baseCommit}`,
    "",
    "## Findings",
    ...findingLines,
    "",
    "## Re-executed",
    "```json",
    JSON.stringify(executions),
    "```",
    "",
    "## Non-claims",
    ...nonClaims.map((line) => line === "None" ? line : `- ${escapeReviewProse(line.slice(2))}`),
    "",
    "## Unverified",
    ...unverified.map((line) => line === "None" ? line : `- ${escapeReviewProse(line.slice(2))}`),
    "",
    "## Sanitization",
    `- absolute-path: ${context.counts["absolute-path"]}`,
    `- user: ${context.counts.user}`,
    `- host: ${context.counts.host}`,
    `- private: ${context.counts.private}`,
    `- relative-path: ${context.counts["relative-path"]}`,
    `- redacted execution fields: ${modifiedExecutionFields.length === 0 ? "None" : modifiedExecutionFields.join(", ")}`,
    "",
    REVIEW_COMPLETE_MARKER,
    "",
  ].join("\n");
  if (Buffer.byteLength(record) > 64 * 1024 || record.split("\n").length > 120) {
    fail("sanitized public review exceeds 64 KiB or 120 lines");
  }
  if (record.split("\n").some((line) => line === "## Analysis" || line === "## Private identifiers")) {
    fail("private-only sections reached public projection");
  }
  return record;
}

async function waitForPrivateReview(path, deadline, interrupted, session) {
  let completedSignature;
  let unchangedSince;
  while (Date.now() <= deadline) {
    if (interrupted.value) {
      fail(
        `review interrupted; reviewer agent '${session.agentName}' in tab ${session.tabId} ` +
        `may still write late evidence to ${path}`,
      );
    }
    if (entryExists(path)) {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || !entry.isFile()) fail("private review output must be a regular file");
      if (entry.size > REVIEW_MAX_PRIVATE_BYTES) fail("private review output exceeds 1 MiB");
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
      } catch {
        fail("private review output is not valid UTF-8");
      }
      // Completion is deliberately more permissive than schema validation: once a
      // writer has emitted the marker, malformed trailing whitespace must fail fast
      // in validateReviewRecord instead of being mistaken for an incomplete write.
      if (privateReviewIsComplete(text)) {
        const signature = `${entry.size}:${entry.mtimeMs}`;
        if (signature !== completedSignature) {
          completedSignature = signature;
          unchangedSince = Date.now();
        } else if (Date.now() - unchangedSince >= REVIEW_SETTLE_MS) {
          const beforeRead = lstatSync(path);
          if (beforeRead.isSymbolicLink() || !beforeRead.isFile()) fail("private review output must be a regular file");
          if (beforeRead.size > REVIEW_MAX_PRIVATE_BYTES) fail("private review output exceeds 1 MiB");
          const beforeSignature = `${beforeRead.size}:${beforeRead.mtimeMs}`;
          const bytes = readFileSync(path);
          const afterRead = lstatSync(path);
          const afterSignature = `${afterRead.size}:${afterRead.mtimeMs}`;
          if (beforeSignature === completedSignature && afterSignature === completedSignature && bytes.length === afterRead.size) {
            try {
              const settledText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
              if (privateReviewIsComplete(settledText)) return settledText;
            } catch {
              fail("private review output is not valid UTF-8");
            }
          }
          completedSignature = undefined;
          unchangedSince = undefined;
        }
      } else {
        completedSignature = undefined;
        unchangedSince = undefined;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(250, Math.max(1, deadline - Date.now()))));
  }
  fail(
    `review timed out; reviewer agent '${session.agentName}' in tab ${session.tabId} ` +
    `may still write late evidence to ${path}`,
  );
}

async function review(topic, args) {
  repositoryRoot({ requiredBy: "review" });
  if (topic === undefined) fail("usage: lane review <topic> --round N [--brief <path>] [--change <name>] [--route <name>] [--timeout <seconds>]");
  const options = parseReviewOptions(args);
  const branch = laneBranch(topic);
  const path = worktreeFor(branch);
  if (path === undefined) fail(`lane ${branch} has no worktree; open it first`);
  requireClean(path, "lane worktree");
  const head = git(["rev-parse", "HEAD"], { cwd: path });
  const head7 = head.slice(0, 7);
  const currentBranch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path });
  if (currentBranch !== branch) fail(`review target branch is ${currentBranch}, expected ${branch}`);
  const baseHead = tryGit(["rev-parse", "--verify", `${MAIN}^{commit}`]);
  if (baseHead === undefined) fail(`configured base branch does not resolve: ${MAIN}`);
  const baseCommit = tryGit(["merge-base", head, baseHead]);
  if (baseCommit === undefined) fail(`review target has no merge base with ${MAIN}`);
  const privateRelative = join(".lane", "reviews", topic, `${head7}-r${options.round}.md`);
  const publicRelative = join("docs", "reviews", topic, `${head7}-r${options.round}.md`);
  assertUnambiguousReviewPrefix(join(REPO_ROOT, ".lane", "reviews", topic), head7, head);
  assertUnambiguousReviewPrefix(join(path, "docs", "reviews", topic), head7, head);
  const privatePath = assertReviewOutputPath(REPO_ROOT, privateRelative, { ignored: true, label: "private review output" });
  const publicPath = assertReviewOutputPath(path, publicRelative, { ignored: false, label: "public review output" });
  const sourceText = reviewSources(path, topic, options);
  let supplement = "No supplemental brief was supplied. Review run budget: zero build/test/prepare/install/check commands.";
  if (options.brief !== undefined) supplement = regularTextFile(resolve(process.cwd(), options.brief), "review brief");
  const gate = reviewGate(path, head, branch);
  process.stderr.write(`lane review: gate ${gate.diagnostic} at ${head}\n`);
  const reviewId = `lr-${randomBytes(16).toString("hex")}`;
  const template = regularTextFile(join(TOOL_ROOT, "docs", "REVIEW_TEMPLATE.md"), "review template");
  const prompt = replaceReviewTemplate(template, {
    TOPIC: topic,
    ROUND: String(options.round),
    REVIEW_ID: reviewId,
    REVIEWED_COMMIT: head,
    BASE_BRANCH: MAIN,
    BASE_HEAD: baseHead,
    BASE_COMMIT: baseCommit,
    PRIVATE_RECORD_FILE: privatePath,
    PUBLIC_RECORD_FILE: publicPath,
    ROUTE: options.route,
    TIMEOUT_SECONDS: String(options.timeout),
    GATE: gate.prompt,
    SOURCE_MATERIAL: sourceText,
    SUPPLEMENTAL_BRIEF: supplement.trimEnd(),
  });
  const deadline = Date.now() + options.timeout * 1000;
  const interrupted = { value: false };
  const onInterrupt = () => { interrupted.value = true; };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  let session;
  try {
    try {
      session = dispatch(topic, prompt, { route: options.route, silent: true, deadline });
    } catch (error) {
      fail(`review dispatch failed: ${error.code === "ETIMEDOUT" ? "timeout" : "Herdr command error"}`);
    }
    const record = await waitForPrivateReview(privatePath, deadline, interrupted, session);
    const parsed = validateReviewRecord(record, {
      head, topic, round: options.round, reviewId, baseBranch: MAIN, baseCommit,
    });
    const currentHead = git(["rev-parse", "HEAD"], { cwd: path, silent: true });
    const afterBranch = tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path, silent: true });
    if (currentHead !== head || afterBranch !== branch) fail("review target HEAD or branch moved; private evidence was retained");
    if (git(["status", "--porcelain=v1"], { cwd: path, silent: true }) !== "") {
      fail("review target worktree changed; private evidence and work were retained");
    }
    if (Date.now() > deadline) fail("review timed out before public projection; private evidence was retained");
    const publicRecord = sanitizeReviewProjection(parsed, {
      head, topic, round: options.round, reviewId, baseBranch: MAIN, baseCommit, path,
    });
    if (Date.now() > deadline) fail("review timed out before public review creation; private evidence was retained");
    try {
      mkdirSync(dirname(publicPath), { recursive: true });
      assertReviewOutputPath(path, publicRelative, { ignored: false, label: "public review output" });
      writeFileSync(publicPath, publicRecord, { encoding: "utf8", flag: "wx", mode: 0o644 });
    } catch (error) {
      if (error?.code === "EEXIST") fail("public review output appeared concurrently; evidence was retained");
      fail("public review output could not be created exclusively; private evidence was retained");
    }
    // Yield once so a concurrent filesystem mutation that races publication can
    // become visible before the final Git integrity check.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    const finalHead = git(["rev-parse", "HEAD"], { cwd: path, silent: true });
    const finalBranch = tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path, silent: true });
    const finalStatus = git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: path, silent: true });
    if (finalHead !== head || finalBranch !== branch || finalStatus !== `?? ${publicRelative.split(sep).join("/")}`) {
      fail("mutation after public review creation caused late publication failure; inspect retained evidence before recovery");
    }
    if (Date.now() > deadline) fail("review timed out after public review creation; inspect retained evidence before recovery");
    process.stderr.write(`lane review: private review: ${privatePath}\n`);
    process.stderr.write(`lane review: public review: ${publicPath}\n`);
    process.stdout.write(`${parsed.verdict}\n`);
    process.exitCode = parsed.verdict === "PASS" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    void session;
  }
}

// A fresh worktree carries no gitignored state: no `node_modules`, no built
// `dist`. Validation then fails for environmental reasons that look like real
// failures — the classic symptom is many test FILES failing to load while every
// assertion that ran passed ("Failed to resolve entry for package ..."). The
// repository says what "prepared" means in .lane.json "prepare": each step is
// skipped when its `unless` path already exists, so this is cheap to call
// unconditionally.
function prepareWorktree(path, { quiet = false } = {}) {
  const say = (m) => { if (!quiet) process.stdout.write(m); };
  for (const step of CONFIG.prepare ?? []) {
    if (step.unless !== undefined && existsSync(join(path, step.unless))) continue;
    say(`preparing ${path}: ${step.run}\n`);
    const run = spawnSync(step.run, { cwd: path, shell: true, stdio: "inherit" });
    if (run.status !== 0) fail(`prepare step failed (${step.run}); cannot validate this worktree`);
  }
}

function check(args) {
  repositoryRoot({ requiredBy: "check" });
  let command = process.env.LANE_VALIDATE ?? DEFAULT_VALIDATE;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--cmd") {
      fail(`usage: lane check [--cmd <validate command>] (unknown option: ${args[index]})`);
    }
    if (args[index + 1] === undefined || args[index + 1] === "") {
      fail("usage: lane check [--cmd <validate command>]");
    }
    command = args[index + 1];
    index += 1;
  }

  requireClean(REPO, "current worktree");
  const head = git(["rev-parse", "HEAD"]);
  const branch = git(["branch", "--show-current"]);
  if (branch === "") fail("current checkout is detached; check requires a branch");

  prepareWorktree(REPO);
  const startedAt = new Date();
  const started = process.hrtime.bigint();
  const run = spawnSync(command, { cwd: REPO, shell: true, stdio: "inherit" });
  const finishedAt = new Date();
  const durationS = Number(process.hrtime.bigint() - started) / 1_000_000_000;
  const signal = run.signal ?? null;
  const signalNumber = signal === null ? undefined : osConstants.signals[signal];
  const exitCode = run.status ?? (signalNumber === undefined ? 1 : 128 + signalNumber);
  const gate = {
    head,
    branch,
    command,
    exit_code: exitCode,
    signal,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_s: durationS,
  };
  const directory = join(REPO, ".lane");
  const path = join(directory, "gate.json");
  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(gate, null, 2)}\n`);
  renameSync(temporary, path);
  process.stdout.write(`GATE ${head} exit=${exitCode} (${durationS.toFixed(3)}s)\n`);
  process.exit(exitCode);
}

function promote(topic) {
  repositoryRoot({ requiredBy: "promote" });
  const branch = laneBranch(topic);
  if (!branchExists(branch)) fail(`no such lane branch: ${branch}`);
  const path = worktreeFor(branch);
  if (path === undefined) fail(`lane ${branch} has no worktree; open one before promoting`);
  requireClean(path, "lane worktree");
  requireClean(REPO, `canonical ${MAIN} checkout`);
  let mainHead = git(["rev-parse", MAIN]);
  if (git(["merge-base", MAIN, branch]) !== mainHead) {
    // A promotion elsewhere moved main. Rebasing is mechanical when the dry
    // run is clean, and the gate below validates the rebased tree; conflicts
    // go back to the implementer with the file list.
    const check = rebaseCheck(branch);
    if (!check.clean) fail(`lane is behind ${MAIN} and does not rebase cleanly; conflicts in: ${check.conflicts.join(", ")}`);
    const before = git(["rev-parse", "--short", branch]);
    git(["rebase", MAIN], { cwd: path });
    process.stdout.write(`rebased ${branch} onto ${MAIN} (${before} -> ${git(["rev-parse", "--short", branch])}, clean replay)\n`);
    mainHead = git(["rev-parse", MAIN]);
  }
  prepareWorktree(path);
  const validate = process.env.LANE_VALIDATE ?? DEFAULT_VALIDATE;
  process.stdout.write(`validating in ${path}: ${validate}\n`);
  const run = spawnSync(validate, { cwd: path, shell: true, stdio: "inherit" });
  if (run.status !== 0) fail(`validation failed (exit ${run.status}); nothing merged`);
  if (git(["rev-parse", MAIN]) !== mainHead) {
    fail(`${MAIN} moved during validation; re-run promote`);
  }
  git(["merge", "--ff-only", branch]);
  process.stdout.write(
    `promoted ${branch}: ${MAIN} ${mainHead.slice(0, 7)} -> ${git(["rev-parse", "--short", MAIN])} (fast-forward)\n`,
  );
  process.stdout.write("No push performed. Close the lane with: lane close " + topic + "\n");
}

function close(topic) {
  repositoryRoot({ requiredBy: "close" });
  const branch = laneBranch(topic);
  if (!branchExists(branch)) fail(`no such lane branch: ${branch}`);
  const path = worktreeFor(branch);
  if (path !== undefined) {
    requireClean(path, "lane worktree");
    // Prefer herdr-native removal so the console workspace retires with the
    // worktree; a git-only removal leaves a ghost workspace behind.
    let removed = false;
    let mismatchedMetadata = false;
    try {
      const workspaceId = openWorkspaceIdFor(path, {
        refuseStale: false,
        onMismatch: () => { mismatchedMetadata = true; },
      });
      if (workspaceId !== undefined) {
        const run = spawnSync("herdr", ["worktree", "remove", "--workspace", workspaceId], {
          encoding: "utf8",
        });
        removed = run.status === 0 && !existsSync(path);
      }
    } catch {
      // herdr unavailable; fall back to git below
    }
    if (!removed) {
      git(["worktree", "remove", path]);
      if (mismatchedMetadata) {
        process.stderr.write(`lane: note: Herdr metadata for ${path} does not match this repository; removed the worktree with git only\n`);
      }
    }
    process.stdout.write(`removed worktree ${path}\n`);
  }
  const merged = tryGit(["merge-base", "--is-ancestor", branch, MAIN]) !== undefined;
  if (merged) {
    // `-d` judges "merged" against THIS worktree's HEAD, which may be behind
    // the main branch; the ancestor check above already proved it contains the lane.
    git(["branch", "-D", branch]);
    process.stdout.write(`deleted merged branch ${branch}\n`);
  } else {
    const tag = `archive/${branch}`;
    git(["tag", tag, branch]);
    git(["branch", "-D", branch]);
    process.stdout.write(`archived unmerged lane as tag ${tag}, then deleted branch\n`);
  }
  const configuredRegistry = registryPathFor(REPO_ROOT, CONFIG);
  if (existsSync(configuredRegistry) || existsSync(registryDirectoryFor(configuredRegistry))) {
    try {
      const registryPath = preflightRegistryAutomation();
      const result = markTopicSessionsDone(registryPath, {
        repoRoot: REPO_ROOT,
        repoId: REPO_IDENTITY,
        topic,
      });
      for (const error of result.errors) process.stderr.write(`lane: warning: session registry: ${error}\n`);
      if (result.marked > 0) process.stdout.write(`marked ${result.marked} session${result.marked === 1 ? "" : "s"} done\n`);
    } catch (error) {
      if (error instanceof RegistryPolicyError) {
        process.stderr.write(`lane: warning: session registry: ${error.message}\n`);
      } else {
        fail(`lane closed; metadata update failed: ${error.message}`);
      }
    }
  }
}

function boardDocument(state) {
  return boardSnapshotDocument({
    state,
    repoId: REPO_IDENTITY,
    rootId: ROOT_IDENTITY,
    repoRoot: REPO_ROOT,
    rootLabel: basename(ROOT_IDENTITY),
    repositoryLabel: REPO_NAME,
    laneBase: WORKTREE_ROOT,
  });
}

function registeredBoardSession(rowId, action) {
  const loaded = loadRegistry(REPO_ROOT, CONFIG);
  const matches = loaded.sessions.filter((session) => session.session_id === rowId);
  if (matches.length !== 1) {
    throw new Error(`board row ${rowId} is not a registered session; ${action} is unsupported`);
  }
  return matches[0];
}

function canonicalBoardSession(rowId, action) {
  const session = registeredBoardSession(rowId, action);
  return verifyCanonicalSession(session, {
    repoId: REPO_IDENTITY,
    repoRoot: REPO_ROOT,
    samePath,
  });
}

async function focusBoardSession(rowId) {
  const session = canonicalBoardSession(rowId, "focus");
  const branch = typeof session.lane === "string" && session.lane.startsWith(LANE_PREFIX)
    ? session.lane
    : undefined;
  if (branch === undefined) throw new Error("board row has no verified lane branch; focus is unsupported");
  const checkout = worktreeFor(branch);
  if (checkout === undefined) throw new Error("stale board selection: selected lane worktree is no longer open");
  const client = new HerdrClient({ socketPath: session.server, requestTimeoutMs: 500 });
  let snapshot;
  try {
    snapshot = await client.snapshot();
  } catch (error) {
    throw new Error(`cannot refresh selected Herdr session: ${error.message}`);
  } finally {
    client.close();
  }
  const selected = verifyFocusSelection({
    session,
    snapshot,
    repoId: REPO_IDENTITY,
    repoRoot: REPO_ROOT,
    checkout,
    samePath,
  });
  const run = spawnSync("herdr", ["agent", "focus", selected.target], {
    encoding: "utf8",
    env: { ...process.env, HERDR_SOCKET_PATH: selected.server },
  });
  const stderr = run.stderr?.trim();
  let document;
  let malformed = false;
  try {
    document = JSON.parse(run.stdout);
  } catch {
    malformed = true;
  }
  const documentError = document?.error;
  if (run.error !== undefined || run.status !== 0 || malformed ||
      documentError !== undefined || !Object.hasOwn(document ?? {}, "result")) {
    const responseMessage = typeof documentError === "string"
      ? documentError
      : documentError?.message ?? documentError?.code;
    const reason = stderr || run.error?.code || responseMessage ||
      (malformed || !Object.hasOwn(document ?? {}, "result")
        ? "malformed Herdr response"
        : `exit ${run.status}`);
    throw new Error(`Herdr focus failed for ${selected.name ?? selected.pane}: ${reason}`);
  }
  process.stdout.write(`focused ${selected.name ?? selected.pane} (${rowId})\n`);
}

function completeBoardSession(rowId) {
  const registryPath = preflightRegistryAutomation({ create: false });
  canonicalBoardSession(rowId, "done");
  markSessionDone(registryPath, rowId, { repoRoot: REPO_ROOT });
  process.stdout.write(`marked ${rowId} done\n`);
}

function writeBoardJson(state) {
  process.stdout.write(`${JSON.stringify(boardDocument(state))}\n`);
}

function boardInventoryOptions(options) {
  return {
    anchor: REPO_ROOT === undefined ? undefined : {
      path: REPO_ROOT,
      config: CONFIG,
      root_id: ROOT_IDENTITY,
      lane_base: WORKTREE_ROOT,
    },
    repoFilter: options.repo,
    includeHistory: options.includeHistory,
  };
}

function writeMachineBoardPlain(document) {
  process.stdout.write(renderMachineBoardPlain(document, {
    missingRegistry: document.coverage.registry === "missing" && REPO_ROOT !== undefined
      ? registryPathFor(REPO_ROOT, CONFIG)
      : undefined,
  }));
}

async function readMachineBoard(options, observationOptions = {}) {
  return collectMachineBoardObservation({ ...boardInventoryOptions(options), ...observationOptions });
}

async function watchMachineBoard(options) {
  let stopped = false;
  let refreshPending = false;
  let refreshTimer;
  let previewTimer;
  let previewRefreshDue = false;
  let document;
  let occupants = new Map();
  let tripwires = new Map();
  let rowsByPane = new Map();
  let subscriptionSignature = "";
  const clients = new Map();
  const runtime = new Map();
  const controller = new AbortController();
  let finish;
  const completed = new Promise((resolvePromise) => { finish = resolvePromise; });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    clearInterval(refreshTimer);
    clearTimeout(previewTimer);
    for (const client of clients.values()) client.close();
    clients.clear();
    finish();
  };
  stopBoardObservation = stop;

  const schedulePreviewRefresh = () => {
    if (previewTimer !== undefined || previewRefreshDue) return;
    previewTimer = setTimeout(() => {
      previewTimer = undefined;
      if (refreshPending) {
        previewRefreshDue = true;
        return;
      }
      void refresh();
    }, 1_000);
  };

  const installSubscriptions = (subscriptions) => {
    const signature = JSON.stringify([subscriptions, [...occupants]]);
    if (signature === subscriptionSignature) return;
    subscriptionSignature = signature;
    const boundOccupants = new Map(occupants);
    for (const client of clients.values()) client.close();
    clients.clear();
    for (const item of subscriptions) {
      if (item.subscriptions.length === 0) continue;
      const client = new HerdrClient({
        socketPath: item.endpoint.path,
        requestTimeoutMs: 500,
        paneReadTimeoutMs: 2_000,
      });
      client.on("event", (event) => {
        if (stopped || document === undefined) return;
        const paneId = event.data?.pane_id;
        const key = `${item.endpoint.server_id}\0${paneId}`;
        if (boundOccupants.get(key) !== occupants.get(key)) {
          void refresh();
          return;
        }
        if (event.event === "pane.output_changed") {
          schedulePreviewRefresh();
          return;
        }
        const row = document.rows.find(
          (candidate) => candidate.row_id === rowsByPane.get(key),
        );
        if (row === undefined) {
          void refresh();
          return;
        }
        if (event.event === "pane.agent_status_changed") {
          row.status = event.data?.agent_status ?? row.status;
          if (row.done && ["idle", "done"].includes(row.status) && !options.includeHistory) {
            document.rows = document.rows.filter((candidate) => candidate !== row);
          } else {
            row.active_after_done = row.done && ["working", "blocked", "unknown"].includes(row.status);
          }
          process.stdout.write(`${JSON.stringify(document)}\n`);
          schedulePreviewRefresh();
        } else if (event.event === "pane.output_matched") {
          const binding = tripwires.get(key);
          if (binding?.row_id === row.row_id && binding.identity === occupants.get(key)) {
            const tripwire = matchingTripwire(binding.patterns, event);
            if (tripwire !== undefined) {
              const previous = runtime.get(key);
              runtime.set(key, {
                ...(previous?.inventoryOccupantId === binding.identity ? previous : {}),
                inventoryOccupantId: binding.identity,
                tripwire,
                observedAt: new Date().toISOString(),
              });
              row.tripwire = tripwire;
            }
          }
          process.stdout.write(`${JSON.stringify(document)}\n`);
        }
      });
      client.on("connectionError", (error) => {
        if (!stopped) process.stderr.write(`lane board: Herdr observation: ${error.message}\n`);
      });
      client.subscribe(item.subscriptions);
      clients.set(item.endpoint.server_id, client);
    }
  };

  const refresh = async () => {
    if (stopped || refreshPending) return;
    refreshPending = true;
    try {
      const observation = await readMachineBoard(options, { runtime, signal: controller.signal });
      if (stopped) return;
      document = observation.document;
      occupants = observation.occupants;
      tripwires = observation.tripwires;
      rowsByPane = observation.rowsByPane;
      process.stdout.write(`${JSON.stringify(document)}\n`);
      installSubscriptions(observation.subscriptions);
    } catch (error) {
      if (!stopped) {
        process.stderr.write(`lane: board read failed: ${error.message}\n`);
        process.exitCode = 1;
        stop();
      }
    } finally {
      refreshPending = false;
      if (!stopped && previewRefreshDue) {
        previewRefreshDue = false;
        void refresh();
      }
    }
  };

  const onSignal = () => stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await refresh();
    if (!stopped) refreshTimer = setInterval(() => void refresh(), 5_000);
    await completed;
  } finally {
    stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    stopBoardObservation = undefined;
  }
}

async function watchBoard() {
  const client = new HerdrClient({ requestTimeoutMs: 500, paneReadTimeoutMs: 2_000 });
  const runtime = new Map();
  const previewTimers = new Map();
  const previewLastRead = new Map();
  let state;
  let refreshTimer;
  let refreshPending = false;
  let previewReadsPending = 0;
  let subscriptionSignature = "";
  let stopped = false;
  let exitStatus = 0;
  let finish;
  const completed = new Promise((resolvePromise) => { finish = resolvePromise; });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    for (const timer of previewTimers.values()) clearTimeout(timer);
    previewTimers.clear();
    client.close();
    finish();
  };
  stopBoardObservation = stop;

  const installSubscriptions = (next) => {
    const subscriptions = buildSubscriptions(next.sessions, next.snapshot);
    const signature = JSON.stringify(subscriptions);
    if (signature === subscriptionSignature) return;
    subscriptionSignature = signature;
    client.subscribe(subscriptions);
  };
  const refresh = async () => {
    if (stopped || refreshPending || previewReadsPending > 0) return;
    refreshPending = true;
    try {
      const next = await collectBoardState({ repoRoot: REPO_ROOT, config: CONFIG, client, runtime });
      if (stopped) return;
      state = next;
      const sampledAt = Date.now();
      for (const agent of state.snapshot.agents ?? []) {
        if (runtime.get(agent.pane_id)?.messageObservedAt !== undefined) {
          previewLastRead.set(agent.pane_id, sampledAt);
        }
      }
      writeBoardJson(state);
      installSubscriptions(state);
    } catch (error) {
      if (!stopped) {
        exitStatus = 1;
        process.stderr.write(`lane: board read failed: ${error.message}\n`);
        stop();
      }
    } finally {
      refreshPending = false;
    }
  };

  const schedulePreview = (paneId) => {
    if (stopped || typeof paneId !== "string" || previewTimers.has(paneId)) return;
    const delay = Math.max(0, 1_000 - (Date.now() - (previewLastRead.get(paneId) ?? 0)));
    const timer = setTimeout(async () => {
      previewTimers.delete(paneId);
      if (stopped) return;
      const remaining = 1_000 - (Date.now() - (previewLastRead.get(paneId) ?? 0));
      if (remaining > 0 || refreshPending || previewReadsPending > 0) {
        const retry = setTimeout(() => {
          previewTimers.delete(paneId);
          schedulePreview(paneId);
        }, Math.max(remaining, 25));
        previewTimers.set(paneId, retry);
        return;
      }
      previewLastRead.set(paneId, Date.now());
      previewReadsPending += 1;
      try {
        const result = await refreshMessagePreviews({
          registry: state.sessions,
          snapshot: state.snapshot,
          runtime,
          client,
          paneIds: [paneId],
          currentSnapshot: () => state.snapshot,
        });
        if (stopped || result.updated === 0) return;
        state = {
          ...state,
          runtime,
          messageErrors: result.errors,
          rows: joinBoardRows({
            registry: state.sessions,
            snapshot: state.snapshot,
            gitStates: state.gitStates,
            reportStates: state.reportStates,
            runtime,
          }),
        };
        writeBoardJson(state);
      } finally {
        previewReadsPending -= 1;
      }
    }, delay);
    previewTimers.set(paneId, timer);
  };

  const onEvent = (event) => {
    if (stopped || state === undefined) return;
    if (event.event === "pane.output_changed") {
      schedulePreview(event.data?.pane_id);
      return;
    }
    const snapshot = {
      ...state.snapshot,
      agents: state.snapshot.agents.map((agent) => ({ ...agent })),
    };
    applyHerdrEvent(snapshot, runtime, state.sessions, event);
    state = {
      ...state,
      snapshot,
      runtime,
      rows: joinBoardRows({
        registry: state.sessions,
        snapshot,
        gitStates: state.gitStates,
        reportStates: state.reportStates,
        runtime,
      }),
    };
    writeBoardJson(state);
    if (event.event === "pane.agent_status_changed") schedulePreview(event.data?.pane_id);
  };
  const onConnectionError = (error) => {
    if (!stopped) process.stderr.write(`lane board: Herdr observation: ${error.message}\n`);
  };
  const onSignal = () => stop();
  client.on("event", onEvent);
  client.on("connectionError", onConnectionError);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await refresh();
    if (!stopped) refreshTimer = setInterval(() => void refresh(), 5_000);
    await completed;
  } finally {
    stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    client.removeListener("event", onEvent);
    client.removeListener("connectionError", onConnectionError);
    stopBoardObservation = undefined;
  }
  if (exitStatus !== 0) process.exitCode = exitStatus;
}

async function board(options) {
  if (options.mode === "focus" || options.mode === "done") {
    try {
      if (options.mode === "focus") await focusBoardSession(options.rowId);
      else completeBoardSession(options.rowId);
    } catch (error) {
      fail(error.message);
    }
    return;
  }
  if (options.mode === "watch-json") {
    await watchMachineBoard(options);
    return;
  }
  if (options.mode === "plain" || options.mode === "json") {
    try {
      const { document } = await readMachineBoard(options);
      if (options.mode === "json") process.stdout.write(`${JSON.stringify(document)}\n`);
      else writeMachineBoardPlain(document);
    } catch (error) {
      fail(`board read failed: ${error.message}`);
    }
    return;
  }

  repositoryRoot({ requiredBy: "interactive board" });
  const boardRoot = join(TOOL_ROOT, "board");
  if (!process.stdin.isTTY) {
    fail("interactive board requires a TTY; use `lane board --once`");
  }
  if (!existsSync(join(boardRoot, "node_modules", "ink"))) {
    fail(`install board dependencies first: npm --prefix ${boardRoot} ci`);
  }
  const boardArgs = [
    "--repo", REPO_ROOT,
  ];
  const boardEnvironment = EXPLICIT_CONFIG
    ? { ...process.env, LANE_CONFIG: CONFIG_LAYERS[0].file }
    : process.env;
  const run = spawnSync("npm", ["--prefix", boardRoot, "run", "--silent", "start", "--", ...boardArgs], {
    cwd: REPO_ROOT,
    env: boardEnvironment,
    stdio: "inherit",
  });
  if (run.error?.code === "ENOENT") fail("npm is required to start the interactive board");
  if (run.status !== 0) {
    process.exit(run.status ?? 1);
  }
}

const [command, topic, ...rest] = process.argv.slice(2);
switch (command) {
  case "config":
    if (topic !== undefined) fail("usage: lane config");
    config();
    break;
  case "check":
    check([topic, ...rest].filter((argument) => argument !== undefined));
    break;
  case "board":
    await board(EARLY_BOARD_OPTIONS);
    break;
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
  case "routes":
    routes();
    break;
  case "dispatch": {
    if (topic === undefined) {
      fail("usage: lane.mjs dispatch <topic> [--route <name>] [--kind <agent>] [--model <m>] [--env K=V ...] [--arg <raw> ...] [@brief-file | prompt text]");
    }
    const options = { env: [], args: [] };
    const positional = [];
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "--route") options.route = rest[(i += 1)];
      else if (rest[i] === "--model") options.model = rest[(i += 1)];
      else if (rest[i] === "--kind") options.kind = rest[(i += 1)];
      else if (rest[i] === "--env") options.env.push(rest[(i += 1)]);
      else if (rest[i] === "--arg") options.args.push(rest[(i += 1)]);
      else positional.push(rest[i]);
    }
    let promptText;
    if (positional.length > 0) {
      if (positional[0].startsWith("@")) {
        options.briefPath = resolve(CALLER_CWD, positional[0].slice(1));
        try {
          promptText = readFileSync(options.briefPath, "utf8");
        } catch (error) {
          fail(`cannot read dispatch brief ${options.briefPath}: ${error.message}`);
        }
      } else {
        promptText = positional.join(" ");
      }
    }
    dispatch(topic, promptText, options);
    break;
  }
  case "review":
    try {
      await review(topic, rest);
    } catch {
      process.stderr.write(
        "lane review: unexpected failure; private evidence may have been retained and a public record " +
        "may also have been created; retained evidence must be inspected before recovery\n",
      );
      process.exit(2);
    }
    break;
  case "rebase-check": {
    // Control for the promote auto-rebase: exit 0 iff <topic> rebases cleanly
    // onto --against (default main); prints the conflicting files otherwise.
    if (topic === undefined) fail("usage: lane.mjs rebase-check <topic> [--against <ref>]");
    const against = rest[0] === "--against" ? rest[1] : MAIN;
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
    repositoryRoot({ requiredBy: "prepare" });
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
      "usage: lane <open|status|seams|routes|config|dispatch|review|prepare|check|rebase-check|verify-agent|promote|close|board> [topic] [base-ref]\n" +
        `  open <topic> [base]  cut lane/<topic> into a herdr worktree; base defaults to\n` +
        `                       ${MAIN} — pass a kept branch or archive/* tag to resume it\n` +
        "  seams [pattern]  list kept unfinished work (branches + archive tags)\n" +
        "  routes           list configured dispatch routes and resolved defaults\n" +
        "  config           print resolved configuration as key, JSON value, and source\n" +
        "  dispatch <topic> [--route <name>] [--kind <agent>] [--model <m>] [@brief-file | prompt]\n" +
        "                   start a visible agent session (any herdr kind) in the\n" +
        "                   lane's workspace and record display metadata; defaults\n" +
        "                   in .lane.json routes/dispatch\n" +
        "  review <topic> --round N [--brief <path>] [--change <name>]\n" +
        "                   [--route <name>] [--timeout <seconds>]\n" +
        "                   run one foreground independent review; route defaults to\n" +
        "                   review and timeout defaults to 1800 seconds\n" +
        "  prepare <topic>  run .lane.json prepare steps in the lane worktree; a\n" +
        "                   fresh worktree carries no gitignored state, and validation\n" +
        "                   then fails for environmental reasons that look real\n" +
        `  status           list open lanes vs ${MAIN}\n` +
        "  check [--cmd <validate command>]\n" +
        "                   validate this clean worktree and record its HEAD gate\n" +
        "  board [--once | --json | --watch --json | focus <row-id> | done <row-id>]\n" +
        "        [--repo <path>] [--all]\n" +
        "                   open the UI, observe sessions, focus a verified live row,\n" +
        "                   or mark a verified registered row done\n" +
        `  promote <topic>  validate then fast-forward ${MAIN} (clean + rebased + green only)\n` +
        "  close <topic>    remove worktree; delete merged branch or archive-tag unmerged;\n" +
        "                   mark matching display sessions done after git succeeds\n",
    );
    process.exit(1);
}
