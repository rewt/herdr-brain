**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: c41ec1e27656b9f4a1c0cc17f3297715b5987160
Topic: discovery
Round: 1
Review ID: lr-c3efe29d2addc77399aef68f37723b3a
Base branch: main
Base commit: f6d6eef4dc7bc9175261745d3b600e035a1e2a41

## Findings
- [Major] discovery/runtime.mjs:160 - apply-routes runs in the unsandboxed session parent and writes the agent-writable lane file .lane.json through writeFileAtomic, whose temporary name is the predictable .lane.json.tmp-PID and is opened with a plain writeFileSync that follows symlinks; a sandboxed worker can pre-plant that temporary name as a symlink to any file the user can write (for example a shell rc file) and the parent writes the route JSON through it outside the sandbox before renaming the link away, which defeats the stated rule that the privileged writer never follows an agent-created temporary symlink; Fix: in the session parent write agent-reachable files with a random temporary name opened with the wx flag (as poll already does for replies) or an O\_NOFOLLOW plus O\_EXCL open, lstat-check the target directory chain, and add an offline test that plants a symlink at the old temporary name and asserts the outside target is untouched
- [Major] discovery/install.mjs:30 - the codex and claude shims wrap every session launched from the Herdr shell PATH the README tells the operator to prefix, but existing launchers (lane dispatch, contrib/settle-watch.mjs and supervisor/open-session.mjs all use herdr agent start with kind codex or claude) pass no role or bypass, so createEntry defaults to worker and always creates a fresh lane from main: a dispatched engineer is moved out of its assigned lane worktree, a supervisor opened by open-session is told it is a worker with no housekeeping or dispatch authority, settle sessions spawn and leak new lane worktrees, and any codex or claude session in a non-Git folder, a repo with no commit, or a canonical checkout not on the integration branch now exits 1 instead of starting; Fix: make entry detect an already-assigned lane worktree or an explicit launcher-set role and pass through unchanged, have lane dispatch, settle-watch and open-session pass the correct role or bypass, fall back to the native executable with a warning when no lane identity exists, and add offline tests that run the installed shim from a dispatched lane worktree, from a non-Git folder and from a supervisor launch
- [Moderate] discovery/runtime.mjs:45 - every broker Git call (commit, rebase continue) runs with GIT\_CONFIG\_GLOBAL set to the null device, which drops the user's global user.name and user.email; in this very repository the identity is configured only globally (git config local user.name is unset, global is set), so monitor commit either fails or records an auto-detected host identity, and the offline tests and the acceptance probe mask this by setting repo-local user.name and user.email in every fixture; Fix: read user.name and user.email with normal config resolution before entry and pass them as GIT\_AUTHOR and GIT\_COMMITTER environment values (or override only the dangerous keys through GIT\_CONFIG\_COUNT instead of discarding global config), and add a fixture whose identity exists only in a scratch HOME global config
- [Moderate] discovery/runtime.mjs:48 - externalGit inspects config with normal global resolution and refuses any filter clean, smudge or process key, so a machine with git-lfs installed globally (git lfs install writes filter.lfs.\* to the global config) refuses entry in every project, including projects that never use LFS; for a product meant for any project this turns the installed codex and claude shims into hard failures; Fix: only refuse drivers actually referenced by the checkout's gitattributes for tracked paths, or treat known drivers such as lfs through a bounded allowlist, and add a test with a scratch HOME that has a global lfs filter and a project without LFS attributes
- [Moderate] bin/org.mjs:100 - automatic record bootstrap from the plain CLI path initializes the canonical .org directory but, unlike discovery/runtime.mjs ignoreRuntime, never adds it to the local Git exclude file, so the first record command (even record status) in a fresh project leaves .org untracked in the canonical checkout, and lane promote then fails requireClean on the canonical checkout because git status porcelain lists untracked files; Fix: share one helper that adds the .org and .lane runtime paths to the common-dir info/exclude whenever the record is auto-initialized inside Git, and extend the case 02 tests to assert git status porcelain is empty after bootstrap
- [Moderate] lib/store.mjs:44 - findOrgDir now replaces the starting directory with the canonical checkout before the ancestor walk, so an initialized .org below the repository root (a monorepo subproject record, or any record nested under the checkout) is no longer found from inside that subdirectory, and openOrg then silently auto-initializes a second divergent record at the canonical root, the outcome the brief asks to avoid; Fix: walk ancestors from the original cwd up to and including the checkout root first, then try the canonical checkout's .org, then continue above the canonical checkout, and add a regression test with a nested record
- [Minor] discovery/validate.mjs:13 - validation settings merge the worker lane's own .lane.json over the canonical project config, so a worker commit that sets validate to a trivially true command (or adds prepare steps) controls the green validation gate that promotion relies on, contrary to the README claim that unknown validation is never replaced with a trivial check; Fix: take validate and prepare from the canonical project config when present, allow a lane value only when the canonical value is absent, and print the effective validation command and its source in check and promote output

## Re-executed
```json
[]
```

## Non-claims
- No claim is made that npm test, npm run test:lanes, the native sandbox test or any acceptance case passes at the reviewed commit; the gate at captured HEAD is inherited evidence only.
- No claim is made that the ENG-74 release acceptance cases 02, 03, 04, 20 and 21 pass; the lane ran its own discovery acceptance script, not the ENG-74 harness against main.

## Unverified
- npm test, test:lanes, discovery sandbox test and discovery acceptance were not run; the supplemental brief contains no Review run budget, so the budget is zero commands.
- The live PASS evidence in attempt-4 was produced by an earlier runtime snapshot; the reviewed runtime adds startup filter refusal, worktree-root refusal and route-file isolation that were not exercised by a live session, per the evidence README and a read-only diff of the snapshot.
- How herdr agent start resolves the codex and claude executables (PATH lookup in the pane shell versus an absolute path) was not observed; the second Major finding relies on the README instruction to prefix the Herdr shell PATH.
- Whether the codex sandbox profile denies writes to a linked worktree's .git file and whether the process ID of the session parent is discoverable inside the sandbox were not exercised.
- Real Claude entry was not exercised by the engineer or this review; only the offline fake-native test covers its argument transport.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
