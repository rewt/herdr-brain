---
run: R-90
outcome: blocked
summary: |
  Fixed the three round-two code findings with regression coverage: reject redirected sandbox grants, preserve disabled Git filter bytes, and supply identity conversion for missing filter directions while enforcing configured commands. Corrected the live-proof classification and added a regression proving that the unauthenticated probe launches no Claude session. Live Claude proof remains PENDING until the operator answers HUM-19; this run accessed no credentials or model sessions.
headline: Sandbox and filter review fixes pass; live Claude proof awaits operator authorization.
blockers:
  - Live Claude discovery and integration proof is PENDING on the operator's answer to existing security question HUM-19. No authenticated model turn or new token measurements are claimed.
  - Actual Linux bubblewrap proof still needs a Linux host under existing item ENG-92; this macOS run verifies its command construction and common path refusals only.
proposals: []
learnings:
  - Git gives an explicitly empty process setting precedence over classic clean and smudge commands; absent process and empty process are different states.
  - A required filter with one classic direction needs a trusted identity transport for the missing direction; configured command failures must still abort the Git operation.
  - Writable sandbox grants must inspect every path component with lstat, realpath and O_NOFOLLOW before provider construction; existsSync misses dangling aliases and resolving an alias does not establish authority.
  - A trusted temporary-directory or queue exception must retain exclusions for protected siblings and descendants, including both a shared-state alias and its target.
artifacts:
  - 'Commit: Reject redirected sandbox grants and preserve filter identity'
  - 'Commit: Report Claude discovery review fixes and pending live proof'
  - 'Branch: lane/claude-discovery'
  - discovery/paths.mjs
  - discovery/confinement.mjs
  - discovery/git-driver.mjs
  - discovery/runtime.mjs
  - discovery/validate.mjs
  - discovery/acceptance.mjs
  - discovery/test/review-r2.test.mjs
  - discovery/README.md
  - docs/reports/ENG-81-claude-discovery-evidence-20261002/summary.json
  - docs/reports/ENG-81-claude-discovery-r2-20261002.md
  - /private/tmp/eng81-r90-baseline.log
  - /private/tmp/eng81-r90-final.log
  - /private/tmp/eng81-r90-rebased.log
  - /private/tmp/eng81-r90-lanes.log
  - /private/tmp/eng81-r90-kernel.log
  - /private/tmp/eng81-r90-native.log
  - /private/tmp/eng81-r90-lane-check.log
  - .lane/gate.json
  - /private/tmp/eng81-r90-existing-review/1c3976f-r1.md
decisions:
  - text: Reject redirected workspace, temporary, queue and live-runtime paths at the common sandbox boundary before constructing any provider exception.
    category: security
    why: An existing target or successful realpath is insufficient authority for a writable grant; inspect every component and retain protected-state exclusions.
  - text: Preserve inactive filters and use a trusted binary byte copy for an active driver's missing classic direction while requiring configured commands to succeed.
    category: design
    why: Git permits single-direction filters and empty commands; an empty shell loses bytes and a missing required direction aborts valid operations.
  - text: Classify both unexecuted live Claude cases as PENDING and leave native sessions untouched.
    category: prover
    why: The existing operator prerequisite HUM-19 remains unanswered; absent live proof establishes neither acceptance nor a code failure.
questions: []
challenges:
  - The independent review requested successful authenticated Claude evidence. The round-two instruction reserves that action to the operator through HUM-19, so the classification is corrected and regression-tested while actual live proof remains pending.
  - The original five-minute lane-suite deadline expired after displayed case 66. The concurrency case and its predecessor passed separately; the complete suite was rerun with a fifteen-minute deadline rather than treating truncated output as a code verdict.
---

Round-two fixes are committed as **Reject redirected sandbox grants and preserve filter identity**. This report is committed as **Report Claude discovery review fixes and pending live proof**. The lane was rebased onto main before editing, then cleanly rebased onto **Report MCP omitted-arguments regression fix**. A final clean rebase picked up **Write the lifecycle fixture's receipt atomically so the test never parses a partial file** before the final gate; its only additional change is the lifecycle fixture's atomic receipt write. No merge, push or promotion was performed.

