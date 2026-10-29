# Decision churn and bounded overnight answers — 2026-10-28

R-1258, owning worker lane-decision-chur-c7a295-bce45a, implements the operator's
ENG-936 authorization to remove decision/backlog machinery when it adds churn.
The linked Claude plan was inaccessible through the browser tool; the full item
record and run brief supply the authoritative scope.

## Frozen record measurement

`before.json` measures the event prefix through sequence 34341, timestamp
2026-10-29T01:54:06.473Z (October 28 locally), and hashes that exact prefix.
Reproduce with pinned Node 20.19.4:

```
node docs/reports/ENG-936/measure.mjs /absolute/project/.org 34341
```

| Cohort | Items | Interpretation |
| --- | ---: | --- |
| Fixed missing-producer/refusal decisions | 321 | 274 closeout, 25 review, 19 dispatch, 3 source-completion |
| Typed blocked-work requests | 5 | Two applied reshapes, three stale answers |
| Owner-selected decision | 1 | Deliberate bounded question, not a fixed-rule product |
| All decision items | 327 | 18 started runs, 17 reports; 14 done, 235 dropped, 77 ready, 1 active |
| Backlog judge batches | 15 | 15 started runs; 13 done, 2 active |

The ask's earlier 318/324 and 16-run facts remain an earlier cohort. The
fixed-rule share here is 321/327 = 98.2%. The typed consequence ledger has one
recorded restart whose final success is unknown. A done diagnostic report
cannot stand in for the missing producer it describes. Backlog records are finite
owner-created batches, not a recurring source program. Their existing results
remain with their owner; new batches are no prerequisite for selected engineering.

Decision: this volume adds item and session churn without measured evidence
that automatic judging resolves those mechanical defects. Stop new automatic
judgment production, use the actual defect/receipt owner, and retain bounded
technical questions. This does not imply every prior answer was useless. No
causal latency, token/cost saving or judge-accuracy estimate is available.
Diagnostic closure counts are not original-subject resolution rates.

The landing removes blocked-work candidate creation, review/dispatch exception
creation, and fresh review/dispatch/backlog judge admission. Existing captured
typed decisions and saved original continuations remain consumable. Exact
source/native/claim/CAS/STOP/HOLD checks still guard effects. No old item,
history, receipt or attempt is deleted or administratively cleared.

The simultaneous ENG-931 proof forbids landing closeout, retirement/cleanup and
measurement changes. The 274 closeout and three source-completion cases therefore
remain unchanged in the landed scope. Their removal is deferred and is never
counted as accomplished by this landing.

## Dated frontier example and local adaptation

[Edwards and Schuster, *Ask or Assume?*](https://arxiv.org/html/2603.26233v3),
submitted March 27, 2026 and revised September 7, evaluates coding agents asking
a second model for missing requirements. The answerer receives the original
issue and is constrained to that context. This is research simulation, not proof
of reliable overnight production delegation. The simulator required environment
guardrails; simulated users have acknowledged limitations. We adapt only its
bounded answer packet, not its extra per-turn intent monitor or interaction
limit as implied consent.

[Anthropic, October 22, 2026](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop)
describes folding routing/planning into an owning loop, retaining separate agents
where isolation or verification warrants them. Our inference is to use the
existing project supervisor as answerer, with no new judge per mechanical error.
This is a local adaptation, not that article's claim about overnight success.

The packet/reply lives in the existing item and native inbox, per
line-service/DECISIONS.md and supervisor/roles/worker.md. The answerer uses full
recorded intent, scope, evidence and explicit delegation; it does not possess
hidden operator preferences. Execution stays with the actual owner. Reserved
decisions stay operator-only. A model reply creates no human answer or permission
to override a harness refusal.

Worked contract examples (author analysis, not independent model trials):

| Question | Bounded answer | Boundary |
| --- | --- | --- |
| Which development check? | Name the affected check and focused-check authority. | No full-release or skipped-control PASS. |
| Which local implementation? | Decide within selected acceptance and delegated T0/T2 scope; record why. | No new product commitment. |
| Start another worker for a missing receipt? | The original owner reconciles the captured attempt. | Retain UNKNOWN/refusal. |
| Publish, fund or weaken permissions? | An actual reserved decision is needed. | Existing once-only operator path. |
| What does an absent requirement mean? | Unknown; identify the fact and hold only its dependent action. | No invented intent, timeout consent or recursive judge. |

Future reports can count actual delegated answers, wrong answers, reserved
escalations and completed original work. Missing observations remain unknown.
This creates no scheduler, audit, status ledger or review stage. The single
normal async source review consumes producer evidence; live release/adoption
remains with its existing owner.
