// Public review findings, path sanitization and evidence projection.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import test from '../../test/helpers/bounded-test.mjs';
import {
  HERE,
  LANE,
  HERDR_CLIENT,
  HEAD,
  negativeControl,
  git,
  lane,
  makeReviewFixture,
  accelerateAgentReadWaits,
  advanceDeliveryClock,
  registryApi,
  reviewPayloadFixture,
  HISTORICAL_REVIEW_ABSOLUTE_PATH_PATTERN,
  HISTORICAL_REVIEW_AMBIGUOUS_PATH_PATTERN,
} from "./lane-fixture.mjs";

// Assert fixture targets here so one-hop planning sees both indirect CLI dependencies.
assert.equal(LANE, resolve(process.env.LANE_TEST_CLI ?? join(HERE, "..", "lane.mjs")));
assert.equal(HERDR_CLIENT, resolve(HERE, "..", "board", "herdr-client.mjs"));

test('captured parallel review survives retirement of the engineer worktree', () => {
  const topic = 'review-retired-source', review = makeReviewFixture(topic, { verdict: 'PASS' });
  const { fixture, fake } = review;
  try {
    const head = git(review.path, ['rev-parse', 'HEAD']);
    const base = git(fixture.repo, ['rev-parse', 'main']);
    git(fixture.repo, ['worktree', 'remove', review.path]);
    fixture.env.FAKE_HERDR_LANE_PATH = fixture.repo;
    const result = lane(fixture, ['review', topic, '--round', '1', '--brief', review.brief,
      '--parallel-review', '--run', 'R-1', '--captured-head', head, '--captured-base', base]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'PASS\n');
    const record = readFileSync(join(fixture.repo, '.lane', 'public-reviews', topic, `${head.slice(0, 7)}-r1.md`), 'utf8');
    assert.match(record, new RegExp(`Reviewed commit: ${head}`));
    assert.equal(existsSync(review.path), false, 'review never recreates the retired lane');
    assert.equal(fake.calls().filter(args => args[0] === 'agent' && args[1] === 'prompt').length, 1);
  } finally { fixture.cleanup(); }
});

for (const [stage, phase, at] of [['ready', 'before', 1], ['cwd', 'before', 2],
  ['delivery', 'after', 1], ['session-poll', 'after', 2]]) {
  test(`review proceeds after one inconsistent list/get pair during ${stage}`, async () => {
    const topic = `review-race-${stage}`, review = makeReviewFixture(topic, { verdict: 'PASS' });
    const { fixture, fake } = review;
    try {
      fixture.env.FAKE_HERDR_SESSION_DETAIL_ONLY = '1';
      fixture.env.FAKE_HERDR_SESSION_AFTER_PROMPT_READS = '3';
      fixture.env.FAKE_HERDR_DETAIL_RACE = JSON.stringify({ phase, at, count: 1, change: { terminal_id: 'racing-terminal' } });
      const run = lane(fixture, ['review', topic, '--round', '1', '--brief', review.brief, '--timeout', '12']);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, 'PASS\n');
      assert.doesNotMatch(run.stderr, /identity changed|Herdr command error|unexpected failure/u);
      assert.equal(fake.state().identityRaceReads, 1);
      assert.ok(fake.state().detailReads[phase] > at);
      assert.equal(fake.calls().filter(args => args[0] === 'agent' && args[1] === 'prompt').length, 1);
      assert.equal(fake.calls().some(args => args[1] === 'close'), false);
      const { loadRegistry } = await registryApi();
      const [record] = loadRegistry(fixture.repo).sessions;
      assert.equal(record.agent_session_id, 'fixture-session-1');
      assert.equal(record.terminal_id, 'fixture-terminal-1');
      const head = git(review.path, ['rev-parse', 'HEAD']);
      assert.match(readFileSync(join(review.path, 'docs', 'reviews', topic, `${head.slice(0, 7)}-r1.md`), 'utf8'), /^\*\*PASS\*\*/u);
    } finally { fixture.cleanup(); }
  });

  test(`review names a persistent list/get identity race during ${stage}`, async () => {
    const topic = `review-persistent-${stage}`, review = makeReviewFixture(topic, { verdict: 'PASS' });
    const { fixture, fake } = review;
    try {
      fixture.env.FAKE_HERDR_SESSION_DETAIL_ONLY = '1';
      fixture.env.FAKE_HERDR_SESSION_AFTER_PROMPT_READS = '3';
      fixture.env.FAKE_HERDR_DETAIL_RACE = JSON.stringify({ phase, at, count: 'always', change: { pane_id: 'other-pane' } });
      accelerateAgentReadWaits(fixture);
      const run = lane(fixture, ['review', topic, '--round', '1', '--brief', review.brief, '--timeout', '12']);
      assert.equal(run.status, 2, run.stderr);
      assert.match(run.stderr, /lane review: .*native agent detail identity changed/u);
      assert.doesNotMatch(run.stderr, /Herdr command error|unexpected failure|^\s+at /mu);
      assert.equal(run.stdout, '');
      assert.ok(fake.state().identityRaceReads > 1, 'the existing deadline permits repeated observations');
      const delivered = phase === 'after';
      assert.equal(fake.calls().filter(args => args[0] === 'agent' && args[1] === 'prompt').length, delivered ? 1 : 0);
      assert.equal(fake.calls().some(args => args[0] === 'tab' && args[1] === 'close'), !delivered);
      assert.match(run.stderr, delivered ? /partial success: the brief was already sent.*do not replay dispatch/u : /tab closed, brief NOT sent/u);
      const { loadRegistry } = await registryApi();
      assert.deepEqual(loadRegistry(fixture.repo).sessions, []);
      assert.equal(existsSync(join(review.path, 'docs', 'reviews', topic)), false);
    } finally { fixture.cleanup(); }
  });
}

