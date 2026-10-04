# Supervisor handoff — 2026-10-03 (evening)

For a fresh `supervisor-herdr` session. The record is authoritative; this note is the map. Start with
`node supervisor/supervisor.mjs brief`, then `record show G-3` and `record show ARCH-10`.
Record: `ORG_DIR=/Users/rewt/development/rewt/.org`, actor `supervisor-herdr`.

## Where we are

- Phases 0–4 are done. **Phase 5 (ARCH-10, adoption) is the remaining phase.** Its definition of done (note on
  ARCH-10): install Herdr, add the plugin, be running like this machine, inside a fleet with per-project sandboxes.
  It ends with the operator's fresh-account rehearsal.
- Main is at `8d633c2` or later. bch-cloak still runs release **v0.1.2**; no release has been activated since.
- RC-1 to RC-3 failed the gate for real reasons (setup input, focus monitor, an ENG-121 dispatch regression). All
  three causes are fixed on main except the harness items in ENG-137. **RC-4** is cut after ENG-137 lands.

## Landed today (all on main)

Test and cycle robustness: ENG-112, 117, 103, 113, 122 (non-setuid process identity), 116 (memory gate), 118 (host
test slot), 120 (focus monitor), 134 (load-aware gate deadlines). Workflow: ENG-124/125/130 (**merge train**:
review-only settle, one CI run per batch, safe bisection), 128 and 136 (standard supervisor entry), 139 (train
recovery paths), 142 (auto tab tidy every housekeeping tick), 140 (no tracked Codex hook). Product: **ARCH-17 fleet**
(projects join a fleet by being entered; discovery stops at the project edge; one shared product inventory),
ENG-119 (gate setup inputs), ENG-121/129/131/133 (one-tab dispatch, works with no Herdr workspace). Design memos:
docs/design/ARCH-17-workspace-20261003.md, docs/design/ARCH-18-sandbox-20261003.md.

## In flight when this was written (their reports arrive as notices)

| Run | Item | What it is | What to do when it reports |
|---|---|---|---|
| R-199 | ENG-157 | CI under 5 minutes (slow tests to the release tier) + set review cap to 1 | Settle (review-only), then enqueue |
| R-201 | ARCH-19 | Zero-setup install | Settle, then enqueue |
| R-202 | ENG-135 | Suite pass, last narrow CI fix | If it fails CI again, **drop the lane** (archive tag keeps it) |
| R-203 | ARCH-18 | Native sandbox fix round (5 Majors) | Direct check, no further review; enqueue |

Next to dispatch after those: ENG-137 (harness fixes), then cut RC-4. Then the smaller follow-ups (ENG-138 fleet
moved-checkout repair, ENG-126 escalation ladder, ENG-127 archive and scratch sweep, ENG-156 slot waits).

## Operator decisions today (all recorded on G-3, ARCH-10, ARCH-17, ARCH-18)

- **Simplify by subtraction (2026-10-04, after low confidence in the workflow):** process freeze (no new workflow items
  until Phase 5 ships); CI under 5 minutes; **one review round** (Majors get a fix, Moderate/Minor become follow-ups);
  **2–3 small, short lanes at a time on disjoint files**; judge by dispatch-to-main time per item.
- Worktree = branch, promotion = pull request: **tests run once, at promotion (CI)**; workers run only the tests they
  write; settle reviews code and runs no suite; the release gate runs once per release.
- Fleet (HUM-24..27): the machine boundary is the **fleet** (`~/.herdr-monitor/fleet.json`), projects join by being
  entered, supervisors are per project only (no fleet supervisor), one adjustable session limit (default 6).
- Sandbox (ARCH-18): **minimal and native** — harness sandbox settings keep writes in the project, per-run TMPDIR; no
  broker, tokens, wrapper or grant machinery; respect the operator's own weaker settings with a visible warning.
- Velocity rules: the host test slot belongs to CI and the release gate only; rebase/fix rounds get a narrow brief of
  their own, never the original task brief; don't couple one lane to another unless it truly depends on it.
- Waiting on the operator: **HUM-19** (scratch Claude login for discovery tests; recommended no) and each release
  activation.

## How to operate (what actually works today)

- **Every final report goes through settle**: `node supervisor/supervisor.mjs handle --notice '<notice>' --role supervisor
  --to supervisor-herdr --review-route review-codex`. Settle is review-only and ingests the report. Use
  `review-codex`: the default Claude review route's output is often rejected by lane review's format check (ENG-132).
  Do not use `lane review` for runs — it bypasses ingestion (that left 35 runs un-ingested on 2026-10-03).
- **Promote through the train**: `MONITOR_TEST_SLOT_WAIT_SECONDS=3600 HERDR_AGENT_NAME=supervisor-herdr node
  promote/promote.mjs <lane>...`. `[promote-queue]` notices report the outcome; close items yourself on "promoted"
  (`record close ITEM --note ...`). A refused lane gets a narrow fix or rebase round.
- When a fix round changes a test, run that test on main first: if main passes it unmodified, the lane broke
  something and the test must not change (R-176 was rejected this way).
- If the record shows runs open that already landed: `record sync`, then `record ingest docs/reports/... --run R-n`.
- Housekeeping (pid may change) runs auto-tidy every minute; restart with `node housekeeping/housekeeping.mjs --start`
  from the canonical checkout if `record housekeeping` shows it stopped.
- Briefs for today's lanes are in `docs/briefs/` (including ARCH-18, ARCH-19, ENG-135, ENG-136, ENG-139, ENG-140,
  ENG-142, ENG-157).

## Known rough edges

- ENG-132: default review route format rejections (use review-codex).
- ENG-155 and the ENG-139 note: a settle refused by a transient record precondition can stay terminal.
- ENG-156: the train refuses instead of waiting when the slot is held (use the wait variable above).
- Lanes still open on purpose: `lane/console-autonomy` (the live console tab runs from it; fast-forward it to main when
  console work lands).
