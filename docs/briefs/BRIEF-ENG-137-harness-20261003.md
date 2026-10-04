# ENG-137: release acceptance harness fixes before RC-4

Read ENG-137 (record show, including its note on R-169's review Minors) and R-168's recorded report
(`/Users/rewt/development/rewt/.org/reports/R-168.md`, evidence under `docs/reports/evidence/ENG-133/`). RC-4 is cut
when this lands, and its gate must fail only for real product reasons. Since RC-3, main gained the native sandbox
(ARCH-18), zero-setup install (ARCH-19) and fast CI (ENG-157: slow tests now run in candidate preparation).

Fix the harness, not the product, for each finding, with an offline regression in `acceptance/test/` that fails first:

1. The scripted stand-in supervisor shows a blank screen; production's empty-composer check (ENG-106) correctly
   treats that as unreadable, so notices never deliver (cases 06, 08-13). The stand-in must present a real empty
   composer. Do not weaken the production check.
2. Case 07's inner promotion contends with the real host test slot. Runs nested inside the gate run inside the gate's
   slot.
3. Case 27 saw a focus change into an owned workspace with no correlated tooling call. Find the cause and keep the
   focus assertion. If the cause is product code, make the smallest fix with its own regression and name it in the
   report; if it is bigger than that, stop and report it as a blocker with evidence.
4. The harness cleans up the owned inbox owner workers it starts.
5. R-169's Minors: the `acceptance/herdr.mjs` polls near lines 174 and 187 honour the real deadline, not only a nominal
   one, while each iteration waits on native calls; the cases 19-20 regression exercises the real `run.mjs` wiring.

Files: `acceptance/` only, unless finding 3 proves otherwise. Per AGENTS.md: run the offline acceptance tests and at
most one `--skip-live` pass, at the end, when the promotion train is idle (`.git/promote/queue.json` has no
`current`). The harness may hold the host test slot for that pass as the gate does; nothing else in the lane takes it.
Never run the live harness. Report per-case results of the pass; any remaining failure gets its cause and whether it
is harness or product. Commit, write the report, record check it, commit it, run lane check last. Then stop.
