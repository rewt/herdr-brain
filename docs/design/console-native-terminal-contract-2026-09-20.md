# Native terminal and host integration contract

Date: 2026-09-20. Scope: the operator's session-output and competing-sidebars findings. This investigation inspected the installed CLI and schema, exercised read-only observers, and added the bounded observer decoder. It did not focus a live pane, write to a harness, create or move a pane, change host settings, or install the plugin.

## Decision

Keep Herdr responsible for the real terminal and its Spaces/Agents navigation. The console contributes project scope, goals, tasks, decisions, and a session-purpose header. Within a session detail, show the goal, task and available summary above a separated **Live terminal · viewing** region. Preserve the harness's terminal cells and colors through Herdr's read-only observer. Make **Open native terminal** the explicit path to type, approve, scroll the actual harness history, or use harness-specific controls.

This is achievable with the installed Herdr. The earlier plain-text peek unnecessarily discarded formatting; the claim that only captured text is available would be incorrect. A live observer is available, but it is a rendered terminal stream rather than ownership of the agent's PTY or input.

## Verified capabilities and version boundary

The local CLI and running server both report **Herdr 0.8.2, protocol 20**. `HERDR_ENV=1` was checked before accessing live state. The installed commands advertise:

```text
herdr pane read <pane_id> --source visible|recent|recent-unwrapped --format text|ansi
herdr terminal session observe <target> [--cols N] [--rows N]
herdr terminal session control <target> [--takeover] [--cols N] [--rows N]
herdr terminal attach <terminal_id> [--takeover]
herdr agent focus <pane_id-or-live-name>
```

Only `read`, `observe`, and topology/status queries were executed. `control` and `attach` are listed to make the authority boundary explicit; the console's viewing adapter cannot call them.

