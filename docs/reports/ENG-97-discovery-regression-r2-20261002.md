---
run: R-112
outcome: done
summary: |
  Corrected the review finding that the acceptance transport dropped the validator's writable temporary-directory grant.
  The native regression now creates, reads and removes a file through TMPDIR while retaining shared-state, Git and network denial checks.
  The live gate and offline native regression now use the same relocated transport, including its verified-path dependencies.
  The rebuilt lane candidate passes all 26 release cases, including both real discovery cases; the offline acceptance suite passes all 63 tests.
  Acceptance against a rebuilt candidate from main remains pending supervisor integration and a receipt identifying that main commit.
headline: Validation temporary files work again and main acceptance awaits integration
blockers: []
proposals: []
learnings:
  - The validator supplies TMPDIR as the verified in-checkout .lane/validation-tmp directory; validating its product write entry without composing it makes native temporary-file operations fail with EPERM.
  - The live gate relocates the native transport into scratch. Its dependency tree must be copied with relative imports intact, and offline native proof must execute that same copy.
  - A green lane candidate receipt establishes lane validation; the separate rebuilt-main acceptance needs a post-integration main receipt.
artifacts:
  - "Commit: Preserve validation TMPDIR writes in acceptance transport (92bdcac)"
  - "Commit: Keep native validation transport imports intact in scratch (fdf2a2a)"
  - "Commit: Report discovery regression review corrections for run R-112"
  - "Branch: lane/discovery-regression"
  - "acceptance/validation.mjs; acceptance/transport.mjs; acceptance/live.mjs; acceptance/test/validation.test.mjs; acceptance/README.md"
  - "Offline baseline npm test: 682 passed, 11 skipped, zero failed; 693 total tests in 300.764 seconds, captured in this run's command output."
  - "Post-TMPDIR-repair npm test: 682 passed, 11 skipped, zero failed; /private/tmp/eng97-r112-after-tests.log"
  - "Final offline acceptance suite, including the copied native transport: 63 passed, zero skipped or failed; /private/tmp/eng97-r112-acceptance-final.log"
  - "Native negative control before the repair: /private/tmp/eng97-r112-missing-tmp-grant.log; fixed native checks: /private/tmp/eng97-r112-validation.log"
  - "First R-112 full gate, identifying the missing scratch dependency before inference: /private/tmp/herdr-acceptance-FTsF0x/evidence; /private/tmp/eng97-r112-candidate-gate.log"
  - "Final full rebuilt lane candidate gate: 26 passed, zero failed or pending in 406 seconds at fdf2a2a; /private/tmp/herdr-acceptance-kwWhU1/evidence; /private/tmp/eng97-r112-candidate-gate-final.log"
  - "Retained gate summaries and screens: docs/reports/evidence/ENG-97-discovery-regression-r2"
  - "Report copy: docs/reports/ENG-97-discovery-regression-r2-20261002.md"
  - "record check /Users/rewt/development/rewt/.org/runs/R-112/report.md"
  - "Final command after the report commit: node lanes/lane.mjs check; .lane/gate.json binds the committed code, evidence and report to its default npm test result."
decisions:
  - text: Preserve verified product write exceptions inside the validation checkout, including its dedicated temporary directory.
    category: security
    why: This restores the product's supported TMPDIR capability. Component checks refuse redirected directories; overlapping Git metadata and grants containing protected shared-state paths refuse; existing read and deny rules remain composed.
  - text: Copy the native transport and its dependencies with their relative directory layout, and use that copy in the offline native regression.
    category: tooling
    why: The first live gate exposed an import missing from the flat scratch copy. Sharing the copy path makes offline proof cover the executable artifact launched by real discovery.
  - text: Record acceptance against rebuilt main as pending supervisor integration and post-integration validation.
    category: prover
    why: Both the previous receipt and this run's receipt identify lane commits. Main is still the captured base, and lane work cannot supply the supervisor's integration receipt.
questions: []
challenges:
  - "The previous R-111 report is preserved as requested. Its lane-candidate success does not establish the separate rebuilt-main acceptance criterion."
  - "The initial native invocation inside Codex's sandbox could not install a nested Seatbelt profile. Authorized host execution then reproduced the actual missing TMPDIR grant and verified the repair without authentication or a model."
  - "The first full gate of this correction at Preserve validation TMPDIR writes in acceptance transport failed cases 21 and 22 before inference because the new verified-path import was absent from the flat scratch transport. Keep native validation transport imports intact in scratch corrects that packaging defect; final offline proof executes the copied transport."
