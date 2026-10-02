---
run: R-88
outcome: done
summary: |
  Fixed the sole round-two review finding: record_ready now accepts a tools/call
  request that omits arguments. Normalization happens before SDK validation while
  preserving the advertised strict object schema and optional role filter.
  A raw stdio regression failed before the fix and passes afterward; the official
  SDK-client demo also exercises name-only ready calls. The complete offline npm
  test suite passes, and the lane was rebased onto main before changes.
headline: Ready work calls now succeed when clients omit arguments
blockers: []
proposals: []
learnings:
  - The installed MCP SDK validates absent tool arguments as undefined even when an object schema has no required properties.
  - Normalizing the name-only ready request through the transport callback preserves the advertised role schema and existing SDK validation.
artifacts:
  - "Commit subject: Accept name-only ready calls over MCP stdio"
  - "Commit subject: Report MCP omitted-arguments regression fix"
  - mcp/server.mjs
  - mcp/test/server.test.mjs
  - mcp/demo.mjs
  - mcp/README.md
  - /private/tmp/arch14-r88-regression-before.log
  - /private/tmp/arch14-r88-mcp-tests.log
  - /private/tmp/arch14-r88-demo.log
  - /private/tmp/arch14-r88-baseline.log
  - /private/tmp/arch14-r88-post.log
  - /private/tmp/arch14-r88-gate.log
  - /private/tmp/arch14-r88-preserved-review-w53ihl0u/mcp-server/1b50466-r1.md
  - .lane/gate.json
decisions:
  - text: Normalize omitted arguments only for the ready tool before SDK input validation.
    category: design
    why: A name-only ready call has no required inputs, while role filtering, strict argument checks and required-input tools retain their existing schemas and behavior.
questions: []
challenges: []
---

The one review finding is fixed. Previously, a raw `tools/call` request with only
`name: record_ready` returned `isError` with “expected object, received undefined.”
The stdio transport now supplies an empty arguments object for that specific
omission before forwarding the request to the SDK. Its normal strict object
validation still applies. Explicit null and invalid arguments are rejected, and
tools with required inputs still reject name-only calls.

The new bounded regression uses its own scratch project and
`ORG_ACTOR=arch14-ready-regression`. It sends a raw stdio request without an
`arguments` member, compares the result with an explicit empty object, checks the
advertised optional string role schema and prohibition on extra properties,
verifies role filtering, and confirms rejected inputs and required-input tools
remain errors. Reads leave the event log unchanged. The regression was executed
against the original server and failed with the review's exact failure condition
before the implementation was changed.

The real-client demo uses the installed official **@modelcontextprotocol/sdk
1.31.0 Client + StdioClientTransport**. Both of its ready calls now omit arguments:
one discovers an empty project and one finds the newly created ready work. Its
transcript records `argumentsOmitted: true`. The complete scratch workflow still
finishes with report ingestion and a verified snapshot, without a model call or
user configuration.

Validation:

- Baseline complete `npm test`: **471 passed, zero failed, four existing skips**.
- Regression before fix: failed on the omitted-arguments request as expected.
- `npm --prefix mcp test`: **seven passed, zero failed, no skips**.
- `npm --prefix mcp run demo`: passed, including both name-only ready calls.
- Post-fix complete `npm test`: **472 passed, zero failed, four existing skips,
  476 total**.
- `git diff --check`: passed. Core imports, dependency declarations and
  `contrib/settle-watch.mjs` are unchanged by this round.

Both complete npm test runs include every file from the unchanged root test
script. They use the established scratch PATH wrapper to run one test file at a
time and an isolated temporary directory; each run has a ten-minute process-tree
bound. The complete validation command is:

```sh
PATH=/private/tmp/arch14-test-bin:$PATH \
TMPDIR=/private/tmp/arch14-r88-validation \
ORG_ACTOR=arch14-r88-validation npm test
```

The supplied private findings file was read in place. A review artifact was
already untracked at `docs/reviews/mcp-server/1b50466-r1.md` on entry. It was moved
to the scratch artifact path listed above, with its SHA-256 verified unchanged,
so it remains recoverable without adding review findings to the repository or
leaving the lane dirty.

The lane was rebased onto main first, and main ancestry was checked after the fix
commit. This report is checked through `record check` and committed by the subject
listed above. `lane check` runs last against that clean report commit with the
same complete npm test command; its receipt is `.lane/gate.json`.
