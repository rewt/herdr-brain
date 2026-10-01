import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

function withAlwaysArgs(args, always) {
  const supplied = (option) => args.some((arg) => arg === option || arg.startsWith(`${option}=`));
  return [...args, ...optionGroups(always).filter(([option]) => !supplied(option)).flat()];
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

export function routeNames(config) {
  return Object.keys(config.routes ?? {}).sort();
}

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
  const effort = selected.effort ?? defaults.effort ?? effortFromArgs(kind, routeArgs);
  return {
    route: options.route,
    kind,
    model,
    effort,
    effortConfigured,
    args: withAlwaysArgs(routeArgs, config.always_args?.[kind] ?? []),
    env: [...(defaults.env ?? []), ...(selected.env ?? []), ...(options.env ?? [])],
    use: selected.use,
  };
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
    parsed = JSON.parse(readFileSync(file, "utf8"));
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
  const top = realpathSync(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
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
export function loadDiscoveredRoutes({ cwd = process.cwd(), file = process.env.LANE_CONFIG } = {}) {
  if (file !== undefined) {
    const absolute = resolve(cwd, file);
    return { config: readRoutesConfig(absolute), files: [absolute] };
  }
  let repository;
  try {
    repository = canonicalCheckout(cwd);
  } catch {
    throw new Error("cannot find route config outside a Git checkout; set LANE_CONFIG or pass --route-config");
  }
  const files = [nearestParentConfig(repository), join(repository, ".lane.json")].filter((candidate) => candidate && existsSync(candidate));
  if (files.length === 0) throw new Error(`no route config found for ${repository}`);
  return { config: mergeRoutesConfig(files.map(readRoutesConfig)), files };
}
