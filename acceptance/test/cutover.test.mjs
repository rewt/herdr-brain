import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { relocate } from '../security.mjs';
import { switches, capture, restore, callers, retireContrib, switchedFiles } from '../cutover.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [, file] of switches) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `# original ${file}\n`, { mode: file.endsWith('.sh') ? 0o751 : 0o640 });
  }
  return root;
}
test('rollback restores every file byte and executable mode', (t) => {
  const root = fixture(t), original = capture(root);
  for (const [, file] of switches) { fs.writeFileSync(path.join(root, file), 'switched'); fs.chmodSync(path.join(root, file), 0o600); }
  restore(root, original);
  assert.deepEqual(capture(root), original);
});
test('contrib cannot retire with an extra executable caller, and scans refuse symlinks', (t) => {
  const root = fixture(t), compat = path.join(root, 'compat.mjs');
  fs.writeFileSync(compat, 'compatibility');
  const caller = path.join(root, '.lane/supervisor/extra.sh');
  fs.writeFileSync(caller, '# historical contrib/settle-watch.mjs\nnode "$CURRENT/contrib/settle-watch.mjs"\n');
  assert.equal(callers(root, 'contrib/settle-watch.mjs').length, 1);
  assert.throws(() => retireContrib(root, compat), /retirement refused/);
  assert.equal(fs.readFileSync(compat, 'utf8'), 'compatibility');
  fs.unlinkSync(caller); fs.symlinkSync(compat, caller);
  assert.throws(() => retireContrib(root, compat), /symlink/);
  fs.unlinkSync(caller); retireContrib(root, compat);
  assert.equal(fs.existsSync(compat), false);
});

test('all ten edits apply to relocated inventory scripts and refuse premise drift', (t) => {
  const root = fixture(t), copy = path.join(root, 'existing/bch-cloak'), candidate = path.join(root, 'candidate');
  const kit = path.resolve(import.meta.dirname, '../../kit/bch-cloak-20261001');
  const spec = { copy, candidate, workspace: 'owned-workspace', target: 'new-target', legacyTarget: 'legacy-target', home: path.join(root, 'home') };
  for (const [, file] of switches) {
    const source = file.replace('.lane/supervisor/', 'supervisor/').replace('scripts/lane/', 'lane/');
    let text = fs.readFileSync(path.join(kit, source), 'utf8');
    if (file.endsWith('launch-supervisor.mjs')) text = text.replace(/const SETTLE_WATCH = .*;/, `const SETTLE_WATCH = ${JSON.stringify(path.join(candidate, 'contrib/settle-watch.mjs'))};`);
    text = relocate(text, { live: '/Users/rewt/development/bastian/bch-cloak', home: '/Users/rewt', scratchHome: spec.home, copy, candidate, root })
      .replaceAll('wFN', spec.workspace).replaceAll('supervisor-opus', spec.legacyTarget);
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true }); fs.writeFileSync(path.join(copy, file), text);
  }
  const edits = switchedFiles(spec);
  assert.equal(Object.keys(edits).length, 10);
  assert.ok(edits.dispatch.includes('arm-watch.sh $RUN'));
  assert.ok(!edits.dispatch.includes('notify-watch.sh'));
  for (const [key, file] of switches) fs.writeFileSync(path.join(copy, file), edits[key]);
  assert.deepEqual(callers(copy, 'contrib/settle-watch.mjs'), []);
  assert.deepEqual(callers(copy, 'notify-watch.sh'), []);
  assert.throws(() => switchedFiles(spec), /premise drift/);
});
