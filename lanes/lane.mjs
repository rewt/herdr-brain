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

import { cliHelp } from '../lib/cli-help.mjs';
import { forwardRelease } from '../lib/releases.mjs';
import { createRetirement } from '../lib/retire-runtime.mjs';
import { readyLane } from '../lib/closeout.mjs';
import { retirementHold } from '../lib/retire-hold.mjs';
import { recordInitialShell, claimInitialShell, initialShellLock, recordLaneOpen } from '../lib/initial-shell.mjs';
import { loadTimeout, admissionDeadline } from '../lib/deadline.mjs';
import { waitForMemory } from '../lib/memory.mjs';
import { waitForProvingHold, RESERVATION_WAIT_EXPIRED_CODE } from '../test-slot/reservations.mjs';
import { projectFleet } from '../lib/fleet.mjs';
import { literalLaunch } from '../lib/owner-launch.mjs';
import { homeProject, policyLocation } from '../lib/config-home.mjs';
import { homePolicyLayers, configBase, readPolicyFile, readProjectPolicy } from '../lib/config-policy.mjs';
import { resolveArchive, validateArchive } from '../lib/archive.mjs';
import { hookReviewDialog, codexProfile } from '../dispatch/hook-review.mjs';
import { hookLaunchArguments } from '../messages/hook-session.mjs';
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { acquireLock, PROMOTION_LOCK_WAIT_MS } from "./promotion-lock.mjs";
import { withPromotionGuard } from '../promote/guard.mjs';
import { runTrain } from '../promote/train.mjs';
import { resolveGateProfile, HOST_ENV } from '../promote/gate-profile.mjs';
import { waitForPromotionMemory, refuseBeforeTrain } from '../promote/memory-gate.mjs';
import { ROUTE_PRESET } from './preset.mjs';
import { INHERITED_GATE_NON_CLAIM } from './review-evidence.mjs';
import { writeFileAtomic as writeAgentFileAtomic } from '../lib/files.mjs';
import { VALIDATION_TIERS, resolveValidation, validateValidation, validateTree, validationEnvironment } from './validation.mjs';
import { readReceiptDeclaration, restrictEnvironment, excludedAdditions, requireExactPlan, selectionUnknown } from './exact-validation.mjs';
import { changedPaths, plannedCommand } from '../promote/test-plan.mjs';
import { canonicalTestPlan } from '../settle/test-plan.mjs';

import {
  loadRegistry,
  markTopicSessionsDone,
  newSessionId,
  registryDirectoryFor,
  registryPathFor,
  writeSessionRecord,
} from "./board/registry.mjs";
import { herdrSocketPath } from "./board/herdr-client.mjs";
import {
  readRoutesConfig,
  resolveLaunchRoute,
  routeNames as configuredRouteNames,
  selectRoute,
  validateRoutesConfig,
  standaloneRouting,
} from "./routes.mjs";

cliHelp(import.meta.url, 'Usage: lane open|status|seams|routes|config|dispatch|review|prepare|check|rebase-check|verify-agent|promote|ready|close [TOPIC] [OPTIONS]');
const forwardedRelease = forwardRelease('lanes/lane.mjs', process.cwd());
if (forwardedRelease !== null) process.exit(forwardedRelease);

const IS_REVIEW_COMMAND = process.argv[2] === "review";
const CALLER_CWD = process.cwd();
// An adopted project's native directory, never inherited Git selectors, owns
// its policy and every subsequent Git child. Legacy invocations keep semantics.
if (homeProject(CALLER_CWD)) for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

// Unix readers such as `head` routinely close a pipeline before the producer
// is finished. Treat that as successful early consumption, not a crash.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") {
    process.exit(IS_REVIEW_COMMAND ? 2 : 0);
  }
  throw error;
});

