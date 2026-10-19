# Old-reader evidence

R-580, 2026-10-19, Node 20.19.4. NEW is the lane source revision recorded in
each JSON result (`1ec5c3f2`, implementation plus the final format inventory).
The later evidence/documentation commit does not change that runtime or list.

| OLD immutable bundle | Pass | Fail | Named not-covered |
| --- | ---: | ---: | ---: |
| `rc-20261019T042359000Z-cc585d9f33` | 27 | 0 | 35 |
| `rc-20261019T154523000Z-ebcc5ffe85` | 27 | 0 | 35 |

Both OLD bundles lack `docs/contracts/formats.json`; the checker uses NEW's
62-entry list. Each JSON includes exact commits, the inventory hash, scopes,
writer-produced artifact hashes and reader subprocess output/exit diagnostics.
No installed bundle was written. All state was disposable: HOME, record, Git
repositories, fleet, native Herdr seam and host resource paths were isolated.

The results cover status/show/snapshot, retirement status and supervisor brief,
pending promotion queue reads, refused-train metrics, dispatch/settle status,
exact validation receipt reuse (a miss refuses another execution), housekeeping
owner/config, and the other named probes. They do **not** certify a successful
train/completion recovery, dispatch/settle retries or the other 35 named gaps.
The archive probe uses the real NEW writer, but OLD has no standalone verifier;
it remains not-covered. Affected switches need evidence for relevant gaps or
KEEP/forward recovery. Zero failures is not permission to switch controllers.

Reproduce each result from the lane, with Node 20.19.4 first in PATH:

```sh
node herdr/compat.mjs /Users/rewt/.local/share/herdr-monitor/releases/rc-20261019T042359000Z-cc585d9f33 "$PWD" --json --out docs/evidence/ENG-441/rc-20261019T042359000Z-cc585d9f33.json
node herdr/compat.mjs /Users/rewt/.local/share/herdr-monitor/releases/rc-20261019T154523000Z-ebcc5ffe85 "$PWD" --json --out docs/evidence/ENG-441/rc-20261019T154523000Z-ebcc5ffe85.json
```

The final focused run is [targeted-tests.tap](targeted-tests.tap): **7 passed,
0 failed**, using:

```sh
PATH=/Users/rewt/.nvm/versions/node/v20.19.4/bin:$PATH node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 test/formats.test.mjs test/compat.test.mjs test/tier-plan.test.mjs
```

Controls include an archived reader tree without the format list, a real OLD
reader rejection with preserved stderr/nonzero exit/KEEP wording, a missing
reader reported by name, refusal to write output inside OLD, inventory/registry
agreement in both directions, distribution inclusion and promotion-tier
placement. The runner's shared-history diagnostic is informational; fixtures
use isolated history paths. No release script, acceptance harness, full suite,
project housekeeping schedule, native worker, model or live pin was invoked.

The fallback's existing acceptance summary was checked read-only: READY,
19 PASS, no failures/skips/pending; SHA-256
`6c81d9147e1983ebf9fb7ad911ed457eddd8e02b3a550e90738cb1fb9e606d39`.
The [project-local rollback section](../../../herdr/RELEASE-PINS.md#project-local-rollback)
names the fallback and the admission-stop, bound-job-drain, committed-pin and
single-owner restart procedure. Build wiring follows the concurrent pin-contract
work; this change deliberately leaves `herdr/release.sh` and `herdr/releases.mjs`
untouched.
