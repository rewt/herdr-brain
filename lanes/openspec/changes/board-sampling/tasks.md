# Bound board observation sampling

## Outcome

Make machine inventory sampling responsive and bounded without changing discovery
identity, filtering, or lifecycle semantics.

## Repository context and authorization

Read the repository instructions, shared OpenSpec workflow, and all artifacts in
this change before implementation. Start only after board-inventory is promoted and
work only in `lane/board-sampling`; commit but never push, promote, close, rewrite
history, or edit `docs/reviews/`.

## Scope and limits

`lane.mjs`; dependency-free board services excluding `board/app.mjs` and `board/ui/`;
`test/`; `README.md`; `docs/REFERENCE.md`; `docs/reports/board-sampling.md`;
`HANDOFF.md`; this change.

No new discovery sources, persistent machine/history registry, lifecycle scheduling,
or remote/process/filesystem discovery.

## 1. Lane-sized task

- [ ] 1.1 Deliver Responsive bounded observation and all scenarios; add and observe
  failing offline regressions with deliberate negative controls; document behavior;
  sync only the sampling delta into the current capability; write the report and
  HANDOFF entry; commit; then obtain a passing GATE against the final commit.

## Acceptance checks

Verify delayed-Git input responsiveness, one in-flight refresh, two-child sampling,
event coalescing, no duplicate per-checkout samples, stable row selection, stale and
disconnect semantics, unknown-on-error behavior, and runtime-cache cleanup on a
100-session/ten-repository fixture. Run the shared serialized verification protocol.
