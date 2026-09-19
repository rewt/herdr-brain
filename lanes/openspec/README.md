# Specification workflow

Use OpenSpec's `spec-driven` artifacts as portable Markdown. Read the root
`AGENTS.md`, this file, and a change's proposal, design, specs, and tasks before
working. Any capable agent can follow them through `lane dispatch`; no slash
commands, generated agent integration, framework install, or runtime hook is needed.

[The initiative report](../docs/SPEC-20260908.md) explains the selection, sequence,
estimates, and operator rollout. roots-config has promoted and its task is checked;
the other change folders remain proposals with unchecked tasks. This planning
addendum neither implements them nor approves contract amendments.
All interactive UI is Ink in the terminal; no browser UI is planned.

## Layout and lifecycle

- `specs/lane-safety/spec.md` records the relevant existing behavior.
- `changes/<change>/proposal.md` gives motivation, impact, and prerequisites.
- `changes/<change>/specs/<capability>/spec.md` holds proposed requirement deltas.
- `design.md` records decisions; `tasks.md` is the complete dispatchable lane brief.
- The optional [mouse research brief](../docs/tasks/board-mouse.md) lives outside
  product changes: its output is a decision report, not a fictional capability.

One product change is one lane, including tests and documentation. The four initiative
phases are divided into numbered subphases so each can promote independently.
Create the lane from the current canonical checkout, then dispatch its tasks file:

```sh
lane open roots
lane dispatch roots --route engineer @openspec/changes/roots-config/tasks.md
```

The review/configuration addendum has two more independent engineering lanes:

