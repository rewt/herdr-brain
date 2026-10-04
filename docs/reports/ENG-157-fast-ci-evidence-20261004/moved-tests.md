# Tests retained in release

Every case below remains release-only and runs via the unchanged full-suite commands in `test:release:steps`. This inventory covers 31 whole files plus expensive cases from 12 newly mixed files, the existing seven mixed files and the lane lifecycle file. Interpolated titles retain their existing matrix values. File-level behavior and cost reasons appear in `docs/validation-tiers.md`. The original measured logs remain historical evidence; the correction audit is in `logic-audit-R-206.md`.

## acceptance/test/boundary.test.mjs

- native adapter pins the original socket despite an isolated HOME or caller override (line 16)
- foreign pane/workspace targets and symlink escapes never reach mutation APIs (line 39)
- model launch requests are always replaced by the scratch worker script (line 51)
- parent-focusing worktree removal is refused before any native mutation (line 66)
- the focus gate fails when a lane-close caller swallows unsafe removal and succeeds via Git (line 75)
- creation receipts grant the only new targets and force no-focus (line 111)
- explicit focus, attach, zoom and creation focus flags leave typed refusal receipts (line 129)
- agent send-keys requires an owned target and checks its live cwd (line 143)
- named-agent mutation receipts retain the pane resolved by native identity lookup (line 155)
- late pane needs a live owned workspace and scratch cwd, then gets an atomic receipt (line 167)
- non-zero native Herdr replies are harness failures through both body and forwarding paths (line 195)
- stand-in registration timeout is harness pending without a safety marker (line 220)
- scripted PTY acknowledgement timeout is harness pending without a safety marker (line 229)
- actual capability refusals stay product FAIL even when wrapped by cleanup (line 241)
- missing live pane cwd receipt is a harness limit, not a candidate capability violation (line 262)
- native transport pins the original socket when copied HOME changes (line 272)
- final tab rename is allowed only for receipt-owned tabs (line 289)
- private lane environment preparation reaches only an owned pane with a live scratch cwd (line 299)

## acceptance/test/cleanup.test.mjs

- ${shape} linked creation receipt survives a failed pane-layout read (line 67)
- ${signal} closes receipt-owned main and linked workspaces before emitting summary (line 98)
- adapter records the implicit main workspace as well as the explicit linked creation reply (line 112)

## acceptance/test/cutover.test.mjs

- installed copied cleanup uses recorded outcomes, latest runs and whole-tab eligibility (line 54)
- installed tidy recovers a bounded tail from each log including a late older run (line 82)

## acceptance/test/focus.test.mjs

- focus sampling continues while the acceptance parent blocks and spans cleanup (line 48)
- native pane_focused events catch a transient change between unchanged samples and name both calls (line 62)
- native startup replay settles before the baseline and subsequent transient owned moves still fail (line 83)
- continuous operator focus starts without silence and an immediate transient harness move still fails (line 103)
- continuous operator activity alone passes after bounded replay (line 126)
- a busy stream from an unknown server never assumes the verified replay bound (line 136)
- external sampled and transient event moves are recorded and re-baseline without failing (line 151)
- an unlisted pane in an owned workspace fails after an external re-baseline, even through cleanup (line 170)
- external moves during unrelated active and completed calls re-baseline without failing (line 188)
- a move to the pane targeted by a concurrent call fails after an external re-baseline (line 210)
- workspace destinations correlate only with their matching call despite a newer unrelated completion (line 226)
- a resolved agent target receipt correlates a named call without guessing pane IDs (line 248)
- a creation receipt attributes a transient move before ownership is registered (line 262)
- a focus event after a slow completed call names that call using its completion time (line 280)
- an unreachable read-only focus socket is an explicit harness limitation (line 302)
- the monitor retains forbidden attempts even when every sample remains unchanged (line 308)

## acceptance/test/load-round2.test.mjs

- a successful TAP test named ETIMEDOUT cannot hide an unrelated assertion failure (line 45)
- handles ETIMEDOUT (line 49)
- independent product behaviour (line 49)
- ${spec.name} bounded child timeout is ${heavy ? 'PENDING' : 'FAIL'} with its operation samples (line 77)
- ${spec.name} report deadline is ${heavy ? 'PENDING' : 'FAIL'} with its own wait samples (line 93)
- ${spec.name} independent child assertion failure stays FAIL under heavy load (line 106)
- supervisor queue deadline is ${heavy ? 'PENDING' : 'FAIL'} with queue-operation samples (line 119)
- delegated fixture setup timeout also cleans its owned root before returning (line 135)

## acceptance/test/recovery.test.mjs

- ${signal} drains an active ${form} and recovers its lost reply (line 32)
- cleanup refuses snapshots until every registered producer acknowledges stop (line 105)
- cleanup stops and awaits a supervisor executing dispatch before reading ownership (line 140)
- stopping an individual idle PTY worker leaves the run admission barrier open (line 207)

## acceptance/test/validation.test.mjs

- green (line 26)
- validation composition keeps product denials and refuses foreign writes and unsupported profiles (line 33)
- validation write exceptions reject redirected directories and protected Git or shared-state targets (line 56)
- only immutable lifetime probes get a narrow read grant; aliases and missing denials refuse (line 71)
- actual native transport validates and promotes work and approved routes offline, preserving owner fd and confinement (line 90)
- gate and product boundaries (line 125)

## acceptance/test/verification.test.mjs

- installed product contains every relative module import, including fleet dependencies (line 47)
- native direct session can commit/worktree/ref but cannot write common or worktree config and hooks (line 114)
- model-controlled tests and Git filters execute only sandboxed; fsmonitor/hooks stay disabled (line 128)
- execution boundary (line 144)
- record verification and scripted answer are kernel-confined even if model output redirects .org (line 153)

## console/test/session.test.mjs

