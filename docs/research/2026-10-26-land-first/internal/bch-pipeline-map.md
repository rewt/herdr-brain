# BCH pipeline map: from dispatch to main, and after

Read-only research, 2026-10-26, cutoff about 18:17 CDT (record seq 47078). Times are CDT. Sources: BCH `AGENTS.md`, config home `/Users/rewt/.herdr-monitor/bastian/bch-cloak/`, BCH `scripts/lane` and `scripts/publication`, installed Brain c160, Brain source, BCH `events.jsonl`, run briefs and reports, and today's 88 archive entries. INFERRED marks a conclusion I did not verify directly.

## Summary

- R-3310 to R-3346 is 37 runs: 18 done, 18 blocked, 1 running.
- "Blocked" rarely meant the code stayed off main. 6 blocked runs still landed their code. Only 3 runs have committed code off main.
- Engineering caused only 2 of the 18 blocks. Guards caused 5, process order 4, permissions 2 and stale items 5.
- Brain's promote refuses a run with no recorded report when it is called with `--if-current-run`. BCH supervisor briefs require that form, so workers report first and land in a later phase. This cost 2 minutes to 3 hours per item today.
- Push 2 (rehearsal v0.2.0) is ENG-2157. It has had 12 runs since 20:31 last night, and 11 stopped at the next guard. The operator approved push 2 at 14:07. Four of the remaining steps are bookkeeping, not boundary checks.
- Withdrawal validation sits behind about 34 strictly serial slices of 300 lines or fewer. INFERRED: the zero-value Chipnet run does not need most of them.

## 1. BCH's own layer

### Enforced by code

| Rule / gate | Where | Applies |
|---|---|---|
| Landing waiver: skips validation, review-PASS, blocker and child checks | config `lane.validation.json`; installed `promote/guard.mjs:28` | At promote |
| Recorded report (done, or blocked under the waiver) before the fast-forward; only with `--if-current-run` | `promote/guard.mjs:45`; `promote/README.md:80` | At promote |
| STOP file, expected head, lane identity, superseded run, open operator question | `promote/guard.mjs:30-33, 46-53, 69` | At promote |
| Session cap 7; memory admission | `dispatch/session-cap.mjs`; `dispatch/dispatch.mjs:435, 529` | At dispatch |
| Freeze 297.34 s (no output AND no activity) | config `promote.json` env | At test run |
| Legacy BCH promote refuses unconditionally (`PREMAIN_GATES_DEFERRED`) | BCH `scripts/lane/lane.mjs:401` | Old path |
| Line service picks only `ready`, unheld items | Brain `line-service/line-service.mjs:270, 273` | At dispatch |
| Six publication steps; push for the rehearsal target only | `scripts/publication/publication.mjs:16, 115` | At publish |
| `authored-source-head`, `skeleton-source-missing`, `provider-scan-unintegrated` | `authored-source.mjs:80`; `covenant-skeleton-overlays.mjs:162`; `covenant-skeleton-prepare.mjs:208` | At prepare |
| Independent review PASS bound to the current scan-generator commit | `scripts/public-export/scan-review-bindings.mjs:65, 88-89` | At prepare |
| Approval pinned in code (still the 31-path `c5540fcb`) | `scripts/public-export/rehearsal-plan-authority.mjs:11` | At prepare |
| Fresh-clone tests after push | `rehearsal-clone.mjs` (`verify-clone`) | After push |

### Prose only

| Rule | Where |
|---|---|
| No pre-main gate; engineers land their own work; red main is accepted | `AGENTS.md:1-53` |
| One async review, cap 1, one fix round; Majors fixed before release | `AGENTS.md:20-31, 661-668`; `lane.json` rules 4 and 9 |
| One full release test at release/adoption | `AGENTS.md:13-18` |
| PRIVATE check plus fresh-clone N1/ten tests/typecheck before and after every push | `AGENTS.md:37-42` |
| S11 validation deferred to release/adoption | `AGENTS.md:44-49` |
| 115 s between session starts (the supervisor checks by hand) | `AGENTS.md:647-648`; `lane.json` rule 5 |
| Codex only until Monday; Bastian identity; no push without authorization | `AGENTS.md:645, 607-613` |
| SP1 proving discipline; check base commit first; rebuild dist | `AGENTS.md:371-470, 564-584` |
| 300 lines / 10 paths per chunk, "stop, don't compress"; a "BEFORE CODE" note per chunk | Briefs only (main-chat rule, 10-21, record seq 24350, 24881) |
| Report first, then land in a separate phase | Briefs, for example `archive/ENG-2124B1-SDK-RAW-ABI-BRIEF-20261026.md:27` |

