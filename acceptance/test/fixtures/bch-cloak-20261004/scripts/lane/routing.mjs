import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROUTING_CONFIG_NAME = "scripts/lane/routing.json";

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertStringArray(value, label) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function validateRoute(route, label) {
  if (route === null || typeof route !== "object" || Array.isArray(route)) {
    throw new Error(`${label} must be an object`);
  }
  for (const field of ["kind", "model", "effort"]) {
    if (route[field] !== undefined) assertString(route[field], `${label}.${field}`);
  }
  if (route.kind !== undefined && !["codex", "claude"].includes(route.kind)) {
    throw new Error(`${label}.kind must be codex or claude`);
  }
  assertStringArray(route.env, `${label}.env`);
  assertStringArray(route.args, `${label}.args`);
  if (route.use !== undefined) assertString(route.use, `${label}.use`);
}

function reservedCodexConfig(expression) {
  if (typeof expression !== "string") return false;
  let normalized = expression.trim();
  if (normalized.startsWith("=")) normalized = normalized.slice(1).trimStart();
  const equals = normalized.indexOf("=");
  if (equals === -1) return false;
  let key = normalized.slice(0, equals).trim();
  if (
    key.length >= 2 &&
    ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))
  ) {
    key = key.slice(1, -1);
  }
  return ["model", "model_reasoning_effort", "profile"].includes(key);
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

export function validateRoutingConfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("routing config must be an object");
  }
  if (config.schema !== 1) throw new Error(`unsupported routing schema: ${config.schema}`);
  assertString(config.authority, "authority");
  validateRoute(config.dispatch, "dispatch");
  for (const field of ["kind", "model", "effort"]) {
    if (config.dispatch[field] === undefined) throw new Error(`dispatch.${field} is required`);
  }
  assertUnreservedArguments(config.dispatch.args ?? [], config.dispatch.kind, "dispatch.args");
  if (config.routes === null || typeof config.routes !== "object" || Array.isArray(config.routes)) {
    throw new Error("routes must be an object");
  }
  for (const [name, route] of Object.entries(config.routes)) {
    assertString(name, "route name");
    validateRoute(route, `routes.${name}`);
    const kind = route.kind ?? config.dispatch.kind;
    assertUnreservedArguments(route.args ?? [], kind, `routes.${name}.args`);
  }
  if (config.always_args !== undefined) {
    if (config.always_args === null || typeof config.always_args !== "object" || Array.isArray(config.always_args)) {
      throw new Error("always_args must be an object");
    }
    for (const [kind, args] of Object.entries(config.always_args)) {
      assertStringArray(args, `always_args.${kind}`);
    }
  }
  return config;
}

export function loadRoutingConfig(repo) {
  const path = join(repo, ROUTING_CONFIG_NAME);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
  return validateRoutingConfig(parsed);
}

export function resolveRouting(config, overrides = {}) {
  for (const field of ["kind", "model", "effort"]) {
    if (Object.hasOwn(overrides, field)) {
      throw new Error(`${field} must be selected by a named route in ${ROUTING_CONFIG_NAME}`);
    }
  }
  const selected = overrides.route === undefined ? {} : config.routes[overrides.route];
  if (overrides.route !== undefined && selected === undefined) {
    throw new Error(`unknown route: ${overrides.route}`);
  }
  const kind = selected.kind ?? config.dispatch.kind;
  const model = selected.model ?? config.dispatch.model;
  const effort = selected.effort ?? config.dispatch.effort;
  assertString(kind, "resolved kind");
  if (!["codex", "claude"].includes(kind)) throw new Error("resolved kind must be codex or claude");
  assertString(model, "resolved model");
  assertString(effort, "resolved effort");
  const routeArgs = selected.args ?? config.dispatch.args ?? [];
  const args = overrides.args?.length > 0 ? overrides.args : routeArgs;
  assertStringArray(args, "resolved args");
  assertUnreservedArguments(args, kind, "resolved args");
  return {
    route: overrides.route,
    kind,
    model,
    effort,
    env: [...(config.dispatch.env ?? []), ...(selected.env ?? []), ...(overrides.env ?? [])],
    args,
    alwaysArgs: config.always_args?.[kind] ?? [],
    use: selected.use,
  };
}

export function nativeAgentArgs(resolved) {
  const args = resolved.kind === "codex"
    ? ["-m", resolved.model, "-c", `model_reasoning_effort=${resolved.effort}`]
    : ["--model", resolved.model, "--effort", resolved.effort];
  args.push(...resolved.args);

  const groups = [];
  for (const token of resolved.alwaysArgs) {
    if (token.startsWith("-") || groups.length === 0) groups.push([token]);
    else groups.at(-1).push(token);
  }
  for (const [option, ...values] of groups) {
    if (!args.some((arg) => arg === option || arg.startsWith(`${option}=`))) {
      args.push(option, ...values);
    }
  }
  return args;
}

export function routingRows(config) {
  return Object.entries(config.routes).map(([name, route]) => {
    const resolved = resolveRouting(config, { route: name });
    return { name, kind: resolved.kind, model: resolved.model, effort: resolved.effort, use: route.use ?? "" };
  });
}
