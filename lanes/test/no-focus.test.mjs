// The operator's Herdr focus must never move to a lane the tooling opens:
// every Herdr call in lane.mjs that creates a workspace, worktree or tab, or
// opens a worktree, passes --no-focus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { productFiles } from '../../lib/product-files.mjs';

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

test("lane closure cannot invoke Herdr's parent-focusing worktree removal", () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const modules = new Map(productFiles(root).filter(file => file.endsWith('.mjs'))
    .map(file => [file, readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')]));
  const removalIsGitOnly = (file, text) => {
    for (const match of text.matchAll(/\[\s*(['"])worktree\1\s*,\s*(['"])remove\2/g)) {
      // The shared adapter's Git helper takes the canonical root first; the
      // lane-local helper takes only argv. Both must remain direct Git calls.
      assert.match(text.slice(0, match.index), /\bgit\(\s*(?:canonicalRoot,\s*)?$/, `${file}: worktree removal must invoke Git, never Herdr`);
    }
  };
  // Scan every shipped module, including every caller and the moved executor.
  for (const [file, text] of modules) removalIsGitOnly(file, text);
  const executor = modules.get('lib/retire-runtime.mjs');
  assert.match(source, /retirement\.removeLane\(/);
  assert.match(executor, /for \(const id of workspaces\) try \{ closeEmptyWorkspace\(id, lane\);/);
  assert.match(executor, /closeWorkspace: workspace => invoke\(herdr, \['workspace', 'close', workspace\]\)/);
  // Exercise the actual close call's forbidden replacement, not a vacuous scan.
  const unsafe = executor.replace("['workspace', 'close', workspace]", "['worktree', 'remove', '--workspace', workspace]");
  assert.notEqual(unsafe, executor);
  assert.throws(() => removalIsGitOnly('lib/retire-runtime.mjs', unsafe), /worktree removal must invoke Git/);
});
