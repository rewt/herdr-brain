# ENG-121: a lane opens on its agent, with no empty tab

Operator, 2026-10-03: every dispatched worktree lane opens with two tabs. `herdr worktree open` (lanes/lane.mjs,
ensureHerdrWorkspace) creates a default tab '1' with an idle shell; dispatch then creates the agent tab
(`tab create --label agent:TOPIC --no-focus`). The workspace's active tab stays the empty '1', so clicking the lane
shows an empty shell and the operator has to click again to reach the agent.

Make a freshly dispatched lane open on its agent with no empty tab: for example run the agent in the initial tab,
or close the initial tab only when dispatch itself just created it and it is still an untouched idle shell, or make
the agent tab the workspace's selected tab. Whatever you choose must never move the operator's focus (ENG-98, and
acceptance case 27) and must never close a tab with anything the operator started. Reused lanes and fix rounds
(a new agent tab in an existing workspace) should also leave the newest agent tab selected. Check what Herdr 0.8.2's
CLI and socket API support (herdr --skill; herdr worktree/tab --help) before designing around it. Keep lanes/
dependency-free; Herdr-only checks skip explicitly when Herdr is absent.

Run npm run test:fast and npm run test:lanes; never the live harness. Commit, write the report, record check it,
commit it, run lane check last. Then stop.
