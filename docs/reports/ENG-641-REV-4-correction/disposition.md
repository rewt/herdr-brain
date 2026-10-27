# Concurrent reset Major: correction disposition

ENG-641 / R-899 is the single formal engineer follow-up under REV-4 for M1.
The source item remains ENG-400 and producer evidence remains R-873. The
already-landed fixture-clock correction supplies the three specifically corrected
reset controls. This disposition associates that correction with M1; no second
implementation, green replay or automatic second review is requested.

## Preserve the captured failure

R-898's **FAIL** remains bound to feature base
`35fdd007092243676c8c12d2aef7d3768d1e1f51` and head
`817de2d78506bb5099b0b6def4fc77bc8c86d5e7`. Both concurrent-reset cases fail at
`test/session-live.test.mjs:329`, with two starts instead of three. They do not
reach the sibling-close and `close/create/close` assertions. The standalone
last-tab control also fails its replacement-start assertion. The precise original
launch-refusal cause remains UNKNOWN; clock expiry was the producer's inference.

The original landed tuples are retained separately:

| Delivery | Base | Head |
| --- | --- | --- |
| Feature | `35fdd007092243676c8c12d2aef7d3768d1e1f51` | `817de2d78506bb5099b0b6def4fc77bc8c86d5e7` |
| Fixture-clock correction | `56718459b0c4c1525fe662bfd9049c7f9dcacd82` | `f1f86b50bb2a0d8fc77a0230541f25be09a1e864` |

Existing held/native attempts, review bindings and earlier failures remain
immutable. The later corrected head must never replace the captured review head
or turn its verdict into PASS. [binding.json](binding.json) binds both landing
receipts, the original reports and execution evidence with SHA256 references.

## Associate the existing correction with M1

The correction at `f1f86b50bb2a0d8fc77a0230541f25be09a1e864` introduces
`resetFixture`: plan and authorization use the same deterministic semantic clock
in the standalone last-tab control and both concurrent-reset controls. Failed
start assertions also retain adapter-result diagnostics. The exact committed
correction diff matches the producer's `fixture-clock.diff`. No production guard
is changed by that correction or this disposition.

The producer/verifier is `lane-line-eng-400--6d8de9-a3c189`. Its evidence is in
`/Users/rewt/development/rewt/.org/evidence/ENG-400/R-873/`. The specific correction
execution is key
`d55de4fb7c2c26e170bba605f78dd5bb44624605390e83cb3b2c501ac2bd01a5`,
bound to the corrected head above by `focused-gate.json`, `focused.tap` and
`focused-execution.json`. It used Node v20.19.4, one attempt, and this command
through the existing lane check and project runner:

```sh
/Users/rewt/.nvm/versions/node/v20.19.4/bin/node test/helpers/run.mjs --test-name-pattern="^(last-tab plan and apply Hold|concurrent owned resets)" test/session-live.test.mjs
```

The recorded execution ran from 2026-10-27T00:50:53.376Z to
2026-10-27T01:09:13.054Z, exit 0: **3 passes, 0 failures, 43 skipped**.
The passing controls are:

- Standalone last-tab plan/apply Hold, with an owned second slot permitting
  exactly one close and respawn.
- Concurrent owned resets in original manifest order.
- Concurrent owned resets in reversed manifest order.

Both concurrent cases prove restoration of the closed slot before the sibling
close, retained workspace, and `close/create/close` ordering. Their changed-native
identity observation still fences respawn. These are fake-native fixture results,
not actual live acceptance.

The earlier executions remain explicit:

| Source | Recorded result | Limit |
| --- | --- | --- |
| Original candidate `8bde29ace30cfd39952f328c8ac83a67b3df40a2` | Exit 1; 105 passes and one adapter-file SIGABRT/heap failure | Lifecycle file completed 92 tests; adapter-file coverage incomplete |
| Captured feature head `817de2d78506bb5099b0b6def4fc77bc8c86d5e7` | Exit 1; 1 pass, 3 failures, 42 skipped | Physical close-edge race passed; all three reset controls failed |
| Corrected head `f1f86b50bb2a0d8fc77a0230541f25be09a1e864` | Exit 0; 3 passes, 43 skipped | Only the three specifically corrected reset controls passed |

The physical close-edge pass retains its earlier head and execution key
`6b36d3f4c4d8844b98d46720fe9f2b286ef3c53e78bf3d3fa17e34abf00ac0ef`.
It was skipped in the correction execution. No skipped or unavailable result is
PASS. The producer's existing heap-investigation follow-up is retained without
creating duplicate work.

## Existing release disposition

Carry this M1 correction association and the bound reset-control evidence into
the existing release disposition. The correction-specific fixture proof is
available at its exact corrected head; whole adapter-file coverage was incomplete
in the original execution, and full final-release coverage and actual required
live acceptance are absent from these receipts. Those obligations remain with
the existing release coordinator. Any genuinely missing affected proof belongs
to the engineer or release owner, with zero reviewer suites. This disposition
does not assert that later source has been tested by these historical executions,
clear unrelated failures, or authorize release or activation.

Disposition verifier: `lane-line-eng-641--2384fa-3f19d2`. The binding records the
observation time, source identities and evidence hashes. The ask selects evidence
reuse and no new check command; no executable source changes here. New tests,
lane check, default suite and additional tiers are unrun. The original review
verifier and producer results are consumed without routine re-execution.

The lane baseline has identical reset-test and planner blobs to the corrected
head. Its fixture-helper blob differs after the separate teardown correction
documented in [the REV-9 disposition](../ENG-638-REV-9-correction/disposition.md).
The binding records all three blob comparisons; the historical reset passes are
not represented as executions against that later helper. The gate's log digest
uses JSON-encoded log text, while the binding's file digests cover raw bytes.

The owning report supplies the immutable landing tuple for these disposition
files to the existing record queue-review intake. It requests no second review
of REV-4 or parallel settle/lane review and replaces no pending/UNKNOWN attempt.
The existing report watcher and completion prompt path retain their ownership.
The project-specific PROJECT SUPERVISOR exception address is UNKNOWN; exception
delivery cannot be claimed, and no recipient or native binding is invented.
