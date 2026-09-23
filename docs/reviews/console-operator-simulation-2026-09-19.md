# Modern console operator simulation — 2026-09-19

The rendered preview passed 20 operator checks in both headless Chromium and a visible Chrome for Testing window after seven interaction defects were repaired. An independent reviewer used the interface without reading the implementation and separately verified the decision, draft, navigation, and creation flows. This validates the sampled preview interactions; it does not establish production readiness or human usability.

## Target and method

- Worktree: `/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-console-autonomy`
- Branch: `lane/console-autonomy`
- Running preview: <http://127.0.0.1:8765/modern-console-preview.html>
- Editable fragment: `.lane/design-preview/modern-console-overview.html`
- Served export: `.lane/design-preview/modern-console-preview.html`
- Independent review: [console-operator-simulation-independent-2026-09-19.md](console-operator-simulation-independent-2026-09-19.md)

The in-app browser connection was unavailable and desktop control failed to start. For Codex CLI, this run used the task-local Playwright package with an existing Chromium installation. That requires no browser extension or connection to a personal profile. Playwright supports both a visible browser and headless execution; see its [browser documentation](https://playwright.dev/docs/browsers).

The independent operator received outcome-based missions before execution. It then used a fresh browser context, visible controls, accessibility snapshots, screenshots, and keyboard input without reading preview implementation, hidden application state, or the root regression suite. It preserved 55 baseline screens and 38 first-retest screens. Its report records which outcomes it personally observed.

The root replay uses a fresh browser context for each mission and asserts visible outcomes, including exact session identity, queue counts, draft contents, focus, and scroll restoration. It checks page errors and saves screenshots. Native browser history and browser-dispatched mouse Back/Forward events are exercised through Chromium; a physical mouse was not used. The visible replay used the regular browser executable, while unattended tests used Chromium headless shell.

No organization records, real worktrees, agent sessions, or messages were created by the simulation. All mutations occurred in the preview's in-memory data. The production Ink console was not changed in this validation pass.

## Defects found and repaired

| Finding | Reproduction and effect | Repair and evidence |
| --- | --- | --- |
| Deferred decisions became inaccessible — high | Open ENG-116, select Later, then try to find the question again. Its count changed, but no recovery destination existed. | Added scoped Open/Later views, an overview link, and Return to open queue. Answering from Later does not decrement Open twice. Independently retested as IR-1. |
| Empty instructions failed silently — medium | Open Instruct and select Review with no text. Nothing explained why it did not advance. | Added an actionable validation alert and returned focus to the textarea. Independently retested as IR-2. Required goal/chat fields also focus their invalid input. |
| Review had no draft-editing route — medium | Compose a chat or instruction and review it. The operator could confirm or discard, but could not return to edit. | Added Edit. Escape, app Back, and native Back return to the composer with its draft. Explicit Cancel remains cancellation. |
| Repeated view clicks polluted history — medium | Click Goals three times, then Back. The operator remained on Goals. | Consecutive navigation to the same view creates one history entry. One Back returns to the prior distinct view. |
| Back lost the originating keyboard control — medium | Open a goal/task and return. Focus fell back to the project switcher or to a different link for the same goal. | Restore the exact triggering control and previous scroll position. Unique accessible labels distinguish duplicate links. |
| Mouse Back skipped a view — high | Overview → Goals → Tasks, then mouse Back. Both the page and the browser handled the event. | Native browser history owns side-button navigation when available. Browser-dispatched Back and Forward now move exactly one view. |
| Native Back skipped the screen under a dialog — medium | Goals → New goal → browser Back returned to Overview. | Dialog stages now participate in history. Back closes the dialog on Goals; review Back restores its draft. Canceled/completed confirmation stages are excluded from subsequent navigation. |

Test-harness failures were kept separate from product findings. A scope-picker expression and a question locator initially mismatched accessible names; these were corrected from the rendered interface. Playwright's main-frame navigation wait also timed out for a successful history change inside the preview's iframe; native-history tests now verify the resulting UI directly.

## Final replay results

Each of these 20 missions passed once in isolated headless Chromium and once in visible Chrome for Testing:

1. Overview shows scoped sessions, goals, tasks, and Needs you.
2. ENG-116 opens the exact captured session `wH7:p5`; Back returns through the task to its originating overview link.
3. Repeated Goals clicks require one Back.
4. Native browser Back returns Tasks → Goals.
5. Browser-dispatched mouse Back and Forward each move one view.
6. Native Back closes New goal without leaving Goals.
7. Mouse Back returns a session review to its exact draft, then closes the composer on Overview.
8. Canceled/completed dialogs do not reopen through app Back; session creation occurs once.
9. Later retains the deferred question and restores the initial queue counts.
10. Empty instruction feedback is actionable; editing review preserves the text.
11. Session review supports Escape/Edit; explicit Cancel creates no session.
12. Goal validation, creation at first priority, reprioritization, and navigation retain the visible rank.
13. A new development worktree validates its name, previews its destination, and explicitly reports no real launch.
14. Switching project changes the session scope; answering a question leaves the other project's count unchanged.
15. Tab remains inside a dialog; Escape exits.
16. Back restores the exact goal link and scroll position at 736 × 600.
17. 1024-pixel dark appearance has no page-wide horizontal overflow or out-of-bounds controls.
18. 736-pixel appearance has no page-wide horizontal overflow or out-of-bounds controls.
19. 360-pixel appearance has no page-wide horizontal overflow or out-of-bounds controls.
20. 320-pixel appearance has no page-wide horizontal overflow or out-of-bounds controls.

Representative screenshots were visually inspected, including the desktop overview, narrow layouts, the dark appearance, and deferred-decision recovery. Geometry checks do not establish readability or comprehension for every row at every size.

Other verification:

- Root `npm test`: **185/185 before and after** the preview changes.
- `npm --prefix console test`: **98/98** after the changes; these overlap the root suite.
- Existing preview flow checks: pass, including fallback navigation without browser history access.
- `git diff --check`: pass.
- HTTP response from the running preview: byte-identical to the tested export.

## Reproduce or watch

Run from this worktree while the preview server is available on port 8765:

```sh
# Unattended browser replay
node .lane/operator-simulation/replay.mjs

# Visible browser replay, slowed so the operator can watch
HEADED=1 SLOW_MO=180 EVIDENCE_DIR=.lane/operator-simulation/headed-replay \
  node .lane/operator-simulation/replay.mjs
```

The visible browser closes when the run completes. Both modes use isolated, temporary browser contexts. The runner is machine-local: Playwright 1.63.0 is installed under `.lane/operator-simulation`, and its executable paths point to the existing Chromium 1243 installations in this machine's cache. No production dependency was added. On another machine, install the test dependency and matching browser in its test environment and update the executable paths.

Evidence locations:

- `.lane/operator-simulation/replay/results.json` and numbered PNGs: final headless results.
- `.lane/operator-simulation/headed-replay/results.json` and numbered PNGs: final visible-browser results.
- `.lane/operator-simulation/independent/`: independent baseline and retest actions, snapshots, and screenshots.
- `.lane/operator-simulation/root-baseline/`: initial navigation, draft, input, geometry, and focus probes.
- `.lane/operator-simulation/dialog-back-baseline.png`: native dialog Back before the final repair.
- `.lane/design-preview/operator-baseline.html`: frozen initial export.
- `.lane/design-preview/operator-before-dialog-history.html`: fragment before the final dialog-history repair.
- `.lane/design-preview/operator-before.log`, `operator-after.log`, and `operator-console-after.log`: suite results.

The generated runner, browser dependency, and evidence live under the Git-ignored `.lane` directory. Keep this worktree to retain them. This report and the independent review are durable documents under `docs/reviews`.

Tested fragment SHA-256: `464f9596208666cef69563e3bc000f8af377e913acb3266baad2dd0248ad8b15`.

Tested export SHA-256: `2adcfa5e3c45ca8ae763be6f3cbe67b201a2e865dfbb192f7686d10678fa51a7`.

## Remaining validation and follow-on work

The source reader remains a placeholder, and some sessions have no captured output excerpt. New-task submission and several other actions demonstrate a review surface rather than complete operational workflows. Goal, priority, decision, and session changes are local to the page and reset on reload. The test does not prove live output streaming, Herdr pane focus, CLI writes, durable records, actual dispatch, failure recovery, or exactly-once backend behavior.

Before shipping the Ink implementation, replay the same operator missions against its terminal UI and a disposable organization/Herdr fixture. Include terminal key sequences, SGR mouse events, resize behavior, stale/deleted sessions, missing source files, rejected CLI writes, disconnected sockets, and duplicate submission. Browser success cannot substitute for terminal input and integration tests.

Use this as a repeatable design gate: give a fresh reviewer concrete operator outcomes without implementation guidance, retain its screen/action evidence, convert each reproducible failure into a regression mission, repair it, and rerun the affected flows. Periodically ask a human operator to complete the same work without coaching; simulation can expose interaction defects but cannot establish human comprehension or perceived efficiency.
