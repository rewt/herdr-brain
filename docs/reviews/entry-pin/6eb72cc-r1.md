**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 6eb72ccc38f8905403353eae959cf116bdfd7d49
Topic: entry-pin
Round: 1
Review ID: lr-49f944e130ec1e2615775a6c61e880f3
Base branch: main
Base commit: 1032c6a599daeb443ed194ce84dd2327216c58cd

## Findings
- [Moderate] lib/cli-help.mjs:23 - cliHelp compares path.resolve of process.argv\[1\] with the module's import.meta.url, but Node keeps argv\[1\] as the unresolved launcher path while the main module URL is the realpath, so any symlinked launch misses the help branch; herdr/release.sh installs \`lane\` as a symlink to the \`current\` release symlink, so the installed \`lane --help\` falls through to the default case of lanes/lane.mjs and exits 1, which misses the ask that every module CLI prints usage and exits 0 on --help; Fix: compare fs.realpathSync of process.argv\[1\] (inside try/catch) with fileURLToPath(url), and add a cli-help case that invokes lanes/lane.mjs and brain/bin/brain.mjs through a symlinked launcher in the scratch directory
- [Moderate] discovery/adapters/claude.mjs:25 - the default Codex validator is now resolved eagerly before the passthrough decision, so when no codex is on PATH and the codex-fallback receipt path is gone (exactly the deleted-old-release case, or a pane with a reduced PATH), the installed \`claude\` wrapper that shadows native Claude exits 1 even for passthrough invocations such as \`claude --version\` that never use the validator; previously the absolute validator was only consumed on entry; Fix: resolve the Codex validator only on the entry path (or degrade to validator auto with a stderr note when lookup fails) and change the test/entry-upgrade.test.mjs missing-codex assertion to require that passthrough still works while entry reports the missing validator
- [Moderate] discovery/native-binary.mjs:19 - launch-time lookup returns the first same-named executable on PATH before the receipt, so explicit selections (HERDR\_MONITOR\_CODEX and HERDR\_MONITOR\_CLAUDE, install.mjs --codex and --claude, and a user-supplied monitor-codex --binary which is overwritten after parsing) silently become last-resort fallbacks, while docs/ADOPTING.md still calls them native executable overrides and herdr/README.md says entry resolves natives from PATH and retains their receipts; the acceptance canaries had to reorder PATH to keep their own transport, which shows the regression; Fix: record in the receipt whether the native was explicitly supplied and launch an explicit selection first while it remains executable (PATH lookup only when it is absent), never override a command-line --binary, and update docs/ADOPTING.md and herdr/README.md to describe launch-time resolution and the remaining role of the receipt
- [Moderate] docs/reports/ENG-229-entry-pin-R-271.md:56 - the report calls the failing concurrent-worker case in acceptance/test/live-session.test.mjs (a file this lane edits, and whose Codex sandbox binary now comes from launch-time lookup because the codex adapter uses validator or binary as sandboxBinary) a separate pre-existing problem without any reproduction at the base commit, so a regression introduced by this lane is not excluded; Fix: run that single case at base 1032c6a5 and record the outcome in the report, and if it passes at base, fix the regression in this lane instead of filing a proposal

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Whether the live-session concurrent-worker exit 125 failure exists at the base commit; the zero-command budget allowed no execution.
- Runtime behaviour of symlinked \`lane --help\` was established by reading herdr/release.sh, lanes/lane.mjs and Node main-module resolution semantics, not by execution.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
