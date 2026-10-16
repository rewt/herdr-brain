# Promotion board

A dependency-free, read-only view of background promotions and gates. Open it in
an ordinary Herdr pane; it never starts, stops, retries or detaches work.

```sh
node ~/.local/share/herdr-monitor/current/board/board.mjs \
  --project /Users/rewt/development/rewt/herdr-brain

node ~/.local/share/herdr-monitor/current/board/board.mjs \
  --project /Users/rewt/development/bastian/bch-cloak \
  --source bch=tools/promotion-board/rows.mjs \
  --log-root /Users/rewt/development/bastian/archive
```

Repeat `--project`, `--source` and `--log-root`. Each source belongs to the
preceding project (or the launch directory). With no project, the launch
directory is used. Brain queues are discovered by Git common-directory identity.
`--interval S` defaults to 2 seconds. Script reads run at most once every 5
seconds, never overlap, time out at 10 seconds and allow at most 1 MiB stdout.
They receive only PATH, HOME and set ORG_* variables. Stderr is discarded.

`--once` prints one plain snapshot. `--json` prints the validated snapshot and
rows for other renderers, omitting worktree and slot identity paths. Neither
mode uses terminal escapes. Live TTY mode uses the alternate screen and restores
the cursor and screen on SIGINT, SIGTERM or SIGHUP. `NO_COLOR` uses plain frames
without escapes. Narrow panes elide columns from the right; `--json` preserves
all validated fields. Rows group by project, then active, queued and newest
finished. The recent Brain window is 24 hours, capped at 20 finished requests.
Closing the pane loses no state. Only script refresh timing and the previous
source/frame are kept in memory; all Brain files and host facts are read anew.

The immutable slice-1 contract is
`/Users/rewt/development/rewt/.org/evidence/PROMOTION-BOARD-SOURCE-CONTRACT-20261016.md`
(SHA-256 prefix `d49f5620`). It defines `board-rows/v1`, including BCH's example.

Brain phase mapping:

| Durable source | Board phase |
| --- | --- |
| pending request | queued |
| batching/promoting; pending train; preparing/prepared/rebasing attempt | admission |
| unfinished gate waiting for its slot, without a command-start receipt | admission |
| unfinished validation gate with command start (or older gate without slot metadata) | stage 1 of 1 |
| validated/integrated/complete attempt; batch-delivering/completed queue state | reconcile |
| promoted result (reconciliation complete or absent for older results) | landed |
| promoted result with incomplete reconciliation | reconcile |
| refused/failed result; red/invalid attempt | failed |
| interrupted/timeout result or attempt | interrupted |
| unrecognized state | unknown |

Results take precedence over intermediate states. Stage 1 of 1 means the whole
validation gate: Brain receipts do not publish a finer stage count. A receipt
with matching key, head and tree supplies gate timing. A matching execution
sidecar supplies the command start, so a slot wait stays admission. Only the integrated
`tip` of a promoted result supplies main; `source_head`/`expectedHead` supplies
candidate. Job/batch logs contribute only numeric TAP/Vitest clocks through
`parseLog`, never phase or completion. Item and pane come from targeted record
`show <id> --json` reads. No whole-record status read occurs.

Every source passes through `rows.mjs`. Failed fields become `withheld`; unknown
keys disappear. Status text rejects controls, paths, long hex and the contract's
secret blocklist. No raw log, stderr, exception, notes, report or dispatch token
reaches the renderer. Logs must be regular files under explicit roots (Brain's
Git common directory is automatic), with no symlinks, `..`, controls or
secret-like segments. This also withholds paths under an OS directory named
`private`, as required by the literal segment rule. Worktree directories are
used only for slot matching and never displayed. Missing/closed panes fall back
to the validated log. Herdr unavailability is explicit.

Memory uses free + inactive + speculative pages on macOS, MemAvailable on Linux,
and unknown elsewhere. The shared slot reader uses read-only filesystem calls
and `readTestSlotQueue(..., {prune:false})`; it never acquires or repairs a lock,
prunes a ticket or prints tokens, pids or cwd paths. Uncertain holder liveness
stays unknown. The holder's label passes through the status-text filter.

Releases archive the complete tracked tree, so `board/` ships without changing
the release file selection. Focused offline checks:

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 \
  test/board-rows.test.mjs test/board-source.test.mjs \
  test/board-brain.test.mjs test/board-view.test.mjs
```
