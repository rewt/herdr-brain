import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('the supervisor arms the standalone watcher; contrib keeps the compatibility watcher', () => {
  const arm = read('../supervisor/arm-watch.sh');
  const compatibilityWatcher = read('../contrib/settle-watch.mjs');

  assert.match(arm, /watch\/watch\.mjs/);
  assert.match(arm, /--to NAME/);
  assert.doesNotMatch(arm, /\/Users\/rewt|--org "\$REWT/);
  assert.doesNotMatch(arm, /open-session|settle-watch/);
  assert.equal(fs.existsSync(new URL('../contrib/settle-watch.mjs', import.meta.url)), true);
  assert.match(compatibilityWatcher, /settle-watch: wait for one org run's worker to stop/);
  assert.match(compatibilityWatcher, /opt\.spawn && !opt\.open/);
  // The legacy model-session launchers are gone; contrib stays self-contained.
  for (const removed of ['open-session.mjs', 'settle.sh', 'continue.sh', 'workspace.mjs', 'SETTLE.md'])
    assert.equal(fs.existsSync(new URL(`../supervisor/${removed}`, import.meta.url)), false, removed);
  assert.doesNotMatch(compatibilityWatcher, /from '\.\.\/supervisor\//);
});
