# bch-cloak's workflow kit, as of 2026-10-01

A read-only copy of the scripts and protocol files that run bch-cloak's agent cycle. Most of them
were not under version control there: `.lane/` is in the global gitignore, and only `SETTLE.md`,
`arm-watch.sh` and `continue.sh` were force-tracked. This copy gives them history before the
platform work (G-3 in herdr-brain's record) starts reworking them. Don't edit these files; the
platform's modules are written fresh and reference them.

What each file does, and how they fit together, is in
`docs/reports/INVENTORY-bch-cloak-workflow-2026-10-01.md` on lane/items-observe.

| Here | Copied from |
|---|---|
| `supervisor/` | `bch-cloak/.lane/supervisor/` (scripts, `SETTLE.md`, `WORK-PATTERN.md`) |
| `lane/` | `bch-cloak/scripts/lane/` (lane tool, routing table and resolver, supervisor launcher, tests) |
| `archive/SETTLE-DESK-POOL-20260927.md` | The settle desks' protocol, from the bch-cloak workspace's `archive/` |
| `claude/settings.hooks.json` | The `hooks` section of `bch-cloak/.claude/settings.local.json` |
| `.bch-cloak-head` | bch-cloak's `main` commit when this was copied |

Left out on purpose: bch-cloak's project state and logs (`OPEN-STATE.md`, `GAPS.md`, `PROJECT.md`,
`TODAY.md`, `notify-log.tsv`, `watch-logs/`, session logs, the promotion queue file and `.bak`
copies). They are bch-cloak's own R&D notes, not part of the workflow, and don't belong in a
repository that may be published.

Outside both repositories, the cycle also depends on `~/.codex/config.toml` `[tui] alternate_screen =
"never"` (so a mouse wheel over a Codex pane doesn't interrupt it), the launchd service
`com.rewt.herdr-brain`, and `~/.local/bin/org`, a symlink into this repository's `bin/org.mjs`.
