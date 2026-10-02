// The operator's Herdr focus must never move to a lane the tooling opens:
// every Herdr call in lane.mjs that creates a workspace, worktree or tab, or
// opens a worktree, passes --no-focus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lane.mjs", import.meta.url), "utf8");

test("lane never moves Herdr focus when it creates or opens a workspace, worktree or tab", () => {
  // A call spans to its closing bracket: on the same line, or on its own line
  // for multi-line argument lists (which may contain nested arrays).
  const calls = [...source.matchAll(/\[\s*"(workspace|worktree|tab)",\s*"(create|open)"/g)].map((match) => {
    const multiline = /^\[\s*\n/.test(source.slice(match.index, match.index + 40));
    const rest = source.slice(match.index);
    const end = multiline ? rest.search(/\n\s*\]/) : rest.indexOf("]");
    return [rest.slice(0, end + 1)];
  });
  assert.ok(calls.length >= 3, `expected the worktree create/open and tab create calls, found ${calls.length}`);
  for (const [call] of calls) assert.match(call, /"--no-focus"/, `missing --no-focus: ${call.slice(0, 120)}`);
});
