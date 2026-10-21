# Execution provenance missing from the declared-gates contract

R-706 stopped implementation under the ask's instruction: if the approved
contract is wrong or incomplete, stop and report the gap. The contract's
authority review remains PASS; this finding does not amend its requirements.

## Missing binding

[The contract](../../../contracts/DECLARED-GATES.md#execution-identity-and-authority)
requires admission to verify the supervisor/worker's **existing launch
authorization**, bind the **actual enqueuing identity**, and recheck it at
dequeue, resume and integration. It says to reuse the native launch and
project/session authorization binding. It explicitly rules out identity names
in environment variables, display metadata, actors, basenames and a shared UID
as sufficient evidence, and requires a hold when provenance is absent.

The current sources supply separate facts, but not that execution binding:

| Existing source | What it establishes | Missing fact |
| --- | --- | --- |
| `lib/project.mjs:10`, `messages/journal.mjs:8` | Canonical Git common directory and its marked owning directory | Which native identity is executing the caller |
| `promote/native-context.mjs:9` | PTY, loopback and process-inventory capabilities | Owner identity or launch authorization |
| `promote/native-context.mjs:38` | Worker PID, kernel birth and command | An authorized owner launch connecting that worker to a native identity |
| `sessions/authorization.mjs:16,67,84` | Scoped human decision for enumerated workspace lifecycle actions | Authorization of the invoking enqueue/drain process; no gate action is in this closed action list |
| `sessions/live.mjs:236` | Native session ID, UID/generation, spec, route and instructions digest | Caller or detached worker process continuity and its actual identity root |
| `lib/run-owner.mjs:20`, `lib/run-owner-guard.mjs` | Record controller, immutable release and run generation | The native execution identity of the current process |

The current enqueue writes the queue after validating job fields and optional
record ownership (`promote/promote.mjs:136-176`); it accepts no native launch
authorization. `queueFor` already creates a directory at line 45. The detached
worker launch at lines 740-750 copies the caller's environment, drops pane/tab/
workspace identifiers and changes cwd. Its worker evidence is recorded by the
worker itself at lines 547-565. Resume checks native capabilities and saved Git
identity at lines 804-822. Neither changing cwd nor recording a worker's own
process birth establishes the required owner launch provenance.

This is an implementation dependency, not a demonstrated escape from a native
sandbox. Existing readers reject the new schema, so no adopted gate has been
activated. The archived fixture below exercises legacy enqueue only, without
launching a worker, planner, gate, model, network request or Herdr operation.

## Why implementation stopped

Finding the target identity directory is possible. Establishing the caller's
actual native identity and its authorized detached-worker continuation is the
missing part. Treating a marker, caller-selected config, environment identity,
record claim, or self-written receipt as that proof would silently weaken the
approved contract. Making every adopting project refuse forever would fail the
required owner-execution positive cases.

The parallel config-home contract was inspected read-only. Its identity and
adoption sections repeat the owner-execution requirement and bind observed
supervisor sessions for KEEP. It expressly distinguishes adoption from a native
launch/context receipt. It does not define an enqueue-to-detached-worker native
execution binding. This lane made no edits in that checkout.

## Required contract clarification

An authority-reviewed amendment must name the source of caller execution
provenance, its trusted writer and verification seam, and the binding retained
through enqueue, detached worker launch, dequeue, resume and integration. It
must explain how an owning supervisor is distinguished from a broader or
foreign caller even when both can read the same project/config, and how missing,
changed or ambiguous evidence holds before side effects. Coordinate the seam
with ENG-514's native launch/adoption work; do not create a competing config
loader, credential service, identity switch or permission wrapper.

Any extension of the existing closed session authorization/context formats
needs explicit scope and compatibility rules. The item's cap is two reviews;
review one approved the contract. The supervisor must disposition the amendment
review and remaining implementation review before work resumes.

## Reproducible diagnostic evidence

`identity-gap.test.mjs` is an archived witness of the current starting point,
outside the product suite inventory. It verifies that the legacy enqueue API
persists a job with no supplied native execution provenance, even with different
scratch marker roots, and that the current validation reader refuses the new
schema. Scratch markers are not native identity credentials; the fixture makes
no claim to authenticate a foreign harness.

Final selection, run once on the clean committed documentation/evidence
candidate with Node 20.19.4 first in PATH:

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 docs/evidence/ARCH-38/R-706/identity-gap.test.mjs
```

The lane check's `.lane/gate.json` and shared lane-validation receipt retain the
result. This selection diagnoses the gap; green diagnostic results do not prove
mixed-runner implementation acceptance. No production code or existing test
file was changed. The ask's implementation acceptance remains unexecuted pending
the contract clarification.
