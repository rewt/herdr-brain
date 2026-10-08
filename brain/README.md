# brain

The smallest orchestrator that keeps you in the loop.

Herdr already runs the sessions, knows their state, and can be read from and
written to. What it has no place for is **what came out of a session** once it
stops. `brain` watches Herdr, notices a session going `done` or `blocked`,
reads what it said, and puts it in a queue you can look at.

The model-free steward consumes blocked entries each watch tick: worker blocks
become project supervisor notices, while supervisor blocks and stalled notices
escalate to the operator and its own bounded journal. Automatic notice delivery
uses the supervisor's existing empty-composer gate. Per-launch permission hooks
approve proven project file reads and decline everything else. A narrowly bound
terminal fallback can decline the captured Claude outside-read dialog.
It sends operator replies (`send`, `key`) or opens a session
(`start`) only when you ask, and it never closes one.

## Run it

As an always-on service (a LaunchAgent that restarts it and starts it at login):

```sh
node bin/brain.mjs service start     # or stop; the console's L key does the same
node bin/brain.mjs status            # is it alive, and when did it last look
```

Only one watcher runs at a time (`~/.local/state/herdr-brain/watch.pid`); a second one refuses
to start. By hand, in a terminal:

```sh
node bin/brain.mjs watch --catch-up --digest
```

- `--catch-up` takes whatever is already stopped on the first tick. Without it,
  done sessions need a transition; newly seen blocked sessions are always
  captured so the steward can route them. A replacement terminal/native session
  is captured even if it starts blocked in the same pane. Persisted observations
  avoid recapture of the same occupant.
- `--digest` turns on the reading pass for results the parser cannot resolve
  on its own. One ephemeral headless session (`claude -p`, Sonnet 5), no pane,
  no tools, one small call.

  Most stopped sessions never reach it. When the parser found a dialog it
  already holds the question and the options verbatim, so the entry is built
  locally and nothing is spent. On the first live run that was 5 of 8. A model
  reads only what is meaning in prose — a finished session whose conclusion is
  a real decision.

  Model choice is measured, not assumed: Haiku handles an obstacle as well as
  anything, but on a finished session carrying a genuine two-route decision it
  collapsed the choice into "send your answer" and lost it. Sonnet 5 kept both
  routes and their consequences.
- `--every N` seconds (default 5), `--model`, `--include-unnamed`.

The installed service runs `watch` without `--digest`. Updating the source does
not replace an already loaded LaunchAgent: activate the new installation with
`brain service start` when ready. No service is started by development or tests.

Then, from anywhere:

```sh
node bin/brain.mjs queue              # what is waiting, with a project column on every row
node bin/brain.mjs show <id>          # one result in full, starting with its project, plus its last screen
node bin/brain.mjs digest <id>        # run the recommendation pass by hand
node bin/brain.mjs answer <id> "…"    # record what you decided
node bin/brain.mjs dismiss <id>
node bin/brain.mjs send <id> "…"      # reply to that session (refused if it is stuck at a prompt)
node bin/brain.mjs key <id> 2         # press a key in the prompt it is stuck at
node bin/brain.mjs later <id>         # not now; it waits under LATER
node bin/brain.mjs never <id>         # drop it for good
node bin/brain.mjs start --cwd DIR --name NAME --label TEXT -- "brief"
                                      # open a session in Herdr, on the folder's Claude account
```

Brain derives the project on old and new results from the session folder and the projects in the
console configuration (`$HERDR_ORG_CONSOLE_CONFIG`, or its default): a configured checkout and its
supported worktree layouts share that project's name, while an unmatched folder is `other`.

The Brain console (herdr-org, `brain_bin` in its config) shows this queue at the top of Waiting on
you. It shows the active project's rows plus `other`, counts rows waiting in other configured
projects on one line, and switches project tabs with `p`. It runs the same commands from its keys:
a number picks a choice, `y` sends Claude's draft or the recommended choice, `r` replies, `l` saves
for later, `x` drops, and `d` on an org question starts a session with `brain start` to work it out.

## What it captures

For every stopped session: what it said last, any dialog it is stuck at with
that dialog's own options, **any text left unsent in its prompt box**, and the
raw screen so nothing is lost when a guess is wrong.

