import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';
import { tapTotals } from '../../lanes/validation.mjs';

for (const green of [true, false]) test(`unconfigured worker writes a ${green ? 'green inherited' : 'failed'} default receipt`, t => {
  const f = fixture(t), run = f.start();
  f.commit(green ? 'correct\n' : '');
  assert.equal(fs.existsSync(path.join(f.repo, '.lane.validation.json')), false);
  const checked = f.exec(process.execPath, [path.join(f.source, 'lanes/lane.mjs'), 'check'], f.workspace);
  assert.equal(checked.status, green ? 0 : 1, checked.stderr + checked.stdout);
  const gate = JSON.parse(fs.readFileSync(path.join(f.workspace, '.lane/gate.json')));
  assert.equal(gate.schema, 'lane-validation/v1'); assert.equal(gate.command, 'npm test');
  assert.equal(gate.node_version, process.version); assert.equal(gate.exit_code, green ? 0 : 1);
  assert.equal(gate.tap_totals[0].tests, 1); assert.equal(gate.tap_totals[0].pass, green ? 1 : 0);
  assert.equal(gate.tap_totals[0].fail, green ? 0 : 1);
  assert.equal(path.dirname(gate.log), path.join(f.repo, '.git/lane-validation'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(gate.log), `${gate.key}.json`))), gate);
  if (green) {
    f.report(run);
    const settled = f.settle(run);
    assert.equal(settled.status, 0, settled.stderr);
    const result = JSON.parse(settled.stdout);
    assert.equal(result.result, 'promotable'); assert.deepEqual(result.validation.inherited, gate);
    assert.equal(fs.readFileSync(result.validation.log, 'utf8'), fs.readFileSync(gate.log, 'utf8'));
    assert.equal(result.validation.executed, false, 'settle only consumes worker evidence');
  }
});

test('TAP summaries retain all top-level suites and never invent absent totals', () => {
  assert.equal(tapTotals('ordinary command output\n'), null);
  assert.deepEqual(tapTotals('    # tests 99\n# tests 2\n# pass 2\n# fail 0\n# tests 3\n# pass 1\n# fail 2\n'),
    [{ tests: 2, pass: 2, fail: 0 }, { tests: 3, pass: 1, fail: 2 }]);
});
