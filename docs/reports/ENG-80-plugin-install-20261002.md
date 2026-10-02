---
run: R-79
outcome: done
summary: |
  Release activation and the plugin build now install reversible machine entry,
  with native CLI receipts and removable zsh/Bash PATH snippets. Fresh native
  Herdr starts receive worker discovery; the explicit installed supervisor
  receives default housekeeping startup without project instruction edits.
  Offline checks and a real native Codex UI canary pass in scratch. The lane
  is rebased onto main; no live installation, project loop, push or publish occurred.
headline: Releases now install reversible discovery and supervisor housekeeping instructions.
blockers: []
proposals:
  - role: engineer
    title: Add entry transports beyond fresh shell PATH launches
    why: Absolute native executable paths and desktop sessions bypass PATH adapters, and remote sessions require installation on their host or a harness entry hook; broader entry needs explicit policy transport and its own acceptance proof.
learnings:
  - Native Herdr agent start injects the bare harness command into the pane shell, so installed shell PATH transport intercepts a fresh launch without harness user configuration.
  - Shell-started native Codex is reported as codex and idle but does not expose the managed agent start interactive_ready field; the canary checks actual agent status and canonical cwd instead.
  - Archive builds must suppress entry installation until the final release directory exists, or wrappers retain a renamed partial path.
  - Herdr manifest build runs installation, while local linking skips it; restore machine entry before Herdr uninstall removes the plugin checkout.
artifacts:
  - Commit subject Install reversible project entry with Monitor releases on lane/plugin-install
  - Commit subject Prove default plugin installation without entry overrides on lane/plugin-install
  - herdr/entry-install.mjs; herdr/release.sh; herdr/install.sh; herdr/supervisor.sh; herdr-plugin.toml
  - discovery/install.mjs; discovery/launch.mjs; discovery/policy.mjs; test/plugin-install.test.mjs
  - acceptance/plugin-entry.mjs; acceptance/run.mjs; herdr/README.md; discovery/README.md; housekeeping/README.md; acceptance/README.md
  - docs/reports/ENG-80-plugin-install-evidence-20261002/summary.json and screen.txt
  - /private/var/folders/st/gcpbkfdj1hbb618vgcf59j3w0000gn/T/monitor-plugin-entry-nbAvcP/evidence
  - /private/tmp/eng80-r79-baseline-bounded.log; /private/tmp/eng80-r79-after.log; /private/tmp/eng80-r79-acceptance-tests.log; /private/tmp/eng80-r79-default-install.log
decisions:
  - text: Implement final-directory entry installation and share that installer with the manifest build.
    category: design
    why: Archive builds stay inert and immutable policy paths survive rename, upgrade, rollback and restore.
  - text: Treat fresh native Herdr starts as workers and reserve supervisor policy for an explicit installed launcher.
    category: security
    why: Display-only managed-start receipts cannot select roles or suppress discovery; assigned Monitor sessions retain their explicit bypass and workers never receive a housekeeping start instruction.
  - text: Use dedicated adapter files and removable shell snippets rather than replacing native CLIs.
    category: design
    why: Native executable receipts stay stable and startup content remains recoverable; changed bytes refuse preflight before activation or restoration.
questions: []
challenges:
  - The native proof witnesses policy delivery and actual Codex startup, not a reasoning turn or a running housekeeping schedule; lane workers are forbidden to start that loop.
  - GitHub download/build staging, real plugin registration, console dependency installation, launchd, absolute executable paths and desktop or remote entry are outside this canary's coverage.
  - Herdr uninstall has no documented manifest cleanup callback; the supplied restore-entry action must run before uninstall, or release users must use release restore.
---

The installer supplies the workflow to an unrelated Git project without
AGENTS.md, CLAUDE.md, .org, .lane.json or housekeeping configuration. It creates
worker entry through the existing bounded adapter. Supervisor entry stays in
the canonical checkout and now explicitly directs its agent to start the
default project schedule using the immutable release's housekeeping command.
The manifest exposes that explicit supervisor pane instead of an unrestricted
housekeeping-start action.

Release builds install dependencies only. Activation preflights entry and
launcher destinations, pins wrappers to the final release, and retains the
native executables. Re-activation preserves the genuine previous release.
Rollback rewrites entry for that previous release; rolling back to a legacy
release without discovery removes entry. Restore removes the managed wrappers
and snippets and preserves the original startup bytes/modes and unrelated
later edits. Tests exercise changed adapters, changed snippets and planted
symlinks refusing before pointer or removal changes.

Validation:

- Baseline npm test: 465 passed, zero failed, four skipped.
- Post-change npm test after rebasing: 469 passed, zero failed, four skipped.
- Offline acceptance boundary suite: all 51 passed.
- Installation suite, including the additional no-overrides case: all five passed.
- Native canary on the committed implementation: PASSED, cleanup errors empty.
  A real `herdr agent start --kind codex` returned an interactive-ready worker
  in its newly created lane. The installed supervisor script then opened native
  Codex in the canonical checkout. Both native-boundary receipts contain policy
  from `home/monitor/releases/candidate/discovery/policy.mjs`; the supervisor's
  receipt contains the default housekeeping `--start` instruction. The canary
  restored adapters/startup files and closed both workspaces it created.
- Shell syntax and git whitespace checks passed. The required final step is
  `lane check` after this report's commit; its `.lane/gate.json` records the
  final committed HEAD and result.

The native canary uses a dummy API credential and a macOS kernel boundary that
denies network and permits native UI writes only in scratch and terminal
devices. It sends no prompt, calls no model, installs nothing on the operator's
home, and starts no housekeeping schedule. Its full policy receipts, command
log, ownership receipts, distribution and scratch project are retained under
the artifact path above. Earlier canary attempts exposed harness parsing and
status-field assumptions; those were corrected, and their owned workspaces and
scratch installations were restored. Sandbox-limited baseline processes were
stopped and replaced by the passing bounded baseline with fixture process access.

The coverage limit is explicit: absolute native binary launches need a supported
harness SessionStart/policy hook or an explicit launch adapter; desktop entry
needs its application's supported instruction transport; remote sessions need
host-side installation or that host's entry hook. Other shells, existing shells
that have not loaded the snippets, aliases/functions and later PATH/ZDOTDIR
overrides are not covered. Running sessions and supervisor-started schedules
retain their own lifetime when entry is restored or rolled back. The documented
[Herdr manifest](https://herdr.dev/docs/socket-api/) declares builds, actions,
panes and runtime hooks but no uninstall callback, so the plugin's explicit
restore action precedes Herdr's [uninstall command](https://herdr.dev/docs/cli-reference/).

No bch-cloak files, shared lane configuration, activated release, native user bin,
launchd or harness user configuration changed. `contrib/settle-watch.mjs` is
unchanged. All Herdr mutations targeted workspaces created by this canary.
