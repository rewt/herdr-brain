---
run: R-19
outcome: done
summary: |
  Designed the console as a scoped goals-to-tasks-to-open-items cascade above a reserved session pane.
  Added an Ink fixture prototype with keyboard and mouse navigation, detail readers, global attention counts,
  and simulated actions. The design includes a sourced field survey, complete input maps, two alternatives,
  and exact renders at three widths. This is ready for an operator design review, not a product cutover.
headline: The console design and interactive prototype are ready to try
blockers: []
proposals: []
learnings:
  - The console README referenced by the brief is absent; its key and Herdr integration notes are in root README.md.
  - The existing print path can request brain explanations and cache them; inspection must disable that effect.
  - Global attention counts require human questions from every configured organization, not only the selected project.
  - Unread acknowledgement needs an explicit receipt; opening a reader must not silently resolve work.
artifacts:
  - docs/design/console-screens-2026-09-18.md
  - console/proto/main.mjs
  - console/proto/README.md
  - console/proto/snapshots/
  - console/proto/prototype.test.mjs
  - console/proto/smoke-pty.py
  - lane/console-design
---

## Recommendation in five sentences

Use the asymmetric goals → tasks → open items cascade above a reserved, repository-grouped session pane.
Start with no goal or task selected, put focus on the first one-line waiting entry, and open its full reader with Enter.
Allow the cascade to filter related entries while keeping an unfiltered global needs-you count, a visible global-inbox button, and a local-of-global count on screen.
At 80 columns, show tasks and open items until the operator focuses goals, then shift to goals and tasks while retaining the path and session pane.
Keep explicit Back and click targets everywhere, use numbered choices only inside details, and make the recommended choice distinct from an unsent draft.

## What I read and inspected

Read the full tracked brief and AGENTS.md, `console/app.mjs`, all of `console/lib/frame.mjs`, `controller.mjs`, `model.mjs`, `mouse.mjs` and `theme.mjs`, plus relevant configuration, source, session and brain adapters. The missing `console/README.md` was resolved to root `README.md`, including the session columns, current key map, popup behavior and Herdr's last-pane/summon bindings; the earlier console specifications supplied historical context. Read the report parser to match the report envelope.

Read both organizations only through the authorized `today --json` and `status --json` commands, plus `brain queue --all --json` and Herdr's read-only agent list. No organization mutation command ran. The captured sources confirmed nested work, human questions, multiple queue entries referring to the same task, and the need to separate sessions from the questions they leave.

The literal live `app.mjs --print` invocation was not used: inspection of `session.mjs` showed its refresh can invoke `brain explain` and cache results, contrary to the brief's read-only assumption, and its normal readers traverse ledgers/worktrees outside the permitted Bastian org reads. Instead, I passed the allowed JSON and Herdr list through the existing `buildBoard` and `renderFrame` at 140×45, 100×40 and 80×30 for each project, with read-free repository mapping and no transcript/brief/ledger readers. These approximate the current live screen's data and faithfully exercise its renderer; they do not claim to reproduce transcript-derived WHO fields or current ledger counts. They show expanded waiting summaries consuming the viewport and hiding sessions. Live text was kept out of the committed synthetic fixtures and mockups.

## What the field contributed

The design document's opening field survey links primary sources and records adoption and rejection choices for K9s, lazygit, htop/btop, mutt/aerc, Magit/Transient, Finder's column analogy with ranger/nnn, and Ink/Gemini CLI. The result takes scoped resource navigation and an optional screen chooser from K9s, explicit panel focus from lazygit, stable process-table conventions from htop/btop, index-to-reader separation from mail tools, local action menus from Transient, and responsive parent-child columns from ranger. Gemini's documented alternate-screen rollback informed terminal cleanup, wheel, resize and packet-boundary checks rather than an assumption that Ink handles these details automatically.

## Runnable design object

```sh
node console/proto/main.mjs
node console/proto/main.mjs --print 140x45
node console/proto/main.mjs --print 100x40 --goal G-1 --task ENG-1
node console/proto/main.mjs --print 80x30 --screen waiting
```

The fixture has six goals, sixty tasks, three human questions plus ten waiting queue rows, three unread results, eight sessions and five lanes, across two invented projects. Main, waiting, goal, task, session, peek, global inbox, later, history, lanes, help, scope, find, actions, reply and review screens run. One-line waiting rows, Enter-for-detail, the cascade, global attention counts and the reserved sessions region are visible; there is no Task composer. No file under `console/lib/` or any other product file changed, and no dependency was added.

The design document contains 21 exact generated frames: no selection, goal selection, task selection, and four detail types, each at 80×30, 100×40 and 140×45. The committed text snapshots are under `console/proto/snapshots/`; `node console/proto/render-mockups.mjs` regenerates them and the document's generated section. The 100-column overview is pasted below.

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 harbor > All goals > All tasks > Open items
────────────────────────────────────────────────────────────────────────────────────────────────────
  Goals 5            │  Tasks 50                 │> Open items 12
