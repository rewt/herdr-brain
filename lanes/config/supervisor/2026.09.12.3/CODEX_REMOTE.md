# Native Codex CLI remote control

This is a **host-level** setup for Codex sessions that the operator wants to
reach from the iOS Remote app. It does not select the supervisor model or
change an active non-Codex supervisor. Check `codex --version` and the installed
`codex remote-control --help` on the host; the commands below were verified
against Codex CLI 0.154.0.

Start or re-enable the managed app-server with native remote control once:

```sh
codex remote-control start --json
codex app-server daemon enable-remote-control
codex app-server daemon version
```

The first command should report a connected remote-control daemon. The second
keeps remote control enabled for future managed daemon starts, and the third
confirms the local managed app-server version. Do not paste full JSON into an
agent brief if it contains host identifiers. The daemon is shared across
projects. Do not start a separate listener for every lane.

Start a new **Codex** session in an available Herdr pane using the daemon's
local Unix socket:

```sh
herdr agent start codex_supervisor_0912 --kind codex --pane "$pane_id" -- --remote unix:// -m "$codex_model" -c "model_reasoning_effort=$codex_effort"
```

Set `pane_id`, `codex_model`, and `codex_effort` explicitly for that session.
The `--remote unix://` argument belongs to Codex after Herdr's `--` separator.
It makes that TUI use the shared local app-server; it is not a public network
listener and does not itself pair a phone. Existing Codex sessions are not
retargeted by changing this launch recipe. Use the same OS account and
`CODEX_HOME` for the daemon and the Codex TUI; a different home selects a
different local control socket.

For native manual pairing, run this only in a private interactive terminal
when the phone is ready and its Remote screen offers manual code entry. Enter
the short-lived code there:

```sh
codex remote-control pair
```

Never save the pairing code in a repository, archive, agent prompt, or test
log. Verify on the phone that a **new** daemon-connected Herdr Codex session
appears before relying on remote control for approvals or steering.

[OpenAI's app-server documentation](https://learn.chatgpt.com/docs/app-server)
documents `codex --remote unix://` for the terminal UI. The installed CLI
exposes `remote-control start` and `pair`; the current [Remote connections
documentation](https://learn.chatgpt.com/docs/remote-connections) instead
describes desktop-app pairing. Native CLI pairing and visibility in the iOS
app still require a live check. Keep the app-server on its local Unix socket
rather than exposing a WebSocket port to the network.
