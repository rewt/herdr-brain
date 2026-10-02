---
run: R-51
outcome: done
summary: |
  Fixed all seven discovery review findings. Privileged file operations reject symlinks, use exclusive random temporary files, and pin directory inodes so ancestor replacement cannot redirect a write. Automatic shims enter only on fresh interactive launches and preserve existing launcher and worktree sessions. Global Git identity, unused global git-lfs, clean automatic bootstrap, nested records, and canonical validation authority have regression coverage. Required suites and the native sandbox check pass. Raw evidence lives in scratch; the corrected release acceptance gate remains separate.
headline: Discovery review fixes preserve existing sessions and protect privileged writes
blockers: []
proposals: []
learnings:
  - "O_NOFOLLOW on a temporary file alone does not protect its ancestor directories; synchronous relative writes from a verified kernel-pinned directory prevent ancestor replacement from redirecting the write."
  - "Herdr shell environment alone cannot distinguish interactive entry from managed agent start; launcher bypass markers and the pane's live managed-start receipt suppress interception without granting capabilities."
  - "Routing-layer merging omits lifecycle keys; the integration branch must be read from the actual canonical configuration layers."
artifacts:
  - "Commit: Harden project entry and preserve existing agent launches"
  - "Commit: Report discovery review fixes and scratch verification"
  - "Branch: lane/discovery"
  - docs/reviews/discovery/c41ec1e-r1.md
  - discovery/README.md
  - discovery/test/review.test.mjs
  - discovery/test/sandbox.test.mjs
  - lib/files.mjs
  - docs/reports/ENG-77-discovery-evidence-20261001/README.md
  - "/private/tmp/eng77-r51-evidence-oFdxBU/summary.json"
  - "/private/tmp/eng77-r51-evidence-oFdxBU/R-49-raw"
decisions:
  - decision: Restrict implicit PATH entry to fresh interactive launches and retain explicit monitor entry for deliberate batch use.
    why: Existing launchers already own their role, checkout, run and report topology. Batch discovery probes now opt in through monitor-codex instead of intercepting every codex exec invocation.
  - decision: Harden shared file operations and resolve canonical validation fields independently.
    why: Routes, replies, audit records, gate files and report reads must not follow agent-created redirects. Canonical validate and prepare remain authoritative whenever each field is present; lane values are fallback only.
  - decision: Preserve summaries in Git and retain raw historical and current verification evidence in scratch.
    why: Transcripts, tested-product snapshots and test logs are review evidence rather than product source. Existing follow-on items already cover release installation, native Herdr interception and real Claude coverage.
questions: []
challenges:
  - premise: Every native harness session should create a new discovery lane.
    verdict: wrong
    evidence: Installed shims preserve interactive sessions from lane dispatch, supervisor/open-session, contrib/settle-watch, managed herdr agent start, and existing linked worktrees; fresh interactive sessions alone adopt automatically.
  - premise: A worker lane may replace the canonical project's green gate.
    verdict: wrong
    evidence: A worker config containing validate true and different prepare commands cannot bypass a failing canonical command in either check or promote; the integration branch remains unchanged.
---

All seven findings from the review of **Report installed project discovery and
isolated acceptance evidence** are addressed by **Harden project entry and
preserve existing agent launches**. This report is committed as **Report discovery
review fixes and scratch verification**.

| Finding | Result and evidence |
|---|---|
| Major: privileged path writes | Random temporary files use `O_NOFOLLOW` and `O_EXCL`. Each directory component is opened without following symlinks and checked against its inode; writes and renames remain relative to the pinned directory. Tests plant `.lane.json.tmp-PID`, redirect the destination and queue, and replace an ancestor during a write. Outside content stays unchanged. |
| Major: launcher compatibility | PTY tests exercise both installed shims, fresh entry, existing worktrees, noninteractive/print/resume passthrough, and native fallback for non-Git, empty and wrong-integration-branch projects. Lane dispatch launches through the installed shim with fake Herdr; supervisor and settle launch environments are produced by their real scripts; a fake managed `herdr agent start` supplies its live registration before launching the shim. Arguments, cwd and existing context survive. |
| Global Git identity | A scratch global config supplies identity with no repo-local identity or inherited identity overrides. The broker commit retains the global author and committer. Real user configuration is untouched. |
| Unused global git-lfs | Registered global LFS commands do not refuse unrelated projects. Attribute inspection includes tracked and new paths; referencing an executable filter still refuses bounded entry. Inspection itself disables hooks and fsmonitor. |
| Clean automatic bootstrap | The CLI and entry share local common-directory excludes for `.org/` and `.lane/`. Six concurrent first writers preserve events and leave Git status clean; installed case 02 also checks clean status. |
| Nested records | Lookup starts at the original cwd, walks to its checkout root, then considers the canonical record and its ancestors. A nested record receives the task without a divergent root record. |
| Canonical validation | Canonical `validate` and `prepare` take precedence independently. Check and promote print effective commands and sources. A failing canonical gate defeats a worker's `true` override and prevents integration. |

Verification used unrelated scratch projects outside repository trees, with no
model calls or live Herdr pane mutations:

| Check | Outcome |
|---|---|
| Baseline `npm test` | 376 passed, 0 failed, 2 skipped |
| Final `npm test` | 386 passed, 0 failed, 2 expected skips |
| `npm run test:lanes` | 146 passed, 0 failed, 0 skipped |
| Explicit native sandbox regression | Passed; sandboxed validation/promotion, conflict recovery, outside-write denial and linked `.git` write denial |
| Installed-product smoke, cases 02–04 | Passed; installed snapshot `/private/tmp/monitor-installed-FiXm80`, projects/evidence `/private/tmp/monitor-projects-LE6MsA/evidence` |

The installed smoke intentionally used `--skip-live`; cases 20/21 are pending,
and exit 1 signals incomplete acceptance rather than a failed smoke assertion.
The R-49 live results remain historical. This run does not judge or modify the
read-only ENG-74 acceptance harness while its R-50 correction is pending, and
does not claim release acceptance. Existing ENG-80 and ENG-81 cover the remaining
installation/native-launch and real Claude work; no duplicate proposals were made.

Only summaries remain in the repository evidence directory. All attempt-1..4
raw transcripts, prompts, receipts, snapshots and old test logs were copied to
`/private/tmp/eng77-r51-evidence-oFdxBU/R-49-raw` before removal from the current
tree. Current raw verification logs and `summary.json` are in the same scratch
root. The earlier report is retained unchanged as a historical record.

This report is checked with the record CLI before its commit. `lane check` is
the final command after that commit; `.lane/gate.json` records its result against
the committed HEAD. No push, release activation, machine installation, shared
configuration edit or housekeeping loop was performed.
