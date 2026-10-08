---
run: R-328
outcome: done
summary: |
  Added max_batch to the canonical committed .promote.json settings. New queue batches stop at that positive integer, leave the tail pending in arrival order, and retain the unbounded default when omitted.
  Documented the setting beside the gate profile and added tests for batches of three then two, the unbounded default, invalid values, and canonical configuration authority. All 38 tests in the touched train test file passed through the offline runner.
  Implementation is committed as 0b564653. This checked report is committed next, followed by a final lane check scoped to the four new cap tests.
headline: Merge queue batches now support a project size cap
blockers: []
proposals: []
learnings:
  - Run the train test file through test/helpers/run.mjs; its fixture-policy preload supplies the simulated memory measurements required by the existing memory-wait test.
artifacts:
  - 'Implementation commit: 0b564653'
  - 'Branch: lane/batch-cap'
  - promote/promote.mjs
  - promote/README.md
  - promote/test/train.test.mjs
  - 'Validation: node test/helpers/run.mjs promote/test/train.test.mjs (38 passed, zero failed, 155.840 seconds)'
  - docs/reports/ENG-277-batch-cap-R-328.md
  - /Users/rewt/development/rewt/.org/runs/R-328/report.md
  - '.lane/gate.json (final lane check receipt)'
decisions:
  - text: Read queue settings from the canonical committed .promote.json and apply max_batch only when dequeuing a new batch.
    category: design
    why: Project policy must not come from untracked overrides or lane copies; retaining captured batch membership preserves interruption recovery and avoids changes to train validation or bisection.
questions: []
challenges: []
---

The cap is a positive safe integer; zero, negative numbers, fractions, strings,
null, booleans, arrays, objects and integers beyond JavaScript's exact range
are refused with `promote max_batch must be a positive integer`. Validation
happens before CLI enqueue and before dequeue, preserving pending requests and
releasing locks on refusal. Omitting the field keeps the current unbounded behavior.

The five-lane tests use deliberately nonalphabetical arrival order and inspect
the queue while the first batch's notice is waiting. With a cap of three, the
last two requests are still pending and absent from main. After delivery clears,
they form the next batch; both gates land their captured lanes in arrival order.
The unconfigured case uses one batch and one gate for all five lanes. Linked
worktree invocations use the canonical declaration. Compatibility boundaries
still apply; existing and interrupted batches retain their captured membership.

The change is local to queue settings and batch formation in promote/promote.mjs;
promote/train.mjs is untouched, minimizing overlap with the gate-watchdog lane.
An initial direct `node --test promote/test/train.test.mjs` run passed 37 of 38
tests but omitted the repository fixture preload and timed out in the existing
memory-wait test. The complete file then passed 38 of 38 through the repository
runner, including that test and the interruption, bisection and guard regressions.

Only the touched promote test file ran. Offline fixtures use their private slot
identities. No host test slot, promotion/release tier, live acceptance harness or
housekeeping loop ran. The final lane check uses the fast tier with an explicit
command selecting the four new cap tests in the same file:

```sh
node lanes/lane.mjs check --cmd "node test/helpers/run.mjs --test-name-pattern='^(five pending lanes|invalid committed max_batch|batch policy ignores)' promote/test/train.test.mjs"
```
