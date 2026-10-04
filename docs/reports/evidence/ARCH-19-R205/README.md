# Install review correction evidence

The review on `2a92730` identified inherited native configuration destinations,
native entry ignoring project opt-out, and dependency installation requiring
`import.meta.dirname` despite the Node 20 minimum. Regression tests were added
before the implementation changes.

| File | Result and scope |
| --- | --- |
| `regressions-before.tap` | Narrow initial run: inherited hook preservation and four native startup/resume opt-out cases fail against the original code. The sixth case initially failed because its fault injection preceded the shebang; the fixture was corrected. |
| `node20-before.log` | The original dependency installer, copied from Git into scratch with `import.meta.dirname` deleted after its shebang, reproduces `ERR_INVALID_ARG_TYPE`. No npm command runs. |
| `install.tap` | `node test/helpers/run.mjs test/zero-setup-install.test.mjs test/plugin-install.test.mjs test/fleet.test.mjs`: plugin and fleet pass 60/60; zero-setup passes 17/18 with only the malformed shebang fixture failing. |
| `install-corrected.tap` | `node test/helpers/run.mjs test/zero-setup-install.test.mjs`: corrected zero-setup fixtures pass 18/18, including the actual build with no `import.meta.dirname`, failure before npm, and repeat dependency reuse. |
| `acceptance.tap` | Initial offline acceptance execution is restricted by the outer lane sandbox: nested sandbox-exec and scratch socket fixtures cannot operate. |
| `acceptance-unsandboxed.tap` | `node test/helpers/run.mjs acceptance/test/*.test.mjs`, outside the outer lane sandbox: 155/155 pass, no skips. The tests' own kernel boundaries remain active. |

The fleet installation fixture simulates inherited Codex and Claude config
directories entirely in scratch. It verifies exact bytes and mode after install
and removal. The existing child release-suite regression also verifies both
native hook files of its parent installation. Every machine installer fixture
supplies explicit scratch `CODEX_HOME` and `CLAUDE_CONFIG_DIR`, including the
release acceptance case and native plugin canary.

Opt-out tests run the actual installed hooks for Codex and Claude on startup and
resume. Resume comes from a linked worktree with its own enabled setting while
the canonical checkout disables entry. They assert silence, no Herdr calls, no
fleet/record/runtime state, and no pane receipt.

Syntax checks for both changed product modules and both acceptance scripts, and
`git diff --check`, passed. No live release harness, account rehearsal, model,
project-wide housekeeping loop, full npm suite, promotion suite or lanes suite
was run. The final lane check is recorded locally after the report commit in
`.lane/ARCH-19-R205-check.log` and `.lane/gate.json`.
