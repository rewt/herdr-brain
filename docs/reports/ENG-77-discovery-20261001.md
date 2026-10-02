---
run: R-49
outcome: done
summary: |
  Built machine-installed Codex and Claude entry adapters, automatic canonical record discovery, a portable suggested route preset and a durable operator-waiting routing question. Workers start in separate Git lanes; a session-scoped adapter performs bounded Git writes while preparation and validation remain sandboxed, and promotion uses the existing lane checks. All five independent discovery probes pass in unrelated scratch projects, including real concurrent Luna integration and operator-approved route adoption. The corrected ENG-74 release gate remains pending R-50 and promotion to main; no machine adapter, release or live project was changed.
headline: Installed entry adapters let agents discover the workflow and integrate separate lanes
blockers: []
proposals:
  - role: engineer
    title: Carry the entry adapters in machine plugin installation and prove native Herdr launch interception
    why: The reversible installer and PATH transport are built and tested in scratch. The current plugin manifest alone does not intercept harness sessions; the supervisor must install the adapters as part of the next release installation and verify native Herdr launches. Absolute native binary paths and desktop or remote sessions require their own entry transport. This lane was explicitly forbidden to alter machine harness configuration or activate a release.
  - role: engineer
    title: Prove Claude discovery and broaden validation sandbox adapters
    why: Claude prompt transport preserves flags and delivers the shared policy in offline tests, but only Codex had real model sessions here. Both transports currently use the native Codex sandbox for validation. Verify real Claude entry and add bounded alternatives for other installed harnesses and projects using external Git filters, without moving harness branches into the record core.
learnings:
  - "A machine entry transport must provide policy before the first task; placing a file in the project cannot solve first entry without another delivery mechanism."
  - "Codex 0.159.3 requires an explicit permission profile for codex sandbox; the final validator also includes managed requirements and denies network and writes outside its assigned checkout."
  - "Git detaches HEAD during a conflicted rebase. Recovery is authorized only by the assigned branch's actual rebase head-name receipt; continue stages resolved files through the adapter."
  - "Luna can infer a protected-index blocker without attempting the available continuation command. Returning an explicit paused-rebase action and staging semantics fixed the observed failure without changing models or weakening protection."
  - "An operator-approved configuration appearing on main does not prove the run finished correctly. The probe now also requires a done report and closure of the routing setup item."
  - "The successful live probe used 529722 input tokens, including 463616 cached input tokens, and 9061 output tokens. All sixteen sessions, including development failures, used 2697537 input, 2264064 cached input and 41234 output tokens."
artifacts:
  - "Commit: Provide installed project entry with isolated lanes and bounded Git promotion"
  - "Commit: Report installed project discovery and isolated acceptance evidence"
  - "Branch: lane/discovery"
  - discovery/README.md
  - discovery/install.mjs
  - discovery/adapters/codex.mjs
  - discovery/adapters/claude.mjs
  - discovery/runtime.mjs
  - discovery/policy.mjs
  - discovery/validate.mjs
  - discovery/acceptance.mjs
  - lanes/preset.mjs
  - lib/project.mjs
  - docs/reports/ENG-77-discovery-evidence-20261001
  - "Baseline npm test: 371 passed, 0 failed, 1 skipped"
  - "After-change npm test: 376 passed, 0 failed, 2 explicit skips"
  - "npm run test:lanes: 146 passed; final route tests: 7 passed"
  - "Final discovery tests with native sandbox: 6 passed, 0 failed, 0 skipped; no model calls"
  - "record check of this report, report commit, then lane check as the last command"
