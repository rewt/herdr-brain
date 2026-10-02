---
run: R-111
outcome: done
summary: |
  Bisected the two real discovery failures to the commit that added macOS validation lifetime identity.
  The release harness replaced the product validation profile and lost its readiness descriptor;
  both defects prevented otherwise valid work and approved routes from reaching main.
  Fixed the acceptance transport, added an offline native regression and verified confinement.
  The rebuilt lane candidate passes all 26 release cases, including both real discovery cases; offline suites pass.
  Implementation, evidence and this report are committed on the lane; the final lane check follows the report commit.
headline: Real discovery promotion works again with the validator lifetime identity preserved
blockers: []
proposals: []
learnings:
  - The first bad commit is Deny unknown validation syscalls and contain detached descendants; its parent and v0.1.4 pass both real discovery cases on Luna at low effort.
  - Native product validation passes outside the release harness. The acceptance transport discarded the selected product profile, including the lifetime denial, and denied the positive probe too.
  - Preserving probe permissions alone is insufficient; the transparent Node transport must also forward descriptor 3 so the validation owner receives its readiness receipt.
artifacts:
  - "Commit: Preserve validation lifetime identity in acceptance transport (2bdc839)"
  - "Commit: Report discovery regression repair for run R-111"
  - "Branch: lane/discovery-regression"
  - "acceptance/validation.mjs; acceptance/native-transport.mjs; acceptance/security.mjs; acceptance/live.mjs; acceptance/test/validation.test.mjs; acceptance/README.md"
  - "docs/reports/evidence/ENG-97-discovery-regression: summary.json and screen.txt per tested candidate"
  - "Git bisect commands and result: /private/tmp/eng97-bisect.log; scratch bare repository /private/tmp/eng97-bisect-repo"
  - "Full offline baseline and post-change npm test: 682 passed, 11 skipped, zero failed; /private/tmp/eng97-baseline-tests.log and /private/tmp/eng97-after-tests.log"
  - "Offline acceptance suite: 62 passed, zero failed; /private/tmp/eng97-acceptance-final.log"
  - "Native transport regression: three passed, zero skipped; /private/tmp/eng97-validation-final.log"
  - "Original transport and lost-descriptor negative controls: /private/tmp/eng97-old-transport-regression.log and /private/tmp/eng97-lost-fd-regression.log"
  - "Direct product native sandbox baseline: /private/tmp/eng97-native-sandbox-before.log"
  - "Full lane candidate gate: 26 passed, zero failed, zero pending in 376 seconds; /private/tmp/herdr-acceptance-EUrCTT/evidence; /private/tmp/eng97-candidate-gate.log"
  - "record check docs/reports/ENG-97-discovery-regression-20261002.md"
  - "Final command: node lanes/lane.mjs check; .lane/gate.json binds the final committed implementation, evidence and report to its validation result."
decisions:
  - text: Compose the fixed product validation exclusions with the stricter acceptance boundary and narrowly admit the positive inert lifetime probe.
    category: security
    why: Discarding the product profile erased its kernel identity. Verified private resource paths, ownership, file modes and denied-probe rules preserve that identity without exposing probe directories or foreign data; Git, shared-state and network denials remain enforced.
  - text: Forward descriptor 3 only for the verified lifetime bootstrap protocol.
    category: tooling
    why: The native owner must receive the actual readiness pipe. Forwarding only standard IO prevented receipt delivery even when project tests passed.
  - text: Use the default Luna low route and run the two real cases plus their required snapshot, Herdr fixture and cleanup for the bisect.
    category: prover
    why: The scoped scratch harness isolates the requested boundary cheaply; the final candidate separately runs every acceptance case.
questions: []
challenges:
  - "The release screen classified the discovery failures as product failures, but the adjacent-commit tests and original-transport negative control establish a harness incompatibility with the new lifetime protocol. The fix changes the acceptance transport; it does not weaken the product validator or lane promotion checks."
  - "The initial restricted-shell npm test refused ps with EPERM before testing. The authorized host-access baseline and post-change runs passed, and all native regression calls used real kernel confinement with no model or authentication."
---

The first bad commit is **Deny unknown validation syscalls and contain detached descendants**
(`2d22bb9`). It introduces the immutable allowed/denied probes and native readiness
receipt used to identify and reap validation descendants. Its parent is **Report
Claude discovery review fixes and pending live proof** (`5873f07`).

