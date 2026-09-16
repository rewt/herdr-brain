# Piloting M1

Date: 2026-09-15, America/Chicago. Scope: dogfooding the `org` CLI built in M1.
Nothing here is authorized to start merely because it is listed. No remote
publication, no cross-project rollout, and no savings claim is implied.

M1 answered its own design question by construction: state is a fold over
`events.jsonl`, status is derived, and the tests prove a copied directory yields an
identical snapshot. What it cannot answer by construction is the only question that
decides M2:

> **Does the record hold well enough that a fresh session never has to fall back to
> the conversation it replaced?**

Everything below is arranged so a failure of that question is cheap and legible.

## Already answered — do not spend pilot budget re-testing

**The YAML subset is not the risk the handoff thought it was.** Thirty report
envelopes in shapes a model plausibly writes were driven straight through
`parseYamlSubset` and `normalizeReport`: 28 were accepted, including colons in
unquoted summaries, `#` inside values, markdown bullets and blank lines in block
scalars, emoji, apostrophes, four-space indents, CRLF, folded scalars, flow lists of
maps, `[]`, `null`, `yes`, backslash paths, and values opening with `*`, `&`, `[`,
`{`, `%` and `@`. Two were rejected: tab indentation and a flow list spanning
several lines. Both fail closed with a line number and a non-zero exit:

```
$ org check tab.md
error: could not read the front matter: line 6: use spaces, not tabs, for indentation
$ echo $?
1
```

Treat `report.mjs` as monitored, not as the leading risk. Record any real-world
rejection during the pilot; swap in a library only if agents actually produce shapes
outside the subset.

**`org` is on PATH.** `~/.local/bin/org` is a symlink to `bin/org.mjs`, matching how
`lane` is installed. This matters more than it looks: `render.mjs:304` ends every
brief with `Check it with \`org check <path>\`, fix anything it reports, then stop.`
A worker that cannot resolve `org` silently skips its own validation step. Panes
inherit your PATH and are fine. **Sandboxed sessions must be checked before
dispatch** — herdr-lanes already runs engineer sessions that cannot bind a Unix
socket, and those same sessions may not see `~/.local/bin`. Use
`org start ID --report <path-in-workspace>` for them, and confirm `org check` runs
there, or accept that their reports arrive unvalidated.

**`herdr org` is not achievable and should be dropped as a goal.** Herdr plugins
cannot register top-level CLI subcommands. The `PluginManifest` struct in the
installed 0.8.2 binary exposes `build`, `startup`, `actions`, `events`, `panes` and
`link_handlers` and nothing else, and the 0.9.0 documentation is explicit: *"Herdr
owns the host surface: installation, manifest validation, keybindings, terminal
panes, events, invocation context, and socket access."* There is no `herdr-<name>`
PATH fallback either. `org` stays a sibling CLI invoked inside Herdr panes. If
in-Herdr integration is wanted later it is a plugin exposing an `org status` pane
and actions, invoked as `herdr plugin action invoke …` — a deliberate M2+ decision,
listed today under *Not in this version*.

## Preconditions

1. **Commit M1 before dispatching anything.** The repo currently has zero commits
   and every file untracked. A pilot against an uncommitted tool cannot say which
   version produced a result, and every acceptance convention in this workspace is
   anchored to an evidence SHA. This is the cheapest precondition and the only
   hard one.
2. **Put `.org/` at `/Users/rewt/development/rewt/.org`, beside `.lane.json` — not
   inside a project.** `lane open` cuts worktrees into
   `/Users/rewt/development/rewt/.worktrees/<project>/<topic>`, which is a *sibling*
   of the project, not a child. Discovery resolves `$ORG_DIR` first and otherwise
   walks up from the cwd looking for `.org/events.jsonl` (`store.mjs:27-35`), so an
   `.org/` inside `herdr-lanes/` is invisible to every agent lane dispatches. One at
   the workspace root is found from the project checkout *and* from the worktree —
   verified against a mirror of this exact layout. It is also the placement the tool
   is actually for: goals that span `herdr-lanes`, `coach` and `herdr-org` rather
   than eleven per-project ledgers.
3. **At that location the commit-policy question disappears.** The workspace root is
   not a git repository, so `.org/` cannot enter any project's history by accident
   and nothing needs deciding before seeding. Revisit only if you later want the
   record to travel between machines.

## Stage 0 — report conformance probe

**Purpose:** find out whether real harnesses write valid, useful reports, before
committing a day to the assumption that they do. **Cost:** three runs.

