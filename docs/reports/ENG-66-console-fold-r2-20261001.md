---
run: R-35
outcome: done
summary: |
  All five independent-review findings are resolved. Activity now gives every recorded moment its own focus identity, keeps only that moment's continuation lines selected, and lets j/k visit older moments even when they belong to the same item. The documentation now distinguishes the modern console from the retained legacy default, answered questions no longer produce a duplicate decision moment, the retired pane's last unused helper is gone, and the earlier report names the rebased work commit.
headline: Activity now follows individual moments and the console documentation matches what runs
blockers: []
proposals: []
learnings:
  - "An item ID cannot identify an Activity control: one item commonly has several lifecycle moments, so the event sequence is the stable focus identity."
  - "A question answer produces both an answer note and an item close; Activity should derive its single answered moment from the close and ignore the answer-kind decision note."
  - "A visible cursor in the plain render makes focus movement inspectable without relying on terminal background color."
artifacts:
  - "af1754b Address console fold review"
  - "console/modern/frame.mjs, console/modern/session.mjs, console/modern/model.mjs"
  - "console/test/modern.test.mjs"
  - "README.md, console/lib/cli.mjs, docs/reports/ENG-66-console-fold-20261001.md"
  - "node console/app.mjs --modern --project herdr-brain --print 100x34 --keys a"
  - "node console/app.mjs --modern --project herdr-brain --print 100x34 --keys ajj"
  - "npm test: 281 passed, 0 failed, 1 dependency-gated skip"
decisions:
  - decision: "Identify Activity controls as activity:<event sequence>, while resolving Enter and clicks back to the durable item."
    why: "The sequence distinguishes every chronological moment without changing the item page that a moment opens. Detail and summary lines remain mouse targets but are not additional keyboard stops."
questions: []
challenges:
  - premise: "All five findings described defects in the original implementation."
    verdict: partly
    evidence: "Four findings exposed implementation or documentation gaps. The unreachable hash was introduced only when the supervisor rebased and rewrote the original work commit, so this round updated the report to the new reachable hash."
---

## Findings resolved

1. **Activity focus and movement.** Each event header is now a distinct `activity:<seq>` keyboard control. Its detail and summary lines use the same activation target as hit-only rows and paint from that event's focus identity. Enter resolves the sequence back to its item. The regression fixture has three moments for the same item and asserts that only the focused moment's rows have selected styling, `j` moves from sequence 3 to sequence 2, and Enter still opens the item.

2. **Two consoles described as one.** README now presents `record console --modern` as the Herdr plugin's operator-facing screen and puts the old Font, Configuration, Screen, and Keys material under a named **Legacy compatibility console** section. It also documents that plain `record console [--project NAME]` launches that retained legacy screen. Modern help no longer sends answers and dispatch to the legacy command; it points answers to **Needs you** and new work to `n`.

3. **Duplicate answered history.** `activityEntries` now excludes `note.added` events whose kind is `answer`. A focused model test supplies the answer note plus the corresponding question close and proves that the result is one `answered` moment, not `decided` plus `answered`.

4. **Retired-pane helper.** Removed the unused `herdrVisible` export and its pane-specific comment from `console/lib/cli.mjs`. No references remained after the standalone items pane was retired.

5. **Stale rebased hash.** Replaced `7240b3c` with reachable commit `79986bb` in the first-round report.

## Screen evidence

The live plain render initially selected the newest event and printed exactly one cursor:

```text
› 15:40  ▶ ENG-66  started   Fold the standalone items pane's ideas into the modern console
           R-35 · lane-console-fold-c8aa2c-1403e2 · codex · gpt-5.6-sol
```

After two `j` presses, that cursor alone moved to the older moment for the same item; the newer ENG-66 start and intervening ENG-67 event stayed unselected:

```text
  15:40  ▶ ENG-66  started   Fold the standalone items pane's ideas into the modern console
  15:37  ◆ ENG-67  decided   Watch module, started early
› 15:36  ✓ ENG-66  reported  Fold the standalone items pane's ideas into the modern console
           R-33
           “The modern console now shows why items exist and what happened to them”
```

Herdr topology reads were permission-denied in the sandbox during these live renders. The record-backed Activity still rendered all 137 moments, which also confirms those source failures remain isolated.
