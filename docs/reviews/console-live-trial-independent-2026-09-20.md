# Independent live console trial — 2026-09-20

Final verdict: all four independently observed findings are repaired and pass their targeted fresh-launch checks. The sampled read-only operator routes work, task states and compact session identity remain readable, and empty-folder guidance states both the trial limitation and an actionable handoff. The original findings are preserved with retest results appended. This is a simulated operator review, not a human usability study or validation of write operations.

## Scope and evidence

The reviewer operated the console through `--help`, documented shortcuts, `--print`, and two isolated PTYs. Application source, tests, configuration contents, and prior design documents were not consulted. Goal descriptions and terminal output were read only as displayed by the interface. The parent changed the implementation during the trial; each finding below distinguishes earlier observations from fresh-launch confirmation.

All Herdr operations were reads through the console. The reviewer never pressed `o`, focused another native terminal, sent an agent a message, called a model, or changed an organization record. A task-owned empty folder was created at `/tmp/console-operator-empty.DSXdjZ`; a subsequent `rg --files --hidden` returned no files. Both PTYs exited with `q` and status 0.

Local evidence: `.lane/operator-live-independent/evidence.json`, containing 37 named command results and terminal captures. Evidence keys below refer to that file. Captures include ANSI focus markers where relevant. They are local generated artifacts; the report is the durable review document. The parent owns repository test execution; this reviewer made no implementation edits.

## Mission results

| Mission | Result | Observed evidence |
| --- | --- | --- |
| Understand a project at entry | PASS for the supplied project | `overview-0`, `overview-1`, `overview-2`: herdr-brain identity, goals, tasks, sessions, working count, attention count, and Live · read only are visible at 100×34, 80×24, and 140×42. |
| Discover and switch project | PASS | `projects` exposes connected projects, discovered folders, and their paths. `project-switch-final`, using `pk\n`, switches to bch-cloak with its own sessions, checkouts, goals, tasks, and attention count. This is a route test, not independent verification of filesystem identity logic. |
| Read a goal and return | PASS | `pty-goal-detail` opens G-2, `pty-goal-pagedown` reveals more of its success criteria, and Back returns to the selected G-2 row. `goal-final` confirms repaired `g` → Enter opens G-1 directly from a fresh launch. |
| Read a task | PASS | `task-final`: `t` → Enter opens ARCH-4, with its full title, ready state, parent goal, and success text. Task-list state scanning has the separate LI-2 issue below. |
| Find an unanswered decision | PASS for inspection | `needs-enter-final`: `!` → Enter exposes HUM-12's question, two choices, and a specific handoff command to the existing console. The read-only limitation is explicit. No answer was submitted. |
| Identify and open session output | PASS for one working session | `session-click` opens the overview's lane-console-autonomy session as wHJ:p1. `final-pty-sessions` and `final-pty-output` confirm `s` → Enter reaches the same live pane from the full session table. No native terminal focus action was used. |
| Read older output, return to latest, refresh, and Back | PASS for sampled route | `final-pty-output-older` shows older output and an “↑ 16 lines above latest” indicator. `final-pty-output-latest` returns to current output. `final-pty-output-refresh` remains on wHJ:p1 and updates output. `final-pty-output-back` returns to the session table with its first session selected. |
| Enter an empty folder | PASS for inspection; guidance needs revision | `empty-folder`, `empty-folder-goals`: zero sessions/goals/tasks and no organization are shown without error or fixture files being created. The guidance describes resources or next actions that are absent; see LI-4. |
| Fit narrow terminal bounds | PASS for bounds; content tradeoffs remain | Overview and session-table prints contain exactly the requested 24/34/42 rows. Their longest lines use at most 79/99/139 code points at 80/100/140 columns. The sampled output has ordinary single-column text and box glyphs; this does not cover arbitrary Unicode display widths. |

## Findings

### LI-1 — Medium, fixed and retested: list shortcuts focused Back

Earlier repro: open the PTY, press `g`, then Enter. Goals opened with the bold focus marker on ‹ Back; Enter returned to Overview. Reaching the first goal required traversing other controls. This was reproduced in the actual PTY, not inferred from print-helper behavior.

Evidence: `pty-goals`, `pty-goal-enter`, `tab-sequence`. The parent repaired initial focus. Fresh-launch results `goal-final`, `task-final`, `needs-enter-final`, and `final-pty-sessions`/`final-pty-output` confirm that `g`, `t`, `!`, and `s` now focus useful content and Enter opens it. Project switching also works through `p`.

### LI-2 — Medium: truncation hides task states

Repro:

```sh
node console/app.mjs --modern --project herdr-brain --print 100x34 --keys t
```

Observed in `task-list-100-final`: ARCH-4 and ENG-23/24/25/28 use the row for their identifier and title, so no state survives truncation. ENG-27 ends with `· blo…`. The first task's detail separately confirms `ARCH-4 · ready`.

Impact: an operator cannot scan the list to distinguish ready, active, and blocked tasks and must open them one by one. Reserve a state column or put state before the title's truncation boundary. Acceptance: at 80 and 100 columns, each row retains its identifier and complete state while only the title truncates. This finding concerns the list; the detail state is readable.

### LI-3 — Medium: the narrow session table spends identity space on unavailable metadata

Repro:

```sh
node console/app.mjs --modern --project herdr-brain --print 80x24 --keys s
```

Observed in `sessions-80-final` and `final-pty-sessions`: Session and Where are truncated, while Up displays `unk…` for every row and Doing displays `Run on |…` or `no descri…`. At 100 columns the working session name and checkout still truncate. Even at 140 columns, unknown uptime is shortened to `unk…` (`sessions-final`). Working/idle remains readable and Enter still reaches the exact pane, so this is a scanning inefficiency, not a demonstrated wrong-target error.

