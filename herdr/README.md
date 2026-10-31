# Machine releases

The product has no npm dependencies. Node.js 20+, Git, Bash, tar and npm are
needed to build a release; npm runs the offline test scripts without installing
packages. Herdr and native Codex or Claude supply agent panes when used.

See the [routine/stable model and release-suite plan mapping](../docs/routine-release-model.md)
for the operator decision, live-acceptance rationale and ENG-1125 slices 1–5.

```sh
bash herdr/release.sh build TAG --landing-checks  # routine runtime update; full coverage UNRUN
bash herdr/release.sh ship TAG --landing-checks   # routine build + activate + check; rollback on failure
bash herdr/release.sh offer TAG /absolute/offer-evidence.json  # qualify a sealed consumer candidate
bash herdr/release.sh build TAG --live           # optional full offline + live diagnostics
bash herdr/release.sh build TAG                  # optional full offline preparation; live acceptance UNRUN
bash herdr/release.sh activate TAG
bash herdr/release.sh ship TAG   # build + activate + check; rolls back on failure
bash herdr/release.sh rollback
bash herdr/release.sh status
bash herdr/release.sh pin TAG /canonical/project  # commit .herdr-release.json to accept
bash herdr/release.sh unpin /canonical/project   # commit to return to current
bash herdr/release.sh attest LEGACY_TAG /path/to/summary.json
bash herdr/release.sh pin-status /canonical/project --json
bash herdr/release.sh exec supervisor/supervisor.mjs brief
```

Only the canonical supervisor releases and activates. Workers land finished owned
source, run only new or affected checks once and hand off one asynchronous capped
diff/evidence review, then fix forward. Tests, review and reports do not gate main.
The supervisor uses `ship TAG --landing-checks` for routine runtime updates.
Activation moves the retired Brain watch LaunchAgent
(`~/Library/LaunchAgents/com.rewt.herdr-brain.plist`) aside after stopping it, so no
manual step precedes the first release.

Builds and ships launched inside Herdr automatically add a background
`Release TAG · running` tab under the **canonical project workspace**, including
when the caller is a lane or a detached process with inherited Herdr context.
The tab follows the build log (including whichever checks actually run),
then keeps the output and a `passed`, `failed` or `interrupted` title. It uses the
existing workspace; no Git worktree, agent, extra gate or suite is created.
The release still executes once in its original process cwd and isolated checkout.
Its command starts before the display connects. Missing Herdr context, a closed
canonical workspace or a native refusal leaves execution and its result intact;
display errors are retained without retrying or targeting another pane.

For standalone full-suite or live-check commands, the release coordinator can use
the same foreground wrapper (the existing authorization and release policy apply):

```sh
node herdr/visible-run.mjs run --repo /canonical/herdr-brain --label 'Full suite' -- npm test
node herdr/visible-run.mjs run --repo /canonical/herdr-brain --label 'Live checks' -- node acceptance/run.mjs --candidate /candidate/checkout --source /canonical/herdr-brain
```

Run from the intended command cwd; `--repo` selects only the display's parent.
Labels and inherited workspace IDs never select a foreign project. Log, actual
command exit/signal and display attachment details stay in
`GIT_COMMON_DIR/visible-runs/run-*`. The view only reads those files. Closing it
does not stop the command; loss of the producer without a result displays
`result unknown`. These presentation files never replace validation receipts,
change release readiness, replay an existing attempt or attach to a running build.
Outside Herdr, releases keep their original output path and behavior.

Both build modes capture one tagged commit, freeze its validation policy, create a
genuine isolated checkout and copy exactly `git archive COMMIT` into
`releases/TAG.partial`. They verify committed payload equality, runtime inventory
and modes, seal read-only, verify the complete bundle and publish without rebuilding
an existing tag. Identity, activation, rollback and pin guards remain in force.
A failed or interrupted build retains its original checkout, evidence and partial
directory; inspect it rather than retrying or replacing an uncertain attempt.