The [CLI reference](https://herdr.dev/docs/cli-reference/#direct-terminal-attach) documents observer frames as NDJSON containing base64 ANSI. An observer cannot send input, resize or scroll the source terminal, or take over a controller. A control stream grants those capabilities separately. The [pane-read reference](https://herdr.dev/docs/cli-reference/#panes) distinguishes plain text from ANSI reads; reads strip styles unless ANSI is requested.

Public documentation currently includes newer capabilities than the installed CLI. For example, plugin `popup` is present in the bundled raw schema but absent from the installed `plugin pane open --help` placement choices. This implementation does not depend on popup placement. Probe capabilities through the installed CLI and handle unavailable observers visibly; do not assume a minimum-version string alone proves the running server implements every method.

## Three distinct viewing contracts

| Surface | Data and behavior | Appropriate use |
| --- | --- | --- |
| `pane read ... --source recent-unwrapped --format text` | One textual snapshot with soft wraps joined and styles removed. Polling produces more snapshots. | Searchable transcript or diagnostic text; label it as such. |
| `pane read ... --source visible --format ansi` | One styled snapshot of rendered output. It is not a live input connection. | Fallback preview or style evidence. |
| `terminal session observe <exact-pane>` | Persistent read-only stream of terminal frames, preserving positions and styling through full/differential updates. | The console's live terminal viewing region. |
| Native Herdr pane | The original harness renderer, input, mouse, scrollback, approvals and lifecycle. | All actual interaction with Codex, Claude or another harness. |

ANSI snapshot styling alone does not turn a transcript into a terminal. Likewise, an observer should never be presented as an editable prompt. For complete native behavior, transfer focus to the exact original pane. The parent integration retains this explicit `o` action and revalidates the current pane/tab before acting.

## Observed frame contract

An actual observer emitted:

```json
{
  "type": "terminal.frame",
  "encoding": "ansi",
  "full": true,
  "width": 120,
  "height": 40,
  "seq": 1,
  "bytes": "BASE64_ANSI_BYTES"
}
```

`bytes` is base64, not display text. Initial frames include absolute cursor positions, erase-screen, SGR styles, cursor visibility/synchronized-output modes, and OSC hyperlink delimiters. Sending them straight to the console's stdout could erase or move the console UI. Removing every escape loses the row positions as well as styling.

The public implementation at upstream commit `95e97bff3ac090ffc71bf24174ccc2449e97bcc6` documents and implements full initial rendering followed by cell differences: [ANSI encoder](https://github.com/herdrdev/herdr/blob/95e97bff3ac090ffc71bf24174ccc2449e97bcc6/src/protocol/render_ansi.rs), [render stream](https://github.com/herdrdev/herdr/blob/95e97bff3ac090ffc71bf24174ccc2449e97bcc6/src/server/render_stream.rs), and [observer CLI](https://github.com/herdrdev/herdr/blob/95e97bff3ac090ffc71bf24174ccc2449e97bcc6/src/client/terminal_sessions.rs). This source is an inspected upstream revision, not a claim that the installed binary was built from that commit.

The live samples were quiet during observation and emitted only initial full frames. Differential support was confirmed from upstream source and tested with synthetic full/delta fixtures; no live delta was claimed from those captures. The adapter therefore honors the explicit `full` flag, preserves prior cells for deltas, requires ordered contiguous delta sequence numbers, and rejects a delta without a valid baseline. A full frame can establish a new baseline after a sequence gap or dimensions change.

### Dimensions and authority

Default observation produced 120×40; explicit requests produced 96×25, 100×30 and 70×16. These are observer presentation dimensions. On the idle exact pane `wHD:pM`, native visible ANSI reads immediately before and after the 70×16 observer were byte-identical: 6,269 bytes with the same SHA-256 digest. The earlier `pane get` reads also retained identical pane records, including source scroll metrics. The native pane reported 79 viewport rows; requesting a shorter observer did not resize it.

The independent UX review exposed a critical consequence: requesting the console's smaller dimensions clips the **top** of the existing harness viewport, hiding its latest work or prompt. On this Claude pane the prompt was at native row 77 of 79, outside every smaller sample. A fresh timestamp did not make those clipped views useful.

The correction is to query `pane layout --pane EXACT`, find `result.layout.panes` by the exact pane ID, and request that record's `rect.width` and `rect.height`. In the live sample this was 177×79, matching `pane get`'s `scroll.viewport_rows=79`. The observer now obtains the full native grid. The console locally displays the bottom rows by default, preserves a horizontal offset, and labels native dimensions and visible row/column ranges. This does not resize or scroll the source terminal. A 94×18 local viewport displayed native rows 62–79 and retained the Claude prompt in verification.

`followNativeSize:true` rechecks native geometry every three seconds and restarts its observer only when the **source** geometry changes. A console resize just recrops the existing decoded native grid. The observer's defaults of 120×40 are not a native-size mode. If exact geometry is unavailable or exceeds the supported decoder bounds, show the error/native-open path rather than silently reverting to a top-clipped view.

### Lifetime and failure

The CLI emits `terminal.closed` when the server closes normally. Unexpected EOF or transport failure can end the stream without that record, so process close/error is also a disconnection. Stalled consumers may be disconnected; a quiet terminal is not itself a failure. The console terminates only its owned observer when leaving the detail, changing scope, or quitting. The adapter replaces that observer when the source viewport changes; resizing the console only changes the local crop. None of these actions closes the target pane.

The adapter waits up to eight seconds for an initial frame. Once a valid frame arrives, it does not time out an idle harness. An unsupported record, unknown drawing control, invalid UTF-8, malformed frame, missing delta or oversized frame produces a visible error and ends this observer. The operator can refresh/reopen or use the native terminal. It does not quietly claim stale text is live.

## Implementation boundary

[`console/modern/terminal.mjs`](../../console/modern/terminal.mjs) exports:

```js
const observer = observeTerminal({
  pane, onFrame, onError, followNativeSize: true,
  // optional: binary, env, spawnImpl for host routing and tests
});
observer.stop();
```

`onFrame` receives `{ width, height, seq, lines: [{ spans: [...] }] }`. Each span has printable `text`, foreground/background as explicit hex colors or `terminalFg`/`terminalBg`, and booleans for bold, dim, italic, underline, inverse and strikethrough. Hidden terminal text is emitted as spaces. Original blank cells and lines are retained.

The decoder accepts the bounded control subset emitted by the observed renderer: cursor addressing/movement, erase, SGR, CR/LF/tab, and saved cursor. OSC/DCS/APC strings and terminal modes are consumed rather than forwarded. Hyperlinks and terminal images are not made interactive or embedded. Underline variants become ordinary underline; blink is static. Default foreground/background have no palette metadata in the sampled frames and require console terminal-color tokens. Named ANSI colors use a fixed xterm palette; customized host ANSI palettes can therefore differ. RGB colors and indexed 256-color values are preserved.

Frames are bounded to 400 columns ×160 rows and four MiB of decoded bytes. A persistent grid is necessary for differentials. Unicode grapheme clusters occupy cells, with combining marks retained and wide/emoji cells tracked so overwriting one half cannot leave a stray glyph. Returned lines must be rendered using their declared cell width; do not run the console's older per-codepoint clipping helper over joined emoji. `cropTerminalSpans(spans,left,width)` safely crops styled display cells; a partially clipped wide glyph becomes a space. Crop decoded cells locally and retain the full baseline for later differential updates.

The explicit `{cols,rows}` mode remains available for bounded consumers that intentionally want that projection, and is covered by tests. The console uses native-size mode to avoid hiding the active prompt. Native geometry queries are independently bounded to four seconds and cancel when the view closes.

The adapter uses `HERDR_BIN_PATH` when provided, an argument array and ignored stdin. There is no native input/focus/resize/scroll method, no shell command, no model invocation, and no organization write. Process cancellation is idempotent and scoped to the child: SIGTERM, with a one-second SIGKILL fallback if necessary. Frame callbacks stop immediately after cancellation.

Parent ownership remains in [`console/modern/session.mjs`](../../console/modern/session.mjs): scope/selection identity, observer start/stop, generation checks, host disconnection, and operator native-open action. [`console/modern/frame.mjs`](../../console/modern/frame.mjs) and [`console/app.mjs`](../../console/app.mjs) render decoded spans in a separated terminal region. The old [`console/lib/cli.mjs`](../../console/lib/cli.mjs) `herdrRead` helper remains suitable for explicitly labeled transcript mode; its `recent-unwrapped/text` choice is not the live terminal contract.

## Host sidebar and plugin ownership

Plugin v1 supplies executable commands and terminal panes, not arbitrary native non-terminal UI. The plugin receives launch context and can be opened as a native tab or split. [Herdr plugin contract](https://herdr.dev/docs/plugins/)

The installed schema exposes pane layouts, focused IDs and plugin invocation context. It does **not** expose a native sidebar-visible field. `HERDR_ENV=1` indicates a managed process; it does not prove the host sidebar is currently expanded. Do not infer hidden host UI state from available width or edit the user's Herdr config.

Recommended UI policy: hosted mode defaults to the project's main content with a compact scope dropdown. Herdr remains the outer Spaces/Agents rail. Provide a local, reversible way to expose project worktrees when useful, and a standalone layout when outside the host. Project worktrees remain discoverable in the content without maintaining a second always-open tree competing with native navigation.

`agent.view.set/clear` is available in the installed schema and could eventually project project-specific agent filters into the native Agents view. It is a host presentation mutation and was not called. It is unnecessary for the first fix. Likewise, opening a companion context split is supported topology but should be an explicit operator action because it changes the live layout. Never move a running agent just to make a preview resemble an embedded terminal.

After native handoff, the actual harness owns its keys, including Escape. Return through the console's existing Projects tab or a deliberately configured plugin action. The console's Back action applies while viewing inside the console; it cannot promise to override the harness's Escape or Herdr's navigation without a separate host integration.

## Evidence and limits

Local evidence is under `.lane/ux-study/` and intentionally contains no copied harness text in this document:

- `herdr-api-schema.json`: bundled protocol20 schema; no sidebar visibility field.
- `observe-metadata.json`, `observe-working-metadata.json`: three exact-pane samples, frame types, dimensions and ANSI control classes.
- `observe-resize-safety.json`: underlying visible snapshot unchanged after an explicitly sized observer.
- `observe-native-size.jsonl` and `native-bottom-view.json`: full 177×79 native grid with the actual Claude prompt retained in the bottom 18-row local crop.
- `terminal-decoder-live-metadata.json`: actual Claude/Codex captures decoded into bounded styled lines without raw escapes.
- `integrated-terminal-view.txt`: actual `--modern --project herdr-brain --print 140x43 --keys 's\n'` session-detail frame, including live Codex output.
- `integrated-observer-lifecycle.json`: initial integration's lifecycle check, before the crop defect was identified; both owned observer children exited on replacement/navigation. Its smaller source projections are superseded by native-size observation.
- `terminal-tests.log`: focused offline decoder and subprocess lifecycle tests.
- [`console/test/terminal.test.mjs`](../../console/test/terminal.test.mjs): executable full/delta, whitespace, styles, Unicode, unsafe-string containment, dimensions, failures and cancellation checks.

No native focus round trip, live harness input, plugin installation or physical mouse behavior was exercised by this investigation. Those require separate operator validation. The renderer's synthetic delta tests establish decoder behavior; the captures establish that the running server accepts the read-only observe command and its actual initial frames decode successfully.
