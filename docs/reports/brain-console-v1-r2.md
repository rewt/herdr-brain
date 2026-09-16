---
run: R-3
outcome: done
summary: |
  Correction round 2: fixed the four open items from .lane/BRIEF-correction-r2.md on
  lane/brain-console-v1. (1) The review round 1 record is committed as-is (db2e550), so the
  worktree is clean and lane review can run. (2) After a "no", org answer now prints
  "<ID> is already running (R-n); the decline does not stop it" for a dependent with an open
  run, and keeps "stays blocked: declined" for the others (0af7b69). A new approvals test covers
  both cases, and it failed when the fix was removed. (3) The spec's Cutover now says to update
  every org on PATH before the first "no". A frozen-fold test shows that an older fold releases
  the dependents of a declined question. (4) The README sample footer now uses the footerKeys()
  order. npm test 60/60, npm --prefix console test 25/25, git status clean. Ready for review
  round 2. Nothing was pushed and no live organization was written.
headline: All four items left open by round 2 are fixed, and the branch is clean and ready for review round 2.
blockers: []
proposals: []
learnings:
  - "`org start` accepts an item that is still blocked. Once it has an open run, itemStatus reports it as active, because the open-run check comes before the blocker check. A decline does not stop a run that has already started."
artifacts:
  - "branch lane/brain-console-v1: db2e550 (review record docs/reviews/brain-console-v1/f141f8e-r1.md), 0af7b69 (org answer message, tests, Cutover note, README footer)"
  - "npm test → 60 pass, 0 fail; npm --prefix console test → 25 pass, 0 fail, 0 skipped"
---

## Items

1. **Commit the review file.** Committed unchanged in db2e550, the first commit of this round.
   `git status --short` is now empty.

2. **Settle finding 11: the message after a `no` for a running dependent** (`bin/org.mjs`, `answer()`).
   - **Fix:** the dependent loop first checks `openRuns(after.state, blocked)`. If the dependent has
     an open run, the message is `ENG-1 is already running (R-1); the decline does not stop it`.
     Dependents with no open run still print `stays blocked: declined (re-plan it, then: org unblock …)`.
     The itemStatus rule is unchanged.
   - **Test:** `test/approvals.test.mjs`, "a decline says so truthfully for a dependent that is
     already running". HUM-1 blocks ENG-1 and REV-1, and ENG-1 is started before the `no` answer.
     The test asserts the running message for ENG-1, with no "stays blocked" message and status
     `active`. It also asserts `stays blocked: declined` and status `blocked` for REV-1.
   - **Negative control:** I changed the condition to `if (false && running.length)`. The test
     then failed: "The input did not match /ENG-1 is already running \(R-1\); the decline does not
     stop it/" (11 pass, 1 fail). With the fix restored, the file passed 12/12.

3. **Older org binaries.** The spec's Cutover section (`docs/spec-brain-console-v1.md`) now opens
   by saying to update every `org` on PATH, and every checkout an agent runs it from, before the
   first question is answered `no`. The reason: an older `org` treats a `no` answer as resolved
   and releases the blocked work. A new test, "an older fold treats a "no" as resolved and releases
   the dependents", uses the frozen v0 fold. In that fold, ENG-1 reads `ready` after a `no`. The
   current CLI shows it as `blocked`.

4. **README sample footer.** The sample now reads `y approve   n decline   o open   Tab reader   ? help   q quit   Enter expand   1-3 tabs   r reload`.
   This matches `footerKeys()` for a list-focused, unexpanded row in a single project.

## Checks

- Core `bin/` and `lib/` gained no imports. `bin/org.mjs` is the only file changed under them.
- No round 1 fix was undone. The only code change is in the dependent message branch.
