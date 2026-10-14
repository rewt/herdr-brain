# Safe retirement verification

Source commits: `bfc1e0b2`, `f950a8b4`, `70647ba`, `0ae4aef` on `lane/safe-retirement`.

The retirement planner/executor, generic references, native identity/process guards,
explicit handoff, record compatibility, copied distribution CLI, guarded lane close,
archive/report preservation, cleanup-only retry and installed settle-watch flags are
covered by `test/retire.test.mjs`, `test/retire-paths.test.mjs`, and `test/tidy-tabs.test.mjs`.

| Check | Result | Evidence |
| --- | --- | --- |
| Retirement files through `node test/helpers/run.mjs` | 67 passed | retirement-gate.tap |
| Same files through plain `node --test` | 67 passed | retirement-node-test.tap |
| Promotion file through the gate runner | 30 passed | promotion-gate.tap |
| Same promotion file through plain Node | 30 passed | promotion-node-test.tap |
| Selected existing lane lifecycle/identity controls through the gate runner | 12 passed; native ps control unavailable | lane-gate.tap |
| Same lane selection through plain Node | 12 passed; native ps control unavailable | lane-node-test.tap |
| Housekeeping and preceding retirement checkpoint through gate runner | 146 passed | focused-gate.tap |
| Same checkpoint through plain Node | 144 passed; 2 receipt/group startup controls require gate runner | focused-node-test.tap |

Lane selection:
`^(close |failed archive and post-close|git-only close|dispatch uses the pane POSIX shell|same-named repositories|a repository with a separate git directory)`.
Other lane tests were excluded from the final targeted repeat. An earlier whole-file
run is preserved in lifecycle-initial.tap: it exposed the optional-record environment
bug and unavailable native ps/FSEvents/short-lived transport fixture reads. The bug
was fixed; affected fixtures now use bounded evidence polling, explicit synthetic
memory for plain Node, and fresh ownership-read retries without bypassing any signal
guard. Final promotion and lane results are above. No baseline/npm/promotion-tier or
release suite was run in this lane.

Adoption used a temporary `copyProduct` distribution, then ran only
`supervisor/retire.mjs plan --repo /Users/rewt/development/bastian/bch-cloak --org /Users/rewt/development/bastian/.org`.
See adoption.json and bch-retirement-plan.json. All 48 observed tabs were retained.
The candidate copy was removed afterward; no release was built or activated, and
no live pane mutation or project housekeeping startup occurred.

The reference directory is optional and has no required writer. There is no dependency
on the paused external host-check loop. Lane evidence/archive durability preflight
remains the separate lane-removal work; this change guards its occupants and resources.
