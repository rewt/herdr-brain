import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRoutingConfig,
  nativeAgentArgs,
  resolveRouting,
  routingRows,
  validateRoutingConfig,
} from "./routing.mjs";
import { buildSupervisorInvocation } from "./launch-supervisor.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the canonical routing table encodes the risk-tiered policy", () => {
  const config = loadRoutingConfig(REPO);
  const expected = {
    chore: ["gpt-5.6-terra", "medium"],
    engineer: ["gpt-6.1-sol", "high"],
    "engineer-xhigh": ["gpt-6.1-sol", "xhigh"],
    review: ["gpt-6.1-sol", "high"],
    "review-critical": ["gpt-6.1-sol", "xhigh"],
    "review-escalate": ["gpt-6-astra", "xhigh"],
    unblock: ["gpt-6-astra", "xhigh"],
    "research-opus-max": ["claude-opus-5-5", "max"],
    "research-astra-max": ["gpt-6-astra", "max"],
    "research-sol-max": ["gpt-6.1-sol", "max"],
    "engineer-opus": ["claude-opus-5-5", "high"],
    "engineer-opus-xhigh": ["claude-opus-5-5", "xhigh"],
    "engineer-astra": ["gpt-6-astra", "xhigh"],
    "review-critical-astra": ["gpt-6-astra", "max"],
    settle: ["gpt-6.1-sol", "high"],
    executive: ["gpt-6.1-sol", "high"],
    monitor: ["gpt-5.6-luna", "low"],
  };
  for (const [name, [model, effort]] of Object.entries(expected)) {
    const resolved = resolveRouting(config, { route: name });
    assert.equal(resolved.model, model, name);
    assert.equal(resolved.effort, effort, name);
  }
  assert.equal(config.routes["review-codex"], undefined, "the contradictory legacy Astra-first review route is absent");
});

test("native arguments are derived from model and effort exactly once", () => {
  const config = loadRoutingConfig(REPO);
  assert.deepEqual(nativeAgentArgs(resolveRouting(config, { route: "review" })), [
    "-m", "gpt-6.1-sol",
    "-c", "model_reasoning_effort=high",
    "-p", "claude-mem-bastian",
  ]);
  assert.deepEqual(nativeAgentArgs(resolveRouting(config, { route: "review-critical-opus" })), [
    "--model", "claude-opus-5-5",
    "--effort", "xhigh",
    "--plugin-dir", "/Users/rewt/development/claude-mem/adapters/claude-bastian",
  ]);
});

test("launch-plumbing overrides do not mutate the canonical route", () => {
  const config = loadRoutingConfig(REPO);
  const resolved = resolveRouting(config, {
    route: "engineer",
    env: ["SLICE_TEST=1"],
    args: ["--temporary"],
  });
  assert.equal(resolved.model, "gpt-6.1-sol");
  assert.equal(resolved.effort, "high");
  assert.ok(resolved.env.includes("SLICE_TEST=1"));
  assert.deepEqual(resolved.args, ["--temporary"]);
  assert.equal(resolveRouting(config, { route: "engineer" }).model, "gpt-6.1-sol");
});

test("unsupported and authority-colliding launch overrides fail closed", () => {
  const config = loadRoutingConfig(REPO);
  for (const [field, value] of [["kind", "gemini"], ["model", "shadow"], ["effort", "low"]]) {
    assert.throws(
      () => resolveRouting(config, { route: "review", [field]: value }),
      new RegExp(`${field} must be selected by a named route`),
    );
  }
  for (const args of [
    ["-m", "shadow-model"],
    ["-mshadow-model"],
    ["-m=shadow-model"],
    ["--model=shadow-model"],
    ["-c", "model=shadow-model"],
    ["-cmodel=shadow-model"],
    ["-c=model=shadow-model"],
    ["--config", "model=shadow-model"],
    ["--config=model=shadow-model"],
    ["-c", "model_reasoning_effort=low"],
    ["-cmodel_reasoning_effort=low"],
    ["-c=model_reasoning_effort=low"],
    ["-c", "model_reasoning_effort = low"],
    ["--config=model_reasoning_effort=low"],
    ["-p", "shadow-profile"],
    ["-pshadow-profile"],
    ["-p=shadow-profile"],
    ["-c", "profile=shadow-profile"],
  ]) {
    assert.throws(
      () => resolveRouting(config, { route: "review", args }),
      /may not override canonical model, effort, profile, or plugin arguments/,
    );
  }
  assert.throws(
    () => resolveRouting(config, { route: "review-opus", args: ["--plugin-dir", "/tmp/shadow"] }),
    /may not override canonical model, effort, profile, or plugin arguments/,
  );
});

test("unknown routes fail closed", () => {
  const config = loadRoutingConfig(REPO);
  assert.throws(() => resolveRouting(config, { route: "review-codex" }), /unknown route: review-codex/);
});

