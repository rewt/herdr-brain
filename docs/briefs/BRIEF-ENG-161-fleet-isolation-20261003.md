# ENG-161: tests never write the operator's real fleet

Read ENG-161 (record show). On 2026-10-03 at 22:16:52 CDT a settle test created the operator's real
`~/.herdr-monitor/fleet.json` entry `project` (checkout `/private/var/folders/.../T/settle-test-rurKFe/project`,
worktrees `~/.herdr-monitor/p/d50edf6a66780cd8`). The operator moved the leaked directory to
`~/.herdr-monitor.leaked-20261003T2217`; read it as evidence, never write it or `~/.herdr-monitor`. That leak broke
record discovery for the canonical checkout. CI was not the source: the bounded runner isolates the fleet. A run
outside it was.

`settle/test/fixture.mjs` already gives child processes a scratch HOME and removes HERDR_ variables, so find the path
that escaped: a test calling product code in its own process (where `os.homedir()` is the real home), or a child
spawned without the fixture's environment. Write the failing test first: run the settle tests the way a worker might
(plain `node --test settle/test/...`, outside `test/helpers/run.mjs`) with `HERDR_MONITOR_FLEET` unset and a guard that
fails if anything resolves `fleetPath()` under the real home. Then fix the escape so isolation does not depend on the
runner. Look for the same pattern in other fixtures that enter or join projects, and fix any you find the same way.

Files: `settle/test/`, `test/helpers/` if a shared guard belongs there, and the fixture of any other leaking test.
Do not touch `acceptance/` (R-215 owns the harness's own isolation). Commit, write the report, record check it, commit
it, run lane check last. Then stop.