for (const [stage, phase, at, trust = false] of [
  ['ready-poll', 'before', 2, true], ['cwd', 'before', 2],
  ['delivery', 'after', 1], ['session-poll', 'after', 2],
]) test(`review recovers a transient list-side disagreement during ${stage}`, async () => {
  const topic = `review-list-race-${stage}`, review = makeReviewFixture(topic, { verdict: 'PASS' });
  const { fixture, fake } = review;
  try {
    fixture.env.FAKE_HERDR_SESSION_DETAIL_ONLY = '1';
    fixture.env.FAKE_HERDR_SESSION_AFTER_PROMPT_READS = '3';
    fixture.env.FAKE_HERDR_DETAIL_RACE = JSON.stringify({
      phase, at, side: 'list', count: 1, change: { terminal_id: 'racing-terminal' },
    });
    if (trust) fixture.env.FAKE_HERDR_TRUST_READS = '1';
    const run = lane(fixture, ['review', topic, '--round', '1', '--brief', review.brief, '--timeout', '12']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'PASS\n');
    assert.equal(fake.state().identityRaceReads, 1);
    assert.ok(fake.state().detailReads[phase] > at);
    assert.equal(fake.calls().filter(args => args[1] === 'prompt').length, 1);
    assert.equal(fake.calls().some(args => args[1] === 'close'), false);
    const { loadRegistry } = await registryApi();
    const [record] = loadRegistry(fixture.repo).sessions;
    assert.equal(record.agent_session_id, 'fixture-session-1');
    assert.equal(record.terminal_id, 'fixture-terminal-1');
    const head = git(review.path, ['rev-parse', 'HEAD']);
    assert.match(readFileSync(join(review.path, 'docs', 'reviews', topic, `${head.slice(0, 7)}-r1.md`), 'utf8'), /^\*\*PASS\*\*/u);
  } finally { fixture.cleanup(); }
});

for (const race of [false, true]) test(`review pins its first readiness occupant across ${race ? 'a list/get race' : 'consistent polls'}`, async () => {
  const topic = `review-ready-replaced-${race}`, review = makeReviewFixture(topic, { verdict: 'PASS' });
  const { fixture, fake } = review;
  try {
    fixture.env.FAKE_HERDR_SESSION_DETAIL_ONLY = '1';
    fixture.env.FAKE_HERDR_SESSION_AFTER_PROMPT_READS = '0';
    fixture.env.FAKE_HERDR_TRUST_READS = '1';
    const change = { terminal_id: 'replacement-terminal' };
    if (race) fixture.env.FAKE_HERDR_DETAIL_RACE = JSON.stringify({
      phase: 'before', at: 2, side: 'list', count: 1, change, replace: true,
    });
    else fixture.env.FAKE_HERDR_READY_REPLACEMENT = JSON.stringify(change);
    accelerateAgentReadWaits(fixture);
    const run = lane(fixture, ['review', topic, '--round', '1', '--brief', review.brief, '--timeout', '45']);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /lane review: native agent detail identity changed for .+; tab closed, brief NOT sent/u);
    assert.doesNotMatch(run.stderr, /Herdr command error|unexpected failure|^\s+at /mu);
    assert.ok(fake.state().readinessReads >= 2);
    assert.equal(fake.state().agentReplacement.terminal_id, 'replacement-terminal');
    assert.equal(fake.state().identityRaceReads ?? 0, race ? 1 : 0);
    if (race) assert.ok(fake.state().detailReads.before >= 3, 'a consistent replacement pair was observed after the race');
    assert.equal(fake.calls().filter(args => args[1] === 'send-keys').length, 1);
    assert.equal(fake.calls().some(args => args[1] === 'prompt'), false);
    assert.deepEqual(fake.calls().filter(args => args[1] === 'close'), [['tab', 'close', 'w-lane:t2']]);
    const { loadRegistry } = await registryApi();
    assert.deepEqual(loadRegistry(fixture.repo).sessions, []);
  } finally { fixture.cleanup(); }
});

test('review retains fresh session evidence after an explicit planning target is exceeded', async () => {
  const topic = 'review-minimum-delivery', review = makeReviewFixture(topic, { verdict: 'PASS' });
  const { fixture, fake } = review;
  try {
    fixture.env.FAKE_HERDR_SESSION_DETAIL_ONLY = '1';
    fixture.env.FAKE_HERDR_SESSION_AFTER_PROMPT_READS = '0';
    advanceDeliveryClock(fixture, 3_600_000);
    const run = lane(fixture, ['review', topic, '--round', '1', '--brief', review.brief, '--timeout', '3']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'PASS\n');
    assert.doesNotMatch(run.stderr, /review timed out/u);
    assert.doesNotMatch(run.stderr, /partial success|metadata could not be written|Herdr command error/u);
    assert.equal(fake.calls().filter(args => args[1] === 'prompt').length, 1);
    assert.equal(fake.state().detailReads.after, 1);
    const { loadRegistry } = await registryApi();
    const [record] = loadRegistry(fixture.repo).sessions;
    assert.equal(record.agent_session_id, 'fixture-session-1');
    assert.equal(record.terminal_id, 'fixture-terminal-1');
  } finally { fixture.cleanup(); }
});

test('review with an existing session succeeds after delivery spends the readiness allowance', async () => {
  const topic = 'review-slow-delivery', review = makeReviewFixture(topic, { verdict: 'PASS' });
  const { fixture, fake } = review;
  try {
    fixture.env.FAKE_HERDR_SESSION_DETAIL_ONLY = '1';
    advanceDeliveryClock(fixture, 31_000);
    const run = lane(fixture, ['review', topic, '--round', '1', '--brief', review.brief, '--timeout', '60']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'PASS\n');
    assert.equal(fake.state().detailReads.after, 1);
    assert.equal(fake.calls().filter(args => args[1] === 'prompt').length, 1);
    const { loadRegistry } = await registryApi();
    assert.equal(loadRegistry(fixture.repo).sessions[0].agent_session_id, 'fixture-session-1');
  } finally { fixture.cleanup(); }
});

test('review follow-up declaration requires a run and rejects duplicate or valued boolean flags', () => {
  const review = makeReviewFixture('review-followup-option');
  try {
    for (const [args, reason] of [
      [['--followup-expected'], /requires --run/],
      [['--run', 'R-1', '--followup-expected', '--followup-expected'], /duplicate review option/],
      [['--run', 'R-1', '--followup-expected', 'false'], /unknown operand: false/],
    ]) {
      const r = lane(review.fixture, ['review', 'review-followup-option', '--round', '1', '--brief', review.brief, ...args]);
      assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, reason);
    }
  } finally { review.fixture.cleanup(); }
});

