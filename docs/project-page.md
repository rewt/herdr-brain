# Local project page

From the owning project checkout (including a claimed lane), run with Node 20.19.4:

```sh
node bin/project-page.mjs --stage ENG-896 --out /absolute/local/path/new-generation
```

Open `new-generation/index.html`. `project.json` contains the equivalent facts,
including completed work. The command is foreground only, dependency-free and
model-free. Each output directory must be new: no existing file, previous page or
record can be overwritten. It does not host, publish, push, acknowledge, install,
poll, restart or change work/closeout. A different project's `ORG_DIR` is refused.
The projection and compact-reader cache are disposable, never authority.

`--stage ITEM_ID` (repeatable) explicitly identifies existing stage roots for
records that have no stage markers. For this plan the recorded Stage 4 root is
ENG-896. It is a command input, not a metadata mutation. Items can also record a
stable item ID in `meta.stage_ref` (or the existing `meta.stage` when it is an item
ID). These references inherit along the parent chain. Distinct references in that
chain, invalid references, cycles or broken ancestry are **Unknown**. No reference
is **Unassigned**. Legacy numeric stages are invalid references, not guessed item
IDs. An explicit item reference can associate detached work without reparenting.
No stages are inferred from titles, item numbers, lane names or prose.

The page reuses the record's `statusMap`, `releases`, `todayJson` (all waiting
questions, including parked ones) and messages digest derivation. The existing
owner-published summary combines native retirement inventory, promotion jobs,
releases and an independent publication cutoff; those observations are outside
this record-only slice. Recorded owners/agents/controllers appear with their
actual meaning; absent owners/actions and native liveness stay unknown. Explicit
`meta.next_action` on an item or its latest run supplies the next action. Ancestor
`meta.hold` and recorded dependency/review blockers remain separate from status.

Source landings require recorded `change.landed` facts for this Git identity and
run/item. Reports require ingestion facts. Independent reviews and formal
corrections use their recorded source bindings; a derived done status alone does
not claim accepted completion. Completed producers remain in open work while a
review/correction is pending. All completed facts remain in JSON.

Each reader is closed. Only selected current fields, the latest why/plan notes
needed by the existing question impact semantics, latest landing/review facts
and five digest envelopes are retained. The event archive is streamed once; it
is never collected. Full report prose, acceptance histories, logs, prompts and
arbitrary private payloads are excluded. Display text has bounded fields,
terminal sanitation, credential redaction and HTML escaping. There is no script,
remote resource or executable content in the page.

Record facts share one captured reader position/digest/sequence. Append,
replacement, deletion or rewrite during generation produces a stale/unavailable
page with null work and questions, never an empty success. A torn record tail is
explicitly incomplete. Configuration and delivery journal have their own captured
file signatures; missing/unavailable/stale auxiliary observations are labeled.
Changed delivery observations become unknown; no delivery state is invented.
Question IDs, recorded answers and delivery states are copied without changes.
Only explicitly reserved questions are labeled reserved; explicit delegation is
labeled delegated; absent authority is unknown. Record locators and `record show
ID` retrieve the authoritative detail.

This is a static snapshot. Its generated time, record cutoff, digest and
five-minute age policy are visible. Regenerate on demand to establish current
facts; an old page does not notice later record changes while idle. No consumer
may use it as mutation authority. Cross-project indexes, live monitoring and
release/activation coverage are separate work.
