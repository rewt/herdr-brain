# Substantive agent message previews

## Delivered behavior

- Online plain, JSON, and watch board reads now use the same conservative Codex
  and Claude rendered-output adapters. The table shows the first substantive line;
  JSON preserves the bounded multiline message and its provenance.
- Recognized prompts, echoed input, tool blocks, spinners, dividers, and footer
  chrome cannot become `LAST MESSAGE`. Unsupported, footer-only, tool-only, or
  ambiguous output is explicitly unavailable, with any terminal excerpt separately
  labeled `pane-output`.
- Each read requests at most 200 `recent_unwrapped` lines and retains at most the
  final 16 KiB. Results expose kind, observation time, Herdr revision, truncation,
  staleness, and limitations. Read errors retain a matching cached preview only as
  stale.
- Cached previews are memory-only and keyed to the current Herdr agent-session
  occupant. A response that completes after the occupant changes is discarded.
- Watch mode reads registered panes on the existing five-second refresh and after
  status or output changes, with event reads coalesced to at most one per pane per
  second. Tripwire matching remains a separate, live-only subscription.

## Files

- `board/message-preview.mjs`: built-ins-only parsing, byte/excerpt limits,
  occupant identity, stale retention, and late-response rejection.
- `board/herdr-client.mjs`: protocol-20 `pane.read` adapter with explicit text,
  ANSI-stripping, source, and line parameters.
- `board/board.mjs`, `board/view.mjs`, and `lane.mjs`: shared one-shot/watch reads,
  event coalescing, table/UI summaries, structured provenance/coverage, and localized
  message errors.
- `test/message-preview.test.mjs`, `board/test/board.test.mjs`,
  `board/test/herdr-client.test.mjs`, and `test/lane.test.mjs`: synthetic Codex and
  Claude fixtures, protocol-shape tests, bounded/stale/replacement cases, and fake
  Herdr one-shot/watch parity.
- `README.md`, `docs/REFERENCE.md`, the completed change task, and
  `openspec/specs/agent-message-preview/spec.md`: public behavior, limits, schema,
  and only this implemented delta synchronized into the current specification.

`board/app.mjs` and every file under `docs/reviews/` remain unchanged.

## Negative controls and verification

- Baseline `npm test`: 120/120 passed, zero skips, in 110.716 seconds after a clear
  load probe.
- Before product changes, the five parser/read tests failed 0/5 because the new
  module did not exist. The first fake-Herdr integration attempt was unexercised
  because the sandbox refused the system-temp Unix socket with `listen EPERM`; an
  immediate run with local socket access reached product behavior and failed 0/1
  because the board still rendered `LAST OUTPUT` instead of `LAST MESSAGE`.
- Post-change focused parser tests passed 5/5 in 0.033 seconds. Before integration,
  the selected fake-Herdr test passed 1/1 with 98 unrelated tests skipped in 1.314
  seconds, and the combined board/client/parser focus passed 28/28 in 0.347 seconds.
- The parity test observed exactly four bounded reads: one plain snapshot, one JSON
  snapshot, one initial watch snapshot, and one coalesced read for two rapid watch
  events. Every request used 200 lines, `recent_unwrapped`, text format, and ANSI
  stripping.
- Complete post-change `npm test`: 127/127 passed, zero skips, in 112.536 seconds.
  `LANE_TEST_NEGATIVE_CONTROL=1 npm test` then failed all 127 named controls with
  zero passes in 104.647 seconds.
- The lane was then rebased onto concurrent board-actions implementation `3ef8230`,
  retaining its HANDOFF entry first and preserving its CLI-only UI/action boundary.
  On the integrated tree, the model/client/parser focus passed 28/28 in 0.340 seconds
  and the fake-Herdr parity case passed 1/1 with 104 unrelated tests skipped in 1.282
  seconds. The pre-final-rebase `npm test` passed 133/133, zero skips, in 114.802
  seconds. A final no-conflict rebase onto facilitator-reviewed tip `8a98b80`
  inherited its review record unchanged. At the reviewed commit, `npm test` passed
  134/134 and all 134 deliberate controls failed with zero passes in the
  facilitator's re-execution.