- approving and declining from the console record the operator\'s answers (line 46)
- Enter and a click peek at a live session; g goes; a gone one says so; Herdr down says so (line 109)
- go-to-session runs herdr with an argument array: the agent by name, else its tab (line 173)
- open suspends for an editor, a failed read keeps the last data, and the header shows the version (line 210)
- NO_COLOR draws plain glyphs, and a scope narrows the list and prefills nothing else (line 256)
- overruling from the history records the opposite answer (line 269)
- a text document opens from a private file that is removed afterwards (line 293)
- DOING for a run with no usable title comes from the work in the brief org start wrote, never its fixed opening (line 353)
- transcripts are looked up by name from the run\'s start, else from local midnight (line 374)
- a named project switch lands on that project and keeps the repository scope (line 391)

## discovery/test/acceptance.test.mjs

- copied ${harness} probe product validates, guards and promotes worker and routing changes offline (line 11)
- English stays (line 53)

## discovery/test/entry.test.mjs

- installed supervisor entry in an untouched project satisfies the release cold-start and notice contract offline (line 28)
- unrelated project has one canonical record, a real pending question and two separate lanes (line 45)
- capability refuses arbitrary operations, fields, changed identity and missing validation sandbox (line 68)
- concurrent automatic record bootstrap never truncates events or duplicates records (line 84)
- initialization preserves a populated record, and a supervisor has no worker Git capability (line 99)
- machine installer retains native flags, reaches Claude too and restores only its own files (line 114)

## discovery/test/lifecycle.test.mjs

- receipt publication hides a deliberately paused partial JSON write from the sweep reader (line 68)
- close preserves ignored .env and .lane files and explains retention (line 84)
- ${kind} entry forwards terminal hangup and cleans its untouched lane (line 99)
- next entry sweeps killed untouched owners and preserves every form of work (line 122)
- sweep never removes a lane owned by a live parent or native child (line 145)
- a parent killed during ownership handoff cannot launch an unregistered native child (line 162)
- symlinked HOME and operator worktree-root prefixes resolve before no-follow creation (line 182)

## discovery/test/owner.test.mjs

- validation runs with no compiler and ignores CC, flags and TMPDIR overrides (line 58)
- installed runtime snapshot carries the verified owner and validates without a compiler (line 82)
- ${name} uses only the bounded source-build fallback (line 107)
- unavailable bundle and ${compiler} compiler refuse project execution (line 118)
- owner verification rejects a checksummed binary for the wrong architecture (line 125)
- no compiler preserves detached descendant cleanup after ${mode} (line 136)

## discovery/test/review-r2.test.mjs

- all providers reject ${location} writable symlink components (line 59)
- sandbox grants reject redirected workspaces, queues and external runtime paths (line 69)
- sandbox exceptions cannot override a protected record, Git tree or nested record target (line 81)
- Git filter refuses a temporary symlink to ${target} before execution (line 91)
- disabled ${Object.keys(settings).join('/')} filters preserve binary bytes across integration (line 107)
- ${direction}-only required filters preserve the missing direction as identity (line 115)
- required configured filters cannot fall back to identity after a command failure (line 125)
- Claude live cases stay pending without authorized authentication and never launch the native binary (line 134)

## discovery/test/review-r3.test.mjs

- detached double-fork descendants are gone after completion; unrelated same-group processes survive (line 49)
- detached double-fork descendants are gone after deadline; unrelated same-group processes survive (line 49)
- descendants are cleaned after the JavaScript wrapper is killed (line 49)
- macOS cleanup retains the immutable kernel marker and refuses a missing provider boundary (line 58)
- validation cannot signal an owner outside its inherited kernel boundary (line 71)
- pending Claude probe emits Linux evidence without a platform guard (${flags.length ? 'skip-live' : 'no-auth'}) (line 96)
- acceptance setup failure removes its installed snapshot and keeps only evidence (line 105)
- acceptance allocation failure removes the first temporary root (line 112)
- acceptance evidence directory failure still removes its installed snapshot (line 118)
- Linux kernel denies asynchronous AF_UNIX socket creation and host socket connection (line 127)

## discovery/test/review.test.mjs

- route adoption leaves planted predictable and destination symlinks untouched (line 40)
- plain CLI finds nested records and keeps automatic runtime files out of git status (line 61)
- atomic writer pins its directory when an attacker replaces the directory path (line 80)
- ${launcher} sends a bypass that preserves its interactive native session (line 99)
- global-only Git identity and unused globally installed LFS survive broker commits (line 125)
- only fresh interactive shims adopt a lane; utilities, batch, resume and existing lanes pass through (line 136)
- interactive no-identity launches warn and preserve the native session (line 162)
- fresh Herdr starts receive entry; explicitly assigned starts retain their bypass (line 175)
- canonical preparation and validation remain authoritative in both check and promote (line 200)
- operator-selected record ancestors, record files and report links keep working (line 225)
- symlinked LANE_CONFIG and canonical .lane.json retain operator route resolution (line 260)
- findOrgDir stops at the filesystem root outside GIT_WORK_TREE (line 278)
- macOS /tmp remains a valid operator record path (line 290)
- close removes only untouched entry lanes, including failed setup (line 298)

## discovery/test/sandbox.test.mjs

- real native sandbox validates both lanes and promotion; outside writes and Git metadata stay denied (line 10)
- green (line 22)

## discovery/test/settings.test.mjs

- explicit installed adapters leave opted-out projects and native arguments untouched (line 62)
- automatic interactive adapters pass opted-out sessions straight through (line 80)
- both transports deliver project settings, integration branch and instruction precedence (line 92)
- main-checkout mode reaches both native harnesses without becoming a supervisor (line 107)
- automatic interactive entry honors the project main-checkout mode (line 131)
- worker mode validates and promotes to the declared integration branch (line 143)
- main-mode worker records and commits locally, refuses promotion and verifies its assigned branch (line 155)
- main-mode done reports require clean committed work and successful sandboxed validation (line 169)
- entry-only configuration preserves the portable route suggestion and pending operator question (line 197)
- entry advertises tracked tiers and its sandbox runs only the requested worker or promotion check (line 206)
- undeclared entry with package metadata and a Node test directory checks and promotes without an npm script (line 223)
- undeclared project check (line 227)
- entry settings use canonical Git identity and do not inherit parent or worker config (line 240)
- invalid enabled settings and mismatched integration branches fail before runtime creation (line 251)

