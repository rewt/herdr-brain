**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: af7d6b9dec4eabe38aab1305f68557ae37c9d292
Topic: review-cli-fix-3
Round: 4
Review ID: lr-4a3f73b480dabc8d394062f3e38de59c
Base branch: main
Base commit: 3367cd53e6fa50d3212f0da32e2189900b9b6d21

## Findings
- [Moderate] lane.mjs:1685 - a backslash placed immediately before an absolute path's leading separator defeats the concrete matcher, the residual rescan that already decodes percent and numeric character escapes, and the protected finding-location check, so an escaped external path in finding prose, in a finding location, or in a command string is published verbatim at exit 0; Fix: decode a backslash that precedes a forward separator in decodeReviewRescanText and in the value assertProtectedPublicValue inspects, so the escaped shape refuses instead of publishing, and add one fixture per affected field with its own deliberate negative control
- [Moderate] test/lane.test.mjs:3856 - the three added protected-location fixtures use file values that the pre-existing repository-relative finding rule already rejects, so they refuse for that reason and pass unchanged on the pre-change implementation, leaving the protected-location sanitizer check for a relative-looking location that embeds an absolute path uncovered; Fix: add a fixture whose location is a word, a closing parenthesis, then an absolute path, observe it failing on the pre-change implementation, and keep its own deliberate negative control
- [Moderate] lane.mjs:1646 - dropping parentheses from the file-URL character class also stops a file URL at a literal opening parenthesis, so a parenthesized path segment is published verbatim where the base commit redacted the whole URL; Fix: refuse publication when a concrete absolute-path match is immediately followed by an opening parenthesis, or accept balanced parentheses inside the match, and record the residue in REFERENCE and the report
- [Minor] docs/REFERENCE.md:535 - the sentence saying a matching regex literal is replaced rather than causing a refusal is contradicted by the spaced-path rule, because a regex literal that contains a space followed by a separator-bearing token still refuses the whole record, and the same claim appears in openspec/changes/review-cli/design.md:227 and docs/reports/review-cli-fix-3.md:126; Fix: qualify all three sentences to say the concrete matcher never refuses while the ambiguous spaced-path rule still can

## Re-executed
```json
[{"command":"node --test --test-name-pattern=\"redacts syntax-shaped|regex-like character class|in a protected location|command-substitution delimiter after file URL|asymmetric path redaction\"","cwd":"scratch","exit_code":1,"result":"In a scratch export of the pre-change commit carrying the reviewed test file, four of the seven focused fixtures failed and three passed in 16.540 seconds, and the file reported 135 cases in total. This reproduces the report's four expected failures and three already-safe passes and identifies the three non-discriminating ones as the protected-location fixtures.","tests_pass":false,"witness":null},{"command":"node probe-shapes.mjs review head","cwd":"scratch","exit_code":0,"result":"Against extracted copies of the reviewed sanitizer, all 15 round one to three leak shapes redacted with none published verbatim, all 9 of the same values refused as finding locations, and the two backslash-escaped-separator shapes published verbatim while the parenthesized file-URL segment survived redaction.","tests_pass":false,"witness":null},{"command":"node probe-shapes.mjs review main","cwd":"scratch","exit_code":0,"result":"The same corpus against the base commit redacted 14 shapes and refused one, refused all 9 locations, published both backslash-escaped shapes verbatim, and redacted the parenthesized file URL completely, establishing the escaped shape as pre-existing and the parenthesis residue as new.","tests_pass":false,"witness":null},{"command":"node test/probe-run.mjs","cwd":"scratch","exit_code":0,"result":"Five end-to-end reviews driven through the real command in a scratch export of the reviewed commit: four backslash-escaped shapes published an external path verbatim at exit 0 in finding prose, in a finding location and in a JSON command string, and the parenthesized file-URL segment reached the published command.","tests_pass":false,"witness":null},{"command":"node test/probe-loc2.mjs","cwd":"scratch","exit_code":0,"result":"A finding location made of a word, a closing parenthesis and an absolute path published verbatim at exit 0 on the pre-change export and refused with exit 2 and the protected-location diagnostic at the reviewed commit, so it discriminates the change while the three shipped fixtures do not.","tests_pass":false,"witness":null},{"command":"node test/probe-loc.mjs","cwd":"scratch","exit_code":1,"result":"The two-segment and drive-letter location fixtures refuse on both the pre-change and the reviewed export with the finding-schema diagnostic about a repository-relative file and line, not the protected-location diagnostic, so those fixtures never reach the sanitizer check they were added for.","tests_pass":false,"witness":null},{"command":"npm test","cwd":"scratch","exit_code":0,"result":"In an export of the reviewed commit, 138 of 138 cases passed with zero skips and zero failures in 247.867 seconds. Three of those cases were reviewer-added probe files that the runner discovered under the test directory, so all 135 cases of the reviewed suite itself passed. The probe files were deleted before the control run.","tests_pass":true,"witness":{"kind":"negative-control","command":"LANE_TEST_NEGATIVE_CONTROL=1 npm test","cwd":"scratch","exit_code":1,"result":"On the same export with the probe files removed, zero cases passed and all 135 failed in 247.138 seconds.","observed_failure":"Every case was expected to fail through its deliberate control and every one of the 135 did, including the controls named for the settle window, the syntax-shaped slash prose redaction, the regex-like character class, each protected-location fixture, the file URL command-substitution delimiter and the asymmetric path-redaction documentation."}},{"command":"OPENSPEC_TELEMETRY=0 openspec validate --all --strict --no-interactive --concurrency 1","cwd":"scratch","exit_code":0,"result":"19 items passed and zero failed, reproducing the reported strict validation result.","tests_pass":false,"witness":null}]
```

## Non-claims
- The scratch probes ran against extracted function copies and a clean export of the reviewed and base trees, so they do not establish behavior for a live Herdr reviewer, a real dispatch, or another operating system.
- The gate supplied with this dispatch is disclosed inherited evidence about a recorded validation run at the reviewed head; this review neither re-derives it nor treats it as a verdict.
- The operating-system user and host aliases are still redacted inside the escaped-separator shape, so the first finding exposes non-alias path text such as directory and repository names rather than the local identity.
- The escaped-separator shape behaves identically at the base commit, so the first finding is an unclosed pre-existing hole rather than a regression introduced by this lane.
- A green focused run shows that each selected test body executed, because the deliberate control asserts one failure at the end of each body; it does not show that every assertion inside a body is sensitive.
- The second finding says the three added location fixtures do not discriminate the implementation change; it does not say they are incorrect or should be deleted.

## Unverified
- No live Herdr reviewer, real agent dispatch, alternate operating system, or filesystem timestamp-resolution edge was exercised.
- A rewrite preserving both size and modification time was not attempted, so the settle interval was not probed adversarially.
- Promotion, rebase onto the base branch, push, archive, board behavior, and the post-commit gate were not exercised.
- Only the shapes named in this record were probed, so the concrete matcher was not swept exhaustively across arbitrary quoting, escaping, or encoding forms.
- Each authorized command ran once, so no repeated-run timing variance was measured.
- The two suite runs were piped, so the recorded exit statuses reflect the runner's own pass and fail counts rather than an observed shell status.
- The strict specification validation ran while another project's unrelated test process was active, so it did not wait for a clear machine-load slot as the budget requires; it is a two-second static check whose result does not depend on load.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
