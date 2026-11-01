import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyProduct } from '../../lib/product-files.mjs';
import { makeFixture, ignoreLaneState, git, openLane, commitFile, lane, writeExecutable } from './lane-fixture.mjs';

const product = fileURLToPath(new URL('../../', import.meta.url));
const compatibilityTest = 'test/release-record-compatibility.test.mjs';

test('check always runs record compatibility for each pinned shape and preserves failure and recovery', () => {
  const f = makeFixture({ main: 'main', validate: 'selected-gate' });
  try {
    ignoreLaneState(f);
    copyProduct(product, f.repo);
    fs.mkdirSync(path.join(f.repo, 'test/helpers'), { recursive: true });
    // Use the real bounded runner with a small admission assertion at the
    // required path. The complete compatibility file is a separate control.
    fs.writeFileSync(path.join(f.repo, 'test/helpers/run.mjs'),
      `import ${JSON.stringify(new URL('../../test/helpers/run.mjs', import.meta.url).href)};\n`);
    fs.writeFileSync(path.join(f.repo, compatibilityTest), `
import test from 'node:test';
import { appendFileSync } from 'node:fs';
import { requireRecordCompatibility } from '../lib/record-compatibility.mjs';
test('fixture record admission', () => {
  appendFileSync(process.env.COMPATIBILITY_WITNESS, 'admission\\n');
  requireRecordCompatibility(process.cwd(), [{type:'report.available',seq:1}]);
});
`);
    git(f.repo, ['add', '.']);
    git(f.repo, ['commit', '-qm', 'Brain compatibility fixture']);
    writeExecutable(f, 'selected-gate', "printf 'selected gate\\n'");
    const witness = path.join(f.root, 'witness');
    const env = { ...f.env, COMPATIBILITY_WITNESS: witness };

    for (const [index, source] of ['lib/state.mjs', 'lib/obligations.mjs'].entries()) {
      const workspace = openLane(f, `shape-${index}`);
      const original = fs.readFileSync(path.join(workspace, source), 'utf8');
      // State permits an implementation comment; obligations pins exact bytes.
      commitFile(workspace, source, original + '\n// source revision\n', 'Change pinned source');
      const run = lane(f, ['check', '--cmd', 'exit 0'], { cwd: workspace, env });
      const gate = JSON.parse(fs.readFileSync(path.join(workspace, '.lane/gate.json'), 'utf8'));
      assert.match(gate.command, /test\/release-record-compatibility\.test\.mjs/);
      assert.equal(gate.head, git(workspace, ['rev-parse', 'HEAD']));
      assert.equal(run.status, index === 0 ? 0 : 1, run.stdout + run.stderr);
      assert.equal(gate.exit_code, run.status);
      assert.match(run.stdout, /fixture record admission/);
      if (index === 1) {
        assert.match(run.stdout + run.stderr, /obligation fold for report.available/);
        // Registering compatible helper bytes is outside this test's scope;
        // restore them and retain a changed, recognized state shape instead.
        commitFile(workspace, source, original, 'Restore registered helper');
        const state = fs.readFileSync(path.join(workspace, 'lib/state.mjs'), 'utf8');
        commitFile(workspace, 'lib/state.mjs', state + '\n// recovered shape\n', 'Keep compatibility observation affected');
        const recovered = lane(f, ['check'], { cwd: workspace, env });
        assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
        assert.match(recovered.stdout, /selected gate/);
      }
    }
    assert.equal(fs.readFileSync(witness, 'utf8'), 'admission\nadmission\nadmission\n');

    const unrelated = openLane(f, 'unrelated');
    commitFile(unrelated, 'shared.txt', 'unrelated\n', 'Unrelated source');
    const run = lane(f, ['check'], { cwd: unrelated, env });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(unrelated, '.lane/gate.json'), 'utf8')).command, 'selected-gate');
    assert.equal(fs.readFileSync(witness, 'utf8'), 'admission\nadmission\nadmission\n');
  } finally { f.cleanup(); }
});
