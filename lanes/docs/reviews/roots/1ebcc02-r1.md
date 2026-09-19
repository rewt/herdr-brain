# Review r1 — roots-config (development-root configuration)

Reviewed commit: 1ebcc02a6e96d62b0a49ce735abe5911d90d7143

Verdict: **READY**

Independent review of the `lane/roots` implementation against
`openspec/changes/roots-config/` (proposal, design, tasks, delta spec), the synced
`openspec/specs/root-configuration/spec.md`, `AGENTS.md`, and `openspec/README.md`.
Every requirement and scenario in the delta spec is implemented and covered, and the
design's path matrix and `LANE_WORKTREE_ROOT` compatibility rule behave as specified
under direct probing. No tracked file was modified by this review. All findings are
minor or smaller; none blocks promotion.

## Findings

**minor-1 — the "nearest parent only" scenario is not discriminated by its test**
(`test/lane.test.mjs:601`). The grandparent and home fixtures define only `main`, which
the repository layer overrides anyway, and the parent's distinguishing key is defined in
no other layer, so an implementation merging every ancestor would still pass every
assertion. The behavior is correct — a probe with a non-home grandparent defining
`seams_doc` and `main` showed neither key contributing — but the scenario is asserted by
construction rather than observation. Fix: give the grandparent a key nothing else
defines and assert its row stays at the default.

**minor-2 — the board bridge reuses the public `LANE_CONFIG` override**
(`lane.mjs:766-788`). Resolved `main`/`registry` reach the isolated board through a temp
file exported as `LANE_CONFIG`. That variable is inherited by every descendant and names
a file deleted when the board exits. Nothing breaks today (the board only runs `git` and
`ps`), but board-actions rewires the UI to invoke lane CLI interfaces; a `lane` process
started from the board would then resolve a two-key config — no routes, no
`worktree_root`, no `validate` — instead of the layered one. Fix: pass `--main` and
`--registry` flags, or dedicated `LANE_BOARD_*` variables, rather than the
operator-facing override.

**minor-3 — temp config directory leaks on interrupt** (`lane.mjs:766,787`). Cleanup is
in a `finally`, which does not run when SIGINT ends the interactive board — the normal
way an operator stops it. Each interrupted run leaves an empty directory holding a 0600
JSON file in the system temp directory. No secret is exposed. Fix: a SIGINT/SIGTERM
handler, or the board package's own runtime directory.

**minor-4 — the `lane board` behavior change is undocumented** (`lane.mjs:776-783`).
The board is now started against the canonical checkout and consumes the merged
`registry` and `main`, so running it inside a lane worktree shows the canonical
repository and honours an inherited registry. The Board section of `docs/REFERENCE.md`
still reads as though the board reads the repository file directly. One sentence closes
it; the change itself is in scope and is the right call for consistency.

**minor-5 — untested branch: explicit config file without `worktree_root`.** The design
states the legacy default applies; the explicit-selection test only exercises a selected
file that defines the key. Verified correct by probe, so this is a coverage gap.

**minor-6 — submodule checkouts resolve configuration from the superproject's modules
directory** (`lane.mjs:41-47`). The canonical root comes from git's common directory,
which for a submodule points inside the superproject. That value previously chose only
the worktree basename; it now also selects the configuration file, so a submodule's own
file is ignored and the upward search can reach the superproject's. Canonical identity
is deferred to the next phase, so this is a note — worth a limits line, or a guard.

**nit-1 — TSV keys are unescaped while values are JSON-encoded** (`lane.mjs:285`): a
route name containing a literal tab yields a four-field row. Route names are
operator-chosen and the existing `routes` command has the same property.
**nit-2 — raw stack instead of `fail()`** (`lane.mjs:766-770`) when the board temp file
cannot be created.

