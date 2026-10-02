import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readPlainFile } from '../lib/files.mjs';
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ROUTE_PRESET } from './preset.mjs';

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
}

function strings(value, label) {
  if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function routeShape(route, label) {
  if (!record(route)) throw new Error(`${label} must be an object`);
  for (const key of ["kind", "model", "effort", "use"]) {
    if (route[key] !== undefined) string(route[key], `${label}.${key}`);
  }
  strings(route.env, `${label}.env`);
  strings(route.args, `${label}.args`);
}

function selectionPolicy(config, { references = true } = {}) {
  const policy = config.selection_policy;
  if (policy === undefined) return;
  if (!record(policy)) throw new Error("selection_policy must be an object");
  const primary = policy.primary_implementation_pool;
  if (primary !== undefined) string(primary, "selection_policy.primary_implementation_pool");
  if (!record(policy.by_task_class)) throw new Error("selection_policy.by_task_class must be an object");
  for (const [taskClass, choice] of Object.entries(policy.by_task_class)) {
    string(taskClass, "selection_policy task class");
    if (typeof choice === "string") {
      if (references && !Object.hasOwn(config.routes, choice)) throw new Error(`selection_policy.${taskClass} names unknown route ${choice}`);
      continue;
    }
    if (!record(choice) || Object.keys(choice).length === 0) {
      throw new Error(`selection_policy.${taskClass} must be a route name or a non-empty pool map`);
    }
    for (const [pool, route] of Object.entries(choice)) {
      string(pool, `selection_policy.${taskClass} pool`);
      string(route, `selection_policy.${taskClass}.${pool}`);
      if (references && !Object.hasOwn(config.routes, route)) {
        throw new Error(`selection_policy.${taskClass}.${pool} names unknown route ${route}`);
      }
    }
    if (primary !== undefined && !Object.hasOwn(choice, primary)) {
      throw new Error(`selection_policy.${taskClass} has no ${primary} pool`);
    }
  }
}

// Validates only routing-owned fields. Other .lane.json keys belong to the lane
// lifecycle and pass through untouched.
export function validateRoutesConfig(config, options = {}) {
  if (!record(config)) throw new Error("route config must be an object");
  if (config.schema !== undefined && config.schema !== 1) {
    throw new Error(`unsupported route schema: ${config.schema}`);
  }
  if (config.authority !== undefined) string(config.authority, "authority");
  if (config.dispatch !== undefined) routeShape(config.dispatch, "dispatch");
  if (config.routes !== undefined && !record(config.routes)) throw new Error("routes must be an object");
  for (const [name, route] of Object.entries(config.routes ?? {})) {
    string(name, "route name");
    routeShape(route, `routes.${name}`);
  }
  if (config.always_args !== undefined) {
    if (!record(config.always_args)) throw new Error("always_args must be an object");
    for (const [kind, args] of Object.entries(config.always_args)) {
      string(kind, "always_args kind");
      strings(args, `always_args.${kind}`);
      if (args[0] !== undefined && !args[0].startsWith("-")) {
        throw new Error(`always_args.${kind} must start with an option`);
      }
    }
  }
  selectionPolicy({ ...config, routes: config.routes ?? {} }, options);
  return config;
}

export function mergeRoutesConfig(configs) {
  const merged = {};
  for (const config of configs) {
    validateRoutesConfig(config, { references: false });
    for (const key of ["schema", "authority", "dispatch", "always_args", "selection_policy"]) {
      if (Object.hasOwn(config, key)) merged[key] = config[key];
    }
    if (Object.hasOwn(config, "routes")) merged.routes = { ...(merged.routes ?? {}), ...config.routes };
  }
  return validateRoutesConfig(merged);
}

function optionGroups(args) {
  const groups = [];
  for (const token of args) {
    if (token.startsWith("-") || groups.length === 0) groups.push([token]);
    else groups.at(-1).push(token);
  }
  return groups;
}

function codexConfigExpression(token, value) {
  if (["-c", "--config"].includes(token)) return value;
  if (token.startsWith("--config=")) return token.slice(9);
  if (token.startsWith("-c")) return token.slice(2);
  return undefined;
}

function withAlwaysArgs(args, always, emitted = [], kind) {
  const present = [...args, ...emitted];
  const presentGroups = optionGroups(present);
  const supplied = ([option, value]) => {
    if (kind === "codex") {
      const key = codexConfigKey(codexConfigExpression(option, value));
      if (key !== undefined) {
        // Codex config flags are repeatable: supplying one key does not supply
        // all the other defaults, even when both use the same -c/--config flag.
        return presentGroups.some(([token, expression]) =>
          codexConfigKey(codexConfigExpression(token, expression)) === key);
      }
    }
    return present.some((arg) => arg === option || arg.startsWith(`${option}=`));
  };
  return [...args, ...optionGroups(always).filter((group) => !supplied(group)).flat()];
}

function effortFromArgs(kind, args) {
  if (kind === "codex") {
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index];
      const expression = ["-c", "--config"].includes(token) ? args[index + 1] :
        token.startsWith("--config=") ? token.slice(9) : token.startsWith("-c") ? token.slice(2) : undefined;
      const match = expression?.match(/^=?\s*model_reasoning_effort\s*=\s*(\S+)\s*$/u);
      if (match) return match[1];
    }
  }
  const index = args.findIndex((arg) => arg === "--effort");
  return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith("--effort="))?.slice(9);
}

