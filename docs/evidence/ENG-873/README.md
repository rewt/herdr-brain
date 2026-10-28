# Closeout measurement correction

This is ENG-873 / R-1215, the one formal correction of REV-184 / R-1208.
The original FAIL and ENG-864 / R-1204 evidence remain authoritative historical
inputs. Later findings fix forward; this correction starts no review chain.

The selected focused command is
`node test/helpers/run.mjs test/closeout-measurement.test.mjs`, through the
existing lane check on pinned Node 20.19.4. Actual source/runner/TAP/landing
receipts and per-Major results belong to `.org/runs/R-1215/report.md` and
`.org/evidence/ENG-873/R-1215/`. No full release or live acceptance is implied.

## Installed evidence

`lib/product-files.mjs` now includes the three exact historical inventory JSON
assets under `docs/evidence/ENG-864/`. The default loader therefore supplies all
three named histories in copied/installed payloads. ENG-866's missing-file
fallback remains: old or incomplete payloads still report the live census with
explicit missing historical scopes. Malformed or redirected files still throw.
The original packaging failure and ENG-866's failed assertion/corrected result
are retained separately from the installed-payload control added here.

## Allocation joins

The denominator remains every terminal report, abandonment and failed dispatch.
The terminal event supplies the immutable age/availability identity. Receipt
lookup follows recorded `closeout_targets` for the same run, Git project,
record, cwd and (when present) allocation start/claim. Each evaluation/effect
must match the bound source and allocation key. References additionally match
that evaluation's own source/key and precede it. Late `cleanup.bound`,
`item.closed`, `review.verdict` and `promotion.reconciled` obligations can thus
prove the terminal allocation without borrowing a different allocation's proof.
The earliest evaluation remains the immutable first-turn accounting result.

## Declared observation window

`recordCloseoutTurn` reads an optional, owner-declared
`closeout-measurement-window.json` in `measurementDirectory(org, identity)`.
It also accepts the identical `window` object as an explicit argument. Example:

```json
{"id":"accepted-candidate-pilot","after_seq":12345,"activated_at":"2026-10-29T00:00:00Z","commit":"FULL_CANDIDATE_COMMIT"}
```

The owner must supply the actual candidate commit, record cutoff and activation
clock; the observer never creates or silently advances this declaration. No
service, watcher, runtime, trust pin or saved job is changed by this module.
A declaration mismatch, event gap, reversed record, source change or cadence gap
fails the sample. Changing a declaration is visible as a reset in the next
sample. Sustained continuity still requires the coordinator's complete journal.
A declared record prefix must begin at or before the first post-cutoff event;
its actual first sequence is retained. Missing run/binding facts stay UNKNOWN.

`window` reports post-cutoff metrics and project/harness/dispatch slices.
`legacy` retains pre-cutoff membership and summary. `aggregate` and top-level
`slices` always include the complete supplied terminal cohort, including legacy
resources. `historical`, `historical_failures` and `historical_green` retain the
three archived evidence scopes and any missing membership. Claude's incomplete
research cannot permanently poison a new runtime window. It remains an
unresolved historical gate. Without a declared window, the previous conservative
all-record/history verdict remains in effect.

`window.green` is the post-cutoff sample metric. Top-level `green` additionally
requires the all-record absolute open-over-two-hours, clean-retained and orphan
counts to be zero. Thus legacy retained resources can coexist with a passing
window metric but cannot disappear from the absolute gate. Historical/manual
failures remain visible in their original scopes. Neither green field certifies
release, recovery of historical allocations, safety acceptance or a sustained
72-hour/100-closeout proof. The release coordinator retains those obligations.

## Bounded immutable audit

The JSONL census and latest projection use `closeout-measurement/v2`. Each frame
is at most 256 KiB. Cohort chunks of 128 full rows, membership manifests, raw
inventory, exclusions and historical memberships/rows are stored as immutable
SHA256-addressed objects in `closeout-objects/`. Existing bytes are verified and
never replaced. Unchanged rows/effects/inventory are reused across turns. Only
derived row ages are omitted from objects and reconstructed from the original
clock and frame observation time; original receipt/hold evidence stays intact.
Oversize summary projections are themselves referenced. No history is rotated
away and no torn audit or record tail is rewritten.

Use the exported `readCloseoutMeasurement(file)` to resolve and verify a latest
projection (also accepts old v1 documents). For an archived frame, retain its
relative object directory and follow the same hash references. Raw frame fields
remain inspectable without expanding the census. Diagnostic entries continue
on the existing `passes.jsonl` path; they contain aggregate counts and at most
ten scoped oldest exceptions. One indexed fold is shared by the cohort,
inventory collector and oracle per turn, rather than folding/scanning all events
for each row. A focused control uses exactly 30,000 events / 3,000 allocations,
two unchanged turns, a 10,000 ms first-turn bound and the 256 KiB frame bound.

The four Minor corrections guard missing pane IDs, cross-check retained/deleted
branch receipts with live refs/head, distinguish vanished PIDs from incomplete
process identities, and resolve source Git lazily in the turn rather than at
module import. No effect, signal, cleanup retry or new service is introduced.
