---
run: R-4
outcome: done
summary: |
  Correction round 3: fixed all five findings from review 0d79431-r2 on lane/brain-console-v1,
  as .lane/BRIEF-correction-r3.md asked. The review record is committed as-is (fd3c226). The
  fixes are in one commit (d5fedac). (1) After a "no", org today gives each decided blocker its
  status and open run ids. The console Summary says, one dependent per line, whether it is still
  running, already closed or still blocked. org answer says "<ID> is already closed (<as>); the
  decline does not reopen it". (2) Code stripping now removes only the IDs the organization
  issues: item IDs whose prefix is in use (org today lists these prefixes in
  project.item_prefixes), run IDs, DECISION memo names and hashes. "CVE-2024-3094", "SHA-256"
  and "BIP-340" now stay. Question and answer rows show the raw title and why in the Context
  tab. (3) When neither VISUAL nor EDITOR is set, the console opens files with `open -t`. org ask
  refuses a --memo that is not a regular file. (4) Decision summaries are stripped and marked the
  same way as other text. (5) console-pane.sh passes --env
  HERDR_ORG_CONSOLE_CONFIG=<absolute path> to the new tab. npm test passes 67/67 and
  npm --prefix console test passes 29/29. I undid each fix once, and its test failed each time.
  Nothing was pushed, and nothing was written to a live organization or a live Herdr. Ready for
  review round 3.
headline: All five findings from review round 2 are fixed and tested, and the branch is committed and ready for review round 3.
blockers: []
proposals: []
learnings:
  - "The console strips codes using project.item_prefixes from org today --json. When an older org does not list prefixes, it uses the prefixes org issues by default (console/lib/text.mjs DEFAULT_PREFIXES). A prefix the organization does not use (DES-3, CVE-2024-3094) is kept as a word."
  - "Each row from buildRows now carries `prefixes`, and summaryParagraphs(row) uses them. A test that builds a row by hand without them gets the default prefixes."
  - "A macOS temporary directory sits behind the /var -> /private/var symlink. A child started with cwd in it sees the /private path, so a test comparing a path that was resolved from a relative one needs fs.realpathSync."
artifacts:
  - "branch lane/brain-console-v1: fd3c226 (review record docs/reviews/brain-console-v1/0d79431-r2.md), d5fedac (all five fixes, tests, README and spec wording)"
  - "npm test → 67 pass, 0 fail; npm --prefix console test → 29 pass, 0 fail, 0 skipped"
---

## Items

0. **Commit the review file.** Committed unchanged in fd3c226, the first commit of this round.

1. **"Still blocked" was not always true after a `no`.**
   - `lib/today.mjs`: each entry in a decided question's `blocks` now carries `status` and
     `open_runs`. The waiting list keeps its old shape. `itemStatus` is unchanged.
   - `console/lib/model.mjs`: the Summary gets one line per dependent after a `no`. The possible
     lines are "Still running, not stopped by the no", "Already closed, not reopened", "Already
     dropped, not reopened" and "Still blocked". If a later unblock made the dependent ready,
     the line says "Not held by the no (now …)". If an older read model has no status, the line
     makes no claim either way. A `yes` still gives one "Released:" line. Context lists each
     blocker with its status and run IDs.
   - `bin/org.mjs` `answer()`: a closed dependent now gets
     `<ID> is already closed (<as>); the decline does not reopen it`. This check runs before the
     running check.
   - Tests: approvals "…already closed" covers one done and one dropped dependent. It also checks
     the new read-model fields and that no "stays blocked" line appears. The "…already running"
     test now also checks `blocks` (`active, [R-1]` and `blocked, []`). The model test "the
     Summary after a no says what happened to each dependent" covers the running, closed, dropped
     and blocked cases, plus the yes case.
   - Negative controls: without the closed branch, the closed approvals test fails. Without the
     new today fields, both decline approvals tests fail. Without the per-dependent Summary, the
     model test fails.

2. **Code stripping removed real names** (`console/lib/text.mjs`).
   - The pattern is now built from the prefixes in use plus `R`, and `DECISION(-X)*-n`. Hex
     runs are handled as before. The pattern is cached per prefix set. A code must not be joined
     to a word or hyphen on either side.
   - `org today --json` lists `project.item_prefixes`. An org without that field gets
     `DEFAULT_PREFIXES`, the prefixes `prefixFor` issues.
   - Question and answer rows show `title` and `why` in Context.
   - Test "only codes the organization issues are stripped…": `Patch CVE-2024-3094 now?` stays.
     `Ship ENG-7 with the SHA-256 fix?` becomes `Ship with the SHA-256 fix?` with the mark.
     `Rename DES-3 now?` stays, because DES is not a prefix in use. The Context tab shows the raw
     title and why. The fallback prefixes and DECISION names are covered too.
   - Negative controls: with the old generic pattern restored, the test fails. Without the
     `title` Context line, it fails too.

3. **The macOS fallback viewer could launch a memo.** `viewerFor` now returns
   `open -t` ("the default text editor"). `org ask` refuses a memo that exists but is not a
   regular file: "memo … is not a regular file". Tests: the model test "the fallback viewer
   always opens a text editor…" checks the viewer arguments, and the approvals test refuses a
   `Tool.app` directory. Negative controls: with `args: []`, the viewer test fails. Without the
   `isFile` check, the approvals test fails. README and spec now say `open -t`.

4. **`decisionHeadline` showed summaries unstripped.** A summary now goes through `plain()`
   with the organization's prefixes. `plain: true` still means that a summary was recorded, and
   the Summary tab's Detail line is stripped as before. Test: `Dispatched ENG-12 after a1b2c3d4`
   becomes `Dispatched after · no plain summary`, both from the function and in the Decided row,
   and no Summary paragraph has a code. Negative control: with `oneLine(summary)` restored, the
   test fails.

5. **The config path did not reach the new tab** (`contrib/console-pane.sh`). When
   `HERDR_ORG_CONSOLE_CONFIG` is set, `herdr tab create` gets
   `--env HERDR_ORG_CONSOLE_CONFIG=<path.resolve(file)>`. Tests: the main test asserts the
   argument. A new test gives a relative path and checks that it arrives absolute. Another new
   test checks that no `--env` is passed when the variable is unset (it uses a temporary HOME).
   Nothing ran against a real Herdr. Negative control: without the `--env`, two pane tests fail.

## Checks

- Core `bin/` and `lib/` gained no imports. The console still writes to the organization only
  through the org CLI (`events.jsonl` is only watched).
- Every negative control was run by editing the file, running the test and restoring the file
  from a scratch copy. `git diff --stat` matched before the commit.
- `lane check` runs after this report is committed, so its gate is recorded at the final HEAD.
  If it had failed for an environmental reason, that would be noted here.