## dispatch/test/dispatch.test.mjs

- Linux dispatch watcher receipt and journal round-trip as strings through record set (line 154)
- dispatch waits under simulated swap pressure before opening a lane and resumes the same request (line 184)
- STOP during dispatch ${stage} memory wait retains the request without a worker launch (line 202)
- dispatch serves a validated operator priority, preserves it through recovery and permits unaligned work (line 240)
- one command records exact route/worker fields, arms watch before prompt, and preserves briefs (line 259)
- open/prepare failures keep a visible request, create no run, and retry cleanly (line 274)
- watch failure records a worker but never sends work; retry reuses the same worker/run (line 281)
- uncertain launch refuses automatic replay and requires explicit adoption (line 288)
- uncertain prompt refuses automatic resend; caller can authorize it after inspection (line 294)
- a fix round can reuse a stopped worker or start fresh; changed route is refused (line 299)
- retry pins routes across config edits and detects a replaced occupant (line 308)
- base moves a clean reused lane only by fast-forward; dirty lane is preserved (line 315)
- a real detached watcher acknowledges initialization and sheds supervisor pane identity (line 321)
- lost record start result is visible and recovered without starting a second run (line 332)
- live request locks refuse retries without changing the journal (line 345)
- explicit fresh launch and accepted delivery recover uncertain attempts (line 350)
- invalid route and empty brief mutate neither lane nor record (line 355)
- a refused record start with no matching run retries the saved request (line 361)
- a run ID supplied as ITEM is refused before creating a lane or journal (line 379)
- reuse refuses an idle worker whose previous run is still open (line 387)
- reuse accepts an abandoned run with the same stopped occupant (line 396)
- retry locks before reading its journal so another retry cannot replay stale progress (line 423)
- two retries cannot both take over a dead-owner lock (line 441)
- an unknown start outcome with no match stays conservative; multiple matches require explicit recovery (line 462)
- dispatch waits for a real watcher whose configuration read exceeds the old startup deadline at load 24 (line 487)

## housekeeping/test/auto-tidy.test.mjs

- finished worker tabs close before promotion while working, blocked, unnamed and operator tabs stay (line 86)
- dry-run previews finished tabs and never closes, including through housekeeping --once (line 98)
- a working or blocked change at the final recheck preserves the finished tab (line 107)
- new occupants revealed after the final pane list preserve their tab (line 115)
- housekeeping --once preserves waiting reports, blocking items and missing item evidence (line 140)
- automatic tidy requires the newest recorded occupant and preserves absent or mismatched identity (line 167)
- replacement identity and a waiting report at the final observation prevent closing (line 191)
- a reused worker name with a newer open run and an extra unnamed occupant never close (line 202)
- a matching worker cannot authorize another occupant reusing its name (line 211)
- only this Git project is tidied and the caller tab is preserved (line 219)
- finished reviews and old settle sessions use the existing tidy policy (line 229)
- three fix rounds clear reported workers and review-codex verdict tabs, leaving the working round (line 247)
- automatic review tidy preserves missing or mismatched occupant evidence without worker runs (line 282)
- replacement reviewers at the final observation keep their tabs without worker runs (line 337)
- review evidence cannot override a recorded worker waiting on a blocker (line 354)
- failed and incomplete reads close nothing and are logged without stopping housekeeping (line 363)
- every tick tidies despite the ten-minute cleanup interval and a tidy failure (line 379)

## lanes/test/workspace-native.test.mjs

- native dispatch opens a one-tab lane from a project with no Herdr workspace and preserves focus (line 17)

## release/test/release.test.mjs

- release defers swap and low-memory pressure without cutting a candidate, then proceeds when cleared (line 43)
- unconfigured release uses npm test, initializes its record and never executes ship (line 57)
- unset and missing preflight inputs remain retryable${advance ? ' after main advances' : ' on the same commit'} (line 71)
- a signaled preflight is retryable and malformed preflight declarations are rejected (line 94)
- a preflight launch error creates no candidate and can be corrected on a later commit (line 111)
- two real lane promotions become one tagged batch and one operator question (line 125)
- publish auto policy cannot approve a release and agents cannot forge, close or overrule its decision (line 148)
- release replies require normalized ${answer} and leave later promotions eligible (line 168)
- agents cannot start a run on an operator-reserved question answered ${answer} (line 216)
- low load, drained promotion queue, clean base and supervisor ownership are required (line 240)
- red gate is durable, never repeated, and a later promotion may become a new candidate (line 258)
- interrupted start, duplicate record writes and older folds preserve once-only semantics (line 270)
- tracked declarations, preparation failure, fixed candidate tags and base overrides are explicit (line 286)
- snapshot extraction gives tar an owned archive file instead of a padded stdin pipe (line 300)
- supervisor, discovery and console recover gate evidence and the operator decision from the record (line 323)
- a running gate excludes a second release and a direct promotion with the shared lock (line 345)
- gate result receipts are immutable and duplicate completion creates no extra operator question (line 361)
- preparation env is scoped and a signaled gate records interruption without a replay (line 372)
- scratch preview runs preparation with inherited dependency-skip switches removed (line 383)
- a moved candidate tag cannot reuse its green evidence (line 398)
- a held host slot defers release before cutting or claiming a candidate (line 407)

## settle/test/config.test.mjs

- a project with only settle settings and no parent routes completes independent review (line 25)
- relative LANE_CONFIG uses the intake file for canonical review without running validation (line 44)
- review retry from another checkout retains the selected absolute config and effective routes (line 60)
- relative LANE_CONFIG resolves from the invoking directory even with --repo elsewhere (line 96)
- a review retry retains discovery when the new invocation sets LANE_CONFIG (line 110)
- CLI desk overrides are consumed by settle without adopting routes or losing lifecycle settings (line 125)

## settle/test/memory-boundaries.test.mjs