decisions:
  - decision: Deliver policy through machine launch adapters instead of copying instruction files into every project.
    why: The installed adapter reaches a pristine unrelated project before the model acts, can create the lane before sandbox startup, and distinguishes an explicitly selected supervisor from default workers. Codex and Claude prompt transport stay outside the neutral runtime and record core.
  - decision: Bootstrap the record on trusted entry or first record use, with canonical Git identity and race-safe initialization.
    why: Linked worktrees share the canonical record, concurrent initialization cannot truncate events, and the adapter ignores inherited record and explicit route-file overrides from unrelated sessions. Legacy ancestor records still work. Passive console discovery remains unchanged.
  - decision: Ship today's portable routes as suggestions and require a real operator answer before persisting them.
    why: The other question category is used with the generic record ask --wait option, so even an auto-answer override cannot silently choose model preferences. Yes applies the proposed preset; no leaves it unapplied; valid route JSON supports a custom answer. Personal paths, profiles and accounts are excluded.
  - decision: Keep a foreground session parent with fixed Git capabilities and sandbox all project preparation and validation.
    why: Requests cannot supply arbitrary commands, Git argv, repositories or cwd. Identity and branch receipts are checked on every operation. Git hooks, signing and fsmonitor are disabled; external filters and drivers are refused before checkout. Existing clean/rebase/green/fast-forward promotion checks remain intact, with no push or automatic deletion.
  - decision: Preserve failed probes and judge this lane through an independent installed-product test while R-50 corrects the release harness.
    why: The supervisor identified source-adjacency contamination in the unpromoted acceptance lane. This run did not edit or claim that harness green. Product installation and projects use separate scratch roots, and the final transcript command audit found zero references to either herdr-brain source checkout.
questions: []
challenges:
  - premise: Discovery needs a file in the project.
    verdict: wrong
    evidence: Four real Luna sessions received the policy through the installed machine adapter in projects with no agent instruction files. The successful projects were outside every repository tree and separate from the installed product snapshot.
  - premise: A project without a record should get one automatically.
    verdict: valid
    evidence: First record use or trusted adapter entry creates canonical .org. Six concurrent record writers retain all six events, and two entering workers share one record and one routing question. No event log is written outside the record CLI.
  - premise: The supervisor and a lane worker should be told different things.
    verdict: valid
    evidence: Workers receive own-lane instructions and no housekeeping authority. Supervisor entry requires the canonical checkout and teaches dispatch, watch, promotion and the supervisor-only housekeeping command. Role comes from explicit adapter invocation, not session registry metadata.
  - premise: The routing question waits for a human.
    verdict: valid
    evidence: The real routing session leaves exactly one other question pending and no .lane.json. A separate scripted operator answer precedes the real continuation that validates and promotes the suggested configuration. An offline test also proves --wait under other=auto.
  - premise: Promotion from a sandboxed agent session is possible.
    verdict: valid
    evidence: Both real workers finish on distinct lanes and integrate overlapping changes without merge commits. The trusted parent performs only bounded Git operations; native validation retains filesystem and network restrictions. Offline probes also deny Git metadata and outside writes and exercise actual conflicted rebase continuation.
  - premise: Installing the existing pane-only plugin automatically reaches every harness entry.
    verdict: wrong
    evidence: The current manifest supplies no machine entry interception. The shipped installer must be installed once on the machine and its bin directory selected on Herdr's shell PATH. Absolute binary, desktop and remote entry are not covered by this PATH mechanism.
  - premise: Zero setup means any folder and an unknown validation command can be promoted safely.
    verdict: partly
    evidence: Lanes require an initial Git commit and canonical identity. Node projects discover npm test or node --test; other projects need the agent to identify and record their real validation command. Unknown validation and external Git filters are refused rather than replaced with a trivial success.
---

The implementation is committed on this lane. The independent installed-product
probe passes all five discovery checks. This is not a release acceptance verdict:
`acceptance/` remains on the read-only release-acceptance lane, and its R-50
correction and the post-promotion main gate still need to run. No push, activation,
user-level installation, shared configuration change, live project mutation or
project housekeeping schedule was performed.

One-screen independent result from the final live probe:

```text
PASS    02 Record bootstrap and canonical discovery
PASS    03 Suggested routes without project configuration
PASS    04 Installed entry teaches dispatch, watch, worker and supervisor defaults
PASS    20 Real concurrent own-lane work and sandboxed fast-forward promotion
PASS    21 Real routing question waits and actual operator answer applies
Evidence: /private/tmp/monitor-projects-ZLb12E/evidence
Installed snapshot: /private/tmp/monitor-installed-FwLugf
Full ENG-74 release acceptance: pending corrected R-50 harness and promotion to main
```

