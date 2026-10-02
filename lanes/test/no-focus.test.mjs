// The operator's Herdr focus must never move to a lane the tooling opens:
// every Herdr call in lane.mjs that creates a workspace, worktree or tab, or
// opens a worktree, passes --no-focus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lane.mjs", import.meta.url), "utf8");

test("lane never moves Herdr focus when it creates or opens a workspace, worktree or tab", () => {
  const calls = [...source.matchAll(/\[\s*"(workspace|worktree|tab)",\s*"(create|open)"[\s\S]*?\]/g)];
  assert.ok(calls.length >= 3, `expected the worktree create/open and tab create calls, found ${calls.length}`);
  for (const [call] of calls) assert.match(call, /"--no-focus"/, `missing --no-focus: ${call.slice(0, 120)}`);
});
