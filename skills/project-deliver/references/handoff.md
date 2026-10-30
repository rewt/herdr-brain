# Compact handoffs with retrievable proof

Put the result and next owner/action early; put the exact support and remaining
responsibility in the existing report fields and free-form body. Choose the
presentation that helps the next reader judge the intended outcome. The first
400 characters are a visibility target, not a parser rule or completion test.
Full reports remain available through `record show RUN` after lane cleanup.

These retrospective rewrites preserve the historical reports. Paths starting
`.org/` resolve from the owning record's parent, not a disposable source lane.
Read the original records for later decisions; these examples grant no authority
and do not claim that historical pending work is still pending today.

## Source example: ENG-1030 / R-1417

Suggested summary at that handoff:

> Watcher parsing now accepts recipient and descriptive liveness under existing
> proof guards. The line owns the single queued review; the assigned engineer
> owns any linked correction, and the release coordinator owns final/live proof.

The intent was to accept two recorded watcher shapes without granting descriptive
liveness process/absence authority. Full producer evidence is `record show R-1417`
and `.org/reports/R-1417.md`, including its original decisions and responsibilities.
The delivered artifact is:

```text
source: 5d52eb84089141cd41a165839601603de8127db6; base: 1a1636ff2c10e34ec572e43862c8c9ea4dcd579c
```

The historical producer ran the selected file once with Node v20.19.4:
`/Users/rewt/.nvm/versions/node/v20.19.4/bin/node test/helpers/run.mjs test/line-service-review-reference.test.mjs`.
Its receipt records exit 0, 66 tests/66 pass/0 fail/cancelled/skipped/todo;
this reader inherits that evidence and runs no suite. Exact supporting files:
`.org/runs/R-1417/focused-gate.json`, `focused-check.log` and `promotion.log`.
The gate retains the shared receipt key, original log, execution receipt and
timings outside the removed lane. Other suites and final-release/live acceptance
were unrun in that report. No watcher/pin/job change was claimed; its existing
watcher retained supervisor-herdr. The report hands one review to the line,
preserves engineer correction ownership, and leaves release proof with its owner.

## Planning example: ENG-1053 / R-1427

Suggested summary at that handoff:

> Prepared revision 4 and eleven slice prompts with evidence pointers.
> Supervisor-herdr owns the requested independent plan review. Acceptance
> application remains with its separately assigned owner; these files do not
> change active acceptance.

The original intent included applying acceptance. The supervisor's scope revision
at ENG-1053 note 43581 removed that effect from this run; tool support alone did
not reauthorize it. See `record show R-1427` / `.org/reports/R-1427.md` for the
decision and original queued exception, its later sent receipt and scope answer.
Application-owner identity was not supplied there; resolve it through the owning
ENG-1053 record rather than inventing a binding. The next review and application
are distinct responsibilities, and no new stage is created by this example.

No delivered source range exists: this was planning/record-only work. The plan is
`.org/evidence/BRAIN-FIX-PLAN-20261029-r4.md`, SHA256
`62bc6b444e6bfe762c79c72e009f5a005e0b88e5dec8f334226be827e36d8586`.
The full file/byte/hash inventory and eleven application inputs are retained in
`.org/evidence/ENG-1053-R-1427/delivery-manifest.json`, `prompt-manifest.json`
and `application-commands.json`. These are evidence pointers, not active commands
for this reader. Product checks were unrun under the empty planning selection;
the inventory is document evidence, not a test or independent review result.
The original r3 review and superseded wording remain linked in the full report.

## Bounded reader example

This synthetic packet is separate from both historical reports. Assess its
supported result and remaining responsibility using only the text below. Explain
any missing proof in the already assigned review; do not run the command or open
another review. The packet makes no claim about the actual repository's tests.

```text
Intent: reject malformed report envelopes while retaining lenient valid input.
Result claimed: parser refusal controls were added and the selected check confirms them.
Next: the assigned engineer owns any linked correction; the release coordinator
owns final-release/live acceptance, which is unrun.
Evidence supplied: a committed parser diff and added refusal assertions.
Selected command: node test/helpers/run.mjs test/report.test.mjs
Runtime: Node v20.19.4. No other evidence is supplied in this packet.
```

Keep the real reader's observations with the existing review's report and its
immutable target. A producer's reading of this example cannot establish the
independent reader witness. ENG-1036 consumes the examples and that same report;
no transcript fork, evaluator, extra reviewer or serial wait is required.