- The first integrated negative-control run encountered the known sandbox-only Unix
  socket `listen EPERM` in the inherited board-focus case and was not used as control
  evidence. The earlier local-socket repeat failed all 133 deliberate controls
  with zero passes or skips in 110.015 seconds. No test or product code was changed
  for the sandbox artifact.
- Final strict OpenSpec validation passed 20/20 with telemetry disabled and
  concurrency one. All test and validation runs were serialized after clear
  executable-aware process probes.
- Verified Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. The new tests
  are offline, create fixtures under the system temp directory, clean them up, and
  inherit the suite's isolated Git configuration with system configuration disabled.

## Remaining limits and approval

The adapters intentionally recognize only the covered visible Codex and Claude
formats. They do not provide a semantic transcript, crawl vendor files, recover
missing alternate-screen history, or guarantee an answer when Herdr reports only a
truncated tail. Raw excerpts remain terminal output, never inferred messages.

No live Herdr pane, interactive TTY, alternate host, model API, action against a
non-fixture session, push, promotion, archive, or independent review was exercised.
No contract amendment or further implementation approval is needed for this read-only
delta. Promotion, archival, and any independent review remain operator actions; the
final clean-commit gate is conversation-only evidence.

## Round 2 corrections — 2026-09-10

The Round 1 review's nine findings are resolved. The Codex and Claude adapters now
reject status candidates before accepting a block, stop at shortcut/context/token/
cost/approval/composer chrome or any implausible continuation, and anchor top-level
message and prompt markers at column zero so indented quotes and bullets remain part
of an answer. Tool-like opening verbs require an argument-shaped call or an indented
result marker before the block is discarded.

Pane reads now have a two-second timeout independent of the 500 ms snapshot budget
in one-shot and watch clients, with at most four concurrent reads. Timeout,
unsupported-read, and generic failure limitations remain distinct. The fallback
occupant tuple is agent/name/pane only, so output revision changes preserve a prior
preview as stale. Plain output receives localized message errors as notices, and the
REFERENCE live-only sentence now applies only to tripwire. The historical report and
HANDOFF counts now identify the reviewed commit's measured 134-test suite.

Eight new test groups plus the extended plain-rendering case cover status-first
blocks; all named trailing chrome forms across both adapters; ordinary Added,
Updated, Applied, Opened, Read, Found, Search, Save, and Edit answer openings;
corroborated tools; nested quotes/lists; nine-pane concurrency; timeout versus
unsupported limitations; revision-only fallback changes; delayed one-shot/watch
parity; and plain notices. Before product changes, the focused selection produced
11 intended failures and zero selected passes. Afterward the module sweep passed
34/34, and the four socket-backed root cases passed outside the sandbox in 4.294
seconds. Their sandboxed attempt failed only with `listen EPERM: operation not
permitted …/board.sock`; no product or test change was made for that restriction.

Final `npm test` passed 142/142 with zero skips in 115.630 seconds. The serialized
`LANE_TEST_NEGATIVE_CONTROL=1 npm test` run produced zero passes and all 142
deliberate failures with zero skips in 110.431 seconds. Strict OpenSpec validation
passed 20/20. Each run followed a clear executable-aware load probe and ran alone.

The adapters remain bounded best-effort readers of visible rendered output. No live
pane was reread in this correction round, so the larger timeout's effect on the
reviewed live Claude panes is not claimed. Missing alternate-screen history,
unrecognized formats, real-TTY behavior, alternate hosts, model APIs, and promotion
remain unverified. No contract amendment or further implementation approval is
needed; `board/app.mjs` and the facilitator-owned review record remain unchanged.

## Round 3 corrections — 2026-09-10

All six Round 2 findings are resolved in the visible-text parser. Any line advertising
the interrupt affordance is status chrome for both adapters, regardless of its
progress verb; the named progress verbs without that affordance now require an actual
elapsed-time form, so ordinary parenthesized answer prose remains substantive.
Indented approval prompts are also boundaries.

