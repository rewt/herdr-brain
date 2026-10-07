---
run: R-279
outcome: done
summary: |
  Replaced the fixed supervisor copy list with recursive discovery of live source and support files, including untracked documents and nested helpers. Runtime state is excluded, raw bytes and modes are backed up and hashed, and referenced readable script backups still participate in retirement checks. A read-only bch-cloak snapshot copied the required waiting note, passed relocation and audit, and accepted all thirteen cutover edits. The relevant offline checks passed 38 distinct tests; the implementation is committed and this checked report precedes the final focused lane check. The rehearsal explicitly records that its process-based session cap is not exercised.
headline: Cutover rehearsal follows new supervisor support files
blockers: []
proposals: []
learnings:
  - Existing-project supervisor helpers and required documents can be untracked; Git inventory and fixed filename lists are insufficient for the rehearsal copy.
  - Cutover tests need a scratch TMPDIR outside the operator home and host execution for their nested sandbox-exec check; the inherited worker sandbox refuses sandbox_apply.
artifacts:
  - "Implementation commit: 8d389fb"
  - "Branch: lane/cutover-files"
  - acceptance/existing-project.mjs
  - acceptance/test/existing-project.test.mjs
  - docs/reports/ENG-238-cutover-files-R-279.md
  - docs/reports/evidence/ENG-238-R279/copy-cutover.tap
  - docs/reports/evidence/ENG-238-R279/harness.tap
  - /private/tmp/eng238-live-copy-7pbjdK/manifest.json
  - ".lane/gate.json binds the final focused lane check to the report commit"
decisions:
  - text: Explicitly record that the rehearsal does not exercise the process-based session cap; retain the sandbox policy and use the deterministic offline cap test as separate evidence.
    category: prover
    why: RC-14 proves host ps can be denied, and a successful dispatch cannot prove its watcher count was observed. The generic copy fix needs no new host process access; both legacy and switched cap matching and refusal remain tested with controlled ps output.
questions: []
challenges: []
---

The failure evidence in `/private/tmp/herdr-acceptance-sagdjD/evidence/19.jsonl`
matches the live dispatch: it requires `.lane/supervisor/no-poll-waiting.md` after
starting the run. The fixed copy list omitted that untracked document.

`acceptance/existing-project.mjs` now discovers supervisor scripts, documents and
configuration recursively, independent of Git tracking. It excludes logs,
outbox/inbox, queues, locks, PID/socket receipts, caches, checkpoint files and
current handoff state. Script names such as `gate-queue.sh` and log-reading
helpers remain source, rather than being confused with state. Every selected
file has its original bytes/mode backed up and its SHA-256 recorded before
relocation. Required cutover inputs still fail explicitly if absent. Support
symlinks are refused; path relocation, transitive audit and kernel sandboxing
remain in the invocation path.

Readable shell and JavaScript variants now participate in the retirement scan.
Referenced timestamped script backups remain active transitively, including
mode-0644 Python/JavaScript backups; unreferenced backups are archived outside the
executable copy. The runtime exclusions are applied only to live-copy inventory;
retirement scanning of the resulting copy has no exclusion callback.

The offline new-file regression executes a copied dispatch that reads the newly
added waiting document, invokes a nested new helper, and reads its new text
support file. It verifies actual output, raw backup bytes, modes, manifest hashes
and refusal when the required note is removed. Additional regressions cover
runtime exclusion, source names containing queue/log, transitive readable backups
and symlink/regular-input refusal.

A read-only smoke snapshot of `/Users/rewt/development/bastian/bch-cloak` copied
37 files and archived 43 historical script backups. Its manifest is retained at
`/private/tmp/eng238-live-copy-7pbjdK/manifest.json`. The waiting document's SHA-256
was `c9e962c36e56aa738764d8365944f4a8000f3751c8555565d2da11fdd58b2ad8`;
dispatch's modification time was `2026-10-06T22:51:39.776Z`. The entire copy passed
relocation and audit, and all thirteen switched-file transformations applied.
No copied live script was executed, and no live project file was edited.

The process-based session cap is explicitly unexercised in the switch case result
and `cutover-switches.json` (`sessionCap.exercised: false`). Host `ps` can be denied
and these canaries do not fill the cap. The offline dispatch test separately
executes both baseline and switched cap refusal/matching with deterministic
process output, alongside the real kernel-lock test. This scope is also stated
in `acceptance/README.md`.

Validation:

```sh
TMPDIR=/private/tmp node --test acceptance/test/existing-project.test.mjs acceptance/test/cutover.test.mjs acceptance/test/cases.test.mjs
# 27/27 passed; copy-cutover.tap

TMPDIR=/private/tmp node --test acceptance/test/harness.test.mjs
# 11/11 passed; harness.tap
```

The inherited TMPDIR initially put scratch paths under `/Users/rewt`, causing the
unchanged transitive audit to refuse them. With `/private/tmp`, the worker sandbox
then refused nested `sandbox-exec`; host execution resolved that environmental
restriction. An initial combined host run passed 37/38, with the unchanged
scripted-supervisor composer test reading readiness before its stdout receipt;
that file passed all eleven checks on an isolated rerun. No unrelated test or
product behavior was changed for it. After the final copier/scanner refinements,
the copy/cutover/case checks passed all 27 tests again. `git diff --check` passed.

No baseline, npm test, promotion suite, lanes suite, release suite, model call,
live harness or housekeeping loop ran. Zero `--skip-live` passes were used.
Independent settle review and release-candidate validation remain downstream;
these offline results do not claim a live cutover or approve a release.

The requested record report is checked and this report/evidence are committed
before the final operation:

```sh
node lanes/lane.mjs check --cmd 'TMPDIR=/private/tmp node --test acceptance/test/existing-project.test.mjs acceptance/test/cutover.test.mjs acceptance/test/cases.test.mjs'
```

The gate receipt and validation log record that result against the final commit.
