import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('the supervisor arms the standalone watcher and launches settle separately', () => {
  const arm = read('../supervisor/arm-watch.sh');
  const settle = read('../supervisor/settle.sh');
  const launcher = read('../supervisor/open-session.mjs');
  const protocol = read('../supervisor/SETTLE.md');
  const compatibilityWatcher = read('../contrib/settle-watch.mjs');

  assert.match(arm, /watch\/watch\.mjs/);
  assert.match(arm, /--to supervisor-herdr/);
  assert.doesNotMatch(arm, /open-session|settle-watch/);
  assert.match(settle, /open-session\.mjs/);
  assert.doesNotMatch(settle, /exec node[^\n]*watch\/watch\.mjs/);
  assert.doesNotMatch(launcher, /--until', '(?:idle|done|blocked)'|fs\.watch|spawn: \{ type: 'boolean'/);
  assert.equal(fs.existsSync(new URL('../contrib/settle-watch.mjs', import.meta.url)), true);
  assert.match(compatibilityWatcher, /settle-watch: wait for one org run's worker to stop/);
  assert.match(compatibilityWatcher, /opt\.spawn && !opt\.open/);
  assert.match(protocol, /refuses instead of waiting[\s\S]*herdr agent wait NAME[\s\S]*settle\.sh R-n.*again/);
});

test('Brain remains an operator-queue capture service, not a run-report delivery path', () => {
  const brain = read('../brain/bin/brain.mjs');
  assert.match(brain, /const CAPTURE = new Set\(\['done', 'blocked'\]\)/);
  assert.match(brain, /append\(entry\)/);
  assert.doesNotMatch(brain, /watch\/watch\.mjs|\[org-report\]/);
});