| Change / dispatchable brief | Route / effort | Sequence and approval |
| --- | --- | --- |
| [review-cli](changes/review-cli/tasks.md) | engineer / High; combined or [R-i/R-ii split](changes/review-cli/design.md#pre-agreed-split-point) | No capability prerequisite beyond current main; roots-config sequencing is now satisfied. No contract amendment; map maintenance is allowed. |
| [default-config](changes/default-config/tasks.md) | engineer / High; combined or [D-i/D-ii split](changes/default-config/design.md#pre-agreed-split-point) | After full review-cli (R-ii if split); approved A5 applies in D-i if split. |

Use each tasks file's topic for subsequent lanes. Resolve its dependencies on local
main before opening it. Check off its single task only after implementation,
verification, and the report are complete; this means ready for promotion, not
already promoted. Commit only when the dispatch authorizes it; never push under
these briefs. Promotion remains the operator's serialized, validated fast-forward.

For an implemented change, sync its deltas into `openspec/specs/<capability>/spec.md`
in the final implementation commit: ADDED becomes the main Requirements section;
MODIFIED replaces the complete matching requirement. The synced spec and code become
current together when that lane promotes. After promotion, archive the completed
change into `openspec/changes/archive/YYYY-MM-DD-<change>/` in a separately
authorized documentation lane or the next dependent lane. Verify the recorded
implementation commit is an ancestor of local main before archiving. Do not reapply
already-synced deltas. Never archive these proposals now or mark an unimplemented
downstream phase current. No empty archive scaffold is necessary.

This is the standard [OpenSpec separation of current specs and proposed changes](https://github.com/Fission-AI/OpenSpec/blob/main/docs/concepts.md),
adapted to git promotion. The [default schema](https://github.com/Fission-AI/OpenSpec/blob/main/schemas/spec-driven/schema.yaml)
supplies the artifact shapes. Optional local validation, using an existing OpenSpec
installation, is:

```sh
OPENSPEC_TELEMETRY=0 openspec validate --all --strict --no-interactive --concurrency 1
```

That variable controls the external authoring tool, not `lane`. Do not add OpenSpec
to package manifests, installation steps, or `npm test`.

## Common delivery rules

Each engineering task includes its requirements and these shared delivery rules.
Independent reviewers follow the narrower review protocol below, not engineering
instructions to add tests, edit files, commit, or run unbudgeted baseline checks.

1. Read `AGENTS.md`, `README.md`, `HANDOFF.md`, `docs/REFERENCE.md`, and its change
   artifacts completely. Work only in the dispatched repository and lane worktree.
2. Inspect status/recent commits and run the baseline. Run one build/test command at
   a time on the machine. This is operator discipline, not a new scheduler or lock.
3. For each behavior, add the smallest offline test in `test/` and observe its
   failure before implementation; retain the suite's deliberate negative control.
   Existing `board/test/` coverage stays, but new regressions must also satisfy
   the root `test/` instruction. Use built-ins and temporary repositories with cleanup.
   Fake Herdr responses must contain real protocol fields; skip live-only checks with
   an explicit reason when Herdr or a suitable terminal is absent.
4. Run `npm test`, relevant negative controls, and `git diff --check`, serialized.
   Describe measured results and limits. Do not lower or bypass the validator.
5. Document every new public command, key, flag, and environment variable in the
   CLI usage text and short command-led README, including the README command table
   for commands and their options; put full semantics in REFERENCE. Keep fixtures
   and all tracked artifacts public-safe. Never copy raw local briefs, transcripts, process
   lists, socket paths, identities, or operator configuration into git.
6. Commit the report and dated HANDOFF entry with implementation. Run `lane check`
   after the final commit; quote its exact GATE in the conversation. Do not create
   another report commit to store that final line: it would stale the gate.
7. A gate is not a review verdict. Promotion always revalidates, regardless of board
   metadata, report wording, completion flags, or a previously green gate.

## Independent review protocol

[review-cli](changes/review-cli/design.md) specifies the reusable reviewer template
and one foreground command. The operator supplies an explicit --round and selects
--change for an OpenSpec-origin lane, otherwise --brief. Additional brief text can
set an explicit finite check budget; absent authorization means zero build/test runs.
Every authorized build/test, including a negative control, waits for a clear load
probe and consumes its stated budget. Reviewers must write the designated private
record; that mandatory output is permitted by their otherwise read-only role.
Before default-config ships, configure the review route first. Reviewers create
nothing inside the lane worktree, including untracked/ignored scratch; any
test/mutation fixtures live under the system temp directory and are cleaned up.

The reviewer writes only the canonical checkout's gitignored
.lane/reviews/<topic>/<head7>-rN.md, never the public record or tracked files. The
v1 schema requires a first line of **PASS**, **NEEDS-WORK** or **FAIL**, full
Reviewed commit, [Major]/[Moderate]/[Minor] findings with file:line/fix, Re-executed
commands/results with a negative-control or mutation witness behind every tests-pass
claim, Non-claims and Unverified. The exact schema is maintained in the change/spec.

lane review enforces unchanged HEAD and a clean tree before/after the reviewer,
waits for the completed private record's size and modification time to settle for
two continuous seconds, re-reads its bytes, then validates that final read and
sanitizes a public projection. Its explicit timeout therefore accepts three through
7200 seconds. Unverifiable
sanitization refuses publication. The CLI writes the public record only after
those checks; it never stages or commits it. The operator inspects public safety
and authorizes any subsequent commit/check/fix. A record's original SHA never
silently becomes evidence for a newer commit.
If the pre-agreed review split is selected, R-i ends at a validated private record
with no public output; R-ii adds verified sanitization and the publication boundary.
Default-config waits for that complete boundary, not just the private-only command.
The delivered command includes R-i and R-ii: private validation is followed by
verified sanitization and the after-check publication boundary. The public record is
still an untracked operator-inspected artifact; the CLI never commits it.

Recommend a higher explicitly selected route for round 3 or later: review-xhigh
for adversarial/crypto/semantics work, review-max after repeated NEEDS-WORK. Before
default-config ships, these are operator-configured route names. There is no automatic
escalation or next round. Any review-fix loop stays with the operator or a separately
authorized contrib wrapper with a fixed round cap; no wrapper is specified here.

## Proposed contract amendments — pending operator approval

The operator must approve these exact texts before their dependent implementation.
Keep the current root `AGENTS.md` unchanged in this planning lane. Approval is for a
concrete amendment; it is not required to finish the present specification.

Roots-config (1a) needs no contract amendment. Canonical-config resolution is a
documented behavior change inside that lane, covered by its tests and reference
update. A1 is approved/applied in roots-identity (1b); its path-placement sentence
retroactively describes the placement already delivered in 1a.

**A1 — append to Product contract (roots-identity):**

> A repository is identified by its canonical git common directory, never by its
> basename, workspace label, remote, or author name alone. Development-root lane
> paths are outside the canonical checkout, with no automatic temporary-directory
> fallback. Existing registered worktrees remain usable without automatic migration.
> Lane commands do not set git identity; git configuration remains authoritative.

**A2 — append to Product contract (session-registry):**

> The session registry and completion markers are gitignored local display metadata.
> Dispatch may record a session and close may mark its sessions done; the board may
> discover sessions and explicitly mark a row done. This data must never authorize,
> schedule, retry, lease, validate, promote, push, or delete work. Concurrent metadata
> updates must not lose unrelated sessions. No daemon or background job coordination
> is added.

**A3 — replace the Herdr-optional bullet in Product contract (board-actions, 2b-ii):**

> Herdr integration is optional for git-only operations and offline board snapshots.
> Dispatch in any form, including review dispatch and dispatch-from-idea, live
> discovery, and session focus require an available Herdr server. The optional board
> UI invokes lane CLI interfaces for observations
> and actions; it does not implement a second git or Herdr control path. Reconnection
> may restore display subscriptions only and must never replay lifecycle actions.

**A4 — replace the built-ins/UI-exception bullet in Change rules (board-ux):**

> Use Node.js built-ins only in lane.mjs, dependency-free board services, and the test
> suite. The isolated board/app.mjs entrypoint and UI-only modules under board/ui/
> may use Ink, React, and @inkjs/ui from board/package.json. Keep their dependencies
> and lockfile isolated; git-only commands, plain/JSON board output, and npm test
> must run without installing the UI package. Preserve Node.js 20 compatibility.

**A5 — replace the repository-neutral configuration bullet in Change rules (default-config):**

> Keep configuration repository-neutral. The tool may ship documented, overridable
> built-in role routes using public vendor model names and effort settings, plus
> packaged generic brief and review templates. Built-ins have lower precedence than
> operator-supplied configuration and must not embed personal or organization-specific
> paths, accounts, credentials, endpoints, or identities. Agent kind and model remain
> configurable; unavailable defaults fail visibly without silent model substitution
> or retries. Under the public-file rule above, documented public vendor product
> identifiers used as overridable defaults are not organization-specific defaults.
> Document every public configuration key and environment variable in
> README.md.

A5 is proposed only for default-config. Public model names are portable identifiers,
but packaged model policy changes the previous operator-owned default boundary;
explicit approval keeps that exception narrow. review-cli needs no A5 or other new
amendment. This planning addendum does not edit AGENTS.md.
Ordinary review deliberately uses the agent's default effort with no flag, rather
than fixed high. Ratify that choice with A5; a complete route override can pin high.
Repository-map entries for the new template/defaults are ordinary documentation
maintenance, authorized in their engineering lanes without a separate amendment.

A2 clarifies the display-only exception already identified in the promoted board
reviews. A3 makes the requested CLI boundary explicit; it does not permit a job
system. A4 extends the existing Ink/React exception only as far as the chosen official
UI component package and UI modules. Any further dependency needs its own proposal.
Board-cli (2b-i) adds read interfaces with the UI untouched and needs no amendment;
A3 applies when board-actions (2b-ii) rewires that UI. Idea-cli composes existing
open/dispatch operations after session-registry and needs no additional amendment.

## Shared decisions

Machine-wide means agents discoverable through accessible **local Herdr servers**,
including unnamed agents and facilitator sessions. It cannot promise arbitrary
processes outside Herdr or inaccessible servers. Show coverage and errors instead
of silently presenting partial results as complete. Do not connect remote sessions,
scan the entire filesystem, or launch a server to discover it.

Default to machine scope, with `--repo <path>` as a canonical-repository filter.
Identity groups represent development-root paths, not author-email groups; the CLI
does not assign identities. Show git identity only through existing git tooling.

Keep public review records in each target repository's trackable
`docs/reviews/<topic>/<head7>-r<N>.md`. Each record names the full reviewed SHA,
verdict, findings, test evidence, and limits, uses public-safe prose, and contains
no raw transcript or local paths. Historical reviews remain immutable evidence;
they do not make a newer commit reviewed or green. Private source material stays
local. The proposed review-cli writes only the validated, sanitized public projection;
it adds no review-based promotion enforcement or remote policy.

[default-config](changes/default-config/design.md) proposes the eight overridable
role profiles, engineer-equivalent shipped dispatch, built-in source provenance and
repository-or-installed template lookup. Configuration stays optional for those
defaults; agent installation/authentication and repository validation remain operator
concerns. Templates and routes cannot weaken the review protocol above.

New workspace labels include repository and root identity:
`<root-label>/<repo-name>:lane-<topic>`. Add a short identity digest when readable
labels coincide. Labels are display text; operations use opaque Herdr IDs and
verified git paths. Retain existing labels and find old workspaces by path/ID.
New labels are bounded to 64 Unicode code points, with grapheme-safe truncation and
a disambiguating identity suffix as specified in the roots-identity design.

Give mouse research one **optional, two-hour lane** after keyboard UX. Enter-to-focus
is the acceptance requirement; a negative mouse result is useful evidence and does
not hold the composer. Successful research proposes a later product change;
it does not silently add mouse support.

No automatic action retries, task queue, job record, leases, or unattended promotion.
Existing bounded shell/cwd readiness checks remain checks. Observation reconnect is
display-only, tied to the foreground board lifetime.
