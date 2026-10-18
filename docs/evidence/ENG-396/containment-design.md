# Green cohort containment question

Run R-529, ENG-396. Source inspected at
`05326989cd5088fc35f29fb1779cc408843907c5`.

This is a blocked design handoff, not an implemented cohort. No eligibility,
configuration, executor, permission or stable surface has changed. The current
`clean-pass` cohort remains the only selectable cohort.

## Finding

The current lifecycle executors verify the selected project's ownership and
authority, but do not restrict their effects to the two green projects. The
cohort setting would control admission of a source change; it would not constrain
the execution of that source after admission. A filename map, import graph,
engineer report, or set of canonical project pins cannot establish that missing
runtime restriction on its own.

The run's ask explicitly allows stopping with a design question rather than guessing
on containment. The unresolved choice is which executable boundary will make an
actual green-only lifecycle change provable. Broadening admission of the existing
generic modules without such a boundary would not meet condition 1.

## Source evidence

- `supervisor/autopilot.mjs:53` binds the notice/run to a canonical Git identity
  and record. This is admission authority, separate from the effects of the
  candidate's code. Its schema currently accepts only enabled/cohort fields.
- `lib/retire-runtime.mjs:134` accepts generic cwd, record, native executable and
  environment inputs. Lines 165–171 resolve the supplied project's common
  directory, canonical checkout, HOLD and record. They do not require Brain or
  the lab. Lines 405–434 apply a plan through the shared executor and native
  prompt/close adapter.
- `sessions/apply.mjs:16` and `sessions/live.mjs:135` use project/workspace
  authorization and physical mutation gates. `sessions/authorization.mjs:102`
  checks generic enrollment and operator evidence; it does not restrict the
  implementation to Brain/lab. Those safeguards must remain effective, but are
  not themselves a green containment proof.
- `supervisor/reconcile.mjs` has 14 files (including the entry) in its relative static import closure,
  listed with source hashes and edges in `source-audit.json`. This closure is
  mandatory ordinary scope in both base and candidate trees, including deletions
  and renamed-away paths.
- At `supervisor/reconcile.mjs:108`, reconciliation also launches source
  `bin/org.mjs complete-batch`. That entry has a 27-file static closure (including itself), covering
  release resolution and route configuration. A static closure of reconcile
  alone misses this subprocess. `bin/org.mjs:991` also has parameterized dynamic
  dispatch; reach analysis must account for the actual command.
- `lib/releases.mjs:120` reads canonical committed release selection;
  `forwardRelease` can spawn an entry from a selected root. Treating that shared
  selector or its mutable fallback as green merely because the notice came from
  Brain would violate the release-selection exclusion.

The JSON is a source inventory, not a complete execution analysis. It records
unresolved edges explicitly; it must never be used as an eligibility certificate.
The existing one-hop test-reference planner in
`test/helpers/affected-tests.mjs` is likewise not an authority checker.

ARCH-23 seq 7884 also records the PATH launchers org/record/lane and BCH scripts
reading machine-wide current directly: settle-watch at launch, auto-promote,
review-receipt, launch-supervisor, dispatch, continue-run, focused-checks and
supervisor-bundle. That operational inventory must be revalidated for the
supervisor's eventual cohort configuration. Neither this audit nor a matching
filename in an immutable release proves current consumption.

## Decision options

1. **Recommended: establish a protected green behavior boundary through the
   ordinary bootstrap route first.** Keep the existing generic controllers and
   guarded executors. Extract only the behavior that can vary for Brain/lab
   behind an independently reviewed dispatch/effect contract. Resolve both
   canonical Git identities and their actual discovered records at entry and at
   mutation edges; other projects continue their existing implementation. Keep
   targeting, HOLD, live-reference, recovery, shared queues/locks and output
   contracts outside the variable behavior. Admit only a closed, mechanically
   understood policy representation; arbitrary JavaScript, callbacks or new
   capabilities remain unknown reach. The first allowed fixture must exercise
   this real consumer rather than a marker in a source comment. This adds a
   prerequisite extraction to ENG-396 and needs a concrete choice of its first
   lifecycle behavior slot.