The unsent-text case is not hypothetical. On the first run against a live
machine it found five sessions stuck at the same first-run dialog, four of them
holding answers that had been typed and never delivered.

## Model-free steward policy and routing

Monitor's [unattended question guard](../supervisor/README.md) prevents a newly
launched ops session from opening its own blocking question; operator chats use
the same guard when macOS is idle for fifteen minutes, locked or unreadable.
It asks the session to record the question with a safe default and continue.
This is separate from the steward's detection and routing below. Existing
dialogs and native permission/trust prompts still need their respective handling.

`watch` runs the steward after captures and also checks stalled delivery when
Herdr is unavailable. A foreground pass is available for inspection:

```sh
node brain/bin/brain.mjs steward --dry-run  # JSON plan; no journal, owner or alert writes
node brain/bin/brain.mjs steward           # one routing pass
```

Projects come from the fleet (`$HERDR_MONITOR_FLEET/fleet.json`, default
`~/.herdr-monitor/fleet.json`) and fresh canonical Git common-directory identity.
Queue project labels, repository basenames and workspace labels do not route.
A linked worktree therefore routes to the same project's record. Only the latest
queue observation of a currently blocked session in the same pane/occupant is
eligible; answered/dismissed/acted/never entries stay resolved. New captures retain
native session and terminal IDs. Older captures lack those IDs and can only be
matched by their live pane and repository; their raw screens remain evidence.

A native supervisor's explicit launch binding can supply its recipient. Legacy
supervisors need an explicit name in `$BRAIN_STATE/steward.json` (default Brain
state below). Example, using the project's exact fleet names:

```json
{
  "enabled": true,
  "projects": {
    "bch-cloak": { "supervisor": "supervisor-opus" },
    "bch-cloak-aggregator": { "supervisor": "aggregator-gm" },
    "herdr-brain": { "supervisor": "supervisor-herdr" }
  },
  "stalled_seconds": 300,
  "debounce_seconds": 300,
  "alert_cap": 3
}
```

Worker blocks are enqueued with stable IDs at `RECORD/supervisor/inbox.log`;
an optional absolute `inbox` in a project entry selects a custom Monitor JSONL
journal. Enqueue never waits for a composer. The acknowledged transport owner
applies notice policy and delivers through the existing idle/done, two-read
composer gate. A worker notice with a lost enqueue reply retries the same ID.
Dead delivery owners are resumed each tick. The steward never focuses a pane,
invokes a supervisor cycle mutation or writes record events.

A blocked supervisor cannot consume its own notice, so it gets a steward journal
entry and a local operator alert. Missing, ambiguous, stale or foreign recipient
bindings also escalate. Native pending/uncertain notices and legacy regular
`.lane/supervisor/outbox/*.msg` files older than `stalled_seconds` use that same
alert channel. Legacy outboxes are read-only: no replay, deletion or `RETRY` file.
Unparseable inboxes escalate with their diagnostic instead of being treated as empty.

The default alert is a macOS notification via a fixed `osascript` program.
`"alert_command": ["/absolute/path/to/command", "arg"]` selects a local channel.
Add `"imessage_recipient": "operator address"` in the operator's local
`$BRAIN_STATE/steward.json` to send iMessage beside that channel. The bundled
`brain/bin/steward-imessage.mjs` passes the recipient and JSON to a fixed
Messages AppleScript using argv. An optional `imessage_command` argv array
selects another transport; it receives the recipient and then the literal JSON.
Every channel receives **project, session and kind only**, never screen text,
question text, filesystem paths or the journal location. No shell interprets
alert arguments. Each channel has a ten-second deadline; one failed channel
cannot suppress the other. No model determines a message or channel.

The operator runs exactly one setup test and grants Messages Automation:

```sh
node brain/bin/brain.mjs steward --test-alert
```

Development/tests never send that live setup alert. Configuration is local to
the operator and never becomes project configuration or a committed address.

### Signal operator setup (outbound only)

