---
run: R-275
outcome: done
summary: |
  Fixed all four review findings: symlinked module help, lazy Claude validator resolution, explicit native precedence with receipt provenance, and the concurrent-worker validation regression. Upgrade/help checks passed 48/48, targeted installer/adapter/canary regressions passed 139 with two provider-specific skips, and seven installation safety/compatibility checks passed. The concurrent-worker case passes at base and at the corrected head inside the host test slot, including with installed entry wrappers ahead of native Codex. The implementation is committed; the checked report commit precedes the final focused lane check.
headline: Entry overrides and symlinked help work and concurrent worker validation passes
blockers: []
proposals: []
learnings:
  - Explicit native selections must retain precedence and provenance in installation receipts; discovered natives follow PATH at launch, and stable native symlinks survive upgrades without reinstalling entry.
  - The concurrent-worker offline case needs the host test-slot wrapper; its inner environment scrubs wait and token variables, while the slot recognizes descendants through process ancestry.
  - An installed Monitor entry wrapper found by which codex is unsuitable as the offline native sandbox provider because its child spawn loses fd 3 readiness. Resolve the real native launcher past managed entry directories.
artifacts:
  - "Implementation commit: 286df534d2ac629a1c93c82b3a77b75a85a851ec"
  - "Branch: lane/entry-pin"
  - docs/reports/ENG-229-entry-pin-R-275.md
  - docs/reports/evidence/ENG-229-R275
  - test/entry-upgrade.test.mjs
  - test/cli-help.test.mjs
  - acceptance/test/live-session.test.mjs
  - ".lane/gate.json records the final lane check against the report commit"
decisions: []
questions: []
challenges:
  - The R-271 report's separate pre-existing failure claim and proposed follow-on are superseded. Base passes in the host slot; the failing lane fixture selected an installed entry wrapper as its native sandbox provider. This run fixes the failure here and proposes no separate work.
---

Addressed the four Moderates from R-271 review
`.lane/reviews/entry-pin/6eb72cc-r1.md`.

`cliHelp` compares realpaths for the executable and module. The tests launch
`lanes/lane.mjs` and `brain/bin/brain.mjs` through a launcher symlink that itself
traverses a `current` release symlink. Both print help and exit zero without
operational writes.

Claude resolves its default Codex validator only after deciding to enter.
The installed automatic `claude --version` works with Codex absent, while an
entry attempt diagnoses the missing validator. Explicit validators still win.

Receipts now carry `nativeExplicit` and `claudeNativeExplicit`. Machine staging
passes discovery provenance in its private installer environment, preserving
compatibility with older installers. Direct installer arguments and machine
environment overrides select explicit natives; release activation retains those
choices. An executable explicit selection wins before PATH; if unavailable,
launch falls back to the current native PATH launcher. Discovered natives search
PATH first and retain receipt paths as fallback. Generated wrappers use a
separate fallback argument so a caller's adapter `--binary` is honored directly.
The adoption and installation guides state these rules. Removed the R-271
canary PATH reordering and naming workarounds now that explicit installs work.

The offline concurrent-worker fixture now resolves native Codex past managed
entry wrappers. The lane shell's `which codex` selected installed Monitor entry,
which spawns only stdin/stdout/stderr and drops the validation owner's fd 3
readiness receipt. That produced exit 125 after green inner tests. Using native
Codex preserves the receipt and allows validation and promotion. The mandatory
readiness and sandbox checks remain intact.

Evidence:

- `TMPDIR=/private/tmp node --test test/entry-upgrade.test.mjs test/cli-help.test.mjs`:
  48 passed. Covers explicit environment and direct installer selections against
  competing PATH natives, per-invocation `--binary`, retained explicit choices
  across installation, discovered PATH replacement while the receipt still
  exists, version upgrades after removing old targets, missing validators,
  managed-directory exclusions, and symlinked module help.
- Targeted bounded runner over `test/zero-setup-install.test.mjs`, discovery's
  entry/review/review-r2/review-r4/settings/lessons files, and acceptance's
  lessons/cases/environment/launch/results files: 139 passed, two explicit
  provider-specific skips, zero failures.
- Targeted `test/plugin-install.test.mjs` selection for overlapping installs,
  stale-plan refusal, runtime rollback, shell-byte preservation, default native
  discovery, real v0.1.3/v0.1.4 compatibility, and edited adapters: seven passed;
  the other 33 cases were excluded by name.
- Base `1032c6a599daeb443ed194ce84dd2327216c58cd`: the single concurrent-worker
  case passed inside the host slot, including a repeat with explicit matched
  native PATH and Node. `concurrent-base-slot.tap` and
  `concurrent-base-matched-slot.tap` retain the results.
- Before the fixture correction, the lane shell reproduced exit 125 after two
  green inner tests inside the host slot (`concurrent-head-slot.tap`).
- Corrected implementation: the same host-slot command with the lane shell's
  original PATH and Node passed the selected case; two unrelated cases were
  excluded by name (`concurrent-head-fixed-slot.tap`). Both worker promotions
  and the answered route flow completed.
- The same base/head comparison with explicit native PATH and Node is recorded
  in `concurrent-base-matched-slot.tap` and `concurrent-head-native-slot.tap`.
  Exact commands, tool selection, and the superseded initial direct attempt
  are explained in the evidence directory's README.
- `git diff --check`: passed before the implementation commit.

The authoritative concurrent-worker runs use:

```
MONITOR_TEST_SLOT_WAIT_SECONDS=3600 TMPDIR=/private/tmp node test-slot/test-slot.mjs run entry-pin-live -- node test/helpers/run.mjs --file-timeout=480000 --test-name-pattern='^installed live discovery records concurrent workers' acceptance/test/live-session.test.mjs
```

The base archive is unmodified for those runs. The first exploratory direct
base run temporarily preserved and forwarded the wait variable; it was outside
the slot and used a different native selection, so it is not evidence of a
pre-existing failure. The supervisor's slot command established the passing
base, and the correction was verified with installed entry still shadowing PATH.
This replaces the R-271 report's attribution and proposal; no new proposal is
filed for that failure. Existing ENG-234 should be assessed against this evidence.

No full promotion/lane/baseline suite, live acceptance harness, model task or
project housekeeping loop was run. The native sandbox checks execute fixed
offline workers only. Machine installation fixtures use scratch homes and bins;
the operator's installed entry was inspected without alteration.

After checking and committing this report, the final action is:

```
node lanes/lane.mjs check --cmd 'MONITOR_TEST_SLOT_WAIT_SECONDS=3600 TMPDIR=/private/tmp node test-slot/test-slot.mjs run entry-pin-final -- node test/helpers/run.mjs --file-timeout=480000 test/entry-upgrade.test.mjs test/cli-help.test.mjs acceptance/test/live-session.test.mjs'
```

The final gate and its content-checked log retain the result against the report
commit. No subsequent lane mutation is planned.
