**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 61dadcb1714266a37ad3c0d297ea027a4721cc61
Topic: review-cli-fix-2
Round: 1
Review ID: lr-38b0b5b100d7de12909dc648317c516c
Base branch: main
Base commit: 8f967cbc39096c17532ff0f46b34167a56b0afe4

## Findings
- [Major] lane.mjs:1543 - alias matching treats the underscore as a word character, so a declared identifier or the local user or host alias written between underscores is neither redacted nor refused, and because this delta dropped the prose double-underscore refusal such text now publishes in clear with a user count of zero; Fix: treat the underscore as an alias boundary in aliasRegex and in the residual rescan, adjust the design word-boundary sentence to match, and add a regression projecting an underscore wrapped declared and automatic alias.
- [Moderate] lane.mjs:1605 - the residual alias and path rescan only inspects literal text, so now that percent and entity refusals are gone a user or host alias written between percent-encoded separators such as %2F publishes unchanged while the sanitization section still reports no user redaction; Fix: decode percent octets and numeric character references into a scratch copy before the alias and path rescan, or retain an explicit refusal when an encoded separator abuts an alias, with a regression for both forms.
- [Moderate] lane.mjs:1611 - escapeReviewProse omits the backslash from its escaped character class, so a reviewer backslash immediately before one of the escaped characters becomes an escaped backslash followed by an active delimiter, which defeats the documented literal rendering and can also synthesise path-looking output after the last residual check; Fix: add the backslash to the escaped class so every escape is unambiguous, and extend the escaping regression to a payload that already contains literal backslashes.
- [Minor] lane.mjs:1590 - a generated absolute-path placeholder is emitted unescaped as a reserved atom, so a path that ends immediately before an opening parenthesis projects as a Markdown inline link whose destination is ordinary prose; Fix: escape the opening parenthesis that immediately follows a generated placeholder, or refuse that adjacency, and cover it in the projection test.
- [Minor] docs/REFERENCE.md:456 - the new paragraph states that publication refuses prose only for non-ASCII, control, unresolved identifier, reserved placeholder and residual path or alias cases, but a finding location still refuses backticks, angle and square brackets, doubled asterisk or underscore runs and encoded octets, which is now undocumented; Fix: state in REFERENCE and the template that a finding file and line value keeps the stricter markup and encoding restriction, and assert that sentence in the documentation test.

## Re-executed
```json
[{"command":"npm test","cwd":"scratch","exit_code":0,"result":"112 of 112 tests passed with zero skips in 115.008 seconds in a system temporary copy of the reviewed commit; exit status 0 was captured directly.","tests_pass":true,"witness":{"kind":"negative-control","command":"LANE_TEST_NEGATIVE_CONTROL=1 npm test","cwd":"scratch","exit_code":1,"result":"0 passed and 112 failed in 116 seconds; exit status 1 was captured directly.","observed_failure":"With every deliberate control armed the suite reported 0 passes and 112 failures, so the green run is not vacuous."}},{"command":"OPENSPEC_TELEMETRY=0 openspec validate --all --strict --no-interactive --concurrency 1","cwd":"scratch","exit_code":0,"result":"17 of 17 items passed strict validation, including change review-cli and spec foreground-lane-review; exit status 0 was captured directly.","tests_pass":false,"witness":null},{"command":"node --test --test-name-pattern \"^PROBE\"","cwd":"scratch","exit_code":0,"result":"Four added probes all published at the reviewed commit: a reviewer backslash before a backtick or underscore produced a doubled backslash plus an active delimiter, underscore wrapped declared and user aliases survived in clear text with a user count of zero, a percent separated user alias survived while an entity separated one was redacted, and an absolute path ending immediately before an opening parenthesis produced an inline link.","tests_pass":false,"witness":null},{"command":"node --test --test-name-pattern \"^PROBE (underscore|percent)\"","cwd":"scratch","exit_code":0,"result":"In a system temporary copy of the base commit the same underscore and percent payloads each exited 2 with the diagnostic that the projected payload contains unsupported markup or encoded text and wrote no public record, so both leaks are newly reachable at the reviewed commit.","tests_pass":false,"witness":null},{"command":"node --test --test-name-pattern \"^PROBE2\"","cwd":"scratch","exit_code":0,"result":"A finding location holding a doubled underscore and one holding a square bracket each exited 2 with the finding location markup diagnostic, while a single underscore location published, confirming a retained restriction that the delta no longer documents.","tests_pass":false,"witness":null},{"command":"node --test --test-name-pattern \"^PROBE3\"","cwd":"scratch","exit_code":0,"result":"A description holding a reviewer backslash published text whose doubled backslash sequence is matched by the tool's own absolute path pattern, showing that display escaping runs after the final residual check.","tests_pass":false,"witness":null}]
```

## Non-claims
- The gate recorded at the reviewed commit is inherited evidence, not a fresh test result produced by this review, and not a verdict.
- Nothing here establishes that the sanitizer detects arbitrary undeclared private names or secrets in reviewer prose.
- The suite, validation and probes ran in system temporary copies, so nothing here covers untracked or ignored state inside the lane worktree.
- No Markdown or HTML renderer was executed; the rendering conclusions follow from the published byte sequences and the CommonMark rule that an escaped backslash leaves the next character active.
- The two earlier Minors are resolved and the delta specs are byte identical to the synced current spec, but that agreement is not evidence that the sanitization policy is complete.

## Unverified
- No live Herdr server, real agent dispatch or reviewer session was exercised; only the offline fake reviewer fixture was used.
- The three budgeted commands ran in system temporary copies of the reviewed and base commits rather than inside the lane, to satisfy the rule that nothing may be created in the reviewed lane.
- Alternate operating systems, native drive-letter and UNC inputs, concurrent private writers and permission denied filesystems were not exercised.
- Timeout, interruption, dispatch failure and unchanged-lane paths were not re-exercised this round; the delta does not touch them and the existing suite covers them.
- The publication size and line bounds were not measured against maximally escaped prose, where escaping can nearly double a punctuation heavy payload.
- No commit, push, promotion, archive, gate run or change under the tracked public review directory was performed.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
