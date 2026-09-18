# brain

The smallest orchestrator that keeps you in the loop.

Herdr already runs the sessions, knows their state, and can be read from and
written to. What it has no place for is **what came out of a session** once it
stops. `brain` watches Herdr, notices a session going `done` or `blocked`,
reads what it said, and puts it in a queue you can look at.

Watching and reading need nothing from you. It sends into a session (`send`, `key`) or opens one
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
  only transitions count, so a restart is quiet.
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
