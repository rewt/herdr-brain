# ENG-139: merge train recovery paths

Read ENG-139 (record show) and the round-2 train review it cites (docs/reviews/train/ on main). The train is on main
(settle is review only; promotion batches run CI once). Fix the four recovery paths: after main moves under a capped
settle, 'handle RUN --retry --fix-findings' reaches the fix-findings branch instead of recapturing first; the record
stage and the other named incomplete stage no longer dead-end after main moves; a failed report-to-main velocity note
never blocks tab cleanup and lane close; a lost fast-forward response is still adopted after later batches advance main.

Failure-path acceptance: a test for each path, written first. Keep promotion's guarantees: never push, never merge
commits, the combined tree is green before main moves. Ship with those tests; run them and the files you touch only;
no baseline or full-suite runs. Commit, write the report, record check it, commit it, run lane check last. Then stop.