2. **Separate that prerequisite from this item.** Retain ordinary handling of
   current lifecycle/controller/release code and implement the cohort only after
   a separately reviewed execution boundary exists. Evidence-only admission can
   be implemented independently, but it would not satisfy ENG-396's required
   positive lifecycle fixture or deliver general lifecycle velocity parity.

Neither option changes native permissions, creates a second controller, or uses
the fast path to establish its own authority. Option 1 is recommended because it
keeps the boundary and its first real consumer in one reviewable bootstrap change.
No option has been adopted in this run.

## Constraints for the implementation after the decision

The cohort's checker, dispatch contract, project/record declarations, evidence
validator, and their transitive authority dependencies must be ordinary scope.
Candidate code cannot alter the rules admitting that candidate. Check both
trees and the complete diff, including mode changes, deletions, renames, symlinks
and generated review bytes; do not import or execute untrusted candidate modules
to decide eligibility.

Proposed named refusal classes, subject to that bootstrap review:

| Refusal code | Ordinary scope |
| --- | --- |
| `GREEN_BCH_CONSUMED` | Reconcile closure and any other code consumed by BCH without switching |
| `GREEN_BLUE_HOTFIX` | Blue hotfix operations |
| `GREEN_HOST_RESOURCE` | Shared slots, lock namespaces, admission and exclusion protocols |
| `GREEN_CROSS_PROJECT_AUTHORITY` | Project/pane/session/record targeting, enrollment, HOLD bypass, weakened retirement safeguards |
| `GREEN_GLOBAL_RELEASE` | Machine-wide current, launchers, fallback, installation, rollback, migrations affecting blue |
| `GREEN_SHARED_RUNTIME` | Notice routing/delivery, run/session identity, queue/receipt semantics, shared state compatibility |
| `GREEN_NATIVE_ISOLATION` | Native permissions and isolation |
| `GREEN_SELF_AUTHORITY` | The cohort's own eligibility, evidence and containment authority |
| `GREEN_REACH_UNKNOWN` | Any unresolved execution path, capability, subprocess, dynamic load, launcher or configuration |
| `GREEN_IDENTITY_MISMATCH` | Missing, stale, aliased or mismatched canonical project/record binding |
| `GREEN_LIFECYCLE_EVIDENCE` | Missing or stale identity, HOLD, live-reference or recoverability evidence |
| `GREEN_BINARY_EVIDENCE` | Binary committed evidence |

Text artifacts under `docs/evidence/**` can map as evidence-only when their bytes,
regular-file modes and non-executable use are established; their directory name
cannot exempt imported code, executable scripts, test inputs with executable
effects, or evidence authority. No tests are required for an actual evidence-only
change. Binary evidence stays ordinary. Preserve `clean-pass` byte-for-byte.

For lifecycle admission, the report must identify the exact candidate/base,
canonical project/record pairs and affected path, and reference content-hashed
focused-check artifacts demonstrating all four controls. Identity evidence needs
a foreign or mismatched-project negative control; HOLD evidence needs a hold
appearing at the mutation edge; live-reference evidence needs a pending callback
or occupied lane kept; recoverability evidence needs dirty/unknown work kept and
unmerged committed work preserved under a verified archive ref before removal.
The checker must validate artifact paths, hashes and candidate bindings, reject
missing controls, and carry that evidence to the same completed independent
clean-PASS settlement checked again before enqueue. The report's assertion alone
does not establish any control or the containment boundary.

Run the touched-module tests once on Node 20.19.4 using the requested bounded
runner. Include one real allowed lifecycle fixture, a reconcile-dependency
refusal, every exclusion class, unknown reach, text/binary evidence, stale
project/record/evidence, and the existing unchanged autopilot tests. Run the
release suites, acceptance and BCH seams once per switch candidate in the
supervisor's agreed release window. This run started none of those tests.
