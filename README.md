# brain

The smallest orchestrator that keeps you in the loop.

Herdr already runs the sessions, knows their state, and can be read from and
written to. What it has no place for is **what came out of a session** once it
stops. `brain` watches Herdr, notices a session going `done` or `blocked`,
reads what it said, and puts it in a queue you can look at.

It never starts, prompts, keys or closes a session. It only watches and reads.

## Run it

```sh
node bin/brain.mjs watch --catch-up --digest
```

- `--catch-up` takes whatever is already stopped on the first tick. Without it,
  only transitions count, so a restart is quiet.
- `--digest` sends each result to one ephemeral headless session
  (`claude -p`, Fable by default) that turns it into a plain summary, a
  question, options with consequences, and a recommendation. No pane, no tools,
  one small call.
- `--every N` seconds (default 5), `--model`, `--include-unnamed`.

Then, from anywhere:

```sh
node bin/brain.mjs queue              # what is waiting
node bin/brain.mjs show <id>          # one result in full, plus its last screen
node bin/brain.mjs digest <id>        # run the recommendation pass by hand
node bin/brain.mjs answer <id> "…"    # record what you decided
node bin/brain.mjs dismiss <id>
```

## What it captures

For every stopped session: what it said last, any dialog it is stuck at with
that dialog's own options, **any text left unsent in its prompt box**, and the
raw screen so nothing is lost when a guess is wrong.

The unsent-text case is not hypothetical. On the first run against a live
machine it found five sessions stuck at the same first-run dialog, four of them
holding answers that had been typed and never delivered.

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
