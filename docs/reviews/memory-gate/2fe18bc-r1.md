**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 2fe18bcec3f3591422283d7b9dfa79c37ac96e5e
Topic: memory-gate
Round: 1
Review ID: lr-422f8c76494bc94e355578f534f14a21
Base branch: main
Base commit: c214a51e89608ba24f43dbef5763807486f0491a

## Findings
- [Moderate] lanes/lane.mjs:2407 - The STOP fix covers only the waits inside dispatch.mjs: after its worker-stage sample clears, dispatch saves stage launching (dispatch/dispatch.mjs:269) and runs \`lane dispatch\`, which performs its own unbounded waitForMemory with no STOP check and with stderr captured by dispatch, so pressure that reappears between the two samples leaves an invisible wait that launches the worker once memory clears even if STOP was placed meanwhile, and an operator interrupt leaves the journal at launching so recovery requires --adopt or --fresh; \`lane review\` at lanes/lane.mjs:2414 repeats the pattern after settle has already saved stage reviewing, contradicting the report and docs claim that STOP prevents delayed worker launches; Fix: make the dispatch.mjs and settle waits the only gate on those paths (for example a parent-supplied option or environment flag that makes \`lane dispatch\` and \`lane review\` skip their own wait when the caller already waited) or give the lane waits a canonical STOP check that exits before launching with a distinct result that dispatch maps back to stage worker, and add an offline test that raises pressure only at the \`lane dispatch\` sample, places STOP, and asserts no worker launch and a resumable journal.
- [Minor] settle/settle.mjs:390 - When settle dispatches a correction, dispatch's memory wait lines go to a captured stderr pipe, so the operator sees no reason while settle may block for hours (the report itself notes that the settle STOP regression had to use an adapter log to observe the wait), which falls short of the acceptance requirement that a dispatch under pressure waits with a visible reason on this automated correction path; Fix: before invoking the correction dispatch, call waitForMemory in settle with label settle correction and a check that returns the existing stopCorrection handoff when STOP appears, or pass the dispatch child's stderr through while still capturing stdout, and assert in the settle regression that the wait reason appears on settle's own stderr.
- [Minor] promote/README.md:147 - The README still says direct and queued promotions wait before validation and before the final fast-forward, but R-155 deliberately removed the pre-fast-forward wait under the promotion lock and docs/reference/memory-gate.md now says there is no second wait; Fix: change the sentence to say promotions wait once before acquiring the promotion lock and starting validation, then finish the fast-forward without another memory wait.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- The inherited settle validation log is truncated at about 8 KiB and stops during the core phase, so it does not itself show the new STOP, stale swap, macOS fallback or promotion lock tests; their passing rests on the recorded gate exit 0 and on worker-authored logs in the system temp directory that list those tests as ok; no independent execution was permitted.
- Real macOS vm\\\_stat and sysctl parsing, real Linux proc meminfo parsing, and the ps option spelling used by processUsage on Linux procps were not exercised on live hosts; correctness rests on unit fixtures and the probe failure path being advisory.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
