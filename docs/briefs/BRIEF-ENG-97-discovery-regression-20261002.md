# Brief: ENG-97, v0.1.5 discovery regression

Org item **ENG-97**. Read `AGENTS.md`, `acceptance/README.md`, `discovery/README.md` first.

## The outcome

The release gate against `releases/v0.1.5` (tag v0.1.5 = main 02a41c5) gives 24 pass / 2 fail: case 21
(Real discovery: concurrent lanes and promotion; detail "work must reach main through promotion") and
case 22 (Real discovery: routing question waits and answer applies; ENOENT for the project's
`.lane.json`). Both passed against v0.1.4 (f476589). In case 21 the real agents committed "Report
promotion validation blocker" twice; in case 22 the agent applied the routing answer in its lane but
it never reached main. Evidence (read-only): `/private/tmp/herdr-acceptance-wz8SsU/evidence/` (21.jsonl,
22.jsonl, summary.json); a retained discovery project from a run at `/private/tmp/herdr-discovery-I4cLkU`.
Find the cause and fix it so cases 21 and 22 pass again. Suspects, not conclusions: ENG-81's macOS
validation sandbox selection (a nested sandbox inside the agent's Codex sandbox may be refused);
ENG-84/ENG-94's promotion guard now imported by lane; ENG-88's test bounds; ENG-82 entry settings.

Judged by: the cause named with evidence (bisect between f476589 and 02a41c5 with the two cases, on the
cheapest route as the harness does); a fix with an offline regression test where possible; and the
harness against a candidate built from your lane passing all cases (run `--candidate` on your
lane's ref).

## Boundaries

Work only in this lane's worktree and scratch. Never write the release directories, bch-cloak, the
shared `.lane.json`, `~/.local/bin`, or panes you did not create. Real discovery sessions on the
cheapest route are approved for this (operator's ENG-74 decision); no credentials beyond what the
harness already uses. Keep `contrib/settle-watch.mjs` as `AGENTS.md` says. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it,
commit it, and run `lane check` last. Then stop.
