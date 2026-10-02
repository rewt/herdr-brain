**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 0b4ad8e674b03d5ca14f5e8ba68a99ad3f50da6e
Topic: discovery
Round: 3
Review ID: lr-a72bb9c5d0b4b2a5450c1631080bdc2f
Base branch: main
Base commit: f6d6eef4dc7bc9175261745d3b600e035a1e2a41

## Findings
- [Moderate] discovery/runtime.mjs:102 - the untouched-lane cleanliness check runs git status porcelain with untracked-files=all but without ignored files, and git worktree remove without force also only refuses untracked and modified paths, so any ignored content in a never-started entry lane (a .env, a Claude settings.local.json, notes or previews under .lane/ which ignoreRuntime now excludes in every worktree, local build output) is deleted with the directory and is not recoverable through an archive tag, contradicting the README promise that dirty work is retained and the lifecycle safety rule; Fix: add the ignored flag to the cleanliness check (git status porcelain with ignored and untracked-files=all) and keep the lane when it reports anything, then extend the close test with an ignored file such as .lane/note or a gitignored path that must survive close
- [Minor] discovery/adapters/codex.mjs:46 - both entry adapters (also discovery/adapters/claude.mjs line 39) handle only SIGINT and SIGTERM, so when the operator closes the terminal or Herdr pane the parent receives SIGHUP, takes the default terminate action and never calls entry.close, leaving the untouched lane worktree and branch, the request queue and the git-dir metadata behind, which is the common open-and-quit path round 2 finding 4 asked to clean up; Fix: forward SIGHUP like the other signals and let the child close handler run entry.close, and make createEntry sweep stale untouched entry lanes under the coordination lock (no live owner, no run, clean including ignored files, no commits beyond integration) so SIGKILL and crashes also converge, with a test that hangs up an entry session
- [Minor] discovery/runtime.mjs:88 - the default worktree root is built from an unresolved os.homedir() and passed to plainDirectory, whose no-follow component walk refuses any symlinked ancestor except the macOS tmp, var and etc aliases, so on machines whose home path contains a symlink (for example Fedora Atomic style home under var) or with an operator MONITOR\_WORKTREE\_ROOT through a link, every automatic entry fails and falls back to native, and discovery never activates for that user; Fix: realpath the home directory and the existing prefix of an operator-supplied worktree root before the no-follow walk (the root is not agent-writable), as already done for the system temporary directory, and add a test with a symlinked HOME

## Re-executed
```json
[]
```

## Non-claims
- No claim is made that npm test, npm run test:lanes, the PTY helper tests, the native sandbox check, the discovery acceptance probe or the installed smoke pass at the reviewed commit; the captured gate is inherited evidence only.
- No claim is made that ENG-74 release acceptance cases 02, 03, 04, 20 and 21 pass against main with this work promoted; the engineer report itself leaves cases 20 and 21 pending at this commit and makes no release acceptance claim.
- No claim is made that the round 2 findings are closed beyond what read-only inspection of the delta shows.

## Unverified
- No build, test or check command was run: the supplemental brief contains no Review run budget, so the budget is zero commands and no negative-control or mutation witness was produced.
- Ignored-file deletion by git worktree remove is established from the git-worktree manual (only untracked files and tracked modifications block removal) and the cleanup code, not by executing a fixture.
- SIGHUP behaviour is inferred from Node default signal handling and the adapter code; no terminal hangup was exercised.
- The symlinked-home failure is inferred from the no-follow component walk in lib/files.mjs; no symlinked HOME fixture was run.
- Linux behaviour of the shared PTY helper and scratch roots was inferred from code; no Linux host was used.
- Real Herdr managed-start detection, real Claude entry and live cases 20 and 21 were not exercised by this review.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