- unconfigured lane review uses the portable preset ${coordination.length ? 'after the parent memory check' : 'with its own memory check'} (line 12)
- dispatch child boundary ${stopped ? 'STOP restores worker stage for ordinary retry' : 'pressure does not create a second hidden wait'} (line 53)
- settle review child boundary ${stopped ? 'STOP restores review stage for ordinary retry' : 'pressure does not create a second hidden wait'} (line 78)
- direct lane ${command} waits visibly and honors canonical STOP from a linked worktree (line 98)
- lane ${command} validates ${args.join(' ') || 'missing round'} before memory wait (line 130)

## settle/test/recapture.test.mjs

- recovery: moved main cannot swallow a capped findings correction${conflict ? ' even with a replay conflict' : ''} (line 18)
- recovery: record-stage recapture waits for ingestion and follows the latest main (line 35)
- two recaptures after an applied rebase replay only lane and review commits from the same lineage (line 99)
- uncertain review retry guards lane mutation before recapturing a moved main (line 116)
- refused recapture ${mode} preserves its old base and gives a terminal conflict handoff (line 127)
- a lost recapture replacement response retains the old base until the proved head is adopted (line 143)
- dispatching recovery after main moves exempts only its existing correction run and changed head (line 158)
- a stopped fix tolerates main moving and dispatches one correction after STOP clears (line 174)

## settle/test/receipts.test.mjs

- ingestion receipt requires the captured recorded report before review or correction (line 47)
- lost successful correction start recovers through settle retry with one recorded run and one prompt (line 81)
- lost-start reconciliation retains closures, unresolved and declined blockers, and newer outcomes (line 98)
- lost-start reconciliation refuses multiple recorded matches without launching work (line 126)

## settle/test/round-cap.test.mjs

- project cap counts completed reviews across fix runs and records the no-dispatch decision (line 20)
- a recorded item cap overrides the project and flag overrides persist on the item (line 38)
- explicit correction after capped findings remains resumable under STOP (line 54)
- zero item cap disables the project cap; worker starts without reviews do not consume rounds (line 70)
- cap reached still dispatches for Major or FAIL (line 78)
- cap cannot waive unverified claims or unparsed finding severity (line 87)
- uncertain reviewer retries retain the cap snapshot and do not consume another completed round (line 98)
- cached capped findings and explicit correction recheck head and current run (line 108)
- malformed cap config or flags are refused before review and dispatch (line 121)
- capped decisions recover missing or lost record responses without repeating review or writing duplicate notes (line 132)

## settle/test/settle.test.mjs

- settle retains the review stage under simulated memory pressure and launches once after it clears (line 11)
- STOP arriving during correction dispatch memory wait returns a resumable stopped handoff (line 34)
- fixture teardown waits for a concurrent child to finish writing before removing its directory (line 91)
- unconfigured project: report, independent claim finding, fresh fix run, report, settle, promotable (line 121)
- already ingested reports use immutable bytes and never create duplicate proposals (line 153)
- non-done outcomes escalate with substance without launching a reviewer or correction (line 162)
- inherited validation acknowledgments are scoped non-claims, never unresolved acceptance evidence (line 173)
- discovered project settings override parent settle values and inherit a non-main integration branch (line 184)
- explicit configuration selects one layer and command flags override settle settings (line 202)
- an item dropped or blocked during NEEDS-WORK review cannot launch a correction (line 215)
- initial and cached readiness both require a clean canonical checkout (line 231)
- dirty lanes and foreign Git identities cannot be reviewed or dispatched (line 244)
- malformed reviews never silently retry models; inspected uncertain launches can start a new round (line 253)
- uncertain fix delivery recovers the dispatch journal and never starts a second correction (line 266)
- suite execution is deferred until promotion even with an independent PASS (line 293)
- red gate (line 295)
- PASS with unverified claims and moved heads do not return promotable (line 302)
- same-lane contenders cannot run two independent reviews (line 310)
- other-item lane work and dropped items require judgment; a saved PASS rechecks the record (line 319)

## settle/test/teardown.test.mjs

- teardown stops a ${slow ? 'slow transport and its' : 'persistently busy'} inbox owner before deleting the record (line 17)
- a real detached owner stays alive through test end and stops in the after-hook (line 43)
- teardown treats a lock pointing at an unrelated command as gone without signalling it (line 52)

## settle/test/validation-tiers.test.mjs

- distinct worker, settle and queue panes reuse each tree through same-tree rebase and queued promotion (line 10)
- saved settle readiness defers changed commands and environments to promotion without repeating review (line 55)

## supervisor/test/supervisor.test.mjs

- cold start surfaces host pressure and memory/CPU process evidence without changing record status (line 16)
- cold start and entry policy expose command basenames and resource figures without process argv (line 30)
- supervisor handle exposes ${stage} memory wait before pressure clears (line 47)
- handle returns capped findings and promotion records explicit acceptance with exact heads (line 76)
- handle explicitly sends capped findings back once and adopts its saved correction (line 98)
- STOP arriving during review retains a resumable correction without launching another worker (line 125)
- supervisor binds head and run into the queue and retries confirmed refusals with history (line 143)
- bound promotion rechecks queued runs and record changes during validation before integration (line 169)
- late final reports recover completed promotion after lane closure and retain binding, integration and current-run guards (line 196)
- late original and correction notices after lane removal preserve promotion guards and never replay settlement (line 253)
- refusal retry cannot authorize a new unreviewed head or replay an interrupted attempt (line 287)
- supervisor entry and final notices carry the unconfigured cycle through actual promotion (line 301)
- cold start includes routes, priorities, history across midnight and a durable explicit reading cursor (line 306)
- ingested report decisions retain provenance and rationale after closure and across checkpoints, scoped by repository (line 334)
- workers, linked checkouts, STOP and intermediate notices cannot start supervisor mechanics (line 377)
- non-done reports hand off substance without review; saved enqueue uncertainty never replays (line 397)
- full JSON preserves overflow, file presence awaits watch and foreign runs are excluded by Git identity (line 413)
- conditional record completion preserves newer work, unresolved and declined blockers (line 427)
- a disappeared checkout retains its open record run through a dispatch identity receipt (line 452)

## test/brain-start.test.mjs

- brain start tells org which session is acting (fake Herdr) (line 15)

## test/console-launch.test.mjs

