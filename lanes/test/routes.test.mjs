import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readRoutesConfig, resolveRoute, selectRoute, validateRoutesConfig } from "../routes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(HERE, "../../kit/bch-cloak-20261001/lane/routing.json");

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
  const resolved = resolveRoute(config, { route: "engineer" });
  assert.deepEqual(
    { route: resolved.route, kind: resolved.kind, model: resolved.model, effort: resolved.effort },
    { route: "engineer", kind: "codex", model: "gpt-6.1-sol", effort: "high" },
  );
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
  assert.equal(resolveRoute(legacy, { route: "engineer" }).effort, "xhigh");
  legacy.routes.engineer.effort = "max";
  assert.equal(resolveRoute(legacy, { route: "engineer" }).effort, "max");
});