Durable transcripts, prompts, answers, Git evidence, measured usage and the exact
adapter code used in each probe are in
[ENG-77-discovery-evidence-20261001](ENG-77-discovery-evidence-20261001/README.md).
The final command audit covers 66 commands with zero source-repository references.
The independent runner uses ordinary installed `codex` on PATH; the task prompts
contain work and safety boundaries, and the installed adapter supplies policy.
Native child sessions retain workspace-write, exclude broad temporary-directory
write grants, and receive only their own checkout and request queue as writable
roots. Authentication copies were deleted; they are absent from the evidence.

Measured successful-run tokens on `gpt-5.6-luna` at low effort:

| Session | Input | Cached input (subset) | Output | Reasoning output (subset) |
|---|---:|---:|---:|---:|
| French worker | 110750 | 97280 | 1755 | 160 |
| German worker | 204170 | 178688 | 3591 | 208 |
| Routing question | 66224 | 56064 | 1749 | 213 |
| Apply operator answer | 148578 | 131584 | 1966 | 218 |
| Total | 529722 | 463616 | 9061 | 799 |

All four development probes, sixteen real sessions, are retained. Their totals
are 2697537 input, 2264064 cached input, 41234 output and 5208 reasoning output
tokens; cached and reasoning counters are subsets, not extra totals. No pricing
is inferred. Attempts exposed missing native sandbox profile syntax, rebase
receipt handling, premature ingestion and unclear continuation semantics. The
last case assertions also prevent a written configuration with an unfinished run
from passing. Final refinements after the successful live snapshot add startup
filter/root refusal, inherited-route-file isolation and managed-requirement
preservation; the final six-test offline native sandbox suite verifies them.

The first-entry choices have different costs and coverage:

| Mechanism | Per-project cost | Reach and limitation |
|---|---|---|
| Project AGENTS.md or CLAUDE.md | A tracked setup edit in every project | Reaches compatible harness readers after the file exists; cannot explain first entry by itself |
| Harness SessionStart hook | No project file; one machine hook install | Harness-specific, with trust and writable-root timing to handle; not built or installed here |
| Herdr plugin pane/action | No project file | Reaches that explicitly opened pane/action; the current manifest alone does not intercept native sessions |
| Installed launch adapter, chosen here | No project instruction file; one machine install | Tested real Codex CLI entry; Claude transport tested offline; prepares the lane before sandbox startup |
| Record CLI bootstrap | Local .org on first use; no model cost | Harness-neutral record adoption, but an agent needs a delivered reason to invoke it |

The supervisor should install from an immutable released product using the exact
recipe in [discovery/README.md](../../discovery/README.md), then make the dedicated
entry bin directory precede native Codex/Claude on Herdr's shell PATH. The installer
requires absolute native executable receipts, refuses unmanaged replacements,
and supports removing only unchanged managed files. The dedicated launcher
accepts an explicit supervisor role; default native session entry is a worker.
This machine step was tested only in scratch and is the remaining activation
boundary, not a per-project setup requirement.

For R-50 integration, use the candidate's machine installer in an isolated bin
and launch the real native sessions through that bin. Keep product installation
and projects in separate roots, keep broad temporary write grants excluded, and
require both actual main integration and durable done reports. Case 04 must
observe the supplied no-model entry contract rather than ending pending
unconditionally. The current release acceptance source was only read here.

The adapter's sandbox transport follows the documented
[Codex developer instructions configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
and [permission profiles](https://learn.chatgpt.com/docs/permissions); the local
installed CLI established the required native sandbox syntax. Claude uses the
[append system prompt flag](https://code.claude.com/docs/en/cli-reference). Neither
harness's model or effort flags are reinterpreted by the record core.

The report is checked before its commit. The required lane check runs last on the
clean report commit and writes its gate receipt under the ignored .lane directory.