Signal is an optional third channel. Install a current
[signal-cli release](https://github.com/AsamK/signal-cli/releases) and its Java
runtime (the JVM distribution currently requires Java 25; see the
[upstream requirements](https://github.com/AsamK/signal-cli/blob/v0.14.8/README.md)).
The steward requires **0.14.8 or later**, with a stable numeric version. This is
a compatibility floor, not a promise that old releases keep working against
Signal's servers; keep the installation current. Each executable is probed with
`--version` once per process, including failures; restart Brain after an upgrade.
Channel receipts record the parsed version (null if unavailable), success or a
failure reason, without addresses, command arguments or transport stderr.

Use **two distinct accounts**, with international phone numbers. The operator's
personal number belongs on their phone; register a separate bot number capable
of receiving SMS or a verification call. Never link signal-cli to the operator's
account: linked-device messages arrive as Note to Self without an operator push
notification. Matching bot and recipient numbers are refused before any effects.

The following are manual operator commands; Brain never registers accounts or
changes trust. Set `BOT` and `OPERATOR` to the two numbers and use the installed
executable for `signal-cli`. Protect the bot's key storage before registration:

```sh
umask 077
mkdir -p "$HOME/.local/share/signal-cli"
chmod 700 "$HOME/.local/share/signal-cli"
signal-cli -a "$BOT" register --captcha "$CAPTCHA"
signal-cli -a "$BOT" verify "$CODE"
signal-cli -a "$BOT" setPin "$REGISTRATION_LOCK_PIN"
```

Obtain `CAPTCHA` by solving the
[registration captcha](https://signalcaptchas.org/registration/generate.html)
and copying the Open Signal link. For voice verification, attempt SMS first,
wait 60 seconds, then use `register --voice --captcha "$CAPTCHA"`; complete
`verify` with the spoken code. Keep the PIN private. See the upstream
[registration and PIN commands](https://github.com/AsamK/signal-cli/blob/v0.14.8/man/signal-cli.1.adoc).
If `XDG_DATA_HOME` is set, use its `signal-cli` directory instead. Keep all key
files mode **0600**, containing directories **0700** (directories need traversal
permission). These keys can impersonate the bot. Use the same OS user and data
environment for setup and Brain; no keys or numbers belong in project config.

Add only to `$BRAIN_STATE/steward.json`, using your real executable and numbers:

```json
{
  "signal": {
    "cli": "/absolute/path/to/signal-cli",
    "account": "+15555550101",
    "recipient": "+15555550102"
  }
}
```

Run `node brain/bin/brain.mjs steward --test-alert`. It sends through every
configured channel, including Signal without requiring iMessage, and writes an
intent and channel results to `steward/journal.json`. Signal receives exactly
the same filtered JSON as the existing channels. It shares their caps and
debounce during routing. Missing/unsupported CLI versions, timeouts and send
failures are receipted while the other channels deliver independently.

Every send forces `--trust-new-identities never`. An unknown or changed identity
fails closed (signal-cli exit 4); the steward never invokes `trust`. The first
refused send can discover the recipient key. Inspect it manually:

```sh
signal-cli -a "$BOT" listIdentities -n "$OPERATOR"
```

Compare the displayed safety number with the operator phone's Signal chat with
the bot: open the chat, tap its name, then View Safety Number. Verify all digits
via that trusted phone, then explicitly pin the verified number:

```sh
signal-cli -a "$BOT" trust -v "$VERIFIED_SAFETY_NUMBER" "$OPERATOR"
node brain/bin/brain.mjs steward --test-alert
```

Repeat that comparison and `trust -v` after any identity change; never use
`trust -a` or an `always` trust policy. See
[upstream identity/trust commands](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli.1.adoc#trust).
This channel runs only version checks and sends: no receive loop, daemon or reply
handling, and a reply cannot answer a record question.

Routing alerts share a per-occupant debounce (five minutes by default), with
three attempts **per episode**: a captured block or a particular undelivered
notice. Failed commands and interrupted acknowledgements consume attempts.
An exhausted stall episode cannot silence a later supervisor block. A new
capture/notice gets its own cap while retaining the occupant's debounce.
Successful delivery or a resumed session ends the corresponding condition.
Non-fleet sessions must wait `stalled_seconds` before unresolved-route alerts.
Routing Git lookups are cached for 30 seconds, with at most 512 entries;
permission approvals always resolve fresh Git and filesystem identity.

`$BRAIN_STATE/steward/journal.json` contains fsynced action intents and results,
bounded to 2,048 events and 4 MiB. Compaction retains recent active alert intents,
latest routing receipts, 128 history events and up to 256 retired alert intents
no older than seven days. Old retired receipts expire so unrelated occupants
cannot permanently fill the journal. A corrupt/full journal refuses effects and
attempts one operator `journal-refused` alert per day through a separate small
fsynced receipt. Neither corruption nor failure silently resets active receipts.
`enabled: false` disables routing, owner recovery and alerts. Unknown fields and
fleet project names fail closed.

### Permission decisions

Monitor's joined-project native launches register their permission handler in
its own [module](../supervisor/permission-hooks.mjs); `session-hooks.mjs` only
exports its registration. Existing question and lifecycle hooks remain separate.
Claude uses a per-launch **PermissionRequest command hook**. Each request runs
in its own process and can answer even if the launch adapter has exited.
Codex uses a **PermissionRequest command hook** subject to
native operator hook trust. Its command is stable across launches; the parent
supplies project/run-temp binding through `MONITOR_PERMISSION_BINDING`. Neither
adapter writes persistent settings or hook trust, nor bypasses a trust review.
Unsupported old harnesses keep their existing visible warning and native flow.

The table is deterministic and defaults to denial:

| Request | Decision |
| --- | --- |
| Claude built-in `Read`, regular file resolving inside its freshly verified checkout, project lane root, record or this launch's private temp | Allow this request only |
| Credentials, funds/chain, publishing or permission expansion | Deny, nudge the session to `record ask`, alert the operator |
| Shell commands, Codex Bash/apply_patch/MCP requests, unknown tools, foreign paths, unresolved inputs or symlink escapes | Deny and nudge the session to `record ask` |

A command is never proven read-only. No shell allow-prefix/execpolicy amendment,
`updatedPermissions`, saved permission rule or broad folder grant is emitted.
Existing native execpolicy continues to reject forbidden commands; a request
that reaches the hook is declined. Codex currently exposes no native file-read
approval class, so it has no automatic approvals. Credential-looking resolved
targets are denied even through an ordinary-looking symlink. Search/glob tools
are also denied: recursive traversal is not proof of resolved containment.
Action keywords classify non-read tool inputs; reading a project release report
or trust brief does not itself publish or expand permissions. Resolved credential
files include `.ssh/` and `.aws/` contents, dot-env files, keychain databases,
private-key files and `wallet.dat`. Credential-, secret- and seed-phrase-named
files with json, yaml, yml, toml, txt, p12, pfx, jks or keystore extensions also
deny with an alert. Source and documentation names, including wallet sources,
remain safe reads.

The denied session receives: do not work around the denial, record the question
under its work item with `record ask` and the action category, continue other
work, and wait for operator authorization before any later retry. **The session
owns recording the question via the CLI.** Brain never appends `events.jsonl`.
Local action audit is in `$BRAIN_STATE/steward/permissions.json`: fsynced before
responding, at most 512 decision receipts and 128 launch circuit counters. An
allow reserves circuit capacity with a pending receipt; only the watchdog's
acknowledgement of emitted allow output confirms that receipt as an approval.
An interrupted confirmation leaves a conservative pending reservation. The audit
stores request fingerprints and policy reasons, without copying raw requests.
Approvals stop after three identical requests or 32 approvals per launch.
Denied requests still clear the dialog when the circuit is open. Never-list
alerts consume durable per-request caps and per-launch debounce receipts before
effects; channel failure cannot become an approval. Invalid audit/config/binding
always returns a structured denial. Already-installed hooks deny if disabled;
restart native sessions after changing launch policy.
The hook has one unscaled eight-second decision deadline, enforced by a parent
watchdog even if decision work blocks its event loop. Each Git call has a
one-second timeout within that deadline. Concurrent audit writers wait up to two
unscaled seconds for the lock; dead-owner recovery shares the same deadline.
The decision worker starts an argv-only detached alert child with ignored stdio
as soon as the denial's cap/debounce receipt is durable, before releasing the
audit lock or returning the decision. Delivery proceeds if the watchdog later
kills the worker; alert failure cannot change or repeat the denial.
Deadline exhaustion emits the emergency denial and exits 2 with the nudge.
Missing or malformed launch bindings are audited denials. If checkout modules
cannot load or the hook encounters an uncaught failure, its dependency-free
emergency response emits denial JSON and exits 2 with the nudge on stderr.
That path cannot write the normal audit when its audit module is unavailable.

Terminal fallback (`key_fallback`, default true) is **denial only** and supports
the captured four-option Claude outside-working-directories read request. It
requires native session and terminal IDs, the same live blocked occupant/pane,
exact fresh screen/dialog comparisons, and repeated occupant checks. It picks
only `No, and ask again next time` (key 3), never the persistent allow/block
choices. It records an intent before keys, never retries a lost acknowledgement,
and limits attempts to three per occupant in five minutes. A durable inbox nudge is enqueued before keys
to ask the denied session to record its question. Changed/unknown dialogs,
missing IDs and hook-trust/folder-trust setup stay on the existing route/alert
path; it never guesses a key. New permission hooks take effect on new launches,
not retroactively inside sessions already running.

The native protocol shapes follow [Claude's hook reference](https://code.claude.com/docs/en/hooks#permissionrequest-decision-control)
and [official Codex hook documentation](https://learn.chatgpt.com/docs/hooks#permissionrequest).

## Where things live

- `~/.local/state/herdr-brain/queue.jsonl` — append-only log of results,
  digests and answers. Folded into the current view on read. Override with
  `BRAIN_STATE`.
- `~/.local/state/herdr-brain/watch.json` — what each session was doing last
  tick, so a restart does not re-capture the world.

## What it is not

Not a protocol. A session does not have to write a report, use a format, or
know that `brain` exists. It just finishes.

Not a scheduler. Nothing here decides what runs next; that is still your
judgement. The queue is what you judge from.

## Record signal digest and lesson distillation

For a foreground, model-free learning pass:

```sh
node brain/bin/brain.mjs digest --org /path/to/.org --json
node brain/bin/brain.mjs digest --org /path/to/.org --limit 20 --max-chars 16000
# Supervisor only, after the routed distill run and proposal review finish:
node brain/bin/brain.mjs digest --org /path/to/.org --ack PASS_ID
```

This form reads the record and optional verified settle evidence; it never calls
a model, starts Herdr, writes record events or enables the watcher's reading pass.
The existing `digest <result-id>` still reads a captured session with a model.
The operator has kept background model calls off; record distillation does not
change that choice or start a schedule.

Give the digest and [distill.md](distill.md) to a normally routed run. The pass
only proposes lessons through the record CLI. See the [supervisor procedure and
coverage rules](../docs/reference/lessons.md#distillation) for evidence review,
activation, cursor acknowledgement and release-cycle use.

State is two small files, `cursor.json` and the latest `pending.json`, under
`$BRAIN_STATE/distill/<hash-of-canonical-record-directory>/` (using the normal
Brain state directory by default). Symlink aliases share a cursor; different
records do not. Preview writes pending input but does not advance the cursor.
Repeat with the same input/bounds to replay it. A new preview may replace the
pending pass; only its current ID can be acknowledged. A failed or interrupted
run leaves the cursor unchanged. Successful acknowledgement is safe to retry.
A bounded page can end inside a report; the next page resumes at its next signal.
Keep draining while `more` is true. The default bound is 40 signals and 24,000
serialized JSON characters; hard ceilings are 100 and 64,000. Excerpts retain at
most 400 characters and explicitly mark truncation. Full evidence stays local
in the record, not duplicated into Brain history.

Cursor receipts include a hash of the consumed event prefix. Appends are safe;
a rewritten/truncated record, corrupt cursor, malformed event, duplicate sequence
or incomplete event tail refuses without advancing. Do not delete the cursor to
bypass a refusal: inspect/restore the record or deliberately choose fresh Brain
state for a full replay. The per-record `lock` directory serializes foreground
state writes. An interrupted process can leave it behind; remove it only after
confirming no digest command is running. No automatic service owns this lock.