- org console explains how to install the console when its dependencies are missing (line 11)
- org console starts the console app, which writes an example configuration on first run (line 19)

## test/fleet.test.mjs

- first entry maps an existing record in place; a neighbouring repository gets its own record and routes (line 42)
- concurrent first entries publish one complete fleet with both projects (line 67)
- join is a byte and mtime no-op from a linked checkout; session limit changes only through join (line 82)
- moved checkout remains stale in fleet and console instead of being guessed by name (line 98)
- a ${change} default-record checkout joins automatically without claiming the stale same-name entry (line 112)
- explicit replacement remaps the default checkout record by its relative path (line 148)
- a re-clone in place can explicitly replace a missing native record (line 171)
- an unedited example console configuration is rejected with a fleet present (line 193)
- malformed fleet fails before entry or discovery touches any record (line 203)
- fleet advisory and stale checkout are visible in the project view (line 224)
- installed monitor command joins without a session and removal restores its bin (line 232)
- stable machine installation carries monitor and recovery can restore its launcher (line 243)
- an already-open console reads new joins and adjusted advisory limits on refresh (line 263)
- explicit adoption maps paths and settings; record ownership cannot be duplicated (line 275)
- without a fleet file legacy ancestor discovery and console configuration are unchanged (line 289)
- fleet-present unjoined discovery terminates outside GIT_WORK_TREE and ignores outside records (line 299)
- entry worktree roots are session overrides and never freeze the fleet mapping (line 319)
- console merges unjoined configured projects with fleet entries across refresh and adoption (line 333)
- explicit ORG_DIR validates the fleet without launching Git on record commands (line 365)
- a moved checkout can explicitly replace its stale mapping while retaining its external record (line 378)

## test/mcp.test.mjs

- MCP stdio integration (install with npm --prefix mcp ci) (line 9)

## test/open-session.test.mjs

- open-session tells org which session is acting (dry run, fake Herdr) (line 15)
- a codex route starts a codex session with its model, effort, route args and always_args (dry run) (line 88)
- open-session refuses a concurrent supervisor session instead of waiting (line 118)
- a run with a recorded report never opens a duplicate settle session (line 142)

## test/plugin-install.test.mjs

- planning rejects ${edit} edits to ${target} without publishing a journal (line 85)
- release tests preserve a separate installation inherited through the parent environment (line 123)
- overlapping installs serialize before planning and retain the first runtime and complete entry (line 146)
- a complete stale plan refuses before a journal and cannot roll back another successful install (line 174)
- runtime rollback removes only its own staging directory and preserves a foreign final runtime (line 196)
- rollback leaves an unstarted file alone even when another writer supplied its planned after-bytes (line 209)
- shell install, upgrade and restore preserve every original byte including malformed UTF-8 (line 219)
- non-UTF-8 shell bytes survive ${crash ? 'terminated-install recovery' : 'failed-write rollback'} (line 240)
- mode-only reinstallation at ${point} survives ${crash ? 'terminated-install recovery' : 'failed-write rollback'} (line 263)
- legacy shell receipts preserve new non-UTF-8 edits outside the managed snippet (line 311)
- relocated installed runtime executes lane review through its bundled template dependency (line 322)
- release carries entry, pins final versions, rolls back and restores exact shell state (line 349)
- build installs pinned console and MCP dependencies with offline preference and honors RELEASE_NO_NPM (line 391)
- manifest build installs entry even when npm is skipped; restores preserve surrounding user edits (line 410)
- plugin build discovers native CLIs and installs default machine paths without entry overrides (line 419)
- Herdr build checkout can move or disappear while installed entry and restore still work (line 433)
- supervisor resolves the selected workspace to canonical Git instead of its plugin cwd (line 456)
- real v0.1.3 and v0.1.4 scratch copies activate, rollback, roll forward and restore (line 476)
- non-writable shell files refuse installation without adapters or partial snippets (line 500)
- recovery receipt precedes shell writes and ${crash ? 'recovers a terminated install' : 'rolls back a failure after the first snippet'} (line 510)
- rollback preserves a namespaced tag with a same-basename distractor (line 543)
- terminated install recovers a staged shell replacement as well as the first installed snippet (line 554)
- edited adapters/snippets and planted symlinks refuse before activation or removal mutates state (line 568)
- rolling back to a release without discovery removes entry and can roll forward again (line 587)

## test/pty.test.mjs

- PTY transport uses native BSD arguments and shell-safe util-linux arguments (line 15)
- PTY completion retains TTY, arguments, output and exit status (line 77)
- PTY native owner accepts the measured-load allowance above its fifteen-second base (line 83)
- PTY cleanup completes when native enumeration exceeds its former three-second allowance (line 114)
- PTY cleanup refusal still returns unconfirmed status with a loaded allowance (line 126)
- PTY command timeout clears its separate group, including SIGHUP handlers with blocked loops (line 132)
- ${kind} of the outer suite clears the independently owned PTY session (line 141)
- blocked PTY culprit (line 151)

## test/release.test.mjs

- a release is a read-only copy of a tag, never rebuilt in place, and only from a tag (line 57)
- activate moves the launchers and the Brain service onto current; rollback and restore undo it (line 70)
- an existing before directory learns that the new record launcher was absent (line 94)
- restore preserves a replacement at a launcher that was originally missing (line 112)
- a launcher that is a real file is never replaced (line 135)
- the dev plugin is a second id pointed at a worktree (line 144)
- activating the active release again (after a failed step) keeps its real previous release (line 158)
- the plugin is linked to the active release itself and re-linked on every switch; restore unlinks it (line 170)

## test/settle-watch.test.mjs

- settle-watch tells org which session is acting (dry run, fake Herdr) (line 15)
- a codex route starts a codex session with its model, effort, route args and always_args (dry run) (line 86)

## test/startup-deadlines.test.mjs

- ${module} acknowledges a delayed startup at load 24, without launching real background work (line 16)

## test/test-hangs.test.mjs

