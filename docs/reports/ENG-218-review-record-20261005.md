---
run: R-259
outcome: done
summary: |
  Reviewers now deliver their private record inside the lane worktree, where the existing native worker settings allow writes. The foreground lane review command applies the existing completion, schema, ASCII and sanitization checks, exclusively archives the accepted bytes into canonical .lane/reviews, and removes the delivered file. Sandbox settings remain unchanged. Regression checks cover native confinement, archival, late evidence, occupied rounds, collisions and settle acceptance; the final lane check runs after this report is committed.
headline: Reviews can save their records without a sandbox exception
blockers: []
proposals: []
learnings:
  - Native Codex settings also make a linked workspace's .lane directory read-only; a delivery path inside a lane must use a different directory.
  - A private delivery directory with its own self-ignoring .gitignore keeps late evidence out of Git status without changing project ignores or granting another write root.
  - Native sandbox and filesystem watcher probes may require execution outside an enclosing macOS sandbox; sandbox_apply refused nesting and an existing watcher test reported EMFILE here, then both probes passed outside it.
artifacts:
  - "Implementation commit: 2c829f9 on lane/review-record"
  - "lanes/lane.mjs"
  - "lanes/docs/REVIEW_TEMPLATE.md"
  - "lanes/docs/REFERENCE.md"
  - "lanes/README.md"
  - "lanes/test/lane.test.mjs"
  - "settle/test/review-delivery.test.mjs"
  - "/private/tmp/ENG-218-native-red.tap"
  - "/private/tmp/ENG-218-native-probe.tap"
  - "/private/tmp/ENG-218-review-focused.tap"
  - "/private/tmp/ENG-218-interruption.tap"
  - "/private/tmp/ENG-218-byte-prefix.tap"
decisions:
  - text: Deliver private review records through an ignored directory inside the lane and let the foreground CLI archive the validated snapshot.
    category: design
    why: The lane is already writable to native reviewers, while canonical coordination state must remain protected. Exclusive archival of the settled bytes supports separate filesystems and prevents concurrent changes from reaching the canonical record.
questions: []
challenges: []
---

The brief's private output path is now `<lane>/.lane-review-<full-head>-r<N>/record.md`.
The CLI creates a mode-0700 directory with a self-ignoring `.gitignore`. Its only
authorized reviewer write is the designated record; other review restrictions and
the record format remain intact. Authorized scratch work uses the reviewer's private
run temporary directory.

The existing two-second completion settle interval, metadata matching, LF/UTF-8 and
size checks, ASCII projection, sanitization and unchanged-target checks still run.
After those checks, the CLI saves the exact settled bytes with exclusive creation
and mode 0600 at `<canonical>/.lane/reviews/<topic>/<head7>-r<N>.md`. It checks that
the delivered bytes have not changed before and after archival, then removes the
delivered file. Public projection and verdict exit codes remain unchanged. No
native settings or writable roots were added or modified.

Failure retains delivery evidence. The directory reserves the HEAD/round even if a
timed-out reviewer has not created the file yet, so another dispatch cannot reuse
that round. A selected later round leaves the late evidence intact. Canonical and
delivery abbreviation collisions, redirected paths and occupied archives refuse.
The existing settle implementation already consumes the public record and requires
no product change: the new integration test verifies archival, the isolated public
review commit, a clean lane, promotable status and an idempotent second handle.

Validation evidence:

- Before the fix, `node test/helpers/run.mjs --test-name-pattern='^review delivery is writable' lanes/test/lane.test.mjs`
  failed: the real `nativeSandboxLaunch` generator selected read access for the
  brief's canonical `.lane/reviews` path (`false !== true`). After the fix, the same
  regression passes with both Codex and Claude generated worker settings. The
  canonical archive remains denied, including Claude's Edit rule.
- With `MONITOR_TEST_SANDBOX=/Users/rewt/.codex/packages/standalone/releases/0.160.0-aarch64-apple-darwin/bin/codex`,
  that regression also passes an offline OS sandbox probe using the generated
  native profile: replacing the canonical archive raises EPERM/EACCES, writing the
  delivery file succeeds, and the archive still contains its original private
  evidence. This probe ran outside the enclosing sandbox; it calls no model.
- `node test/helpers/run.mjs --test-name-pattern='^(review |settle accepts and commits|malformed reviews never)' lanes/test/lane.test.mjs settle/test/review-delivery.test.mjs settle/test/settle.test.mjs`
  completed with 65 passes and one environmental filesystem watcher failure in
  the existing interruption test. The passes include canonical verdicts, rewritten
  completion, schema and encoding refusals, ASCII and privacy sanitization, lane
  mutation checks, exclusive publication, late delivery and settle recovery.
- The failed interruption case was rerun alone outside the sandbox with
  `--test-name-pattern='^review interruption exits'`: one pass, zero failures.
- The added raw UTF-8 byte preservation and pending-delivery abbreviation collision
  regressions ran with `--test-name-pattern='^review (archival preserves accepted|preflight preserves abbreviation)'`:
  two passes, zero failures. The raw-byte check preserves an accepted UTF-8 BOM
  rather than silently re-encoding the review during archival.
- `git diff --check` passed. No baseline, promotion suite, release suite or live
  acceptance harness was run. All test fixtures and model transports were offline.

After report validation and its separate commit, the last action is `lane check`
with the focused native, delivery, archival, collision, settled-byte, interruption
and settle integration regressions. Its gate receipt records the final committed
tree and command; this report does not claim a result before that check runs.