---

The moderate review finding is fixed in **Preserve validation TMPDIR writes in
acceptance transport**. Product write entries now enter the composed filesystem
after existing-ancestor containment and component-by-component no-follow checks.
The transport rejects exceptions overlapping the assigned or common Git metadata,
and exceptions containing protected read-only or denied paths. Other session
paths remain read-only. The native regression verifies TMPDIR's actual validation
path, creates a temporary directory, writes and reads a file, removes it and the
directory, and retains the foreign-read, shared-record, canonical coordination,
assigned/common Git and network denials. It exercises check and fast-forward
promotion for both ordinary work and approved routes.

Before the fix, that same native temporary-directory operation failed with
`EPERM` in `mkdtemp`, retained in
`/private/tmp/eng97-r112-missing-tmp-grant.log`. After the fix the native checks
pass. **Keep native validation transport imports intact in scratch** adds the
transport dependency copy used by both the live gate and offline regression.
The final offline acceptance suite passes all 63 tests with no skips, including
actual native confinement and integration without authentication or model calls.
The inherited R-111 validation log is also green: 682 passed, 11 skipped, zero
failed against **Report discovery regression repair for run R-111**.

The original cause remains **Deny unknown validation syscalls and contain detached
descendants** (`2d22bb9`): the acceptance transport discarded the product's
allowed/denied lifetime identity and did not forward its readiness descriptor.
R-111's adjacent-commit evidence shows its parent **Report Claude discovery review
fixes and pending live proof** (`5873f07`) passing both real cases, with `2d22bb9`
failing both. Receipts remain in
`docs/reports/evidence/ENG-97-discovery-regression` and the original scratch
directories named in the unchanged R-111 report. This correction preserves the
lifetime fixes and adds the missing temporary-directory capability.

The full lane gate command is:

```sh
node acceptance/run.mjs --candidate lane/discovery-regression \
  --source /Users/rewt/development/rewt/.worktrees/herdr-brain/lane-discovery-regression \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm
```

The final gate rebuilt its snapshot from
`fdf2a2a05e8fad3dcedfd4110f3b3c1ac8da9655` (**Keep native validation transport
imports intact in scratch**) and passed **26/26**, with **zero failed or pending**,
in 406 seconds. Cases 21 and 22 both pass. All four real sessions used
`gpt-5.6-luna` / `low` and exited zero with measured usage. Their numbered logs,
transcripts, permission/policy receipts, questions/answers, integration verification
and usage remain under `/private/tmp/herdr-acceptance-kwWhU1/evidence`. Cleanup
left no owned workspaces, retained discovery roots or credential residue.
Only `summary.json` and `screen.txt` are retained per gate in the repository.

The first R-112 gate at **Preserve validation TMPDIR writes in acceptance
transport** passed 24 cases and failed cases 21 and 22 before inference because
the new relative path-checker import was omitted from the flat scratch copy.
Its receipt remains under `/private/tmp/herdr-acceptance-FTsF0x/evidence` and
in the separate retained `first-r112-gate` summary. The second implementation
commit fixes that packaging and makes the native offline test exercise the
same copied transport as the successful full gate.

**Acceptance against a rebuilt candidate from main: PENDING.** Main still resolves
to `3817c15513c07fe2331d479619d11820220d8425` (**Brief for ENG-97: v0.1.5 discovery
regression**) at report preparation. This lane receipt does not complete that
criterion. After the supervisor integrates the independently accepted lane,
the supervisor must rebuild and run the full gate with `--candidate main` from
the canonical checkout, then attach `summary.json` and `screen.txt` identifying
that rebuilt main commit and showing cases 21 and 22 passing. No rebuilt-main
receipt is currently supplied.

This report is checked and committed before the final default lane check.
The check's default command is `npm test`; its exact committed head and result
are recorded in `.lane/gate.json`. Release directories, bch-cloak source, shared
lane configuration, operator bin and unowned panes were untouched. No push,
publication, project-wide housekeeping loop or canonical integration was run.