test("review preserves a final finding immediately before the next section heading", () => {
  const findings = [
    "- [Major] first.txt:1 - first issue; Fix: fix the first issue",
    "- [Moderate] second.txt:2 - second issue; Fix: fix the second issue",
  ].join("\n");
  const review = makeReviewFixture("review-compact-findings", {
    verdict: "NEEDS-WORK", mode: "compact-findings", payload: { findings },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-compact-findings", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 1, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-compact-findings", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.match(publicRecord, /first\.txt:1 - first issue/);
    assert.match(publicRecord, /second\.txt:2 - second issue/);
    negativeControl("compact finding section boundary");
  } finally {
    review.fixture.cleanup();
  }
});

test("review completion admits representative validator-accepted record boundaries", () => {
  const boundaries = [
    ["record-start", 1],
    ["record-start", 2],
    ["after-Findings", 1],
    ["before-Unverified", 0],
    ["after-marker", 2],
  ];
  const findings = [
    "- [Major] first.txt:1 - first issue; Fix: fix the first issue",
    "- [Moderate] second.txt:2 - second issue; Fix: fix the second issue",
  ].join("\n");
  const fixtures = [];
  const failures = [];
  try {
    for (const [boundaryIndex, [boundary, blankLines]] of boundaries.entries()) {
      const topic = `review-spacing-${boundaryIndex}-${blankLines}`;
      const review = makeReviewFixture(topic, {
        verdict: "NEEDS-WORK", payload: { findings, spacing: { boundary, blankLines } },
      });
      fixtures.push(review.fixture);
      const run = lane(review.fixture, [
        "review", topic, "--round", "1", "--brief", review.brief, "--timeout", "10",
      ]);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      const publicPath = join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`);
      const publicRecord = existsSync(publicPath) ? readFileSync(publicPath, "utf8") : "";
      if (run.status !== 1 || !publicRecord.includes("first.txt:1 - first issue") ||
          !publicRecord.includes("second.txt:2 - second issue")) {
        failures.push({ boundary, blankLines, status: run.status, stderr: run.stderr });
      }
    }
    assert.deepEqual(failures, []);
    negativeControl("completion admits representative validator-accepted boundary fixtures");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review preserves finding entries across the blank-line matrix", () => {
  const fixtures = [];
  const outcomes = [];
  try {
    for (const blankLines of [0, 1, 2]) {
      const topic = `review-finding-gap-${blankLines}`;
      const findings = [
        "- [Major] first.txt:1 - first issue; Fix: fix the first issue",
        ...Array(blankLines).fill(""),
        "- [Moderate] second.txt:2 - second issue; Fix: fix the second issue",
      ].join("\n");
      const review = makeReviewFixture(topic, { verdict: "NEEDS-WORK", payload: { findings } });
      fixtures.push(review.fixture);
      const run = lane(review.fixture, [
        "review", topic, "--round", "1", "--brief", review.brief,
      ]);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      const publicRecord = readFileSync(join(
        review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`,
      ), "utf8");
      assert.match(publicRecord, /first\.txt:1 - first issue/);
      assert.match(publicRecord, /second\.txt:2 - second issue/);
      outcomes.push({
        blankLines,
        status: run.status,
        emptyStdout: run.stdout === "",
        spacingDiagnostic: /Findings spacing/.test(run.stderr),
        findingDiagnostic: /each finding/.test(run.stderr),
      });
    }
    assert.deepEqual(outcomes, [
      { blankLines: 0, status: 1, emptyStdout: false, spacingDiagnostic: false, findingDiagnostic: false },
      { blankLines: 1, status: 1, emptyStdout: false, spacingDiagnostic: false, findingDiagnostic: false },
      { blankLines: 2, status: 1, emptyStdout: false, spacingDiagnostic: false, findingDiagnostic: false },
    ]);
    negativeControl("finding entry spacing preserves public revisions");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review keeps malformed findings public on Codex and alternate routes without private sections", () => {
  const fixtures = [];
  try {
    for (const route of ["review-codex", "alternate"]) {
      for (const verdict of ["NEEDS-WORK", "FAIL", "PASS"]) {
        const topic = `review-unparsed-${route}-${verdict.toLowerCase()}`;
        const findings = [
          "- [Major] promote/promote.mjs:105 - Saving freshness repeats promotion. Fix: keep freshness local.",
          "- [Moderate] console/lib/cli.mjs:62 - The project may have no cwd. Fix: require a resolved directory.",
          "- [Moderate] acceptance/run.mjs:711 - Cleanup misses blocked workers. Fix: exercise copied cleanup.",
          "- [Unknown] shared.txt:1 - unrecognized severity; Fix: preserve this revision",
          "1. Missing location and fix remain readable",
          "  Continued prose with `quoted_command` and <markup> from ReviewerSecret at /opt/private/review.txt",
          "- [Minor] shared.txt:1 - canonical finding; Fix: preserve its structure",
        ].join("\n");
        const review = makeReviewFixture(topic, {
          verdict, payload: {
            findings, identifiers: ["ReviewerSecret"],
            analysis: "PRIVATE_ANALYSIS_SENTINEL must never be public.",
          },
        });
        fixtures.push(review.fixture);
        const run = lane(review.fixture, [
          "review", topic, "--round", "1", "--brief", review.brief, "--route", route,
        ]);
        assert.equal(run.status, verdict === "PASS" ? 0 : 1, run.stderr);
        assert.equal(run.stdout, `${verdict}\n`);
        const head = git(review.path, ["rev-parse", "HEAD"]);
        const publicRecord = readFileSync(join(
          review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`,
        ), "utf8");
        assert.equal((publicRecord.match(/\[Unparsed finding\]/gu) ?? []).length, 6);
        for (const revision of ["keep freshness local", "require a resolved directory", "exercise copied cleanup",
          "preserve this revision", "Missing location and fix remain readable", "Continued prose"]) {
          assert.ok(publicRecord.includes(revision), revision);
        }
        assert.match(publicRecord, /from \[PRIVATE\] at \[ABS_PATH\]/);
        assert.ok(publicRecord.includes("\\`quoted\\_command\\` and \\<markup\\>"));
        assert.match(publicRecord, /- \[Minor\] shared\.txt:1 - canonical finding; Fix: preserve its structure/);
        assert.doesNotMatch(publicRecord, /ReviewerSecret|\/opt\/private|PRIVATE_ANALYSIS_SENTINEL|## Analysis|## Private identifiers/);
        const prompt = review.fake.calls().find((args) => args[0] === "agent" && args[1] === "prompt")?.[3];
        assert.ok(prompt.includes("`; Fix: ` separator is mandatory"));
        assert.ok(prompt.includes("check every finding"));
      }
    }
    negativeControl("malformed public findings and private section exclusion");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review projects repository-relative finding locations containing spaces", () => {
  const review = makeReviewFixture("review-spaced-location", {
    verdict: "PASS",
    payload: { findings: "- [Minor] docs/with space.md:7 - wording issue; Fix: clarify the wording" },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-spaced-location", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-spaced-location", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.match(publicRecord, /docs\/with space\.md:7 - wording issue; Fix: clarify the wording/);
    negativeControl("spaced repository-relative finding location");
  } finally {
    review.fixture.cleanup();
  }
});

test("review sanitizes deterministic aliases and path forms in a bounded public projection", () => {
  const review = makeReviewFixture("review-sanitize", { verdict: "PASS" });
  try {
    const username = userInfo().username;
    const homeName = homedir().split("/").filter(Boolean).at(-1);
    const host = hostname();
    review.fixture.env.FAKE_REVIEW_PAYLOAD = JSON.stringify({
      findings: `- [Moderate] shared.txt:1 - User ${username} inspected ${review.path}/shared.txt; Fix: ask ${homeName} to use a relative path`,
      reexecuted: [{
        command: `node scripts/check.mjs ${review.path}/shared.txt ${review.path}/other.txt --user ${username}`,
        cwd: "scratch",
        exit_code: 1,
        result: `host ${host}; posix /opt/tools/check; drive C:\\Temp\\check.exe; unc \\\\server\\share\\check; url file:///var/tmp/check; prefix ${review.path}-private/secret`,
        tests_pass: false,
        witness: null,
      }],
      nonclaims: "- SECRETNAME was not independently authenticated.",
      unverified: "- annex behavior remains unverified.",
      identifiers: ["SecretName"],
      analysis: `Private analysis keeps ${username}, ${host}, and /private/source/path.`,
    });
    const run = lane(review.fixture, ["review", "review-sanitize", "--round", "1", "--brief", review.brief]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicPath = join(review.path, "docs", "reviews", "review-sanitize", `${head.slice(0, 7)}-r1.md`);
    const publicRecord = readFileSync(publicPath, "utf8");
    assert.match(publicRecord, /User \[USER\] inspected shared\.txt; Fix: ask \[USER\] to use a relative path/);
    assert.match(publicRecord, /node scripts\/check\.mjs shared\.txt other\.txt --user \[USER\]/);
    assert.match(publicRecord, /host \[HOST\]; posix \[ABS_PATH\]; drive \[ABS_PATH\]; unc \[ABS_PATH\]; url \[ABS_PATH\]; prefix \[ABS_PATH\]/);
    assert.match(publicRecord, /- \[PRIVATE\] was not independently authenticated\./);
    assert.match(publicRecord, /- annex behavior remains unverified\./);
    assert.match(publicRecord, /- absolute-path: 5\n- user: 3\n- host: 1\n- private: 1\n- relative-path: 3/);
    assert.match(publicRecord, /- redacted execution fields: 0\.command, 0\.result/);
    assert.doesNotMatch(publicRecord, /Private identifiers|## Analysis|Private analysis|private\/source/);
    assert.ok(Buffer.byteLength(publicRecord) <= 64 * 1024);
    assert.ok(publicRecord.split("\n").length <= 120);
    negativeControl("sanitized public projection");
  } finally {
    review.fixture.cleanup();
  }
});

test("review redacts syntax-shaped slash prose while retaining alias safeguards", () => {
  const fixtures = [];
  try {
    const accepted = makeReviewFixture("review-slash-prose", {
      verdict: "PASS",
      payload: {
        findings: "- [Minor] shared.txt:1 - Patterns /tmp/gimu, /tmp/gimu/private, C:/tmp/gimu, and /alpha/beta/ were reported; Fix: spell patterns in words",
        reexecuted: [{
          command: "printf '%s\\n' $(cat /var/tmp/input.txt) $(type C:\\Temp\\input.txt) $(type \\\\server\\share\\input.txt)",
          cwd: "scratch",
          exit_code: 0,
          result: "Command-substitution path content was inspected without execution.",
          tests_pass: false,
          witness: null,
        }],
        nonclaims: "- The external fixture at /opt/review/input.js was not re-executed.",
      },
    });
    fixtures.push(accepted.fixture);
    const acceptedRun = lane(accepted.fixture, [
      "review", "review-slash-prose", "--round", "1", "--brief", accepted.brief,
    ]);
    assert.equal(acceptedRun.status, 0, acceptedRun.stderr);
    const acceptedHead = git(accepted.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      accepted.path, "docs", "reviews", "review-slash-prose", `${acceptedHead.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.match(publicRecord, /Patterns \[ABS_PATH\], \[ABS_PATH\], \[ABS_PATH\], and \[ABS_PATH\] were reported; Fix: spell patterns in words/);
    assert.doesNotMatch(publicRecord, /tmp\/gimu|alpha\/beta/);
    assert.match(publicRecord, /The external fixture at \[ABS_PATH\] was not re-executed\./);
    const executions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
    assert.equal(executions[0].command, "printf '%s\\n' $(cat [ABS_PATH]) $(type [ABS_PATH]) $(type [ABS_PATH])");

    const refused = makeReviewFixture("review-slash-alias", {
      verdict: "PASS",
      payload: {
        findings: "- [Minor] shared.txt:1 - Private ReviewerAlias found an issue; Fix: remove the alias",
        identifiers: ["ReviewerAlias"],
      },
    });
    fixtures.push(refused.fixture);
    const refusedRun = lane(refused.fixture, [
      "review", "review-slash-alias", "--round", "1", "--brief", refused.brief,
    ]);
    assert.equal(refusedRun.status, 2, refusedRun.stderr);
    assert.equal(refusedRun.stdout, "");
    assert.match(refusedRun.stderr, /finding description contains a declared private identifier/);
    negativeControl("syntax-shaped slash prose redaction");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review redacts an absolute path inside a regex-like character class", () => {
  const review = makeReviewFixture("review-regex-class-path", {
    verdict: "PASS",
    payload: {
      findings: "- [Minor] shared.txt:1 - Pattern /[open /var/tmp/private.txt]/g was inspected; Fix: spell the pattern in words",
    },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-regex-class-path", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-regex-class-path", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.ok(publicRecord.includes("Pattern /\\[open [ABS_PATH]\\][ABS_PATH] was inspected"));
    assert.doesNotMatch(publicRecord, /var\/tmp\/private/);
    negativeControl("regex-like character class path redaction");
  } finally {
    review.fixture.cleanup();
  }
});

for (const [field, topic, payload, verify] of [
  [
    "finding prose",
    "review-flag-attached-prose-path",
    { findings: "- [Moderate] shared.txt:1 - Flag -x/var/tmp/private.txt was observed; Fix: use a public-safe path" },
    (publicRecord) => {
      assert.match(publicRecord, /Flag -x\[ABS_PATH\] was observed/);
      assert.doesNotMatch(publicRecord, /var\/tmp\/private/);
    },
  ],
  [
    "finding location",
    "review-flag-attached-location-path",
    { findings: "- [Moderate] -x/var/tmp/private.txt:1 - issue; Fix: use a repository-relative location" },
    null,
  ],
  [
    "command string",
    "review-flag-attached-command-path",
    { reexecuted: [{
      command: "inspect -x/var/tmp/private.txt",
      cwd: "scratch",
      exit_code: 0,
      result: "The command was inspected without execution.",
      tests_pass: false,
      witness: null,
    }] },
    (publicRecord) => {
      const executions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
      assert.equal(executions[0].command, "inspect -x[ABS_PATH]");
    },
  ],
]) {
  test("review sanitizes a flag-attached absolute path in " + field, () => {
    const review = makeReviewFixture(topic, { verdict: "PASS", payload });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      const publicPath = join(review.path, "docs", "reviews", topic, head.slice(0, 7) + "-r1.md");
      if (field === "finding location") {
        assert.equal(run.status, 2, run.stderr);
        assert.equal(run.stdout, "");
        assert.match(
          run.stderr,
          /finding location contains a private alias or absolute path and cannot be rewritten safely/u,
        );
        assert.ok(!existsSync(publicPath));
      } else {
        assert.equal(run.status, 0, run.stderr);
        assert.ok(existsSync(publicPath));
        verify(readFileSync(publicPath, "utf8"));
      }
      negativeControl("flag-attached absolute path in " + field);
    } finally {
      review.fixture.cleanup();
    }
  });
}

for (const [field, topic, payload, verify] of [
  [
    "backtick-quoted finding prose",
    "review-delimited-flag-prose-path",
    { findings: "- [Moderate] shared.txt:1 - Flag `-I/var/tmp/private.h` was observed; Fix: use a public-safe path" },
    (publicRecord) => {
      assert.ok(publicRecord.includes("Flag \\`-I[ABS_PATH]\\` was observed"));
      assert.doesNotMatch(publicRecord, /var\/tmp\/private/);
    },
  ],
  [
    "assigned command string",
    "review-delimited-flag-command-path",
    { reexecuted: [{
      command: "CFLAGS=-I/var/tmp/private.h compile",
      cwd: "scratch",
      exit_code: 0,
      result: "The command was inspected without execution.",
      tests_pass: false,
      witness: null,
    }] },
    (publicRecord) => {
      const executions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
      assert.equal(executions[0].command, "CFLAGS=-I[ABS_PATH] compile");
    },
  ],
  [
    "double-quoted finding location",
    "review-delimited-flag-location-path",
    { findings: "- [Moderate] \"-I/var/tmp/private.h\":1 - issue; Fix: use a repository-relative location" },
    null,
  ],
]) {
  test("review sanitizes a delimiter-prefixed flag-attached absolute path in " + field, () => {
    const review = makeReviewFixture(topic, { verdict: "PASS", payload });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      const publicPath = join(review.path, "docs", "reviews", topic, head.slice(0, 7) + "-r1.md");
      if (field === "double-quoted finding location") {
        assert.equal(run.status, 2, run.stderr);
        assert.equal(run.stdout, "");
        assert.match(
          run.stderr,
          /finding location contains a private alias or absolute path and cannot be rewritten safely/u,
        );
        assert.ok(!existsSync(publicPath));
      } else {
        assert.equal(run.status, 0, run.stderr);
        assert.ok(existsSync(publicPath));
        verify(readFileSync(publicPath, "utf8"));
      }
      negativeControl("delimiter-prefixed flag-attached absolute path in " + field);
    } finally {
      review.fixture.cleanup();
    }
  });
}

for (const [description, topic, command, projected] of [
  [
    "forward-separator UNC path",
    "review-forward-unc-path",
    "inspect //server/share/private.txt",
    "inspect [ABS_PATH]",
  ],
  [
    "hosted file URL",
    "review-hosted-file-url",
    "inspect file://server/share/private.txt",
    "inspect [ABS_PATH]",
  ],
]) {
  test("review redacts a " + description, () => {
    const review = makeReviewFixture(topic, {
      verdict: "PASS",
      payload: {
        reexecuted: [{
          command,
          cwd: "scratch",
          exit_code: 0,
          result: "The command was inspected without execution.",
          tests_pass: false,
          witness: null,
        }],
      },
    });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      assert.equal(run.status, 0, run.stderr);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      const publicRecord = readFileSync(join(
        review.path, "docs", "reviews", topic, head.slice(0, 7) + "-r1.md",
      ), "utf8");
      const executions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
      assert.equal(executions[0].command, projected);
      assert.ok(!publicRecord.includes(command.split(" ").at(-1)));
      negativeControl(description);
    } finally {
      review.fixture.cleanup();
    }
  });
}

for (const [field, topic, payload, diagnostic] of [
  [
    "finding prose",
    "review-escaped-prose-path",
    { findings: "- [Moderate] shared.txt:1 - Escaped path \\/var/tmp/private.txt was observed; Fix: remove it" },
    /projected payload retains private path or alias content/u,
  ],
  [
    "finding location",
    "review-escaped-location-path",
    { findings: "- [Moderate] scope)\\/var/tmp/private.txt:1 - issue; Fix: remove it" },
    /finding location contains a private alias or absolute path and cannot be rewritten safely/u,
  ],
  [
    "command string",
    "review-escaped-command-path",
    { reexecuted: [{
      command: "inspect \\/var/tmp/private.txt",
      cwd: "scratch",
      exit_code: 0,
      result: "The command was inspected without execution.",
      tests_pass: false,
      witness: null,
    }] },
    /projected payload retains private path or alias content/u,
  ],
]) {
  test(`review refuses an escaped absolute path in ${field}`, () => {
    const review = makeReviewFixture(topic, { verdict: "PASS", payload });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      assert.equal(run.status, 2, run.stderr);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, diagnostic);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      assert.ok(!existsSync(join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`)));
      negativeControl(`escaped absolute path in ${field}`);
    } finally {
      review.fixture.cleanup();
    }
  });
}