Conflicts:

- The installed decision-routing appendix still says "Pool construction stays private" (`DECISION-ROUTING.md:219`) and "focused pre-merge package checks remain the validation direction" (`:248`). Both contradict `AGENTS.md:1-4, 692-698`.
- `AGENTS.md:615` is an empty heading.
- No HOLD or STOP file exists right now. Item `meta.held` is code-enforced in the line service.

## 2. Runs R-3310 to R-3346

| Run | Start | Item | Outcome | On main? | Block reason (cluster) |
|---|---|---|---|---|---|
| 3310 | 08:34 | ENG-2143 | done | yes, c1ccd0e6..aba0f8e6 | none |
| 3311 | 08:38 | ENG-2157 | done | yes, a3deb13f | none |
| 3312 | 08:45 | ENG-2141 | done | already on main | none |
| 3313 | 08:50 | ENG-1836 | blocked | yes, e120cf75 | Reviewer started 64.8 s after the last start (rule is 115 s); callback deadline missed (process). No Vitest in the fresh worktree (environment) |
| 3314 | 10:12 | ENG-2143 | done | n/a (packet) | none |
| 3315 | 10:17 | ENG-2157 | blocked | n/a | Provenance file missing; rehearsal checkout drift (guard) |
| 3316 | 10:24 | ENG-1836 | done | yes, d5009ef1 | none |
| 3317 | 10:35 | ENG-2141 | done | yes, 79690225..abe557b3 | none |
| 3318 | 11:01 | ENG-2157 | blocked | n/a | Policy names an old scanner digest (guard) |
| 3319 | 11:30 | ENG-1866 | blocked | later, b3492ba0 | Git rebase EPERM on `.git/worktrees` (permission) |
| 3320 | 11:37 | ENG-1907 | blocked | NO, 4 commits | Native Git permission; lane 91 commits behind main (permission) |
| 3321 | 12:21 | ENG-2157 | blocked | later, 16:28 | 124 known-value lines plus an unscannable `.patch` (guard); report-first refusal (process) |
| 3322 | 12:31 | ARCH-762 | done | yes, e166d7d0 | none |
| 3323 | 12:36 | ENG-2124 | blocked | later, 14:42 | Report-first refusal (process); `kill EPERM` |
| 3324 | 14:18 | ENG-2157 | blocked | later, 19a915eb 16:28 | Signed scope still 31 paths; review binding (guard) |
| 3325 | 14:22 | ENG-1866 | blocked | yes, by 14:35 | Only a source handback before promote (process) |
| 3326 | 14:47 | ENG-2129 | blocked | n/a | Missing owner and runner-config producers (engineering) |
| 3327 | 14:58 | ENG-2124 | blocked | n/a | Draft at 336 lines, over the 300 cap (process) |
| 3328 | 15:56 | ENG-2124 | done | yes, fc259a68 | none |
| 3329 | 16:06 | REV-1179 | done (PASS) | n/a | none |
| 3330 | 16:28 | REV-1182 | done (NEEDS-WORK) | n/a | none |
| 3331 | 16:58 | ENG-296 | blocked | n/a | September scope, stale payload (stale) |
| 3332 | 17:00 | ENG-2124 | done | yes, a63cac94 | none |
| 3333 | 17:03 | ENG-319 | done | yes, ab28daf5 | none |
| 3334 | 17:04 | ENG-2157 | blocked | NO, b5cf7790 | Scratch guard `EVIDENCE_PRIVATE_VALUE` (guard) |
| 3335 | 17:06 | ENG-1866 | blocked | n/a | Mutant's assertion not confirmed (engineering) |
| 3336 | 17:10 | ENG-824 | done | yes, e8fd285c | none |
| 3337, 3338 | 17:17, 17:23 | ENG-1123, ENG-1124 | done | n/a (delivery tracking) | none |
| 3339 | 17:26 | ENG-1866 | done | n/a | none |
| 3340 | 17:29 | ENG-1125 | blocked | NO, cd6e9197 | Supervisor scope hold (stale) |
| 3341, 3343, 3345 | 17:36, 17:47, 17:59 | ENG-1126 | blocked (R-3345 not yet ingested) | n/a | Acceptance needs retired gates (stale; redispatched 3 times) |
| 3342 | 17:41 | ENG-1136 | done | yes, a9da9724..c5339a02 | none |
| 3344 | 17:52 | ENG-1140 | done | yes, cb3abfb4 | none |
| 3346 | 18:07 | ENG-1141 | running, then held | n/a | n/a |