An indented Herdr result marker immediately after a Claude candidate is tool evidence
without requiring a known tool-name prefix, and result markers independently end
answer blocks. A Codex tool-label opening without call/result corroboration remains
unavailable unless the completed block is sentence-shaped, preserving ordinary prose
such as `Ran into a compatibility issue.` while withholding a partially rendered
`Ran` command. Composer frames are now recognized only when their lines contain frame
characters and padding; directory trees and tables with content remain part of the
answer.

The extended chrome case and four new negative-controlled test groups cover the
indented approval prompt; two unlisted interrupt-status verbs; ordinary parenthesized
`Working` answers in both adapters; a Claude human-description tool block; a detached
result-marker boundary; two pending Codex tool shapes and sentence-shaped prose; a
directory tree; a table; and a pure composer frame. Before the parser change, the
focused run passed 9/14 and failed the five affected groups. A follow-up padding-only
frame assertion then failed its group at 13/14 against the first correction, proving
that whitespace needed separate treatment. The final focused run passed 14/14 in
0.050 seconds.

The untouched baseline passed 142/142 in 120.972 seconds. Final `npm test` passed
146/146 with zero skips in 124.049 seconds. The serialized
`LANE_TEST_NEGATIVE_CONTROL=1 npm test` run produced zero passes and all 146
deliberate failures with zero skips in 106.511 seconds. Strict OpenSpec validation
passed 20/20. Each pre-commit build or test began after a clear executable-aware load
probe and ran alone; no Unix-socket sandbox failure occurred in those pre-commit
runs. The single post-commit lane check then failed 140/146 solely because the sandbox
refused six system-temp Unix sockets with `listen EPERM: operation not permitted
…/board.sock`; no product or test workaround was made. The facilitator's gate for
the same commit exited zero. Verification used Node.js 20.19.4, npm 10.8.2, Git
2.54.0, and OpenSpec 1.6.0.

The adapters remain conservative, bounded classifiers of rendered pane text rather
than semantic transcripts. No live pane or real TTY was exercised in this correction
round, so the two review-observed live forms were covered with public-safe synthetic
fixtures only. Unrecognized formats, missing alternate-screen history, alternate
hosts, model APIs, push, promotion, and archive remain unverified. No contract
amendment or further implementation approval is needed; `board/app.mjs` and every
file under `docs/reviews/` remain unchanged.

## Round 4 corrections — 2026-09-10

The parser now rejects named progress lines only when an elapsed time occurs in the
trailing rendered status form: parentheses, brackets, or text after an ellipsis. An
interrupt affordance remains independently sufficient evidence of status chrome.
This preserves ordinary answers that start with Working, Worked, Thinking, or
Running and merely discuss a duration.

Tool-label candidates are unavailable only when their first line is the bare tool
word or the remainder has a command-invocation shape. Prose, short sentences,
colon-introduced lists, and file paths in prose remain substantive, while a trailing
partially rendered command suppresses the older superseded answer. The exact
public-safe Claude in-flight summary captured by one bounded 120-line
`recent-unwrapped` read is now a block boundary in both adapters. Same-indent runs
of bare elbow and tee tree lines remain answer content; an isolated bare elbow is
still treated conservatively as an ambiguous result marker. README and REFERENCE
now promise exclusion only for recognized chrome and document these limits.

Files changed in this round are `board/message-preview.mjs` for classification,
`test/message-preview.test.mjs` for the cumulative regression corpus, README and
`docs/REFERENCE.md` for the qualified public behavior, and this report plus
HANDOFF for measured delivery evidence.

The cumulative message-preview corpus now has 28 negative-controlled test groups:
24 visible-text extraction groups and four read-state groups. Round 4 added 14 groups
covering 19 distinct fixture variants and 34 adapter cases: the ten answer strings
quoted by the Round 3 review in both adapters, three trailing-duration chrome forms
in both adapters, four partially rendered command variants, the bounded live tool
summary in both adapters, and a bare hand-drawn tree run in both adapters. Existing
Round 1 and Round 2 answer, status, footer, approval, result-marker, composer-frame,
tree, table, prompt, and tool fixtures remain in the cumulative file.