// The repository is whichever checkout the command runs in (any worktree of it).
const REPO = (() => {
  try {
    return realpathSync(execFileSync("git", ["-C", CALLER_CWD, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim());
  } catch (error) {
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
  try {
    const common = execFileSync("git", ["-C", REPO, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    return realpathSync(common);
  } catch {
    fail(`cannot resolve canonical git common directory for ${REPO}`);
  }
})();
const CURRENT_GIT_DIRECTORY = (() => {
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
const FLEET = (() => { try { return projectFleet(REPO_ROOT); } catch (error) { fail(error.message); } })();
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
//   dispatch  {"kind", "model", "effort", "env": ["K=V"], "args": [...]} — global
//             defaults for dispatching a herdr agent session.
//   routes    {"name": {"kind", "model", "effort", "env": ["K=V"], "args": [...],
//             "use": "when to select it"}} — named dispatch defaults;
//             kind/model/effort/args override dispatch, while env is appended.
//             A selected route owns kind/model/effort; use is descriptive only.
//   always_args accepted and ignored (left with the entry layer); put options in
//             a route's args instead.
//   registry  JSON session-metadata path for dispatched agents (default
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
  for (const key of ["kind", "model", "effort", ...(route ? ["use"] : [])]) {
    if (Object.hasOwn(config, key) && typeof config[key] !== "string") {
      fail(`invalid lane config ${file}: ${label}.${key} must be a string`);
    }
  }
  requireStringArray(config, "env", label, file);
  requireStringArray(config, "args", label, file);
}

function validateConfig(config, file) {
  if (!isRecord(config)) fail(`invalid lane config ${file}: top level must be an object`);
  try { validateArchive(config, file); } catch (error) { fail(error.message); }
  if (config.validation !== undefined) {
    try { validateValidation(config.validation); } catch (error) { fail(`invalid lane config ${file}: ${error.message}`); }
  }
  try {
    validateRoutesConfig(config, { references: false });
  } catch (error) {
    fail(`invalid lane config ${file}: ${error.message}`);
  }
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

const HOME_PROJECT = homeProject(REPO_ROOT);
const EXPLICIT_CONFIG = process.env.LANE_CONFIG !== undefined && !HOME_PROJECT;
const REPOSITORY_CONFIG_FILE = policyLocation(REPO_ROOT, 'lane').file;
const PARENT_CONFIG_FILE = EXPLICIT_CONFIG ? undefined : FLEET.fleet ? (FLEET.project ?? FLEET.legacy)?.layers[0] : nearestParentConfig(REPO_ROOT);
const CONFIG_LAYERS = (() => {
  if (EXPLICIT_CONFIG) {
    const file = resolve(CALLER_CWD, process.env.LANE_CONFIG);
    return [{ file, config: readConfig(file, { required: true }) }];
  }
  return homePolicyLayers(REPO_ROOT, FLEET.fleet ? (FLEET.project ?? FLEET.legacy)?.layers ?? [] : [PARENT_CONFIG_FILE]);
})();
const { config: CONFIG, sources: CONFIG_SOURCES, routeSources: ROUTE_SOURCES } = (() => {
  const config = CONFIG_LAYERS.length ? {} : structuredClone(ROUTE_PRESET);
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
if (HOME_PROJECT?.sources.routing) {
  const routing = readProjectPolicy(REPO_ROOT, 'routing');
  const selected = standaloneRouting(CONFIG, routing.config);
  for (const key of Object.keys(CONFIG)) delete CONFIG[key];
  Object.assign(CONFIG, selected);
  for (const key of Object.keys(routing.config)) CONFIG_SOURCES.set(key, routing.file);
  ROUTE_SOURCES.clear();
  for (const name of Object.keys(routing.config.routes ?? {})) ROUTE_SOURCES.set(name, routing.file);
  CONFIG_LAYERS.push({ file: routing.file, base: routing.base, config: routing.config });
}
if (HOME_PROJECT?.defaults.launch) CONFIG.launch = [...HOME_PROJECT.defaults.launch];
if (HOME_PROJECT && !['dispatch', 'routes', 'selection_policy'].some(key => Object.hasOwn(CONFIG, key))) Object.assign(CONFIG, structuredClone(ROUTE_PRESET));
try {
  validateRoutesConfig(CONFIG);
} catch (error) {
  fail(`invalid merged lane config: ${error.message}`);
}
const MAIN = CONFIG.main ?? "main";
const LANE_PREFIX = "lane/";
const REPO_NAME = basename(REPO_ROOT);
const ROOT_IDENTITY = HOME_PROJECT?.owner.root ?? realpathSync(PARENT_CONFIG_FILE === undefined ? dirname(REPO_ROOT) : dirname(PARENT_CONFIG_FILE));
const { path: WORKTREE_ROOT, base: WORKTREE_BASE, source: WORKTREE_ROOT_SOURCE } = (() => {
  if (process.env.LANE_WORKTREE_ROOT !== undefined) {
    const path = resolve(CALLER_CWD, process.env.LANE_WORKTREE_ROOT);
    return { path, base: path, source: "env" };
  }
  // A project's own worktree_root wins over the machine fleet map, so a project moves its lanes by
  // committing its settings. Existing lanes keep their registered paths.
  if (Object.hasOwn(CONFIG, "worktree_root")) {
    const source = CONFIG_SOURCES.get("worktree_root");
    const base = resolve(configBase(source, REPO_ROOT, process.env, 'worktree_root'), CONFIG.worktree_root);
    return { path: join(base, REPO_NAME), base, source };
  }
  if (FLEET.project && !EXPLICIT_CONFIG) return { path: FLEET.project.worktrees, base: FLEET.project.worktrees, source: FLEET.fleet.file };
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
function validationSettings() {
  try { return resolveValidation({ root: REPO_ROOT, config: CONFIG, sources: Object.fromEntries(CONFIG_SOURCES) }); }
  catch (error) { fail(`invalid validation config: ${error.message}`); }
}
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
  return configuredRouteNames(CONFIG);
}

function resolveDispatch(options = {}) {
  try {
    if (options.routeConfig !== undefined && options.route === undefined) fail("--route-config requires --route");
    return resolveLaunchRoute(options.routeConfig === undefined ? CONFIG : readRoutesConfig(options.routeConfig), options);
  } catch (error) {
    fail(error.message);
  }
}

function routeRow(name, prefix = name) {
  const resolved = resolveDispatch({ route: name });
  process.stdout.write(
    `${prefix}\tkind=${resolved.kind}\tmodel=${resolved.model ?? "(none)"}\teffort=${resolved.effort ?? "(none)"}` +
      `\targs=${JSON.stringify(resolved.args)}` +
      `\tuse=${resolved.use ?? "(none)"}\n`,
  );
}

function routes(argv = []) {
  if (argv.length > 0) {
    let taskClass;
    let pool;
    for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index];
      if (!["--for", "--pool"].includes(flag) || argv[index + 1] === undefined || argv[index + 1] === "") {
        fail("usage: lane routes [--for <task-class> [--pool <pool>]]");
      }
      if (flag === "--for") taskClass = argv[(index += 1)];
      else pool = argv[(index += 1)];
    }
    if (taskClass === undefined) fail("--pool requires --for <task-class>");
    let name;
    try {
      name = selectRoute(CONFIG, taskClass, pool);
    } catch (error) {
      fail(error.message);
    }
    routeRow(name, `${taskClass}\tpool=${pool ?? CONFIG.selection_policy?.primary_implementation_pool ?? "(none)"}\troute=${name}`);
    return;
  }
  const names = routeNames();
  if (names.length === 0) fail("no routes configured");
  for (const name of names) routeRow(name);
}

function config() {
  const validation = validationSettings();
  const archive = resolveArchive({ canonical: REPO_ROOT, layers: CONFIG_LAYERS });
  const rows = [
    ["always_args", CONFIG.always_args ?? {}, CONFIG_SOURCES.get("always_args") ?? "default"],
    ["archive directories", archive.dirs, archive.source],
    ["authority", CONFIG.authority ?? null, CONFIG_SOURCES.get("authority") ?? "default"],
    ["dispatch", CONFIG.dispatch ?? {}, CONFIG_SOURCES.get("dispatch") ?? "default"],
    ["main", MAIN, CONFIG_SOURCES.get("main") ?? "default"],
    ["prepare", CONFIG.prepare ?? [], CONFIG_SOURCES.get("prepare") ?? "default"],
    ["registry", CONFIG.registry ?? ".lane/sessions.json", CONFIG_SOURCES.get("registry") ?? "default"],
    ["schema", CONFIG.schema ?? null, CONFIG_SOURCES.get("schema") ?? "default"],
    ["seams_doc", CONFIG.seams_doc ?? null, CONFIG_SOURCES.get("seams_doc") ?? "default"],
    ["selection_policy", CONFIG.selection_policy ?? null, CONFIG_SOURCES.get("selection_policy") ?? "default"],
    [
      "validate",
      process.env.LANE_VALIDATE ?? DEFAULT_VALIDATE,
      process.env.LANE_VALIDATE !== undefined ? "env" : (CONFIG_SOURCES.get("validate") ?? "default"),
    ],
    ["worktree_root", WORKTREE_ROOT, WORKTREE_ROOT_SOURCE],
    ...VALIDATION_TIERS.map(tier => [`validation.${tier}`, validation.tiers[tier].command, validation.tiers[tier].source]),
    ['validation.environment', validation.environment, validation.environment_source],
    ...VALIDATION_TIERS.flatMap(tier => [
      [`validation.${tier}.timeout_seconds`, validation.tiers[tier].timeoutSeconds ?? null, 'resolved'],
      [`validation.${tier}.idle_timeout_seconds`, validation.tiers[tier].idleTimeoutSeconds ?? null, 'resolved'],
    ]),
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
// herdr workspace. Open from the canonical parent explicitly, using its path
// when it has no workspace yet. Retain opaque IDs and verify repository identity.
function ensureHerdrWorkspace(path, label, workspaces, deadline, { created, holdInitial } = {}) {
  // Worktree creation/opening and workspace discovery are separate Herdr
  // snapshots. Refetch here so newly visible metadata is never judged against
  // the caller's pre-creation listing.
  let id = openWorkspaceIdFor(path, { deadline });
  const recordInitial = opened => {
    if (opened?.workspace?.workspace_id !== id) return;
    try {
      const receipt = recordInitialShell({ common: REPO_IDENTITY, cwd: path, created: opened,
        locked: Boolean(holdInitial), deadline, h: args => herdrJson(args, { deadline }) });
      if (!receipt) process.stderr.write('initial shell receipt unavailable; retirement requires the guarded legacy rule\n');
      return receipt;
    } catch (error) { process.stderr.write(`initial shell receipt unavailable: ${error.message}\n`); }
  };
  if (id !== undefined) {
    if (created) recordInitial(created);
    return { workspaceId: id };
  }
  const parent = parentWorkspaceId(workspaces);
  const opened = herdrJson([
    "worktree", "open",
    ...(parent === undefined ? ["--cwd", REPO_ROOT] : ["--workspace", parent]),
    "--path", path, "--label", label, "--no-focus",
  ], { deadline });
  if (opened?.already_open === false && typeof opened.tab?.tab_id === 'string') holdInitial?.(opened.tab.tab_id);
  const refreshed = herdrJson(["workspace", "list"], { deadline })?.workspaces;
  id = openWorkspaceIdFor(path, { workspaces: refreshed, deadline });
  if (id === undefined) return undefined;
  const receipt = opened?.already_open === false ? recordInitial(opened) : null;
  // Only this invocation's native creation reply authorizes initial-pane reuse.
  // In particular, a concurrent opener's already_open reply is not ours.
  const initial = opened?.already_open === false && opened.workspace?.workspace_id === id &&
    opened.tab?.workspace_id === id && opened.root_pane?.workspace_id === id &&
    typeof opened.tab.tab_id === "string" && typeof opened.root_pane.pane_id === "string" &&
    opened.root_pane.tab_id === opened.tab.tab_id
    ? { pane: opened.root_pane.pane_id, tabId: opened.tab.tab_id, receipt }
    : undefined;
  return { workspaceId: id, initial };
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

class NativeAgentIdentityChanged extends Error {
  constructor(agentName, agent) {
    super(`native agent detail identity changed for ${agentName}`);
    this.agent = agent;
  }
}

function sameAgentIdentity(agent, detail) {
  return ["name", "pane_id", "workspace_id"].every(key => agent[key] && detail[key] === agent[key]) &&
    samePath(detail.cwd, agent.cwd) && (!agent.terminal_id || detail.terminal_id === agent.terminal_id) &&
    (!agent.agent || detail.agent === agent.agent) &&
    (!agent.agent_session?.value || detail.agent_session?.value === agent.agent_session.value);
}

function agentRecord(agentName, deadline, requireDetail = false) {
  const listed = herdrJson(["agent", "list"], { deadline });
  const agent = listed?.agents?.find((a) => a.name === agentName);
  if (!agent || (agent.agent_session?.value && !requireDetail)) return agent;
  // The list is a summary; Codex's native session can appear only in detail.
  const detail = herdrJson(["agent", "get", agentName], { deadline })?.agent;
  if (!detail) return requireDetail ? undefined : agent;
  if (!sameAgentIdentity(agent, detail)) throw new NativeAgentIdentityChanged(agentName, agent);
  return { ...agent, ...detail };
}

function retryAgentRecord(agentName, deadline, expected, retryDeadline = deadline) {
  let changed;
  for (;;) {
    if (changed && (retryDeadline === undefined || Date.now() >= retryDeadline)) throw changed;
    try {
      const record = agentRecord(agentName, changed ? retryDeadline : deadline, changed !== undefined);
      if (!changed) return record;
      // Prefer the caller's verified occupant over the racing list row. An
      // unavailable read cannot authorize a summary-only fallback.
      if (record && sameAgentIdentity(expected ?? changed.agent, record) && Date.now() < retryDeadline) return record;
    } catch (error) {
      if (!(error instanceof NativeAgentIdentityChanged)) throw error;
      changed ??= error;
    }
    if (retryDeadline === undefined || Date.now() >= retryDeadline) throw changed;
    sleepMs(Math.min(250, retryDeadline - Date.now()));
  }
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
function verifyAgentCwd(agentName, path, deadline, expected) {
  try {
    const record = retryAgentRecord(agentName, deadline, expected);
    if (record === undefined) return { ok: false, cwd: undefined, record: undefined };
    if (expected && !sameAgentIdentity(expected, record)) throw new NativeAgentIdentityChanged(agentName, expected);
    return { ok: samePath(record.cwd, path), cwd: record.cwd, record };
  } catch (error) {
    if (!(error instanceof NativeAgentIdentityChanged)) throw error;
    return { ok: false, reason: error.message };
  }
}

// Preflight the final trees of `branch` and `against` with merge-tree (no
// worktree touched); intermediate replay can still conflict. Return conflicts
// by file so the implementer sees them. A
// lane that already contains `against` needs no rebase (promote fast-forwards
// it), so only a lane that is behind can be refused for carrying merges.
function rebaseCheck(branch, against = MAIN) {
  const [ahead, behind] = git(["rev-list", "--left-right", "--count", `${branch}...${against}`]).split("\t");
  if (ahead === "0" || behind === "0") return { ahead, behind, clean: true, conflicts: [] };
  if (git(["rev-list", "--merges", `${against}..${branch}`]) !== "") {
    return {
      ahead,
      behind,
      clean: false,
      conflicts: [],
      reason: "merge commit present; plain rebase would linearize and may conflict",
    };
  }
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

function open(topic, base = MAIN, { gitOnly = false } = {}) {
  repositoryRoot({ requiredBy: "open" });
  const branch = laneBranch(topic);
  if (branchExists(branch)) fail(`branch ${branch} already exists; use status/promote/close`);
  if (tryGit(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === undefined) {
    fail(`base ref does not resolve: ${base}`);
  }
  const baseTip = git(['rev-parse', `${base}^{commit}`]);
  const path = join(WORKTREE_ROOT, `lane-${topic}`);
  assertSafeNewWorktreePath(path);
  let workspaces = gitOnly ? [] : herdrJson(["workspace", "list"])?.workspaces ?? [];
  const label = workspaceLabel(topic, path, workspaces);
  const parent = parentWorkspaceId(workspaces);
  const herdr = gitOnly ? undefined : spawnSync(
    "herdr",
    [
      "worktree", "create",
      ...(parent === undefined ? ["--cwd", REPO_ROOT] : ["--workspace", parent]),
      "--branch", branch, "--base", base, "--path", path, "--label", label,
      // Never move the operator's Herdr focus to a new lane.
      "--no-focus",
    ],
    { encoding: "utf8" },
  );
  if (gitOnly || herdr.status !== 0 || !existsSync(path)) {
    git(["worktree", "add", "-b", branch, path, base]);
    if (!gitOnly) process.stdout.write("(herdr refused or is unavailable; created via git worktree)\n");
  } else {
    workspaces = herdrJson(["workspace", "list"])?.workspaces ?? [];
  }
  assertCreatedWorktree(path, branch);
  recordLaneOpen(REPO_IDENTITY, path, baseTip);
  let created;
  if (herdr?.status === 0) try { const parsed = JSON.parse(herdr.stdout); if (!parsed.error) created = parsed.result; } catch {}
  const workspaceId = gitOnly ? undefined : ensureHerdrWorkspace(path, label, workspaces, undefined, { created })?.workspaceId;
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
    gitOnly ? "  herdr workspace: deferred until dispatch\n" : workspaceId === undefined
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
    let rebase = "";
    if (ahead !== "0") {
      const check = behind === "0" ? undefined : rebaseCheck(branch);
      rebase = check === undefined ? "  rebase: current"
        : check.clean ? "  rebase: clean"
        : `  rebase: ${check.reason ?? `CONFLICT ${check.conflicts.join(",")}`}`;
    }
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

// Reusing the initial pane requires POSIX source/export syntax. Inspect the
// actual shell when available, including while an rc child owns the foreground.
// Unknown or non-POSIX shells retain their initial tab and use tab.create's env.
function supportsInitialEnvironment(pane, deadline) {
  const info = herdrJson(["pane", "process-info", "--pane", pane], { deadline })?.process_info;
  const shellProcess = info?.foreground_processes?.find(item => item.pid === info.shell_pid);
  let shell = shellProcess?.name ?? shellProcess?.argv0;
  if (!shell && Number.isSafeInteger(info?.shell_pid) && info.shell_pid > 0) {
    const result = spawnSync("/bin/ps", ["-p", String(info.shell_pid), "-o", "comm="], {
      encoding: "utf8",
      ...(deadline === undefined ? {} : { timeout: Math.max(1, deadline - Date.now()) }),
    });
    if (result.status === 0) shell = result.stdout.trim();
  }
  shell ||= process.env.SHELL;
  return ["sh", "bash", "zsh", "dash", "ash", "ksh"].includes(basename(shell ?? "").replace(/^-/, ""));
}

function dispatch(topic, promptText, options = {}) {
  repositoryRoot({ requiredBy: "dispatch" });
  const branch = laneBranch(topic);
  const resolved = resolveDispatch(options);
  const path = worktreeFor(branch);
  if (path === undefined) fail(`lane ${branch} has no worktree; open it first`);
  // Dispatch is model-agnostic: the tier policy is the operator's, and the
  // operator-owned role->agent mappings live in .lane.json "routes". A named
  // route owns kind/model/effort; extra agent-CLI arguments are launch plumbing
  // passed through via --arg. No config: kind falls back to
  // claude, no model argument is sent.
  let agentArgs = [...resolved.args];
  if (resolved.model !== undefined) agentArgs.push("--model", resolved.model);
  const hasEffort = resolved.kind === "codex"
    ? resolved.args.some((arg, index) => {
      const expression = ["-c", "--config"].includes(arg) ? resolved.args[index + 1] :
        arg.startsWith("--config=") ? arg.slice(9) : arg.startsWith("-c") ? arg.slice(2) : undefined;
      return /^=?\s*model_reasoning_effort\s*=/u.test(expression ?? "");
    })
    : resolved.args.some((arg) => arg === "--effort" || arg.startsWith("--effort="));
  if (resolved.effort !== undefined && (resolved.effortConfigured || !hasEffort)) {
    if (resolved.kind === "codex") agentArgs.push("-c", `model_reasoning_effort=${resolved.effort}`);
    else agentArgs.push("--effort", resolved.effort);
  }
  agentArgs = hookLaunchArguments({ cwd: path, kind: resolved.kind,
    role: IS_REVIEW_COMMAND ? 'reviewer' : 'worker', args: agentArgs,
    env: { ...process.env, ...Object.fromEntries(resolved.env.map(pair => {
      const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)];
    })) } });
  let registryPath;
  try {
    registryPath = preflightRegistryAutomation();
  } catch (error) {
    fail(error.message);
  }
  const workspaces = herdrJson(["workspace", "list"], { deadline: options.deadline })?.workspaces;
  if (workspaces === undefined) fail("herdr is unavailable; dispatch requires the herdr server");
  const label = workspaceLabel(topic, path, workspaces);
  let releaseInitial;
  const unlockInitial = () => {
    process.removeListener('exit', unlockInitial);
    const release = releaseInitial; releaseInitial = undefined; release?.();
  };
  const workspace = ensureHerdrWorkspace(path, label, workspaces, options.deadline, { holdInitial: tab => {
    releaseInitial = initialShellLock(REPO_IDENTITY, tab, { deadline: options.deadline });
    process.once('exit', unlockInitial);
  } });
  const workspaceId = workspace?.workspaceId;
  if (workspaceId === undefined) {
    fail(`herdr shows no open workspace for ${path} and could not open one from the ${REPO_ROOT} workspace`);
  }
  let initial = workspace.initial && supportsInitialEnvironment(workspace.initial.pane, options.deadline)
    ? workspace.initial : undefined;
  // The tab lock protects the unclaimed creation receipt while deciding reuse.
  // A separate-tab fallback leaves this untouched shell eligible for retirement.
  // No recorded receipt needs a claim; native creation still authorizes reuse.
  if (initial?.receipt) try { claimInitialShell(REPO_IDENTITY, initial.tabId, { locked: true }); }
  catch (error) { process.stderr.write(`${error.message}; dispatch will use a separate tab\n`); initial = undefined; }
  let pane = initial?.pane, tabId = initial?.tabId;
  if (initial === undefined) {
    const tabArgs = ["tab", "create", "--workspace", workspaceId, "--label", `agent:${topic}`, "--no-focus"];
    for (const pair of resolved.env) tabArgs.push("--env", pair);
    const created = JSON.parse(execFileSync("herdr", tabArgs, {
      encoding: "utf8",
      ...(options.deadline === undefined ? {} : { timeout: Math.max(1, options.deadline - Date.now()) }),
    }));
    pane = created.result.root_pane.pane_id;
    tabId = created.result.tab.tab_id;
  }
  const failedTab = () => {
    const held = retirementHold(REPO_ROOT);
    if (held) return held;
    if (initial !== undefined) return "initial tab retained";
    spawnSync("herdr", ["tab", "close", tabId], { encoding: "utf8" });
    return "tab closed";
  };
  const cwdAttempts = loadTimeout(60), startAttempts = loadTimeout(20), readyAttempts = loadTimeout(30);
  let paneCwd;
  for (let attempt = 0; attempt < cwdAttempts && (options.deadline === undefined || Date.now() < options.deadline); attempt += 1) {
    paneCwd = herdrJson(["pane", "get", pane], { deadline: options.deadline })?.pane?.foreground_cwd;
    if (samePath(paneCwd, path)) break;
    sleepMs(Math.min(500, Math.max(1, (options.deadline ?? (Date.now() + 500)) - Date.now())));
  }
  if (!samePath(paneCwd, path)) {
    fail(`pane ${pane} shell never reached ${path} (last cwd: ${paneCwd}); ${failedTab()}, nothing started`);
  }
  if (initial !== undefined) {
    // Keep credentials out of shell input, history and terminal scrollback.
    // The private source file also proves the effective exported environment
    // in a child shell; a successful pane.run alone only acknowledges input.
    const pairs = [...resolved.env];
    if (pairs.some(pair => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(pair) || pair.includes("\0"))) {
      fail("initial-pane environment requires NAME=value assignments; initial tab retained, nothing started");
    }
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const effective = new Map(pairs.map(pair => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
    const nonce = `lane-env-${randomBytes(24).toString("hex")}`;
    const directory = mkdtempSync(join(tmpdir(), "herdr-lane-env-"));
    const file = join(directory, "prepare.sh");
    const verifier = join(directory, "verify.sh");
    // The nonce proves shell readiness and exports, even while rc files finish.
    // Share the agent-start allowance rather than imposing a separate 5 s cap.
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + startAttempts * 500);
    let verified = false;
    try {
      const checks = [...effective].map(([key, value]) => `[ "\${${key}+x}" = x ] && [ "$${key}" = ${quote(value)} ]`).join(" && ") || "true";
      writeFileSync(verifier, `${checks} && printf '\\n%s\\n' ${quote(nonce)}\n`, { mode: 0o600, flag: "wx" });
      writeFileSync(file, `set +x\n${pairs.length ? `export ${pairs.map(quote).join(" ")} || return\n` : ""}` +
        `command /bin/sh ${quote(verifier)}\n`, { mode: 0o600, flag: "wx" });
      // Suppress source diagnostics too: an incompatible shell may print the
      // offending assignment. Only the non-secret path enters shell history.
      const prepared = spawnSync("herdr", ["pane", "run", pane,
        ` . ${quote(file)} 2>/dev/null; command rm -f -- ${quote(file)} ${quote(verifier)}`], {
        encoding: "utf8", timeout: Math.max(1, deadline - Date.now()),
      });
      if (prepared.status === 0) {
        while (Date.now() < deadline) {
          const read = spawnSync("herdr", ["pane", "read", pane, "--source", "recent-unwrapped", "--format", "text"], {
            encoding: "utf8", timeout: Math.max(1, deadline - Date.now()),
          });
          if (read.status === 0 && read.stdout.split(/\r?\n/u).includes(nonce)) {
            verified = true;
            break;
          }
          sleepMs(Math.min(100, Math.max(1, deadline - Date.now())));
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    if (!verified) fail(`could not verify initial pane environment ${pane}; initial tab retained, nothing started`);
  }
  // The stem remains readable, while repository identity and random suffixes
  // keep names distinct across equal topics and retry leftovers. Herdr limits
  // names to 32 characters and [a-z][a-z0-9_-]*.
  const liveAgentNames = new Set(
    (herdrJson(["agent", "list"], { deadline: options.deadline })?.agents ?? []).map((agent) => agent.name),
  );
  let agentName = newAgentName(topic, liveAgentNames);
  const startArgsFor = (name) => {
    const args = ["agent", "start", name, "--kind", resolved.kind, "--pane", pane];
    if (agentArgs.length > 0) args.push("--", ...agentArgs);
    return args;
  };
  // The pane's shell needs a moment before it can host an agent; retry
  // instead of dying, and close the orphaned tab if the start never lands.
  let started = false;
  let lastError = "";
  for (let attempt = 0; attempt < startAttempts && !started && (options.deadline === undefined || Date.now() < options.deadline); attempt += 1) {
    // A failed start can leave the name registered, and a start that herdr
    // reports as failed can still have launched the agent in the pane: use a
    // fresh name per attempt and adopt whatever is already running there.
    if (attempt > 0) agentName = newAgentName(topic, liveAgentNames);
    const launchInput = literalLaunch('herdr', startArgsFor(agentName), resolved.launch);
    const run = spawnSync(launchInput.command, launchInput.args, {
      cwd: path,
      encoding: "utf8",
      env: process.env,
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
    fail(`agent start never succeeded (${failedTab()}); last error: ${lastError}`);
  }
  // codex asks to trust a directory it has not seen; accept the preselected
  // "Yes, continue" — the directory is this repository's own worktree.
  const readyDeadline = Math.min(options.deadline ?? Infinity, Date.now() + readyAttempts * 1000);
  let readyRecord;
  for (let attempt = 0; attempt < readyAttempts && Date.now() < readyDeadline; attempt += 1) {
    const visible = spawnSync("herdr", ["agent", "read", agentName, "--source", "visible"], { encoding: "utf8" }).stdout ?? "";
    let observed;
    try {
      observed = retryAgentRecord(agentName, readyDeadline, readyRecord);
      if (readyRecord && observed && !sameAgentIdentity(readyRecord, observed)) {
        throw new NativeAgentIdentityChanged(agentName, readyRecord);
      }
      // Trust prompts can require several polls; keep the first verified occupant.
      readyRecord ??= observed;
    } catch (error) {
      if (!(error instanceof NativeAgentIdentityChanged)) throw error;
      fail(`${error.message}; ${failedTab()}, brief NOT sent`);
    }
    const status = observed?.agent_status;
    if (visible.includes("Do you trust the contents of this directory")) {
      spawnSync("herdr", ["agent", "send-keys", agentName, "Enter"], { encoding: "utf8" });
    } else if (status === "idle" || status === "done" || status === "working") {
      break;
    }
    sleepMs(Math.min(1000, Math.max(1, readyDeadline - Date.now())));
  }
  const cwdCheck = verifyAgentCwd(agentName, path, readyDeadline, readyRecord);
  if (cwdCheck.ok && (cwdCheck.record.pane_id !== pane || cwdCheck.record.workspace_id !== workspaceId)) {
    cwdCheck.ok = false;
    cwdCheck.reason = `native agent detail identity changed for ${agentName}`;
  }
  if (!cwdCheck.ok) {
    if (cwdCheck.reason) fail(`${cwdCheck.reason}; ${failedTab()}, brief NOT sent`);
    fail(`agent '${agentName}' is running in '${cwdCheck.cwd}', not the lane worktree ${path}; ${failedTab()}, brief NOT sent`);
  }
  // The native registry now names this agent in the verified lane pane. The
  // receipt, when claimed, and ordinary occupant guards protect it after lock release.
  unlockInitial();
  let reviewReceipt;
  const deferredReviewReceipt = IS_REVIEW_COMMAND && !cwdCheck.record?.agent_session?.value;
  const recordReviewLaunch = () => {
    // Reviewers have no worker run of their own. Bind their native occupant to
    // the run under review, independently of display metadata. Fresh sessions
    // can only supply this identity after their first prompt.
    try {
      reviewReceipt = createRetirement({ cwd: REPO_ROOT, main: MAIN,
        deadline: Math.min(options.deadline ?? Infinity, Date.now() + 10000) }).recordCallback({
        kind: 'settle', pane, agent: agentName, run: options.run,
      });
    } catch (error) {
      process.stderr.write(`lane review: warning: launch identity could not be recorded (${error.message}); tab retained\n`);
    }
  };
  if (IS_REVIEW_COMMAND && !deferredReviewReceipt) recordReviewLaunch();
  if (promptText !== undefined && promptText.trim() !== "") {
    if (resolved.kind === "codex") {
      const screen = spawnSync("herdr", ["pane", "read", pane, "--source", "visible", "--format", "text"], {
        encoding: "utf8",
        ...(options.deadline === undefined ? {} : { timeout: Math.max(1, options.deadline - Date.now()) }),
      });
      if (screen.status !== 0) {
        fail(`could not read visible screen for live agent '${agentName}' in pane ${pane}; agent retained, brief not sent; inspect the worker before delivering the brief`);
      }
      const dialog = hookReviewDialog(screen.stdout ?? "");
      if (dialog) {
        const profile = codexProfile(agentArgs);
        const scope = profile ? `profile ${JSON.stringify(profile)} (-p ${JSON.stringify(profile)})`
          : "the configured default profile (no -p/--profile in the launch arguments)";
        fail(`Codex hook-review dialog "${dialog}" blocks worker ${agentName} in ${pane}, ${scope}; agent retained, brief not sent. Open /hooks in that worker session and review the hooks in that profile, then deliver the brief to that retained worker with herdr agent prompt. Hook trust is the operator's decision.`);
      }
    }
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
    route: options.route ?? null,
    harness: resolved.kind,
    model: resolved.model ?? null,
    effort: resolved.effort ?? null,
    brief: options.briefPath ?? null,
    goal: dispatchGoal(topic, promptText, options.briefPath),
    report: `docs/reports/${topic}.md`,
    deadline: null,
    done: false,
    created_at: new Date().toISOString(),
  };
  try {
    const beforeSessionId = cwdCheck.record?.agent_session?.value;
    const beforeTerminalId = cwdCheck.record?.terminal_id;
    const hasTerminal = typeof beforeTerminalId === "string" && beforeTerminalId !== "";
    const observe = (deadline, allowUnavailable = false, retryDeadline = deadline) => {
      const live = retryAgentRecord(agentName, deadline, cwdCheck.record, retryDeadline);
      if (live === undefined && allowUnavailable) return undefined;
      if (live === undefined || live.name !== agentName || live.pane_id !== pane ||
          live.workspace_id !== workspaceId || !samePath(live.cwd, path) ||
          cwdCheck.record.pane_id !== pane || cwdCheck.record.workspace_id !== workspaceId) {
        throw new Error("the delivered agent no longer occupies its verified lane pane");
      }
      if ((typeof beforeSessionId === "string" && beforeSessionId !== live.agent_session?.value) ||
          (typeof beforeTerminalId === "string" && beforeTerminalId !== live.terminal_id)) {
        throw new Error("the delivered agent's immutable occupant identity changed");
      }
      return live;
    };
    // Preserve the delivery allowance for the first native read. Only recovery
    // and later session polls share the remaining readiness/observation bound.
    const started = performance.now();
    const deadline = deferredReviewReceipt && hasTerminal
      ? Math.min(options.deadline - REVIEW_SETTLE_MS - 1000, Date.now() + 10000)
      : readyDeadline;
    let liveAfterDelivery = observe(options.deadline, false, deadline);
    if (deferredReviewReceipt && hasTerminal) {
      // Share the saved delivery deadline, leaving time for the review's settled
      // file read. A session that never appears must not consume the review wait.
      while (!liveAfterDelivery.agent_session?.value && Date.now() < deadline && performance.now() - started < 10000) {
        sleepMs(Math.max(0, Math.min(250, deadline - Date.now(), 10000 - (performance.now() - started))));
        if (Date.now() >= deadline || performance.now() - started >= 10000) break;
        const seen = observe(Math.floor(Math.min(deadline, Date.now() + 10000 - (performance.now() - started))), true);
        if (!seen) break;
        if (Date.now() <= deadline && performance.now() - started < 10000) liveAfterDelivery = seen;
      }
    }
    const sessionId = beforeSessionId || (deferredReviewReceipt && hasTerminal
      ? liveAfterDelivery.agent_session?.value : undefined);
    if (typeof sessionId === "string" && sessionId !== "") {
      record.agent_session_id = sessionId;
    }
    if (hasTerminal) {
      record.terminal_id = beforeTerminalId;
    }
    registryPath = preflightRegistryAutomation();
    writeSessionRecord(registryPath, record);
    if (deferredReviewReceipt) {
      if (record.agent_session_id) recordReviewLaunch();
      else process.stderr.write("lane review: warning: native session was not established within the delivery observation bound; tab retained\n");
    }
  } catch (error) {
    const action = promptText !== undefined && promptText.trim() !== ""
      ? "the brief was already sent"
      : "the agent was already started and verified ready";
    fail(
      `partial success: ${action}, but session metadata could not be written (${error.message}); ` +
      `live agent '${agentName}' remains in workspace ${workspaceId} (pane ${pane}); do not replay dispatch`,
    );
  }
  // A retained failed dispatch must still look like the initial shell. Rename
  // only after environment readiness, agent/cwd checks, delivery and recording.
  if (initial !== undefined && herdrJson(["tab", "rename", tabId, `agent:${topic}`], { deadline: options.deadline }) === undefined) {
    fail(`partial success: live agent '${agentName}' was recorded, but initial tab ${tabId} could not be renamed; do not replay dispatch`);
  }
  if (!options.silent) {
    process.stdout.write(
      `dispatched '${agentName}' in herdr workspace ${workspaceId} (pane ${pane})\n` +
        `  watch:  herdr agent read ${agentName}\n` +
        `  steer:  herdr agent attach ${agentName}\n`,
    );
  }
  return {
    agentName, pane, tabId, workspaceId,
    agentSessionId: record.agent_session_id ?? null,
    terminalId: record.terminal_id ?? null,
    cwd: path,
    ...(reviewReceipt ? { reviewReceipt } : {}),
  };
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
    if (['--settle-commits-review', '--followup-expected'].includes(flag)) {
      if (seen.has(flag)) fail(`duplicate review option: ${flag}`);
      seen.add(flag);
      options[flag === '--settle-commits-review' ? 'deferCloseout' : 'followupExpected'] = true;
      continue;
    }
    if (!["--round", "--brief", "--change", "--route", "--route-config", "--timeout", "--run"].includes(flag)) {
      fail(`usage: lane review <topic> --round N [--brief <path>] [--change <name>] [--route <name>] [--route-config <path>] [--timeout <seconds>] [--run R-n [--followup-expected]] (unknown operand: ${flag})`);
    }
    if (seen.has(flag)) fail(`duplicate review option: ${flag}`);
    seen.add(flag);
    const value = args[(index += 1)];
    if (value === undefined || value === "" || value.startsWith("--")) fail(`missing value for ${flag}`);
    if (flag === "--round") options.round = Number(value);
    else if (flag === "--timeout") options.timeout = Number(value);
    else if (flag === "--route-config") options.routeConfig = resolve(CALLER_CWD, value);
    else options[flag.slice(2)] = value;
  }
  if (!Number.isSafeInteger(options.round) || options.round < 1) fail("--round must be a positive safe integer");
  if (options.run !== undefined && !/^R-[1-9]\d*$/u.test(options.run)) fail("--run must be a run id (R-n)");
  if (options.followupExpected && !options.run) fail('--followup-expected requires --run R-n');
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
  if (ignored === false && isIgnored) fail(`${label} must be trackable and not gitignored`);
  return path;
}

function reviewDeliveryPath(path, head, round) {
  // Native workers cannot write canonical .lane/ (and Codex also protects a
  // workspace's .lane/). A self-ignored private directory keeps delivery inside
  // their existing workspace write root without changing Git or sandbox config.
  // Keep it after failure so late evidence and the occupied round survive.
  for (const name of readdirSync(path)) {
    const match = name.match(/^\.lane-review-([0-9a-f]{40})-r[1-9][0-9]*$/u);
    if (match && match[1].slice(0, 7) === head.slice(0, 7) && match[1] !== head) {
      fail(`review abbreviation ${head.slice(0, 7)} is ambiguous with an existing delivery`);
    }
  }
  const directoryRelative = `.lane-review-${head}-r${round}`;
  const directory = assertReviewOutputPath(path, directoryRelative, { label: "private review delivery directory" });
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  return assertReviewOutputPath(path, join(directoryRelative, "record.md"), { ignored: true, label: "private review delivery" });
}

function archivePrivateReview(bytes, deliveryPath, privatePath, privateRelative) {
  // Copy the bytes that were actually validated, rather than renaming a file
  // the reviewer could still replace or append to after the settled read.
  const unchanged = () => {
    const directory = lstatSync(dirname(deliveryPath));
    const entry = lstatSync(deliveryPath);
    return !directory.isSymbolicLink() && directory.isDirectory() &&
      !entry.isSymbolicLink() && entry.isFile() && entry.size === bytes.length &&
      readFileSync(deliveryPath).equals(bytes);
  };
  if (!unchanged()) fail("private review delivery changed after validation; evidence was retained");
  try {
    assertReviewOutputPath(REPO_ROOT, privateRelative, { ignored: true, label: "private review output" });
    mkdirSync(dirname(privatePath), { recursive: true });
    assertReviewOutputPath(REPO_ROOT, privateRelative, { ignored: true, label: "private review output" });
    writeFileSync(privatePath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") fail("private review output appeared concurrently; delivery evidence was retained");
    fail("private review output could not be created exclusively; delivery evidence was retained");
  }
  if (!unchanged()) fail("private review delivery changed during archival; both evidence files were retained");
  unlinkSync(deliveryPath);
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

  // Finding shape is advisory for projection. Validate the section boundary
  // above, then keep unparsed text within that section rather than hiding the
  // review from the worker who needs to act on it.

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
  for (const name of ["Findings", "Non-claims", "Unverified"]) {
    for (const line of sections.get(name).split("\n")) {
      if (name === "Non-claims" && line === INHERITED_GATE_NON_CLAIM) continue;
      for (const match of line.matchAll(/\btests? pass(?:ed|ing)?\b/giu)) {
        const before = line.slice(0, match.index);
        const after = line.slice(match.index + match[0].length);
        const negated = /\b(?:no|not|never)\s*$/iu.test(before) ||
          /^(?:(?![.;]).){0,80}\b(?:not|never)\s+(?:claimed|verified|supported)\b/iu.test(after) ||
          /^(?:(?![.;]).){0,80}\b(?:claim|witness)\b(?:(?![.;]).){0,40}\b(?:absent|missing|unavailable)\b/iu.test(after);
        if (!negated) fail("tests-pass claims are allowed only in witnessed Re-executed entries");
      }
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
  const findings = parsed.sections.get("Findings");
  const sourceFindingLines = findings.split("\n").filter((line) => line.trim() !== "");
  if (sourceFindingLines.length === 0) sourceFindingLines.push("No finding text supplied.");
  const findingLines = findings === "None"
    ? ["None"]
    : sourceFindingLines.map((line) => {
      const match = line.match(/^- \[(Major|Moderate|Minor)\] (.+):([1-9][0-9]*) - (.+); Fix: (.+)$/u);
      if (match === null) {
        // This is prose, never structural metadata. Use the same sanitizer,
        // idempotence check and literal renderer as other public payloads.
        const text = sanitize(line);
        findingPayloads.push(text);
        return `- [Unparsed finding] ${escapeReviewProse(text)}`;
      }
      if (isAbsolute(match[2]) || /^[A-Za-z]:[\\/]/u.test(match[2]) || match[2].split(/[\\/]/u).includes("..")) {
        fail("finding location must be repository-relative");
      }
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
              if (privateReviewIsComplete(settledText)) return { text: settledText, bytes };
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

async function review(topic, args, memoryChecked = false) {
  repositoryRoot({ requiredBy: "review" });
  if (topic === undefined) fail("usage: lane review <topic> --round N [--brief <path>] [--change <name>] [--route <name>] [--route-config <path>] [--timeout <seconds>] [--run R-n [--followup-expected]]");
  const options = parseReviewOptions(args);
  const branch = laneBranch(topic);
  // Explicit route choices must fail before a memory wait. Resolve the implicit
  // default inside dispatch as before, after reading the bundled template, using
  // the same project configuration and portable preset fallback as dispatch.
  if (args.includes('--route') || options.routeConfig !== undefined) {
    resolveDispatch({ route: options.route, routeConfig: options.routeConfig });
  }
  if (!launchMemoryGate('lane review', memoryChecked)) {
    process.exitCode ??= 3;
    return;
  }
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
  const deliveryPath = reviewDeliveryPath(path, head, options.round);
  const prompt = replaceReviewTemplate(template, {
    TOPIC: topic,
    ROUND: String(options.round),
    REVIEW_ID: reviewId,
    REVIEWED_COMMIT: head,
    BASE_BRANCH: MAIN,
    BASE_HEAD: baseHead,
    BASE_COMMIT: baseCommit,
    PRIVATE_RECORD_FILE: deliveryPath,
    PUBLIC_RECORD_FILE: publicPath,
    ROUTE: options.route,
    TIMEOUT_SECONDS: String(options.timeout),
    GATE: gate.prompt,
    INHERITED_GATE_NON_CLAIM,
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
      session = dispatch(topic, prompt, { route: options.route, routeConfig: options.routeConfig, run: options.run, silent: true, deadline });
    } catch (error) {
      fail(`review dispatch failed: ${error.code === "ETIMEDOUT" ? "timeout" : "Herdr command error"}`);
    }
    const { text: record, bytes } = await waitForPrivateReview(deliveryPath, deadline, interrupted, session);
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
    archivePrivateReview(bytes, deliveryPath, privatePath, privateRelative);
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
    if (options.run && session.reviewReceipt) try {
      createRetirement({ cwd: REPO_ROOT, main: MAIN, deadline: Math.min(deadline, Date.now() + 10000) }).recordReviewVerdict({
        pane: session.pane, run: options.run, verdict: parsed.verdict, head, evidence: publicPath,
        deferCloseout: options.deferCloseout,
        followup_expected: options.followupExpected ?? false,
        sha256: createHash('sha256').update(publicRecord).digest('hex'),
      });
    } catch (error) {
      process.stderr.write(`lane review: warning: verdict release evidence could not be recorded (${error.message}); tab retained\n`);
    }
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
function prepareWorktree(path, { quiet = false, env = validationEnvironment(), prepare = CONFIG.prepare ?? [], shell = true } = {}) {
  const say = (m) => { if (!quiet) process.stdout.write(m); };
  for (const step of prepare) {
    if (step.unless !== undefined && existsSync(join(path, step.unless))) continue;
    say(`preparing ${path}: ${step.run}\n`);
    const run = spawnSync(step.run, { cwd: path, env, shell, stdio: "inherit" });
    if (run.status !== 0) fail(`prepare step failed (${step.run}); cannot validate this worktree`);
  }
}

function check(args) {
  repositoryRoot({ requiredBy: "check" });
  let tier = 'fast', override, exactGate = false, requiredTests;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--gate') { exactGate = true; continue; }
    if (!["--cmd", "--tier", "--required-tests"].includes(args[index])) {
      fail(`usage: lane check [--cmd <validate command>] | --gate [--required-tests JSON] (unknown option: ${args[index]})`);
    }
    if (args[index + 1] === undefined || args[index + 1] === "") {
      fail(args[index] === '--required-tests'
        ? "usage: lane check [--cmd <validate command>] | --gate [--required-tests JSON]"
        : "usage: lane check [--cmd <validate command>]");
    }
    if (args[index] === '--tier') tier = args[index + 1];
    else if (args[index] === '--required-tests') {
      if (requiredTests !== undefined) fail('--required-tests may only be specified once');
      try { requiredTests = JSON.parse(args[index + 1]); }
      catch { fail('--required-tests must be a JSON array of test files'); }
      if (!Array.isArray(requiredTests) || requiredTests.length > 512 || requiredTests.some(file => typeof file !== 'string' || !/^[\w./-]+\.test\.mjs$/.test(file) || file.split('/').includes('..') || isAbsolute(file))) fail('invalid required test files');
    } else override = args[index + 1];
    index += 1;
  }
  if (requiredTests !== undefined && !exactGate) fail('--required-tests requires --gate');
  // The train plans the sorted union of the jobs' bound test evidence.
  const required = [...new Set(requiredTests ?? [])].sort();
  if (!['fast', 'promotion'].includes(tier)) fail('lane check tier must be fast or promotion; release gates are run by bash herdr/release.sh build TAG');
  const settings = validationSettings();

  let command = override ?? settings.tiers[tier].command;
  requireClean(REPO, "current worktree");
  const head = git(["rev-parse", "HEAD"]);
  const branch = git(["branch", "--show-current"]);
  if (branch === "") fail("current checkout is detached; check requires a branch");

  let exact, env = validationEnvironment(), prepare = CONFIG.prepare ?? [], environment = settings.environment, profile;
  if (exactGate) {
    try {
      if (override !== undefined || tier !== 'fast') throw Error('--gate cannot be combined with --cmd or --tier');
      const base = git(['rev-parse', MAIN], { cwd: REPO_ROOT });
      if (git(['merge-base', base, head]) !== base) throw Error('EXACT_BASE_BEHIND: lane must contain current canonical main');
      const declaration = readReceiptDeclaration({ repo: REPO_ROOT, base });
      if (!declaration) throw Error('exact validation receipts are not declared by canonical main');
      exact = { base, declaration };
      tier = 'promotion';
      profile = resolveGateProfile(REPO_ROOT);
      if (profile) {
        env = profile.env;
        prepare = [...prepare, ...profile.prepare];
        environment = `${environment}\nprofile:${profile.fingerprint}`;
      }
      env = restrictEnvironment(env, declaration);
      if (!settings.promotion_tests || settings.tiers.promotion.source === 'env') requireExactPlan(settings, null);
    } catch (error) { fail(error.message); }
  }
  prepareWorktree(REPO, { env, prepare, shell: exact ? '/bin/sh' : true });
  if (git(['rev-parse', 'HEAD']) !== head || git(['branch', '--show-current']) !== branch) fail('worktree branch or lane tip changed during preparation');
  if (exact) {
    try {
      const excluded = new Set(excludedAdditions({ repo: REPO, base: exact.base, head, declaration: exact.declaration }));
      const changed = changedPaths(REPO, exact.base, head).filter(name => !excluded.has(name));
      const plan = canonicalTestPlan({ repo: REPO_ROOT, base: exact.base, cwd: REPO, planner: settings.promotion_tests,
        changed, required, baseCommand: settings.tiers.promotion.command, env });
      requireExactPlan(settings, plan);
      const covered = [...plan.files, ...(plan.covered ?? [])];
      if (required.some(file => !covered.includes(file))) throw Error('promotion test plan no longer covers the bound deferred test evidence');
      command = plannedCommand(settings.tiers.promotion.command, plan);
    } catch (error) { fail(error.code === 'SELECTION_UNKNOWN' ? error.message : selectionUnknown(error.message).message); }
  }
  let gate;
  try { gate = validateTree({ cwd: REPO, common: REPO_IDENTITY, command, tier,
    timeoutSeconds: profile?.timeoutSeconds ?? settings.tiers[tier].timeoutSeconds, idleTimeoutSeconds: profile?.idleTimeoutSeconds ?? settings.tiers[tier].idleTimeoutSeconds,
    prepare, environment, env, exact }); }
  catch (error) {
    if (error.exitCode === 75) process.exit(75); // validateTree already emitted its one coded line.
    fail(error.message);
  }
  const directory = join(REPO, ".lane");
  const path = join(directory, "gate.json");
  writeAgentFileAtomic(path, `${JSON.stringify(gate, null, 2)}\n`);
  process.stdout.write(`GATE ${head} exit=${gate.exit_code} (${gate.duration_s.toFixed(3)}s)\n`);
  if (exact) process.stdout.write(`EXACT key=${gate.key} base=${exact.base}\n`);
  // Exit 75 is reserved for a pre-execution slot refusal. Keep the command's
  // real code in the receipt/GATE line, but report a started exit 75 as failure.
  process.exitCode = gate.exit_code === 75 ? 1 : gate.exit_code;
}

function withPromotionLock(operation) {
  let release;
  try { release = acquireLock(join(REPO_IDENTITY, "lane-promote.lock"), { waitMs: PROMOTION_LOCK_WAIT_MS }); }
  catch (error) { fail(error.message); }
  // fail() exits; the exit handler releases ordinary refusals too. Signals leave
  // the lock behind because a validation or lifecycle child may still be alive.
  process.once("exit", release);
  // The opt-in train imports its engine asynchronously under this same lock.
  const finish = () => { process.off("exit", release); release(); };
  let pending = false;
  try {
    const result = operation();
    if (result instanceof Promise) { pending = true; return result.finally(finish); }
    return result;
  } finally { if (!pending) finish(); }
}

function promote(topic, options = {}) {
  const root = repositoryRoot({ requiredBy: "promote" });
  try { waitForPromotionMemory(root); }
  catch (error) {
    if (error.code === RESERVATION_WAIT_EXPIRED_CODE) { deferReservation(error); return; }
    fail(error.message);
  }
  return withPromotionLock(() => promoteLocked(topic, root, options));
}

function promoteLocked(topic, root, options) {
  const branch = laneBranch(topic);
  if (!branchExists(branch)) fail(`no such lane branch: ${branch}`);
  const path = worktreeFor(branch);
  if (path === undefined) fail(`lane ${branch} has no worktree; open one before promoting`);
  const guard = (operation) => {
    try { return withPromotionGuard({ canonical: root, identity: REPO_IDENTITY, workspace: path, topic, ...options }, operation); }
    catch (error) { fail(error.message); }
  };
  guard();
  requireClean(path, "lane worktree");
  requireClean(root, `canonical ${MAIN} checkout`);
  if (tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root }) !== MAIN) {
    fail(`canonical checkout must be on ${MAIN}`);
  }
  if (tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path }) !== branch) {
    fail(`lane worktree must be on ${branch}`);
  }
  let mainHead = git(["rev-parse", MAIN]);
  if (git(["merge-base", MAIN, branch]) !== mainHead) {
    if (options.expectedHead !== undefined) fail(`expected head requires a rebase onto ${MAIN}; rebase, settle and authorize it again; nothing merged`);
    // The net-tree preflight cannot prove that every intermediate commit will
    // replay cleanly. A replay refusal must also reach the supervisor with its
    // file list, leaving the paused rebase available to the implementer.
    const check = rebaseCheck(branch);
    if (!check.clean) {
      const reason = check.reason ?? `conflicts in: ${check.conflicts.join(", ")}`;
      fail(`lane is behind ${MAIN} and does not rebase cleanly; ${reason}`);
    }
    const before = git(["rev-parse", "--short", branch]);
    try {
      git(["rebase", MAIN], { cwd: path });
    } catch (error) {
      if (error.stdout) process.stdout.write(error.stdout);
      const conflicts = tryGit(["diff", "--name-only", "--diff-filter=U"], { cwd: path, silent: true });
      const diagnostic = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.split("\n")
        .filter((line) => /^(CONFLICT|error:|fatal:)/.test(line)).join("; ");
      const reason = conflicts ? `conflicts in: ${conflicts.split("\n").join(", ")}`
        : (diagnostic || error.message).replace(/\s+/g, " ").slice(0, 400);
      fail(`rebase replay onto ${MAIN} failed; ${reason}; lane kept at ${path}; resolve or abort the rebase there before retrying`);
    }
    process.stdout.write(`rebased ${branch} onto ${MAIN} (${before} -> ${git(["rev-parse", "--short", branch])}, clean replay)\n`);
    mainHead = git(["rev-parse", MAIN]);
  }
  prepareWorktree(path);
  guard();
  const settings = validationSettings();
  const validate = settings.tiers.promotion.command;
  process.stdout.write(`validating in ${path}: ${validate}\n`);
  const validatedHead = git(["rev-parse", branch]);
  let gate;
  try { gate = validateTree({ cwd: path, common: REPO_IDENTITY, command: validate, tier: 'promotion', timeoutSeconds: settings.tiers.promotion.timeoutSeconds, idleTimeoutSeconds: settings.tiers.promotion.idleTimeoutSeconds, prepare: CONFIG.prepare ?? [], environment: settings.environment, label: 'validated lane worktree' }); }
  catch (error) {
    if (error.exitCode === 75) process.exit(75);
    fail(error.message);
  }
  // Promotion must also work in a project that has never run lane check and
  // does not ignore .lane/. Its authoritative receipt already lives in Git.
  if (tryGit(['check-ignore', '--quiet', '.lane/gate.json'], { cwd: path, silent: true }) !== undefined) {
    writeAgentFileAtomic(join(path, '.lane', 'gate.json'), JSON.stringify(gate, null, 2) + '\n');
  }
  if (gate.outcome === 'timeout') {
    process.stderr.write(`GATE_TIMEOUT: ${gate.gate_timeout?.kind ?? 'wall'} gate limit exceeded; lane retained for correction; nothing merged\n`);
    process.exit(124);
  }
  if (gate.exit_code !== 0) fail(`validation failed (exit ${gate.exit_code}); nothing merged`);
  // Validation was gated before acquiring the promotion lock. Finish this
  // cheap integration under the lock without waiting on unrelated memory pressure.
  if (git(["rev-parse", MAIN]) !== mainHead) {
    fail(`${MAIN} moved during validation; re-run promote`);
  }
  requireClean(path, "validated lane worktree");
  requireClean(root, `canonical ${MAIN} checkout`);
  if (git(["rev-parse", branch]) !== validatedHead || git(["rev-parse", "HEAD"], { cwd: path }) !== validatedHead ||
      tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path }) !== branch ||
      tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root }) !== MAIN) {
    fail("worktree branch or lane tip changed during validation; re-run promote");
  }
  guard(() => git(["merge", "--ff-only", validatedHead], { cwd: root }));
  process.stdout.write(
    `promoted ${branch}: ${MAIN} ${mainHead.slice(0, 7)} -> ${git(["rev-parse", "--short", MAIN])} (fast-forward)\n`,
  );
  process.stdout.write("No push performed. Close the lane with: lane close " + topic + "\n");
}

function close(topic, options = {}) {
  const held = retirementHold(repositoryRoot({ requiredBy: "close" }));
  if (held) fail(`lane retained: ${held}`);
  return withPromotionLock(() => closeLocked(topic, options));
}

function closeLocked(topic, { gitOnly = false, expectedTip } = {}) {
  const held = retirementHold(REPO_ROOT);
  if (held) fail(`lane retained: ${held}`);
  const branch = laneBranch(topic);
  if (!branchExists(branch)) fail(`no such lane branch: ${branch}`);
  if (expectedTip !== undefined) {
    if (git(["rev-parse", `refs/heads/${branch}`]) !== expectedTip) {
      fail("lane tip changed after promotion; lane kept");
    }
    if (tryGit(["merge-base", "--is-ancestor", expectedTip, MAIN]) === undefined) {
      fail(`lane tip is not contained in ${MAIN}; lane kept`);
    }
  }
  const lane = worktreeFor(branch);
  if (lane !== undefined) requireClean(lane, 'lane worktree');
  const retirement = createRetirement({ cwd: REPO_ROOT, main: MAIN, allowAbsentHerdr: true,
    log: entry => process.stdout.write(JSON.stringify(entry) + '\n') });
  let result;
  try { result = retirement.removeLane({ lane: lane ?? join(WORKTREE_ROOT, `lane-${topic}`), branch, expectedTip, gitOnly }); }
  catch (error) { fail(`lane retained: ${error.message}`); }
  if (lane !== undefined) process.stdout.write(`removed worktree ${lane}\n`);
  if (result.integrated) process.stdout.write(`deleted merged branch ${branch}\n`);
  else process.stdout.write(`archived unmerged lane as tag ${result.archiveTag}, then deleted branch\n`);
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
  if (result.pending.length) fail(`lane closed; workspace cleanup pending: ${result.pending.join('; ')}`);
}

const [command, topic, ...rest] = process.argv.slice(2);
// Parent coordinators may have already waited before saving a launch stage.
// Always check canonical STOP, including when that redundant wait is skipped.
function launchMemoryGate(label, alreadyChecked = false) {
  const reason = 'Supervisor STOP appeared before lane launch; no new worker launched';
  const check = () => {
    if (existsSync(join(REPO_ROOT, '.lane/supervisor/STOP'))) {
      const error = new Error(reason);
      error.code = 'LANE_STOPPED';
      throw error;
    }
  };
  try {
    if (alreadyChecked) check();
    else { waitForProvingHold({ label, check, deadline: admissionDeadline() }); waitForMemory({ label, check }); }
    return true;
  } catch (error) {
    if (error.code === RESERVATION_WAIT_EXPIRED_CODE) return deferReservation(error);
    if (error.code !== 'LANE_STOPPED') throw error;
    process.stderr.write(`${label}: ${reason}\n`);
    process.stdout.write(`${JSON.stringify({ result: 'stopped', reason })}\n`);
    return false;
  }
}

function deferReservation(error) {
  process.stderr.write(`${error.message}\n`);
  process.stdout.write(`${JSON.stringify({ result: 'deferred', code: error.code, reason: error.message, elapsed_ms: error.elapsed_ms })}\n`);
  process.exitCode = 75;
  return false;
}

switch (command) {
  case "config":
    if (topic !== undefined) fail("usage: lane config");
    config();
    break;
  case "check":
    check([topic, ...rest].filter((argument) => argument !== undefined));
    break;
  case "open": {
    const positionals = rest.filter(value => value !== "--git-only");
    if (topic === undefined || positionals.length > 1 || positionals.some(value => value.startsWith("--"))) {
      fail("usage: lane.mjs open <topic> [base-ref] [--git-only]");
    }
    open(topic, positionals[0], { gitOnly: rest.includes("--git-only") });
    break;
  }
  case "status":
    status();
    break;
  case "seams":
    seams(topic);
    break;
  case "routes":
    routes([topic, ...rest].filter((value) => value !== undefined));
    break;
  case "dispatch": {
    if (topic === undefined) {
      fail("usage: lane.mjs dispatch <topic> [--route <name> | --kind <agent> --model <m>] [--env K=V ...] [--arg <raw> ...] [@brief-file | prompt text]");
    }
    const options = { env: [], args: [] };
    const positional = [];
    for (let i = 0; i < rest.length; i += 1) {
      if (["--route", "--route-config", "--model", "--kind", "--env", "--arg"].includes(rest[i]) &&
          (rest[i + 1] === undefined || rest[i + 1] === "")) {
        fail(`${rest[i]} requires a value`);
      }
      if (rest[i] === "--route") options.route = rest[(i += 1)];
      else if (rest[i] === "--route-config") options.routeConfig = resolve(CALLER_CWD, rest[(i += 1)]);
      else if (rest[i] === "--model") options.model = rest[(i += 1)];
      else if (rest[i] === "--kind") options.kind = rest[(i += 1)];
      else if (rest[i] === "--env") options.env.push(rest[(i += 1)]);
      else if (rest[i] === "--arg") options.args.push(rest[(i += 1)]);
      else if (rest[i] === "--json") options.silent = true;
      else if (rest[i] === "--memory-checked") options.memoryChecked = true;
      else positional.push(rest[i]);
    }
    if (options.route !== undefined && (options.kind !== undefined || options.model !== undefined)) {
      fail("--kind and --model cannot override a named route");
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
    laneBranch(topic);
    resolveDispatch(options);
    if (!launchMemoryGate('lane dispatch', options.memoryChecked)) break;
    const result = dispatch(topic, promptText, options);
    if (options.silent) process.stdout.write(`${JSON.stringify(result)}\n`);
    break;
  }
  case "review":
    try {
      await review(topic, rest.filter(arg => arg !== '--memory-checked'), rest.includes('--memory-checked'));
    } catch {
      process.stderr.write(
        "lane review: unexpected failure; private evidence may have been retained and a public record " +
        "may also have been created; retained evidence must be inspected before recovery\n",
      );
      process.exit(2);
    }
    break;
  case "rebase-check": {
    // Control for the promote auto-rebase: exit 0 iff <topic> already contains
    // --against (default main) or would replay onto it cleanly; otherwise print
    // the conflicting files, or the merge-commit reason for a lane that is behind.
    if (topic === undefined) fail("usage: lane.mjs rebase-check <topic> [--against <ref>]");
    const against = rest[0] === "--against" ? rest[1] : MAIN;
    const check = rebaseCheck(laneBranch(topic), against);
    const result = check.clean ? "clean" : (check.reason ?? `CONFLICT ${check.conflicts.join(",")}`);
    process.stdout.write(`${laneBranch(topic)} vs ${against}: +${check.ahead}/-${check.behind} ${result}\n`);
    process.exit(check.clean ? 0 : 1);
  }
  case "verify-agent": {
    // Control for the dispatch cwd guard: exit 0 iff herdr reports the agent's
    // cwd as <path>. `verify-agent <name> /wrong/path` must exit 1.
    const [agentName, expectedPath] = [topic, rest[0]];
    if (agentName === undefined || expectedPath === undefined) fail("usage: lane.mjs verify-agent <agent-name> <worktree-path>");
    const check = verifyAgentCwd(agentName, resolve(expectedPath));
    process.stdout.write(`${check.ok ? "ok" : "MISMATCH"}: agent ${agentName} cwd=${check.cwd} expected=${resolve(expectedPath)}${check.reason ? `; ${check.reason}` : ""}\n`);
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
  case "promote-batch": {
    if (!topic || rest.length) fail('usage: lane promote-batch RECEIPT');
    const root = repositoryRoot({ requiredBy: 'promote' });
    try {
      const profile = resolveGateProfile(root);
      if (profile && process.env[HOST_ENV] !== profile.fingerprint) throw new Error('declared gate profile requires the promotion queue host adapter; enqueue with promote/promote.mjs');
      const refuse = error => {
        if (!['PROMOTION_STOPPED', 'PROMOTION_MEMORY_PRESSURE', RESERVATION_WAIT_EXPIRED_CODE].includes(error.code)) throw error;
        // A resumed train must reconcile its integration checkpoint and apply
        // its own STOP guards. Never replace that receipt with a fresh refusal.
        if (error.code === 'PROMOTION_STOPPED' && JSON.parse(readFileSync(resolve(topic), 'utf8')).attempts?.length) return false;
        refuseBeforeTrain({ file: resolve(topic), identity: REPO_IDENTITY, error });
        process.stderr.write(error.message + '\n');
        if (error.code === RESERVATION_WAIT_EXPIRED_CODE) process.exitCode = 75;
        return true;
      };
      // A profiled batch already owns the external lock and slot here. Its
      // initial memory/reservation wait belongs to the host adapter, before either lock.
      if (!profile) {
        try { waitForPromotionMemory(root); }
        catch (error) { if (refuse(error)) break; }
      }
      await withPromotionLock(() => {
        try { waitForPromotionMemory(root, { held: true }); }
        catch (error) { if (refuse(error)) return; }
        return runTrain({ file: resolve(topic), canonical: root, identity: REPO_IDENTITY,
          main: MAIN, prepare: CONFIG.prepare ?? [], validation: validationSettings() });
      });
    } catch (error) {
      if (error.code === RESERVATION_WAIT_EXPIRED_CODE) deferReservation(error);
      else fail(error.message);
    }
    break;
  }
  case "promote": {
    const usage = 'usage: lane promote <topic> [--expected-head COMMIT] [--if-current-run R-n --org DIR]';
    if (topic === undefined) fail(usage);
    const options = {};
    for (let index = 0; index < rest.length; index++) {
      const key = { '--expected-head': 'expectedHead', '--if-current-run': 'run', '--org': 'org' }[rest[index]];
      if (!key || options[key] !== undefined || rest[index + 1] === undefined) fail(usage);
      options[key] = rest[++index];
    }
    if (options.expectedHead !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(options.expectedHead)) fail(usage);
    if (options.run !== undefined && (!/^R-\d+$/u.test(options.run) || options.expectedHead === undefined || !options.org)) fail(usage);
    if (options.org !== undefined) options.org = realpathSync(resolve(options.org));
    promote(topic, options);
    break;
  }
  case "close": {
    const usage = "usage: lane close <topic> [--git-only] [--expected-tip COMMIT]";
    if (topic === undefined) fail(usage);
    let gitOnly = false, expectedTip;
    for (let index = 0; index < rest.length; index++) {
      if (rest[index] === "--git-only") gitOnly = true;
      else if (rest[index] === "--expected-tip" && expectedTip === undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(rest[index + 1] ?? "")) {
        expectedTip = rest[++index];
      } else fail(usage);
    }
    close(topic, { gitOnly, expectedTip });
    break;
  }
  case 'ready': {
    if (!topic || (rest.length && (rest.length !== 2 || rest[0] !== '--run'))) fail('usage: lane ready <topic> [--run R-n]');
    process.stdout.write(JSON.stringify(readyLane({ cwd: REPO, topic, run: rest[1] })) + '\n');
    break;
  }
  default:
    process.stdout.write(
      "usage: lane <open|status|seams|routes|config|dispatch|review|prepare|check|rebase-check|verify-agent|promote|ready|close> [topic] [base-ref]\n" +
        `  open <topic> [base]  cut lane/<topic> into a herdr worktree; base defaults to\n` +
        `                       ${MAIN} — pass a kept branch or archive/* tag to resume it\n` +
        "  seams [pattern]  list kept unfinished work (branches + archive tags)\n" +
        "  routes [--for <task-class> [--pool <pool>]]\n" +
        "                   list routes, or resolve the configured selection policy\n" +
        "  config           print resolved configuration as key, JSON value, and source\n" +
        "  dispatch <topic> [--route <name> | --kind <agent> --model <m>] [@brief-file | prompt]\n" +
        "                   start a visible agent session (any herdr kind) in the\n" +
        "                   lane's workspace and record display metadata; defaults\n" +
        "                   in .lane.json routes/dispatch\n" +
        "  review <topic> --round N [--brief <path>] [--change <name>]\n" +
        "                   [--route <name>] [--route-config <path>] [--timeout <seconds>]\n" +
        "                   [--run R-n [--followup-expected]]\n" +
        "                   run one foreground independent review; route defaults to\n" +
        "                   review and timeout defaults to 1800 seconds\n" +
        "  prepare <topic>  run .lane.json prepare steps in the lane worktree; a\n" +
        "                   fresh worktree carries no gitignored state, and validation\n" +
        "                   then fails for environmental reasons that look real\n" +
        `  status           list open lanes vs ${MAIN}\n` +
        "  check [--cmd <validate command>] [--tier fast|promotion]\n" +
        "                   validate this clean worktree and record its HEAD gate\n" +
        "                   --tier fast (worker default) or promotion (integration CI); reuse exact trees\n" +
        "  check --gate [--required-tests JSON]\n" +
        "                   plan with the queue's bound test list\n" +
        `  promote <topic>  validate then fast-forward ${MAIN} (clean + rebased + green only)\n` +
        "  ready <topic> [--run R-n]  optionally record the same closeout request as an ingested done report\n" +
        "  close <topic> [--git-only] [--expected-tip COMMIT]  remove worktree; delete merged branch or archive-tag unmerged;\n" +
        "                   mark matching display sessions done after git succeeds\n",
    );
    process.exit(1);
}
