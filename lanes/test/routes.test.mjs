import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from 'node:os';
import { dirname, resolve } from "node:path";
import test from '../../test/helpers/bounded-test.mjs';
import { fileURLToPath } from "node:url";

import { exitCommandFor, loadDiscoveredRoutes, readRoutesConfig, readRoutesSnapshot, resolveLaunchRoute, resolveRoute, selectRoute, validateRoutesConfig } from "../routes.mjs";
import { ROUTE_PRESET } from "../preset.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BCH_ROUTING = resolve(HERE, "fixtures/bch-cloak-routing.json");

test('native exit commands are launch data and unknown kinds have none', () => {
  for (const [kind, command] of [['codex', '/quit'], ['claude', '/exit'], ['unknown', null], ['toString', null]]) {
    assert.equal(exitCommandFor(kind), command);
    assert.equal(resolveLaunchRoute({ dispatch: { kind } }).exit, command);
  }
});

test("planning and Codex review default to Sol xhigh", () => {
  assert.deepEqual(["unblock", "review-codex"].map((route) => { const { model, effort } = resolveLaunchRoute(ROUTE_PRESET, { route }); return [model, effort]; }), [["gpt-6.1-sol", "xhigh"], ["gpt-6.1-sol", "xhigh"]]);
});

test("the bch-cloak route table loads without losing project fields", () => {
  const raw = JSON.parse(readFileSync(BCH_ROUTING, "utf8"));
  const loaded = readRoutesConfig(BCH_ROUTING);
  assert.deepEqual(loaded, raw);
  assert.equal(Object.keys(loaded.routes).length, 23);
  assert.deepEqual(Object.keys(loaded), [
    "schema", "authority", "dispatch", "always_args", "routes", "selection_policy",
  ]);
});

test('an explicitly selected routing file validates its desk references after hand edits', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'route-reference-')), file = resolve(root, 'routing.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { routes: { reviewer: { kind: 'codex' } }, settle: { review_route: 'reviewer' } };
  writeFileSync(file, JSON.stringify(config));
  assert.equal(readRoutesConfig(file).settle.review_route, 'reviewer');
  const loaded = loadDiscoveredRoutes({ cwd: root, file });
  assert.deepEqual(loaded.layers, [{ file, base: root, config }]);
  config.settle.review_route = 'unknown-hand-edit'; writeFileSync(file, JSON.stringify(config));
  assert.throws(() => readRoutesConfig(file), /unknown route: unknown-hand-edit/);
  assert.throws(() => loadDiscoveredRoutes({ cwd: root, file }), /unknown route: unknown-hand-edit/);
});

test('fresh explicit routing cannot claim snapshot scope for identity settings', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'route-identity-')), file = resolve(root, 'routing.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const key of ['launch', 'identity_root', 'defaults_origin', 'project_access', 'brain_write']) {
    const bytes = JSON.stringify({ routes: { engineer: { kind: 'codex' } }, [key]: null });
    writeFileSync(file, bytes);
    assert.throws(() => readRoutesConfig(file), /identity-only settings belong in identity.json/);
    assert.throws(() => loadDiscoveredRoutes({ cwd: root, file }), /identity-only settings belong in identity.json/);
    assert.throws(() => readRoutesSnapshot(file, { cwd: root }), /identity-only settings belong in identity.json/);
    assert.equal(readFileSync(file, 'utf8'), bytes, 'refusal never rewrites the input');
  }
});

test("one resolution supplies launch plumbing and opaque run metadata", () => {
  const config = readRoutesConfig(BCH_ROUTING);
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
  assert.deepEqual(resolved.args, []);
});

test("selection policy uses opaque pool names and only names configured routes", () => {
  const config = readRoutesConfig(BCH_ROUTING);
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




test('retired always_args values parse and never change launch arguments', () => {
  for (const always_args of [null, true, ['bad'], { codex: ['--sandbox', 'danger-full-access'] }]) {
    const config = { routes: { engineer: { kind: 'codex', args: ['-p', 'native'] } }, always_args };
    assert.doesNotThrow(() => validateRoutesConfig(config));
    assert.deepEqual(resolveLaunchRoute(config, { route: 'engineer' }).args, ['-p', 'native']);
  }
});
