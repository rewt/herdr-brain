# Lessons in the record

A lesson is a short evidence-backed claim an agent should know before working in
an area. It lives in the same `events.jsonl` as work and reports. It has an `L-n`
ID of its own because knowledge has a different lifecycle from schedulable work:
lessons do not add work items, change their status, inherit budgets or start runs.
Allocation avoids collisions with existing items using the custom `L` role prefix.

The dependency-free core validates references and selects lessons without a model,
a harness check or a filesystem search. It does not distill report learnings or
insert lessons into entry text, briefs or cold starts; those are
the next consumers of this interface.

## Write

```sh
export ORG_ACTOR=worker
record lesson add 'Keep the record core dependency-free.' \
  --scope project --path lib --module record \
  --evidence ENG-168 --evidence R-226 --evidence event:2690

record lesson activate L-1
record lesson retire L-1 --reason 'This claim no longer applies.'

# A corrected claim gets its own identity and evidence. The old lesson remains.
record lesson add 'The record core stays dependency-free; adapters may add dependencies.' \
  --path lib --evidence ENG-168
record lesson activate L-2 --supersedes L-1 --reason 'Clarify the adapter boundary.'
```

Substitute IDs from your record. `--evidence` is repeatable and required at least
once; each value must identify an existing item, run, or event sequence (`event:N`)
in that record. JSON represents evidence as `{kind: "item"|"run", id: "..."}` or
`{kind: "event", seq: N}`. Evidence is a durable link, not copied report text or
an assertion that the lesson has been reviewed. Unknown references refuse the
entire operation before any event is appended or ID is consumed.

`add` proposes by default. Text is normalized to one line and bounded to 400
Unicode code points. Scope defaults to `project`; `fleet` and `framework` name
broader applicability. All three scopes are stored and queried in the selected
record: a scope does not authorize access to, copy to, or search other records.
Optional repeatable `--path` and `--module` selectors restrict applicability.
The proposal's event `by` records who proposed it, following the ordinary
`ORG_ACTOR` convention. Every later mutation also retains actor, time and sequence.

Activating a proposed or retired lesson makes it active. Repeated activation and
unchanged retirement are idempotent. Retirement requires a nonblank reason; it
can retire a proposal before activation and can update an earlier retirement
reason. Activation clears the current retirement, while the earlier reason
remains in the log.

`activate --supersedes L-old` can be repeated to replace several older lessons.
Activation and all supersessions append together under the ordinary record lock;
any invalid reference or cycle refuses the whole operation. Each old lesson has
one replacement, and transitive as well as self-cycles are refused. Replacement
is permanent: an already superseded lesson cannot be activated, retired or given
a different replacement. Propose a new claim instead. The supersession reason
defaults to `Replaced by L-new` when `--reason` is omitted.

## Read

```sh
record lessons
record lessons --path lib/state.mjs
record lessons --module record --scope framework
record lessons --state proposed --json
record lessons --state all --json
```

`lessons` defaults to active lessons across all scopes. `--state` accepts
`proposed`, `active`, `retired`, `superseded`, or `all`. `--scope` selects one exact
scope. With no path or module query, all lessons in the selected state and scope
match, including lessons with selectors.

Paths use `/` separators and are relative to the project root, independent of
the calling directory or existing files. `./`, repeated slashes, trailing slashes
and internal `.`/`..` segments normalize deterministically. Absolute paths, parent
escapes, control characters, backslashes and wildcard syntax are refused. A path
selector matches that exact path or a descendant at a `/` boundary: `lib` matches
`lib/state.mjs`, but not `library`. `.` matches the whole project tree.

Modules match trimmed names exactly and case-sensitively. They are not inferred
from paths. With both queries present, matching either selector is sufficient.
Lessons without selectors always match. A targeted lesson with no matching
selector is excluded from a targeted query.

Ordering is deterministic: exact path or module matches first, then the longest
matching directory prefix, then lessons without selectors. Within equal match
scores, scope order is project, fleet, framework, then ascending numeric lesson
ID. Without a target query, scope and ID alone decide the order. There is no
recency heuristic, model relevance score or dependence on directory contents.

Plain text shows the first five matches with bounded applicability, evidence and
proposer summaries, plus a count of the rest. JSON returns every match in that
same order with full evidence and provenance. This keeps pasted context small
while allowing consumers to select a different bound. No matching lessons yields
`No matching lessons.` in text and `[]` in JSON.

## Events and consumer API

The fold in `lib/state.mjs` creates `state.lessons`, a map keyed by lesson ID:

| Event | Durable facts folded |
| --- | --- |
| `lesson.proposed` | Text, scope, paths, modules, evidence, proposer/time/sequence |
| `lesson.activated` | Latest activation actor/time/sequence; clears current retirement |
| `lesson.retired` | Latest retirement actor/time/sequence and reason |
| `lesson.superseded` | Replacement `by_lesson`, reason, actor/time/sequence |

