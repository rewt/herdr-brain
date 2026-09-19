# Brief: show coordination evidence in console details

Status: future engineering lane. Start only after board-frame, board-details,
complete discovery (inventory plus sampling), and the coordination read-model are
reviewed and promoted. Read repository instructions, `openspec/README.md`, this
change and those prerequisite designs/specs before work. Suggested route: engineer;
effort: High. Work in a separately authorized lane.

## Outcome and boundary

Consume only the CLI's read-only coordination projection. In Context/Evidence,
show project/outcome, assignment ID, owner and integration owner, **planned next
milestone**, reported latest delta pointer/time, blocker/decision and next action
with unavailable/historical/read-stale reasons. Preserve the board's existing
machine/repository coverage, fixed evidence
pane, keyboard focus, NO_COLOR cues, stable row selection, and technical attention.
Show acceptance as unknown until the integration owner supplies separate verified
acceptance evidence; a reported result alone is not accepted. Show coordination
decision/blocker reasons separately; a combined count counts one session once.
A root grouping cannot become a launch target. No action is inferred
from owner, report, blocker, or deadline display.

Scope: `lane.mjs` interactive launcher forwarding only; `board/args.mjs`,
`board/app.mjs`, `board/cli-client.mjs`, and UI-only `board/ui/`; `test/`,
README/REFERENCE, report, HANDOFF, and only the complete Interactive coordination
source forwarding and Separate coordination attention requirement blocks into
`openspec/specs/coordination-observation/spec.md` after implementation. Parse the
interactive flag and pass the once-resolved source through launcher/app/client to
each initial, refreshed, and reconnected watch child; leave focus/done action
arguments unchanged. Do not add a second CLI control path, Git/Herdr socket or
target-file reads in the UI, dependency upgrades, composer behavior, model polling,
lifecycle retry, or background coordination.

## Test-first acceptance

Observe failing built-ins-only `test/` fixtures with deliberate negative controls
for absent/ambiguous owner, historical latest report, planned versus accepted labels,
blocker plus failed gate, unique attention count, NO_COLOR, keyboard selection/focus,
and reconnect without actions. An injected process-boundary fixture must trace
`--coordination` from `lane.mjs` through `board/args.mjs`, `board/app.mjs`, and
`board/cli-client.mjs` to every watch child, including refresh/reconnect, while
action children receive no source and reconnection invokes no action.
Serialize `npm test`, relevant controls, `git diff --check`, optional board install
and real-TTY smoke after clear process probes; distinguish simulated rendering from
observed terminal behavior. Commit report/HANDOFF, run `lane check` at final HEAD,
and leave independent review/promotion/close to the integration owner.
