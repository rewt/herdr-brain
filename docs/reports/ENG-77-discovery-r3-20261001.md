---
run: R-53
outcome: done
summary: |
  Fixed all four round-two discovery review findings. Core record and lane configuration IO again follows operator-selected symlinks; no-follow protection remains at the privileged entry boundary. Record discovery stops at the filesystem root, scratch and PTY tests support Darwin and Linux, and untouched entry lanes are removed on close or setup failure. Both required suites and the native sandbox regression pass. Installed smoke cases 02–04 pass; live cases 20/21 and release acceptance remain unclaimed.
headline: Discovery preserves operator paths and cleans up unused entry lanes
blockers: []
proposals: []
learnings:
  - "No-follow protection belongs at privileged writes into agent-writable locations; applying it to ordinary record and operator configuration IO breaks legitimate symlinks and ancestor permissions."
  - "A Git toplevel need not be an ancestor of cwd when GIT_DIR and GIT_WORK_TREE are supplied; upward record discovery must stop at the filesystem root."
  - "An unused entry lane can be removed only after fresh Git identity, branch, cleanliness and ancestry checks under the coordination lock; started, dirty or committed work must survive."
artifacts:
  - "Commit: Restore operator path compatibility and clean unused entry lanes"
  - "Commit: Report discovery path compatibility and entry cleanup verification"
  - "Branch: lane/discovery"
  - docs/reviews/discovery/43f63cb-r2.md
  - discovery/README.md
  - discovery/test/review.test.mjs
  - discovery/test/sandbox.test.mjs
  - test/helpers/pty.mjs
  - test/pty.test.mjs
  - "/private/tmp/eng77-r53-evidence-T4XqrN/summary.json"
  - "/private/tmp/eng77-r51-evidence-oFdxBU/R-49-raw"
decisions:
  - decision: Restore ordinary core IO and keep hardened file operations local to entry capabilities.
    why: Operator-selected record, report and routing paths must retain main's symlink behavior, while agent-created redirects must not redirect privileged writes. Entry resolves existing record paths before launching the child and checks those receipts later.
  - decision: Remove only unused entry lanes using fresh Git facts and non-forced removal.
    why: Opening and immediately quitting a session must not leak a lane, while every started run, dirty checkout or branch containing new commits remains recoverable.
  - decision: Share platform-aware PTY test transport and canonical system temporary roots.
    why: BSD script and util-linux script use different command forms; unavailable transports need explicit skips rather than platform-dependent failures.
questions: []
challenges:
  - premise: All record and lane configuration paths should reject symlinks.
    verdict: wrong
    evidence: Regression fixtures use symlinked record ancestors and files, ORG_DIR, settle-watch --org, LANE_CONFIG, route-config, reports, canonical .lane.json and the macOS /tmp alias while retaining agent-planted symlink refusal tests.
---

All four findings from the review of **Report discovery review fixes and scratch
verification** are addressed by **Restore operator path compatibility and clean
unused entry lanes**. This report is committed as **Report discovery path
compatibility and entry cleanup verification**.

| Finding | Result and regression evidence |
|---|---|
| Operator path compatibility | Ordinary core reads, append, lock and atomic-write behavior restored. Linked records, configs and reports work. Canonical linked validation still defeats a worker override. Privileged writers retain exclusive random temporary files, no-follow opens and pinned directories; planted symlinks and directory replacement remain refused. |
| Record discovery termination | Nested lookup stops when dirname equals the current directory. A timed child with cwd outside GIT_WORK_TREE returns the canonical record. |
| Portable tests | Scratch uses realpath of os.tmpdir. All PTY launches share Darwin/Linux argument selection and explicit unsupported/missing-tool skips. Both command forms and Linux shell quoting have unit coverage. |
| Untouched lane cleanup | Immediate interactive exit, explicit close and setup failure remove clean lanes with no run or commits beyond integration under the coordination lock. Dirty, committed and started lanes remain. Removal never forces Git. |

Verification used unrelated scratch projects outside repository trees, without
model calls or live Herdr pane mutations:

| Check | Outcome |
|---|---|
| Baseline / final npm test | 386 / 392 passed; both 0 failed, 2 expected skips |
| npm run test:lanes | 146 passed, 0 failed, 0 skipped |
| Focused discovery and PTY regressions | 21 passed |
| Explicit native Codex sandbox regression | Passed: validation, promotion, conflict recovery, outside-write and linked .git write denial |
| Installed-product smoke | Cases 02–04 passed; 20/21 pending with --skip-live, hence intentional exit 1 |

These suites ran on Darwin; no Linux host run is claimed. The corrected ENG-74
harness remains read-only and under review. This run makes no release acceptance
claim and retains R-49 live results as historical evidence. Existing follow-on
items cover machine installation, native Herdr interception and real Claude work.

Only summaries remain in the repository evidence directory. Current raw logs
and summary.json are in `/private/tmp/eng77-r53-evidence-T4XqrN`; the summary names
the separate installed snapshot and scratch-project evidence paths. Historical
attempt-1..4 raw evidence remains at
`/private/tmp/eng77-r51-evidence-oFdxBU/R-49-raw`.

The report is checked with the record CLI before its commit. Lane check follows
as the final command; `.lane/gate.json` records the committed HEAD. No push,
release activation, shared configuration change or housekeeping loop was run.
