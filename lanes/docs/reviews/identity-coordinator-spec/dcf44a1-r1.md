**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: dcf44a160e05f01a2d4b8a65fa3beff06ff62863
Topic: identity-coordinator-spec
Round: 1
Review ID: lr-55aeb84ca15eb960c53af55822cfd45e
Base branch: main
Base commit: 8d80ffae74aa05c4135bc159995e177f3ba2dcc1

## Findings
- [Moderate] openspec/changes/identity-coordinator/specs/identity-coordination/spec.md:42 - The stale-handoff scenario requires an acknowledged successor even when the current owner remains available and authorized and only the saved HEAD, gate, or plan is obsolete. That contradicts the design's evidence reconciliation and resumption rule and forces unnecessary ownership transfers and context reloads; Fix: separate unavailable-owner transfer from stale-evidence recovery, allowing the unchanged authorized owner to reconcile primary evidence and continue the unfinished step without renewed delegation.
- [Moderate] openspec/changes/identity-coordinator/briefs/coordination-details.md:20 - Neither brief owns the complete interactive source-selection path. The read-model specifies the coordination flag for JSON and watch while excluding the app; the UI brief excludes the CLI launcher and shared argument/client modules. The inspected launcher forwards only the repository and the client constructs its own watch arguments, so rendering the new fields alone leaves the console permanently without a selected coordination source; Fix: assign explicit interactive flag parsing and source forwarding through the launcher, app, and observation client to the appropriate briefs, including reconnect preservation and a process-boundary acceptance fixture.
- [Moderate] openspec/changes/identity-coordinator/design.md:155 - The new JSON input is called bounded solely by reference to board-sampling, whose inspected design bounds refresh cadence and child concurrency but supplies no JSON byte, collection, or text limits. An oversized snapshot or a path that is not a regular file has no specified rejection boundary, despite the promise of responsive localized observation; Fix: define the snapshot's finite input and read limits, permitted file kind, field types and nullability, and localized malformed or oversized-input behavior, and make these part of the read-model acceptance cases.
- [Moderate] openspec/changes/identity-coordinator/design.md:156 - Board-sampling makes observations stale after missed reads; that does not determine whether a successfully reread manual snapshot or its latest report is obsolete. The proposed recorded\_at fields have no validity or age rule, although the observation scenario requires stale reports to become unavailable. An old file can therefore remain current indefinitely, while applying the sampling interval to report age would demand updates during otherwise valid quiet work; Fix: distinguish observation freshness from snapshot and report validity, specify deterministic timestamp and stale-state rules compatible with checkpoint-only reports, and cover both readable obsolete content and unchanged valid content.
- [Moderate] openspec/changes/identity-coordinator/briefs/coordination-details.md:12 - The UI is instructed to show an accepted milestone, but the source supplies only milestone and an explicitly unverified latest\_delta pointer. The manual assignment defines its milestone as the next milestone, so a planned or merely reported result can be displayed as accepted without acceptance evidence; Fix: label this field as the planned or reported milestone with explicit provenance and unknown acceptance, or specify an evidence-backed acceptance field before requiring an accepted label.
- [Minor] openspec/changes/identity-coordinator/briefs/coordination-details.md:21 - The conditional sync instruction permits the observation delta to have been synced by the earlier CLI lane, although that same delta includes the later console-only Separate coordination attention requirement. The briefs do not partition the requirement blocks, leaving unfinished UI behavior eligible to appear in the current capability; Fix: assign the projection and bounded-read blocks to the CLI sync and the Separate coordination attention block to the UI sync, with each block becoming current only alongside its implementation.

## Re-executed
```json
[]
```

## Non-claims
- The captured npm test gate with exit code zero is inherited evidence only and was not re-executed.
- This review does not adopt the protocol, select pilot projects, authorize lifecycle work, or assert measured token or monetary savings.
- The inventory and frame audit concerns the named historical commits only and does not establish their promotion or current runtime correctness.

## Unverified
- No build, test, prepare, install, check, OpenSpec validation, negative-control, or mutation command was run because the explicit review budget is zero.
- Live acknowledgements and report delivery, pilot accounting and budget observability, console execution, and minimum-version or alternate-host behavior were not exercised in this documentation review.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
