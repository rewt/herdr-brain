---
run: R-113
outcome: done
summary: |
  Removed Herdr's parent-focusing worktree removal from lane closure, made both
  plugin pane actions explicitly preserve focus, and prohibited the unsafe removal
  API in acceptance. Added a separate read-only sampler and focus-event subscriber
  spanning the full acceptance run, including cleanup, with actual/requested call
  receipts and offline failure controls. Full acceptance of the committed lane
  candidate passed all 27 cases; the operator pane never changed in 1,298 samples.
headline: Full acceptance passed without moving the operator's focus
blockers: []
proposals:
  - role: engineer
    title: Include implicit source workspaces in acceptance ownership and cleanup
    why: |
      Native worktree create with --cwd can also create a primary source workspace,
      but its creation response names only the linked workspace. The full gate's
      default-cycle source workspace w247 remained outside the receipt ledger after
      cleanup. Its exact run-specific scratch identity was independently verified
      and it was closed with zero focus changes in a supplementary trace. The
      harness should retain a proof of these implicit creations, close them itself,
      and test that a green scope audit cannot hide them. Evidence is retained at
      /tmp/eng98-focus-audit/remaining-source-workspaces.json and
      /tmp/eng98-focus-audit/final-cleanup/closure.json.
learnings:
  - Herdr 0.8.2 worktree remove focuses its parent even when the removed workspace is in the background; workspace close followed by Git worktree removal preserves an unrelated focused pane.
  - Herdr's agent start, pane run, prompt and key/text input have no --no-focus option; creation flags do not govern later lifecycle removal.
  - A sampler in the runner's own event loop would pause during spawnSync; a separate process and pane.focused subscription detect both long calls and focus changes restored between samples.
artifacts:
  - "Commit: Preserve operator focus through lane cleanup and full acceptance"
  - "Commit: Report operator focus acceptance and scope findings"
  - "Branch: lane/operator-focus"
  - "docs/reports/ENG-98-operator-focus-evidence-20261002/candidate/summary.json"
  - "docs/reports/ENG-98-operator-focus-evidence-20261002/candidate/screen.txt"
  - "/private/tmp/eng98-full-gate/herdr-acceptance-EtiJZ0/evidence/focus-trace.jsonl"
  - "/private/tmp/eng98-full-gate/herdr-acceptance-EtiJZ0/evidence/focus-calls.jsonl"
  - "/private/tmp/eng98-full-gate/herdr-acceptance-EtiJZ0/evidence/focus-summary.json"
  - "/private/tmp/eng98-full-gate/herdr-acceptance-EtiJZ0/evidence/discovery-usage.json"
  - "/tmp/eng98-focus-audit/original-focus-excerpts.log"
  - "/tmp/eng98-focus-probe-bcQ1bG/trace.json"
  - "/tmp/eng98-herdr-schema.json"
  - "/tmp/eng98-focus-audit/final-cleanup/focus-summary.json"
  - "/tmp/eng98-after-tests.log; /tmp/eng98-lanes-tests.log; /tmp/eng98-acceptance-tests.log"
  - "Final validation command: node lanes/lane.mjs check; committed report HEAD receipt: .lane/gate.json"
decisions:
  - text: Use separate Herdr workspace and Git lifecycle operations for background lane closure.
    category: design
    why: The native combined operation forces parent focus. This changes the existing cleanup's implementation, preserves all durable branch history through archive-tag recovery, and retains Git cleanliness and repository identity guards.
  - text: Pass --no-focus explicitly from both shipped plugin pane actions.
    category: design
    why: Console and supervisor pane creation should preserve the operator's current screen; explicit operator navigation remains available through the console's Go action.
  - text: Reject parent-focusing worktree removal at the acceptance capability boundary.
    category: security
    why: The approved acceptance boundary forbids focus mutation. Older callers must receive a named refusal before native mutation instead of disturbing the operator during a regression run.
  - text: Fail the focus case on every observed change, including external changes and changes restored between samples.
    category: prover
    why: A zero-change trace must be independent of blocked runner commands and must never conceal a focus change by restoring the old pane. Broken monitoring is pending, never passing evidence.
