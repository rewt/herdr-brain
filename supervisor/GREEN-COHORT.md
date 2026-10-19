# Green clean-PASS cohort

`green-pass` is opt-in and stays disabled in this change. Astra's amended option 3
(2026-10-18; ENG-396) replaces the scanner-as-proof approach with a reviewed,
candidate-immutable containment manifest. Supervisor-herdr owns ordinary bootstrap,
independent review and later activation. No implementation report self-certifies
those steps. The existing notice autopilot, native worker, independent ready review,
explicit empty Findings, clean PASS and checked promotion still apply. `clean-pass`
keeps its own map and behavior.

`green-contracts.json` is the manifest: exact canonical identities/records, optional
empty lab slot, allowed component profiles, owner-confirmed BCH command and API entries, installed defaults and explicit
alternate roots, promotion authority, runtime/configuration pins, external launcher
and config pins, loader environment, and Node version/executable. The detailed
contracts are in [GREEN-CONTRACTS.md](GREEN-CONTRACTS.md), itself frozen.

Only `board/render.mjs`'s default width, an integer 80..240 in an otherwise exact
reviewed module, is initially eligible. Both committed trees must match the
reviewed component shape. This useful renderer control makes no lifecycle claim.
ENG-422 owns extracting a useful lifecycle boundary; no lifecycle profile is
currently admitted. No blanket docs, evidence or test permission exists. Only the
exact independently hashed generated review addition retains its existing exemption.

## Bootstrap and activation

1. Take ordinary independent review of the manifest, its contracts, the checker,
   deployment facts and positive/refusal evidence. Reconfirm BCH's ten-entry owner inventory and configured installed reconcile root,
   including the documented manual/reuse alternate selectors.
2. Rebuild the manifest's pins from the exact ordinary bootstrap candidate if its
   boundary changed. `buildManifest(tree, {bindings, externalInputs})` in
   `green-manifest.mjs` produces review input from a Git tree reader. Preserve the
   exclusion map and pass the owner-attested `consumerEvidenceBinding` when
   regenerating. It neither writes a manifest nor enables anything. Review the
   resulting diff; never regenerate from a green candidate to make it qualify.
   Bootstrap files are pinned to the trusted running versions in both committed
   trees; all other runtime/configuration inputs carry exact hashes and modes.
3. Review the concrete external input inventory. It must include Git executable/
   configuration, project/ancestor `.lane.json`, `.housekeeping.json`, fleet,
   relevant release pins and record configuration. Each absence is pinned too.
   The plain-text environment policy and Node launcher are versioned; harness Git
   and Node selectors are stripped from child launches, not hashed per session. A deployment using different
   inputs needs ordinary manifest review. The committed manifest describes Brain;
   no lab exists. Adding a lab binding/components is an ordinary reviewed amendment.
4. After bootstrap PASS and deployment acceptance, the supervisor must run a fresh
   `checkDeployment` of the committed manifest against the canonical checkout,
   using the reviewed Node, environment and execArgv, before writing any activation
   note. With the committed manifest's empty execArgv, run from the canonical root:

   ```sh
   node <<'NODE'
   import('./supervisor/green-pass.mjs').then(({ createGreenCohort }) => createGreenCohort().deployment());
   NODE
   ```

   Any refusal requires ordinary handling and re-review of changed pins. A passing
   probe in a lane does not replace this canonical deployment check.
   The supervisor can then enable the
   existing cohort in canonical `.supervisor.json` with the manifest's exact pairs
   and the first activation event's `activationId` and `activatedAt`. Calculate SHA-256 of the exact
   reviewed `supervisor/green-contracts.json` bytes and append through the existing
   record CLI: `record note ENG-396 "green-activation/v1 MANIFEST_SHA256" --decision`.
   Use the first cohort activation note's event `seq` as `activationId` and `at`
   as `activatedAt`; no custom event type or direct log write is needed. Every
   refreshed digest requires ordinary independent review, a fresh canonical
   deployment check and a new note on that same item. The configured id and time
   still name the first cohort activation across all digests. Missing digest
   evidence or reset ids/timestamps refuse. The interim lasts ten days from activation
   or until the reviewed successor replaces it, whichever comes first. Future,
   missing or expired activation dates refuse; expiry returns work to ordinary
   handling. This lane never activates it.

```json
{"autopilot":{"enabled":true,"cohort":"green-pass","green":{
  "brain":{"repo":"/Users/rewt/development/rewt/herdr-brain","identity":"/Users/rewt/development/rewt/herdr-brain/.git","org":"/Users/rewt/development/rewt/.org"},
  "lab":null,"activationId":12345,"activatedAt":"SUPERVISOR_SETS_AT_ACTIVATION"
}}}
```

Git common-directory identity and discovered record must agree, including in the
candidate lane. No inherited `ORG_DIR`, workspace name, basename, model or session
metadata grants authority. Config pairs must exactly match the trusted manifest.
A lab binding alone grants no component permission. Configuration and expiry are
checked before each automatic command by the existing authority checks.

## Mechanical containment

Admission reads Git objects and trusted boundary bytes; it never imports or
executes candidate code. The manifest, exclusions, checker, contract documentation,
review authority and validation/promotion selectors cannot approve their own edits.
Changed or missing boundary files, new runtime/configuration inputs, changed modes,
running-source drift, environment or external config drift all refuse. Computed
data reads in a frozen renderer do not become execution edges. The existing closed
reach checker is retained for diagnostics and the numeric-slot mechanical check;
its findings can narrow eligibility and never expand manifest authority.

The exclusions remain: BCH mutable consumption; blue hotfixes; native permissions;
shared resources; cross-project targeting/authority; global release selection and
rollback; shared notice/run/queue/receipt/state contracts; eligibility/evidence
and promotion authority. Every refusal follows the ordinary route. Existing lifecycle
artifact verification remains available for a future ordinary-reviewed protected
profile: identity, HOLD, live-reference and recoverability evidence must bind the
run/base/head/record and immutable artifact/log hashes. It is not an initial
lifecycle admission route.

`supervisor/test/green-main.test.mjs` reads actual Git `main` boundary blobs,
then applies the explicit ordinary-bootstrap diff from main to the committed
lane HEAD. It uses the committed manifest bytes and owner consumer-evidence
binding, without regenerating pins. An unrelated main input with stale pins
refuses. Outside Brain's canonical Git identity, including release snapshots,
the real-main probe skips explicitly. The probe reads declared external inputs
under the manifest's environment selection, discovers no live record or fleet,
and writes no operator refs/config/records/source.
It requires a one-line renderer change to pass containment and entry, authority,
manifest, boundary-drift and foreign-project controls to refuse. It records exact
base/candidate bytes and hashes. This is engineer containment evidence; it is not
an actual independent candidate review, bootstrap PASS or permission to enable.
A full admission fixture separately exercises canonical identity, clean committed
candidates, optional lab, expiry and autopilot review/promotion checks.

Engineer-focused checks and one independent ready review still apply per candidate.
The renderer's declared test is passed as required test evidence to the promotion
queue, so planner budgets cannot defer it.
Deferred review evidence joins that required set. Train verification checks the
saved union, and bare recovery or refused/timed-out retries inherit all earlier
requirements; an explicit attempt to remove any is refused.
Release-wide suites, live acceptance and BCH seam checks run once per switch
candidate in the supervisor's agreed window. No lane runs live acceptance or a
release, changes native permissions, lifts a HOLD, pushes, or activates this cohort.