Against the reviewed parser, the first focused run passed 15/28 and failed the 13
newly exposed cases. After the first correction passed 28/28, a separately added
inline-command assertion failed its group at 27/28 before the final command-shape
branch was restored. The final focused run passed 28/28 in 0.043 seconds. The
untouched baseline passed 146/146 in 111.644 seconds.

Final `npm test` passed 160/160 with zero skips in 114.092 seconds. The serialized
`LANE_TEST_NEGATIVE_CONTROL=1 npm test` run produced zero passes, 160 failures, and
zero skips in 102.976 seconds: 159 cases reached their deliberate controls, while the
board-focus case first hit the known sandbox `listen EPERM: operation not permitted
…/board.sock` restriction. No product or test workaround was made. Strict OpenSpec
validation passed 20/20, and `git diff --check` was clean. Each build or test began
after a clear executable-aware load probe and ran alone. Verification used Node.js
20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.

Only the one sanitized in-flight summary from the bounded live read was incorporated;
raw pane text, paths, host details, and unrelated output were not retained. No live
interactive render, alternate host, model API, push, promotion, archive, or product
contract change was exercised. `board/app.mjs` and every file under `docs/reviews/`
remain unchanged. The single post-commit lane gate remains to be run and reported as
conversation-only evidence.

## Round 5 corrections — 2026-09-10

Three existing negative-controlled corpus groups were extended before product edits.
Their seven added adapter cases cover two-clause and reordered in-flight summaries in
both adapters, an indented Claude approval prompt, and the three-period status form in
both adapters. Against the reviewed parser, the focused file passed 25/28 and failed
exactly those three groups. After the narrow corrections it passed 28/28 in 0.046
seconds; all earlier answer fixtures remain in the same cumulative corpus.

`board/message-preview.mjs` now accepts any ordered subset of comma-separated summary
clauses from the fixed Searched for, Read, Listed, and Ran verb list, with an integer
and one- or two-word noun phrase per clause. The Claude boundary now reuses the
existing approval-prompt pattern, and trailing status recognizes `...` wherever it
already recognized the single `…` character. `docs/REFERENCE.md` names count-clause
summaries; the tests, this report, and HANDOFF carry the corresponding evidence. No
broader prose, sentence-length, or tool-name heuristic was added.

The clean baseline passed 160/160 with zero skips in 117.024 seconds. Final `npm test`
passed 160/160 with zero skips in 116.792 seconds. The serialized
`LANE_TEST_NEGATIVE_CONTROL=1 npm test` run produced zero passes, 160 failures, and
zero skips in 107.582 seconds: 159 cases reached their deliberate controls, while the
board-focus case first hit the known sandbox `listen EPERM: operation not permitted
…/board.sock` restriction. No product or test workaround was made. Strict OpenSpec
validation passed 20/20, and every build or test followed a clear load probe and ran
alone. Verification used Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.

A prose continuation made entirely of the recognized count-clause grammar remains
indistinguishable from this rendered chrome and will be excluded conservatively. No
live pane, interactive render, alternate host, model API, push, promotion, archive,
or contract change was exercised. No further approval is needed. `board/app.mjs` and
every file under `docs/reviews/` remain unchanged; the post-commit lane gate remains
conversation-only evidence.

## Round 6 corrections — 2026-09-10

The cumulative parser corpus now includes 30 paired chrome/answer fixtures exercised
as 43 adapter pairs. Each pair rejects the rendered status, tool-word, approval,
ellipsis, or tool-summary form while preserving an ordinary answer with the same
opening words. The new invariant is one negative-controlled group. Against the
reviewed parser, the focused file passed 28/29 groups and failed on the new invariant;
after the correction it passed 29/29 in 0.044 seconds.

`board/message-preview.mjs` now requires an elapsed time to end the rendered trailing
status form, so three-dot prose followed by a later duration remains substantive. The
Claude approval boundary requires at least two leading spaces, keeping indented prompt
chrome out of a response without rejecting an approval-worded Claude opening. Boundary
comments state the standing paired-fixture rule. No new sentence-shape, word-count, or
general prose heuristic was added.

