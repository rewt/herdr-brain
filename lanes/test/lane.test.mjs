// Lane lifecycle, configuration, validation and review failure matrices.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { currentTest } from '../../test/helpers/bounded-test.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { INHERITED_GATE_NON_CLAIM } from '../review-evidence.mjs';
import {
  waitForFile,
  HERE,
  LANE,
  GIT,
  HEAD,
  OPERATOR_GIT_ENV,
  negativeControl,
  hermeticGitEnvironment,
  gitExec,
  git,
  makeFixture,
  writeConfig,
  lane,
  laneProcess,
  waitForCondition,
  discoveredEnv,
  configRows,
  lanePath,
  openLane,
  commitFile,
  refExists,
  ignoreLaneState,
  writeExecutable,
  repositoryIdentity,
  identityDigest,
  writeFakeHerdr,
  registryApi,
  makeReviewFixture,
  privateReviewDelivery,
} from "./lane-fixture.mjs";

test("git helpers isolate the operator's global excludes file", () => {
  const fixture = makeFixture();
  try {
    mkdirSync(join(fixture.repo, ".lane"));
    writeFileSync(join(fixture.repo, ".lane", "state.json"), "{}\n");
    const operatorIgnored = spawnSync(GIT, ["-C", fixture.repo, "check-ignore", ".lane/state.json"], {
      env: OPERATOR_GIT_ENV,
      encoding: "utf8",
    });
    assert.equal(operatorIgnored.status, 0, operatorIgnored.stderr);
    const ignored = spawnSync(GIT, ["-C", fixture.repo, "check-ignore", ".lane/state.json"], {
      env: hermeticGitEnvironment(),
      encoding: "utf8",
    });
    assert.equal(ignored.status, 1, ignored.stderr);
    negativeControl("operator global excludes isolation");
  } finally {
    fixture.cleanup();
  }
});

test("open creates a lane and refuses duplicate, invalid, and unresolved inputs", () => {
  const fixture = makeFixture();
  try {
    const opened = lane(fixture, ["open", "alpha-topic"]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, /lane open: lane\/alpha-topic/);
    assert.ok(existsSync(lanePath(fixture, "alpha-topic")));
    assert.ok(refExists(fixture.repo, "refs/heads/lane/alpha-topic"));

    const duplicate = lane(fixture, ["open", "alpha-topic"]);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already exists/);

    const invalid = lane(fixture, ["open", "Bad_Name"]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /short kebab-case/);

    const unresolved = lane(fixture, ["open", "missing-base", "does-not-exist"]);
    assert.equal(unresolved.status, 1);
    assert.match(unresolved.stderr, /base ref does not resolve/);
    negativeControl("open guards");
  } finally {
    fixture.cleanup();
  }
});

test("status reports distance, dirtiness, and files shared by lanes", () => {
  const fixture = makeFixture();
  try {
    const alpha = openLane(fixture, "alpha-topic");
    const beta = openLane(fixture, "beta-topic");
    commitFile(alpha, "shared.txt", "alpha\n", "alpha change");
    commitFile(beta, "shared.txt", "beta\n", "beta change");
    commitFile(fixture.repo, "main-only.txt", "main\n", "move main");
    appendFileSync(join(alpha, "dirty.txt"), "uncommitted\n");

    const run = lane(fixture, ["status"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /lane\/alpha-topic\s+\+1\/-1 vs main.*DIRTY/);
    assert.match(run.stdout, /lane\/beta-topic\s+\+1\/-1 vs main/);
    assert.match(run.stdout, /shared files: lane\/alpha-topic × lane\/beta-topic: shared\.txt/);
    negativeControl("status reporting");
  } finally {
    fixture.cleanup();
  }
});

test("promote refuses a dirty lane worktree", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "dirty-topic");
    writeFileSync(join(path, "dirty.txt"), "dirty\n");
    const before = git(fixture.repo, ["rev-parse", "main"]);
    const run = lane(fixture, ["promote", "dirty-topic"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /lane worktree is not clean/);
    assert.equal(git(fixture.repo, ["rev-parse", "main"]), before);
    negativeControl("dirty promotion refusal");
  } finally {
    fixture.cleanup();
  }
});