`lessonState(lesson)` derives the state from these facts: supersession takes
precedence, then retirement, then activation, otherwise proposed. Events and
folded entities have no stored status/state field. `lessonsJson(state, options)`
from `lib/lessons.mjs` adds the derived `state` only to read rows; its options are
`{path, module, scope, state}`, with the same defaults as the CLI.
`renderLessons(rows)` from `lib/render.mjs` renders the bounded terminal-safe view.

The new types do not alter existing work/run events. The regression folds actual
lesson events interleaved with work and run events through the frozen
`test/fixtures/state-v0.mjs` unknown-type branch, proving the older fold retains
its work/run state and does not treat lesson IDs as work.

## Distillation

Brain builds a model-free digest of signals since the last acknowledged pass:
report learnings, recorded review notes with verdicts, failed/interrupted release
gates with their recorded details and log links, CI/validation failure notes,
refusals, retries, work rounds per item, and operator overrules. Notes use literal
markers already in the record, so they are candidates to inspect, not inferred
causes or authority to change anything. Unknown event types are ignored.
Each signal carries its exact `event:N` and, when available, run and item IDs.
Release-candidate IDs are displayed, but evidence uses the gate event because
lesson evidence accepts items, runs and events, not candidate IDs.

Groups use an explicit module or the first literal path's top directory, plus
signal kind. Paths are attached to each signal (up to four). Signal text provides
paths first; explicit item/run metadata and report artifacts are fallbacks.
Without a target the group is `record`. No file search or model assigns relevance.
Work rounds count `run.started` events on an item; they are not review rounds and
cannot themselves prove why a correction was needed.

For modern `Settle:` notes, Brain can read the named receipt in the selected
record's `settle/` directory. Enrichment requires the same recorded decision,
run, item, record identity, report hash, and verified review-text hash. It retains
the verdict, findings excerpt and source link. Missing, changed or unverifiable
receipts leave the recorded note with an explicit missing-evidence message.
The distiller must inspect originals before using an excerpt as cause evidence.

A proposed or active lesson covers the exact provenance references it cites.
Those references suppress matching signals; retired and superseded claims do not
suppress new proposals. Evidence granularity matters: `event:N` covers all signals
from that event, a run covers its signals, and an item covers its signals across
runs. Prefer precise event evidence to avoid silencing unrelated future incidents.
A shared path or module never establishes coverage. Model-free filtering cannot
recognize paraphrases from different evidence: the distill run must read existing
lessons and avoid a duplicate claim before `record lesson add`.

The supervisor runs a pass on demand, for example after a release gate completes
and before planning the next cycle. There is no installed schedule or automatic
model call. From the canonical checkout:

1. Generate a bounded digest with `node brain/bin/brain.mjs digest --org "$ORG_DIR"
   --json > /private/tmp/distill-digest.json`. Keep its pass ID and its bounds.
2. Create a normal distill work item under the learning goal, using the record
   CLI. Compose an ask containing `brain/distill.md`, the digest path and selected
   record CLI. Dispatch that item with the configured route through
   `node dispatch/dispatch.mjs ITEM --org "$ORG_DIR" --lane distill-pass
   --route engineer --brief /absolute/path/to/distill-ask.md`. This is the model
   reasoning step; Brain itself neither routes nor launches it.
3. The worker follows [the short procedure](../../brain/distill.md), compares
   existing claims, cites originals, and uses `record lesson add` to propose only.
   Its checked report lists proposed lesson IDs and the digest pass ID. Seed
   Claude-only project memories through this same path: memories are leads;
   locate their record evidence, compare already seeded lessons, and apply the
   same evidence bar rather than bulk copying private prose.
4. Review the proposals. Require one or two actionable sentences, appropriate
   scope/paths, and at least two independent signals or one confirmed gate failure
   with a cause supporting the action. Multiple references to one incident and
   two remarks in one report count once. Never activate from one remark or an
   unexplained exit code. Activate qualifying lessons via `record lesson activate
   L-n`; retire rejected proposals with a reason. Corrections/supersessions use
   the normal lesson CLI and project authority. Any resulting workflow/default
   code changes still pass the ordinary review, train and release gate.
5. When the pass has finished and every candidate is reviewed or explicitly
   declined, acknowledge its exact pending ID with `node brain/bin/brain.mjs
   digest --org "$ORG_DIR" --ack PASS_ID`. Do not acknowledge a failed run or
   unresolved evidence. New events appended during the run remain for the next
   page. Repeat while the digest says `more`; the supervisor can stop between
   pages without losing unprocessed signals. Keep Brain state consistent across
   preview and acknowledgement; a temporary `BRAIN_STATE` is a separate preview.

Activation makes lessons available to the ordinary readers. Dispatch briefs and
supervisor cold starts consume active lessons through ENG-170's integration;
distillation does not bypass those consumers or make proposals active at entry.
The cursor and latest pending digest stay in Brain's own bounded local state,
not the record or a committed digest archive. See [Brain's command and recovery
notes](../../brain/README.md).