- real detached fixture cleanup survives an assertion failure (line 33)
- ${kind} cleanup bounds genuinely detached fixtures outside the suite group (line 44)
- real detached cancellation fixture (line 53)
- compound fixture scenarios have an explicit aggregate bound and owned cleanup (line 108)
- a nested bounded suite may exceed one command deadline while ordinary commands retain their bound (line 116)
- aggregate suite longer than one command (line 118)
- a late waiter receives a child result and output after close (line 125)
- a completed fixture never looks up or signals its historical PID during teardown (line 134)
- already completed fixture (line 137)
- ${kind} names the failed test and reaps its fixture child and grandchild (line 153)
- ${kind} watchdog bounds a blocked event loop and clears the fixture group (line 174)
- blocked event loop culprit (line 175)
- ${signal} of an outer runner reaps every nested worker and blocked fixture descendant (line 196)
- nested blocked loop (line 207)
- enclosing nested runner (line 215)
- a leader exiting before its redirected background child fails the suite and leaves no survivor (line 246)
- a failed end-of-suite lookup still performs freshly confirmed group teardown without suspending fixtures (line 260)
- audit lookup failure (line 261)
- suite cancellation clears a detached spawn frozen before its ownership lookup (line 280)
- spawn before ownership lookup (line 283)
- fixture environment overrides cannot detach a grandchild from the suite group (line 304)
- no escaped grandchild (line 311)
- a fresh signal confirms the same owned birth tuple across caller timezone changes (line 326)

## watch/test/watch.test.mjs

- spawn resolves the cwd workspace when it is run outside a Herdr pane (line 119)
- a valid report is checked and delivered without Herdr being present (line 136)
- final watch notice waits for fake operator typing, then sends once across watcher restart (line 163)
- a capped final watcher exits while its owned notice later delivers without another watcher (line 190)
- a report landing wakes the watcher without polling Herdr (line 215)
- a valid report also waits while the worker state is unknown (line 258)
- a mismatched report is invalid even when org check passes (line 279)
- a vanished worker delivers exited-without-report and stops (line 295)
- an initially idle worker is not terminal until it has worked (line 307)
- idle grace waits for a late report before sending a no-report notice (line 323)
- idle grace does not start before the worker has been seen working (line 351)
- idle grace notices a blocked worker immediately and keeps watching (line 369)
- idle, working, idle without a report delivers both stop notices (line 407)
- a blocked worker delivers its distinct notice (line 423)
- a valid report stays intermediate while blocked and is final only after idle (line 438)
- a refused intermediate delivery stays first in the inbox and recovers before the final report (line 460)
- a still-working worker delivers the long-running notice (line 482)
- a capped long-running notice keeps one owned ID and payload across minutes and watcher restarts (line 499)
- a Herdr outage is delivered after Herdr recovers, never reported as gone (line 586)

## Exact runtime titles moved from lanes

The other 123 lane cases cover workspace/Herdr startup, transport and configuration matrices. Merge guards retain 20 cases.

