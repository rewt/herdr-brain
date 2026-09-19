# Identity coordination: independently deliverable briefs

This is an index, not a completed implementation task. Each unchecked brief is a
separate, reviewable lane when explicitly commissioned. Do not sync either proposed
delta into `openspec/specs/` in this specification lane.

- [ ] 1. [Manual protocol adoption](briefs/manual-protocol.md): review authority,
  select one identity/two repositories, fill private roster and pilot template,
  and run the bounded manual comparison. No console prerequisite or product code.
- [ ] 2. [CLI coordination read-model](briefs/coordination-read-model.md): after
  board-inventory and board-sampling promote, add bounded opt-in JSON/watch
  projection with offline tests; sync only projection and bounded-read requirements.
- [ ] 3. [Console coordination detail](briefs/coordination-details.md): after
  board-frame, board-details, and brief 2 promote, forward the selected source
  through the interactive process boundary and render it without widening actions;
  sync only forwarding and separate-attention requirements. Independent of manual
  pilot execution.

Each implementation lane follows `openspec/README.md`, its own prerequisite and
approval checks, a test-first product change where applicable, serialized
verification, a report/HANDOFF entry, and a current post-commit `lane check` gate.
The operator or designated integration owner handles independent review,
promotion and close. No brief authorizes push or an account change.
