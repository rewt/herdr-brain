---
run: R-204
outcome: done
summary: |
  Shortened the shared offline root and per-file fleet paths, and made fixtureFleet allocate
  a disposable short fleet when its project scratch path exceeds the native temp budget.
  The fleet and promotion fixtures also use short roots. Supplied the Linux refusal fixture's
  required project temp root and isolated the main-mode adapter's native configuration directories.
  All five train failures now pass; the three requested test files have 59 passes, zero failures
  and two explicit provider skips. Production code and its 60-byte refusal are unchanged.
headline: Short test fleet paths restore the five failing CI cases
blockers: []
proposals: []
learnings:
  - "Default fleet temp adds /t/<16-character hash>/r-XXXXXX, so test fixtures must budget the resolved fleet path plus 28 bytes. macOS os.tmpdir() alone can exceed the allowed root length."
  - "Native settings fixtures must isolate CODEX_HOME and CLAUDE_CONFIG_DIR: inherited operator permission choices deliberately suppress generated confinement settings, even with a capable fake harness."
  - "Direct discovery/validate.mjs fixtures need MONITOR_PROJECT_TEMP when their fake repository has no joined fleet context."
artifacts:
  - "Fix and evidence commit: 4f5e5c0 on lane/native-sandbox"
  - test/helpers/offline-herdr.mjs
  - test/plugin-install.test.mjs
  - test/fleet.test.mjs
  - promote/test/promote.test.mjs
  - discovery/test/review-r4.test.mjs
  - discovery/test/settings.test.mjs
  - docs/reports/evidence/R-204/focused.tap
  - docs/reports/evidence/R-204/focused-sandbox-attempt.tap
  - docs/reports/ARCH-18-native-sandbox-ci-20261004.md
decisions:
  - text: Adapted offline fixtures to the existing native launch contract without changing production limits or policies.
    category: tooling
    why: The narrow CI fix brief requires short fixture paths and preserves the production 60-byte refusal.
questions: []
challenges: []
---

The train's failures 144, 148 and 149 are in test/plugin-install.test.mjs; 741 is in
discovery/test/review-r4.test.mjs; 764 is in discovery/test/settings.test.mjs. The first
three failed because the shared offline fleet lived beneath macOS's long system-temp
directory. The Linux case instead lacked its required temp root. The main-mode case
already advertised permission-profile support but inherited operator configuration,
so its expected generated filesystem setting was absent.

The new regression case exercises default run-temp allocation through the shared
offline fleet and through fixtureFleet with a long scratch root. Both remain within
60 bytes, while an intentionally long production root still refuses. Per-file fleet
isolation, fake Herdr refusal, owned cleanup and environment restoration remain intact.
Static inspection found two more explicit system-temp fleet roots in test/fleet.test.mjs
and promote/test/promote.test.mjs; those now use resolved /tmp roots with short prefixes.
Their files were not run, as the brief restricts this round to the three affected files.

Validation command:

```sh
node test/helpers/run.mjs test/plugin-install.test.mjs discovery/test/review-r4.test.mjs discovery/test/settings.test.mjs
```

The initial sandboxed attempt passed all five named cases but failed four other
validation cases because macOS refused nested sandbox_apply calls. The approved
host rerun passed 59 of 61 cases with no failures; two optional real-provider cases
explicitly skipped because their provider environment variables were unset. Both
attempts are retained in repository evidence. Tests remained offline and called no model.

Reviewed the diff against the CI fix brief and ran git diff --check. No baseline,
full suite, promotion suite, lane suite or live acceptance harness was invoked.
After checking and committing this report, the final action is lane check with the
same three-file command via --cmd, preserving the requested test scope instead of
running the configured broader fast suite. Its receipt and log identify the final
clean commit. Promotion and release validation remain with their authorized batches.