Run it on `herdr-org` itself. The work is real, small, unblocked, has no gate or
serialization constraints, and a bad outcome costs nothing — unlike herdr-lanes,
where every change queues behind an acceptance bottleneck. The M1 handoff already
names three suitable items:

- make briefs embed paths relative to the org root instead of absolute ones;
- decide and document the `.org/` commit policy;
- record whether the YAML subset needs replacing, given the measurement above.

Dispatch one to **Claude Code**, one to **Codex**, one to **Gemini**. Three
harnesses, not three sessions of one: M1 claims the core "never branches on harness,
provider or model," and a single-harness probe cannot test that claim.

```sh
cd /Users/rewt/development/rewt          # the workspace root, beside .lane.json
org init
org add --goal "M1 survives contact with real harnesses"
org add "Make brief paths relative to the org root" --parent G-1 --role engineer \
    --accept "a brief generated from a deep worktree is no longer than one from the repo root"
org start ENG-1 --harness claude-code --model opus
# open a Herdr pane, launch the harness, paste the printed prompt
```

Then `org sync` and `org status`.

**Measure only four things.** Did `org sync` accept the report unedited? Did the
worker run `org check` on its own, as the brief told it to? Are `learnings` and
`proposals` substantive, or restatements of the brief? Did any proposal become a
child item worth having?

**Gate.** If two or more of three reports are unparseable, or all three produce
empty or vacuous `learnings`, **stop and fix the brief template — not the parser.**
The measurement above says the parser is unlikely to be at fault, which makes a
failure here evidence that the brief is not asking clearly enough.

## Stage 1 — the real dogfood

Only after Stage 0 passes. One working day plus one overnight, in `herdr-lanes`.

**Seed from the carry-forward table.** `docs/plans/2026-09-15-carry-forward.md`
already carries eleven open items with prerequisites and next actions, and it maps
onto the model almost directly: items become items, the *Prerequisite* column
becomes `--blocked-by`, and the four rows reading "Operator decision" are exactly
the `needs_human` state. Seeding is transcription, not planning.

**Dispatch a day's work through `org start`,** with the harness in a Herdr pane, as
in Stage 0. Record usage whenever a harness reports it:
`org set R-n tokens_in=… tokens_out=… cost=…`. Where a harness does not report it,
usage is **unknown** — leave it unknown rather than estimating.

**Then the test that matters.** That evening, kill every session and every pane.
The next morning, open a fresh session, run `org snapshot`, and continue from it
alone — no prior conversation, and deliberately **without opening `HANDOFF.md`.**

## The baseline, and the metric that actually decides

The incumbent is not "no coordination." It is the file that does this job by hand
today:

| Cold-start read today | Bytes | ≈ tokens |
| --- | --- | --- |
| `HANDOFF.md` | 132,451 | 33,112 |
| `docs/plans/2026-09-15-carry-forward.md` | 5,384 | 1,346 |
| `AGENTS.md` | 5,197 | 1,299 |
| **Total** | **143,032** | **≈ 35,758** |

A demo-sized `org snapshot` is roughly 500 tokens. **Do not report that ratio as the
result.** A snapshot that omits what a session needs is not cheaper, it is just
smaller, and the two artifacts do not carry the same thing.

The real metric is a count, taken during the morning-after session:

> **How many times did the fresh session have to fall back to `HANDOFF.md`, to an
> earlier transcript, or to you?**

Zero means the record replaces the handoff file, and the token comparison is then
worth reporting. A constant trickle means `org` is one more file to maintain
alongside the one it was supposed to retire. Keep the running list the M1 handoff
asked for — everything you had to re-explain that the record should have held. That
list, not the ratio, is what specifies M2.

## Stop and reconsider

- Stage 0 gate fails → fix the brief template, re-probe, do not proceed to Stage 1.
- A mid-day refusal (unknown id, cycle, a second differing report for one run) is
  **correct behavior**. Record it and adapt; do not work around it.
- Do not run this at the same time as the manual coordinator pilot
  (carry-forward item 8). That experiment asks whether a coordinator identity earns
  its overhead; this one asks whether the durable record holds. Run them together
  and neither result is attributable. `org` is the plumbing the coordinator pilot
  can use afterwards, once it is known to hold.
- Do not weaken an acceptance check to keep a pilot run moving.

## Explicitly not in this pilot

Automatic dispatch, harness adapters, a Herdr plugin, leases, memory integration,
model routing, and token or quota enforcement. Dogfooding decides which of these M2
needs; none is assumed.
