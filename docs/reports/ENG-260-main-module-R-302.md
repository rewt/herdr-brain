---
run: R-302
outcome: done
summary: |
  Consolidated sixteen product entry guards on the existing realpath-based isMain helper in lib/cli-help.mjs. Added directory/file symlink probes for every converted script, helper edge-case coverage, and a source guard in both fast and promotion tiers. Snapshot copies remain untouched.
  The requested implementation and evidence are committed. Symlink regressions, helper/candidate tests, slot suites, and additional housekeeping/lane checks passed. Broader offline acceptance has two unresolved failures, recorded as follow-on proposals below; promotion cleanup failures passed on isolated retries. The checked report is committed next, followed by the required final lane fast check.
headline: Product entry points now run through symlinks with one shared realpath check
blockers: []
proposals:
  - role: engineer
    title: Investigate native validation owner exit 125 after successful sandbox assertions
    why: The offline actual-native-transport case in acceptance/test/validation.test.mjs reproduces in isolation with four other cases passing. Its inner sandbox tests pass but the validation owner returns 125. Evidence is docs/evidence/ENG-260/R-302/validation-retry-host.tap; this prevents green full offline acceptance and needs independent investigation before release.
  - role: engineer
    title: Keep offline discovery fixture promotion inside an isolated test slot
    why: acceptance/test/live-session.test.mjs uses sessionEnv with an empty input and loses the scratch slot configuration. Its installed-discovery case then encounters the real promotion batch holding /private/tmp/bch-cloak-test-slot.lock. Offline acceptance should not depend on real project activity. Evidence is acceptance-isolated-host.tap, case 142.
  - role: engineer
    title: Make fixture inbox cleanup tolerate owner lock handoff
    why: The capped-promotion-notice test failed in cleanup when test/helpers/inbox.mjs checked that owner.lock existed and then owner.json disappeared before its read. The unchanged case passed on an isolated retry. Handle this disappearance without weakening PID and argv ownership checks to prevent intermittent suite failures.
learnings:
  - "Run test-slot/test directly with node --test and an offline Herdr environment. The bounded test runner disables child detachment and changes the process-group behavior those cancellation tests verify."
  - "Worker TMPDIR can be under the real home. Acceptance scratch safety rejects those roots; use TMPDIR, TMP and TEMP under /private/tmp for these offline checks, plus owned fixture slots. Clear inherited ORG_DIR for in-process fixture cleanup."
artifacts:
  - "Implementation and evidence commit: 46c0837e60439ed565d9272cab06a3c262e16b4f"
  - "Branch: lane/main-check"
  - "test/main-module.test.mjs"
  - "docs/evidence/ENG-260/R-302/commands.txt"
  - "docs/evidence/ENG-260/R-302/related-files.txt"
  - "docs/reports/ENG-260-main-module-R-302.md"
  - "/Users/rewt/development/rewt/.org/runs/R-302/report.md"
decisions:
  - text: Reuse the existing isMain helper for all conditional product entry points, including already-safe duplicate checks.
    category: design
    why: One dependency-free realpath implementation handles both file and directory symlinks and keeps imports side-effect-free.
questions: []
challenges:
  - "The brief's eleven-script inventory is stale: four test helpers already use isMain. The sweep found twelve remaining path.resolve comparisons, one raw argv comparison in acceptance/focus.mjs, and three duplicate realpath checks. All sixteen are consolidated."
  - "Broader offline acceptance remains 219 pass and 2 fail. Neither failure was hidden or converted to a skip; native validation reproduces in isolation, while the installed-discovery failure names the real held promotion slot."
---

The shared helper already resolves both argv and the module URL and returns false
for missing or dangling launch paths. No new helper or dependency was introduced.
Unused path/URL imports and an unused SELF constant were removed where appropriate.

`test/main-module.test.mjs` has 34 cases: 32 CLI probes (directory and file symlinks
for each of sixteen scripts), one repository source guard, and one helper edge-case
test. Probes reach actual command parsing, rejection, or hook output rather than
relying on early shared help. The source guard rejects the old path comparison and
duplicate main checks outside `acceptance/test/fixtures/` and `kit/`; both snapshot
trees have zero changes. It allows ordinary argv path resolution unrelated to an
entry comparison. The new file runs in both fast and promotion tiers.

Before conversion, 24 probes for the twelve path.resolve scripts silently exited;
the preliminary source guard also failed. The final symlink/helper tests passed.
TAP logs retain all attempts, with trailing whitespace normalized for Git checks.

Primary test batches, with counts from their TAP summaries:

| Evidence log | Pass | Fail | Skip |
| --- | ---: | ---: | ---: |
| main-and-pty-host.tap | 45 | 0 | 0 |
| helpers-final-host.tap | 66 | 0 | 0 |
| slot-direct-host.tap | 75 | 0 | 0 |
| additional-related-host.tap | 91 | 0 | 1 |
| related-isolated-host.tap | 493 | 1 | 6 |
| acceptance-isolated-host.tap | 219 | 2 | 0 |

The related batch's failure was the stale-worker-lock test's cleanup resolving the
inherited real ORG_DIR. The unchanged full promotion file, retried with ORG_DIR
and HERDR_AGENT_NAME removed, passed that case: 23 pass / 1 cleanup-race fail.
That different cleanup-race case passed its isolated retry: 1 pass / 23 unselected
skips. Native validation's isolated retry remained 4 pass / 1 fail. These retries
overlap the primary batches and are not added to their counts.

Test files were selected by script-path/import searches; the exact related-file
list and reproducible commands are retained beside the logs. Coverage includes:

| Converted scripts | Script-specific coverage |
| --- | --- |
| discovery bounded, bubblewrap, lane-file-access | alternatives, entry, owner, review-r3, review-r4; symlink probes |
| herdr release-candidate | release/test/candidate; CLI help and symlink probes |
| promote promote and metrics | promote, train, workflow-train, affected-tests, metrics |
| release release | release/test/release; candidate and CLI probes |
| supervisor supervisor, prompt-supervisor, tidy-tabs | supervisor/status, supervisor, delivery, entry, autopilot; inbox and tidy-tabs tests |
| housekeeping housekeeping | housekeeping and auto-tidy tests |
| test-slot wrapper | all five direct slot test files; lane validation/workspace and load-deadline tests |
| acceptance run, settle, supervisor, focus | all 27 top-level offline acceptance test files; symlink probes |

Already-migrated tier, suite, release-suite and PTY helpers were also checked,
including their existing symlink tests. No baseline, aggregate promotion/lanes
suite, full release suite, live acceptance harness, model call, project-wide
housekeeping loop, promotion, push, or merge was performed. Downstream independent
review and release-candidate validation remain required.
