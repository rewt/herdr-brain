---
name: lane
description: Open, inspect, promote, or close a concurrent R&D lane (branch + herdr worktree) in bch-cloak. Use when starting a new research/dev topic, checking lane state, integrating finished lane work into main, or retiring a lane. Not for publication work — publication has its own gated pipeline under scripts/publication/.
---

# BCH Cloak R&D lanes

One topic = one `lane/<topic>` branch = one worktree under
`~/.herdr/worktrees/bch-cloak/`. The manager is `scripts/lane/lane.mjs`;
the contract lives in root `AGENTS.md` under "Concurrent R&D lanes".

```sh
node scripts/lane/lane.mjs open <topic> [base]  # cut lane/<topic>; base defaults to main
node scripts/lane/lane.mjs seams [pattern]      # kept unfinished work + archive tags
node scripts/lane/lane.mjs routes                        # authoritative named routes
node scripts/lane/lane.mjs dispatch <topic> --route <name> [@brief.md]
node scripts/lane/lane.mjs status               # lanes vs main, dirty flags
node scripts/lane/lane.mjs promote <topic>      # validate -> ff-only into main
node scripts/lane/lane.mjs close <topic>        # retire worktree + branch
```

## Dispatching agent work into a lane

Prefer `dispatch` over invisible background subagents for substantial lane
work: it opens a tab in the lane's herdr workspace, starts the configured
interactive agent there, and submits the brief — so the operator can watch
(`herdr agent read lane-<topic>`), attach, and steer from the console. The
launched session inherits AGENTS.md automatically (tracked CLAUDE.md
import); still put the task-specific constraints in the brief. Write long
briefs to a file and pass `@path/to/brief.md`. The orchestrating session
reviews the lane branch's commits afterwards and owns promote/close.

## Dispatch model policy

`scripts/lane/routing.json` is the sole authority for named route selection,
agent kind, model, reasoning effort, and the criteria for choosing a route.
Inspect it with `node scripts/lane/lane.mjs routes`, choose the route whose
`use` field matches the work, and pass only `--route <name>`. If no route fits,
propose a reviewed update to the table; do not copy a mapping into this skill,
a brief, another configuration, or ad hoc CLI overrides.
Environment, persona, account, memory integration, and other launch plumbing
are outside that routing authority.

- Cross-family second opinions remain useful for consequential claims when an
  applicable named route exists.
- **Verification is never delegated to the implementer.** The orchestrating
  session re-runs the decisive measurements itself before promote — an
  implementer's own numbers are claims, not evidence, whatever produced
  them.
- **One heavy dispatch per lane at a time.** Provers additionally serialize
  globally and stay in the main checkout (see AGENTS.md SP1 discipline).
- State the chosen route and why in one line of the brief. Runtime records may
  record the resolved agent/model/effort as evidence, but they are not policy.

Rule inheritance is already agnostic: codex reads AGENTS.md natively;
claude loads it via the tracked CLAUDE.md import. Those are the two supported
agent kinds.

## Supervising dispatched work (overnight-capable)

The orchestrating session supervises event-driven, not by polling:

- After each dispatch, start a watcher in the orchestrator's background:
  `herdr agent wait <agent-name> --timeout <ms>` — it exits when the agent
  reaches idle, done, or blocked (or on timeout), waking the orchestrator.
- On wake: the lane branch's commits are the deliverable. Independently
  re-run the decisive tests (never trust the implementer's numbers),
  promote on green, dispatch the next queued slice. On blocked/timeout,
  capture `herdr agent read <name>` and decide: steer, requeue, or hold.
- Unattended autonomy bounds (e.g. overnight): no push; NEVER mainnet;
  no proving unless the brief explicitly authorizes it (and then only
  under AGENTS.md SP1 memory discipline); no frozen-contract or tasks.md
  edits; promote only on green validation; anything ambiguous stays on
  its lane branch for operator review. Batch everything into one digest
  for the operator — interrupt for nothing.
- Live Chipnet operations (sign/broadcast with the operator's funded
  chipnet wallets — canonical funded set:
  `~/development/bastian/proofnote-workspace/state/wallets/chipnet-batch-demo/`
  (participant p1..p8 + recipient r* wallets, ~0.1 tBCH each, with
  address-manifest.json and funding-txids.json; payer-keys.json and every
  `wallet` file are SECRETS); round material in the main checkout's
  `.local-live/`) are allowed ONLY
  under an explicit standing operator authorization and a live-scoped
  brief. Operator policy 2026-08-30 for research-question transactions:
  HIGH VELOCITY — on a misconfigured or buggy live operation, log the
  exact error and restart the operation fresh; attempt no UTXO recovery
  (chipnet funds are expendable). Never print or delete secret material
  regardless; funding wallets is always the operator's act; live runs
  execute from the main checkout, never a worktree (pins and
  `.local-live/` live there).
- Close the tab when the session is done AND its results are durably
  recorded (commit promoted, or blocker/review report preserved):
  `herdr tab close <tab-id>`. Tabs are working surfaces, not archives —
  git and preserved reports are the record; lingering done-tabs are
  console clutter.
- Practicalities: the machine must stay awake (`caffeinate -is` in the
  orchestrator's background) and the orchestrating session must stay
  running; arm a self-paced heartbeat so a silent stall cannot strand the
  queue overnight.

## Leveraging kept unfinished work

ALWAYS check the seams before starting a new R&D question — prior
unfinished work often already covers part of it. Unfinished work survives
as kept branches (`experiment/*`, `work/*`, `infra/*`, ...) and as
`archive/*` tags on retired iterations; `preserve/*` snapshots are
read-only evidence, never resume-targets. The topic map — what each seam
is good for and why it was kept — is `docs-internal/rd-seam-inventory.md`.

```sh
node scripts/lane/lane.mjs seams private-spend  # discover by pattern
git log --oneline main..<ref>                   # what a seam adds
node scripts/lane/lane.mjs open <topic> <ref>   # resume it as a lane
```

Then, inside the lane worktree: `git rebase main` (promote enforces it),
re-validate — treat inherited work as unverified until its tests run green
on top of current main — and promote as usual. To mine files or single
commits instead of whole seams, open a lane from main and use
`git cherry-pick <sha>` or `git restore --source <ref> -- <paths>`.
Once a resumed lane promotes, its source seam shows up as merged/superseded
in the next branch-hygiene pass.

Rules of the road:

- Work and commit on the lane branch inside its worktree. Never commit to
  main directly; never push.
- `promote` refuses unless the lane worktree is clean, the branch is
  rebased onto current main, and validation is green (default
  `pnpm validate:all-safe`; override with `LANE_VALIDATE=...` when the
  lane's focused suite is the right bar — say so in your report).
- `close` on an unmerged lane archive-tags it (`archive/lane/<topic>`)
  before deleting the branch, so nothing is lost.
- Worktrees carry no gitignored state (`.local-live/` is empty there) and
  pinned-prover runs must stay in the main checkout — see AGENTS.md.
- Lanes never touch `scripts/publication/**` gates or public repos.
