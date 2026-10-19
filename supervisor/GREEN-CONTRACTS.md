# Interim containment contracts

Authority: Astra's 2026-10-18 amended option 3, adopted for ENG-396. This file,
`green-contracts.json`, the checker and its mechanical profiles go through the
ordinary bootstrap route and independent review. This document is a review input,
not an independent PASS or an activation. The manifest remains candidate immutable.

## Allowed component: board-default-width/v1

Only `board/render.mjs`, in the canonical Brain identity and record, qualifies.
Only the integer default of `render(snapshot, { width = 120, ... })` may change,
within 80..240. The manifest binds SHA-256 of the *entire* reviewed module after
normalizing this exact numeric slot. Both base and candidate must match. The
mechanical check also runs the existing closed data profile on the numeric slot.
Every other byte, including comments, imports, callback calls, computed accesses,
`live()` and its environment/terminal handling, remains bound. New imports,
launches, reflection, configuration, effects or executable targets cannot fit
this contract, including code placed in the slot or a second matching slot.

The bound module imports `WITHHELD` from `board/rows.mjs`. Its duration and render
functions format input data; row properties, column callbacks and template
expressions choose text, not modules or programs. `live()` invokes injected
`collect`/`exit` callbacks, uses the injected output and signal emitter, and arms
foreground timers. Those callbacks and callers are unchanged and bound. The
production caller is `board/board.mjs`; its discovery, `board/brain.mjs`, source
launcher (`board/source.mjs`), validation (`board/rows.mjs`), host reads
(`board/facts.mjs`) and dependencies are frozen in the manifest. Script sources
may run project-declared programs; this contract does not change their selection,
argv, cwd, env, queue access or project targets. Changing them is ordinary work.
No board output is interpreted as a command or promotion result. The focused
validation is `test/board-view.test.mjs`, returned by scope and forwarded through
autopilot and supervisor to the promotion queue as required tests, bypassing the
affected-test planner's file/time deferral limits; its body is ordinary test code, while
runners and result interpretation remain promotion authority. Ordinary tests are
not implicitly admitted: this first component does not authorize editing them.
There is no blanket documentation, evidence or test permission.

This is a useful but deliberately narrow initial surface. It demonstrates
renderer eligibility, **not lifecycle eligibility**. No lifecycle component is
established. ENG-422 must extract the smallest protected identity/HOLD/live-reference/
recoverability boundary before a genuine lifecycle candidate can qualify. The
existing lifecycle artifact validator is retained; synthetic artifacts prove its
validation rules, not permission to admit lifecycle code.

## BCH entry contract: reconcile-complete-batch/v1

BCH's owner confirmed the installed current release as the configured ordinary
`supervisor/reconcile.mjs` root for preparation and finish on 2026-10-19. The
manual wrapper allows `HERDR_BRAIN_ROOT`; the optional reuse path uses
`request.brain`. A checkout remains a supported alternate boundary, so reconcile
and its full closure stay frozen. The Brain CLI also supports refresh; the BCH
ordinary wrapper invokes only prepare/finish. Its full file and all runtime/configuration inputs are frozen.
The Git wrapper calls the PATH-selected `git` executable, with `--no-optional-locks`
and `-C` bound to the explicit canonical project. Calls perform status, ref,
worktree and ancestry reads. `lib/project.mjs` also uses Git to resolve common-dir
identity and the canonical checkout. Git selection, configuration and the environment
are boundary inputs, not candidate-supplied receipt fields.

The completion child is exactly `process.execPath`, with the import-meta anchored
`bin/org.mjs` target and first command argument exactly `complete-batch`. Remaining
argv is `--file RECEIPT` and, only on refresh, `--accept-delta DIGEST --why TEXT`.
Receipt paths and receipt JSON are data reads, not executable targets. The cwd is
the explicitly verified canonical project; env inherits the launching environment
and sets `ORG_DIR` to that project's explicit discovered record and `ORG_ACTOR` to
the inherited actor or `supervisor-completion`. Encoding and timeout are fixed.
Brain admission binds its Node 20.19.4 executable/version/digest. BCH selects its
own Node 22.22.3; no claim is made that BCH uses Brain's Node launcher. Loader
injection keys must be absent in Brain admission; launcher/configuration inputs
remain frozen. The existing reconcile child inherits its caller environment;
this amendment does not rewrite that BCH seam.
Native settings remain owned by the harness; this implements no permissions.

`bin/org.mjs` eagerly imports project, fleet, release selection, store, fold,
roles, retirement hint, lessons, report, discernment, sanitize, today, routes,
completion, release-record, handoffs-command and render modules, plus Node builtins.
All eager/transitive dependencies are frozen in the runtime inventory. Its fixed
`COMMANDS['complete-batch']` calls `completeBatchCommand` directly. That command
parses receipt JSON, opens the record read-only for discovery, checks the batch
and transactions, appends completion/reconciliation events under the record lock,
and writes the retirement request hint. `mutate()` calls `requestRetirement()`;
that function writes a coalesced hint, not a retirement execution or background
cycle. Those files, locks, process observations and shared receipt contracts stay
excluded. It does not select the board entry or renderer.

The command cannot select `handoff`, `pane-release`, `session-bind`, `desks`,
`routes`, `housekeeping` or `summary`: the command word is fixed independently of
receipt data, `main` dispatches exactly that key, and complete-batch parses no
positional command. Their lazy modules are conservatively frozen anyway; this
manifest does not rely on subtracting them from containment.

