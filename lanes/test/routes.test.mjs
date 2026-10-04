import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from '../../test/helpers/bounded-test.mjs';
import { fileURLToPath } from "node:url";

import { readRoutesConfig, resolveLaunchRoute, resolveRoute, selectRoute, validateRoutesConfig } from "../routes.mjs";
import { ROUTE_PRESET } from "../preset.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(HERE, "../../kit/bch-cloak-20261001/lane/routing.json");

test("planning and Codex review default to Sol xhigh", () => {
  assert.deepEqual(["unblock", "review-codex"].map((route) => { const { model, effort } = resolveLaunchRoute(ROUTE_PRESET, { route }); return [model, effort]; }), [["gpt-6.1-sol", "xhigh"], ["gpt-6.1-sol", "xhigh"]]);
});

test("the bch-cloak route table loads without losing project fields", () => {
  const raw = JSON.parse(readFileSync(KIT, "utf8"));
  const loaded = readRoutesConfig(KIT);
  assert.deepEqual(loaded, raw);
  assert.equal(Object.keys(loaded.routes).length, 23);
  assert.deepEqual(Object.keys(loaded), [
    "schema", "authority", "dispatch", "always_args", "routes", "selection_policy",
  ]);
});

test("one resolution supplies launch plumbing and opaque run metadata", () => {
  const config = readRoutesConfig(KIT);
  const resolved = resolveLaunchRoute(config, { route: "engineer" });
  assert.deepEqual(
    { route: resolved.route, kind: resolved.kind, model: resolved.model, effort: resolved.effort },
    { route: "engineer", kind: "codex", model: "gpt-6.1-sol", effort: "high" },
  );
  for (const route of Object.keys(config.routes)) {
    const metadata = resolveRoute(config, { route });
    const launch = resolveLaunchRoute(config, { route });
    assert.deepEqual(
      [launch.kind, launch.model, launch.effort],
      [metadata.kind, metadata.model, metadata.effort],
      route,
    );
  }
  assert.ok(resolved.env.includes("AI_PERSONA=personal"));
  assert.deepEqual(resolved.args, ["-p", "claude-mem-bastian"]);
});

test("selection policy uses opaque pool names and only names configured routes", () => {
  const config = readRoutesConfig(KIT);
  assert.equal(selectRoute(config, "implementation-narrow"), "engineer-opus");
  assert.equal(selectRoute(config, "implementation-narrow", "codex"), "engineer");

  const missing = structuredClone(config);
  missing.selection_policy.by_task_class.settle.codex = "missing";
  assert.throws(() => validateRoutesConfig(missing), /names unknown route missing/);
});

test("legacy effort arguments remain readable while explicit effort is canonical", () => {
  const legacy = {
    dispatch: { kind: "codex", model: "gpt-x", args: ["-c", "model_reasoning_effort=high"] },
    routes: { engineer: { args: ["-c", "model_reasoning_effort=xhigh"] } },
  };
  assert.equal(resolveRoute(legacy, { route: "engineer" }).effort, undefined);
  assert.equal(resolveLaunchRoute(legacy, { route: "engineer" }).effort, "xhigh");
  assert.equal(resolveLaunchRoute(legacy, { route: "engineer", args: ["--sandbox", "workspace-write"] }).effort, "xhigh");
  assert.equal(resolveLaunchRoute(legacy, { args: ["-c", "model_reasoning_effort=low"] }).effort, "low");
  legacy.routes.engineer.effort = "max";
  assert.equal(resolveRoute(legacy, { route: "engineer" }).effort, "max");
});

test("always_args omits native aliases of emitted Codex model and effort options", () => {
  const config = {
    routes: { engineer: { kind: "codex", model: "route-model", effort: "high" } },
    always_args: { codex: ["-m", "fallback", "--config", "model_reasoning_effort=low", "--sandbox", "workspace-write"] },
  };
  assert.deepEqual(resolveLaunchRoute(config, { route: "engineer" }).args, ["--sandbox", "workspace-write"]);
});

test("Codex always_args preserves unrelated config keys alongside canonical effort", () => {
  const optionForms = (expression) => [
    ["-c", expression], ["--config", expression], [`--config=${expression}`],
    [`-c${expression}`], [`-c=${expression}`],
  ];
  for (const args of [[], ["-c", "model_reasoning_effort=high"]]) {
    for (const unrelated of optionForms("sandbox_workspace_write.network_access=true")) {
      for (const fallback of optionForms(' "model_reasoning_effort" = "low" ')) {
        const config = {
          routes: { engineer: { kind: "codex", model: "route-model", effort: "high", args } },
          always_args: { codex: [...fallback, ...unrelated, "-p", "NAME"] },
        };
        const launch = resolveLaunchRoute(config, { route: "engineer" });
        assert.equal(launch.effort, "high");
        assert.deepEqual(launch.args, [...args, ...unrelated, "-p", "NAME"]);
      }
    }
  }
});

test("Codex always_args deduplicates only the same config key across native aliases", () => {
  const config = {
    routes: { engineer: { kind: "codex", effort: "high", args: ["-c", "sandbox_workspace_write.network_access=false"] } },
    always_args: { codex: [
      "--config", 'sandbox_workspace_write . "network_access" = true',
      "-c", "history.persistence=none",
    ] },
  };
  assert.deepEqual(resolveLaunchRoute(config, { route: "engineer" }).args, [
    "-c", "sandbox_workspace_write.network_access=false", "-c", "history.persistence=none",
  ]);
});
