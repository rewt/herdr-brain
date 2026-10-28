# Completion identity and worktree alignment

ENG-801 / R-1125, 2026-10-28. Operator direction is preserved in the owning
record's `evidence/SESSION-ID-ON-COMPLETION-20261028.md`.

## Checked harness behavior

- Installed `codex resume --help` accepts an explicit UUID and optional task
  prompt, exposes `--cd`, and says `--all` disables cwd filtering in the picker.
  The [official OpenAI documentation](https://learn.chatgpt.com/docs/projects)
  says resumed chats retain their transcript and recorded working directory
  while reading the current worktree. A removed checkout therefore needs an
  existing working directory before Brain launches the saved conversation.
- Installed Claude Code 2.1.310 (`claude --help`, package metadata) accepts
  `--resume`, retains sessions on disk, and can reuse the session ID. Its
  [official session documentation](https://code.claude.com/docs/en/sessions)
  confirms explicit UUID lookup works across directories and transcripts are
  stored per project path. **Claude does not strictly require the original
  checkout path to find the UUID.** Recreating that path is Brain's alignment
  contract, preserving paths referenced by the prior conversation.
- The existing `ai` wrapper selects the owning persona/config directories by
  cwd. This change retains that wrapper and uses the existing harness-specific
  `resume UUID` / `--resume UUID` argument builder. It does not change identity,
  permissions, hooks, pins or saved runtimes.

## Implementation and evidence boundary

Report intake snapshots effective identity under the record lock, including
the checked late session binding. Closeout snapshots each closed native session
on its immutable effect. A completion carries the UUID, harness and original
lane/path without a join to `run.session_bound`. Multi-session closure uses an
array; a singular closure also exposes the UUID/harness directly. Unknown or
conflicting historical identity is null rather than invented. No historical
event or folded run/report shape changes.

New resume requests consume the completion, keep source/path aligned, and refuse
dirty, foreign, relocated, wrong-item or wrong-family sources. The kept branch
is reopened without replacement; if closeout removed its integrated branch,
the original lane/path is recreated from main. Existing closeout's 17:5x rule
still closes the session and removes the clean folder together, retains dirty
folders, and deletes only integrated branches.

The selected check is `node test/helpers/run.mjs test/completion-resume.test.mjs
dispatch/test/correction-launch.test.mjs test/direct-report-routing.test.mjs`.
It is run once through `lane check --cmd` on committed source. The lane receipt
and owning report provide the actual command/head/status/totals; this document
does not claim an unrun result.

The new focused file covers raw and late identity at actual report ingestion,
idempotency and older folds, real closeout and worktree removal, actual lane
reopening, and dispatch with preserved transcript context for both harnesses,
from both retained and integrated branches. Deterministic native adapters
assert the resumed UUID/cwd, receipt of the new run's prompt, and supervisor
watcher addressing. Native model execution and a live supervisor delivery
canary are **unrun**; the release coordinator retains live acceptance and full
release coverage. No service or watcher is restarted.

## Premise ledger

Premise: completion snapshots plus original-path reopening can preserve saved
context while following immediate report closeout. No failed fix attempts at
initial implementation. Source/claim/CAS/STOP/HOLD guards remain authoritative.
Any first red, setup slip, correction and check result are preserved in the
owning run's evidence/report rather than relabelled green.