questions: []
challenges:
  - premise: Creation flags explain every focus jump in the supplied trace.
    evidence: The server log places worktree.remove immediately before forced parent focus at 15:06:16 UTC and 15:12:14 UTC. The supplied trace records those destinations as w22P:p1 and w239:p1. These are lifecycle-removal effects after background creation.
    resolution: Replace the parent-focusing removal operation and monitor through cleanup, not just worker startup.
  - premise: Every destination named in the original trace was an acceptance-owned workspace.
    evidence: The original run's ownership.json at /private/tmp/herdr-acceptance-rgMI5x/evidence excludes w22K, w22J and w1YQ. It also omits the implicit default-cycle source workspace w239, which the native log identifies as the late removal's parent.
    resolution: Record call correlations without claiming unsupported causality. External focus changes still fail; implicit source-workspace ownership is proposed separately.
---

The full candidate gate passed **27/27**, with no pending cases, in 382 seconds.
The operator pane was **wFN:pY6** before candidate execution and remained there
through cleanup: **1,298 samples, zero focus events, zero changes, zero monitoring
errors**, over 381,711 ms. The separate monitor never issued a focus mutation.
The supplementary closure of the implicit source workspace retained the same
baseline in three samples and also recorded zero events, changes or errors.

The original failure's direct cause is visible in the retained native log:
`worktree.remove` closes a background lane, then focuses its primary workspace.
This explains both repeated early jumps to the configured fixture and the late
default-cycle jump. Merely extending creation flags cannot affect that operation.

Call audit:

| Surface | Findings and treatment |
| --- | --- |
| Lane worktree create/open and dispatch tab creation | Existing explicit `--no-focus` retained and covered by offline tests. |
| Lane closure and promotion-queue closure | Replaced native `worktree remove` with verified workspace closure plus Git removal. Archive recovery and clean-worktree guards pass. |
| Brain startup, supervisor startup and compatibility settle launcher | Tab creation already uses `--no-focus`; agent startup uses an explicit pane. Kept the compatibility launcher's path, flags and behavior. |
| Watcher tab startup | Existing background tab creation and explicit `pane run` retained. |
| Plugin console and supervisor actions | Both now pass `--no-focus` explicitly. Installed-entry canary already passes it. |
| Acceptance scripted startup, real-session startup and PTY delivery | Explicit returned pane IDs; native pane run/text/keys preserve focus. Native creation is forced background by the adapter. Removed the adapter's permission to forward worktree removal. |
| Housekeeping, tidy, tab/workspace closure and signal cleanup | No focus commands; background closure verified in the full run and scratch probe. No project-wide housekeeping loop was started. |
| Console Go and documented attach commands | Deliberate operator navigation only; background dispatch does not invoke them. Terminal observers have no focus or attach API. |

The installed CLI help and its exported protocol-20 schema were checked directly.
Creation, split/move and plugin pane open support focus selection; agent start,
pane run and terminal input do not accept `--no-focus`. The [official socket API
reference](https://herdr.dev/docs/socket-api/) documents the focus event and
subscription surface. Offline tests use the installed schema's
`{type: "pane.focused"}` subscription shape and prove that a transient change
restored between samples still fails, naming both the actual native transport
call and the requested candidate call. Changes outside a recorded call are
labelled as external activity rather than attributed to an unrelated caller.

Validation:

| Check | Result |
| --- | --- |
| Baseline `npm test` | 682 pass, 0 fail, 11 skip. |
| Post-change `npm test` | 683 pass, 0 fail, 11 skip. |
| `npm run test:lanes` | 150 pass, 0 fail, 0 skip. |
| `npm run test:acceptance` | 68 pass, 0 fail, 0 skip. |
| Full acceptance against the implementation commit | 27 pass, 0 fail, 0 pending; operator-focus PASS. |

```sh
ACCEPTANCE_TMPDIR=/tmp/eng98-full-gate node acceptance/run.mjs \
  --candidate 0e8f9b7 \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm \
  --discovery-model gpt-5.6-luna --discovery-effort low
```

All four measured discovery sessions used the approved cheapest route, completed
successfully, and retained measured usage in scratch. Scripted mechanics exercise
real Git, record, lanes and Herdr PTYs; their agent-start requests are replaced by
the stand-in transport and do not establish native interactive startup detection.

Only the candidate summary and screen are tracked alongside this report. Raw
logs, traces, prompts and measured usage remain under the evidence paths above.
The gate removed authentication copies and discovery/session roots, and closed
all receipt-owned workspaces. The independently discovered implicit source
workspace was subsequently closed under its own zero-change trace; the proposed
follow-up addresses that pre-existing ledger gap. No bch-cloak files, shared lane
configuration, release directories, operator bin, unowned panes, push or publish
were changed. The report is checked and committed before the final lane check;
that check writes its exact committed-HEAD result to `.lane/gate.json`.