`build TAG --landing-checks` skips the offline gate and live acceptance. Its sealed
`.release-validation.json` records `releaseMode: "routine"` and
`validation.routine.fullCoverage: "UNRUN"`, without inventing an execution receipt.
The manifest records `release: {"kind":"routine","fullCoverage":"UNRUN"}` and
`acceptance: {"ran":false,"ready":false}`. It is usable for routine global
activation and requires a recorded consumer offer before stable adoption or a
project pin. The flag cannot be combined
with `--live`, `--coverage` or `--live-coverage`; even an arbitrary tag name cannot
turn it into a stable release. `ship TAG --landing-checks` keeps the installed
launcher check and automatic rollback on failure. This uses the producer's existing
landing evidence; it neither replays landing checks nor certifies their completion.
Keep their actual scope and failures in the owning record. A missing check stays
unproven and does not become a new activation readiness gate.

Stable consumer offers require the exact candidate's canary pass (installed
mechanics, bounded probation and actual real-work soak), landing tests and
corrected Majors. Full-suite runs, including absent or failed runs, are
non-blocking background information under HUM-43. Each consumer project decides
activation through its existing controls. Routine updates keep landing checks,
fix forward, immutable bundles, rollback and separation from pinned consumers.

Without `--landing-checks`, build runs
the `release` command and its `timeout_seconds` (and optional
`idle_timeout_seconds`) from the snapshot's `.lane.validation.json`, falling back
to `npm run test:release` when no release command is declared. The foreground
gate bounds the command and its children. `--coverage FILE` retains the existing
`release-full-coverage/v1` verifier for reconciled complete evidence, without
replaying a green whole command. `--live` adds the actual live acceptance harness
after the offline gate or verified continuation; it is never run in lanes.
Optional `--live` retains its actual summary for the exact commit in the release
manifest. It does not qualify a newly built candidate for a consumer offer. Offline builds
explicitly record acceptance did not run. `attest` supplies write-once installation
evidence only for older protocol-1 bundles without an acceptance record.
Every release retains `contrib/settle-watch.mjs` and `lib/cli-help.mjs`.

Activation updates `previous` and `current` and installs project-aware resolvers
for `~/.local/bin/{org,record,lane}`. A committed canonical `.herdr-release.json`
selects a complete, acceptance-READY immutable bundle; unpinned projects keep using `current`.
See [release pins](RELEASE-PINS.md) for acceptance, rollback, compatibility,
operation inventory and the deferred BCH adapters. Existing regular
files are refused before switching. Repeating activation preserves the previous
release. Rollback selects it. The operator controls activation and publishing.
Home-policy admission retains its READY requirement. For newly built bundles,
a recorded consumer offer supplies qualification; routine activation alone does
not qualify adopted projects that require READY `current`.
The retired `rewt.herdr-monitor` plugin is unlinked if still registered; a failure
warns. Complete releases and routing generations are retained; there is no pruning.

## Consumer offer evidence

The canonical release coordinator runs `bash herdr/release.sh offer TAG FILE`
after building the candidate with `--landing-checks` and receiving A2/A3/A4
qualification. This command only records an offer for the sealed bundle. It does
not activate, alter a consumer pin, execute suites or deliver the offer to another
project. The consumer owner accepts, defers or declines through its own controls.
Existing bundles retain their old admission contract; new builds require an
offer even when optional full/live preparation passed. Failed or absent broad
suites never block this command. Original attempts and rollback remain intact.

`FILE` is a plain JSON packet with these fields:

