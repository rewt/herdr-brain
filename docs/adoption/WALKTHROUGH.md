# Scratch adoption walkthrough

The entry point is [ADOPTING.md](../ADOPTING.md). This recipe is its bounded,
repeatable mechanical walkthrough; it needs no private project, record, user
settings or agent history. [rehearse.mjs](rehearse.mjs) automates the commands
below, captures every child command/output and fails if any required receipt is
missing. It is outside `npm test` and never calls a model.

## Repeat it

Prerequisites: all normal product requirements from the guide, including
`python3`, plus the walkthrough tools zsh, `tar` and the BSD
(macOS) or util-linux `script` PTY tool. macOS/Linux arm64/x64 use bundled lifetime
owners without a C compiler. The runner verifies their checksums before setup;
Python remains required for release plugin discovery and restoration. Native Codex must support
`sandbox --permission-profile`. Pass the actual native executable, rather than a
Monitor PATH wrapper. No native credentials or user configuration are needed.

```sh
ORG_ACTOR=adoption-rehearsal node docs/adoption/rehearse.mjs \
  --native-codex /absolute/path/to/native/codex
```

Pinned console and MCP dependencies are installed through the real release
build's `npm ci`, with all cache/log writes in the fresh home. On an offline
machine with those tarballs already cached, add `--npm-cache /path/to/npm-cache`.
The runner copies only integrity-selected lockfile content blobs into scratch,
reads no authentication/configuration files from the cache, and forces offline
npm. It never writes the supplied cache. Missing tarballs fail explicitly.

The runner creates a new product repository with two scratch tags and a separate
parent containing an unrelated hello project. Its child environment selects a
fresh HOME, shell files, native runtime home, record actor, Git identity and cache.
It strips inherited project/entry/Herdr/account variables. It does not change the
operator's environment, canonical checkout, installed release or machine config.
Release registration uses a local Herdr fixture with a scratch registry: the real
release script calls Python to discover, re-link and unlink that registration.
The fixture refuses linking over an existing entry, and restore must remove it.
Compiler/Python version checks are captured in `prerequisites.txt`; actual worker
validation also compiles and links the product's native lifetime owner.
Console session lists and housekeeping use an empty, list-only Herdr fixture;
they never contact the operator's server. The native stand-in is a scripted coding
worker, not a model. It captures the
actual injected policy and extracts that policy's exact bounded client prefix.
When validation asks it to run `sandbox`, it forwards unchanged arguments and the
product's readiness descriptor to the actual native Codex provider.

## Guide commands and receipts

| Step | Commands/behaviour from the guide | Required receipt |
| --- | --- | --- |
| 1. New project | Initial Git commit, an ordinary package `test` script and a real assertion for Hello | No `.org`, `.lane.json`, `AGENTS.md` or `CLAUDE.md` before entry; no parent workflow config |
| 2. Build | `bash herdr/release.sh build adoption-a` | Pinned console/MCP installs, immutable final archive; no shell entry installed by build |
| 3. Activate | `bash herdr/release.sh activate adoption-a`; `status` | Scratch launchers, reversible shell snippets and Python-discovered registration in a local fixture; launchd skipped |
| 4. Fresh entry | New zsh shell, `command -v codex`, `command -v monitor-codex`, then `codex` in an actual PTY | Adapter found automatically; real injected worker policy names a separate lane/shared record and forbids housekeeping |
| 5. Actual task | Policy client `start 'Change the greeting to Bonjour and validate it'`; read returned brief | A task/run/report binding from actual record; no invented IDs |
| 6. Complete | Edit greeting/assertion, write/check report; `commit`, `check`, `promote`, `finish` | Native sandboxed `npm test`, clean same HEAD on main/lane, actual fast-forward, immutable ingested done report; routing question remains unanswered |
| 7. Observe | `console/app.mjs --modern --folder PROJECT --print 100x34`; `supervisor/supervisor.mjs brief` | Rendered console and read-only supervisor cold start from the newly populated record |
| 8. Housekeeping | `housekeeping/housekeeping.mjs --once --dry-run --state-dir PROJECT/.lane/housekeeping-preview` | Scratch preview with an empty read-only Herdr fixture; no project loop or live pane mutation |
| 9. Reviewed cycle | `node acceptance/supervisor.mjs CANDIDATE` as documented in the supervisor/acceptance references | Actual record/watch/settle/fix/review/queue/close mechanics, including stale notices and duplicate receipts; Herdr/model work is scripted |
| 10. Upgrade | Build/activate `adoption-b`; `rollback` | Exact `current` and fixture plugin paths change to B, then return to A; no active machine release touched |
| 11. Restore | `bash herdr/release.sh restore` | Fixture registration unlinked through Python-backed discovery; original scratch `.zshrc` bytes and mode restored; originally absent shell files/adapters/launchers gone; committed project and record preserved |

Automatic fresh entry requires terminal stdin/stdout. `zsh -ic codex` with piped
stdio deliberately passes through; use an actual pane or the runner's PTY. This
was caught while proving the recipe. The scripted worker's first versions also
needed an empty scratch CODEX_HOME, validation fd 3 forwarding, and the supported
`record status --json` command; those are harness corrections, not product fixes.
The routing question's pending state is checked by absence of a closed/answer
receipt, rather than expecting a needs-human *report* status on a question item.

