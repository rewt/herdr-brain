# Running-line Minor batches

ENG-1352 Part 1 works through reviewer instructions, without changing the sealed
intake or restarting the line. Only reviews with Minors and no Major use this:

```markdown
---
run: R-N
outcome: done
summary: Reviewed the captured diff; Minors are retained for a related batch.
headline: The review passed with minor findings saved for a batch
verdict: PASS
proposals: []
---

(Keep the assigned inherited-check acknowledgments, acceptance evidence and empty
re-executed list here.)

## Batched Minors
- lib/example.mjs:42 - On this trigger, this behavior occurs; correct it this way.
```

Use one physical line per finding. Backticks around `path:line` are accepted.
Do not include severity-bearing frontmatter findings, tagged Minor bullets or
engineer proposals on these reports. The generated sealed-runtime review brief
still asks for the old format; AGENTS.md and project-review override that format
only for Minor-only reviews. Any Major retains the complete original format,
verdict, linked corrections and Major correction checks. No acceptance evidence
becomes PASS because Minors are batched.

Run the collector from landed source with pinned Node 20.19.4:

```sh
node measurement/minor-batches.mjs --org /absolute/owning/record > /durable/evidence/minors.json
```

It reads existing events and hash-verifies each review's **ingested report copy**.
It never reads the editable worker report as evidence, changes record state,
selects work, dispatches, or starts a service. JSON output retains every finding's
review/run, immutable report hash, captured base/head, body line, and stable key.
`pending` lists undisposed findings; `groups` suggests exact cited files only.
An engineer chooses related findings by the actual shared problem, without a
size target. Malformed sections, changed/missing report bytes and invalid
dispositions appear in `issues` and produce exit 1; inspect these before using
counts. `legacy_minor_only` identifies reviews with typed/tagged Minors and no
typed/tagged Major, plus PASS reviews with engineer proposals. It also exposes
correction items and fix sessions so reviews
that kept the old format remain visible. Historical reports are never rewritten.

Record a disposition with the existing `record note REVIEW_ID` entry, on the
finding's review, passing this entire single-line text as one quoted argument:

```text
minor-batch: {"schema":"brain.minor-batch/v1","finding":"batched-minor/v1:HASH","status":"batched","batch":"ENG-N","reason":"Shares the same parser correction with the other named findings","evidence":"/durable/pilot/plan.md"}
```

Statuses are `batched`, `fixed`, `stale`, and `dismissed`. Every disposition needs
a concrete reason and retained evidence. Batched/fixed also need an existing
engineer item in `batch`. All valid notes remain in `dispositions`; the latest
is current. Update a stale/dismissed finding with a later note if the premise
changes. A note is a recorded claim, not independently checked proof of its
evidence or batch cost. Inspect its evidence when choosing or reviewing work.
Unbatched findings remain pending until a related batch or concrete disposition
exists; do not silently discard them. No new event type or required capability
is involved.

## Intake after the next installed build

Part 2 accepts ordinary structured/tagged Minor findings as well as the temporary
`## Batched Minors` section. With no Major it creates one unselected linked
correction containing all new Minors, including conditional ones. Explicit
selection remains with the owning line; this change does not start related
batches automatically. A waiting new batch does not hold a fulfilled PASS's
acceptance. Selection or any recorded attempt restores the ordinary correction
discharge requirement. Negative judgments, Major checks, old selected corrections
and retained attempts keep their meaning.

Keep the temporary reviewer instructions while intake still runs in the sealed
Part 1 build. The release/soak owner may remove them after the installed-build
witness proves that ordinary Minor reports produce an unselected batch and no
fix session. No instruction removal or source landing substitutes for that witness.

For Part 1 reports already ingested by the sealed build, the owning record writer
can use the existing intake entry **after the new intake reaches its runtime**:

```sh
record ingest /absolute/owning/record/reports/R-N.md
```

Use the hash-verified immutable copy listed by the collector. An unchanged report
with its original PASS judgment and plain section gains only missing finding
links and an unselected batch; intake does not rewrite the report or judgment,
and skips findings with an existing valid manual disposition.
Repeated intake adds nothing once every finding is linked. Other historical
reports remain unchanged. This is report intake, never dispatch/launch replay.
The collector preserves the original `batched-minor/v1` keys and reports their
formal `review-finding/v1` links as batched dispositions. Existing manual
dispositions remain in sequence order. Review their evidence before selecting
work; already batched, stale or dismissed findings need no backfill merely to
change their representation. Preserve their disposition instead.

File the hand pilot as ordinary engineering through the owning record, carrying
the exact keys, report hashes, related problem, proposed check and existing fix
owners/held attempts. It gets one independent review of its diff through the
normal queue. A linked correction can skip review, so it is unsuitable for the
pilot. Do not replay held dispatches or close other findings without evidence;
existing owners handle any supersession. Keep stale/dismissed findings and their
reasons alongside actual fixes. Do not force unrelated candidates into a batch.

Part 1's immutable report format is deliberately outside formal finding links.
Existing change acceptance and project views still derive from their original
acceptance evidence; the collector is the debt inventory until ENG-1353's intake
change takes these findings in or records their disposition. Retain the exact
plain section and report identities for that owner. No UI or acceptance fold is
changed here.

The live witness must retain at least five **post-landing** Minor-only reviews
whose captured source heads include this instruction change, with no individual
fix sessions and their Minors visible in collector output. Compare the inventory
against the record, including every legacy-format review in that cohort. Review
arrival count alone, fixtures, or an empty queue do not prove it. Save dated
snapshots and each finding's current disposition, including pending ones.

Pilot cost uses the same credit-equivalent accounting as the baseline in
`.org/evidence/REVIEW-TOKENS-20261101/SLICE-MINOR-ONLY-BATCH.md` Part 1:
127 sessions, 173 findings, 1,552 credits, **8.97 credits per finding**. Record
actual pilot session cost divided by findings considered, separately reporting
fixed/stale/dismissed counts and the independent review cost. Keep the numerator,
denominator, usage source and review receipt, including any cost exclusions;
unavailable usage is UNRUN, never an estimated saving. The aim of roughly half
the baseline is a measurement, not a budget or selection gate. The owning item
remains incomplete until its live and pilot evidence is present. A finite report
hands remaining evidence collection to its recorded owner; do not leave a worker
or new timer standing by.
