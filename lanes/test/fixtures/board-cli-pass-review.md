**PASS**
Schema: lane-review/v1
Reviewed commit: 0000000000000000000000000000000000000000
Topic: fixture-topic
Round: 1
Review ID: lr-fixture
Base branch: main
Base commit: 0000000000000000000000000000000000000000

## Findings
- [Minor] lane.mjs:105 - the repository probe now runs with git stderr set to ignore, so every failure at that call is reported only as "lane: not inside a git repository" and the actual cause is discarded; a directory whose .git file is malformed made git print "fatal: invalid gitfile format" under 7bee6e8 and prints nothing under 2020756, and the same loss applies to dubious-ownership and permission failures for every lane command, not only board with --repo; Fix: pipe git stderr instead of ignoring it and, after writing the lane message, append the captured git text as a second stderr line whenever it is not the ordinary not-a-git-repository line, which leaves the exact-match assertion at test/lane.test.mjs:2634 passing.
- [Minor] test/lane.test.mjs:2429 - the regression added for the shared-context finding matches board/board.mjs source text rather than behavior, so it cannot detect the divergence it exists to prevent; with the JSON projection deliberately rewired to an empty runtime map in a temporary copy this test still passed and only the unrelated watch test at test/lane.test.mjs:2678 failed, while a pure rename of resolveSessionContext would fail it with no behavior change; Fix: replace the three source-text assertions with a behavioral one that builds a single synthetic state and asserts the workspace, agent, runtime, git, report, and branch values agree between joinBoardRows and boardSnapshotDocument.

## Re-executed
```json
[
  {
    "command": "npm test",
    "cwd": "lane",
    "exit_code": 0,
    "result": "TAP totals: 115 tests, 115 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo, duration_ms 105322.104875; wall clock 106 s. Exit status captured directly as 0. Test 83 is the new shared-resolution test and test 86 is the option-validation test carrying the new invalid-repo assertion; both passed.",
    "tests_pass": true,
    "witness": {
      "kind": "negative-control",
      "command": "LANE_TEST_NEGATIVE_CONTROL=1 npm test",
      "cwd": "lane",
      "exit_code": 1,
      "result": "TAP totals: 115 tests, 0 pass, 115 fail, 0 skipped; wall clock 101 s.",
      "observed_failure": "Every one of the 115 tests failed its deliberate control assertion with zero passes, including test 83 'plain and JSON board projections share session and branch resolution', so the green run is not vacuous."
    }
  },
  {
    "command": "LANE_TEST_NEGATIVE_CONTROL=1 npm test",
    "cwd": "lane",
    "exit_code": 1,
    "result": "TAP totals: 115 tests, 0 pass, 115 fail, 0 skipped; wall clock 101 s. Recorded as the deliberate negative control, not as a passing run.",
    "tests_pass": false,
    "witness": null
  },
  {
    "command": "OPENSPEC_TELEMETRY=0 openspec validate --all --strict --no-interactive --concurrency 1",
    "cwd": "lane",
    "exit_code": 0,
    "result": "Totals: 18 passed, 0 failed (18 items), including change/board-cli and spec/board-cli-interface. Not a test-suite claim.",
    "tests_pass": false,
    "witness": null
  },
  {
    "command": "git diff --check 8f967cbc39096c17532ff0f46b34167a56b0afe4..20207568fd068376f839693f19da4fcd1f1d018c",
    "cwd": "lane",
    "exit_code": 0,
    "result": "No whitespace or conflict-marker damage across the whole two-commit delta.",
    "tests_pass": false,
    "witness": null
  },
  {
    "command": "node $TMP/equiv.mjs $TMP/old $TMP/new",
    "cwd": "scratch",
    "exit_code": 0,
    "result": "Equivalence probe importing board/board.mjs from 7bee6e8 and from 2020756 side by side and running joinBoardRows and boardSnapshotDocument over one synthetic state (three sessions covering a bare topic without the lane/ prefix, an agent belonging to a different workspace, dirty null, a stale gate, a missing report and populated pane runtime). Both projections were byte-identical between the two versions: plain rows identical true, JSON documents identical true. Branch derivation produced lane/alpha, lane/beta, lane/gamma; the cross-workspace session correctly resolved to offline.",
    "tests_pass": false,
    "witness": null
  },
  {
    "command": "node $TMP/old/lane.mjs board --json --repo $TMP/plain   (7bee6e8 tool, empty non-repository directory)",
    "cwd": "scratch",
    "exit_code": 1,
    "result": "Empty stdout. stderr carried two lines: 'fatal: not a git repository (or any of the parent directories): .git' followed by 'lane: not inside a git repository'.",
    "tests_pass": false,
    "witness": null
  },
  {
    "command": "node $TMP/copy/lane.mjs board --json --repo $TMP/plain   (2020756 tool, same target)",
    "cwd": "scratch",
    "exit_code": 1,
    "result": "Empty stdout. stderr carried exactly one line: 'lane: not inside a git repository'. Confirms the second round-1 finding is fixed on the path the new assertion covers.",
    "tests_pass": false,
    "witness": null
  },
  {
    "command": "node $TMP/old/lane.mjs board --json --repo $TMP/gitfile ; node $TMP/copy/lane.mjs board --json --repo $TMP/gitfile   (directory whose .git file is malformed)",
    "cwd": "scratch",
    "exit_code": 1,
    "result": "7bee6e8 printed the fatal invalid gitfile format line naming the probed path before the lane message; 2020756 printed only 'lane: not inside a git repository'. Basis for the first finding: a distinct git cause is now discarded rather than shown.",
    "tests_pass": false,
    "witness": null
  },
  {
    "command": "cd $TMP/ok && node $TMP/copy/lane.mjs config   (fresh temporary git repository)",
    "cwd": "scratch",
    "exit_code": 0,
    "result": "Six resolved configuration records printed on stdout with empty stderr, confirming the new stdio array still returns git stdout and the success path of repository resolution is unaffected.",
    "tests_pass": false,
    "witness": null
  },
  {
    "command": "cd $TMP/copy && node --test --test-name-pattern=\"share session and branch resolution|watch frames event snapshots\" test/lane.test.mjs   (mutation: boardSnapshotDocument passes runtime: new Map() instead of state.runtime)",
    "cwd": "scratch",
    "exit_code": 1,
    "result": "93 collected, 91 skipped, 1 pass, 1 fail. The new source-text test passed under the mutation; the watch test failed with last_message available false where true was expected. Shows the divergence is caught by behavior tests but not by the added structural assertions.",
    "tests_pass": false,
    "witness": null
  },
  {
    "command": "cd $TMP/mutB && node --test --test-name-pattern=\"reject contradictory, duplicate, unknown, extra, and missing options\" test/lane.test.mjs   (mutation: lane.mjs restored to its 7bee6e8 content)",
    "cwd": "scratch",
    "exit_code": 1,
    "result": "93 collected, 92 skipped, 0 pass, 1 fail. Assertion diff showed actual stderr 'fatal: not a git repository (or any of the parent directories): .git\\nlane: not inside a git repository\\n' against the expected single line. Mutation witness that the new invalid-repo assertion genuinely guards the second fix.",
    "tests_pass": false,
    "witness": null
  },
  {
    "command": "cd $TMP/mutC && node --test --test-name-pattern=\"usage exits one with no command\" test/lane.test.mjs   (mutation: the board row deleted from the README command table)",
    "cwd": "scratch",
    "exit_code": 1,
    "result": "0 pass, 1 fail. The test reported the README command-table regular expression as unmatched. Mutation witness for the README half of the third fix.",
    "tests_pass": false,
    "witness": null
  },
  {
    "command": "cd $TMP/mutD && node --test --test-name-pattern=\"usage exits one with no command\" test/lane.test.mjs   (mutation: the board entry deleted from the CLI usage text)",
    "cwd": "scratch",
    "exit_code": 1,
    "result": "0 pass, 1 fail. The test reported the board usage regular expression as unmatched. Mutation witness for the usage half of the third fix.",
    "tests_pass": false,
    "witness": null
  }
]
```

