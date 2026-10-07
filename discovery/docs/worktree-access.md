# Native worktree access evidence

Historical ENG-242 evidence, inspected 2026-10-07.
ENG-259 supersedes the supervisor lane-write restrictions below: supervisor and
chat launches now receive their own worktree root as a write root. Worker and
reviewer restrictions remain. See [current launch permissions](../README.md).

ENG-242, inspected 2026-10-07. Installed native versions: Codex CLI **0.160.0**
and Claude Code **2.1.292**. The installed PATH wrappers select these executables;
no machine installation or activation was changed for this work.

The fleet's `bch-cloak-aggregator` mapping owns the canonical checkout
`/Users/rewt/development/bastian/bch-cloak-aggregator`, its `.org` record,
`~/.herdr-monitor/p/cbefc18c85497e98/worktrees`, and
`~/.herdr-monitor/t/cbefc18c85497e98`. The queue evidence is in
`~/.local/state/herdr-brain/queue.jsonl`:

- At `2026-10-07T01:37:35.367Z`, the Codex worker
  `lane-z11-r1-challe-be18f4-2941ad` shows **Folder access** in the fleet worktree.
  Its screen says trusting applies to the canonical repository root. The launch
  warning shows an inherited `sandbox_mode="workspace-write"` selected native
  policy, so prevention must also cover that early-return branch.
- At `2026-10-07T03:20:35.662Z`, `aggregator-gm` shows **Allow this read outside
  the working directories?** while reading the experimenter's lane report.
  The preceding screen timestamps its attempted read at 22:20:33 the night
  before. Its four choices include persistent global allow/block decisions;
  Monitor answers none of them and changes no persistent setting.

## Generated settings and native interpretation

Correction R-284: Claude's working directories stay the primary checkout and
private run temp. The shared worktree root is **not** passed through `--add-dir`.
The generated 0600 session settings file grants the selected project's worktree
root through `permissions.allow: ["Read(//absolute/worktrees/**)"]` and
`sandbox.filesystem.allowRead`. The record, request queue and configured extras
receive scoped Read rules; their pre-existing write grants use Edit rules and
sandbox allowWrite instead of additional working directories. No persistent
settings file is rewritten; the session file is removed on exit.

The supervisor gets `Edit(//absolute/worktrees/**)` and sandbox denyWrite for the
shared root. Workers get the same two deny mechanisms for sibling entries
present at launch, including resolved spellings and siblings at each ancestor
of a nested checkout. A configured write root overlapping those entries is
refused. Only the current lane retains its implicit working-directory write
access. A generated native PreToolUse command hook resolves Edit, Write and
NotebookEdit targets at tool time, denying writes under the shared root outside
the current checkout. This covers new lanes created during the session, relative
paths, outside symlink aliases and symlinks from the owned lane. Missing files
resolve through their existing ancestors; dangling or unresolvable paths fail
closed. Reads and ordinary writes return no hook decision, preserving native
permission flow and existing hooks. Native file tools consult **Edit** rules for Edit, Write and NotebookEdit;
adding a `Write(path)` rule alone does not enforce this boundary.

The opt-in 2.1.292 offline test imports the binary's actual `DE` (read) and `Iy`
(edit) permission functions with Bun preload, then exits before CLI entry. It
also extracts the installed `san` outside-read gate and evaluates that exact
body with an interactive auto-mode context. The control lane read is `ask` with
a `workingDir` reason and opens the gate; the generated Read rule returns
`allow` with a `rule` reason and the gate stays closed. Thus this proof tests the
prompt decision, rather than merely working-directory membership or headless
`-p` behavior (which never shows that interactive prompt).

For both roles, sibling Edit/Write/NotebookEdit checks deny existing and new
files under an existing sibling lane in default, acceptEdits, auto and bypass
modes, even with a conflicting broad Edit allow. A worker's symlink to the
sibling is denied, while its own checkout stays editable. Peer reads get no
Read allow. The shared root remains outside the working-directory predicate.
An explicit `blockReadsOutsideWorkingDirectories: true` or Read deny still
refuses the read; Monitor does not clear the operator's persistent read block.

Codex's CLI override must be an **inline table value**:

```text
-c projects={"/canonical/checkout"={"trust_level"="trusted"},"/fleet/worktrees/lane"={"trust_level"="trusted"}}
```

Codex 0.160.0 splits dotted override keys literally, even inside quotes.
A model-free native `config/read` check of
`projects."/private/tmp/trust.<random>/repo.with.dot".trust_level="trusted"`
produced a malformed project entry starting with a literal quote; it did not
trust the intended path. The inline table loads the exact canonical and linked
worktree paths, including dots and embedded quotes, as trusted. The native
config reader also loads the worktree's project configuration marker, preserves
a peer's inherited `untrusted` setting, and leaves the user config bytes intact.
It uses an isolated scratch Codex home without credentials and sends only
initialization and configuration-read protocol messages, never a model request.

The documented native contracts are [Claude working directories](https://code.claude.com/docs/en/permissions#working-directories),
[Claude settings](https://code.claude.com/docs/en/settings), and
[Codex project trust](https://learn.chatgpt.com/docs/config-file/config-reference).
Exact version-specific parsing and predicate behavior above were measured
locally rather than inferred from the latest documentation.

## Offline checks and limits

```sh
node --test discovery/test/native-sandbox.test.mjs

# Optional native checks: no session, model, credentials, or live Herdr calls.
MONITOR_TEST_CODEX_CONFIG=/absolute/native/codex \
MONITOR_TEST_CLAUDE_READ=/absolute/native/claude \
  node --test discovery/test/native-sandbox.test.mjs
```

Default tests capture generated argument/settings boundaries, both roles,
modern/legacy Codex sandbox branches, inherited and CLI sandbox overrides, and
default-fleet assigned/headless/resume adapters in real scratch Git worktrees.
They verify unchanged persistent config bytes, peer exclusion, temporary-file
cleanup and retained hooks/denies. Utilities and excluded projects retain their
existing passthrough behavior. Optional tests explicitly skip when their native
executables are not supplied; the Claude permission check is pinned to 2.1.292.

The generated sibling Edit/shell deny list is a launch-time snapshot. The
PreToolUse guard covers file tools for newly created sibling names as well.
New lanes receive no generated shell write grant. The offline hook test invokes
the exact generated command (including paths with spaces and quotes), proving
structured deny replies for late siblings, relative paths and aliases while
ordinary edits produce no approval or denial. The native hook contract is in
[Claude PreToolUse decision control](https://code.claude.com/docs/en/hooks#pretooluse-decision-control).
Inherited operator write/additional-directory overrides are still diagnosed,
and managed policy retains native precedence. Existing host read access is not
a cross-project read-isolation guarantee. Unknown builds retain the existing
unsupported-native-sandbox warning. No live TUI/model canary or release acceptance
harness was run in this lane.