Recommendation: at narrow widths, prioritize session identity, checkout, and state. Remove or collapse unavailable uptime/description columns before truncating both identity fields; show their full values in detail. Label Up as Uptime when space permits, or use a defined compact missing-value marker. Acceptance: the 80-column layout should not allocate several cells per row to clipped variants of “unknown” while hiding more useful identity text.

### LI-4 — Low: empty-folder guidance implies resources or actions that are not available

Repro:

```sh
node console/app.mjs --modern --folder /tmp/console-operator-empty.DSXdjZ --print 80x24
node console/app.mjs --modern --folder /tmp/console-operator-empty.DSXdjZ --print 80x24 --keys g
```

Observed: the overview correctly shows zero sessions and “No open checkou…”, but also says shell tabs remain available in its checkouts and that its sessions/checkouts “are usable now.” The Goals screen says the project can start with a folder and a conversation, but provides no conversation action or concrete handoff on that screen.

Recommendation: make the empty copy conditional on actual resources. Say that the folder is open, that no sessions or connected project record were found, and what the read-only trial lets the operator do next. If conversation creation is outside the trial, name that limitation and its supported destination. Do not treat opening a folder as creating a session or registering an organization. Acceptance: a completely empty folder does not claim it has usable sessions/checkouts, and the suggested next step is reachable or explicitly explained.

## Naming and onboarding recommendations

- Keep Projects, Goals, Tasks, Sessions, Main checkout, and Worktrees as concrete nouns. Their relationships are clearer than exposing “native spaces” in onboarding. Describe the current opt-in surface as a live read-only console trial; `--modern` can remain a temporary technical flag.
- In the project picker, distinguish “Connected project,” “Found in Herdr,” and “Opened folder” when the actual reason is known. The combined “Discovered in Herdr / opened folder” label explains possibilities rather than the status of the selected item.
- Lead empty-folder entry with the folder path and what was found. Offer an explicit next step for an existing checkout, a new conversation, or an unformed idea only where that path actually exists. Goals should remain optional at entry, as the current copy intends.
- Keep long record identifiers in detail. The attention list's long timestamp-shaped identifier consumes almost the entire 80-column row; a short type label plus the question would better support choosing what needs attention.
- Reduce repeated output metadata at 80×24. The project header, checkout header, path, native-open hint, and session metadata leave a small output window. A compact identity line with expandable detail would improve reading without weakening target identification.
- Document print-helper key encoding. During this run `--help` listed `--keys` without its format. The parent supplied the accepted `\n`/newline Enter and `\e` Escape forms; that knowledge should be in help for repeatable operator tests. This is a testability note, not a blocker for ordinary PTY use.

## Limits

No writes, model calls, dispatch, approvals, native terminal focus, or promotion were tested. The working lane session was deliberately left untouched. No Herdr disconnect or external failure was induced. The fresh timestamps and changing live output show refresh functioning on the sampled route; they do not establish stale-data behavior during outages. Missing session associations remained explicitly Unlinked, and the reviewer did not infer durable task links from terminal text. Real human first-use comprehension, assistive technology, terminal resizing during a session, and visual appearance in every terminal emulator remain NOT TESTED.

## Targeted layout and onboarding retest

The parent reported repairs to LI-2, LI-3, and LI-4. The reviewer used eight fresh print-mode launches against current local data; no source files were consulted. Additional evidence is in `.lane/operator-live-independent/evidence-retest.json`.

| Finding / check | Retest verdict | Evidence |
| --- | --- | --- |
| LI-2: task states survive title truncation | PASS | `tasks-80`, `tasks-100`, `tasks-140`: every sampled row retains its full identifier and ready/blocked state before the title. Title truncation no longer hides the state. |
| LI-3: compact session table prioritizes identity and state | PASS | `sessions-80`, `sessions-100`: Session / Who / Where / State replaces six columns. All three sampled session names and working/idle states remain complete. Unknown uptime and empty descriptions no longer consume list width. A visible hint directs the operator to open a session for detail. |
| Selected output retains omitted details | PASS | `selected-output`: the view identifies wHJ:p1, the full session name, full checkout path, activity text, working state, and explicitly unknown uptime. It contains live captured output. No native-open action was used. |
| LI-4: setup limitation and useful next step | PASS for revised guidance; minor residual copy | `empty-overview`: the view says setup/chat creation are not connected, then directs the operator to open the folder and start an agent in Herdr and return with `r`. `empty-goals` explains that goals/tasks require setup outside the trial. The generic Sessions 0 text still says shell tabs remain available in its checkouts even though the sidebar says no open checkout. |

Residual LI-4 acceptance: when both sessions and checkouts are absent, replace that generic shell-tab sentence with an accurate empty state. The improved setup guidance already resolves the more important missing next step. No Herdr session was started to test the handoff because this independent trial remains read-only.

The compact Where column still truncates the long lane checkout at 80 and 100 columns; the full path is available on selection. That remaining tradeoff does not invalidate the verified removal of unavailable metadata or the preserved session names. Other terminal widths, arbitrary Unicode names, failure handling, and live writes were not added to this retest's scope.

### Final LI-4 confirmation

A final fresh launch against the same empty fixture now displays “No sessions or checkouts are open for this folder.” The unsupported shell-tab implication is gone. Zero counts, the setup/chat limitation, and the Herdr → refresh next step remain visible at 80×24. LI-4 is **PASS**, including its residual copy check. Evidence: `.lane/operator-live-independent/evidence-empty-final.json`. No new session, checkout, organization, or model action was performed.
