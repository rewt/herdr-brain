# Change project operations without changing the release

An adopted project's audited home policy can change the settings captured by
the next admission while its accepted Brain release stays the same. Editing a
repo copy or shared skill alone is not activation. Existing saved operations
and delivered briefs retain their original settings and paths.

## Evidence and current limit

ENG-1041 / R-1502 supplies one offline control in
[`test/project-operations.test.mjs`](../test/project-operations.test.mjs). It
uses the existing config-home fixture, guarded adoption with an injected native
observation and a synthetic fixture human answer, then the installed fixture
release's real `record config`, `start`, and brief renderer. Those synthetic
inputs authorize only disposable fixture data; they are not actual owner proof.

The single effective change is project `routes.engineer.effort`, `high` to
`xhigh`. The control checks source/key/scope provenance, the precise audit diff
and owner Git identity, unchanged old run/event/brief bytes, the next record
run's changed settings and brief, unchanged release ID and full installed
runtime/metadata digests, visible divergence from the retained repo copy, and
an audited digest-checked rollback. Both runs remain open in the fixture while
the policy changes; rollback preserves both captured settings. No native
session is launched. Fixture teardown removes only fixture data.

Live acceptance remains pending. The project supervisor recorded on ENG-1041
on 2026-10-30 that Brain currently uses development source and has no adopted
home binding; ENG-1050 owns the source/release split. The installed BCH release
belongs to another identity and is outside this scope. The first actual owner
with an adopted project on an unchanged release supplies the live receipt
after that prerequisite. This document authorizes no adoption, rebuild, pin
change, other-project action or additional session start.

## Owner procedure for the live receipt

Use the existing project owner, project record, pinned Node and accepted
installed command. Follow the shared `project-preflight` and `project-deliver`
skills for source work and its evidence; do not copy procedures into a live
saved runtime or revise an already delivered brief. This is a procedure for an
owner-authorized operating change, not permission to perform one.

1. Record the owner's authorization and exact project/common-directory/record
   binding. Use `record config --json` to capture effective source/key/scope,
   `record config history --json` for the current audited revision, and the
   existing release status to capture the selected non-null release ID, root,
   commit and pin provenance. If the project is not already adopted onto an
   accepted home-aware release, leave this proof pending with its owner.
2. Select one reversible supported project setting with that owner. The offline
   example changes one existing project-declared engineer route effort from
   `high` to `xhigh`; choose it live only when appropriate for authorized work.
   Retain the complete original project file, its SHA-256 digest, and whether
   the key was absent or inherited. Save rollback instructions before editing.
   Do not materialize inherited routes accidentally. Standalone routing uses
   its explicitly bound home routing file, not a guessed repo filename.
3. Identify an already admitted run and capture its declared route settings,
   generated brief, saved operation's route snapshot and release binding.
   Hash the immutable files. Keep native addresses, saved runtime paths,
   callbacks, watchers, pins and issued jobs unchanged. A still-pending saved
   job is an old admission even if its native launch happens later.
4. From the owning project, use the supported audited writer with the inspected
   file digest and owner reference. For the exact example, when that key was
   already project-declared:

   ```sh
   record config set routes.engineer.effort xhigh --expect OLD_SHA256 --who-asked OWNER_RECORD_REFERENCE
   ```

   Capture the resulting `config.changed` event, old/new digests, actor, caller
   Git identity and leaf diff. Inspect `record config --json` once: the only
   effective value diff must be `routes.engineer.effort: high -> xhigh`, with
   the selected home source. Preserve its warning that the retained repo copy
   differs and repo-reading scripts still use that copy. Neither a matching
   repo edit nor a package build is required to activate a supported home key.
5. Let the existing owner admit the next already-authorized eligible work
   through normal guarded dispatch. Do not create a demonstration model job,
   bypass selection/holds or restart a service. Capture its job/run/brief and
   native launch receipt under the same non-null release ID/root/commit. Verify
   the new route snapshot and actual launch settings use the recorded revision;
   recheck the old snapshot/brief hashes. An unchanged release or a config
   preview alone is insufficient evidence of a new native session.
6. For the exact example, roll back using the post-change digest:

   ```sh
   record config set routes.engineer.effort high --expect NEW_SHA256 --who-asked OWNER_ROLLBACK_REFERENCE
   ```

   Preserve the rollback audit and effective diff. If the original key was
   absent, use the writer's `--unset` form to restore inheritance instead;
   restore any deliberately materialized route through its supported writer.
   A digest mismatch requires fresh owner inspection, not overwriting intervening
   policy. Rollback changes future admissions; it never edits either saved run.
7. Attach the old/new immutable bindings, exact effective diff, config revision,
   actual owner and native receipts, unchanged release evidence and rollback
   receipt to the owning record. Mark unperformed native/live checks unrun.
   Keep the existing single asynchronous review and release-owner obligations.

This key rollback is distinct from undoing home adoption, which has its own
guarded owner procedure in [the binding contract](contracts/CONFIG-HOME.md).