The untouched baseline passed 160/160 with zero skips in 116.702 seconds. Final
`npm test` passed 161/161 with zero skips in 114.426 seconds. The serialized
`LANE_TEST_NEGATIVE_CONTROL=1 npm test` run produced zero passes, 161 failures, and
zero skips in 103.725 seconds: 155 cases reached their deliberate controls, while six
board socket cases first hit the known sandbox `listen EPERM: operation not permitted
…/board.sock` restriction. No product or test workaround was made. Strict OpenSpec
validation passed 20/20. Every build or test followed a clear executable-aware load
probe and ran alone. Verification used Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and
OpenSpec 1.6.0.

No live pane, interactive render, alternate host, model API, push, promotion, archive,
or contract change was exercised. No further approval is needed. `board/app.mjs` and
every file under `docs/reviews/` remain unchanged; the post-commit lane gate remains
conversation-only evidence and may encounter the same sandbox socket restriction.

## Round 7 restructure — 2026-09-10

The parser now owns one named chrome-rule table per adapter: 16 Codex entries and
17 Claude entries. Each of the 33 entries has exactly an anchored rendered-row
pattern, a candidate-first-line scope flag, and a minimal chrome example. At the
Round 7 commit, the suite enumerated those tables into 33 chrome/leading-token pairs:
each twin retained at most three word tokens and was exercised only as a marked first
line. It asserted that `interrupt-status` was the sole declared first-line scope, but
did not prove that the matcher enforced the flag or that a continuation-scoped rule
preserved ordinary prose containing its complete example.

The timed-status entry now recognizes an elapsed time that ends the trailing group,
an elapsed time anywhere inside a parenthesized or bracketed group, or an elapsed
time combined with a rendered `·`, `•`, or `|` field separator. Four explicit paired
fixtures cover a duration followed by a token count, file count, `total`, and
`remaining`. Shortcut, context, token/cost, Claude spinner, Codex approval, and Codex
footer rows are table entries rather than free predicates. REFERENCE records the
approval-row asymmetry and the common rule that approval chrome is not consulted
against a marked candidate's captured first line. The cumulative review corpus keeps
the status, three-period prose, tool-word, approval, and count-summary examples from
all six review rounds.

Before the parser edit, the focused file passed 29/31 groups and failed the two new
negative-controlled groups: the chrome tables did not exist, and a timed status with
a following token-count field was published as the newest answer. The final focused
run passed 32/32 in 0.059 seconds. Final `npm test` passed 164/164 with zero skips in
125.195 seconds. The serialized `LANE_TEST_NEGATIVE_CONTROL=1 npm test` run produced
zero passes, 164 deliberate failures, and zero skips in 119.958 seconds. Strict
OpenSpec validation passed 20/20. Each build, test, or validation followed a clear
executable-aware load probe and ran alone. Verification used Node.js 20.19.4,
npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.

The initial in-sandbox baseline passed 157/161; four unrelated host Git-ignore policy
checks failed. Separate environment probes also reproduced the known sandbox socket
restriction. Final verification isolated global/XDG Git configuration and ran with
socket access; it did not change the product or tests. No live pane, interactive
render, alternate host, model API, push, promotion, archive, action-boundary change,
or contract change was exercised. `board/app.mjs`, the read bounds, reader pool, pane
timeout, occupant replacement, stale retention, tripwire rule, and every file under
`docs/reviews/` remain unchanged. The single post-commit lane gate remains to be run.

## Round 8 corrections — 2026-09-10

The candidate matcher now enforces each table entry's scope before consulting its
pattern. Both the marked rendered row and its captured first-line body are checked in
candidate-first-line mode, so every flag-false rule is skipped and
`interrupt-status` remained the sole allowed first-line classifier at that commit.
That correctly enforced the flag but incorrectly left timed status unable to classify
marked candidates or lone marked rows. A matcher-level spy rule admits both adapter
markers and indented `Summary:` rows; its pattern is not consulted in either first-line
shape and is consulted as a continuation.