Clusters (18 blocked runs):

| Cluster | Count |
|---|---|
| Engineering | 2 |
| Gate/guard | 5 (all push 2) |
| Permission | 2 |
| Process/order | 4 |
| Stale item | 5 |

Main took 50 commits today, from about 923 worker-minutes. The idle gaps waiting for a disposition between runs were often longer than the runs themselves:

- ENG-2157: 63, 18, 42, 52 and 64 minutes.
- ENG-2124: 129, 14 and 37 minutes.
- ENG-1866: 88, 159 and 5 minutes.

## 3. Push 2: from 19a915eb to the private repo

Push 1 (v0.1.0) ran all six canonical steps in one session on 10-24 (`archive/REHEARSAL-FIRST-PUSH-20261024/attempt2/`). A 31-path v0.2.0 release record has existed since 10-25 13:46 (`publication/releases/covenant-shielded-pool-rehearsal-v0.2.0.json`). The scope then grew to 32 paths:

1. The operator's rule against elapsed-time test failures (ENG-2147) needed a Vitest patch (ENG-2150, 7 runs).
2. The fresh-clone tests have to use the patch, so it must ship (ENG-2154, ENG-2157).

| # | Step | Owner | State | Kind |
|---|---|---|---|---|
| 1 | D-consumer and construction source (19a915eb set) | ENG-2157 | Landed 16:28 | Needed |
| 2 | Operator conditional approval of the exact 32 paths | Operator | Given 14:07 (seq 46538) | GENUINE: approval |
| 3 | Brain Chat T2 method document (`rewt/.org/evidence/BCH-PUSH2-CONDITIONAL-APPROVAL-T2-20261026.md`) | brain-chat | Done | Bookkeeping |
| 4 | Supervisor "FULL read, adopted" note | supervisor-opus | Done (seq 46539) | Bookkeeping |
| 5 | Turn the grant into authenticated code data; signed-scope resolution | ENG-2157 (R-3334) | b5cf7790 committed, not landed | Mostly bookkeeping (approval is pinned in code) |
| 6 | Land R-3334 (report intake, then rebase) | ENG-2157 | Pending | Ordering |
| 7 | Classify the `EVIDENCE_PRIVATE_VALUE` hit on a non-MAIN output | Disposition, then worker | Cause UNKNOWN | GENUINE |
| 8 | Write out the complete 32-file candidate | ENG-2157 | Stopped | GENUINE: exact candidate |
| 9 | Full strict and value-shape scan; reconcile the 124 known-value lines via the approved construction rule; zero unresolved | ENG-2157 | Not run | GENUINE: real-secrets check (the operator's condition) |
| 10 | Review PASS bound to the new generator commit | REV queue | REV-1180 held (wrapper failed); cap 1 allows no re-review | Ordering (a review used as a code gate) |
| 11 | Rebind the v0.2.0 release and generated records to 32 files | ENG-2157 | Not done | Needed, bookkeeping in form |
| 12 | "Signed-data disposition": install approval pins | ENG-2119 (HOLD, 0 runs) | Held | Bookkeeping |
| 13 | Supervisor binds the final candidate to the approval scope | supervisor-opus | Pending | Bookkeeping |
| 14 | Majors resolved before outward action | Engineer | R-3321 Moderate open; REV-1180 has no verdict | Ordering |
| 15 | Fresh clone before push: N1 first, restore, ten tests, typecheck | Publisher | Not run | GENUINE |
| 16 | `publication prepare`, promote, commit, PRIVATE check | Publisher | Not run | GENUINE |
| 17 | `publication push` | Publisher | Not run | GENUINE: the boundary |
| 18 | `verify-clone` plus tests after push | Publisher | Not run | GENUINE |

Genuine boundary steps are 2, 7-9 and 15-18. Steps 3-6 and 10-14 are ordering or bookkeeping. INFERRED: steps 8, 9 and 15-18 are about two runs of work.

## 4. Withdrawal-to-wallet validation path

| Item | Depends on | State |
|---|---|---|
| ARCH-720 GATE: zero-value Chipnet deposit-to-exit | ENG-1931, ENG-1699, ARCH-726 | Open, 0 runs |
| ARCH-726: Chipnet run plus operator funds go | ENG-1940, ENG-1954, ENG-1699 | Open |
| ENG-1940: run packet (raw harness) | Lists ENG-1934 admission and S11 as prerequisites (`archive/ENG-1940-RUN-PACKET-20261024.md:73`) | Draft done 10-24 |
| ENG-1954 / ENG-2133: S11 route and its validation | ENG-2133 held until release/adoption | Source landed; validation deferred |
| ENG-1931: harness withdraw route | HUM-169 | 0 runs |
| ENG-2130: Electron Cash funding/payout recipe | REV-1155 (PASS, left open) | F1 done; F2a queued 18:17 |
| ENG-2124: resource policy and probes (slice 1 of 18) | REV-1149 (PASS, left open), ARCH-765 | A1/A2 landed 14:42; B stopped at 336 lines; B1 landed 16:25; B2a landed 17:19; B2b brief only |
| ARCH-762: withdrawal-owner design | none | On main e166d7d0: 16 serial allocations W1a..W3e (`WITHDRAWAL-OWNER-PREDECESSORS.md:211-246`) |
| ENG-2129: W1a owner | ENG-2125d after 2125a after 2124b, plus host provenance | Blocked; held 18:16 |
| ENG-1907: packet-check activation | ENG-2137 (done, left open), HUM-169 | Protected `rebase --continue` approved 13:56, still no result at 16:16; review NEEDS-WORK (1 Major); 4 commits off main |
| ENG-2136: prove-duration measurement | Over 20 GB free, PAM lock, after adoption step 4 | Held |

Genuinely needed for the zero-value validation run:

- harness withdraw route (ENG-1931);
- S11 route (ENG-1954);
- wallet recipe (ENG-2130);
- funded packet (ENG-1940);
- operator funds go (ARCH-726);
- direct-RPC evidence;
- one review of the run (REV-1014).

INFERRED ordering: the consumer 16 GiB admission (about 18 slices) and the W1-W3 owner path (16 slices) are not needed if the run uses the raw harness.

## 5. Instruction load

| Component | Words |
|---|---|
| Dispatch prompt (`dispatch/dispatch.mjs:624-634`) | about 500 |
| Run brief `runs/R-*/brief.md` | 1,344-3,060, median about 2,200 |
| Ask, supervisor-dispatched | usually 500-800; 3,261 (R-3319); 9,132 (R-3322) |
| Ask, line service | 52-93 |
| BCH `AGENTS.md` | 6,245 |
| Package `AGENTS.md` files | 101-246 each |
| Installed `PROTOCOL.md` (AGENTS.md:652 says read it) | 1,298 |
| `DECISION-ROUTING.md` (named as canonical) | 3,322 |
| Each disposition marked "FULL read" | 500-1,500 |

A typical supervisor-dispatched worker reads 10,000-12,000 words before working, and the largest reach about 20,000. Briefs use joined-up shorthand, for example "four-literal-Bastian" and "inherited1505/53/ONEinstall0".

## Order problems

1. **Report before landing.** With `--if-current-run`, promote refuses until a report exists (`promote/guard.mjs:45`). BCH briefs demand that form, so workers file a "source handback" (often marked blocked) and land in a separate phase:
   - ENG-2124 A1/A2 was accepted at 12:49 and landed at 14:42.
   - R-3321's source landed 3 hours after its report.
   - R-3325 was "blocked" only for this reason.

   Line-service runs (R-3333, R-3336, R-3342, R-3344) promote without the flag, and land and report in one run.

2. **Each rebase is an escalation.** Sandboxes cannot write `.git/worktrees/*` (R-3319). After a report-first delay main has moved, so expected-head refuses (ENG-2124 note at 14:39) and a separately approved protected rebase is needed. ENG-1907's approved `rebase --continue` has produced no result for more than two hours. The no-polling rule leaves it unchecked (notes at 15:04 and 16:16).

3. **Publication guards are found one per run.** ENG-2157's 11 blocked runs since 20:31 yesterday each stopped at a new refusal:
   - privacy guard;
   - store;
   - Git permission;
   - tar field;
   - installed membership;
   - ten extra files;
   - source pin and drift;
   - scanner digest;
   - D admissions;
   - signed scope and review binding;
   - output guard.

   Each refusal costs a cycle of 18-64 minutes: Brain Chat writes a disposition in the rewt record, supervisor-opus adopts it, then writes a new brief. Nothing runs `pnpm publication prepare` in a mode that collects every refusal at once.

4. **A review is a publish gate in code, and it resets.** `scan-review-bindings.mjs:88-89` requires a PASS bound to the current generator commit. Push-2 runs keep editing `generate-scan-admissions.mjs`. With cap 1 and no re-review, the later-source review stays UNKNOWN and prepare refuses (`:65`; R-3324). REV-1180 is held because its wrapper failed.

5. **A test-timing rule grew the outward file set.** The elapsed-failure rule required a Vitest patch, and shipping the patch turned 31 paths into 32. That forced a new amendment, a new operator approval and a scan of an "unscannable" `.patch` (R-3321). The 31-path record had been ready since 10-25 13:46. INFERRED: a 31-path push 2 could have gone first.

6. **A crude guard runs ahead of the real classifier.** R-3334 stopped in a scratch helper kept in the archive (`signed32-R3334/evidence/prepare-normal-candidate.mjs:63`). It uses the M5C evidence-writing guard (hash 910b) and imports from `/private/tmp/corpus-admission-R-3299-replacement`, so the D scanner never ran. INFERRED: the canonical prepare into `.publication/stage` would run the real scan first.

7. **An approval has to become code.** The approval came at 14:07. R-3334 then spent 70 minutes making the grant into authenticated data, because approvals are pinned in code (`rehearsal-plan-authority.mjs:11`). ENG-2119, which installs them, is a HOLD with 0 runs.

8. **A stale hold blocks the line service.** HUM-169 is a 10-18 "manual promotion only" hold, superseded by the 10-25 waiver. It still blocks 84 open items, including ENG-1931 (0 runs) and ENG-1907. The line service dispatches only `ready` items (`line-service.mjs:270`). Finished but unclosed items (REV-1149, REV-1155, REV-1153, ENG-2137) are only clutter: Brain treats a done outcome as resolved (`lib/state.mjs:295-296, 373-375`).

9. **A blocked report triggers immediate redispatch.** A blocked item with resolved links reads as `ready` (`lib/state.mjs:381`), and dispatch keys per last run. So ENG-1126 ran three times, 3-4 minutes apart, with the same conflict, until it was held at 18:10. The service also picked September items (ENG-296, ENG-1123..1126, ENG-1136, ENG-1140, ENG-1141) ahead of current work. Supervisor-opus noted this too (`archive/STREAMLINE-RESPONSE-supervisor-opus-20261026.md:5`).

10. **Withdrawal validation waits on consumer slices.** The validation run uses the raw harness, but its packet lists the ENG-1934 admission (`ENG-1940-RUN-PACKET-20261024.md:73`). Current work therefore follows about 34 strictly serial slices. INFERRED: ENG-1931 + ENG-1954 + ENG-2130 + the funds go is the shorter path. ENG-1931 has never run.

11. **The validation run waits on validation deferred to the end.** `AGENTS.md:44-49` defers S11 validation (ENG-2133) to release/adoption. ENG-2133 blocks ENG-1954, which blocks ARCH-726. INFERRED: the Chipnet run cannot be scheduled before adoption, whatever its own readiness.

12. **The line cap strands coherent work.** "Stop, don't compress" split one sampler into B, B1, B2a and B2b: four runs and three disposition gaps (R-3327 stopped at 336 lines). Each chunk also needs a "BEFORE CODE" note; R-3334 alone wrote eight between 17:14 and 17:57. Supervisor-opus agrees the caps should be "scheduling aids, not reasons to strand a coherent fix" (`STREAMLINE-RESPONSE...:3`).

13. **Bookkeeping is counted as failure.** R-3313's code had already landed, yet it was reported blocked partly for reviewer spacing (64.8 s against a prose-only 115 s rule, `AGENTS.md:647`) and a missed callback deadline.

14. **Fresh worktrees have no dependencies.** R-3313's check failed for lack of Vitest and `node_modules` (`AGENTS.md:440-448, 564-573`). R-3316 and R-3317 each spent part of their run installing before the fix.

15. **Instructions contradict each other.** The `DECISION-ROUTING.md:219, 248` appendix contradicts `AGENTS.md:1-4, 692-698`. Every worker has to resolve the precedence across about 11,000 words.
