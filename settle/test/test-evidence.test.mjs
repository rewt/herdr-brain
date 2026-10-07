import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateTree } from '../../lanes/validation.mjs';
import { fixture } from './fixture.mjs';
import { deferredTests, TEST_ESCALATION } from '../test-evidence.mjs';
const scoped = '- Test evidence not re-executed: checks.test.mjs';
const result = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
function setup(t, { planner = true, unverified = scoped } = {}) {
  const f = fixture(t), run = f.start();
  if (planner) {
    fs.writeFileSync(path.join(f.repo, 'planner.mjs'), "console.log(JSON.stringify({files:['checks.test.mjs']}));\n");
    fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ promotion_tests: 'planner.mjs' }));
    f.git(['add', 'planner.mjs', '.lane.validation.json']); f.git(['commit', '-qm', 'Declare promotion tests']);
    f.git(['merge', '--ff-only', 'main'], f.workspace);
  }
  fs.writeFileSync(path.join(f.workspace, 'checks.test.mjs'), "import test from 'node:test'; test('offline',()=>{});\n");
  f.git(['add', 'checks.test.mjs'], f.workspace); f.git(['commit', '-qm', 'Add changed release test'], f.workspace);
  fs.writeFileSync(path.join(f.root, 'review-result.json'), JSON.stringify({ unverified }));
  f.commit('correct\n'); f.report(run);
  return { ...f, run };
}
test('only scoped test deferrals become promotable through the planned gate', t => {
  const f = setup(t), settled = result(f.settle(f.run));
  assert.equal(settled.result, 'promotable'); assert.equal(settled.review.verdict, 'PASS');
  assert.deepEqual(settled.test_evidence.files, ['checks.test.mjs']);
  const g = setup(t, { unverified: scoped + '\n- Acceptance evidence remains unresolved.' });
  assert.match(result(g.settle(g.run)).reason, /unverified claims/);
  assert.equal(deferredTests('- Test evidence not re-executed: ../checks.test.mjs', ''), null);
});
test('recorded re-execution permits supervisor-bound promotion; unrecorded or stale evidence refuses', t => {
  const f = setup(t, { planner: false });
  assert.equal(result(f.settle(f.run)).reason, TEST_ESCALATION);
  assert.equal(result(f.retry(f.run, ['--resolve-tests'])).result, 'escalate');
  const command = 'node --test checks.test.mjs';
  const gate = validateTree({ cwd: f.workspace, common: path.join(f.repo, '.git'), command, tier: 'fast', env: f.env });
  const receipt = path.join(f.repo, '.git/lane-validation', `${gate.key}.json`);
  const fake = path.join(f.root, 'queue.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(f.root, 'queued.json'))},JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({jobs:[{id:'bound-test'}]}));`);
  const promote = () => f.exec(process.execPath, [path.join(f.source, 'supervisor/supervisor.mjs'), 'promote', f.run,
    '--role', 'supervisor', '--why', 'Independent PASS with recorded full-file evidence', '--promote-cli', fake]);
  assert.equal(result(promote()).result, 'escalate', 'an unrecorded green gate cannot discharge the deferral');
  f.record(['note', f.run, `Test re-execution evidence: ${receipt}`, '--decision']);
  const original = fs.readFileSync(receipt, 'utf8');
  fs.writeFileSync(receipt, JSON.stringify({ ...gate, head: '0'.repeat(40) }));
  assert.equal(result(promote()).result, 'escalate', 'stale head evidence refuses');
  fs.writeFileSync(receipt, original);
  const saved = result(promote());
  assert.equal(saved.phase, 'acknowledged'); assert.equal(saved.run, f.run);
  assert.equal(saved.test_evidence.reexecuted.receipt, receipt);
  const args = JSON.parse(fs.readFileSync(path.join(f.root, 'queued.json')));
  assert.equal(args[args.indexOf('--if-current-run') + 1], f.run);
  assert.equal(args[args.indexOf('--expected-head') + 1], f.git(['rev-parse', 'HEAD'], f.workspace));
  assert.equal(f.calls().filter(args => args[1] === 'start').length, 1, 'test resolution preserves the independent review');
});
