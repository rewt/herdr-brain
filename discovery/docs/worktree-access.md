# Native worktree access evidence

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

Claude receives separate `--add-dir` arguments for the selected project's
worktree root and record, private run temp, request queue if present, and explicit
canonical project extra directories. The variadic directory arguments terminate
at `--settings`. The generated 0600 session file also grants those paths through
`sandbox.filesystem.allowRead`, covering shell reads under an inherited read mask.
The persistent outside-read block is neither cleared nor disabled globally.
The session file lives in the private run temp and is removed on exit.

The 2.1.292 bundled `Zh` predicate checks whether all resolved file spellings lie
under the session's working directories. The outside-read gate uses this
predicate; the read-block check excludes repository-sourced additional-directory
grants, so a tracked project setting alone is insufficient. The opt-in offline
test imports the binary's own exported predicate through a Bun preload and exits
before the CLI entry point. Without the generated roots, reads fail the
working-directory predicate; with them, project lane reports, record files and
private temp files pass. Peer checkout, record, temp and worktrees remain outside
the predicate for both worker and supervisor contexts.

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
executables are not supplied; the Claude predicate check is pinned to 2.1.292.

`--add-dir` is native project access, including edits under appropriate Claude
permission modes. This change does not claim that the project's sibling lanes
are read-only. It adds no global outside-read permission, fleet-parent trust or
whole-temp-root grant. Existing Codex runtime read access remains; peer paths
are excluded from generated project trust and writable grants, not hidden from
all host reads. Operator settings and managed policy retain native precedence;
an explicit deny or managed restriction can still refuse a read. Unknown builds
retain the existing unsupported-native-sandbox warning. No live TUI/model canary
or release acceptance harness was run in this lane.
