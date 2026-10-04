---
run: R-200
outcome: done
summary: |
  Implemented native launch settings and short private fleet temp paths in discovery/.
  Codex uses an explicit permission profile when supported, with a legacy writable-root fallback;
  Claude receives a per-session settings file with write paths, peer-project denies and preserved hooks.
  Worker, assigned/headless and resume launches export TMPDIR/TMP/TEMP; validation uses isolated
  fleet temp for each step and cleans it on success or failure. Long paths refuse with a reason,
  unsupported harnesses visibly warn, and no outer session wrapper or Herdr socket policy was added.
  Committed with offline acceptance evidence and ready for the single review round; no promotion or push.
headline: Native launch settings and short private temp paths are ready for review
blockers: []
proposals:
  - role: engineer
    title: Adapt remaining native-launch consumer fixtures to short fleet temp roots
    why: |
      The approved 60-byte limit intentionally rejects long fleet temp roots. Static inspection of
      supervisor/test/entry.test.mjs shows its adapter fixtures still use long system-temp roots.
      Reconcile these consumer fixtures with ENG-157 before promotion/release validation; this run
      changed and tested only discovery/ fixtures, as directed by the operator.
learnings:
  - "Current Codex sandbox requires a permission profile; legacy sandbox_workspace_write settings do not narrow the built-in :workspace profile. The generated monitor-worker profile passed real kernel denial probes."
  - "Claude appends claude-<uid> beneath CLAUDE_CODE_TMPDIR; set that override as well as TMPDIR/TMP/TEMP. Settings generation uses the documented schema for Claude 2.1.284 or later; older or unknown builds warn."
  - "macOS native sandboxes do not nest. Host-only offline probes ran through an approved sandbox escalation, using disposable projects and a fake Herdr socket."
artifacts:
  - "Implementation and tests: commit 44fe2a4 on lane/native-sandbox"
  - discovery/native-sandbox.mjs
  - discovery/temporary.mjs
  - discovery/test/native-sandbox.test.mjs
  - discovery/README.md
  - docs/reports/evidence/R-200/native.tap
  - docs/reports/evidence/R-200/focused.tap
  - docs/reports/evidence/R-200/transport-filter.tap
  - docs/reports/evidence/R-200/copied-transport.tap
decisions:
  - text: Implemented the operator-approved minimal native sandbox scope and retained Herdr's socket transport.
    category: security
    why: The ARCH-18 operator decision and current brief expressly authorize native write confinement and short per-run temp, and exclude wrappers, brokers, tokens and grant machinery.
questions: []
challenges:
  - "Tests outside discovery/ were left untouched and unrun. The remaining long consumer fixture roots are an integration follow-up, not evidence of a production fallback; long production roots are deliberately refused."
---

Real Codex acceptance passed all 11 cases, including writes to another project's checkout,
record and temp, a symlink escape, system-temp denial, allowed own-project writes, and the installed
Herdr agent-state hook reporting its fixture session to a fake Unix socket. The real Herdr socket
was never contacted. Claude evidence covers native settings generation, existing hook merging and
scripted adapter transport; no live Claude or Codex model session ran.

Focused launch, lifecycle and validation checks passed 46 cases with three explicit provider skips.
Transport/filter regression evidence has 34 passes and two earlier long-fixture failures; both
copied-product cases subsequently passed after shortening their discovery fixtures, recorded in
copied-transport.tap. No baseline, full suite, promotion suite or release acceptance harness ran.

Validation still protects the selected record's resolved files, including a linked event log.
The updated test checks these targets rather than requiring the kernel to prevent removing an
own-worktree `.org` symlink; that link is not the fleet's authoritative record path. Lifecycle
ownership, identity and recovery checks remain in place. Normal native exit removes its temp;
crash-leftover sweeping stays with ENG-127.

Native keys were checked against the [Codex configuration reference](https://developers.openai.com/codex/config-reference),
[Claude sandbox documentation](https://code.claude.com/docs/en/sandboxing) and
[Claude temp environment reference](https://code.claude.com/docs/en/env-vars).
Self-reviewed the diff against the current brief. The report is checked and committed before the
required final lane check; that last check is the existing lane smoke, with full validation reserved
for promotion.
