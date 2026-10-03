---
run: R-152
outcome: done
summary: |
  Researched, by experiment in scratch, what can confine every agent session to its own project on macOS,
  and wrote docs/design/ARCH-18-sandbox-20261003.md with a recommended order and seven operator questions.
  A generated seatbelt profile and a Codex permission profile both blocked every cross-project, private-folder,
  system-temp and control-socket probe while git, node, cc and the record CLI kept working. The decisive
  constraint is that macOS seatbelt does not nest: any outer profile with a deny rule makes a child's
  sandbox_apply fail, so a Monitor wrapper replaces the harness's own sandbox rather than adding to it.
  Two blockers for any sandbox are already in the code: the test runner needs setuid ps (refused in every
  seatbelt sandbox, Codex's included), and Herdr's own agent-state hook uses the Herdr socket from inside
  the session, so the socket needs a pane-scoped broker instead of a plain deny. Linux bubblewrap and a
  separate macOS user were assessed by analysis only (no Linux host or Docker daemon; creating a user is
  the operator's call). No product code changed.
headline: Every agent session can be locked to its own project on macOS, but the harness sandbox and a Monitor wrapper cannot be stacked, so you need to choose where the lock sits.
blockers: []
proposals:
  - role: engineer
    title: Replace setuid ps in the test process helper so the suite can run inside an OS sandbox
    why: test/helpers/processes.mjs refuses to start without /bin/ps, which is setuid root and cannot be executed inside any seatbelt sandbox (ours, Codex's or Claude's); npm test therefore cannot run in a confined session. pgrep and sysctl work inside the sandbox; the ENG-105 native owner is another source.
  - role: engineer
    title: Per-run short temp directories inside the workspace with a Unix socket path budget
    why: Every sandbox option needs TMPDIR/TMP/TEMP inside the boundary (cc fails without it); macOS socket paths are capped at 103 characters and Node silently truncates longer ones, so the launcher must use a short root (for example <workspace>/.t/<tag>-<run>), refuse paths over about 60 characters, list named system-temp exceptions, and have housekeeping remove the directory with its lane.
  - role: engineer
    title: Generate read-closed native harness sandboxes per session from the workspace file
    why: Step 1 of ARCH-18. Extend discovery/confinement.mjs from write-only guards to a read-closed Codex permission profile and a per-session Claude --settings file (sandbox enabled, failIfUnavailable, no unsandboxed retry, matching Read/Edit deny rules, harness config in the worktree not writable). Depends on ARCH-17's workspace file.
  - role: engineer
    title: Pane-scoped Herdr broker socket for agent sessions
    why: Workers must not drive other projects' panes, but Herdr's installed Claude hook reports agent state over HERDR_SOCKET_PATH from inside the session, so a plain deny breaks the agent status that watch and the console use. A per-session broker in the session temp that forwards only its own pane's state reports, with the real socket denied, closes the control path without that regression.
learnings:
  - macOS seatbelt does not nest. With an outer (allow default) profile a nested sandbox-exec works; add any single deny rule and the inner sandbox_apply fails with Operation not permitted (exit 71). codex sandbox inside such a profile fails the same way. (allow process-exec* (with no-sandbox)) only "works" because children escape confinement.
  - Setuid binaries such as /bin/ps cannot be executed in any seatbelt sandbox (execvp EPERM, exit 71), including codex sandbox. pgrep and sysctl are fine.
  - Seatbelt unix-socket rules need the resolved path (/private/tmp, not /tmp); several path-literals inside one (remote unix-socket ...) filter silently match only the first; denying file read/write on a socket node does not stop connect(). Use one filter per resolved path.
  - macOS sun_path holds 103 characters plus NUL. Python refuses longer paths; Node silently truncates them, which causes EADDRINUSE collisions or connections to the wrong socket.
  - Codex permission profiles accept per-path "none" and deny reads; with network.enabled=false all Unix sockets are blocked, with it on all are allowed.
  - Claude Code's sandbox confines Bash/Monitor commands only; Read/Edit/Write/Grep, hooks and MCP servers are outside it and Read/Edit deny rules are enforced in-process (code.claude.com/docs/en/sandboxing). --settings sits above user and project settings, below managed.
  - git fails under a home-closing profile until files pulled in by [include] in ~/.gitconfig are readable; generators must resolve includes.
  - Herdr's installed hook ~/.claude-personal/hooks/herdr-agent-state.sh connects to HERDR_SOCKET_PATH from inside the agent session to report pane state.
  - The operator's home and ~/development are mode 0755, so a separate macOS user would read all source and records unless those modes change.
artifacts:
  - docs/design/ARCH-18-sandbox-20261003.md (commit 0dd9e09)
  - npm test on the lane after the design commit: exit 0 (core 709 tests 0 fail, cycle 150 pass 0 fail), unconfined
  - scratch experiments (probe matrix, generated profiles, gen-sb.mjs) in this session's scratchpad; not committed
decisions:
  - text: Recommend native harness sandboxes first and a Monitor wrapper as an alternative layer, not a stack, because seatbelt cannot nest on macOS.
    category: design
    why: Measured in scratch; a wrapper with any deny rule makes both Codex's and a plain nested sandbox-exec fail.
  - text: Tested only against scratch homes, scratch projects and a stand-in socket; real private folders and the real Herdr socket were touched only by exit-code or connect-then-close checks, and no credentials were read or copied.
    category: other
    why: The brief forbids weakening the operator's setup or touching real credentials.
questions:
  - question: Approve the order (temp scheme and ps fix first, then generated native harness sandboxes, then a Monitor wrapper proven on one project)?
    category: security
    recommend: yes
    why: Each later step depends on the earlier ones and the cheap steps close most of the measured gaps.
  - question: Package caches per project (isolated, slower first install) or one shared workspace cache (fast, but a cross-project write channel)?
    category: security
    recommend: per-project writable caches, shared caches read-only where a tool allows it
    why: A shared writable cache lets one project poison another's installs.
  - question: For Claude sessions on macOS, target the outer wrapper (OS-level file tools, harness sandbox off) over Claude's own sandbox plus in-process deny rules?
    category: security
    recommend: native first, wrapper as the target once proven
    why: Claude's file tools, hooks and MCP servers are outside its own sandbox; the wrapper covers them but needs proving under Herdr.
  - question: Give each project its own harness state directory (a login per project) so projects cannot read each other's transcripts and memory?
    category: security
    recommend: yes, when the wrapper lands
    why: Harness state directories hold every project's transcripts, and a wrapper must let the harness read its own state.
  - question: Run agents as a separate macOS user?
    category: security
    recommend: not now; rehearse ARCH-19's install on one and revisit after the wrapper
    why: It separates agents from the operator but not projects from each other, and the operator's home is 0755 today.
  - question: Close Herdr control with a Monitor pane-scoped broker now and ask Herdr upstream for per-pane capability tokens?
    category: security
    recommend: yes to both
    why: A plain deny breaks Herdr's agent-state hook.
  - question: Record grants as workspace-file entries and security decisions, effective from the next session start?
    category: security
    recommend: yes
    why: A seatbelt profile cannot change after it is applied, so revocation needs a restart and the console should show sessions still holding a revoked grant.
challenges:
  - The ARCH-18 order lists the wrapper as a layer after native sandboxes; on macOS the two cannot be combined in one process tree (evidence in the design's finding 1), so step 2 is an alternative per session, not an addition.
  - npm test cannot run inside any OS sandbox today because test/helpers/processes.mjs requires setuid ps (refused by seatbelt, Codex's sandbox included); this also bears on the sandboxed promotion validation described in discovery/README.md.
---

The design note has the full experiment matrix, per-mechanism blocks, gaps, breakages and costs, the
ARCH-17 seams (the shared rewt/.org record, lanes committing through the canonical .git, shared caches,
workspace-level sessions), and the operator questions.

Not done, by design or constraint: no Linux experiment (no Linux host, Docker daemon not running; ENG-92
stays the gate for bubblewrap), no separate macOS user created, no real Claude session in a scratch home
(it would need copied credentials), and no inspection of the Claude binary's built-in profile (declined by
the session's permission classifier; documentation used instead).
