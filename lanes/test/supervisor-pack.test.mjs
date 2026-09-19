import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "supervisor");
const latest = readdirSync(root).filter((name) => /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(name)).sort().at(-1);

test("native remote supervisor launch binds Codex to its approved worktree", () => {
  const guide = readFileSync(join(root, latest, "CODEX_REMOTE.md"), "utf8");
  assert.match(guide, /herdr agent start[^\n]*--remote unix:\/\/ -C "\$supervisor_worktree"/);
  assert.match(guide, /directory:/);
});
