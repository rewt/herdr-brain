#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { loadRoutingConfig, resolveRouting, ROUTING_CONFIG_NAME } from "./routing.mjs";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// The installed Herdr Monitor release, never the herdr-brain development checkout
// (2026-10-01): herdr/release.sh in herdr-brain points `current` at the active release.
const SETTLE_WATCH = resolve(homedir(), ".local/share/herdr-monitor/current/contrib/settle-watch.mjs");
const SUPERVISOR_ROUTES = new Set(["executive", "settle", "settle-critical"]);

function fail(message) {
  throw new Error(`supervisor launch: ${message}`);
}

export function buildSupervisorInvocation(repo, argv) {
  if (argv[0] !== "--route" || argv[1] === undefined || argv[2] !== "--") {
    fail("usage: launch-supervisor.mjs --route <executive|settle|settle-critical> -- <settle-watch arguments>");
  }
  const routeName = argv[1];
  if (!SUPERVISOR_ROUTES.has(routeName)) fail(`unsupported supervisor route: ${routeName}`);
  const forwarded = argv.slice(3);
  if (forwarded.length === 0) fail("settle-watch arguments are required");
  for (const forbidden of ["--model", "--effort", "--lane-config"]) {
    if (forwarded.includes(forbidden) || forwarded.some((arg) => arg.startsWith(`${forbidden}=`))) {
      fail(`${forbidden} is resolved from ${ROUTING_CONFIG_NAME} and may not be overridden`);
    }
  }

  const config = loadRoutingConfig(repo);
  const selected = resolveRouting(config, { route: routeName });
  const externalBase = routeName === "executive" ? "executive" : "settle";
  const base = resolveRouting(config, { route: externalBase });
  if (selected.kind !== base.kind) {
    fail(`${routeName} kind ${selected.kind} is incompatible with ${externalBase} kind ${base.kind}`);
  }
  const opensExecutive = forwarded.includes("--open");
  if ((routeName === "executive") !== opensExecutive) {
    fail(`${routeName} does not match ${opensExecutive ? "executive" : "settle"} invocation shape`);
  }

  return {
    command: process.execPath,
    args: [
      SETTLE_WATCH,
      ...forwarded,
      "--lane-config", resolve(repo, ROUTING_CONFIG_NAME),
      "--model", selected.model,
      "--effort", selected.effort,
    ],
    route: routeName,
    kind: selected.kind,
    model: selected.model,
    effort: selected.effort,
  };
}

export function main(argv = process.argv.slice(2)) {
  let invocation;
  try {
    invocation = buildSupervisorInvocation(REPO, argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  process.stderr.write(`supervisor route ${invocation.route}: ${invocation.kind} ${invocation.model} ${invocation.effort}\n`);
  const run = spawnSync(invocation.command, invocation.args, { stdio: "inherit" });
  if (run.error !== undefined) {
    process.stderr.write(`supervisor launch failed: ${run.error.message}\n`);
    return 1;
  }
  return run.status ?? 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