Every child has a finite timeout (at most four minutes; product checks also have
their own shorter bounds). Failures keep their scratch evidence/lanes for
inspection. The runner never deletes user history or another project's state.
Success keeps the two scratch roots and final evidence too; remove them only when
you have finished inspecting them. The JSON result names those exact roots.

## Native Herdr transport proof

The separate command in the guide runs `acceptance/plugin-entry.mjs` from an
authorized Herdr pane. It starts an isolated named server with a scratch home,
uses Herdr's actual plugin-install/build/move path, starts the actual native
Codex UI with no prompt/network, witnesses the worker policy, then opens the
manifest's supervisor pane from the unrelated project workspace without a cwd
override. It verifies the stable relocated runtime and canonical project policy.
It restores shell bytes, removes entry, uninstalls its plugin, closes only its
created workspaces and stops only its own named server. It starts no housekeeping
loop. This complements the scripted task's integration proof.

## Recorded evidence, 2026-10-02

Native canary: **PASSED**, with no cleanup errors.

- Evidence: `/private/tmp/e80-native-p045cS/evidence/summary.json`.
- Own named server: `eng80-entry-33318`; stopped after owned workspace cleanup.
- Native Codex: 0.160.0 on macOS; Herdr 0.8.2.
- Candidate code: the lane's base `a49d6be`, archived into a scratch product.
- Proved real plugin install/build/move, native worker start, manifest supervisor
  entry, stable policy runtime, exact shell restoration and plugin uninstall.

Original automated task/build/rollback: **PASSED** (before the corrective
compiler/Python preflight and local release-registration fixture were added).

- Evidence: `/private/var/folders/st/gcpbkfdj1hbb618vgcf59j3w0000gn/T/monitor-adoption-NAqVuu/evidence/summary.json` (the full bounded child-command transcript is
  `commands.json` beside it).
- Project: `/private/var/folders/st/gcpbkfdj1hbb618vgcf59j3w0000gn/T/adopter-projects-MijJ5J/hello`; its separate parent contained no workflow settings.
- Run `R-1` on `ENG-1`; actual bounded start/commit/check/promote/finish.
- Integrated clean commit: `f52076bfae13d250f9ce553d8881f8f7b3ccc110` (Hello → Bonjour and the matching test).
- The native sandbox actually ran `npm test` for check and promotion; record
  ingestion preserved the unanswered routing question. No tracked workflow
  config was needed.
- Console frame: `1718` bytes; supervisor cold start and
  dry-run preview captured; the scripted reviewed cycle passed through finding,
  watched correction, PASS, queued fast-forward/closure and duplicate notices.
- Real pinned console/MCP `npm ci` ran using only integrity-selected cached
  tarballs copied into the scratch cache. Both scratch release builds completed.
- Upgrade A → B, rollback B → A and restore all completed; original shell bytes
  and mode matched, installed adapters/launchers were removed, and the project
  commit/record remained.

Earlier failed harness attempts remain in their own scratch roots; no product
code was changed to get the proof green. The final passing recipe is the one
linked above.

## Corrective evidence, 2026-10-02

Corrective automated rehearsal: **PASSED**, using the candidate at `c2721fd`
("Keep scratch release registration fixture across observation steps").

- Evidence: `/private/var/folders/st/gcpbkfdj1hbb618vgcf59j3w0000gn/T/monitor-adoption-mhl0eN/evidence/summary.json`;
  `commands.json`, `prerequisites.txt` and `herdr-commands.jsonl` beside it retain
  the bounded commands, host toolchain checks and scratch registry calls.
- Fresh unrelated project: `/private/var/folders/st/gcpbkfdj1hbb618vgcf59j3w0000gn/T/adopter-projects-0zFm4Y/hello`.
  Run `R-1` integrated commit `00576c07258474eccf63fc7f04bcfda44077ea97`.
- Host dependencies: Apple clang 21.0.0 at `/usr/bin/cc`, Python 3.14.7 on PATH;
  the worker's native sandbox checks also compiled/linked the actual lifetime
  owner and ran the project's assertions. The scratch HOME has no user settings;
  the compiler, Python and native executable come from the host installation.
- Release plugin registration used the local fixture with real Python-backed
  discovery: A linked, A unlinked/B linked, B unlinked/A linked, then A unlinked
  on restore. Final registration was absent, shell bytes/mode matched, scratch
  entry/launchers were gone, and the integrated project/record survived.
- The first corrective attempt reached integration but its console list-only
  fixture leaked into later release steps. The final runner scopes that override
  to the console child; the fresh passing attempt exercises all release receipts.

## Limits

The native canary substitutes a local repository for GitHub transport and omits
npm downloads. The task rehearsal installs pinned dependencies and uses actual
native validation, but its coding worker and reviewed-cycle Herdr/reviewer work
are deterministic fixtures. No proof here claims model judgment, public GitHub
availability, live independent-review quality, Linux/desktop/remote entry or a
release-ready gate. The full real-session acceptance gate remains a separate
operator/supervisor release step, as the adoption guide says. Nothing is pushed,
published or activated on the operator's machine.