function codexConfigKey(expression) {
  if (typeof expression !== "string") return undefined;
  let normalized = expression.trim();
  if (normalized.startsWith("=")) normalized = normalized.slice(1).trimStart();
  const equals = normalized.indexOf("=");
  if (equals === -1) return undefined;
  // Normalize both a quoted whole key and quoted dotted-key segments. Only
  // key identity is needed here; the value stays opaque and passes unchanged.
  return normalized.slice(0, equals).trim().split(".")
    .map((segment) => segment.trim().replace(/^["']|["']$/gu, ""))
    .join(".");
}

function reservedCodexConfig(expression) {
  const key = codexConfigKey(expression);
  return key !== undefined && (
    ["model", "model_reasoning_effort", "profile", "profiles"].includes(key) ||
    key.startsWith("profiles.")
  );
}

function reservedArgument(args, kind) {
  const exact = kind === "codex"
    ? new Set(["-m", "--model", "-p", "--profile"])
    : new Set(["--model", "--effort", "--plugin-dir"]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (exact.has(option) || [...exact].some((name) => option.startsWith(`${name}=`))) return option;
    if (kind === "codex" && (/^-m.+/u.test(option) || /^-p.+/u.test(option))) return option;
    if (kind === "codex" && ["-c", "--config"].includes(option)) {
      const value = args[index + 1];
      if (reservedCodexConfig(value)) return `${option} ${value}`;
      index += 1;
    }
    if (kind === "codex" && option.startsWith("--config=") && reservedCodexConfig(option.slice(9))) return option;
    if (kind === "codex" && option.startsWith("-c") && reservedCodexConfig(option.slice(2))) return option;
  }
  return undefined;
}

function assertUnreservedArguments(args, kind, label) {
  const collision = reservedArgument(args, kind);
  if (collision !== undefined) {
    throw new Error(`${label} may not override canonical model, effort, profile, or plugin arguments: ${collision}`);
  }
}

export function routeNames(config) {
  return Object.keys(config.routes ?? {}).sort();
}

// Record callers copy declared metadata only; native CLI interpretation belongs
// exclusively to resolveLaunchRoute below.
export function resolveRoute(config, options = {}) {
  validateRoutesConfig(config);
  const defaults = config.dispatch ?? {};
  let selected = {};
  if (options.route !== undefined) {
    selected = config.routes?.[options.route];
    if (selected === undefined) {
      const names = routeNames(config);
      throw new Error(`unknown route: ${options.route} (${names.length ? `configured: ${names.join(", ")}` : "none configured"})`);
    }
  }
  const kind = options.kind ?? selected.kind ?? defaults.kind ?? "claude";
  const model = options.model ?? selected.model ?? defaults.model;
  const routeArgs = options.args?.length ? options.args : (selected.args ?? defaults.args ?? []);
  const effortConfigured = selected.effort !== undefined || defaults.effort !== undefined;
  const effort = selected.effort ?? defaults.effort;
  return {
    route: options.route,
    kind,
    model,
    effort,
    effortConfigured,
    args: [...routeArgs],
    env: [...(defaults.env ?? []), ...(selected.env ?? []), ...(options.env ?? [])],
    use: selected.use,
  };
}

// Lane-only compatibility and launch plumbing. Infer from configured arguments,
// never overrides of a named route, so replacing plumbing cannot change metadata.
export function resolveLaunchRoute(config, options = {}) {
  if (options.route !== undefined) {
    for (const field of ["kind", "model", "effort"]) {
      if (options[field] !== undefined) throw new Error(`--route cannot be combined with --${field}`);
    }
  }
  const resolved = resolveRoute(config, options);
  if (options.route !== undefined && options.args?.length) {
    assertUnreservedArguments(options.args, resolved.kind, "--arg");
  }
  const inferenceArgs = options.route === undefined
    ? resolved.args
    : resolveRoute(config, { route: options.route }).args;
  resolved.effort ??= effortFromArgs(resolved.kind, inferenceArgs);
  const emitted = [];
  if (resolved.model !== undefined) {
    emitted.push("--model");
    if (resolved.kind === "codex") emitted.push("-m");
  }
  if (resolved.effort !== undefined) {
    emitted.push(...(resolved.kind === "codex" ? ["-c", `model_reasoning_effort=${resolved.effort}`] : ["--effort"]));
  }
  resolved.args = withAlwaysArgs(resolved.args, config.always_args?.[resolved.kind] ?? [], emitted, resolved.kind);
  return resolved;
}

export function selectRoute(config, taskClass, pool) {
  validateRoutesConfig(config);
  const policy = config.selection_policy;
  if (policy === undefined) throw new Error("no selection_policy configured");
  const choice = policy.by_task_class[taskClass];
  if (choice === undefined) throw new Error(`unknown task class: ${taskClass}`);
  if (typeof choice === "string") return choice;
  const selectedPool = pool ?? policy.primary_implementation_pool;
  if (selectedPool === undefined) throw new Error(`task class ${taskClass} requires --pool`);
  if (!Object.hasOwn(choice, selectedPool)) throw new Error(`task class ${taskClass} has no ${selectedPool} pool`);
  return choice[selectedPool];
}

export function readRoutesConfig(file) {
  let parsed;
  try {
    parsed = JSON.parse(readPlainFile(file));
  } catch (error) {
    throw new Error(`cannot read route config ${file}: ${error.message}`);
  }
  return validateRoutesConfig(parsed);
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

function canonicalCheckout(cwd) {
  const top = realpathSync(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
  const common = realpathSync(execFileSync("git", ["-C", top, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
  const gitDir = realpathSync(execFileSync("git", ["-C", top, "rev-parse", "--path-format=absolute", "--git-dir"], { encoding: "utf8" }).trim());
  if (common === gitDir) return top;
  const listed = execFileSync("git", ["-C", top, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  for (const entry of listed.split("\n\n")) {
    const candidate = entry.split("\n").find((line) => line.startsWith("worktree "))?.slice(9);
    if (!candidate) continue;
    try {
      const candidateGit = realpathSync(execFileSync("git", ["-C", candidate, "rev-parse", "--path-format=absolute", "--git-dir"], { encoding: "utf8" }).trim());
      if (candidateGit === common) return realpathSync(candidate);
    } catch {}
  }
  return top;
}

// Finds the same parent/repository .lane.json layers as lane. An explicit file
// selects one layer, which is useful for projects that keep routing.json apart.
export function loadDiscoveredRoutes({ cwd = process.cwd(), env = process.env, file = env.LANE_CONFIG } = {}) {
  if (file !== undefined) {
    const absolute = resolve(cwd, file);
    return { config: readRoutesConfig(absolute), files: [absolute] };
  }
  let repository;
  try {
    repository = canonicalCheckout(cwd);
  } catch {
    const directory = realpathSync(cwd);
    const local = join(directory, ".lane.json");
    const nearest = existsSync(local) ? local : nearestParentConfig(directory);
    if (!nearest) return { config: structuredClone(ROUTE_PRESET), files: [], suggested: true };
    return { config: readRoutesConfig(nearest), files: [nearest] };
  }
  const files = [nearestParentConfig(repository), join(repository, ".lane.json")].filter((candidate) => candidate && existsSync(candidate));
  if (files.length === 0) return { config: structuredClone(ROUTE_PRESET), files, suggested: true };
  return { config: mergeRoutesConfig(files.map(readRoutesConfig)), files };
}