The tables remain 16 Codex rules and 17 Claude rules, producing 33 generated
chrome/prose pairs. Each twin removes only rendered indentation and row-leading
chrome, then appends an ordinary clause. That retained later parentheses, brackets,
colons, elapsed fields, and separators, but it removed the leading keyed glyph from
eight rules and therefore did not test those rules' closest glyph-preserving near
misses. Every twin is exercised as both a marked first line and an indented continuation
after a blank line. A new rule without the required example/scope shape, a
marker-admitting flag-false `Summary:` rule, or an overbroad indented `Note:` rule fails
the negative-controlled groups; widening a shortcut rule to any question-mark row was
not yet detected.

Timed status is again a direct trailing rendered form: the timed group or ellipsis
must immediately follow the progress verb and reach the end of the row. Bounded forms
cover elapsed-ending status, parenthesized or bracketed elapsed fields, elapsed fields
with `·`, `•`, or `|`, and the recorded count/`total`/`remaining` suffixes. Ten
duration-bearing prose sentences—including the review's parenthesized, bracketed,
and three-period cases—survive in candidate and continuation positions for both
adapters. Codex prompt rows are column-zero again, and colon-bearing `Context left:`
continuations remain prose. Timed-status remained continuation-only at that commit,
however, so marked and lone timed rows leaked. The cumulative corpus retains the
examples from all seven public review records.

Before product changes, the finalized fixture set passed 29/35 focused groups and
failed the six affected negative-controlled groups in 0.057 seconds. After correction
and rebasing, the focused parser file passed 35/35 in 0.057 seconds. The initial clean
baseline passed 164/164 in 113.331 seconds. The rebased `npm test` passed 168/168 with
zero skips in 115.479 seconds; the exact `LANE_TEST_NEGATIVE_CONTROL=1 npm test` run
produced zero passes, 168 failures, and zero skips in 108.497 seconds, with no socket
failure. Strict OpenSpec validation passed 20/20.

Main advanced twice during verification, first with test isolation and console UX
documentation and then with proposed console OpenSpec text. The lane was rebased onto
each new tip, preserving main's HANDOFF entries before this lane's entries; the second
advance changed documentation and OpenSpec artifacts only. Every build, test, and
validation followed a clear load probe and ran alone. Verification used Node.js
20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.

No live pane, interactive render, alternate host, model API, push, promotion, archive,
action-boundary change, or contract amendment was exercised. `board/app.mjs`, the read
bounds, reader pool, pane timeout, occupant replacement, stale retention, tripwire
live-only rule, and every file under `docs/reviews/` remain unchanged. The single
post-commit lane gate remains to be run and quoted in the handoff conversation.

## Round 9 corrections — 2026-09-11

The matcher continues to enforce each rule's scope before consulting its pattern, but
the corrected scope principle now classifies both `interrupt-status` and `timed-status`
as first-line rules. Those are the only two: a rendered status row is chrome as a marked
candidate, an indented continuation, or a lone row, while all other prompt, result,
shortcut, context, token/cost, approval, spinner, summary, footer, and composer rules
remain flag-false. The timed rule admits each adapter marker, the captured body, and
indentation while keeping the status body exact and trailing. Parenthesized, bracketed,
and ellipsis forms contain only elapsed fields and bounded count/status fields, with
rendered `·`, `•`, or `|` separators where present; arbitrary prose between the progress
verb, ellipsis or delimiter and the duration no longer matches.

The tables still contain 16 Codex and 17 Claude entries. At this commit, each ordinary
twin placed fixed explanatory words before the complete literal example, so the
containment assertion was tautological and most examples did not begin the rendered
row. Eight rules whose classification keys on a leading glyph had per-rule near-miss
twins that kept the glyph, changed a later keyed group, and ran as indented
continuations. A temporary widening of both
question-shortcut patterns to every indented question-mark row failed that group 37/38,
but a tail-widening mutation still escaped for 20 of the 33 rules. Sixteen status forms
and matching
same-opening prose twins run in candidate, continuation, and lone placements for Codex
and both Claude markers. The corpus also pins the five overbroad elapsed-time prose
shapes in candidate and continuation positions.

