# Operator route profile 2026.09.12.1

This is a pinned core CLI and configuration release based on herdr-lanes
`de11d4b` (package `0.1.0`). It includes only the files listed in
`core-files.txt`. The built-ins-only board observation modules are required
by the CLI, but the interactive console entrypoint and dependencies are
excluded. The new Lane Console frame and inventory lanes remain subject to
independent review. The release does not choose a model for an already-running
agent.

The `monitor` route is for one short, read-only status session. Start it with a
small brief containing exact repository, agent names, current bindings, and the
question to answer. Use the monitoring protocol below. Do not keep a monitor
session alive to wait on unchanged agents. Prefer direct shell inspection if no
model judgment is needed.

The `review-codex` route permits an explicit Codex reviewer while preserving
each operator's existing `review` route and default dispatch policy. Select it
with `lane review ... --route review-codex`. The normal review template and
independent fixed-commit evidence rules still apply.

Parent `.lane.json` is inherited by descendants, except where a repository
overrides the same route name. Check `lane config` in a target repository before
assuming either route applies. Repository-specific dispatcher scripts and direct
Herdr starts do not read this profile.

## Monitoring protocol

1. Discover exact names and cwd once using a compact `herdr agent list` projection.
2. Check a named agent only at a milestone, on a user request, or after a known
   state change. Record its `state_change_seq`; skip unchanged states.
3. Never repeat `herdr agent wait` on `idle` or `done`. A timeout while `working`
   is no new result. Resume other useful work or end the session.
4. Read at most 40 to 80 recent lines after a transition. Prefer Git HEAD,
   committed artifacts, gate files, and review records for durable conclusions.
5. Send one concise update per actual transition. Do not infer approval or any
   financial, wallet, or chain action from pane status.

Measure total input, cached input, uncached input, output, model response count,
and elapsed time per completed milestone. Cached input is reused prompt context
counted again on later requests; a high cache ratio alone is not evidence of
unique new content or of low total cost.