- git helpers isolate the operator's global excludes file
- open creates a lane and refuses duplicate, invalid, and unresolved inputs
- status reports distance, dirtiness, and files shared by lanes
- promote waits before the lock and completes fast-forward if memory pressure appears during validation
- rebase-check exits zero when clean and one with files on conflict
- rebase-check and status refuse a merge-bearing lane only when it is behind main
- prepare runs needed steps and skips steps whose unless path exists
- check records configured validation against the current HEAD
- check honors LANE_VALIDATE and --cmd precedence and returns a failed gate exit
- check defaults to npm test and refuses a dirty current worktree
- check runs configured prepare steps before validation
- check records signal termination using the shell exit convention
- check refuses a detached HEAD without replacing an existing gate
- check rejects unknown options and missing or empty --cmd values
- routes prints configured routes with resolved dispatch defaults
- named dispatch refuses copied metadata and reserved CLI arguments before any Herdr call
- always_args sees the canonical model and effort that dispatch emits
- always_args rejects a non-object value
- always_args rejects a list whose first token is not an option
- config attributes always_args to the file that supplied it
- config layers the nearest parent and canonical repository with attributed replacement semantics
- config escapes route names so every TSV record remains one line with three fields
- worktree roots honor parent-relative, parent-default, legacy, and caller-relative environment precedence
- home is a configuration discovery boundary
- LANE_CONFIG selects one caller-relative file and bypasses discovered layers
- long Unicode workspace labels retain graphemes and fragments within 64 code points
- a missing registered worktree names git worktree prune
- stale Herdr checkout metadata is not used for dispatch or close
- linked invocation creates labeled children under the canonical repository workspace
- open refreshes Herdr workspaces after a failed create before accepting fallback metadata
- dispatch refreshes Herdr workspaces before accepting newly visible metadata
- dispatch opens a single agent tab in the initial pane and keeps fix rounds background
- dispatch opens a one-tab lane without a project workspace (linked caller: false)
- dispatch opens a one-tab lane without a project workspace (linked caller: true)
- dispatch retains the recorded session after a rejected final rename without replay
- dispatch uses the pane POSIX shell despite SHELL=fish (rc child: false)
- dispatch uses the pane POSIX shell despite SHELL=fish (rc child: true)
- dispatch leaves earlier and concurrently opened workspace shells untouched
- dispatch retains initial tabs on environment and agent cwd failures
- dispatch waits for shell readiness beyond five seconds
- dispatch falls back to a separate agent tab for /opt/homebrew/bin/fish
- dispatch falls back to a separate agent tab for /opt/homebrew/bin/nu
- dispatch records canonical session metadata with fenced-heading, prose, inline, and empty fallbacks
- dispatch persists immutable occupant evidence as display-only optional metadata
- dispatch does not write a claim when the prompted occupant is replaced
- one exported Herdr socket-path helper supplies the Herdr client and dispatch records
- dispatch refuses unsafe registries and unreadable briefs before every Herdr call
- dispatch checks tracked registry state in the canonical checkout from a lane
- dispatch reports repository containment before an external symlink
- dispatch symlink refusal names the repository-local correction
- dispatch unwritable-sidecar refusal names both corrections
- dispatch writes no record on cwd, start, or prompt failure and reports post-prompt persistence as partial success
- independent record writes and simultaneous done markers retain all sessions
- registry reads legacy arrays, sidecar records, done markers, and localized malformed entries
- session completion refuses unignored and external registry writes
- close warns and succeeds when registry policy refuses automated metadata
- close marks exact repository topic sessions done only after git close succeeds
- git-only close with no registry creates no metadata store
- registered legacy lane paths remain authoritative after worktree_root changes
- dispatch rejects an unknown route before checking Herdr
- review requires explicit source, round, route, and bounded unique flags with exit 2
- review dispatches once and publishes all canonical verdicts after private validation
- review accepts a routing snapshot without replacing project lifecycle configuration
- review settles a completed private record before validating its final bytes
- review preserves a final finding immediately before the next section heading
- review completion admits representative validator-accepted record boundaries
- review preserves finding entries across the blank-line matrix
- review keeps malformed findings public on Codex and alternate routes without private sections
- review projects repository-relative finding locations containing spaces
- review sanitizes deterministic aliases and path forms in a bounded public projection
- review redacts syntax-shaped slash prose while retaining alias safeguards
- review redacts an absolute path inside a regex-like character class
- review sanitizes a flag-attached absolute path in finding prose
- review sanitizes a flag-attached absolute path in finding location
- review sanitizes a flag-attached absolute path in command string
- review sanitizes a delimiter-prefixed flag-attached absolute path in backtick-quoted finding prose
- review sanitizes a delimiter-prefixed flag-attached absolute path in assigned command string
- review sanitizes a delimiter-prefixed flag-attached absolute path in double-quoted finding location
- review redacts a forward-separator UNC path
- review redacts a hosted file URL
- review refuses an escaped absolute path in finding prose
- review refuses an escaped absolute path in finding location
- review refuses an escaped absolute path in command string
- review refuses a relative-looking protected location embedding an absolute path
- review refuses a two-segment flag-letter path in a protected location
- review refuses a deeper path with a flag-letter second segment in a protected location
- review refuses a drive path with a flag-letter segment in a protected location
- review preserves a command-substitution delimiter after file URL redaction
- review refuses a closing-parenthesis file URL residue that the base matcher fully redacted
- review publishes a standalone closing delimiter after file URL redaction
- review refuses a spaced-path continuation after a closing parenthesis
- review refuses a spaced-path continuation after a closing quote
- review refuses a spaced-path continuation after a closing bracket
- review refuses a spaced-path continuation after any greater-than terminator
- review refuses a spaced-path continuation after any colon terminator
- review refuses a spaced-path continuation after any less-than terminator
- review refuses a spaced-path continuation after any opening-bracket terminator
- review refuses a spaced-path continuation after any closing-brace terminator
- review refuses a spaced-path continuation after any arbitrary punctuation run
- review refuses a spaced-path continuation with an embedded absolute-path match
- review refuses a parenthesized file URL residue
- review sanitization preserves unrelated words and fails closed on ambiguous or unsafe payloads
- review projects command syntax verbatim while escaping the same characters in prose
- review escapes prose punctuation after sanitizing the unescaped payload
- review refuses an opening parenthesis after a concrete path match
- review projects every finding from the sanitized production PASS fixture
- review refuses a finding description containing a declared private identifier
- review allows private-only heading text inside a verbatim command
- review publishes exclusively, leaves normal clean-tree commands refusing, and blocks the occupied round
- review late-publication mutation exits 2 and retains both evidence files
- review renders OpenSpec, supplemental literal input, gate, and captured commit metadata
- review keeps uppercase brace tokens literal in briefs and tracked source files
- review accepts negated test-pass limits but still refuses affirmative prose claims
- review refuses malformed private evidence, incomplete output, timeout, and lane mutation
- review sends malformed completed endings to schema validation without waiting for timeout
- review contains unexpected errors when the target disappears after dispatch
- review unexpected failure after publication warns about retained public evidence
- review interruption exits 2 without a verdict or follow-up lifecycle action
- review reference describes the shipped public path and protected-location policy
- review preflight requires ignored private and trackable absent public paths
- usage exits one with no command and with an unknown command
- status exits quietly when a downstream reader closes stdout
- verify-agent mismatch control uses a fake Herdr

## Exact runtime titles moved from logic

The other 137 cases cover native waits, installed adapters, syscall/sandbox/network checks, process delivery and scheduler recovery. These seven original mixed files retain 30 cases. The R-206 correction adds 32 cases from the 12 newly mixed files listed above; all 19 files and reasons are mapped in validation-tiers.md.