The original `acceptance/native-transport.mjs` removed the product's selected
`monitor-validation` profile and selected `acceptance` instead. The original
profile's denied marker therefore became unused, while the gate's root/tmp
read restriction denied the positive marker as well. The native bootstrap could
not observe its required allowed/denied pair and returned 125 with
`validation lifetime marker is absent`. Concurrent greeting work stayed in lanes;
the routing answer was applied in a lane but never integrated, explaining the
canonical `.lane.json` ENOENT. Every affected real session in the supplied
`/private/tmp/herdr-acceptance-wz8SsU/evidence` transcripts shows the same error.

There was a second independent incompatibility: Node's `stdio: 'inherit'`
forwarded only descriptors 0–2. With only the marker fix applied, the negative
control executed green project tests but still returned 125 because the owner
never received readiness on its actual pipe. Passing descriptor 3 through the
validated bootstrap fixes that failure too.

| Candidate / commit subject | Concurrent discovery | Routing approval | Scratch evidence |
| --- | --- | --- | --- |
| v0.1.4 / Report readable backup and exact launch acceptance proof (`f476589`) | PASS | PASS | `/private/tmp/herdr-acceptance-16thYw/evidence` |
| Report Claude discovery review fixes and pending live proof (`5873f07`) | PASS | PASS | `/private/tmp/herdr-acceptance-tdokqK/evidence` |
| Deny unknown validation syscalls and contain detached descendants (`2d22bb9`) | FAIL | FAIL | `/private/tmp/herdr-acceptance-4210NK/evidence` |
| v0.1.5 / Add settle-cap independent review round 1 (`02a41c5`, supplied evidence) | FAIL | FAIL | `/private/tmp/herdr-acceptance-wz8SsU/evidence` |
| Lane candidate / Preserve validation lifetime identity in acceptance transport (`2bdc839`) | PASS | PASS | `/private/tmp/herdr-acceptance-EUrCTT/evidence` |

The scoped runner is the `02a41c5` harness archived at
`/private/tmp/eng97-bisect-harness`, with only its case dispatcher filtered to
`candidate-snapshot`, `herdr-fixture`, `discovery-concurrent`, `discovery-routing`
and `scope-cleanup` (plus prerequisite-tool refusal). Product code and both real
case bodies are unchanged. All twelve sessions used `gpt-5.6-luna` / `low`,
completed with measured usage and exit zero, including the sessions whose
promotion failed. Raw transcripts, boundary receipts, commands, question/answer
and usage remain in the three scratch evidence directories above. These scoped
runs establish the two-case boundary; their five-case READY labels do not claim
full release acceptance. The scratch Git bisect was seeded with the actual
adjacent good/bad outcomes and the supplied v0.1.5 bad endpoint.

The offline regression drives the actual trusted entry parent, gate transport,
native Codex sandbox, record, commits, checks and fast-forward promotion for work
and approved routes. It proves foreign-canary reads, writes to the selected
record/canonical lane state/Git metadata/other session paths and a network
connection stay denied. Separate controls reject foreign write grants,
unsupported profiles, lost lifetime denials and symlinked probes. No offline
case calls a model, reads authentication or operates Herdr.

The full gate command is:

```sh
node acceptance/run.mjs --candidate lane/discovery-regression \
  --source /Users/rewt/development/rewt/.worktrees/herdr-brain/lane-discovery-regression \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm
```

The gate rebuilt its snapshot from committed lane ref `2bdc839`, passed **26/26**
cases with **zero pending** in 376 seconds, closed all its created workspaces and
reported no retained discovery roots or credential residue. All four real sessions
used `gpt-5.6-luna` / `low`; their measured usage and transcripts are retained in
`/private/tmp/herdr-acceptance-EUrCTT/evidence`. Only `summary.json` and
`screen.txt` for each candidate are copied into this report's evidence directory.
The full gate used the changed harness without the scratch bisect filter.

No release, shared lane configuration, bch-cloak source, operator bin, unowned
pane, remote or publication was changed. The report is checked and committed
before the final default `lane check`; the resulting `.lane/gate.json` records
the exact final commit. Integration and release decisions remain with the
project supervisor.