test("malformed routes fail validation", () => {
  const config = structuredClone(loadRoutingConfig(REPO));
  config.routes.review.effort = [];
  assert.throws(() => validateRoutingConfig(config), /routes\.review\.effort must be a non-empty string/);
});

test("unsupported agent kinds fail validation", () => {
  const config = structuredClone(loadRoutingConfig(REPO));
  config.routes.review.kind = "unknown";
  assert.throws(() => validateRoutingConfig(config), /routes\.review\.kind must be codex or claude/);
});

test("route listing exposes every selection criterion", () => {
  const config = loadRoutingConfig(REPO);
  const rows = routingRows(config);
  assert.equal(rows.length, Object.keys(config.routes).length);
  assert.ok(rows.every((row) => row.use.length > 0));
});

test("supervisor launchers and runbook consume the canonical route table", () => {
  const continueScript = readFileSync(resolve(REPO, ".lane/supervisor/continue.sh"), "utf8");
  const watchScript = readFileSync(resolve(REPO, ".lane/supervisor/arm-watch.sh"), "utf8");
  const runbook = readFileSync(resolve(REPO, ".lane/supervisor/SETTLE.md"), "utf8");
  for (const script of [continueScript, watchScript]) {
    assert.match(script, /scripts\/lane\/launch-supervisor\.mjs/);
    assert.doesNotMatch(script, /\$BASTIAN\/\.lane\.json/);
    assert.doesNotMatch(script, /settle-watch\.mjs/);
  }
  assert.match(runbook, /node scripts\/lane\/lane\.mjs routes/);
  assert.match(runbook, /dispatch <topic> --route "\$ROUTE"/);
  assert.doesNotMatch(runbook, /dispatch-defaults|gpt-[0-9]|model_reasoning_effort|\b(?:Opus|Astra|Fable|Terra)\b/);
});

test("supervisor wrapper validates and resolves routine and critical routes", () => {
  const routine = buildSupervisorInvocation(REPO, ["--route", "settle", "--", "R-1", "--org", "/tmp/org"]);
  const critical = buildSupervisorInvocation(REPO, ["--route", "settle-critical", "--", "R-1", "--org", "/tmp/org"]);
  const executive = buildSupervisorInvocation(REPO, ["--route", "executive", "--", "--open", "--org", "/tmp/org"]);
  assert.equal(routine.effort, "high");
  assert.equal(critical.effort, "xhigh");
  assert.equal(executive.route, "executive");
  for (const invocation of [routine, critical, executive]) {
    assert.equal(invocation.args.filter((arg) => arg === "--lane-config").length, 1);
    assert.equal(invocation.args.filter((arg) => arg === "--model").length, 1);
    assert.equal(invocation.args.filter((arg) => arg === "--effort").length, 1);
  }
  assert.throws(
    () => buildSupervisorInvocation(REPO, ["--route", "settle", "--", "R-1", "--effort", "low"]),
    /--effort is resolved .* and may not be overridden/,
  );
  assert.throws(
    () => buildSupervisorInvocation(REPO, ["--route", "settle-critical", "--", "--open"]),
    /does not match executive invocation shape/,
  );
});

test("supervisor wrapper rejects malformed canonical configuration before launch", () => {
  const root = mkdtempSync(resolve(tmpdir(), "bch-cloak-routing-test-"));
  mkdirSync(resolve(root, "scripts/lane"), { recursive: true });
  const config = structuredClone(loadRoutingConfig(REPO));
  delete config.routes.settle;
  writeFileSync(resolve(root, "scripts/lane/routing.json"), JSON.stringify(config));
  assert.throws(
    () => buildSupervisorInvocation(root, ["--route", "settle", "--", "R-1"]),
    /unknown route: settle/,
  );
});

test("active lane skill names routes and contains no competing policy", () => {
  const skill = readFileSync(resolve(REPO, ".claude/skills/lane/SKILL.md"), "utf8");
  assert.match(skill, /lane\.mjs dispatch <topic> --route <name>/);
  assert.match(skill, /lane\.mjs routes/);
  assert.match(skill, /Environment.*outside that routing authority/s);
  assert.doesNotMatch(skill, /dispatch-defaults|maximum reasoning|codex 5\.6|claude opus/i);
});

