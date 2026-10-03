# ENG-120: the release gate's focus monitor and a busy Herdr

Release candidate RC-2 (2026-10-03) gated 9 pass / 0 fail / 18 pending: case 05's focus monitor threw
'focus subscription startup did not settle' (acceptance/focus.mjs: it waits for 400 ms without pane.focused
events, up to 5 s, to drain startup replay), and every Herdr case depends on case 05. Evidence:
/private/tmp/herdr-acceptance-JN4Osm/evidence and .git/release/RC-2.log in the canonical checkout.

First find out what was streaming focus events (Herdr's subscription replay, a chatty pane, or the operator's own
pane switching); say which in the report. Then make startup robust to it. The monitor exists to prove the harness
never moves the operator's focus (ENG-98), so it must still catch any focus move the harness causes; it must not
require the operator to stop using Herdr while the gate runs.

Run npm run test:fast, the acceptance offline tests and at most one acceptance --skip-live pass. Never run the live
harness. Commit, write the report, record check it, commit it, run lane check last. Then stop.