| Field | Required content |
| --- | --- |
| `schema` | `consumer-release-offer/v1` |
| `commit`, `manifestSha256` | Full exact bundle commit and SHA-256 of its sealed `.release-manifest.json` |
| `canary` | `status: "PASS"`, explicit `scope`, and nonempty `evidence` references covering `stage: "installed"`, `"probation"`, `"soak"` (A2/A3/A4) |
| `landing` | `status: "PASS"`, selected/affected `scope`, and nonempty `evidence` of actual passing lane checks |
| `majors` | Explicit applicable-review `scope`, `unresolved: []`, `corrections: [{item, scope, evidence}]`; an empty corrections array means no applicable Majors, attested in the scope |
| `fullSuite` | Optional `{status: "UNRUN" | "FAIL" | "PASS" | "UNKNOWN", details: "actual result and retained evidence locations"}`; absence records UNRUN |
| `attestationDigest`, `attestationSeq` | Exact packet reconciliation recorded as described below |

Each evidence reference is `{file: "/absolute/plain/file", sha256: "..."}`.
Canary references also name their stage. Canary semantics and the complete
applicable Major inventory are reconciled by the coordinator, not inferred from
opaque filenames. The coordinator verifies the installed candidate, genuine
soak, all-run/rescue accounting, holds and review corrections through A2/A3/A4;
this command consumes their evidence and does not implement the canary itself.
Landing and Major-correction evidence must be completed `lane-validation/v1`
receipts with `executed: true`, exit zero, no signal/timeout, Node v20.19.4 and a
source head ancestral to the candidate. Each such reference also supplies the
exact sorted `changedFiles` since that head and an explicit `reconciliation`
explaining why the selected passing scope still applies. Preserve original red
attempts and name the correction item; never replace a failure with a green label.

Compute SHA-256 of `JSON.stringify(packet)` **before** adding `attestationDigest`
and `attestationSeq`. Using the owning project's source record command, record
`note ITEM 'Consumer release offer reconciled: DIGEST' --decision`, then add that
note's event sequence and digest to the packet. The decision binds the exact
candidate, canary, selected landing scope, applicable Major inventory and full
suite's informational status. It grants no native or outward authority.

The verifier reads and hashes retained evidence and the exact record note once.
`RELEASE_HOME/offers/TAG.json` retains the packet bytes/digest, disposition and
full-suite information, read-only and write-once. Later admission verifies this
captured record against the sealed manifest; it does not depend on disposable
producer worktrees or rerun any checks. Altered offer records refuse admission.
Offer acceptance does not relabel `.release-acceptance.json`, invent a full-suite
PASS or change the bundle. Missing or invalid offers remain unqualified.

Set `HERDR_MONITOR_HOME`, `HERDR_MONITOR_BIN` and `HERDR_MONITOR_REPO` to choose
release, launcher and source locations. `HERDR_MONITOR_PLIST` selects the retired
plist check, and `HERDR_BIN_PATH` selects the Herdr CLI. Tests always supply scratch
homes and fake Herdr commands. No release command installs dependencies, native
hooks, harness wrappers or machine permissions.

Older installations may still contain `before/`, entry wrappers and shell PATH
blocks. Machines that activated an entry-installing release need this one-time
operator cleanup; current releases keep no restoration receipts:

1. Remove the managed wrappers in `~/.local/share/herdr-monitor/entry/bin` (or the
   former `HERDR_MONITOR_ENTRY_BIN` under a custom `HERDR_MONITOR_HOME`).
2. Remove the block between `# >>> Herdr Monitor entry >>>` and
   `# <<< Herdr Monitor entry <<<` from `.zshenv` and `.zshrc` under
   `${ZDOTDIR:-$HOME}`, and from `~/.bashrc` and the selected `~/.bash_profile`,
   `~/.bash_login` or `~/.profile`.
3. Remove only Monitor's `SessionStart` hook groups that invoke
   `herdr/native-entry.mjs` from `${CODEX_HOME:-~/.codex}/hooks.json` and
   `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, preserving other hooks and settings.

The old bin's `.monitor-shell.json` and `.monitor-native-hooks.json` receipts name
the exact destinations if they changed. Keep those receipts until cleanup is
complete, then open a fresh shell and confirm `codex` and `claude` resolve to the
native launchers. Preserve existing records and lane worktrees.