test("review refuses a relative-looking protected location embedding an absolute path", () => {
  const topic = "review-location-relative-looking";
  const review = makeReviewFixture(topic, {
    verdict: "PASS",
    payload: { findings: "- [Major] scope)/tmp/gimu:1 - issue; Fix: change it" },
  });
  try {
    const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(
      run.stderr,
      /finding location contains a private alias or absolute path and cannot be rewritten safely/u,
    );
    negativeControl("relative-looking protected absolute path");
  } finally {
    review.fixture.cleanup();
  }
});

for (const [description, topic, location] of [
  ["two-segment flag-letter path", "review-location-two-segment-flags", "/tmp/gimu"],
  ["deeper path with a flag-letter second segment", "review-location-deep-flags", "/tmp/gimu/private.txt"],
  ["drive path with a flag-letter segment", "review-location-drive-flags", "C:/tmp/gimu"],
]) {
  test(`review refuses a ${description} in a protected location`, () => {
    const review = makeReviewFixture(topic, {
      verdict: "PASS",
      payload: { findings: `- [Major] ${location}:1 - issue; Fix: change it` },
    });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      assert.equal(run.status, 2, run.stderr);
      assert.equal(run.stdout, "");
      const head = git(review.path, ["rev-parse", "HEAD"]);
      assert.ok(!existsSync(join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`)));
      negativeControl(`protected ${description}`);
    } finally {
      review.fixture.cleanup();
    }
  });
}

test("review preserves a command-substitution delimiter after file URL redaction", () => {
  const review = makeReviewFixture("review-file-url-delimiter", {
    verdict: "PASS",
    payload: {
      reexecuted: [{
        command: "printf '%s\\n' $(cat file:///var/tmp/input.txt)",
        cwd: "scratch",
        exit_code: 0,
        result: "The command syntax was inspected without execution.",
        tests_pass: false,
        witness: null,
      }],
    },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-file-url-delimiter", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-file-url-delimiter", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    const executions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
    assert.equal(executions[0].command, "printf '%s\\n' $(cat [ABS_PATH])");
    negativeControl("file URL command-substitution delimiter");
  } finally {
    review.fixture.cleanup();
  }
});

test("review refuses a closing-parenthesis file URL residue that the base matcher fully redacted", () => {
  const command = "inspect file:///var/tmp/archive)tail/input.txt";
  const payload = {
    reexecuted: [{
      command,
      cwd: "scratch",
      exit_code: 0,
      result: "The command was inspected without execution.",
      tests_pass: false,
      witness: null,
    }],
  };
  const current = makeReviewFixture("review-file-url-closing-current", { verdict: "PASS", payload });
  try {
    assert.equal(command.replace(HISTORICAL_REVIEW_ABSOLUTE_PATH_PATTERN, "[ABS_PATH]"), "inspect [ABS_PATH]");

    const currentRun = lane(current.fixture, [
      "review", "review-file-url-closing-current", "--round", "1", "--brief", current.brief,
    ]);
    assert.equal(currentRun.status, 2, currentRun.stderr);
    assert.equal(currentRun.stdout, "");
    assert.match(currentRun.stderr, /projected payload contains an ambiguous absolute path/u);
    const currentHead = git(current.path, ["rev-parse", "HEAD"]);
    assert.ok(!existsSync(join(
      current.path, "docs", "reviews", "review-file-url-closing-current", `${currentHead.slice(0, 7)}-r1.md`,
    )));
    negativeControl("closing-parenthesis file URL residue differential");
  } finally {
    current.fixture.cleanup();
  }
});

test("review publishes a standalone closing delimiter after file URL redaction", () => {
  const topic = "review-file-url-closing-delimiter";
  const review = makeReviewFixture(topic, {
    verdict: "PASS",
    payload: { unverified: "- Inspect file:///var/tmp/input.txt) before release." },
  });
  try {
    const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.ok(publicRecord.includes("- Inspect [ABS_PATH]) before release."));
    negativeControl("standalone closing delimiter after file URL redaction");
  } finally {
    review.fixture.cleanup();
  }
});

for (const [description, topic, terminator] of [
  ["closing parenthesis", "review-spaced-path-after-parenthesis", ")"],
  ["closing quote", "review-spaced-path-after-quote", '"'],
  ["closing bracket", "review-spaced-path-after-bracket", "]"],
]) {
  test(`review refuses a spaced-path continuation after a ${description}`, () => {
    const command = `inspect file:///var/tmp/private${terminator} folder/secret.txt`;
    assert.match(command, HISTORICAL_REVIEW_AMBIGUOUS_PATH_PATTERN);
    const review = makeReviewFixture(topic, {
      verdict: "PASS",
      payload: {
        reexecuted: [{
          command,
          cwd: "scratch",
          exit_code: 0,
          result: "The command was inspected without execution.",
          tests_pass: false,
          witness: null,
        }],
      },
    });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      assert.equal(run.status, 2, run.stderr);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /projected payload contains an ambiguous absolute path/u);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      assert.ok(!existsSync(join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`)));
      negativeControl(`spaced-path continuation after a ${description}`);
    } finally {
      review.fixture.cleanup();
    }
  });
}

for (const [description, topic, field, value] of [
  [
    "greater-than terminator",
    "review-spaced-path-after-greater-than",
    "command",
    "inspect <file:///var/tmp/private> folder/secret.txt",
  ],
  [
    "colon terminator",
    "review-spaced-path-after-colon",
    "prose",
    "Path /var/tmp/private: folder/secret.txt was observed; Fix: remove it",
  ],
  [
    "less-than terminator",
    "review-spaced-path-after-less-than",
    "command",
    "inspect file:///var/tmp/private< folder/secret.txt",
  ],
  [
    "opening-bracket terminator",
    "review-spaced-path-after-opening-bracket",
    "prose",
    "Path /var/tmp/private[ folder/secret.txt was observed; Fix: remove it",
  ],
  [
    "closing-brace terminator",
    "review-spaced-path-after-closing-brace",
    "command",
    "inspect file:///var/tmp/private} folder/secret.txt",
  ],
  [
    "arbitrary punctuation run",
    "review-spaced-path-after-punctuation-run",
    "prose",
    "Path /var/tmp/private>}:!? folder/secret.txt was observed; Fix: remove it",
  ],
]) {
  test(`review refuses a spaced-path continuation after any ${description}`, () => {
    assert.match(value, HISTORICAL_REVIEW_AMBIGUOUS_PATH_PATTERN);
    const payload = field === "command"
      ? {
          reexecuted: [{
            command: value,
            cwd: "scratch",
            exit_code: 0,
            result: "The command was inspected without execution.",
            tests_pass: false,
            witness: null,
          }],
        }
      : { findings: `- [Moderate] shared.txt:1 - ${value}` };
    const review = makeReviewFixture(topic, { verdict: "PASS", payload });
    try {
      const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
      assert.equal(run.status, 2, run.stderr);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /projected payload contains an ambiguous absolute path/u);
      const head = git(review.path, ["rev-parse", "HEAD"]);
      assert.ok(!existsSync(join(
        review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`,
      )));
      negativeControl(`spaced-path continuation after any ${description}`);
    } finally {
      review.fixture.cleanup();
    }
  });
}