| Review concern | Result and regression coverage |
| --- | --- |
| Writable temporary-directory aliases could override protection | `paths.mjs` checks root and every component with lstat, realpath and O_NOFOLLOW, verifies named/opened inodes, and rejects redirected paths before grant construction. Tests cover final, ancestor and dangling links across all providers, redirected workspace/queue/runtime paths, out-of-checkout grants, and protected targets or descendants. Actual filter attempts against record and Git symlinks fail before execution and retain sentinel bytes. |
| Disabled filters could erase file content | Empty clean/smudge settings stay identity; empty process retains Git's precedence over classic commands. Binary fixtures containing NUL and non-UTF8 bytes pass allocation, commit, validation, fast-forward integration and completion, including mixed empty/nonempty settings. |
| Single-direction filters could abort valid operations | Missing classic directions use a trusted stdin-to-stdout byte copy without a shell or writable grant. Both clean-only and smudge-only drivers preserve bytes through integration. A configured clean command returning exit 17 still refuses the commit and retains the original blobs. |
| Live evidence incorrectly presented missing authentication as a code failure | The no-authentication probe reports distinct PENDING rows for cases 20 and 21 and never launches the fake native executable. A regression checks the retained summary's HUM-19 classification. Historical CLI failures and zero token/cost observations remain in the summary; none became successful live evidence. |

The common boundary also checks privileged native queues and the live probe's separate runtime paths. Validation cannot grant external runtime writes. macOS exception predicates retain checkout scope and protected sibling/descendant exclusions. Bubblewrap keeps its existing refusal of shared-state symlinks; its kernel boundary still awaits ENG-92.

The empty-process behavior follows [Git's filter implementation](https://raw.githubusercontent.com/git/git/master/convert.c), where a present process setting suppresses classic direction selection even when its value is empty. Integration regressions exercise the installed Git behavior directly.

Validation is offline, uses explicit test actors and bounded runners, and invokes no model. New cases assign their own ORG_ACTOR and have 45-second limits; subprocesses have additional deadlines. The scratch npm script-shell selects four concurrent test files without changing tracked package scripts or user configuration.

| Check | Result |
| --- | --- |
| Baseline `npm test`, before edits | 477 total; 470 passed, 7 skipped, 0 failed; 59.6 seconds. |
| `npm test`, after round-two fixes | 496 total; 489 passed, 7 skipped, 0 failed; 65.7 seconds. |
| `npm test`, after the first post-edit rebase | 506 total; 498 passed, 8 skipped, 0 failed; 84.6 seconds. The optional MCP adapter dependency is absent and explicitly skipped. |
| `npm run test:lanes` | 147 passed, 0 skipped, 0 failed; 377.5 seconds. The initial 300-second runner expired; the bounded rerun completed under its 900-second limit. The isolated concurrency case and its preceding dispatch case also passed. Lane sources are identical before and after the rebase. |
| `MONITOR_TEST_ALTERNATIVE=/usr/bin/sandbox-exec node --test discovery/test/alternatives.test.mjs discovery/test/review-r2.test.mjs` | 27 passed, 0 skipped, 0 failed; 17.1 seconds against the actual macOS kernel sandbox. |
| `MONITOR_TEST_SANDBOX=/Users/rewt/.local/bin/codex node --test discovery/test/sandbox.test.mjs discovery/test/confinement.test.mjs` | 4 passed, 0 skipped, 0 failed; 8.5 seconds against the actual Codex filesystem sandbox, with no model invocation. |

The report is validated with `ORG_ACTOR=r90-report ORG_DIR=/Users/rewt/development/rewt/.org node /Users/rewt/development/rewt/herdr-brain/bin/org.mjs check <report>`, then committed. The final action is `lane check --cmd 'npm test'` against that clean committed head with an explicit actor, the same bounded npm runner, and scratch-only LANE_CONFIG; `.lane/gate.json` records its exact head and outcome. Its output is retained at `/private/tmp/eng81-r90-lane-check.log`. The report does not predeclare the result of a check that must follow its commit.

No Keychain, credential file, Claude login or live Claude session was accessed in R-90. Live usage remains unmeasured for this run. The previous unauthenticated observations remain zero input/cache/output tokens and zero CLI-reported cost; they establish no live proof. HUM-19 and ENG-92 already exist, so no duplicate question or proposal was created and no shared-record event was written.

The pre-existing untracked sanitized review `docs/reviews/claude-discovery/1c3976f-r1.md` was preserved at `/private/tmp/eng81-r90-existing-review/1c3976f-r1.md` before committing, allowing a clean lane gate without including it in this fix. The private findings file was read in place and was not copied into the repository. No shared lane configuration, activated release, harness user settings, project-wide housekeeping loop, bch-cloak state or live Herdr pane was changed.