Before dispatch, `forwardRelease('bin/org.mjs', process.cwd())` can select the
canonical target project's committed `.herdr-release.json`. It either stays in
this source tree or launches exactly `bin/org.mjs` in a verified immutable release,
with the same argv and cwd. Global release selection, manifests, checks, launcher
code, rollback and project targeting are excluded. The project pin, fleet and
relevant route/config files are external version pins. Immutable release consumers
receive changes only through the existing switch candidate's release suites, live
acceptance and BCH seam checks. Missing or changed inputs mean ordinary handling.

The owner-confirmed direct inventory is recorded in
[the confirmation](../docs/evidence/ENG-396/R-570/bch-confirmation.txt) and
[the structured inventory](../docs/evidence/ENG-396/R-570/bch-consumers.json):

| Entry | BCH use |
| --- | --- |
| `bin/org.mjs` | auto-promote check/ingest; PATH `org` and `org-guarded` also forward record commands; transitive complete-batch and worker recording |
| `promote/promote.mjs` | auto-promote queue, expected head and current run |
| `dispatch/record-worker.mjs` | dispatch and continuation worker identity recording |
| `supervisor/reconcile.mjs` | ordinary and explicit reuse prepare/finish |
| `contrib/settle-watch.mjs` | installed watcher with routing-selected `--model`, `--effort`, `--lane-config` |
| `lib/store.mjs` | auto-promote/review receipt/pre-window record reads |
| `lib/state.mjs` | auto-promote/review receipt/pre-window fold and derived state |
| `lib/report.mjs` | auto-promote report parsing |
| `lib/roles.mjs` | pre-window role checks |
| `lanes/validation.mjs` | conditional explicit reuse `validateTree` API |

The observed current alias resolved to
`rc-20261019T042359000Z-cc585d9f33`, Brain commit
`cc585d9f334c9842b459ef2b7ff3f693d57eb08b`. BCH has no project release pin.
The installed promotion launcher removes both alternate-root selectors with its
`env -i` allowlist; auto-promote strips `HERDR_BRAIN_ROOT`. The observed supervisor
process and LaunchAgent supplied neither selector. No live reconcile was running
at capture, so this is configured-root evidence, not a historical execution trace.
It corrects older checkout-root wording, including AGENTS.md's description.

All ten entries appear in `externalConsumers`; their transitive closures remain
frozen. Manual/reuse alternate roots require the same frozen boundary or ordinary
handling. The validation-reuse adapter's hash walks over lanes/lib/test-slot are
data reads, not additional executable entries. Immutable release consumption and
`contrib/` plus `lib/cli-help.mjs` shipping remain intact. A future switch still
requires release suites, live acceptance and BCH seam checks. Before activation,
the supervisor reconfirms that this captured consumer/root inventory still holds.

## Promotion authority and unresolved edges

The manifest separately labels the code selecting checks, interpreting results,
validating review/receipt evidence, authorizing promotion and selecting execution
targets: `supervisor/autopilot.mjs`, supervisor handle/notice glue, `settle/`,
`promote/`, `.lane.validation.json`, `.promotion-selector.json`, `package.json`,
`lanes/validation.mjs`, `test/helpers/` and `acceptance/`. Other supporting
runtime/configuration files are frozen without claiming every ordinary module or
test is promotion authority. None can be changed through this cohort. Bootstrap
files compare against captured trusted bytes, avoiding circular hashes; all other
boundary files have exact mode and SHA-256 pins in both trees and running source.

The conservative runtime universe includes all tracked runtime/configuration files
outside ordinary test bodies and archived/evidence trees. Its exact membership is
also checked, including additions/deletions. Unknown generic wrappers in that
frozen universe do not gain an exemption to execute changed code: the sole variable
is a bounded display integer in an otherwise exact module. A component with a new
or unresolved execution edge cannot satisfy that shape. This contract grants no
arbitrary-JavaScript safety claim. Expanding the surface or a wrapper's possible
reach requires ordinary contract review and a new manifest.

The reviewed external inputs list binds canonical Git configuration, relevant
project and ancestor route/configuration, fleet, release pins and the Git launcher.
Mutable event/queue/receipt *data* is not hashed as configuration. The environment
policy is plain text: HOME, XDG_CONFIG_HOME and HERDR_MONITOR_FLEET select pinned
configuration; NODE_OPTIONS/NODE_PATH and DYLD_/LD_ injection must be absent.
Harness-specific GIT_ and NODE_ keys are not session hash pins. Checker Git and
autopilot Node children strip GIT_/NODE_/DYLD_/LD_ selectors and ORG_ overrides,
use the reviewed Node/Git directories plus HOME/.local/bin and fixed system bins,
and receive the explicit record/actor. Git and Node executables remain byte pinned.
The running Node's execArgv is also bound as a readable array.

Activation is the first append-only `note.added` event whose exact text is
`green-activation/v1 MANIFEST_SHA256`, in the manifest Brain record. Its event
`at` must equal configured `activatedAt`; missing evidence, torn records and later
reset timestamps refuse. Repeating the note cannot restart the ten-day interim.
The checker reads this evidence and never writes the event log.
Any boundary drift, missing input, unknown component or foreign project returns
to ordinary handling immediately. No mandatory tracing campaign is introduced.