- promotion validation can read Git after the old injected 15-second command deadline
- load 24 admits a start reply beyond the former fifteen-second ref-transaction deadline
- load 24 admits a prepare reply beyond the former fifteen-second ref-transaction deadline
- load 24 admits a commit reply beyond the former fifteen-second ref-transaction deadline
- Claude-only scratch installation does not require or install Codex
- real alternative sandbox denies outside, symlink, metadata, record, rename and network writes
- real filters remain functional through allocation, commit, check and fast-forward promotion
- real main-mode alternative guard protects linked shared records and leaves the native runtime writable
- bounded commands kill descendants before they can write after a deadline
- Linux network guard refuses unsupported ABIs and sends seccomp over an inherited descriptor
- declared promotion outlives fast owner, wrapper and client bounds with real descendant cleanup
- claude: a notice arriving during typing is durable, notifies without focus, and delivers intact after clearing
- codex: a notice arriving during typing is durable, notifies without focus, and delivers intact after clearing
- two quiet reads use the default three-second separation
- typing between quiet reads restarts the confirmation window
- the immediate final read catches a draft introduced after the confirmation pair
- non-idle status, unknown layout and failed reads retain capped notices
- cap retains FIFO; a later caller drains older notices once, with stable-id deduplication
- concurrent callers serialize notices without interleaving or duplicate prompts
- a definite pre-input refusal retries through the empty-composer gate
- lost acknowledgement automatically replays the same visible notice ID and journals the possible duplicate
- a lone capped notice delivers after its caller exits, without another enqueue or manual drain
- a dead sender before the prompt side effect replays pending intent with the same ID
- a dead sender after the prompt side effect replays pending intent with the same ID
- torn inbox tails fail closed and preserve their bytes
- recorded promoted workers close through the shared tidy planner
- abandoned promoted workers may close
- CLI-closed unmerged work is authorized by its Git archive, never a session done marker
- preserves open workers/tabs
- preserves unpromoted workers/tabs
- preserves dirty workers/tabs
- preserves blocked workers/tabs
- preserves working workers/tabs
- preserves unknown workers/tabs
- preserves unnamed workers/tabs
- preserves unrecorded workers/tabs
- preserves replaced workers/tabs
- preserves waiting workers/tabs
- preserves report-blocked workers/tabs
- preserves report-needs-human workers/tabs
- preserves new-open-run workers/tabs
- preserves declined workers/tabs
- preserves wrong-repo workers/tabs
- preserves mixed-pane workers/tabs
- preserves running-shell workers/tabs
- preserves session-done workers/tabs
- preserves review-file workers/tabs
- latest open fix round defeats an older reported run using the same worker name
- unknown finished sessions stay; exited watcher shell tabs use tidy-tabs
- never closes or resumes its own tab
- an interrupted open worker resumes once, and durable attempts survive a new runner
- failed prompt is logged and never replayed at the same state sequence
- unrecorded disk report, human words, other harness and absent identity prevent resume
- dry run reports close/resume plans and persists no attempts or live actions
- fresh state or record changes prevent deletion
- a run completed during the pre-input recheck receives no resume input
- a record change after clearing composer suppresses the prompt
- incomplete or failed reads never authorize any action
- one-shot logs actions, disabled config stops, invalid config refuses, and overlap refuses
- the loop rereads opt-in and shuts down with its lock removed
- no configuration defaults on and project record/main are discovered from a canonical checkout
- no configuration defaults on and project record/main are discovered from a linked preview
- no record and no Git project are quiet no-ops
- an existing housekeeping tick recovers pending notice intent while dry-run starts no delivery
- housekeeping lock cleanup refuses PID reuse before registration and retains ownership on start retries
- canonical checkout startup assertion failure stops a real schedule before removing a symlinked fixture
- installed copy startup assertion failure stops a real schedule before removing a symlinked fixture
- canonical checkout start stays idempotent after a lane is removed
- installed copy start stays idempotent after a lane is removed
- dry-run start leaves no timer process
- old interruption with forty blank rows and a final reply is rejected within a bounded subprocess
- lane code cannot --once live housekeeping even with the canonical target
- canonical code cannot --once live housekeeping from a linked target
- lane code cannot --start live housekeeping even with the canonical target
- canonical code cannot --start live housekeeping from a linked target
- lane code cannot --loop live housekeeping even with the canonical target
- canonical code cannot --loop live housekeeping from a linked target
- a record CLI override in a lane cannot pin a live schedule to removable code
- linked code remains usable for isolated dry-run previews
- an existing different-script owner never reports already-running or alters the old lock
- an existing different-record owner never reports already-running or alters the old lock
- an existing missing-script owner never reports already-running or alters the old lock
- an existing missing-record owner never reports already-running or alters the old lock
- an existing legacy owner never reports already-running or alters the old lock
- promotion cleanup inspects and closes only the requested lane workspace
- durable supervisor pane binding survives native restore, clear and compact without adapter env
- claude adapter reuses the project SessionStart entry exactly once
- codex supervisor adapter injects SessionStart without a project hook
- re-armed watcher uses its recorded dispatch recipient before the supervisor fallback
- adapter exports its known supervisor agent identity
- entry CLI is non-blocking and prints the cold start with paused housekeeping
- entry twice restarts stopped housekeeping and dead open watchers only once
- entry respects {"enabled":false}
- entry respects {"resume":false}
- cold-start brief flags a dead housekeeping process without changing its lock
- entry reports dead promotion, release and settle owners but preserves all locks and live owners
- failed cold start, housekeeping and watch print reasons and allow later recovery steps
- Claude project hook delivers supervisor entry on startup
- Claude project hook delivers supervisor entry on resume
- Claude project hook delivers supervisor entry on clear
- Claude project hook delivers supervisor entry on compact
- hook skips or explains unmarked without blocking startup
- hook skips or explains worker without blocking startup
- hook skips or explains lane without blocking startup
- hook skips or explains foreign without blocking startup
- hook skips or explains bad-input without blocking startup
- hook skips or explains missing-record without blocking startup
- hook skips or explains worker-bypass without blocking startup
- housekeeping resume recovers a confirmed dead matching owner and repeated entry adopts the new process
- claude adapter binds supervisor and supplies native hooks only to supervisors
- claude adapter binds worker and supplies native hooks only to supervisors
- codex adapter binds supervisor and supplies native hooks only to supervisors
- codex adapter binds worker and supplies native hooks only to supervisors
- entry safely handles STOP
- entry safely handles invalid-config
- entry safely handles invalid-pid
- entry safely handles reported-during-entry
- housekeeping resume preserves a live owner
- housekeeping resume preserves a invalid owner
- housekeeping resume preserves a foreign owner
- housekeeping resume preserves a missing-runtime owner
- housekeeping resume preserves a resume-disabled owner
- watch recovery handles reused identity without blocking entry
- watch recovery handles unreadable identity without blocking entry
- watch recovery handles legacy-live identity without blocking entry
- watch recovery handles changed-during-entry identity without blocking entry
- empty supervisor environment and null dispatch recipient use the supervisor fallback
- housekeeping snapshot reports reused birth without changing the lock
- housekeeping snapshot reports unreadable birth without changing the lock
- housekeeping snapshot reports legacy-live birth without changing the lock
- housekeeping resume replaces a reused PID without signaling the replacement process
- claude interactive --resume through automatic adapter preserves supervisor entry and worker guards
- claude interactive --continue through automatic adapter preserves supervisor entry and worker guards
- codex interactive resume through automatic adapter preserves supervisor entry and worker guards
- Linux watcher recovery round-trips textual identities through record set and compares changed ticks
- claude nested headless launch cannot inherit supervisor recognition
- codex nested headless launch cannot inherit supervisor recognition
