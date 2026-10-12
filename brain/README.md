# brain

A foreground, model-free record signal digest for lesson distillation. It is
all that remains of Brain: no service, capture queue, steward or model call.

```sh
node brain/bin/brain.mjs digest --org /path/to/.org --json
node brain/bin/brain.mjs digest --org /path/to/.org --limit 20 --max-chars 16000
# Supervisor only, after the routed distill run and proposal review finish:
node brain/bin/brain.mjs digest --org /path/to/.org --ack PASS_ID
```

The digest reads the record and optional verified settle evidence. It never
calls a model, starts Herdr, writes record events or runs in the background.

Give the digest and [distill.md](distill.md) to a normally routed run. The pass
only proposes lessons through the record CLI. See the [supervisor procedure and
coverage rules](../docs/reference/lessons.md#distillation) for evidence review,
activation, cursor acknowledgement and release-cycle use.

State is two small files, `cursor.json` and the latest `pending.json`, under
`$BRAIN_STATE/distill/<hash-of-canonical-record-directory>/` (default
`~/.local/state/herdr-brain`). Symlink aliases share a cursor; different
records do not. Preview writes pending input but does not advance the cursor.
Repeat with the same input/bounds to replay it. A new preview may replace the
pending pass; only its current ID can be acknowledged. A failed or interrupted
run leaves the cursor unchanged. Successful acknowledgement is safe to retry.
A bounded page can end inside a report; the next page resumes at its next signal.
Keep draining while `more` is true. The default bound is 40 signals and 24,000
serialized JSON characters; hard ceilings are 100 and 64,000. Excerpts retain at
most 400 characters and explicitly mark truncation. Full evidence stays local
in the record, not duplicated into Brain state.

Cursor receipts include a hash of the consumed event prefix. Appends are safe;
a rewritten/truncated record, corrupt cursor, malformed event, duplicate sequence
or incomplete event tail refuses without advancing. Do not delete the cursor to
bypass a refusal: inspect/restore the record or deliberately choose fresh Brain
state for a full replay. The per-record `lock` directory serializes foreground
state writes. An interrupted process can leave it behind; remove it only after
confirming no digest command is running.

Files left by the removed capture service and steward (`queue.jsonl`,
`watch.json`, `watch.log`, `watch.pid`, `explain/`, `steward*`) are inert; nothing
reads them. Releases no longer manage the `com.rewt.herdr-brain` LaunchAgent, and
activation refuses while that plist exists ([herdr/README.md](../herdr/README.md)).
