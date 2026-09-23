# Keeping the live console's workflows in the goals design

The operator's baseline is the live console, `console/app.mjs`, before the goals
redesign. The initial goals pass compared against the ARCH-3 fixture prototype.
That preserved its cascade but missed controls available in the live app. Those
omissions were a design regression; adding goals does not retire those workflows.

This correction extends the fixture prototype on `lane/console-autonomy`. It does
not integrate the proposed screens into the live console. Restart the prototype
to see the changes:

```sh
cd /Users/rewt/development/rewt/.worktrees/herdr-brain/lane-console-autonomy
node console/proto/main.mjs
```

## Live baseline and corrected prototype

The comparison uses `console/lib/controller.mjs` for actions, `frame.mjs` for the
visible controls and readers, and `model.mjs` for direction and history. The goal
cascade, one-line waiting rows, dedicated readers and reserved sessions pane stay.

| Live workflow | Where it is in the corrected prototype |
|---|---|
| Give the whole project an instruction | `i` in the header; edit, review and record. The direction appears in `O` Status and `h` History. |
| Turn capture off/on and see loop health | `L` in the header; review the change. Header distinguishes ok, down and off. Capture configuration does not grant pickup authority or clear STOP. |
| See daily sessions, STOP, stale state, Herdr problems and alerts | Persistent status line opens `O`; the full reader includes current project direction and alert text. Orchard demonstrates stale/unavailable/STOP; enabling its loop still shows down. |
| Act directly on a selected waiting row | Numbered choices, `y` recommended, `Y` agent draft, `n` explicit No, `r` reply, `l` later, `x` drop, `d` start a session. Sending, choosing, starting and dropping still review the exact action. |
| Clear a finished result | `a` mark read or `x` clear, with review. Reading alone does not clear it. |
| Open the selected row's menu | `m`; right click also works when the terminal forwards it. Menu actions target that row, including from the board. |
| Read summaries, captured screens, memos, briefs and context | Enter opens a reader; `V` Summary, `D` Document, `C` Context are also mouse targets. Markdown uses the live console's renderer. |
| Open a source file | `o` on a row with a source path shows the simulated open receipt. The menu exposes the same action. |
| Review history and overrule an automated answer | `h`; `n` on an automated answer requires a reason, reviews old/new answers, and retains the original answer. |
| Show only working sessions | `w` while browsing or the Working/Show all button in the sessions header. Global needs-you count remains visible. |
| Peek, reply to a session, jump to its pane | Session detail retains Enter to peek, `r` reply and `g` simulated pane jump; applicable actions also work directly on the selected row. |
| Project/view selection and reload | `p` project, `:` screens, `!` all needs, `R` simulated refresh. Clear filters remains clickable at 80 columns even beside goal ranking controls. |
| Priority and autonomy | Goal rank, authority, Next work, and Why this work remain alongside these controls. |

The latest project instruction moves from the live list body into the persistent
Status reader, one click or `O` away; it is also shown while composing a new
instruction. This is a placement change, not a removal. Status uses the former
separator row, leaving the cascade and sessions the same vertical space.

## Shortcut differences to assess before product integration

The cascade prototype already uses `s` to focus sessions, Tab to move between
columns, `/` to find rows and number keys to answer questions. Source tabs use
`V`/`D`/`C` so looking at evidence cannot accidentally answer a question. The
live app's `s` summary and `1`/`2`/`3` tabs therefore are not copied verbatim.
`y` consistently reviews the recommended numbered choice; `Y` explicitly reviews
the agent's text draft. `n` in history overrules an answer; `n` in Next work
requests an executive. In task/session readers, `w` still means Why this work;
the sessions filter remains available by mouse there.

These differences need to stay explicit in a product migration. The live app's
new-task command is a placeholder, so this correction does not invent a completed
new-task composer. The prototype's plain-text editor still supports append,
backspace, bracketed paste and Tab-to-Cancel rather than a full editor.

## What the fixture can and cannot establish

Instructions, answers, loop settings, saved-for-later state and authority changes
exist only in memory. No org command, model, file opener, Herdr command or service
control is invoked. Source documents are synthetic. Live refresh, streamed peek
updates/follow, durable read receipts/drafts, external editors and actual pane
switching still require product integration. Session metadata remains display-only.

Regression checks exercise action targeting, confirmation/cancellation, editor
ownership, direction/history, overrule provenance, capture versus authority,
working filters and layout/hit bounds at 80/100/140 columns. The PTY smoke runs the
actual Ink host through instructions, history, loop changes, filtering, document
tabs, autonomy actions, mouse packets, resize and terminal cleanup.

Validation: root `npm test` passed before the correction (175 tests) and after
(185 tests); `npm --prefix console test` passed all 98 tests; the extended PTY
smoke passed. All 12 regenerated autonomy snapshots match their documented
`--print` commands. Logs are under the ignored `.lane/ux-regression/` directory.

The original R-25 report remains unchanged because it has already been ingested.
This note records the later feedback and correction; the prior review does not
cover these subsequent changes.