Approval chrome is explicitly a single rendered row whose question mark ends that same
row. The existing asymmetry remains: Codex recognizes that row at any indentation and
Claude only when indented, while neither rule is consulted on a marked candidate's own
first line. Two paired fixtures record the intended wrapped behavior: an approval opening
whose question mark appears on the next indented row remains prose.

The clean baseline passed 168/168 with zero skips in 123.195 seconds. Before product
changes, the finalized focused fixtures passed 34/38 and failed four affected,
negative-controlled groups in 0.065 seconds. After correction the focused file passed
38/38 in 0.076 seconds. Final `npm test` passed 171/171 with zero skips in 128.896
seconds. The exact `LANE_TEST_NEGATIVE_CONTROL=1 npm test` run produced zero passes,
171 deliberate failures, and zero skips in 112.917 seconds without a socket failure.
Strict OpenSpec validation passed 20/20. Every build, test, and validation followed a
clear load probe and ran alone. Verification used Node.js 20.19.4, npm 10.8.2, Git
2.54.0, and OpenSpec 1.6.0.

Main did not move, so no rebase was needed. No live pane, interactive render, alternate
host, model API, push, promotion, archive, action-boundary change, or contract amendment
was exercised. `board/app.mjs`, the read bounds, reader pool, pane timeout, occupant
replacement, stale retention, tripwire live-only rule, and every file under
`docs/reviews/` remain unchanged. The single post-commit lane gate remains to be run and
quoted verbatim.

## Round 10 corrections — 2026-09-11

The 16-entry Codex and 17-entry Claude tables remain the source of the chrome corpus.
For each of the 27 end-bounded rules, the suite now forms a body-first twin from the
complete minimal example followed immediately by ordinary words on the same row. It
exercises that exact shape in both marked-candidate and indented-continuation
placements. The group also constructs a tail-widened version of every bounded pattern
and proves that the mutant matches its witness while the committed rule rejects it;
adding an optional ordinary tail to any bounded table rule therefore fails the suite.
The six rules designed to accept arbitrary tails retain keyed glyph near-misses, and
the existing eight-rule glyph-bearing corpus continues to cover the bounded fast-mode
and spinner rows as well.

Claude fast-mode rows now require an indented double-triangle glyph, either the
rendered `accept edits` or `bypass permissions` mode, `on`, and an optional exact
`(shift+tab to cycle)` hint. Claude spinner rows require indentation, a spinner, one or
more words, an ellipsis, and optionally a parenthesized elapsed field plus rendered
token counts. Six continuation and inner-row chrome fixtures cover the expanded forms;
four corresponding prose near-misses preserve changed mode state, descriptive mode
text, post-ellipsis prose, and a non-status parenthetical group.

The fixture-first focused run passed 38/40 groups. The expanded Claude group failed on
the first `accept edits on` continuation before the parser changed; the other failure
identified a stale test-helper name introduced while replacing the Round 9 generator.
After correcting both, the focused file passed 40/40 in 0.096 seconds. Before the
required rebase, `npm test` passed 173/173 in 124.751 seconds and the exact negative
run produced zero passes and 173 deliberate failures in 118.369 seconds. After `main`
advanced with the review sanitizer correction, the lane rebased onto `a9cd127`; final
`npm test` passed 206/206 with zero skips in 317.998 seconds, and the exact negative
run produced zero passes, 206 deliberate failures, and zero skips in 305.020 seconds.
Repository-wide strict OpenSpec validation passed 20/20.

Every build, test, and validation followed a clear load probe and ran alone.
Verification used Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. No live
pane, interactive render, alternate host, model API, push, promotion, archive, action-
boundary change, or contract amendment was exercised. `board/app.mjs`, the read
bounds, reader pool, pane timeout, occupant replacement, stale retention, live-only
tripwire rule, and every file under `docs/reviews/` remain unchanged by this round.
