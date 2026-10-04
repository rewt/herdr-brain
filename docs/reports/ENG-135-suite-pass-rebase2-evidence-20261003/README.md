# R-195 rebase-only evidence

All checks were offline, with heavy focused commands serialized through the host test slot. Exact commands are in `commands.txt`.

| Log | Base | Result | Test time |
| --- | --- | --- | --- |
| `focused.log` | `2b073a0` | Promote plus 14 consumers of the conflicted settle fixture: 137 passed, no failures | 226.332 s across two phases |
| `final-conflicts.log` | `a19de1e` | Console housekeeping and promote: 32 passed, one after-hook ENOTEMPTY failure | 44.445 s |
| `promote-recheck.log` | `a19de1e` | Unchanged promote file: 24 passed, no failures | 44.408 s |
| `fleet-conflict.log` | `bf89a5b` | Promote combined with main's actual-inbox cleanup: 24 passed, no failures | 44.322 s |

The first rebase resolved only the settle fixture import. Main advanced during host-slot waits: the next rebase combined process identity with load-aware console deadlines, and velocity-note recovery assertions with the accepted event wait; the fleet rebase combined actual-inbox cleanup with event-wait and deadline imports. The final rebase onto `8d633c28067ec6ee9ef38eed7920dd2bbe94a9f0` was clean. All three resolved files are byte-identical to `fleet-tested-blobs.txt` after that final rebase.

`range-diff.txt` and `resolved-diff.patch` cover the first rebase; `final-range-diff.txt` and `final-resolved-diff.patch` cover the train recovery base; `fleet-range-diff.txt` and `fleet-resolved-diff.patch` cover the fleet base. `latest-range-diff.txt` compares the seven original accepted commits against the final rebased commits; `latest-base.txt` records the latest base and accepted head. All three resolved files passed syntax and scoped whitespace checks.

The failed log is retained. `teardown-observation.txt` records the remaining explicit-record inbox files and the earlier fixture's default-inbox wait. Main's fleet changes already supply cleanup of every actual inbox destination, including explicit records, and assertions that the producer exits before deleting its fixture. Those existing fixes and assertions were retained; this lane added no new fix. The combined promote file passed its focused run.

No baseline, full tier, live acceptance harness, promotion or push was run in this round. The requested fast lane check follows the checked report commit; its final-head receipt belongs in `.lane/gate.json`.
