import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failingTestFiles, completeShadow } from '../selector.mjs';

// This is the TAP shape emitted by the project's bounded test wrapper: location
// identifies the wrapper; only the diagnostic stack identifies the actual file.
const wrapped = `# Subtest: a wrapped test
not ok 1 - a wrapped test
  ---
  location: '/project/test/helpers/bounded-test.mjs:49:10'
  stack: |-
    file:///project/promote/test/train.test.mjs:169:12
    TestContext.<anonymous> (file:///project/test/helpers/bounded-test.mjs:50:29)
  ...
# Subtest: next test
ok 2 - next test
`;
test('real bounded-runner TAP attributes a wrapped failure from file URL stack frames', () => {
  assert.deepEqual(failingTestFiles(wrapped, ['/project']), {
    failing_files: ['promote/test/train.test.mjs'], unattributed: false,
  });
});

test('a later green test cannot supply attribution for an earlier unknown failure', () => {
  const output = `not ok 1 - unknown\n  ...\n# Subtest: later\nok 2 - later\n  location: 'test/green.test.mjs:1:1'\n`;
  assert.deepEqual(failingTestFiles(output), { failing_files: [], unattributed: true });
});

test('recovered failures remain misses when unattributed or outside the pick', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selector-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'gate.log'), gate = { log, exit_code: 0 };
  const selection = { pick: ['promote/test/train.test.mjs'], reason: 'fixture' };
  fs.writeFileSync(log, wrapped);
  assert.equal(completeShadow(selection, gate, ['/project']).miss, false);
  assert.equal(completeShadow({ ...selection, pick: [] }, gate, ['/project']).miss, true);
  fs.writeFileSync(log, 'not ok 1 - no identity\n# retry succeeded\n');
  assert.equal(completeShadow(selection, gate).miss, true);
  assert.equal(completeShadow({ ...selection, pick: 'full' }, gate).miss, false);
});