test("malformed dispatch option values fail before Herdr mutation", () => {
  for (const flag of ["--route", "--env", "--arg"]) {
    const run = spawnSync(process.execPath, [resolve(REPO, "scripts/lane/lane.mjs"), "dispatch", "unused-topic", flag], {
      cwd: REPO,
      encoding: "utf8",
    });
    assert.equal(run.status, 1, flag);
    assert.match(run.stderr, new RegExp(`${flag} requires (?:a route name|a value)`), flag);
  }
  for (const flag of ["--kind", "--model", "--effort"]) {
    const run = spawnSync(process.execPath, [resolve(REPO, "scripts/lane/lane.mjs"), "dispatch", "unused-topic", flag, "shadow"], {
      cwd: REPO,
      encoding: "utf8",
    });
    assert.equal(run.status, 1, flag);
    assert.match(run.stderr, new RegExp(`unknown dispatch option: ${flag}`), flag);
  }
  const unnamed = spawnSync(process.execPath, [resolve(REPO, "scripts/lane/lane.mjs"), "dispatch", "routing-source-of-truth"], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.equal(unnamed.status, 1);
  assert.match(unnamed.stderr, /dispatch requires --route <name>/);
});

test("dispatch CLI transports permitted long native arguments but rejects attached authority collisions", () => {
  const unavailablePath = "/opt/homebrew/bin:/usr/bin:/bin";
  const dispatch = (...args) => spawnSync(
    process.execPath,
    [resolve(REPO, "scripts/lane/lane.mjs"), "dispatch", "routing-source-of-truth", "--route", "review", ...args],
    { cwd: REPO, encoding: "utf8", env: { ...process.env, PATH: unavailablePath } },
  );

  for (const permittedArgs of [
    ["--arg", "--enable", "--arg", "sample-feature"],
    ["--arg", "-c", "--arg", "features.goals=false"],
    ["--arg", "-c=features.goals=false"],
  ]) {
    const permitted = dispatch(...permittedArgs);
    assert.equal(permitted.status, 1, JSON.stringify(permittedArgs));
    assert.match(permitted.stderr, /herdr is unavailable/, JSON.stringify(permittedArgs));
    assert.doesNotMatch(permitted.stderr, /--arg requires a value|may not override canonical/);
  }

  for (const collisionArgs of [
    ["--arg", "-mshadow-model"],
    ["--arg", "-c", "--arg", "model=shadow-model"],
    ["--arg", "-cmodel=shadow-model"],
    ["--arg", "-c=model_reasoning_effort=low"],
    ["--arg", "-c", "--arg", "model_reasoning_effort = low"],
    ["--arg", "--config=model=shadow-model"],
    ["--arg", "-pshadow-profile"],
  ]) {
    const run = dispatch(...collisionArgs);
    const label = JSON.stringify(collisionArgs);
    assert.equal(run.status, 1, label);
    assert.match(run.stderr, /may not override canonical model, effort, profile, or plugin arguments/, label);
    assert.doesNotMatch(run.stderr, /herdr is unavailable/, label);
  }
});

test("CLI help requires a named route and bounds routing authority", () => {
  const run = spawnSync(process.execPath, [resolve(REPO, "scripts/lane/lane.mjs"), "help"], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.equal(run.status, 1, "the existing help/default path exits nonzero");
  assert.match(run.stdout, /dispatch <topic> --route <name>/);
  assert.match(run.stdout, /not environment, persona, account, memory, or plumbing/);
});

function checkSelectionPolicy(config) {
  const policy = config.selection_policy;
  assert.ok(policy, "selection_policy is present");
  assert.ok(["claude", "codex"].includes(policy.primary_implementation_pool));
  for (const [taskClass, byPool] of Object.entries(policy.by_task_class)) {
    for (const pool of ["claude", "codex"]) {
      assert.ok(config.routes[byPool[pool]], `${taskClass}.${pool} names an existing route: ${byPool[pool]}`);
    }
  }
  const kindOf = (taskClass) =>
    ["claude", "codex"].map((pool) => config.routes[policy.by_task_class[taskClass][pool]].kind);
  assert.deepEqual(kindOf("review-of-claude-work"), ["codex", "codex"]);
  assert.deepEqual(kindOf("review-of-codex-work"), ["claude", "claude"]);
  assert.deepEqual(kindOf("implementation-adversarial-crypto-custody"), ["codex", "codex"]);
  assert.deepEqual(kindOf("review-adversarial"), ["codex", "codex"]);
}

test("the selection policy names only real routes and keeps reviews cross-provider", () => {
  checkSelectionPolicy(loadRoutingConfig(REPO));
});

test("the selection policy check fires on a missing route and on a same-provider review", () => {
  const missing = structuredClone(loadRoutingConfig(REPO));
  missing.selection_policy.by_task_class.settle.codex = "settle-missing";
  assert.throws(() => checkSelectionPolicy(missing), /names an existing route: settle-missing/);
  const sameProvider = structuredClone(loadRoutingConfig(REPO));
  sameProvider.selection_policy.by_task_class["review-of-codex-work"].codex = "review-critical";
  assert.throws(() => checkSelectionPolicy(sameProvider));
  const adversarialOnClaude = structuredClone(loadRoutingConfig(REPO));
  adversarialOnClaude.selection_policy.by_task_class["implementation-adversarial-crypto-custody"].claude = "engineer-opus-xhigh";
  assert.throws(() => checkSelectionPolicy(adversarialOnClaude));
});