test("review refuses a spaced-path continuation with an embedded absolute-path match", () => {
  const topic = "review-spaced-path-embedded-absolute";
  const command = "inspect file:///var/tmp/private relative/path:/opt/other";
  assert.match(command, HISTORICAL_REVIEW_AMBIGUOUS_PATH_PATTERN);
  const review = makeReviewFixture(topic, {
    verdict: "PASS",
    payload: {
      reexecuted: [{
        command,
        cwd: "scratch",
        exit_code: 0,
        result: "The command was inspected without execution.",
        tests_pass: false,
        witness: null,
      }],
    },
  });
  try {
    const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /projected payload contains an ambiguous absolute path/u);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    assert.ok(!existsSync(join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`)));
    negativeControl("spaced-path continuation with an embedded absolute-path match");
  } finally {
    review.fixture.cleanup();
  }
});

test("review refuses a parenthesized file URL residue", () => {
  const topic = "review-file-url-parenthesis";
  const review = makeReviewFixture(topic, {
    verdict: "PASS",
    payload: {
      reexecuted: [{
        command: "inspect file:///var/tmp/(private)/input.txt",
        cwd: "scratch",
        exit_code: 0,
        result: "The command was inspected without execution.",
        tests_pass: false,
        witness: null,
      }],
    },
  });
  try {
    const run = lane(review.fixture, ["review", topic, "--round", "1", "--brief", review.brief]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /projected payload contains an ambiguous absolute path/u);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    assert.ok(!existsSync(join(review.path, "docs", "reviews", topic, `${head.slice(0, 7)}-r1.md`)));
    negativeControl("parenthesized file URL residue");
  } finally {
    review.fixture.cleanup();
  }
});

test("review projects command syntax verbatim while escaping the same characters in prose", () => {
  const fixtures = [];
  const machineSyntax = "env PATH=<node and system bin only> printf '`value` [item] ** %2F &amp; \\x41 \\u0041' > $VAR";
  try {
    const accepted = makeReviewFixture("review-command-syntax", {
      verdict: "NEEDS-WORK",
      payload: {
        findings: [
          "- [Minor] first.txt:1 - first issue; Fix: fix the first issue",
          "- [Moderate] second.txt:2 - second issue; Fix: fix the second issue",
        ].join("\n"),
        reexecuted: [{
          command: machineSyntax,
          cwd: "scratch",
          exit_code: 1,
          result: "The command exited with the expected diagnostic.",
          tests_pass: false,
          witness: {
            kind: "negative-control",
            command: `${machineSyntax} --negative-control`,
            cwd: "scratch",
            exit_code: 1,
            result: "The deliberate control failed.",
            observed_failure: "The expected failure was observed.",
          },
        }],
      },
    });
    fixtures.push(accepted.fixture);
    const acceptedRun = lane(accepted.fixture, [
      "review", "review-command-syntax", "--round", "1", "--brief", accepted.brief,
    ]);
    assert.equal(acceptedRun.status, 1, acceptedRun.stderr);
    const head = git(accepted.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      accepted.path, "docs", "reviews", "review-command-syntax", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.match(publicRecord, /first\.txt:1 - first issue/);
    assert.match(publicRecord, /second\.txt:2 - second issue/);
    const publicExecutions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
    assert.equal(publicExecutions[0].command, machineSyntax);
    assert.equal(publicExecutions[0].witness.command, `${machineSyntax} --negative-control`);

    const prose = makeReviewFixture("review-prose-syntax", {
      verdict: "PASS",
      payload: {
        findings: `- [Minor] shared.txt:1 - ${machineSyntax}; Fix: use plain prose`,
      },
    });
    fixtures.push(prose.fixture);
    const proseRun = lane(prose.fixture, [
      "review", "review-prose-syntax", "--round", "1", "--brief", prose.brief,
    ]);
    assert.equal(proseRun.status, 0, proseRun.stderr);
    const proseHead = git(prose.path, ["rev-parse", "HEAD"]);
    const prosePublic = readFileSync(join(
      prose.path, "docs", "reviews", "review-prose-syntax", `${proseHead.slice(0, 7)}-r1.md`,
    ), "utf8");
    assert.match(prosePublic, /PATH=\\<node and system bin only\\>/u);
    assert.ok(prosePublic.includes("'\\`value\\` \\[item\\] \\*\\* %2F &amp;"));

    const reserved = makeReviewFixture("review-command-placeholder", {
      verdict: "PASS",
      payload: {
        reexecuted: [{
          command: "printf [USER]",
          cwd: "scratch",
          exit_code: 0,
          result: "Command completed.",
          tests_pass: false,
          witness: null,
        }],
      },
    });
    fixtures.push(reserved.fixture);
    const reservedRun = lane(reserved.fixture, [
      "review", "review-command-placeholder", "--round", "1", "--brief", reserved.brief,
    ]);
    assert.equal(reservedRun.status, 2, reservedRun.stderr);
    assert.equal(reservedRun.stdout, "");
    assert.match(reservedRun.stderr, /reserved sanitizer placeholder/);

    const nonAscii = makeReviewFixture("review-command-non-ascii", {
      verdict: "PASS",
      payload: {
        reexecuted: [{
          command: "printf caf\u00e9",
          cwd: "scratch",
          exit_code: 0,
          result: "Command completed.",
          tests_pass: false,
          witness: null,
        }],
      },
    });
    fixtures.push(nonAscii.fixture);
    const nonAsciiRun = lane(nonAscii.fixture, [
      "review", "review-command-non-ascii", "--round", "1", "--brief", nonAscii.brief,
    ]);
    assert.equal(nonAsciiRun.status, 2, nonAsciiRun.stderr);
    assert.equal(nonAsciiRun.stdout, "");
    assert.match(nonAsciiRun.stderr, /projected payload contains unsupported non-ASCII text/);
    negativeControl("verbatim command projection and escaped prose");
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

test("review escapes prose punctuation after sanitizing the unescaped payload", () => {
  const findings = [
    "- [Minor] first.txt:1 - `git status` reported **fatal** for [draft] <path> and snake_case; Fix: quote `--` and keep __tokens__ literal",
    "- [Moderate] second.txt:2 - asterisk * underscore _ brackets [] and angles <> remain visible; Fix: preserve every quoted character",
  ].join("\n");
  const nonclaims = "- Quoted `usage [--flag] <path>` and **bold** __label__ text with a literal \\ separator is not a claim.";
  const unverified = "- Git said: `fatal: pathspec '[draft]_<name>.md' did not match any files`.";
  const review = makeReviewFixture("review-escaped-prose", {
    verdict: "NEEDS-WORK",
    payload: { findings, nonclaims, unverified },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-escaped-prose", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 1, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-escaped-prose", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    for (const escaped of [
      "\\`git status\\`", "\\*\\*fatal\\*\\*", "\\[draft\\]", "\\<path\\>", "snake\\_case",
      "\\`--\\`", "\\_\\_tokens\\_\\_", "asterisk \\*", "underscore \\_", "brackets \\[\\]",
      "angles \\<\\>", "\\`usage \\[--flag\\] \\<path\\>\\`", "\\*\\*bold\\*\\*",
      "\\_\\_label\\_\\_", "literal \\\\ separator", "pathspec '\\[draft\\]\\_\\<name\\>.md'",
    ]) assert.ok(publicRecord.includes(escaped), `missing escaped prose: ${escaped}\n${publicRecord}`);
    assert.equal((publicRecord.match(/^- \[(?:Major|Moderate|Minor)\]/gmu) || []).length, 2);
    const renderedLiteral = publicRecord.replace(/\\([\\`*_\[\]<>])/gu, "$1");
    assert.ok(renderedLiteral.includes(findings.split("\n")[0]));
    assert.ok(renderedLiteral.includes(findings.split("\n")[1]));
    assert.ok(renderedLiteral.includes(nonclaims));
    assert.ok(renderedLiteral.includes(unverified));
    negativeControl("escaped review prose projection");
  } finally {
    review.fixture.cleanup();
  }
});