test("promote leaves main unchanged when validation fails", () => {
  const fixture = makeFixture({ main: "main", validate: "false" });
  try {
    const path = openLane(fixture, "red-topic");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    const before = git(fixture.repo, ["rev-parse", "main"]);
    const run = lane(fixture, ["promote", "red-topic"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /validation failed \(exit 1\); nothing merged/);
    assert.equal(git(fixture.repo, ["rev-parse", "main"]), before);
    negativeControl("validation gate");
  } finally {
    fixture.cleanup();
  }
});

test("promote waits before the lock and completes fast-forward if memory pressure appears during validation", async () => {
  const fixture = makeFixture();
  let pending;
  try {
    const path = openLane(fixture, "memory-topic");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    const memory = join(fixture.root, 'memory.json'), validated = join(fixture.root, 'validated');
    const pressure = { available: 128 * 1024 ** 2, swap_used: 0 };
    writeFileSync(memory, JSON.stringify(pressure));
    fixture.env.TEST_MEMORY_FILE = memory;
    // Plain node --test must load the same native-input adapter as the runner.
    const memoryAdapter = new URL('../../test/helpers/memory-fixture.mjs', import.meta.url).href;
    fixture.env.NODE_OPTIONS = `${fixture.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(memoryAdapter)}`;
    const script = join(fixture.root, 'validate-memory.cjs');
    writeFileSync(script, `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(validated)}, 'validated');
fs.writeFileSync(${JSON.stringify(memory)}, ${JSON.stringify(JSON.stringify(pressure))});\n`);
    writeConfig(fixture, { main: 'main', validate: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` });
    pending = laneProcess(fixture, ['promote', 'memory-topic']);
    try {
      await waitForCondition(() => pending.stderr().includes('lane promote: waiting; memory pressure'), 'promotion did not wait before validation', 10000);
      assert.equal(existsSync(join(fixture.repo, '.git/lane-promote.lock')), false, 'pressure wait must leave the promotion lock free');
      assert.equal(existsSync(validated), false);
    } finally { writeFileSync(memory, JSON.stringify({ available: 8 * 1024 ** 3, swap_used: 1024 ** 2 })); }
    await waitForCondition(() => existsSync(validated), 'validation did not start after pressure cleared', 10000);
    try {
      // A second wait would strand the promotion lock. Fail promptly, then
      // clear the fixture so the owned child can finish even on a regression.
      await waitForCondition(() => pending.child.exitCode !== null, 'promotion waited on memory after validation while holding its lock', 10000);
    } finally {
      writeFileSync(memory, JSON.stringify({ available: 8 * 1024 ** 3, swap_used: 0 }));
      await pending.completed;
    }
    assert.equal(pending.child.exitCode, 0, pending.stderr());
    assert.match(pending.stdout(), /promoted lane\/memory-topic/);
    assert.equal(git(fixture.repo, ['rev-parse', 'main']), git(fixture.repo, ['rev-parse', 'lane/memory-topic']));
    assert.equal(existsSync(join(fixture.repo, '.git/lane-promote.lock')), false);
  } finally {
    if (pending && pending.child.exitCode === null) {
      writeFileSync(join(fixture.root, 'memory.json'), JSON.stringify({ available: 8 * 1024 ** 3, swap_used: 0 }));
      await pending.completed;
    }
    fixture.cleanup();
  }
});

test("promote rebases a clean lane behind main and fast-forwards", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "green-topic");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    commitFile(fixture.repo, "main.txt", "main\n", "main change");
    const before = git(fixture.repo, ["rev-parse", "main"]);

    const run = lane(fixture, ["promote", "green-topic"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /rebased lane\/green-topic onto main/);
    assert.match(run.stdout, /promoted lane\/green-topic/);
    assert.notEqual(git(fixture.repo, ["rev-parse", "main"]), before);
    assert.equal(
      git(fixture.repo, ["rev-parse", "main"]),
      git(fixture.repo, ["rev-parse", "lane/green-topic"]),
    );
    assert.equal(readFileSync(join(fixture.repo, "lane.txt"), "utf8"), "lane\n");
    negativeControl("rebase and fast-forward");
  } finally {
    fixture.cleanup();
  }
});

test("promote refuses to linearize a merge-bearing lane while the equivalent linear lane promotes", () => {
  const fixture = makeFixture();
  try {
    const mergedPath = openLane(fixture, "merged-history");
    const linearPath = openLane(fixture, "linear-history");
    commitFile(mergedPath, "lane.txt", "lane\n", "lane base");
    git(mergedPath, ["switch", "-c", "merged-history-side"]);
    commitFile(mergedPath, "side.txt", "side\n", "side change");
    git(mergedPath, ["switch", "lane/merged-history"]);
    commitFile(mergedPath, "topic.txt", "topic\n", "topic change");
    git(mergedPath, ["merge", "--no-ff", "merged-history-side", "-m", "merge side"]);
    commitFile(linearPath, "linear.txt", "linear\n", "linear change");
    commitFile(fixture.repo, "main.txt", "main\n", "main change");
    const mainBefore = git(fixture.repo, ["rev-parse", "main"]);
    const mergedBefore = git(fixture.repo, ["rev-parse", "lane/merged-history"]);

    const refused = lane(fixture, ["promote", "merged-history"]);
    assert.equal(refused.status, 1);
    assert.match(
      refused.stderr,
      /merge commit present; plain rebase would linearize and may conflict/,
    );
    assert.equal(git(fixture.repo, ["rev-parse", "main"]), mainBefore);
    assert.equal(git(fixture.repo, ["rev-parse", "lane/merged-history"]), mergedBefore);
    assert.equal(git(mergedPath, ["status", "--porcelain=v1"]), "");
    assert.ok(!existsSync(git(mergedPath, ["rev-parse", "--git-path", "rebase-merge"])));
    assert.ok(!existsSync(git(mergedPath, ["rev-parse", "--git-path", "rebase-apply"])));

    const promoted = lane(fixture, ["promote", "linear-history"]);
    assert.equal(promoted.status, 0, promoted.stderr);
    assert.match(promoted.stdout, /rebased lane\/linear-history onto main/);
    assert.match(promoted.stdout, /promoted lane\/linear-history/);
    negativeControl("merge-bearing rebase refusal and linear promotion");
  } finally {
    fixture.cleanup();
  }
});

test("promote accepts a gitignored session registry in the canonical checkout", () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    writeFileSync(
      join(fixture.repo, ".gitignore"),
      readFileSync(resolve(HERE, "..", ".gitignore"), "utf8"),
    );
    git(fixture.repo, ["add", ".gitignore"]);
    git(fixture.repo, ["commit", "-m", "add ignore rules"], { stdio: "ignore" });
    const path = openLane(fixture, "board-registry");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    mkdirSync(join(fixture.repo, ".lane"));
    writeFileSync(join(fixture.repo, ".lane", "sessions.json"), "[]\n");

    const run = lane(fixture, ["promote", "board-registry"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /promoted lane\/board-registry/);
    negativeControl("gitignored board registry promotion");
  } finally {
    fixture.cleanup();
  }
});

test("close reads a legacy session registry file without failing", () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    writeFileSync(
      join(fixture.repo, ".gitignore"),
      readFileSync(resolve(HERE, "..", ".gitignore"), "utf8"),
    );
    git(fixture.repo, ["add", ".gitignore"]);
    git(fixture.repo, ["commit", "-m", "add ignore rules"], { stdio: "ignore" });
    const path = openLane(fixture, "legacy-registry");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    mkdirSync(join(fixture.repo, ".lane"));
    writeFileSync(join(fixture.repo, ".lane", "sessions.json"), "[]\n");

    const run = lane(fixture, ["close", "legacy-registry"]);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /metadata update failed|loadRegistry is not defined/);
  } finally {
    fixture.cleanup();
  }
});

test("promote refuses a conflicting rebase and names the file", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "conflict-topic");
    commitFile(path, "shared.txt", "lane\n", "lane conflict");
    commitFile(fixture.repo, "shared.txt", "main\n", "main conflict");
    const before = git(fixture.repo, ["rev-parse", "main"]);

    const run = lane(fixture, ["promote", "conflict-topic"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /does not rebase cleanly; conflicts in: shared\.txt/);
    assert.equal(git(fixture.repo, ["rev-parse", "main"]), before);
    negativeControl("conflicting rebase refusal");
  } finally {
    fixture.cleanup();
  }
});

test("promote refuses when main moves during validation", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "moving-main");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    writeConfig(fixture, {
      main: "main",
      validate: `git -C '${fixture.repo}' commit --allow-empty -m validation-moved-main`,
    });
    const laneHead = git(fixture.repo, ["rev-parse", "lane/moving-main"]);

    const run = lane(fixture, ["promote", "moving-main"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /main moved during validation; re-run promote/);
    assert.notEqual(git(fixture.repo, ["rev-parse", "main"]), laneHead);
    negativeControl("main movement guard");
  } finally {
    fixture.cleanup();
  }
});

test("close deletes a merged branch", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "merged-topic");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    assert.equal(lane(fixture, ["promote", "merged-topic"]).status, 0);

    const run = lane(fixture, ["close", "merged-topic"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /deleted merged branch lane\/merged-topic/);
    assert.ok(!existsSync(path));
    assert.ok(!refExists(fixture.repo, "refs/heads/lane/merged-topic"));
    negativeControl("merged close");
  } finally {
    fixture.cleanup();
  }
});

test("close retires a background workspace without worktree.remove and preserves the archive", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "unmerged-topic");
    commitFile(path, "lane.txt", "lane\n", "lane change");
    const laneHead = git(fixture.repo, ["rev-parse", "lane/unmerged-topic"]);
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: "lane/unmerged-topic", initiallyOpened: true });

    const run = lane(fixture, ["close", "unmerged-topic"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /archived unmerged lane as tag archive\/lane\/unmerged-topic/);
    assert.ok(!refExists(fixture.repo, "refs/heads/lane/unmerged-topic"));
    assert.equal(git(fixture.repo, ["rev-parse", "archive/lane/unmerged-topic"]), laneHead);
    assert.ok(fake.calls().some((args) => args[0] === "workspace" && args[1] === "close" && args[2] === "w-lane"));
    assert.ok(!fake.calls().some((args) => args[0] === "worktree" && args[1] === "remove"));
    negativeControl("unmerged archive");
  } finally {
    fixture.cleanup();
  }
});

test("close refuses a dirty worktree", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "dirty-close");
    writeFileSync(join(path, "dirty.txt"), "dirty\n");
    const run = lane(fixture, ["close", "dirty-close"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /lane worktree is not clean/);
    assert.ok(existsSync(path));
    assert.ok(refExists(fixture.repo, "refs/heads/lane/dirty-close"));
    negativeControl("dirty close refusal");
  } finally {
    fixture.cleanup();
  }
});

test("close preserves a locked worktree and its workspace when Git removal refuses", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "locked-close");
    commitFile(path, "lane.txt", "recoverable\n", "locked lane work");
    const head = git(fixture.repo, ["rev-parse", "lane/locked-close"]);
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: "lane/locked-close", initiallyOpened: true });
    git(fixture.repo, ["worktree", "lock", "--reason", "offline lifecycle regression", path]);

    const refused = lane(fixture, ["close", "locked-close"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /locked/u);
    assert.ok(existsSync(path));
    assert.equal(git(fixture.repo, ["rev-parse", "lane/locked-close"]), head);
    assert.ok(!refExists(fixture.repo, "refs/tags/archive/lane/locked-close"));
    assert.ok(!fake.calls().some((args) => args[0] === "workspace" && args[1] === "close"));
    assert.ok(!fake.calls().some((args) => args[0] === "worktree" && args[1] === "remove"));

    git(fixture.repo, ["worktree", "unlock", path]);
    const closed = lane(fixture, ["close", "locked-close"]);
    assert.equal(closed.status, 0, closed.stderr);
    assert.ok(!existsSync(path));
    assert.equal(git(fixture.repo, ["rev-parse", "archive/lane/locked-close"]), head);
    assert.equal(fake.calls().filter((args) => args[0] === "workspace" && args[1] === "close").length, 1);
    negativeControl("locked close refusal preserves workspace");
  } finally {
    fixture.cleanup();
  }
});

test("rebase-check exits zero when clean and one with files on conflict", () => {
  const fixture = makeFixture();
  try {
    const clean = openLane(fixture, "clean-check");
    const conflict = openLane(fixture, "conflict-check");
    commitFile(clean, "clean.txt", "clean\n", "clean lane");
    commitFile(conflict, "shared.txt", "lane\n", "conflicting lane");
    commitFile(fixture.repo, "shared.txt", "main\n", "conflicting main");

    const cleanRun = lane(fixture, ["rebase-check", "clean-check"]);
    assert.equal(cleanRun.status, 0, cleanRun.stderr);
    assert.match(cleanRun.stdout, /clean$/m);
    const conflictRun = lane(fixture, ["rebase-check", "conflict-check"]);
    assert.equal(conflictRun.status, 1);
    assert.match(conflictRun.stdout, /CONFLICT shared\.txt/);
    negativeControl("rebase-check exits");
  } finally {
    fixture.cleanup();
  }
});

test("rebase-check and status refuse a merge-bearing lane only when it is behind main", () => {
  const fixture = makeFixture();
  const mergeLane = (path, topic) => {
    commitFile(path, `${topic}.txt`, "lane\n", "lane base");
    git(path, ["switch", "-c", `${topic}-side`]);
    commitFile(path, `${topic}-side.txt`, "side\n", "side change");
    git(path, ["switch", `lane/${topic}`]);
    commitFile(path, `${topic}-topic.txt`, "topic\n", "topic change");
    git(path, ["merge", "--no-ff", `${topic}-side`, "-m", "merge side"]);
  };
  try {
    mergeLane(openLane(fixture, "merged-behind"), "merged-behind");
    commitFile(fixture.repo, "main.txt", "main\n", "main change");
    mergeLane(openLane(fixture, "merged-current"), "merged-current");

    const current = lane(fixture, ["rebase-check", "merged-current"]);
    assert.equal(current.status, 0, current.stdout);
    assert.match(current.stdout, /lane\/merged-current vs main: \+\d+\/-0 clean$/m);
    const behind = lane(fixture, ["rebase-check", "merged-behind"]);
    assert.equal(behind.status, 1);
    assert.match(
      behind.stdout,
      /lane\/merged-behind vs main: \+\d+\/-1 merge commit present; plain rebase would linearize and may conflict$/m,
    );

    const run = lane(fixture, ["status"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /lane\/merged-current\s+\+\d+\/-0 vs main.*rebase: current$/m);
    assert.match(
      run.stdout,
      /lane\/merged-behind\s+\+\d+\/-1 vs main.*rebase: merge commit present; plain rebase would linearize and may conflict$/m,
    );
    negativeControl("merge-bearing rebase-check and status");
  } finally {
    fixture.cleanup();
  }
});

test("prepare runs needed steps and skips steps whose unless path exists", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "prepare-topic");
    writeFileSync(join(path, "already.marker"), "present\n");
    writeConfig(fixture, {
      main: "main",
      validate: "true",
      prepare: [
        { unless: "ready.marker", run: "printf 'ran\\n' >> prepare.log; printf 'ready\\n' > ready.marker" },
        { unless: "already.marker", run: "printf 'unexpected\\n' >> skipped.log" },
      ],
    });

    const first = lane(fixture, ["prepare", "prepare-topic"]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(join(path, "prepare.log"), "utf8"), "ran\n");
    assert.ok(!existsSync(join(path, "skipped.log")));
    const second = lane(fixture, ["prepare", "prepare-topic"]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(join(path, "prepare.log"), "utf8"), "ran\n");
    negativeControl("prepare unless guards");
  } finally {
    fixture.cleanup();
  }
});

test("check records configured validation against the current HEAD", () => {
  const fixture = makeFixture({ main: "main", validate: "gate-pass configured" });
  try {
    ignoreLaneState(fixture);
    writeExecutable(fixture, "gate-pass", "exit 0");
    const path = openLane(fixture, "checked-topic");
    const head = git(path, ["rev-parse", "HEAD"]);

    const run = spawnSync(process.execPath, [LANE, "check"], {
      cwd: path,
      env: fixture.env,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`^GATE ${head} exit=0 \\(\\d+(?:\\.\\d+)?s\\)\\n$`));
    const gate = JSON.parse(readFileSync(join(path, ".lane", "gate.json"), "utf8"));
    assert.equal(gate.head, head);
    assert.equal(gate.branch, "lane/checked-topic");
    assert.equal(gate.command, "gate-pass configured");
    assert.equal(gate.exit_code, 0);
    assert.equal(gate.signal, null);
    assert.equal(new Date(gate.started_at).toISOString(), gate.started_at);
    assert.equal(new Date(gate.finished_at).toISOString(), gate.finished_at);
    assert.ok(Date.parse(gate.finished_at) >= Date.parse(gate.started_at));
    assert.equal(typeof gate.duration_s, "number");
    assert.ok(gate.duration_s >= 0);
    negativeControl("check configured validation record");
  } finally {
    fixture.cleanup();
  }
});

test("check honors LANE_VALIDATE and --cmd precedence and returns a failed gate exit", () => {
  const fixture = makeFixture({ main: "main", validate: "gate-configured" });
  try {
    ignoreLaneState(fixture);
    writeExecutable(fixture, "gate-configured", "exit 2");
    writeExecutable(fixture, "gate-environment", "exit 0");
    writeExecutable(fixture, "gate-override", "exit 7");

    fixture.env.LANE_VALIDATE = "gate-environment";
    const environment = lane(fixture, ["check"]);
    assert.equal(environment.status, 0, environment.stderr);
    assert.equal(
      JSON.parse(readFileSync(join(fixture.repo, ".lane", "gate.json"), "utf8")).command,
      "gate-environment",
    );

    const command = "gate-override --record-verbatim";
    const override = lane(fixture, ["check", "--cmd", command]);
    assert.equal(override.status, 7, override.stderr);
    assert.match(override.stdout, /GATE [0-9a-f]{40} exit=7/);
    const gate = JSON.parse(readFileSync(join(fixture.repo, ".lane", "gate.json"), "utf8"));
    assert.equal(gate.command, command);
    assert.equal(gate.exit_code, 7);
    negativeControl("check validation precedence and failed exit");
  } finally {
    fixture.cleanup();
  }
});

test("check defaults to npm test and refuses a dirty current worktree", () => {
  const fixture = makeFixture({ main: "main" });
  try {
    ignoreLaneState(fixture);
    writeExecutable(fixture, "npm", "[ \"$1\" = test ] || exit 9\nexit 0");
    const clean = lane(fixture, ["check"]);
    assert.equal(clean.status, 0, clean.stderr);
    const gatePath = join(fixture.repo, ".lane", "gate.json");
    const gate = JSON.parse(readFileSync(gatePath, "utf8"));
    assert.equal(gate.command, "npm test");

    const previous = readFileSync(gatePath, "utf8");
    writeFileSync(join(fixture.repo, "dirty.txt"), "dirty\n");
    const dirty = lane(fixture, ["check"]);
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /current worktree is not clean/);
    assert.equal(readFileSync(gatePath, "utf8"), previous);
    negativeControl("check default and dirty refusal");
  } finally {
    fixture.cleanup();
  }
});

test("check runs configured prepare steps before validation", () => {
  const fixture = makeFixture({
    main: "main",
    validate: "gate-needs-prepare",
    prepare: [{ unless: ".ready.marker", run: ": > .ready.marker" }],
  });
  try {
    ignoreLaneState(fixture);
    writeExecutable(fixture, "gate-needs-prepare", "[ -f .ready.marker ] || exit 6\nexit 0");

    const run = lane(fixture, ["check"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /preparing .*: : > \.ready\.marker/);
    assert.ok(existsSync(join(fixture.repo, ".ready.marker")));
    assert.equal(
      JSON.parse(readFileSync(join(fixture.repo, ".lane", "gate.json"), "utf8")).exit_code,
      0,
    );
    negativeControl("check prepare parity");
  } finally {
    fixture.cleanup();
  }
});

test("check records signal termination using the shell exit convention", () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    const run = lane(fixture, ["check", "--cmd", "kill -9 $$"]);
    assert.equal(run.status, 137, run.stderr);
    assert.match(run.stdout, /GATE [0-9a-f]{40} exit=137/);
    const gate = JSON.parse(readFileSync(join(fixture.repo, ".lane", "gate.json"), "utf8"));
    assert.equal(gate.exit_code, 137);
    assert.equal(gate.signal, "SIGKILL");
    negativeControl("check signal gate");
  } finally {
    fixture.cleanup();
  }
});

test("check refuses a detached HEAD without replacing an existing gate", () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    mkdirSync(join(fixture.repo, ".lane"));
    const gatePath = join(fixture.repo, ".lane", "gate.json");
    writeFileSync(gatePath, "existing gate\n");
    git(fixture.repo, ["switch", "--detach"]);

    const run = lane(fixture, ["check"]);
    assert.equal(run.status, 1);
    assert.equal(run.stderr, "lane: current checkout is detached; check requires a branch\n");
    assert.equal(readFileSync(gatePath, "utf8"), "existing gate\n");
    negativeControl("check detached HEAD refusal");
  } finally {
    fixture.cleanup();
  }
});

test("check rejects unknown options and missing or empty --cmd values", () => {
  const fixture = makeFixture();
  try {
    const unknown = lane(fixture, ["check", "--unknown"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown option: --unknown/);

    const missing = lane(fixture, ["check", "--cmd"]);
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr, "lane: usage: lane check [--cmd <validate command>]\n");

    const empty = lane(fixture, ["check", "--cmd", ""]);
    assert.equal(empty.status, 1);
    assert.equal(empty.stderr, "lane: usage: lane check [--cmd <validate command>]\n");
    negativeControl("check argument refusals");
  } finally {
    fixture.cleanup();
  }
});

test("routes prints configured routes with resolved dispatch defaults", () => {
  const fixture = makeFixture({
    main: "main",
    validate: "true",
    dispatch: {
      kind: "claude",
      model: "default-model",
      args: ["--default-flag"],
    },
    always_args: {
      codex: ["--profile", "fallback", "--sandbox", "workspace-write"],
      reviewer: ["--review-extra"],
    },
    routes: {
      review: { kind: "reviewer" },
      engineer: {
        kind: "codex",
        model: "engineer-model",
        args: ["--profile", "implementation"],
        use: "Complex implementation lanes",
      },
    },
    selection_policy: {
      primary_implementation_pool: "primary",
      by_task_class: { implementation: { primary: "engineer", alternate: "review" } },
    },
  });
  try {
    const run = lane(fixture, ["routes"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      run.stdout,
      "engineer\tkind=codex\tmodel=engineer-model\teffort=(none)\targs=[\"--profile\",\"implementation\"]\tuse=Complex implementation lanes\n" +
        "review\tkind=reviewer\tmodel=default-model\teffort=(none)\targs=[\"--default-flag\"]\tuse=(none)\n",
    );
    const selected = lane(fixture, ["routes", "--for", "implementation"]);
    assert.equal(selected.status, 0, selected.stderr);
    assert.match(selected.stdout, /^implementation\tpool=primary\troute=engineer\tkind=codex\tmodel=engineer-model/);

    writeConfig(fixture, { main: "main", validate: "true" });
    const empty = lane(fixture, ["routes"]);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /lane: no routes configured/);
    negativeControl("routes output");
  } finally {
    fixture.cleanup();
  }
});

test("named dispatch refuses copied metadata and reserved CLI arguments before any Herdr call", () => {
  const fixture = makeFixture({
    main: "main", validate: "true",
    always_args: { codex: ["-p", "NAME"] },
    routes: {
      legacy: { kind: "codex", model: "route-model", args: ["-c", "model_reasoning_effort=high"] },
      declared: { kind: "codex", model: "route-model", effort: "high" },
      claude: { kind: "claude", model: "route-model", effort: "high" },
    },
  });
  try {
    const fake = writeFakeHerdr(fixture, { lanePath: lanePath(fixture, "reserved"), branch: "lane/reserved" });
    for (const flag of ["--kind", "--model"]) {
      const run = lane(fixture, ["dispatch", "reserved", "--route", "legacy", flag, "other"]);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /--kind and --model cannot override a named route/);
    }
    const codex = [
      ["--model", "other"], ["--model=other"], ["-m", "other"], ["-mother"], ["-m=other"],
      ["--profile", "other"], ["--profile=other"], ["-p", "other"], ["-pother"], ["-p=other"],
    ];
    for (const key of [
      "model", "model_reasoning_effort", "profile",
      "profiles.NAME.model", "profiles.NAME.model_reasoning_effort", "profiles.NAME.profile",
      "profiles.NAME.history.persistence",
    ]) {
      codex.push(["-c", `${key}=other`], ["--config", `${key}=other`],
        [`--config=${key}=other`], [`-c${key}=other`], [`-c=${key}=other`],
        ["-c", ` "${key}" = "other" `], ["--config", ` '${key}' = 'other' `]);
    }
    codex.push(
      ["-c", 'profiles . "NAME" . "model_reasoning_effort" = "low"'],
      ["--config", "'profiles'.'NAME'.'model' = 'other'"],
      ["-c", 'profiles.NAME={model_reasoning_effort="low"}'],
      ["--config", 'profiles={NAME={model_reasoning_effort="low"}}'],
    );
    const claude = [
      ["--model", "other"], ["--model=other"], ["--effort", "low"], ["--effort=low"],
      ["--plugin-dir", "/other"], ["--plugin-dir=/other"],
    ];
    for (const [route, variants] of [["legacy", codex], ["declared", codex], ["claude", claude]]) {
      for (const args of variants) {
        const run = lane(fixture, ["dispatch", "reserved", "--route", route, ...args.flatMap((arg) => ["--arg", arg])]);
        assert.equal(run.status, 1, `${route}: ${args.join(" ")}`);
        assert.match(run.stderr, /--arg may not override canonical model, effort, profile, or plugin arguments/);
      }
    }
    assert.deepEqual(fake.calls(), []);
  } finally {
    fixture.cleanup();
  }
});




test("config attributes always_args to the file that supplied it", () => {
  const alwaysArgs = { codex: ["--profile", "shared", "--sandbox", "workspace-write"] };
  const fixture = makeFixture({ always_args: alwaysArgs });
  try {
    const run = lane(fixture, ["config"]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(configRows(run.stdout).get("always_args"), {
      value: alwaysArgs,
      source: fixture.configPath,
    });
    negativeControl("always_args config value and source");
  } finally {
    fixture.cleanup();
  }
});

test("config layers the nearest parent and canonical repository with attributed replacement semantics", () => {
  const fixture = makeFixture(undefined, { repoParts: ["home", "projects", "team", "repo"] });
  try {
    const home = join(fixture.root, "home");
    const grandparent = join(home, "projects");
    const parent = join(grandparent, "team");
    const parentConfig = join(parent, ".lane.json");
    const repoConfig = join(fixture.repo, ".lane.json");
    const shouldNotRun = join(fixture.root, "config-command-ran");
    writeFileSync(join(home, ".lane.json"), `${JSON.stringify({ main: "home-main" })}\n`);
    writeFileSync(join(grandparent, ".lane.json"), `${JSON.stringify({
      main: "grandparent-main",
      seams_doc: "grandparent-seams.md",
    })}\n`);
    writeFileSync(parentConfig, `${JSON.stringify({
      main: "parent-main",
      registry: "parent-sessions.json",
      worktree_root: "parent-trees",
      prepare: [{ unless: "parent.marker", run: `touch '${shouldNotRun}'` }],
      dispatch: { kind: "claude", env: ["PARENT=1"], args: ["--parent"] },
      routes: {
        engineer: { kind: "claude", env: ["PARENT_ROUTE=1"] },
        reviewer: { kind: "claude", model: "review-model", args: ["--review"] },
      },
    }, null, 2)}\n`);
    writeFileSync(repoConfig, `${JSON.stringify({
      main: "main",
      validate: `touch '${shouldNotRun}'`,
      worktree_root: "../repo-trees",
      prepare: [{ unless: "repo.marker", run: `touch '${shouldNotRun}'` }],
      dispatch: { kind: "codex", env: ["REPO=1"], args: ["--repo"] },
      routes: {
        engineer: { kind: "codex", model: "engineer-model", args: ["--engineer"] },
      },
    }, null, 2)}\n`);

    const run = lane(fixture, ["config"], {
      env: discoveredEnv(fixture, { HOME: home }),
    });
    assert.equal(run.status, 0, run.stderr);
    const rows = configRows(run.stdout);
    assert.deepEqual(rows.get("main"), { value: "main", source: repoConfig });
    assert.deepEqual(rows.get("registry"), { value: "parent-sessions.json", source: parentConfig });
    assert.deepEqual(rows.get("seams_doc"), { value: null, source: "default" });
    assert.deepEqual(rows.get("prepare"), {
      value: [{ unless: "repo.marker", run: `touch '${shouldNotRun}'` }],
      source: repoConfig,
    });
    assert.deepEqual(rows.get("dispatch"), {
      value: { kind: "codex", env: ["REPO=1"], args: ["--repo"] },
      source: repoConfig,
    });
    assert.deepEqual(rows.get("routes.engineer"), {
      value: { kind: "codex", model: "engineer-model", args: ["--engineer"] },
      source: repoConfig,
    });
    assert.deepEqual(rows.get("routes.reviewer"), {
      value: { kind: "claude", model: "review-model", args: ["--review"] },
      source: parentConfig,
    });
    assert.deepEqual(rows.get("worktree_root"), {
      value: join(dirname(fixture.repo), "repo-trees", "repo"),
      source: repoConfig,
    });
    assert.ok(!existsSync(shouldNotRun));
    const opened = lane(fixture, ["open", "repository-root-lane"], {
      env: discoveredEnv(fixture, { HOME: home }),
    });
    assert.equal(opened.status, 0, opened.stderr);
    assert.ok(existsSync(join(dirname(fixture.repo), "repo-trees", "repo", "lane-repository-root-lane")));
    negativeControl("layered config attribution and replacement");
  } finally {
    fixture.cleanup();
  }
});

test("config escapes route names so every TSV record remains one line with three fields", () => {
  const fixture = makeFixture({
    routes: {
      "review\tline\nnext\\path": { kind: "claude" },
    },
  });
  try {
    const run = lane(fixture, ["config"]);
    assert.equal(run.status, 0, run.stderr);
    const routeRows = run.stdout.trim().split("\n").filter((line) => line.startsWith("routes."));
    assert.deepEqual(routeRows, [
      `routes.review\\tline\\nnext\\\\path\t{"kind":"claude"}\t${fixture.configPath}`,
    ]);
    negativeControl("config TSV route-key escaping");
  } finally {
    fixture.cleanup();
  }
});

test("worktree roots honor parent-relative, parent-default, legacy, and caller-relative environment precedence", () => {
  const cases = [
    {
      name: "parent-relative",
      parent: { worktree_root: "shared-trees" },
      expected(fixture) { return join(fixture.root, "home", "projects", "shared-trees", "repo"); },
    },
    {
      name: "parent-default",
      parent: { validate: "true" },
      expected(fixture) { return join(fixture.root, "home", "projects", ".worktrees", "repo"); },
    },
    {
      name: "legacy-default",
      expected(fixture) { return join(fixture.root, "home", ".herdr", "worktrees", "repo"); },
    },
  ];
  for (const item of cases) {
    const fixture = makeFixture(undefined, { repoParts: ["home", "projects", "repo"] });
    try {
      const home = join(fixture.root, "home");
      const parent = join(home, "projects");
      if (item.parent !== undefined) {
        writeFileSync(join(parent, ".lane.json"), `${JSON.stringify(item.parent)}\n`);
      }
      const env = discoveredEnv(fixture, { HOME: home });
      const explained = lane(fixture, ["config"], { env });
      assert.equal(explained.status, 0, explained.stderr);
      assert.deepEqual(configRows(explained.stdout).get("worktree_root"), {
        value: item.expected(fixture),
        source: item.parent === undefined ? "default" : join(parent, ".lane.json"),
      });
      const run = lane(fixture, ["open", `${item.name}-lane`], { env });
      assert.equal(run.status, 0, run.stderr);
      assert.ok(existsSync(join(item.expected(fixture), `lane-${item.name}-lane`)));
    } finally {
      fixture.cleanup();
    }
  }

  const fixture = makeFixture();
  try {
    const caller = join(fixture.repo, "caller");
    mkdirSync(caller);
    const env = discoveredEnv(fixture, { LANE_WORKTREE_ROOT: "environment-trees" });
    const explained = lane(fixture, ["config"], { cwd: caller, env });
    assert.equal(explained.status, 0, explained.stderr);
    assert.deepEqual(configRows(explained.stdout).get("worktree_root"), {
      value: join(caller, "environment-trees"),
      source: "env",
    });
    const run = lane(fixture, ["open", "environment-lane"], { cwd: caller, env });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /unsafe worktree path.*canonical checkout/);
    assert.ok(!existsSync(join(caller, "environment-trees", "lane-environment-lane")));
    assert.ok(!existsSync(join(caller, "environment-trees", "repo")));
    negativeControl("worktree root precedence matrix");
  } finally {
    fixture.cleanup();
  }
});

test("home is a configuration discovery boundary", () => {
  const fixture = makeFixture(undefined, { repoParts: ["home", "repo"] });
  try {
    const home = join(fixture.root, "home");
    writeFileSync(join(home, ".lane.json"), `${JSON.stringify({
      main: "must-not-cross-home",
      worktree_root: "must-not-use",
    })}\n`);
    const run = lane(fixture, ["config"], { env: discoveredEnv(fixture, { HOME: home }) });
    assert.equal(run.status, 0, run.stderr);
    const rows = configRows(run.stdout);
    assert.deepEqual(rows.get("main"), { value: "main", source: "default" });
    assert.deepEqual(rows.get("worktree_root"), {
      value: join(home, ".herdr", "worktrees", "repo"),
      source: "default",
    });
    negativeControl("home discovery boundary");
  } finally {
    fixture.cleanup();
  }
});

test("LANE_CONFIG selects one caller-relative file and bypasses discovered layers", () => {
  const fixture = makeFixture();
  try {
    const caller = join(fixture.repo, "caller");
    const home = join(fixture.root, "home");
    mkdirSync(caller);
    mkdirSync(home);
    const parentConfig = join(fixture.root, ".lane.json");
    const repoConfig = join(fixture.repo, ".lane.json");
    const selected = join(caller, "selected.json");
    writeFileSync(parentConfig, `${JSON.stringify({ main: "parent-main", validate: "parent" })}\n`);
    writeFileSync(repoConfig, `${JSON.stringify({ main: "repo-main", validate: "repo" })}\n`);
    writeFileSync(selected, `${JSON.stringify({ validate: "selected", worktree_root: "selected-trees" })}\n`);
    const env = discoveredEnv(fixture, { HOME: home, LANE_CONFIG: "selected.json" });
    const run = lane(fixture, ["config"], { cwd: caller, env });
    assert.equal(run.status, 0, run.stderr);
    const rows = configRows(run.stdout);
    assert.deepEqual(rows.get("main"), { value: "main", source: "default" });
    assert.deepEqual(rows.get("validate"), { value: "selected", source: selected });
    assert.deepEqual(rows.get("worktree_root"), {
      value: join(caller, "selected-trees", "repo"),
      source: selected,
    });
    const validateOverride = lane(fixture, ["config"], {
      cwd: caller,
      env: { ...env, LANE_VALIDATE: "environment-validate" },
    });
    assert.equal(validateOverride.status, 0, validateOverride.stderr);
    assert.deepEqual(configRows(validateOverride.stdout).get("validate"), {
      value: "environment-validate",
      source: "env",
    });
    writeFileSync(selected, `${JSON.stringify({ validate: "selected" })}\n`);
    const legacyRoot = lane(fixture, ["config"], { cwd: caller, env });
    assert.equal(legacyRoot.status, 0, legacyRoot.stderr);
    const worktreeRoot = configRows(legacyRoot.stdout).get("worktree_root");
    assert.equal(worktreeRoot.value, join(home, ".herdr", "worktrees", "repo"));
    assert.equal(worktreeRoot.source, "default");
    negativeControl("explicit config bypass");
  } finally {
    fixture.cleanup();
  }
});

test("linked invocations use canonical repository config for explanation, check, and promote", () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    writeExecutable(fixture, "canonical-check", "exit 0");
    const linked = join(fixture.root, "linked");
    git(fixture.repo, ["worktree", "add", "-b", "lane/linked-config", linked], { stdio: "ignore" });
    const canonicalConfig = join(fixture.repo, ".lane.json");
    writeFileSync(canonicalConfig, `${JSON.stringify({ validate: "canonical-check", worktree_root: "canonical-trees" })}\n`);
    git(fixture.repo, ["add", ".lane.json"]);
    git(fixture.repo, ["commit", "-m", "add canonical config"], { stdio: "ignore" });

    const run = lane(fixture, ["config"], { cwd: linked, env: discoveredEnv(fixture) });
    assert.equal(run.status, 0, run.stderr);
    const rows = configRows(run.stdout);
    assert.deepEqual(rows.get("validate"), { value: "canonical-check", source: canonicalConfig });
    assert.deepEqual(rows.get("worktree_root"), {
      value: join(fixture.repo, "canonical-trees", "repo"),
      source: canonicalConfig,
    });
    const check = lane(fixture, ["check"], { cwd: linked, env: discoveredEnv(fixture) });
    assert.equal(check.status, 0, check.stderr);
    const promote = lane(fixture, ["promote", "linked-config"], { env: discoveredEnv(fixture) });
    assert.equal(promote.status, 0, promote.stderr);
    negativeControl("canonical config from linked worktree");
  } finally {
    fixture.cleanup();
  }
});

test("bare repositories with only linked worktrees allow reads and refuse mutations clearly", () => {
  const fixture = makeFixture();
  try {
    const bare = join(fixture.root, "repository.git");
    const linked = join(fixture.root, "linked-checkout");
    gitExec(["clone", "--bare", fixture.repo, bare], { stdio: "ignore" });
    gitExec(["--git-dir", bare, "worktree", "add", linked, "main"], { stdio: "ignore" });
    const linkedFixture = { ...fixture, repo: linked };

    const explained = lane(linkedFixture, ["config"]);
    assert.equal(explained.status, 0, explained.stderr);
    assert.deepEqual(configRows(explained.stdout).get("main"), { value: "main", source: fixture.configPath });
    const listed = lane(linkedFixture, ["status"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /no open lanes/);

    const opened = lane(linkedFixture, ["open", "needs-primary"]);
    assert.equal(opened.status, 1);
    assert.match(opened.stderr, /cannot resolve canonical non-linked checkout.*open requires a canonical checkout/);
    assert.ok(!refExists(linked, "refs/heads/lane/needs-primary"));
    negativeControl("bare linked reads and mutation refusal");
  } finally {
    fixture.cleanup();
  }
});

test("same-named repositories in equal-labeled roots keep distinct paths, labels, agents, and git identities", () => {
  const fixtures = [
    makeFixture(undefined, { repoParts: ["development-a", "same-root", "same-repo"] }),
    makeFixture(undefined, { repoParts: ["development-b", "same-root", "same-repo"] }),
  ];
  try {
    const records = [];
    for (const [index, fixture] of fixtures.entries()) {
      const rootIdentity = realpathSync(join(fixture.root, `development-${index === 0 ? "a" : "b"}`, "same-root"));
      writeFileSync(join(rootIdentity, ".lane.json"), `${JSON.stringify({ validate: "true" })}\n`);
      fixture.env = discoveredEnv(fixture, { HOME: join(fixture.root, `development-${index === 0 ? "a" : "b"}`) });
      ignoreLaneState(fixture);
      const path = join(rootIdentity, ".worktrees", "same-repo", "lane-shared-topic");
      const identity = repositoryIdentity(fixture.repo);
      const readableLabel = "same-root/same-repo:lane-shared-topic";
      const fake = writeFakeHerdr(fixture, {
        lanePath: path,
        branch: "lane/shared-topic",
        extraWorkspaces: [{
          active_tab_id: "w-foreign:t1",
          agent_status: "idle",
          focused: false,
          label: readableLabel,
          number: 8,
          pane_count: 1,
          tab_count: 1,
          workspace_id: "w-foreign",
          worktree: {
            checkout_path: "/foreign/worktree",
            is_linked_worktree: true,
            repo_key: "/foreign/repository.git",
            repo_name: "same-repo",
            repo_root: "/foreign/same-repo",
          },
        }],
      });
      git(fixture.repo, ["config", "user.name", `Lane Identity ${index + 1}`]);
      git(fixture.repo, ["config", "user.email", `identity-${index + 1}@example.invalid`]);
      const before = git(fixture.repo, ["config", "--local", "--list"]);
      const opened = lane(fixture, ["open", "shared-topic"]);
      assert.equal(opened.status, 0, opened.stderr);
      assert.ok(existsSync(path));
      assert.match(opened.stdout, new RegExp(`repository identity: ${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(opened.stdout, new RegExp(`root identity: ${rootIdentity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      const dispatched = lane(fixture, ["dispatch", "shared-topic", "implement the task"]);
      assert.equal(dispatched.status, 0, dispatched.stderr);
      const calls = fake.calls();
      const create = calls.find((args) => args[0] === "worktree" && args[1] === "create");
      const label = create[create.indexOf("--label") + 1];
      const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
      const agent = start[2];
      const firstAgentList = calls.findIndex((args) => args[0] === "agent" && args[1] === "list");
      const firstAgentStart = calls.findIndex((args) => args[0] === "agent" && args[1] === "start");
      assert.ok(firstAgentList >= 0 && firstAgentList < firstAgentStart);
      assert.match(label, /^same-root\/same-repo:lane-shared-topic~[0-9a-f]{8}$/);
      assert.ok(label.endsWith(identityDigest(rootIdentity, identity, "shared-topic")));
      assert.match(agent, /^[a-z][a-z0-9_-]{0,31}$/);
      assert.ok(agent.includes(identityDigest(rootIdentity, identity, "shared-topic", 6)));
      assert.equal(git(fixture.repo, ["config", "--local", "--list"]), before);
      assert.equal(git(path, ["config", "user.name"]), `Lane Identity ${index + 1}`);
      records.push({ agent, identity, label, path });
    }
    assert.notEqual(records[0].path, records[1].path);
    assert.notEqual(records[0].identity, records[1].identity);
    assert.notEqual(records[0].label, records[1].label);
    assert.notEqual(records[0].agent, records[1].agent);
    negativeControl("root/repository identity labels and agent names");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("long Unicode workspace labels retain graphemes and fragments within 64 code points", () => {
  const accent = "e\u0301";
  const family = "👨‍👩‍👧‍👦";
  const fixtures = ["a", "b"].map((suffix) => makeFixture(undefined, {
    repoParts: [`${accent.repeat(12)}-root-${suffix}`, `${family.repeat(3)}-repository-${suffix}`],
  }));
  try {
    const labels = [];
    for (const [index, fixture] of fixtures.entries()) {
      const rootIdentity = realpathSync(dirname(fixture.repo));
      writeFileSync(join(rootIdentity, ".lane.json"), `${JSON.stringify({ validate: "true" })}\n`);
      fixture.env = discoveredEnv(fixture, { HOME: fixture.root });
      const topic = `${"common-prefix-".repeat(4)}${index === 0 ? "a" : "b"}`;
      const path = join(rootIdentity, ".worktrees", fixture.repo.split("/").at(-1), `lane-${topic}`);
      const fake = writeFakeHerdr(fixture, { lanePath: path, branch: `lane/${topic}` });
      const opened = lane(fixture, ["open", topic]);
      assert.equal(opened.status, 0, opened.stderr);
      const create = fake.calls().find((args) => args[0] === "worktree" && args[1] === "create");
      const label = create[create.indexOf("--label") + 1];
      assert.ok([...label].length <= 64, `${[...label].length} code points: ${label}`);
      assert.match(label, new RegExp(`^(?:${accent})+…/`));
      assert.ok(label.includes(`${family}${family}…:lane-common-prefix-`));
      assert.match(label, /~[0-9a-f]{8,}$/);
      assert.ok(label.endsWith(identityDigest(rootIdentity, repositoryIdentity(fixture.repo), topic)));
      labels.push(label);
    }
    assert.notEqual(labels[0], labels[1]);
    negativeControl("bounded grapheme-safe identity labels");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("open refuses symlink escapes and destinations inside repository checkouts before mutation", () => {
  const fixtures = [];
  try {
    const escaped = makeFixture();
    fixtures.push(escaped);
    const selectedBase = join(escaped.root, "selected-base");
    const outside = join(escaped.root, "outside-base");
    mkdirSync(selectedBase);
    mkdirSync(outside);
    symlinkSync(outside, join(selectedBase, "repo"));
    writeConfig(escaped, { main: "main", validate: "true", worktree_root: selectedBase });
    delete escaped.env.LANE_WORKTREE_ROOT;
    const escape = lane(escaped, ["open", "symlink-escape"]);
    assert.equal(escape.status, 1);
    assert.match(escape.stderr, /unsafe worktree path.*outside selected base/);
    assert.ok(!existsSync(join(outside, "lane-symlink-escape")));
    assert.ok(!refExists(escaped.repo, "refs/heads/lane/symlink-escape"));

    const canonical = makeFixture();
    fixtures.push(canonical);
    canonical.env.LANE_WORKTREE_ROOT = join(canonical.repo, "nested-worktrees");
    const descendant = lane(canonical, ["open", "checkout-descendant"]);
    assert.equal(descendant.status, 1);
    assert.match(descendant.stderr, /unsafe worktree path.*canonical checkout/);
    assert.ok(!refExists(canonical.repo, "refs/heads/lane/checkout-descendant"));

    const registered = makeFixture();
    fixtures.push(registered);
    const host = openLane(registered, "registered-host");
    registered.env.LANE_WORKTREE_ROOT = join(host, "nested-worktrees");
    const nested = lane(registered, ["open", "registered-descendant"]);
    assert.equal(nested.status, 1);
    assert.match(nested.stderr, /unsafe worktree path.*registered checkout/);
    assert.ok(!refExists(registered.repo, "refs/heads/lane/registered-descendant"));

    const foreign = makeFixture();
    fixtures.push(foreign);
    const other = join(foreign.root, "other-repository");
    gitExec(["init", "-b", "main", other], { stdio: "ignore" });
    foreign.env.LANE_WORKTREE_ROOT = join(other, "nested-worktrees");
    const otherRepo = lane(foreign, ["open", "foreign-descendant"]);
    assert.equal(otherRepo.status, 1);
    assert.match(otherRepo.stderr, /unsafe worktree path.*another repository/);
    assert.ok(!refExists(foreign.repo, "refs/heads/lane/foreign-descendant"));
    negativeControl("realpath and checkout descendant guards");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("registered paths are rejected when their on-disk repository identity changes", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "swapped-owner");
    const original = `${path}-original`;
    execFileSync("mv", [path, original]);
    const foreign = join(fixture.root, "foreign-checkout");
    gitExec(["init", "-b", "main", foreign], { stdio: "ignore" });
    symlinkSync(foreign, path);
    const run = lane(fixture, ["status"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /registered worktree .* does not belong to canonical git common directory/);
    negativeControl("registered worktree ownership verification");
  } finally {
    fixture.cleanup();
  }
});

test("a missing registered worktree names git worktree prune", () => {
  const fixture = makeFixture();
  try {
    const path = openLane(fixture, "missing-registration");
    renameSync(path, `${path}-moved`);
    const run = lane(fixture, ["status"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /registered worktree .* is missing; run git worktree prune/);
    assert.doesNotMatch(run.stderr, /does not belong to canonical git common directory/);
    negativeControl("missing registered worktree guidance");
  } finally {
    fixture.cleanup();
  }
});

test("stale Herdr checkout metadata is not used for dispatch or close", () => {
  const dispatchFixture = makeFixture();
  const closeFixture = makeFixture();
  try {
    ignoreLaneState(dispatchFixture);
    const dispatchPath = openLane(dispatchFixture, "stale-dispatch");
    const dispatchFake = writeFakeHerdr(dispatchFixture, {
      lanePath: dispatchPath,
      branch: "lane/stale-dispatch",
      staleId: "w-stale",
      staleLabel: "root/repo:lane-stale-dispatch",
      foreignRepoKey: join(dispatchFixture.root, "foreign.git"),
      noRepair: true,
    });
    const dispatched = lane(dispatchFixture, ["dispatch", "stale-dispatch", "do not send"]);
    assert.equal(dispatched.status, 1);
    assert.match(dispatched.stderr, /Herdr workspace w-stale.*repository identity mismatch/);
    assert.ok(!dispatchFake.calls().some((args) => args[0] === "tab" && args[1] === "create"));

    const closePath = openLane(closeFixture, "stale-close");
    const closeFake = writeFakeHerdr(closeFixture, {
      lanePath: closePath,
      branch: "lane/stale-close",
      staleId: "w-stale",
      staleLabel: "root/repo:lane-stale-close",
      foreignRepoKey: join(closeFixture.root, "foreign.git"),
      noRepair: true,
    });
    const closed = lane(closeFixture, ["close", "stale-close"]);
    assert.equal(closed.status, 1, closed.stderr);
    assert.match(closed.stderr, /metadata\/common directory mismatch/);
    assert.ok(!closeFake.calls().some((args) => args[0] === "worktree" && args[1] === "remove"));
    assert.ok(existsSync(closePath));
    negativeControl("stale Herdr path identity refusal");
  } finally {
    dispatchFixture.cleanup();
    closeFixture.cleanup();
  }
});

test("linked invocation creates labeled children under the canonical repository workspace", () => {
  const fixture = makeFixture(undefined, { repoParts: ["repo", "repo"] });
  try {
    const caller = join(fixture.root, "caller-lane");
    git(fixture.repo, ["worktree", "add", "-b", "lane/caller", caller], { stdio: "ignore" });
    const path = lanePath(fixture, "child-topic");
    const fake = writeFakeHerdr(fixture, {
      callerPath: caller,
      lanePath: path,
      branch: "lane/child-topic",
    });
    const opened = lane(fixture, ["open", "child-topic"], { cwd: caller });
    assert.equal(opened.status, 0, opened.stderr);
    const controls = fake.calls().filter((args) => args[0] === "worktree" && ["create", "open"].includes(args[1]));
    assert.ok(controls.length >= 2);
    for (const args of controls) {
      assert.equal(args[args.indexOf("--workspace") + 1], "w-parent");
      assert.notEqual(args[args.indexOf("--workspace") + 1], "w-caller");
      assert.equal(args[args.indexOf("--label") + 1], "repo/repo:lane-child-topic");
    }
    assert.equal(
      fake.calls().filter((args) => args[0] === "workspace" && args[1] === "list").length,
      2,
    );
    negativeControl("canonical Herdr parent and labeled child");
  } finally {
    fixture.cleanup();
  }
});

test("open refreshes Herdr workspaces after a failed create before accepting fallback metadata", () => {
  const fixture = makeFixture();
  try {
    const path = lanePath(fixture, "fallback-refresh");
    const fake = writeFakeHerdr(fixture, {
      lanePath: path,
      branch: "lane/fallback-refresh",
      failedCreateOpened: true,
    });
    const opened = lane(fixture, ["open", "fallback-refresh"]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, /herdr workspace: w-lane/);
    assert.equal(
      fake.calls().filter((args) => args[0] === "worktree" && args[1] === "open").length,
      0,
    );
    assert.equal(
      fake.calls().filter((args) => args[0] === "workspace" && args[1] === "list").length,
      2,
    );
    negativeControl("failed-create workspace refresh");
  } finally {
    fixture.cleanup();
  }
});

test("close warns and succeeds when registry policy refuses automated metadata", () => {
  const scenarios = [
    {
      topic: "external-close-registry",
      configure(fixture) {
        const registry = join(fixture.root, "external-sessions.json");
        writeConfig(fixture, { main: "main", validate: "true", registry });
        writeFileSync(registry, "[]\n");
      },
      expected: /repository-local registry/u,
    },
    {
      topic: "unignored-close-registry",
      configure(fixture) {
        mkdirSync(join(fixture.repo, ".lane"), { recursive: true });
        writeFileSync(join(fixture.repo, ".lane", "sessions.json"), "[]\n");
      },
      expected: /registry.*gitignored/u,
    },
    {
      topic: "tracked-close-registry",
      configure(fixture) {
        ignoreLaneState(fixture);
        mkdirSync(join(fixture.repo, ".lane"), { recursive: true });
        writeFileSync(join(fixture.repo, ".lane", "sessions.json"), "[]\n");
        git(fixture.repo, ["add", "-f", ".lane/sessions.json"]);
        git(fixture.repo, ["commit", "-m", "track registry"], { stdio: "ignore" });
      },
      expected: /registry.*tracked/u,
    },
  ];
  for (const scenario of scenarios) {
    const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
    try {
      scenario.configure(fixture);
      const path = openLane(fixture, scenario.topic);
      const closed = lane(fixture, ["close", scenario.topic]);
      assert.equal(closed.status, 0, closed.stderr);
      assert.match(closed.stderr, /warning: session registry/u);
      assert.match(closed.stderr, scenario.expected);
      assert.doesNotMatch(closed.stderr, /lane closed; metadata update failed/u);
      assert.ok(!existsSync(path));
      assert.ok(!refExists(fixture.repo, `refs/heads/lane/${scenario.topic}`));
    } finally {
      fixture.cleanup();
    }
  }
  negativeControl("close policy refusal warning boundary");
});

test("close marks exact repository topic sessions done only after git close succeeds", async () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    ignoreLaneState(fixture);
    const path = openLane(fixture, "close-sessions");
    const otherPath = openLane(fixture, "other-topic");
    writeFakeHerdr(fixture, { lanePath: path, branch: "lane/close-sessions", initiallyOpened: true });
    assert.equal(lane(fixture, ["dispatch", "close-sessions", "first"]).status, 0);
    assert.equal(lane(fixture, ["dispatch", "close-sessions", "second"]).status, 0);
    writeFakeHerdr(fixture, { lanePath: otherPath, branch: "lane/other-topic", initiallyOpened: true });
    assert.equal(lane(fixture, ["dispatch", "other-topic", "other"]).status, 0);
    const { loadRegistry } = await registryApi();
    writeFileSync(join(fixture.repo, ".lane", "sessions.json.d", "unrelated-malformed.json"), "{\n");
    writeFileSync(join(path, "dirty.txt"), "dirty\n");
    const refused = lane(fixture, ["close", "close-sessions"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /lane worktree is not clean/u);
    assert.ok(loadRegistry(fixture.repo, { registry: ".lane/sessions.json" }).sessions.every((session) => !session.done));
    rmSync(join(path, "dirty.txt"));
    writeFakeHerdr(fixture, { lanePath: path, branch: "lane/close-sessions", initiallyOpened: true });
    const stoppedState = join(fixture.root, 'herdr-state.json');
    writeFileSync(stoppedState, JSON.stringify({ ...JSON.parse(readFileSync(stoppedState, 'utf8')), agent: null }));
    const closed = lane(fixture, ["close", "close-sessions"]);
    assert.equal(closed.status, 0, closed.stderr);
    assert.match(closed.stderr, /warning: session registry.*unrelated-malformed\.json/u);
    const sessions = loadRegistry(fixture.repo, { registry: ".lane/sessions.json" }).sessions;
    assert.ok(sessions.filter((session) => session.topic === "close-sessions").every((session) => session.done));
    assert.ok(sessions.filter((session) => session.topic === "other-topic").every((session) => !session.done));
    assert.ok(!refExists(fixture.repo, "refs/heads/lane/close-sessions"));
    negativeControl("close completion ordering");
  } finally {
    fixture.cleanup();
  }
});

test("failed archive and post-close metadata writes preserve honest completion state", async () => {
  const archiveFixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  const metadataFixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    ignoreLaneState(archiveFixture);
    const archivePath = openLane(archiveFixture, "archive-failure");
    commitFile(archivePath, "lane-change.txt", "unmerged\n", "leave lane unmerged");
    writeFakeHerdr(archiveFixture, { lanePath: archivePath, branch: "lane/archive-failure", initiallyOpened: true });
    assert.equal(lane(archiveFixture, ["dispatch", "archive-failure", "archive me"]).status, 0);
    git(archiveFixture.repo, ["tag", "archive/lane/archive-failure", "main"]);
    const stoppedArchiveState = join(archiveFixture.root, 'herdr-state.json');
    writeFileSync(stoppedArchiveState, JSON.stringify({ ...JSON.parse(readFileSync(stoppedArchiveState, 'utf8')), agent: null }));
    const archiveClose = lane(archiveFixture, ["close", "archive-failure"]);
    assert.equal(archiveClose.status, 1);
    assert.ok(refExists(archiveFixture.repo, "refs/heads/lane/archive-failure"));
    const { loadRegistry } = await registryApi();
    assert.ok(loadRegistry(archiveFixture.repo).sessions.every((session) => !session.done));

    ignoreLaneState(metadataFixture);
    const metadataPath = openLane(metadataFixture, "metadata-failure");
    commitFile(metadataPath, "lane-change.txt", "unmerged\n", "leave lane unmerged");
    writeFakeHerdr(metadataFixture, {
      lanePath: metadataPath,
      branch: "lane/metadata-failure",
      initiallyOpened: true,
    });
    assert.equal(lane(metadataFixture, ["dispatch", "metadata-failure", "record me"]).status, 0);
    const metadataRegistry = join(metadataFixture.repo, ".lane", "sessions.json");
    const [metadataSession] = loadRegistry(metadataFixture.repo).sessions;
    mkdirSync(join(`${metadataRegistry}.d`, `${metadataSession.session_id}.done.json`));
    const stoppedMetadataState = join(metadataFixture.root, 'herdr-state.json');
    writeFileSync(stoppedMetadataState, JSON.stringify({ ...JSON.parse(readFileSync(stoppedMetadataState, 'utf8')), agent: null }));
    const metadataClose = lane(metadataFixture, ["close", "metadata-failure"]);
    assert.equal(metadataClose.status, 1);
    assert.match(metadataClose.stderr, /lane closed; metadata update failed/u);
    assert.ok(!existsSync(metadataPath));
    assert.ok(!refExists(metadataFixture.repo, "refs/heads/lane/metadata-failure"));
    assert.ok(refExists(metadataFixture.repo, "refs/tags/archive/lane/metadata-failure"));
    assert.equal(loadRegistry(metadataFixture.repo).sessions[0].done, false);
    negativeControl("archive and post-close metadata failure boundaries");
  } finally {
    archiveFixture.cleanup();
    metadataFixture.cleanup();
  }
});

test("git-only close with no registry creates no metadata store", () => {
  const fixture = makeFixture({ main: "main", validate: "true", registry: ".lane/sessions.json" });
  try {
    const path = openLane(fixture, "no-registry-close");
    const closed = lane(fixture, ["close", "no-registry-close"]);
    assert.equal(closed.status, 0, closed.stderr);
    assert.ok(!existsSync(path));
    assert.ok(!existsSync(join(fixture.repo, ".lane")));
    negativeControl("close without registry metadata");
  } finally {
    fixture.cleanup();
  }
});

test("a repository with a separate git directory retains its canonical checkout identity", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-lanes-separate-test-")));
  const repo = join(root, "working", "repository");
  const gitDirectory = join(root, "metadata", "repository.git");
  const bin = join(root, "bin");
  const configPath = join(root, "lane.json");
  const worktrees = join(root, "worktrees");
  mkdirSync(dirname(repo), { recursive: true });
  mkdirSync(dirname(gitDirectory), { recursive: true });
  mkdirSync(bin);
  symlinkSync(GIT, join(bin, "git"));
  symlinkSync(HEAD, join(bin, "head"));
  gitExec(["init", "-b", "main", "--separate-git-dir", gitDirectory, repo], { stdio: "ignore" });
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git(repo, ["add", "shared.txt"]);
  git(repo, ["commit", "-m", "initial"], { stdio: "ignore" });
  writeFileSync(configPath, `${JSON.stringify({ main: "main", validate: "true" })}\n`);
  const fixture = {
    root, repo, bin, configPath, worktrees,
    env: { ...hermeticGitEnvironment(), PATH: bin, LANE_CONFIG: configPath, LANE_WORKTREE_ROOT: worktrees },
  };
  try {
    const opened = lane(fixture, ["open", "separate-directory"]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, new RegExp(`canonical checkout: ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(opened.stdout, new RegExp(`repository identity: ${realpathSync(gitDirectory).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.ok(existsSync(join(worktrees, "lane-separate-directory")));
    negativeControl("separate git directory canonical checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected malformed, unreadable, and wrongly typed config files fail before mutation", () => {
  const fixtures = [];
  try {
    const malformed = makeFixture();
    fixtures.push(malformed);
    const malformedPath = join(malformed.repo, ".lane.json");
    writeFileSync(malformedPath, "{ malformed\n");
    const malformedRun = lane(malformed, ["open", "malformed-config"], { env: discoveredEnv(malformed) });
    assert.equal(malformedRun.status, 1);
    assert.match(malformedRun.stderr, new RegExp(`invalid lane config .*${malformedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.ok(!refExists(malformed.repo, "refs/heads/lane/malformed-config"));

    const typed = makeFixture();
    fixtures.push(typed);
    const typedPath = join(typed.repo, ".lane.json");
    writeFileSync(typedPath, `${JSON.stringify({ prepare: "npm ci" })}\n`);
    const typedRun = lane(typed, ["open", "typed-config"], { env: discoveredEnv(typed) });
    assert.equal(typedRun.status, 1);
    assert.match(typedRun.stderr, /invalid lane config .*prepare must be an array/);
    assert.ok(!refExists(typed.repo, "refs/heads/lane/typed-config"));

    const unreadable = makeFixture();
    fixtures.push(unreadable);
    const directory = join(unreadable.repo, "config-directory");
    mkdirSync(directory);
    const unreadableRun = lane(unreadable, ["open", "unreadable-config"], {
      env: discoveredEnv(unreadable, { LANE_CONFIG: directory }),
    });
    assert.equal(unreadableRun.status, 1);
    assert.match(unreadableRun.stderr, /cannot read lane config/);
    assert.ok(!refExists(unreadable.repo, "refs/heads/lane/unreadable-config"));

    const missing = makeFixture();
    fixtures.push(missing);
    const missingPath = join(missing.repo, "missing.json");
    const missingRun = lane(missing, ["config"], {
      env: discoveredEnv(missing, { LANE_CONFIG: missingPath }),
    });
    assert.equal(missingRun.status, 1);
    assert.match(missingRun.stderr, /cannot read lane config/);
    negativeControl("invalid selected config refusal");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("open refuses ordinary and foreign-worktree destinations without creating branches", () => {
  const fixture = makeFixture();
  try {
    const ordinaryPath = lanePath(fixture, "occupied-directory");
    mkdirSync(ordinaryPath, { recursive: true });
    const sentinel = join(ordinaryPath, "keep.txt");
    writeFileSync(sentinel, "preserve\n");
    const ordinary = lane(fixture, ["open", "occupied-directory"]);
    assert.equal(ordinary.status, 1);
    assert.match(ordinary.stderr, /worktree path already exists/);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve\n");
    assert.ok(!refExists(fixture.repo, "refs/heads/lane/occupied-directory"));

    writeConfig(fixture, {
      main: "main",
      validate: "true",
      worktree_root: join(fixture.root, "shared-base"),
    });
    delete fixture.env.LANE_WORKTREE_ROOT;
    const foreignRepo = join(fixture.root, "foreign-repo");
    const foreignPath = join(fixture.root, "shared-base", "repo", "lane-foreign-worktree");
    gitExec(["init", "-b", "main", foreignRepo], { stdio: "ignore" });
    writeFileSync(join(foreignRepo, "foreign.txt"), "foreign\n");
    git(foreignRepo, ["add", "foreign.txt"]);
    git(foreignRepo, ["commit", "-m", "foreign initial"], { stdio: "ignore" });
    git(foreignRepo, ["worktree", "add", "-b", "foreign-lane", foreignPath], { stdio: "ignore" });
    const foreignHead = git(foreignPath, ["rev-parse", "HEAD"]);
    const foreign = lane(fixture, ["open", "foreign-worktree"]);
    assert.equal(foreign.status, 1);
    assert.match(foreign.stderr, new RegExp(`worktree path belongs to another repository: ${foreignPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(foreign.stderr, /choose distinct worktree bases/);
    assert.equal(git(foreignPath, ["rev-parse", "HEAD"]), foreignHead);
    assert.ok(!refExists(fixture.repo, "refs/heads/lane/foreign-worktree"));
    negativeControl("occupied foreign path refusal");
  } finally {
    fixture.cleanup();
  }
});

test("registered legacy lane paths remain authoritative after worktree_root changes", () => {
  const fixture = makeFixture();
  try {
    ignoreLaneState(fixture);
    const originalPath = openLane(fixture, "legacy-location");
    writeConfig(fixture, { main: "main", validate: "true", worktree_root: join(fixture.root, "new-root") });
    delete fixture.env.LANE_WORKTREE_ROOT;

    const status = lane(fixture, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(originalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const dispatch = lane(fixture, ["dispatch", "legacy-location"]);
    assert.equal(dispatch.status, 1);
    assert.match(dispatch.stderr, /herdr is unavailable/);
    assert.doesNotMatch(dispatch.stderr, /has no worktree/);
    const check = lane(fixture, ["check", "--cmd", "true"], { cwd: originalPath });
    assert.equal(check.status, 0, check.stderr);
    commitFile(originalPath, "lane.txt", "lane\n", "legacy lane change");
    const promote = lane(fixture, ["promote", "legacy-location"]);
    assert.equal(promote.status, 0, promote.stderr);
    const close = lane(fixture, ["close", "legacy-location"]);
    assert.equal(close.status, 0, close.stderr);
    assert.ok(!existsSync(originalPath));
    negativeControl("registered legacy paths remain authoritative");
  } finally {
    fixture.cleanup();
  }
});

test("review sanitization preserves unrelated words and fails closed on ambiguous or unsafe payloads", () => {
  const fixtures = [];
  try {
    const preserved = makeReviewFixture("review-boundary", { verdict: "PASS" });
    fixtures.push(preserved.fixture);
    const username = userInfo().username;
    preserved.fixture.env.FAKE_REVIEW_PAYLOAD = JSON.stringify({
      findings: "- [Minor] shared.txt:1 - Annex remains unchanged; Fix: keep annex unchanged",
      nonclaims: `- ANN met annex.\n- _Ann_ and _${username}_ are private aliases.`,
      identifiers: ["Ann"],
      analysis: "Private only.",
    });
    const preservedRun = lane(preserved.fixture, ["review", "review-boundary", "--round", "1", "--brief", preserved.brief]);
    assert.equal(preservedRun.status, 0, preservedRun.stderr);
    const preservedHead = git(preserved.path, ["rev-parse", "HEAD"]);
    const preservedPublic = readFileSync(join(
      preserved.path, "docs", "reviews", "review-boundary", `${preservedHead.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.match(preservedPublic, /Annex remains unchanged; Fix: keep annex unchanged/);
    assert.match(preservedPublic, /- \[PRIVATE\] met annex\./);
    assert.match(preservedPublic, /- \\_\[PRIVATE\]\\_ and \\_\[USER\]\\_ are private aliases\./);

    const cases = [
      ["alias-ambiguity", { identifiers: ["Ann", "Anna"] }],
      ["protected-location", { findings: "- [Major] shared.txt:1 - issue; Fix: change it", identifiers: ["shared"] }],
      ["location-backtick", { findings: "- [Major] `shared`.txt:1 - issue; Fix: change it" }],
      ["location-angle", { findings: "- [Major] <shared>.txt:1 - issue; Fix: change it" }],
      ["location-bracket", { findings: "- [Major] [shared].txt:1 - issue; Fix: change it" }],
      ["location-emphasis", { findings: "- [Major] **shared**.txt:1 - issue; Fix: change it" }],
      ["location-placeholder", { findings: "- [Major] [USER].txt:1 - issue; Fix: change it" }],
      ["location-encoded", { findings: "- [Major] shared%2Fsecret.txt:1 - issue; Fix: change it", identifiers: ["secret"] }],
      ["location-path-after-paren", { findings: "- [Major] wrapper)/var/tmp/private.txt:1 - issue; Fix: change it" }],
      ["location-path-after-bracket", { findings: "- [Major] wrapper]/var/tmp/private.txt:1 - issue; Fix: change it" }],
      ["location-path-after-brace", { findings: "- [Major] wrapper}/var/tmp/private.txt:1 - issue; Fix: change it" }],
      ["ambiguous-spaced-path", { nonclaims: "- The external record /var/tmp/private first second next/segment was not inspected." }],
      ["location-path-flag-segment", { findings: "- [Major] wrapper)/var/tmp/g:1 - issue; Fix: change it" }],
      ["percent-encoded-alias", { nonclaims: "- A%6En was not independently authenticated.", identifiers: ["Ann"] }],
      ["numeric-reference-alias", { nonclaims: "- A&#110;n was not independently authenticated.", identifiers: ["Ann"] }],
      ["non-ascii", { findings: "- [Minor] shared.txt:1 - caf\u00e9 issue; Fix: use ASCII" }],
      ["placeholder", { nonclaims: "- Existing [USER] marker." }],
    ];
    for (const [suffix, payload] of cases) {
      const topic = `review-${suffix}`;
      const refused = makeReviewFixture(topic, { verdict: "PASS", payload });
      fixtures.push(refused.fixture);
      const run = lane(refused.fixture, ["review", topic, "--round", "1", "--brief", refused.brief]);
      assert.equal(run.status, 2, `${suffix}\n${run.stderr}`);
      assert.equal(run.stdout, "");
      const head = git(refused.path, ["rev-parse", "HEAD"]);
      assert.ok(!existsSync(join(refused.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`)));
    }
    negativeControl("sanitization boundaries and refusals");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review publishes exclusively, leaves normal clean-tree commands refusing, and blocks the occupied round", () => {
  const review = makeReviewFixture("review-public-boundary", { verdict: "PASS" });
  try {
    const first = lane(review.fixture, ["review", "review-public-boundary", "--round", "1", "--brief", review.brief]);
    assert.equal(first.status, 0, first.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicPath = join(review.path, "docs", "reviews", "review-public-boundary", `${head.slice(0, 7)}-r1.md`);
    assert.ok(existsSync(publicPath));
    const prompts = review.fake.calls().filter((args) => args[0] === "agent" && args[1] === "prompt").length;
    const second = lane(review.fixture, ["review", "review-public-boundary", "--round", "1", "--brief", review.brief]);
    assert.equal(second.status, 2);
    assert.equal(second.stdout, "");
    assert.equal(review.fake.calls().filter((args) => args[0] === "agent" && args[1] === "prompt").length, prompts);
    const check = lane(review.fixture, ["check", "--cmd", "true"], { cwd: review.path });
    assert.equal(check.status, 1);
    assert.match(check.stderr, /current worktree is not clean/);
    const promote = lane(review.fixture, ["promote", "review-public-boundary"]);
    assert.equal(promote.status, 1);
    assert.match(promote.stderr, /lane worktree is not clean/);
    negativeControl("exclusive publication and clean-tree refusal");
  } finally {
    review.fixture.cleanup();
  }
});

test("review late-publication mutation exits 2 and retains both evidence files", async () => {
  const review = makeReviewFixture("review-late-public", { verdict: "PASS" });
  try {
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const directory = join(review.path, "docs", "reviews", "review-late-public");
    const publicPath = join(directory, `${head.slice(0, 7)}-r1.md`);
    mkdirSync(directory, { recursive: true });
    let mutated = false;
    const mutator = setInterval(() => {
      if (!mutated && existsSync(publicPath)) {
        mutated = true;
        writeFileSync(join(review.path, "late-mutation.txt"), "late\n");
      }
    }, 1);
    currentTest().after(() => clearInterval(mutator));
    const child = spawnChild(currentTest(), process.execPath, [
      LANE, "review", "review-late-public", "--round", "1", "--brief", review.brief,
    ], {
      cwd: review.fixture.repo,
      env: hermeticGitEnvironment(review.fixture.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const { code: result } = await waitForExit(child);
    clearInterval(mutator);
    assert.equal(result, 2, stderr);
    assert.equal(stdout, "");
    assert.ok(mutated);
    assert.ok(existsSync(publicPath));
    assert.ok(existsSync(join(review.fixture.repo, ".lane", "reviews", "review-late-public", `${head.slice(0, 7)}-r1.md`)));
    assert.match(stderr, /mutation after public review creation|late publication/);
    negativeControl("late publication evidence retention");
  } finally {
    review.fixture.cleanup();
  }
});

test("review renders OpenSpec, supplemental literal input, gate, and captured commit metadata", () => {
  const review = makeReviewFixture("review-source", {
    verdict: "PASS",
    brief: "Review run budget:\n- command: printf '$HOME; $(touch nope)'\n  maximum runs: 1\nSecond line.\n",
  });
  try {
    const changeRoot = join(review.path, "openspec", "changes", "different-change");
    mkdirSync(join(changeRoot, "specs", "sample"), { recursive: true });
    for (const [name, text] of [
      ["proposal.md", "proposal sentinel"],
      ["design.md", "design sentinel"],
      ["tasks.md", "tasks sentinel"],
      [join("specs", "sample", "spec.md"), "delta sentinel"],
    ]) writeFileSync(join(changeRoot, name), `${text}\n`);
    mkdirSync(join(review.path, "openspec", "specs", "sample"), { recursive: true });
    writeFileSync(join(review.path, "openspec", "specs", "sample", "spec.md"), "current sentinel\n");
    git(review.path, ["add", "openspec"]);
    git(review.path, ["commit", "-m", "add review source"], { stdio: "ignore" });
    const head = git(review.path, ["rev-parse", "HEAD"]);
    mkdirSync(join(review.path, ".lane"), { recursive: true });
    writeFileSync(join(review.path, ".lane", "gate.json"), `${JSON.stringify({
      head,
      branch: "lane/review-source",
      command: "node --test",
      exit_code: 0,
      signal: null,
      started_at: "2026-09-09T00:00:00.000Z",
      finished_at: "2026-09-09T00:00:01.000Z",
      duration_s: 1,
    })}\n`);
    const run = lane(review.fixture, [
      "review", "review-source", "--round", "2", "--change", "different-change",
      "--brief", review.brief, "--route", "alternate", "--timeout", "5",
    ]);
    assert.equal(run.status, 0, run.stderr);
    const prompt = review.fake.calls().find((args) => args[0] === "agent" && args[1] === "prompt")?.[3] ?? "";
    for (const sentinel of ["proposal sentinel", "design sentinel", "tasks sentinel", "delta sentinel", "current sentinel"]) {
      assert.match(prompt, new RegExp(sentinel));
    }
    assert.match(prompt, /printf '\$HOME; \$\(touch nope\)'/);
    assert.match(prompt, new RegExp(`Reviewed commit: ${head}`));
    assert.match(prompt, /Gate at captured HEAD: exit=0/);
    assert.match(prompt, /Route: alternate/);
    assert.match(prompt, /Timeout seconds: 5/);
    negativeControl("review source and captured metadata rendering");
  } finally {
    review.fixture.cleanup();
  }
});

test("review keeps uppercase brace tokens literal in briefs and tracked source files", () => {
  const fixtures = [];
  try {
    const briefReview = makeReviewFixture("review-brief-token", {
      verdict: "PASS", brief: "Treat {{BRIEF_TOKEN}} as literal source text.\n",
    });
    fixtures.push(briefReview.fixture);
    const briefRun = lane(briefReview.fixture, [
      "review", "review-brief-token", "--round", "1", "--brief", briefReview.brief,
    ]);
    assert.equal(briefRun.status, 0, briefRun.stderr);
    const briefPrompt = briefReview.fake.calls().find((args) => args[0] === "agent" && args[1] === "prompt")?.[3] ?? "";
    assert.match(briefPrompt, /\{\{BRIEF_TOKEN\}\}/);

    const trackedReview = makeReviewFixture("review-tracked-token", { verdict: "PASS" });
    fixtures.push(trackedReview.fixture);
    writeFileSync(join(trackedReview.path, "AGENTS.md"), "Treat {{TRACKED_TOKEN}} as literal source text.\n");
    git(trackedReview.path, ["add", "AGENTS.md"]);
    git(trackedReview.path, ["commit", "-m", "add literal review source"], { stdio: "ignore" });
    const trackedRun = lane(trackedReview.fixture, [
      "review", "review-tracked-token", "--round", "1", "--brief", trackedReview.brief,
    ]);
    assert.equal(trackedRun.status, 0, trackedRun.stderr);
    const trackedPrompt = trackedReview.fake.calls().find((args) => args[0] === "agent" && args[1] === "prompt")?.[3] ?? "";
    assert.match(trackedPrompt, /\{\{TRACKED_TOKEN\}\}/);
    negativeControl("literal source brace tokens");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review refuses reconstructed Claude inherited-gate test-pass prose", () => {
  const topic = "review-claude-inherited-claim";
  const review = makeReviewFixture(topic, { verdict: "PASS" });
  review.fixture.env.FAKE_REVIEW_RECORD_PATH = join(HERE, "fixtures", "inherited-gate-claim-review.md");
  try {
    const head = git(review.path, ["rev-parse", "HEAD"]);
    mkdirSync(join(review.path, ".lane"), { recursive: true });
    writeFileSync(join(review.path, ".lane", "gate.json"), JSON.stringify({
      head, branch: `lane/${topic}`, command: "node --test", exit_code: 0,
      started_at: "2026-10-05T00:00:00.000Z", finished_at: "2026-10-05T00:00:01.000Z",
    }));
    const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief, "--route", "alternate"]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /gate exit=0/);
    assert.match(run.stderr, /tests-pass claims are allowed only in witnessed Re-executed entries/);
    assert.match(readFileSync(privateReviewDelivery(review), "utf8"), /inherited lane gate shows tests passed/);
    assert.ok(!existsSync(join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`)));
  } finally {
    review.fixture.cleanup();
  }
});

test("review accepts only the exact inherited-gate acknowledgment under Non-claims on either route", () => {
  assert.equal(INHERITED_GATE_NON_CLAIM,
    "- The supplied gate is inherited evidence; this review does not claim tests passed.");
  const cases = [
    ["alternate", { nonclaims: INHERITED_GATE_NON_CLAIM }, 0],
    ["review-codex", { nonclaims: INHERITED_GATE_NON_CLAIM }, 0],
    ["alternate", { unverified: INHERITED_GATE_NON_CLAIM }, 2],
    ["alternate", { findings: INHERITED_GATE_NON_CLAIM }, 2],
    ["alternate", { nonclaims: `${INHERITED_GATE_NON_CLAIM} Tests passed.` }, 2],
    ["alternate", { nonclaims: `${INHERITED_GATE_NON_CLAIM}\n- The inherited gate confirms tests passed.` }, 2],
    ["alternate", { nonclaims: "- The supplied gate is inherited evidence; this reviewer does not claim tests passed." }, 2],
  ];
  for (const [index, [route, payload, status]] of cases.entries()) {
    const topic = `review-inherited-ack-${index}`;
    const review = makeReviewFixture(topic, { verdict: "PASS", payload });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief, "--route", route]);
      assert.equal(run.status, status, run.stderr);
      assert.equal(run.stdout, status === 0 ? "PASS\n" : "");
      const head = git(review.path, ["rev-parse", "HEAD"]);
      const publicPath = join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`);
      if (status === 0) {
        const record = readFileSync(publicPath, "utf8");
        assert.match(record, /## Re-executed\n```json\n\[\]/);
        assert.ok(record.includes(`## Non-claims\n${INHERITED_GATE_NON_CLAIM}\n`));
        const prompt = review.fake.calls().find(args => args[0] === "agent" && args[1] === "prompt")[3];
        assert.ok(prompt.includes(INHERITED_GATE_NON_CLAIM));
        assert.match(prompt, /accepted only under Non-claims/);
      } else {
        assert.match(run.stderr, /tests-pass claims are allowed only in witnessed Re-executed entries/);
        assert.ok(!existsSync(publicPath));
      }
    } finally {
      review.fixture.cleanup();
    }
  }
});

test("review inherited-gate acknowledgment cannot replace an execution witness", () => {
  const witnessed = {
    command: "node --test", cwd: "scratch", exit_code: 0, result: "Observed suite completion", tests_pass: true,
    witness: { kind: "mutation", command: "node --test broken.test.mjs", cwd: "scratch", exit_code: 1,
      result: "Observed mutation rejection", observed_failure: "The mutated expectation failed" },
  };
  const cases = [
    [witnessed, 0],
    [{ ...witnessed, witness: null }, 2],
    [{ ...witnessed, exit_code: 1 }, 2],
  ];
  for (const [index, [execution, status]] of cases.entries()) {
    const topic = `review-inherited-witness-${index}`;
    const review = makeReviewFixture(topic, { verdict: "PASS",
      payload: { nonclaims: INHERITED_GATE_NON_CLAIM, reexecuted: [execution] } });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      assert.equal(run.status, status, run.stderr);
      if (status !== 0) assert.match(run.stderr, /tests_pass requires exit 0 and an observed witness/);
    } finally {
      review.fixture.cleanup();
    }
  }
});

test("review accepts negated test-pass limits but still refuses affirmative prose claims", () => {
  const fixtures = [];
  try {
    const limited = makeReviewFixture("review-negated-claim", {
      verdict: "PASS",
      payload: {
        unverified: "- Tests passed was not claimed.\n- The tests passed witness is unavailable.",
        analysis: "Tests passed appears only in private analysis.",
      },
    });
    fixtures.push(limited.fixture);
    const limitedRun = lane(limited.fixture, [
      "review", "review-negated-claim", "--round", "1", "--brief", limited.brief,
    ]);
    assert.equal(limitedRun.status, 0, limitedRun.stderr);

    const affirmative = makeReviewFixture("review-affirmative-claim", {
      verdict: "PASS", payload: { unverified: "- Tests passed in the suite." },
    });
    fixtures.push(affirmative.fixture);
    const affirmativeRun = lane(affirmative.fixture, [
      "review", "review-affirmative-claim", "--round", "1", "--brief", affirmative.brief,
    ]);
    assert.equal(affirmativeRun.status, 2, affirmativeRun.stderr);
    assert.equal(affirmativeRun.stdout, "");
    negativeControl("negated and affirmative test-pass prose");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review refuses malformed private evidence, incomplete output, timeout, and lane mutation", () => {
  const cases = [
    ["sha-mismatch", "PASS", 2],
    ["review-id-mismatch", "PASS", 2],
    ["bad-witness", "PASS", 2],
    ["incomplete", "PASS", 2],
    ["oversized", "PASS", 2],
    ["dirty-public", "PASS", 2],
    ["dirty-tracked", "PASS", 2],
    ["dirty-index", "PASS", 2],
    ["head-move", "PASS", 2],
    ["missing", undefined, 2],
  ];
  const fixtures = [];
  try {
    for (const [mode, verdict, exit] of cases) {
      const topic = `review-${mode}`;
      const review = makeReviewFixture(topic, { verdict, mode });
      fixtures.push(review.fixture);
      const capturedHead = git(review.path, ["rev-parse", "HEAD"]);
      const timeout = ["incomplete", "missing"].includes(mode) ? "3" : "4";
      const run = lane(review.fixture, [
        "review", topic, "--round", "1", "--brief", review.brief, "--timeout", timeout,
      ]);
      assert.equal(run.status, exit, `${mode}\n${run.stderr}`);
      assert.equal(run.stdout, "");
      const privatePath = privateReviewDelivery(review);
      if (verdict !== undefined) assert.ok(existsSync(privatePath), `${mode}: private delivery evidence retained`);
      assert.ok(!existsSync(join(review.fixture.repo, ".lane", "reviews", topic, `${capturedHead.slice(0, 7)}-r1.md`)));
      if (mode === "missing") {
        assert.match(run.stderr, /review timed out; reviewer agent '[a-z0-9_-]+' in tab w-lane:t2/);
      }
      assert.ok(review.fake.calls().filter((args) => args[0] === "agent" && args[1] === "prompt").length === 1);
    }
    negativeControl("review evidence and unchanged-lane refusals");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review sends malformed completed endings to schema validation without waiting for timeout", () => {
  const cases = [
    ["trailing-space-line", /private review completion marker must be the last nonempty line/],
    ["trailing-tab-line", /private review completion marker must be the last nonempty line/],
    ["crlf-record", /private review must use LF line endings; CRLF is not supported/],
  ];
  const fixtures = [];
  const outcomes = [];
  try {
    for (const [mode, diagnostic] of cases) {
      const topic = `review-${mode}`;
      const review = makeReviewFixture(topic, { verdict: "PASS", mode });
      fixtures.push(review.fixture);
      const started = Date.now();
      const run = lane(review.fixture, [
        "review", topic, "--round", "1", "--brief", review.brief, "--timeout", "4",
      ]);
      outcomes.push({
        mode,
        status: run.status,
        emptyStdout: run.stdout === "",
        schemaDiagnostic: diagnostic.test(run.stderr),
        timedOut: /review timed out/.test(run.stderr),
        elapsedMs: Date.now() - started,
      });
    }
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 2, JSON.stringify(outcome));
      assert.equal(outcome.emptyStdout, true, JSON.stringify(outcome));
      assert.equal(outcome.schemaDiagnostic, true, JSON.stringify(outcome));
      assert.equal(outcome.timedOut, false, JSON.stringify(outcome));
      assert.ok(outcome.elapsedMs >= 2_000 && outcome.elapsedMs < 3_800, JSON.stringify(outcome));
    }
    negativeControl("malformed completed record fast schema refusal");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review contains unexpected errors when target Git metadata disappears after dispatch", () => {
  const review = makeReviewFixture("review-removed-worktree", {
    verdict: "PASS", mode: "remove-worktree",
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-removed-worktree", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /lane review: unexpected failure; private evidence may have been retained/);
    assert.doesNotMatch(run.stderr, /(?:Error:|\n\s+at )/);
    assert.doesNotMatch(run.stderr, new RegExp(review.fixture.root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.ok(existsSync(privateReviewDelivery(review)));
    negativeControl("unexpected review error boundary");
  } finally {
    review.fixture.cleanup();
  }
});

test("review unexpected failure after publication warns about retained public evidence", async () => {
  const review = makeReviewFixture("review-post-public-error", { verdict: "PASS" });
  try {
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicPath = join(
      review.path, "docs", "reviews", "review-post-public-error", `${head.slice(0, 7)}-r1.md`,
    );
    let injected = false;
    const mutator = setInterval(() => {
      if (!injected && existsSync(publicPath)) {
        injected = true;
        renameSync(join(review.path, ".git"), join(review.path, ".git-injected-failure"));
      }
    }, 1);
    currentTest().after(() => clearInterval(mutator));
    const child = spawnChild(currentTest(), process.execPath, [
      LANE, "review", "review-post-public-error", "--round", "1", "--brief", review.brief,
    ], {
      cwd: review.fixture.repo,
      env: hermeticGitEnvironment(review.fixture.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const { code: result } = await waitForExit(child);
    clearInterval(mutator);
    assert.equal(result, 2, stderr);
    assert.equal(stdout, "");
    assert.equal(injected, true);
    assert.ok(existsSync(publicPath));
    assert.match(stderr, /public record may also have been created/);
    assert.match(stderr, /must be inspected before recovery/);
    assert.doesNotMatch(stderr, /(?:Error:|\n\s+at )/);
    assert.doesNotMatch(stderr, new RegExp(review.fixture.root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    negativeControl("post-publication unexpected failure recovery diagnostic");
  } finally {
    review.fixture.cleanup();
  }
});

test("review interruption exits 2 without a verdict or follow-up lifecycle action", async () => {
  const review = makeReviewFixture("review-interrupt");
  try {
    const child = spawnChild(currentTest(), process.execPath, [
      LANE, "review", "review-interrupt", "--round", "1", "--brief", review.brief,
    ], {
      cwd: review.fixture.repo,
      env: hermeticGitEnvironment(review.fixture.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await waitForFile(review.fake.log, text => text.includes('["agent","prompt"'), { timeoutMs: 5000 });
    child.kill("SIGTERM");
    const result = await waitForExit(child);
    assert.equal(result.code, 2, `signal=${result.signal}\n${stderr}`);
    assert.equal(stdout, "");
    assert.match(stderr, /review interrupted; reviewer agent '[a-z0-9_-]+' in tab w-lane:t2 may still write late evidence/);
    const calls = review.fake.calls();
    assert.equal(calls.filter((args) => args[0] === "agent" && args[1] === "prompt").length, 1);
    assert.ok(!calls.some((args) => ["close", "remove"].includes(args[1])));
    negativeControl("review interruption cleanup");
  } finally {
    review.fixture.cleanup();
  }
});

test("review reference describes the shipped public path and protected-location policy", () => {
  const reference = readFileSync(join(HERE, "..", "docs", "REFERENCE.md"), "utf8");
  assert.doesNotMatch(reference, /even though this first slice does not write it/);
  assert.match(reference, /same command creates the public record after the\s+unchanged-lane check/);
  assert.match(reference, /reserved placeholders[^.]*finding locations/iu);
  negativeControl("review reference publication and location wording");
});

test("review preflight requires ignored private and trackable absent public paths", () => {
  const fixtures = [];
  try {
    const privateNotIgnored = makeFixture({ main: "main", routes: { review: { kind: "codex" } } });
    fixtures.push(privateNotIgnored);
    const lanePathValue = openLane(privateNotIgnored, "private-ignore");
    const brief = join(privateNotIgnored.root, "brief.md");
    writeFileSync(brief, "Review.\n");
    writeFakeHerdr(privateNotIgnored, {
      lanePath: lanePathValue, branch: "lane/private-ignore", initiallyOpened: true, reviewVerdict: "PASS",
    });
    const ignoredRun = lane(privateNotIgnored, ["review", "private-ignore", "--round", "1", "--brief", brief]);
    assert.equal(ignoredRun.status, 2, ignoredRun.stderr);
    assert.equal(ignoredRun.stdout, "");

    const publicIgnored = makeReviewFixture("public-ignore", { verdict: "PASS" });
    fixtures.push(publicIgnored.fixture);
    writeFileSync(join(publicIgnored.path, ".gitignore"), ".lane/\ndocs/reviews/\n");
    git(publicIgnored.path, ["add", ".gitignore"]);
    git(publicIgnored.path, ["commit", "-m", "ignore public reviews"], { stdio: "ignore" });
    const publicRun = lane(publicIgnored.fixture, ["review", "public-ignore", "--round", "1", "--brief", publicIgnored.brief]);
    assert.equal(publicRun.status, 2, publicRun.stderr);
    assert.equal(publicRun.stdout, "");

    const existing = makeReviewFixture("existing-round", { verdict: "PASS" });
    fixtures.push(existing.fixture);
    const existingHead = git(existing.path, ["rev-parse", "HEAD"]);
    const occupied = join(existing.fixture.repo, ".lane", "reviews", "existing-round", `${existingHead.slice(0, 7)}-r1.md`);
    mkdirSync(dirname(occupied), { recursive: true });
    writeFileSync(occupied, "existing private evidence\n");
    const occupiedRun = lane(existing.fixture, ["review", "existing-round", "--round", "1", "--brief", existing.brief]);
    assert.equal(occupiedRun.status, 2, occupiedRun.stderr);
    assert.equal(occupiedRun.stdout, "");

    const escaped = makeReviewFixture("symlink-private", { verdict: "PASS" });
    fixtures.push(escaped.fixture);
    const reviewsRoot = join(escaped.fixture.repo, ".lane", "reviews");
    const outside = join(escaped.fixture.root, "outside-private");
    mkdirSync(join(escaped.fixture.repo, ".lane"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, reviewsRoot);
    const escapedRun = lane(escaped.fixture, ["review", "symlink-private", "--round", "1", "--brief", escaped.brief]);
    assert.equal(escapedRun.status, 2, escapedRun.stderr);
    assert.equal(escapedRun.stdout, "");
    negativeControl("review output path preflight");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("usage exits one with no command and with an unknown command", () => {
  const fixture = makeFixture();
  try {
    const missing = lane(fixture, []);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /^usage:/);
    const dispatchAlternatives = "dispatch <topic> [--route <name> | --kind <agent> --model <m>]";
    assert.ok(missing.stdout.includes(dispatchAlternatives));
    const missingTopic = lane(fixture, ["dispatch"]);
    assert.equal(missingTopic.status, 1);
    assert.ok(missingTopic.stderr.includes(dispatchAlternatives));
    assert.match(missing.stdout, /check \[--cmd <validate command>\]/);
    assert.match(
      missing.stdout,
      /  check \[--cmd <validate command>\] \[--tier fast\|promotion\]\n                   validate this clean worktree/,
    );
    assert.doesNotMatch(missing.stdout, /lane board/u);
    assert.match(missing.stdout, /  config           print resolved configuration as key, JSON value, and source/);
    const unknown = lane(fixture, ["not-a-command"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stdout, /^usage:/);
    const readme = readFileSync(resolve(HERE, "..", "README.md"), "utf8");
    assert.match(readme, /\| `lane config` \| Print resolved configuration values and sources \|/);
    assert.doesNotMatch(readme, /lane board/u);
    negativeControl("usage exits");
  } finally {
    fixture.cleanup();
  }
});

test("status exits quietly when a downstream reader closes stdout", () => {
  const fixture = makeFixture();
  try {
    for (const topic of ["pipe-one", "pipe-two", "pipe-three", "pipe-four", "pipe-five"]) {
      git(fixture.repo, ["branch", `lane/${topic}`]);
    }
    const command = `"${process.execPath}" "${LANE}" status | head -n 1`;
    const run = spawnSync("/bin/bash", ["-o", "pipefail", "-c", command], {
      cwd: fixture.repo,
      env: fixture.env,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /EPIPE/);
    assert.match(run.stdout, /^main [0-9a-f]{7}\n$/);
    negativeControl("EPIPE handling");
  } finally {
    fixture.cleanup();
  }
});

test("verify-agent mismatch control uses a fake Herdr", () => {
  const fixture = makeFixture();
  try {
    writeFakeHerdr(fixture);
    const run = spawnSync(process.execPath, [LANE, "verify-agent", "missing-agent", "/wrong/path"], {
      cwd: fixture.repo,
      env: fixture.env,
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /MISMATCH/);
    negativeControl("herdr cwd guard");
  } finally {
    fixture.cleanup();
  }
});

test('close marks matching sessions done even while empty workspace cleanup is pending', async () => {
  const fixture = makeFixture({ main: 'main', validate: 'true', registry: '.lane/sessions.json' });
  try {
    ignoreLaneState(fixture); const path = openLane(fixture, 'pending-workspace');
    commitFile(path, 'work.txt', 'unique work\n', 'work awaiting archive');
    const fake = writeFakeHerdr(fixture, { lanePath: path, branch: 'lane/pending-workspace', initiallyOpened: true });
    assert.equal(lane(fixture, ['dispatch', 'pending-workspace', 'record this session']).status, 0);
    const { loadRegistry } = await registryApi();
    assert.ok(loadRegistry(fixture.repo).sessions.some(s => s.topic === 'pending-workspace' && !s.done));
    const stateFile = join(fixture.root, 'herdr-state.json');
    writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), agent: null }));
    fixture.env.FAKE_HERDR_WORKSPACE_CLOSE_FAIL = '1';
    const closed = lane(fixture, ['close', 'pending-workspace']);
    assert.equal(closed.status, 1); assert.match(closed.stderr, /lane closed; workspace cleanup pending:.*injected workspace close failure/);
    assert.ok(!existsSync(path)); assert.ok(!refExists(fixture.repo, 'refs/heads/lane/pending-workspace'));
    assert.ok(refExists(fixture.repo, 'refs/tags/archive/lane/pending-workspace'));
    const sessions = loadRegistry(fixture.repo).sessions.filter(s => s.topic === 'pending-workspace');
    assert.ok(sessions.length > 0 && sessions.every(s => s.done)); assert.equal(fake.state().opened, true);
    assert.match(closed.stdout, /marked 1 session done/);
    negativeControl('post-Git session completion despite pending workspace cleanup');
  } finally { fixture.cleanup(); }
});
