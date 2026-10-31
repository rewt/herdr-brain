import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The fresh-process launch and landing witnesses live in launch-holds and
// expected-head-from-worktree; this closes the original synchronous ESM seam.
test('effect-only import delegates avoid synchronous ESM loading', () => {
  for (const file of ['lanes/lane.mjs', 'lib/run-owner.mjs', 'messages/operator-inbox.mjs']) {
    const source = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bcreateRequire\b/, file);
    assert.doesNotMatch(source, /\brequire\s*\(\s*['"][^'"]+\.mjs['"]\s*\)/, file);
  }
});
