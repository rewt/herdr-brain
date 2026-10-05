---
run: R-267
outcome: done
summary: |
  Reproduced the Claude-route refusal using a reconstructed inherited-gate review record. The lane review template, generated settle brief, and validator now share an exact inherited-evidence acknowledgment accepted only as a whole Non-claims bullet. Affirmative prose claims and unwitnessed execution claims remain refused. Focused lane and settle checks pass, including the correction flow outside the enclosing sandbox; the final lane check runs after this report is committed.
headline: Reviewers can acknowledge inherited gates without claiming fresh test results
blockers: []
proposals: []
learnings:
  - The cited settle review logs retain gate diagnostics and refusal messages but not the original reviewer prose; the regression fixture explicitly identifies its wording as reconstructed.
artifacts:
  - "Implementation commit: 4f7eb2f on lane/review-claims"
  - "lanes/review-evidence.mjs"
  - "lanes/docs/REVIEW_TEMPLATE.md"
  - "lanes/docs/REFERENCE.md"
  - "lanes/lane.mjs"
  - "lanes/test/fixtures/inherited-gate-claim-review.md"
  - "lanes/test/lane.test.mjs"
  - "settle/settle.mjs"
  - "settle/test/fixture.mjs"
  - "settle/test/settle.test.mjs"
  - "/private/tmp/ENG-132-reproduction.tap"
  - "/private/tmp/ENG-132-lanes.tap"
  - "/private/tmp/ENG-132-settle-focused.tap"
  - "/private/tmp/ENG-132-settle-outside.tap"
decisions:
  - text: Share one exact inherited-gate acknowledgment between the lane template, generated settle brief, and validator, accepted only as a whole Non-claims bullet.
    category: design
    why: Reviewers can copy a deterministic acknowledgment without a fresh execution claim; arbitrary inherited-result paraphrases remain subject to the existing claim check.
questions: []
challenges: []
---

The fixed acknowledgment is:

```text
- The supplied gate is inherited evidence; this review does not claim tests passed.
```

The validator exempts only that exact whole line under Non-claims. Moving it to
Findings or Unverified, changing its wording, appending an affirmative claim, or
adding a separate inherited-gate tests-pass claim still refuses publication. The
existing prose negation handling remains intact. A Re-executed entry with
`tests_pass: true` still needs exit zero and an observed witness; the acknowledgment
cannot substitute for either. Reviewers who execute no commands keep Re-executed
as an empty JSON array.

The template and generated settle brief explicitly prohibit restating inherited
results as tests-pass prose. Settle retains its existing separate exact acknowledgment
of the zero-command validation budget and its scoped Unverified handling. No settle
lifecycle or acceptance logic changed, and no live model review was launched.

Before the implementation change, the reconstructed R-266-style fixture supplied a
matching exit-zero gate and stated `The inherited lane gate shows tests passed
(exit=0).` under Unverified. The real lane CLI with the scripted Claude route
refused it with exit 2 and `tests-pass claims are allowed only in witnessed
Re-executed entries`; no public verdict was created. R-255 and R-256 round-2 logs
show the same refusal with stale gates, while R-266 round 1 shows gate exit zero.
The logs do not establish the original exact reviewer wording, so the fixture does
not claim to be a recovered private record.

Validation:

- Before the fix, `node test/helpers/run.mjs --test-name-pattern='^review refuses reconstructed Claude inherited-gate' lanes/test/lane.test.mjs`
  passed the regression asserting the original refusal (1 pass).
- After the fix, `node test/helpers/run.mjs --test-name-pattern='^review (refuses reconstructed Claude inherited-gate|accepts only the exact inherited-gate|inherited-gate acknowledgment|accepts negated test-pass|renders OpenSpec)' lanes/test/lane.test.mjs`
  passed all 5 selected tests. They exercise accepted records through scripted
  Claude and Codex routes, public projection, wrong-section and modified-line
  refusals, witness requirements, existing negated limits, and prompt rendering.
- `node test/helpers/run.mjs --test-name-pattern='^(settle generated review brief|inherited validation acknowledgments)' settle/test/settle.test.mjs`
  passed both selected tests. The generated brief's acknowledgment survives the
  real lane checker, public record, and settle commit, with no fresh execution;
  unresolved acceptance evidence still escalates.
- The existing `^unconfigured project:` settle correction-flow test hit
  `EMFILE: too many open files, watch` twice in the enclosing macOS sandbox. Its
  offline rerun outside that sandbox passed (1 pass), including the correction
  report, second review, promotable result, clean lane, and idempotent settlement.
- `git diff --check` passed before the implementation commit. The final required
  action is the default fast `node lanes/lane.mjs check` after the report commit;
  its receipt is written to the ignored `.lane/gate.json` at the final HEAD.

No baseline, full suite, promotion tier, live acceptance harness, or project-wide
housekeeping loop was run for this lane.