**Observations, accepted.** `validate` and `prepare[].run` are shell commands that may
now come from an ancestor directory's file rather than the repository's tracked one —
the intended sharing model; a reference sentence advising that shared configuration
belongs only in directories the operator controls would make the widened trust boundary
explicit. No new shell interpolation was introduced: only `validate`, `prepare[].run`
and `check --cmd` reach a shell, all pre-existing, and resolved paths reach git through
argument arrays. `lane check` inside a lane now uses the canonical file, so a lane
editing its own configuration validates with the integration branch's settings until it
promotes — the intended parity, documented. Path comparisons are not realpath-resolved,
so a home directory reached through a symlink would fall outside the home-bounded
branch; realpath identity is deferred by design and listed as a limit.

## Requirement results

| Requirement | Result |
| --- | --- |
| Bounded two-file configuration | Pass. Nearest parent plus repository; home and above excluded (boundary probed; test under-discriminates, minor-1). Repository prepare/dispatch/engineer replace their parent values, parent reviewer retained, no cross-file concatenation. A linked invocation resolves the canonical config; explicit selection bypasses both layers. Malformed, wrongly typed, unreadable and missing selected files exit nonzero naming the file, with no branch created |
| Worktree-base precedence | Pass. Relative keys resolve against their own defining file; the environment value stays the final container with no repository segment; parent `.worktrees/<repo>` and the legacy home default both observed — all five matrix rows |
| Explain resolved configuration | Pass. Sorted rows, JSON values, routes expanded per name, env/default/file sources, derived default naming the parent file, exit 0, no command execution, no Herdr call; usage text and README command table both assert the command |
| Preserve foreign paths and existing work | Pass. An ordinary directory and another repository's worktree are refused untouched with no branch; status, dispatch, check, promote and close keep using the registered path after the root changes |
| Shared rules and OpenSpec workflow | Pass. Built-ins, Node 20, offline temp fixtures with cleanup, short README with detail in the reference; checkbox set, ADDED block synced verbatim, nothing else under `openspec/` changed |

## Test evidence

- `npm test` with Herdr installed: 58 tests, 58 passed, 0 failed, 0 skipped (~11.2 s).
- `LANE_TEST_NEGATIVE_CONTROL=1 npm test`: 58 tests, 0 passed, 58 failed (~8.3 s) —
  every test, including all nine new ones, reaches its negative-control assertion.
- Suite with the Herdr executable removed from PATH: 57 passed, 0 failed, 1 skipped with
  the explicit reason "herdr is absent; herdr-dependent tests are skipped".
- Strict OpenSpec validation, telemetry disabled, concurrency one: 12 passed, 0 failed,
  including the new current spec and this change.
- `git diff --check` against the integration branch: clean. An added-line scan for host
  or private text found only a fixture-local socket path forcing the board offline.
- Failing-test-first reconstruction: the reviewed test file run against the pre-change
  CLI fails eight of the nine new tests plus the usage/README discoverability assertion;
  only "registered legacy lane paths remain authoritative" passes, a genuine preservation
  control. This matches the report's "57 tests, 50 passed, seven new failures". Three
  further failures there are artifacts of not staging the board package.
- Probes in throwaway temporary repositories: an identity directory holding only `{}` two
  levels above a repository activates `<identity>/.worktrees/<repo>` and names that file
  as the source; a non-home grandparent contributes nothing; an explicit configuration
  file without the key falls back to the legacy default; and a fake Herdr executable
  placed first on PATH is never invoked by the explain command.
- Environment: Node.js 20.19.4 and git 2.54.0, matching the implementation report.

## Limits

Live Herdr dispatch, workspace creation, and labels were not exercised — the suite keeps
Herdr off the fixture PATH, so lane creation always took the git fallback. The
interactive board was not driven with a real terminal, so minor-2 and minor-3 were
reasoned from the code. Linux and Windows hosts, case-insensitive paths, a symlinked
home, an actual submodule checkout, a permission-denied regular file, and concurrent
creation races were not tested. No promotion, push, archive, or gate run was performed
here, and a review record is evidence about one commit, never a promotion gate.