## Non-claims
- The passing gate supplied with the target is inherited evidence; it is not a fresh test claim by this review and it is not a verdict.
- This review does not reproduce the historical pre-change measurements recorded in the report and handoff; only present-day outcomes and the resulting counts were observed.
- Neither checkout was altered except the designated private record; nothing was staged, committed, published, or written under docs/reviews, and no public projection was produced.
- The equivalence probe compares the two projection functions over one synthetic state; it is not a claim about live Herdr data or about states outside the fields it populated.
- No judgement is offered on board-actions, board-messages, board-discovery, board-ux, idea or default-config, which are outside this delta.

## Unverified
- The interactive Ink board was not exercised: board/node_modules is absent in the lane worktree and no terminal was available, so only the byte-identical board/app.mjs blob and the continued presence of every service export it imports were checked.
- No live Herdr server was contacted in this round; all board behavior was exercised through local fake sockets in the suite and through synthetic state in the equivalence probe.
- Dubious-ownership and permission-denied git failures were not reproduced directly, so the first finding rests on the malformed-gitfile case as its demonstrated instance of the discarded cause.
- The three budgeted commands were each run once as authorized, so repeat variance, flakiness, and timing spread were not assessed.
- Alternate operating systems and minimum supported versions were not exercised.
- The board test directory was verified only in aggregate through the suite totals, not case by case.
- The engineer's claim that two focused product expectations failed before implementation was corroborated indirectly through mutation witnesses rather than by replaying the pre-change tree.

## Private identifiers
```json
[]
```

## Analysis
Sanitized production-derived fixture evidence.

<!-- lane-review-complete -->
