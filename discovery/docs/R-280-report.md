---
run: R-280
outcome: done
summary: |
  Claude launch now treats the shared temp socket fallback as optional. Missing or inaccessible directories, foreign ownership, group/other write access and redirected paths produce one warning and omit the generated fallback grant. A safely owned fallback retains its grant; the private run-temp grant and environment are unchanged. Focused offline tests passed; the report is committed before the final lane check.
headline: Claude entry continues when the shared temp fallback cannot be safely inspected.
blockers: []
proposals: []
learnings: []
artifacts:
  - 9c44505e4321b0040779f3f0f01d873f8a3bec7b — implementation, documentation and offline regressions
  - lane/claude-fallback
  - discovery/native-sandbox.mjs
  - discovery/test/native-sandbox.test.mjs
  - discovery/README.md
  - discovery/docs/R-280-report.md
  - node --test discovery/test/native-sandbox.test.mjs — 25 passed, 1 existing opt-in Codex probe skipped
decisions:
  - text: Generate the shared fallback socket grant only after no-follow directory inspection confirms current-user ownership and no group or other write access; otherwise warn once and continue.
    category: security
    why: The ask explicitly requires unsafe or inaccessible fallbacks to be optional, while retaining the grant for a safely owned directory.
questions: []
challenges: []
---

Read ENG-239, ENG-228 and the RC-14 case 21 evidence. The original failure was
an EPERM from checkedDirectory opening /private/tmp/claude-501. The launch now
catches failures across fallback path resolution, traversal and ownership
inspection, including ENOENT, and generates only the run-temp socket grant in
those cases. The warning names the fallback and inspection failure. The launcher
does not create, repair or chmod the shared directory.

Offline regression cases exercise a missing directory, EPERM at open, foreign
ownership, unsafe write mode and a symlink. They verify a usable launch result,
one warning, run-temp socket/write grants, temp environment and cleanup. The
positive case verifies that a safely owned fallback keeps its canonical grant
without warning. A short run temp verifies that no fallback inspection occurs.
Tests use a private stand-in for in-process fallback inspection, avoiding ambient
machine ownership and permission assumptions.

Validation during development: node --test discovery/test/native-sandbox.test.mjs
completed with 25 passes, zero failures and one existing opt-in Codex probe skip.
git diff --check also passed. No model call or live acceptance harness was run.
ENG-233's short per-run Claude temp redesign remains separate.

After validating and committing this report, the final command is:

    node lanes/lane.mjs check --cmd 'npm run test:fast && node --test discovery/test/native-sandbox.test.mjs'

This binds both the normal fast tier and the changed regression file to the final
clean commit in .lane/gate.json. The focused file is included explicitly because
it is outside the inherited fast tier. The final gate result is retained by the
lane command rather than changing the report after that check.
