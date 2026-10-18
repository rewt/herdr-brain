**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: ab1fda7ff9892e05f2cfce96b148608071b4a620
Topic: release-pins
Round: 1
Review ID: lr-492bceb6415274af469206413644747c
Base branch: main
Base commit: 1d41b7e78fb8536c95a2a4162951a13dea467d86

## Findings
- [Moderate] lanes/validation.mjs:119 - The lane-validation cache key now digests the full executing bundle identity, including its absolute root path, so a lane-tier receipt made by one lane CLI path (a lane worktree source, the canonical source, or a different installed release) never matches the promotion-tier key for the identical tree, command and fingerprint; this silently disables the cross-tier verify-once reuse the module comment promises, and the upgrade invalidates every existing green receipt, which the ask did not request; Fix: keep \`release\` in the gate receipt and onStart evidence but remove it from the \`digest\` key input (or salt only with a protocol number), and add a test that a receipt made under one bundle root is reused under another for the same tree and command.
- [Moderate] lib/releases.mjs:112 - forwardRelease forwards every source-checkout invocation (no release commit) to the accepted pin, so once herdr-brain commits a pin as planned for dogfooding, running \`node bin/org.mjs\`, \`node lanes/lane.mjs\`, supervisor, promote, dispatch, settle or housekeeping from a herdr-brain lane or the canonical checkout silently executes the pinned release instead of the code under development, and any test that spawns these source CLIs with a cwd inside the project would exercise the pinned bundle rather than the tree under validation; Fix: do not forward when the executing source bundle is itself a worktree of the target project (compare the source root's Git common directory with the pin's project identity), or at minimum print a one-line stderr notice naming the forwarded bundle, and add a fixture covering source invocation inside a pinned project.
- [Minor] promote/promote.mjs:345 - The cross-bundle cleanup continuation calls \`invoke\` and \`operationFile\` without the error containment finishCleanup provides, so a missing or changed saved bundle, or a nonzero child exit, throws out of retryCleanup (called again in drain's finally), crashes the worker, skips every later pending cleanup and never advances that row's attempts or backoff, so it fails again on every drain; Fix: wrap the continuation in try/catch and record the failure on the result row as a pending cleanup refusal with incremented attempts and next\_attempt\_at, then continue with the remaining rows.
- [Minor] herdr/RELEASE-PINS.md:73 - The Brain-side operation inventory omits \`dispatch/record-worker.mjs\`, which BCH invokes through the mutable current path for dispatch and continuation (listed in the BCH table) and which spawns its bundle-relative \`bin/org.mjs\`; invoked through current it never consults a project pin, and the ask requires inventorying every real entry point; Fix: add a row stating record-worker's binding (no pin selection unless admitted through \`release.sh exec\` or the router) and the required admission path.
- [Minor] lib/releases.mjs:63 - checkRelease rereads and SHA-256 hashes every manifest file of the pinned bundle on every routed launch and every forwardRelease call, putting a full-bundle read on the hot path of each \`record\`, \`org\` and \`lane\` command in a pinned project; Fix: do the full hash verification at pin time and build time, and at launch check only the manifest schema, commit and presence of the mandatory entry files (the fail-closed fixture still holds for a removed mandatory file).

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- The live two-project Brain plus lab demonstration, activation and BCH adapters are out of this lane's scope per the ask and were not assessed as delivered.

## Unverified
- Test evidence not re-executed: test/release-pins.test.mjs
- Test evidence not re-executed: test/release.test.mjs
- Report record-check validation not independently executed.
- Worker-reported broader module run (28 failures attributed to sandbox EMFILE, process-source and watcher-ownership limits) and final focused run (2 failures) could not be independently classified as environment-only; the inherited settle validation log states no worker validation receipt exists at the captured tree, so the promotion gate must supply green validation.
- Acceptance that old and new workers never mutate one queue concurrently with incompatible schemas rests on unchanged schemas and existing locks by inspection only; the dispatch retry handoff unlocks before the receiving bundle relocks, and that window was not exercised.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
