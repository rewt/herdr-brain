---
run: R-221
outcome: done
summary: |
  Confirmed that entering discovery and routing workers belong in separate entry lanes, share the canonical project's record, and promote approved routes into its .lane.json. The accepted fleet build retains a new project's canonical .org, superseding the earlier fleet-area recommendation. RC-5's actual failure was the acceptance sandbox denying entry request writes after TMPDIR moved into the fleet's private run directory. Fixed the harness grant, preserved the integration expectations, improved failure diagnostics, and added offline native-sandbox regressions. All 183 offline acceptance and focused discovery entry tests passed; implementation and evidence are committed.
headline: Discovery workers can reach their entry queue after the private temp handoff.
blockers: []
proposals: []
learnings:
  - The recorded R-162 fleet-build decision retains new-project records at the canonical checkout's .org; the ARCH-17 memo's external record layout was a recommendation superseded by the minimal build.
  - Entering routing workers apply approved configuration in their assigned lane and promote it into the canonical .lane.json; answering a routing question does not select a different entry role or checkout mode.
  - The acceptance profile makes the session temp read-only, while entry moves TMPDIR into f/t/<project>/r-XXXXXX. The sibling entry-requests queue therefore needs its own narrow write grant.
  - RC-5's discovery transcripts contain EPERM for every client request, including context, start, resume and apply-routes; the missing runs and missing route file were consequences of those refusals.
  - Native offline fixtures need the validation owner's fd 3 forwarded through their stand-in executable, and must await both concurrent workers before removing scratch roots.
artifacts:
  - "Implementation commit 1ffd5bc: Fix live discovery request grants after fleet temp handoff"
  - "Branch lane/rc5-discovery"
  - "acceptance/security.mjs"
  - "acceptance/live.mjs"
  - "acceptance/test/security.test.mjs"
  - "acceptance/test/live-session.test.mjs"
  - "acceptance/test/helpers/discovery-worker.cjs"
  - "docs/reports/evidence/ENG-164-R221/offline.tap"
  - "node test/helpers/run.mjs acceptance/test/*.test.mjs discovery/test/entry.test.mjs: 183 passed, 0 failed, 0 skipped"
  - "Final committed-tree check: node lanes/lane.mjs check --tier fast --cmd 'node test/helpers/run.mjs acceptance/test/live-session.test.mjs acceptance/test/security.test.mjs'; receipt .lane/gate.json"
decisions:
  - text: Keep the product's default worker entry lanes and the discovery cases' canonical record and promoted-route expectations.
    category: design
    why: The recorded minimal fleet build retains canonical .org records, and the installed entry design applies approved routes in a worker lane before promotion. No recorded fleet, native-sandbox or zero-setup decision introduces a routing-session exception.
  - text: Grant acceptance workers writes only to the harness-fixed entry-requests root in addition to their existing checkout and private run temp; exclude this grant from project validation.
    category: security
    why: The harness must permit its installed client protocol after TMPDIR relocation without granting writes to the whole scratch home, canonical project, Git metadata or fleet. Redirected queues are refused, including aliases inside scratch.
questions: []
challenges:
  - The brief's proposed explanation that record writes and adopted routes landed in entry worktrees is disproved by the RC-5 receipts and transcripts. All receipts name the canonical project .org; client requests failed with EPERM before recording runs or applying routes.
---

The intended behavior is decided by the existing record. Ordinary discovered
workers, including workers preparing or applying routing configuration, enter
their own worktrees. Explicit supervisor entry stays in the canonical checkout;
an explicit project `entry.mode: main` is the documented worker alternative.
There is no automatic role or mode change based on a task mentioning setup.
The installed design is documented in `discovery/README.md` (Project entry,
Project settings and routing) and implemented by `discovery/policy.mjs` and
`discovery/runtime.mjs`.

The source for record placement is the recorded report from R-162 on ARCH-17,
read with `record show R-162`, and its design decision in
`docs/reports/ARCH-17-fleet-build-20261003.md`: new projects retain the native
canonical checkout `.org`; their worktree and temp areas use Git identity under
the fleet home. Existing owned records are mapped in place. This supersedes the
external `p/<name>/record` recommendation in
`docs/design/ARCH-17-workspace-20261003.md`, whose status explicitly says
recommendation. ARCH-17's October 3 decisions narrow the implementation to
joining and project boundaries, and the item records the accepted fleet build
landing. ARCH-18's October 3 11:42 decision chooses native project confinement
and private temp, with deliberately weaker user settings respected by its 20:24
review guidance. ARCH-19 adds automatic entry/install and project controls;
neither changes worker routing integration. The accepted native-sandbox
correction also explicitly covers request queue writes in
`docs/reports/ARCH-18-native-sandbox-R203.md`.

Approved routes belong to project customization, ultimately committed in the
canonical `.lane.json`. `apply-routes` writes the assigned worker lane's file;
commit, green validation and fast-forward promotion integrate it. The two
release cases' canonical `.org` and `.lane.json` expectations therefore remain
correct for their brand-new projects.

Read RC-5's `21.jsonl`, `22.jsonl`, discovery entry/boundary receipts, stderr,
model transcripts/answers and summary under
`/private/tmp/herdr-acceptance-Vck0TK/evidence`. Every entry receipt names the
canonical project `.org`. The worker answers report empty run IDs and failed
client operations. The transcripts identify request-file creation under
`/private/tmp/as-*/entry-requests/<entry-id>/` failing with `EPERM`. They do not
show runs recorded into another record or configuration applied in another
checkout. Entry's retained-lane messages reflect unfinished work after these
refusals.

The acceptance profile deliberately grants the surrounding session temp only
read access. Previously its `:tmpdir` write grant covered entry requests because
TMPDIR was that session temp. Native entry now assigns a deeper private run
directory, leaving the request queue outside that grant. The harness fix names
only its fixed `entry-requests` root, checks containment and canonical spelling,
and omits the grant during project validation. Live-case diagnostics now include
the worker's failure result rather than only a run-count assertion or ENOENT.
Product entry, record placement, route application and promotion code are unchanged.

The new offline integration regression runs the real installed adapter,
`live-worker.mjs`, native transport and client protocol. A fixed script replaces
model turns; all script commands run inside the real Codex native sandbox.
Two workers enter on the same base, both record runs before a barrier releases
them, then validate and promote independent edits. A routing worker proves
`apply-routes` refuses the pending question and finishes needs_human. A scripted
human answer permits another entering worker to resume, apply, validate,
promote and finish. The canonical record contains all four reports and the
canonical route file contains the approved defaults. Main stays clean and has
no merge commits. Canonical record/Git, fleet and surrounding scratch-home
writes are denied while private run-temp writes work. Unit regressions also
refuse queue redirects to foreign paths, the canonical project and another
scratch directory, and verify validation receives no queue grant.

Before the fix, the grant regression failed and the installed native-sandbox
regression reproduced the same request-file EPERM as RC-5. After the fix, the
integration regression passed and the required offline acceptance tests plus
focused discovery entry tests passed all 183 cases with no skips. The outer
lane sandbox denied the fixture's scratch Unix socket, so these offline checks
ran through the approved host execution path while retaining their own native
boundaries and fake Herdr fixtures. The evidence log is committed. A subsequent
test-only cleanup refinement ensures a failed concurrent peer is released and
awaited before scratch teardown; the final lane check covers that committed
version.

No model call, live acceptance harness, project-wide housekeeping loop, baseline,
npm test, promotion suite or lane suite was run. No release pass is claimed.
The report is checked with the record CLI and committed separately; the narrow
fast lane check named above is the final work step, then this run stops.
