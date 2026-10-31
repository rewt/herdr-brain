# Git project caller audit for ENG-1165

R-1564 audited the semantic identity change from the immutable ENG-1160 range
at 7febec3a, against correction base 7bd6cde0. The durable call inventory is
`.org/evidence/ENG-1165/R-1564/git-project-callers.json` in the owning record.
It lists tracked production call lines and surrounding statements, excluding
tests, historical evidence and the definition. Counts differ from the review's
earlier inventory because this selection includes all production directories.

Result: no additional caller was found to require `includeHead`. Discovery's
contract is checkout/canonical/common-directory identity. A caller needing a
source revision must observe that revision explicitly. This audit does not
claim dynamic coverage of every consumer or restore incidental dependencies on
unrelated worktree tips.

| Consumer group | Consumed identity and independent source fence |
| --- | --- |
| Release pin selection | `lib/releases.mjs:pinSnapshot` explicitly requests `includeHead:true`; `committedPin` consumes the snapshot head and committed pin bytes. `releaseProject` supplies identity only. |
| Record/config/ownership | `lib/store.mjs`, `record-guard.mjs`, `config-home.mjs`, `config-audit.mjs`, `config-command.mjs`, `fleet.mjs`, `run-owner*.mjs` consume paths/common identity. Config content, adoption scope, queue members and claim generations are separate observations. `integratedClose` explicitly checks ancestry to HEAD. |
| Source delivery/promotion | `landing-receipt.mjs` explicitly checks both canonical and lane HEAD against the delivered head in its plan. `promote/promote.mjs` reads committed settings at its own HEAD and retains expected-head/FF guards; `lanes/lane.mjs` owns worker promotion. `source-provenance.mjs` checks exact object IDs and ancestry. |
| Closeout/recovery | `closeout.mjs:bindCleanupEntry` observes selected branch/head and physical identities separately. `closeout-code.mjs` reads canonical branch/tip explicitly. `closeout-allocations.mjs` rechecks the original lane head and branch generation. Recovery derives head with `rev-parse` and compares each original target before binding. Executor admission still checks actual project, source enablement and original refusals. |
| Dispatch/resume/settle/verify | `dispatch/launch-guard.mjs` checks the selected review head explicitly; `dispatch.mjs` checks immutable review source. `not-started.mjs` checks the original lane base. `resume-source.mjs` checks recorded branch, registration and clean saved work. `settle/settle.mjs` and `verify/verify.mjs` retain their own immutable job/desk source observations. |
| Line review/runtime | Queue, admission and source discovery consume project identity plus their captured target/ownership index. `review-unstarted.mjs`, `review-reference.mjs` and `review-recovery.mjs` explicitly recheck canonical/source/lane heads and clean state. Runtime/probation operations consume immutable release manifests and separate scope/authority archives. |
| Read views/routing/native recipients | Board, summaries, archive, routes, sessions, logs, messages, supervisor context/status, observer and watcher callers use canonical/common identity and native/record tuples. A moving main head is not part of those identities. Their existing native and policy checks remain separate. |

No project identity implementation change was needed. The semantic projection
still validates its identity result before commit and seals physical Git inputs
across append/effect admission. R-1554's record-planning controls are retained
historical evidence, including their original reds; they were not replayed.
The correction's focused finite-turn control exercises identity discovery and
real executor refusal outside record-planning. Broader consumer suites, a full
suite, installed canary and real-work soak remain UNRUN for this correction.