* All goals         >│* All tasks               >│> Q-1     Choose a retry poli… harbor   reply    >
  G-1 Reliable imp… >│  ENG-1  Validate impo… * >│  Q-2     Keep the existing f… harbor   decision >
  G-2 Clear accoun… >│  ENG-2  Retry interru… . >│  Q-3     Accept the message…  harbor   decision >
  G-3 Fast search   >│  REV-3  Review error… !  >│  Q-4     Pick a recovery tim… harbor   decision >
  G-4 Calm releases >│  RES-4  Measure slow… .  >│  Q-5     Review the search s… harbor   decision >
  G-5 Useful audit… >│  ENG-5  Explain recov… * >│  Q-6     Schedule the releas… harbor   decision >
                     │  ENG-6  Check saved f… . >│  Q-7     Approve the audit w… harbor   decision >
                     │  ENG-7  Test keyboard… ! >│  Q-8     Choose a fallback p… harbor   decision >
                     │  REV-8  Simplify prog… . >│  HUM-1   Choose the recovery… harbor   decision >
                     │  RES-9  Document fall… * >│  HUM-2   Set the review wind… harbor   decision >
                     │  ENG-10 Verify releas… . >│  REV-3   Error review is rea… harbor   read     >
                     │  ENG-11 Validate impo… * >│  ENG-31  Release rehearsal f… harbor   read     >
                     │  ENG-12 Retry interru… . >│
                     │  REV-13 Review error… !  >│
                     │  RES-14 Measure slow… .  >│
                     │  ENG-15 Explain recov… * >│
                     │  ENG-16 Check saved f… . >│
 1-6 / 6             │ 1-17 / 51                 │ 1-12 / 12
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────
  SESSION               WHO                UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery       Codex Astra        32m   blocked  ENG-1   Waiting for a retry policy       >
  batch-retry           Claude Opus        18m   working  ENG-2   Testing interrupted batches      >
  import-review         Codex Astra        45m   done     REV-3   Finished the error review        >
  account-recovery      Claude Opus        24m   working  ENG-11  Tracing a recovery edge case     >
  search-timing         Codex Astra        12m   idle     ENG-21  Ready for the next sample        >
  release-checks        Claude Opus        9m    working  ENG-31  Checking the release steps       >



  Sessions 1-7 / 7 lines; scroll here for more
 Showing 10 of 13 needing you; ! opens all. Task stages: all.
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [Goals] [Tasks] [Open items] [0 Clear filters] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

## Validation

- Installed locked console dependencies with a worktree-local npm cache. The first network-restricted attempt failed; the authorized download succeeded. The initial root test failure was the absent-dependencies check; after installation the unchanged baseline passed 151/151 root tests and 95/95 console tests.
- Final `npm test`: 160/160 passed, including nine prototype interaction checks. Final `npm --prefix console test`: 95/95 passed. Tests are offline and do not call a model.
- `python3 console/proto/smoke-pty.py`: passed with real Ink in a pseudo-terminal, covering keyboard cascade navigation, click selection, fragmented/coalesced SGR, choice review, draft cancellation, stack return, session peek, lanes, resize to 80 columns, wheel input, quit and terminal-mode cleanup.
- The prototype checks verify global counts across filters, all target frame dimensions, visible focus, session reachability in compact readers, inert mouse releases, no choice before confirmation, draft preservation, and later-to-inbox recovery.
- Generated renders were inspected at all three widths; the 80-column waiting reader shows summary, all three choices, recommendation, why, relation path and draft above the sessions region. The first layout iteration's equal columns was rejected for clipping too much; the asymmetric and shifting-column version is the delivered iteration.
- `git diff --check` and report validation with `org check`: passed. No organization was written, no real session was started/answered/focused/stopped, and no configuration or installed tool was changed. Work files, npm cache and subsequent test temporary files were kept in this worktree; only the requested artifacts are committed.

The PTY test exercises terminal input and rendering, not a physical mouse in a real Herdr popup. Real popup forwarding, the operator's three-second comprehension, production refresh races, durable read receipts and actual command dispatch remain outside this design prototype. Actions change memory only; pane focus and session start produce an explicit simulation receipt. Closing and reopening resets the demo.

## Questions for the operator, with recommended answers

1. **Is “showing X of Y” plus the global inbox enough protection against missing work while browsing a goal?** Recommend yes for the first trial; keep the cascade filtered and use `!` as the single-step global route. If actual use still hides urgency, choose alternative A, the permanent global list above the browsing columns.
2. **Does the moving two-column window at 80 feel clear, or should 80 use only the global inbox?** Recommend the two-column window, preserving the goal/task path and explicit focus buttons; it maintains the requested relationship model without unreadable columns.
3. **Should “tasks” include work that has not run yet, and should “open items” include unread results?** Recommend all non-human work items as tasks and operator questions plus explicit unread results as open items; show read counts separately from decisions.
4. **Should sessions name the task they serve?** Recommend SERVES at 100/140 and the task on the continuation at 80; full task and goal titles belong in session detail.
5. **Should looking at a result mark it read?** Recommend no: use explicit Mark read, leave the task's derived status alone, and settle durable receipt storage before implementing it in the product.
6. **Should `y` send a draft when a recommendation also exists?** Recommend no: `y` always reviews the recommended choice; `r` opens the identified operator/agent draft for review.
7. **Should sessions remain global while goals are scoped?** Recommend project-scoped sessions, unaffected by goal/task/stage filters, with the global session and needs-you counts always visible.
8. **Should a future-stage human question disappear from needs-you?** Recommend keeping it visible and explaining its stage in detail; stage filters browse tasks and should not silently suppress a real request for the operator.
9. **Should Esc at the overview root still close a Herdr popup?** Recommend explicit `q`/Quit, with `b`/Back and optional Esc only for backing out or clearing a root filter; this avoids the operator's learned Esc-to-interrupt gesture.

## Cutover

None. This commit is a design document, report and isolated fixture prototype for review. Product integration, durable acknowledgement semantics and any deployment are a later, separately reviewed change.
