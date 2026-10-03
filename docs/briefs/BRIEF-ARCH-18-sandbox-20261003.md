# ARCH-18: per-project sandbox (research, a recommendation for the operator)

Read ARCH-18 and the operator's 2026-10-03 decision on G-3 (record show). The operator wants every agent session
confined by the OS to its own project: write only its worktree, its project's record and its own temp; no other
project's source, record, temp or scratch, and no private data (Documents, Desktop, Downloads, Mail, most of
~/Library, ~/.ssh, Keychain, system folders) without an explicit, recorded, revocable operator grant. Temp and
scratch stay inside the boundary (Unix socket paths are limited to about 104 characters on macOS). Workers must not
reach the shared Herdr socket to drive other projects' panes.

Find out, by trying in scratch, what can actually enforce this on macOS (and Linux): Codex's sandbox and permission
profiles, Claude Code's sandbox and permission settings, sandbox-exec/seatbelt profiles wrapping any harness,
bubblewrap on Linux (discovery/ already experiments with it), and a separate macOS user. For each: what it can and
cannot block, what breaks (toolchains, git, npm caches, harness login state, sockets), and its cost. Recommend an
order. ARCH-17 (workspace) is designed in parallel; note the seams. Never weaken the operator's own setup and never
touch real credentials; experiments use scratch homes and scratch files.

Write docs/design/ARCH-18-sandbox-20261003.md with operator decisions marked as questions. No product code changes.
Commit, write the report, record check it, commit it, run lane check last. Then stop.
