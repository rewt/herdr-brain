---
run: R-203
outcome: done
summary: |
  Resolved the six findings under the supervisor's narrowed operator direction.
  Native permission choices are preserved with one visible warning naming settings and sources.
  Launch refuses overlapping fleet areas and generated worker policies protect canonical
  coordination receipts while allowing the separate request queue. Supervisor adapter fixtures
  now select short fleet temp roots and retain every role and hook assertion; the production
  60-byte refusal is unchanged. Six regression cases and focused offline evidence are committed.
headline: Native sandbox fixes preserve user settings and protect project coordination
blockers: []
proposals: []
learnings:
  - "Claude settings arrays merge across sources; inherited exclusions and path grants must be diagnosed at their source without silently replacing the operator's choices."
  - "Legacy Codex writable roots cannot exclude canonical coordination receipts within a writable checkout; generated main-mode worker launches require permission-profile support for that layout."
  - "Protecting the canonical .lane parent also prevents renaming the coordination tree; the request queue must remain outside it."
artifacts:
  - "Fix commit: 31b21fa on lane/native-sandbox"
  - discovery/native-settings.mjs
  - discovery/native-sandbox.mjs
  - discovery/runtime.mjs
  - discovery/test/native-sandbox.test.mjs
  - supervisor/test/entry.test.mjs
  - discovery/README.md
  - docs/reports/evidence/R-203/findings-red.tap
  - docs/reports/evidence/R-203/native.tap
  - docs/reports/evidence/R-203/native-kernel.tap
  - docs/reports/evidence/R-203/native-kernel-sandbox-attempt.tap
  - docs/reports/evidence/R-203/supervisor.tap
  - docs/reports/ARCH-18-native-sandbox-R203.md
decisions:
  - text: Preserved weaker operator harness settings with source-naming warnings and corrected fleet overlap and worker receipt protections through native launch settings.
    category: security
    why: The operator's explicit guidance for this fix round authorizes these changes and requires respecting deliberate native configuration choices.
questions: []
challenges:
  - "Deliberate weaker native policies can weaken confinement, as expressly accepted by the operator. The kernel denial evidence applies to the generated Codex policy; it is not a claim that danger-full-access or excluded Claude commands remain confined."
  - "Claude evidence covers settings generation, preserved configuration and hooks, and offline adapter transport. No native Claude model session or live acceptance harness ran."
---

The five discovery regression cases cover Codex inherited/CLI permission selectors
and bypass aliases, Claude interpreter exclusions, Claude additional directories
and sibling-temp grants, nested fleet roots in modern/legacy Codex and Claude,
and worker coordination receipts. The sixth case exercises all four supervisor
adapter combinations with explicitly short fleet temp and the existing supervisor
hook and role assertions. Configuration files remain intact, supplied hooks and
write arrays survive generation, and warnings identify their settings and sources.

The final discovery run passed all 16 tests with no skips. The supervisor selection
passed its one case, covering four adapter combinations; 49 unrelated cases were
explicitly excluded by the name filter. Tests made no model calls. Native Codex
kernel probes denied another project's checkout, record and temp, symlink escapes,
system-temp writes, receipt overwrites and coordination-directory renames. Own
checkout, record, run temp and request queue writes succeeded. The installed Herdr
status hook delivered its fixture session to a fake Unix socket. The real Herdr
socket was never contacted.

The initial five regression cases failed against the previous implementation,
recorded in findings-red.tap. A native probe attempted inside the current sandbox
failed on macOS sandbox nesting and Unix-socket restrictions; the approved host
probe and final focused run then passed. Both attempts are retained as evidence.

The diff was reviewed against the fix brief and the subsequent supervisor
guidance. No baseline, full suite, promotion suite, lane suite or live release
harness ran. This report is checked and committed before the required final
`node lanes/lane.mjs check`; that command writes the lane's final gate receipt.
Promotion and release checks remain with their authorized batches.

Configuration source inspection follows the local files described by the
[official Codex configuration documentation](https://learn.chatgpt.com/docs/config-file/config-basic)
and [Claude settings documentation](https://code.claude.com/docs/en/settings).
Harnesses continue to own native configuration parsing and enforcement.
