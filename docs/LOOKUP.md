# Retrieve decisions and confirmed mistakes

Run `record lookup "words" --json` in the owning record. This read-only command
rebuilds a small text/relationship projection on each invocation from notes,
report decisions/challenges/learnings and lessons. It uses the existing compact
record reader, stores no additional index, and never reads another record or
follows external evidence paths. It performs no inference or model call.

Examples for a fresh Codex or Claude session in Brain:

```
record lookup "automatic blocked-work" --kind decision --item ENG-936 --json
record lookup "fleet isolation" --kind mistake --json
record lookup "shards" --item ENG-1040 --json
record show R-216 --compact
```

Read the returned source, rather than taking a search hit as permission. Notes
use `event:SEQ`, reports use `event:SEQ/decisions/0` (zero-based entry index;
also `challenges` and `learnings`), and lessons retain their `L-n` identity.
Each hit includes original author/time/sequence; report hits also identify the
archived report file and its recorded hash. `record show ITEM|RUN` provides the
original record and report. `record log --json` can locate an exact event.
Hashes identify the parsed event prefix serialized as JSON lines, not raw
on-disk bytes or an independent verification of the report archive.

`--at SEQ` rebuilds an exact historical prefix; save its cutoff and
`source_sha256` with evidence to reproduce it after new events arrive. An absent
sequence is an error. The output identifies a torn tail when one is observed.
All query words must occur literally, case-insensitively, in a hit's text or
metadata. `--item ID` selects owning-item hits or explicitly cited item evidence;
`--kind` selects decision, mistake, challenge, lesson, learning or note.
Results sort newest source sequence first, with stable reference tie-breaking;
`--limit 1..100` bounds results and `total` reveals truncation. Lookup indexes
ordinary notes as notes, without guessing that their words authorize a decision.

## Explicit relationships in the original record

Existing unannotated records remain searchable. A challenge or red test is never
classified as a confirmed mistake on its own. To make a verified failure
retrievable as one, the owning author records the relationship on an existing
decision-note path, using a final single JSON line:

```
record note ENG-1040 'Confirmed in-process fleet isolation mistake; see the original report.
[lookup] {"confirmed_mistake":true,"premise":"Child HOME isolates the parent entry call","failure_evidence":["R-216","event:2746"],"correction":"Set HERDR_MONITOR_FLEET in the caller","scope":"test fixtures using in-process entry","evidence":["ENG-161"]}' --decision
```

This is an annotation in the authoritative note, not a second memory store.
Use real references from the owning record. A report decision or challenge can
carry the same object under `lookup`; the report parser preserves it under
`extra.decisions` or `extra.challenges`. The original source author must have
confirmed the premise failure. The lookup requires explicit confirmation,
premise, correction, scope and present failure references; it checks reference
existence, **not causal truth or proof quality**. Lessons and report learnings
retain their own kinds. Do not label every challenge, failed check, guess or
already-red main as a confirmed mistake.

Reference status is `present` for a local item/run/lesson, exact event or indexed
entry, `missing` for an absent local reference, and `external-unverified` for
other strings, including file paths. Nothing dereferences another repo or silently
certifies external files. Missing/incomplete annotations have explicit diagnostics;
absence of evidence is reported rather than filled with a plausible story.

A later source can add `"supersedes":["event:123/decisions/0"]` (or a note event
or lesson ID), citing its invalidated conclusion and giving the correction and
scope. Only earlier source events can be superseded, preventing annotation
cycles. Lesson activation/supersession/retirement uses its existing native events.
By default, a query matching a superseded row follows its replacement chain and
returns current conclusions, naming `matched_sources` and `supersedes` so the
old evidence remains reachable. It never presents a superseded conclusion as
current. A missing replacement is listed in `unresolved`; proposed and retired
lessons do not become current. `--all-states` inspects the retained history.
Unannotated prose withdrawals cannot be inferred safely: add a source relationship
when that distinction matters, rather than trusting recency or a keyword guess.

## Harness skills and project responsibility

Harness-local memory is a convenience for that harness and context. Skills are
reusable procedures, such as how to choose a focused check or preserve a native
refusal. This lookup serves a different responsibility: the project's decisions,
failed premises, original evidence and invalidations must be retrievable from
either harness through the same owning record. Keep project facts and authority
in that record; local memory or a skill may point to it but cannot supersede it.
This is an allocation of responsibility, not a claim about a provider's current
memory feature set.

ENG-936/R-1258 and `line-service/DECISIONS.md` supply the existing coordination
contract: no new automatic decision item, judge, backlog-distillation loop or
agent relay. Lookup grants no authority, selects no work, and changes no watchers,
saved attempts or release gates. ENG-1040's withdrawal of cross-record shards
keeps this slice per-record. No embeddings or general graph are needed.

The changed-focused control is `node test/helpers/run.mjs test/lookup.test.mjs`.
It plants bounded excerpts of the real ENG-936, fleet-isolation and withdrawn
shard examples in a scratch record, retrieves them through fresh CLI processes,
follows an original report, rejects ordinary challenges as mistakes, and tests
cutoff rebuilds, supersession chains and absent evidence. CLI processes are
mechanical controls, not independent model judgments or live-release acceptance.