test("review refuses an opening parenthesis after a concrete path match", () => {
  const review = makeReviewFixture("review-placeholder-parenthesis", {
    verdict: "PASS",
    payload: { unverified: "- Inspect /opt/review-tool(note) in a later check." },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-placeholder-parenthesis", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /projected payload contains an ambiguous absolute path/u);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    assert.ok(!existsSync(join(
      review.path, "docs", "reviews", "review-placeholder-parenthesis", `${head.slice(0, 7)}-r1.md`,
    )));
    negativeControl("parenthesized concrete path refusal");
  } finally {
    review.fixture.cleanup();
  }
});

test("review projects every finding from the sanitized production PASS fixture", () => {
  const fixturePath = process.env.LANE_BOARD_REVIEW_FIXTURE ?? join(
    HERE, "fixtures", "board-cli-pass-review.md",
  );
  const payload = reviewPayloadFixture(fixturePath);
  const review = makeReviewFixture("review-production-pass", { verdict: "PASS", record: fixturePath });
  try {
    const run = lane(review.fixture, [
      "review", "review-production-pass", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-production-pass", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    const sourceFindings = payload.findings.split("\n");
    assert.equal((publicRecord.match(/^- \[(?:Major|Moderate|Minor)\]/gmu) || []).length, sourceFindings.length);
    for (const finding of sourceFindings) assert.ok(publicRecord.includes(finding), `missing finding: ${finding}`);
    negativeControl("production PASS projection");
  } finally {
    review.fixture.cleanup();
  }
});

test("review refuses a finding description containing a declared private identifier", () => {
  const review = makeReviewFixture("review-private-description", {
    verdict: "PASS",
    payload: {
      findings: "- [Minor] shared.txt:1 - Reviewer_Secret appears in quoted prose; Fix: remove the private identifier",
      identifiers: ["Reviewer_Secret"],
    },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-private-description", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
    const head = git(review.path, ["rev-parse", "HEAD"]);
    assert.ok(!existsSync(join(
      review.path, "docs", "reviews", "review-private-description", `${head.slice(0, 7)}-r1.md`,
    )));
    negativeControl("declared private identifier in finding prose");
  } finally {
    review.fixture.cleanup();
  }
});

test("review allows private-only heading text inside a verbatim command", () => {
  const command = "printf '## Analysis and ## Private identifiers are quoted command text'";
  const review = makeReviewFixture("review-command-headings", {
    verdict: "PASS",
    payload: {
      reexecuted: [{
        command,
        cwd: "scratch",
        exit_code: 0,
        result: "Command text was inspected without execution.",
        tests_pass: false,
        witness: null,
      }],
    },
  });
  try {
    const run = lane(review.fixture, [
      "review", "review-command-headings", "--round", "1", "--brief", review.brief,
    ]);
    assert.equal(run.status, 0, run.stderr);
    const head = git(review.path, ["rev-parse", "HEAD"]);
    const publicRecord = readFileSync(join(
      review.path, "docs", "reviews", "review-command-headings", `${head.slice(0, 7)}-r1.md`,
    ), "utf8");
    const executions = JSON.parse(publicRecord.match(/## Re-executed\n```json\n(.+)\n```/u)[1]);
    assert.equal(executions[0].command, command);
    assert.equal((publicRecord.match(/^## Analysis$/gmu) || []).length, 0);
    assert.equal((publicRecord.match(/^## Private identifiers$/gmu) || []).length, 0);
    negativeControl("private heading text inside command");
  } finally {
    review.fixture.cleanup();
  }
});
