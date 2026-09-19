# Design: Bound board observation sampling

## Sampling and refresh

Collect Git and report data once per checkout on each five-second tick,
asynchronously with at most two child samples at once and one in-flight refresh.
Coalesce event refreshes to at most four per second; agent state events may update
rows directly. Apply request timeouts and retain prior observations visibly stale
when a server fails. A Git/read error produces unknown data, never clean or zero
ahead. Drop runtime caches when sessions disappear and retain no persistent history
cache.

Mark observations stale after two missed five-second ticks, or immediately after a
known disconnect. A timeout and an unchanged successful working-session sample are
distinct; silence never implies blocked, completed, or overdue. Overdue requires an
explicit valid deadline in the past.

Keep stable row IDs and bind selection to row identity across sorting, filtering,
and refreshes. Verify a sanitized 100-session, ten-repository fixture with delayed
Git: keyboard/CLI input is accepted within 100 ms on the available machine, at most
two samples run concurrently, refreshes do not overlap, and duplicate checkout
sampling is absent. Report observed refresh time and process counts without
hardcoding host-speed thresholds into tests.

## Split boundary

This change owns only Responsive bounded observation. It depends on
[`board-inventory`](../board-inventory/), which owns endpoint enumeration, canonical
repository/agent joins, coverage, machine scope, filtering, grouping, and done
semantics. Dependants requiring complete board-discovery wait for both changes.
