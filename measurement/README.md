# Recorded live witnesses

`record witness evaluate` evaluates machine-readable specs in item notes. The
existing finite line pass calls it after writing `pass-complete` when specs are
pending. No new service, watcher or loop is installed. A direct invocation uses
the same finite command; `--item ENG-n` bounds selection and `--dry-run` omits
result writes. Use the project's source entry and pinned Node.

The command reads the owning record and its existing `passes.jsonl` (including
rotated segments). It writes only ordinary, non-decision item notes through the
record's mutation guard. Results cannot close, select, clear HOLD, activate or
release anything. STOP/HOLD and project-record binding still fence writes.

An item's owner registers an explicit observation with the existing `record note`
command. Its text begins exactly `Live witness spec: ` followed by one JSON object:

```json
{
  "schema": "brain.live-witness/v1",
  "id": "reopen-window-1",
  "kind": "start-within-pass",
  "project": "/absolute/project/.git",
  "owner": "existing-witness-owner",
  "next": "consume the result in the existing owning item",
  "from": "2026-10-31T16:20:00Z",
  "cutoff": "2026-10-31T18:35:00Z",
  "subject": "ENG-1248",
  "trigger": {"type": "item.reopened", "after_seq": 0}
}
```

Specs express recorded acceptance; registration grants no authority and never
causes a trigger. The last spec note for an ID is current. A new note explicitly
starts a new observation; previous results remain in history. Owners must choose
the subject, trigger fence and UTC window from their acceptance/evidence, rather
than choosing a successful window after inspecting the result.

Supported observations:

| Kind | Observation and target |
| --- | --- |
| `start-within-pass` | First matching subject event (`item.reopened`, `item.added` or `item.updated`) after `trigger.after_seq`, inside the window. The first PID-bound queue snapshot after it defines the next scheduling pass. No start by that completed pass is NOT MET. MET requires a project line `run.started`, matching pass admission and committed native session. A preceding incomplete queue pass stays UNRUN. |
| `start-within-pass` with `required_class` | Also checks the subject's recorded queue class and that no lower-class admission precedes it in that pass's recorded policy order. Missing class evidence is UNRUN. The check does not infer available capacity, eligibility, priority exceptions or why a subject was stale. |
| `same-revision-skips` | Consecutive completed passes with PID-bound starts on the same recorded revision, both started in the window. At least one warm pass must have `admission_skipped > 0` and `source_skipped > 0`. Known zero counts at cutoff are NOT MET; no pair or unknown counts are UNRUN. |
| `folder-median` | `under_ms` is the strict median target. Reuses the lifecycle reader's whole report cohort and report/claim/effect/receipt joins. The window must finish, the cohort must be nonempty and every latency must be known. Pending folders and missing observations remain UNRUN; they are never dropped to improve a median. |
| `unavailable` | Required `reason` explains why the current readers cannot express the witness. Always UNRUN. This is coverage accounting, not a successful observation. |

Result notes start `Live witness result: ` and retain the spec hash, status,
reason, evidence/window/record fences, source hashes, owner/next event,
condition time and recording delay (null when unknown). Reader errors produce
nonterminal UNRUN notes without repairing or editing the source. Malformed record
tails refuse all result writes. Unchanged observations deduplicate; a terminal
window is not replayed. A first missed pass cannot be erased by a later start.

An absent trigger, empty sample or unknown input is never MET. Free-text
supervisor verdicts are not inputs to the observation logic. Source hashes
identify the selected evidence; they grant no native authority or complete
manual-intervention coverage. Use the nudge journal for recorded nudges, with its
existing unknown-total qualification. The first three automated results require
one comparison against raw journals, recorded as producer evidence; further
supervisor reading is not required by the check.

For the 31 October coverage set: ENG-1250 maps to the reopen observation,
ENG-1277 to its class variant, ENG-1201 to same-revision skips, and ENG-1221(a)
to the full-cohort median. ENG-1241 requires more than closeout counters: a
durable HOLD interval, unchanged-main evidence and native/folder release in the
same finite turn. The currently listed readers do not join that complete proof;
record it as `unavailable` rather than copying the supervisor's PASS note. The
existing witness/runtime owners retain that missing evidence and all acceptance,
Major-correction, review and release decisions.
