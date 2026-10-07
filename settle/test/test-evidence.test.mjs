import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { validateTree } from '../../lanes/validation.mjs';
import { fixture } from './fixture.mjs';
import { deferredTests, recordedTestEvidence, TEST_ESCALATION } from '../test-evidence.mjs';
import { RECORD_CHECK_CLAIM, LEGACY_RECORD_CHECK_CLAIM } from '../report-evidence.mjs';
const scoped = '- Test evidence not re-executed: checks.test.mjs';
const result = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
function setup(t, { planner = true, plannerSource = "import { files } from './coverage.mjs'; console.log(JSON.stringify({files}));\n", missingPlanner = false, unverified = scoped } = {}) {
  const f = fixture(t), run = f.start();
  if (planner) {
    if (!missingPlanner) fs.writeFileSync(path.join(f.repo, 'planner.mjs'), plannerSource);
    fs.writeFileSync(path.join(f.repo, 'coverage.mjs'), "export const files = ['checks.test.mjs'];\n");
    fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ promotion_tests: 'planner.mjs' }));
    f.git(['add', 'coverage.mjs', '.lane.validation.json', ...(missingPlanner ? [] : ['planner.mjs'])]); f.git(['commit', '-qm', 'Declare promotion tests']);
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
for (const claim of [RECORD_CHECK_CLAIM, LEGACY_RECORD_CHECK_CLAIM]) test(`test deferrals plus matching record-check proof use the bound path: ${claim}`, t => {
  const f = setup(t, { unverified: `${scoped}\n${claim}` }), settled = result(f.settle(f.run));
  assert.equal(settled.result, 'promotable'); assert.deepEqual(settled.test_evidence.files, ['checks.test.mjs']);
  assert.equal(settled.report_ingest.sha256, f.show(f.run).report.sha256);
  assert.ok(fs.readFileSync(settled.review.path, 'utf8').includes(claim.replaceAll('`', '\\`')));
  const g = setup(t, { unverified: `${scoped}\n${claim}\n- The report claims a deployment without a receipt.` });
  const refused = result(g.settle(g.run));
  assert.equal(refused.result, 'escalate'); assert.match(refused.reason, /unverified claims/);
  const uncovered = setup(t, { planner: false, unverified: `${scoped}\n${claim}` });
  assert.equal(result(uncovered.settle(uncovered.run)).reason, TEST_ESCALATION);
});
for (const claimsCoverage of [false, true]) test(`lane-modified planner and imports cannot ${claimsCoverage ? 'invent' : 'shrink'} canonical coverage`, t => {
  const f = setup(t, claimsCoverage ? { plannerSource: "import { files } from './coverage.mjs'; console.log(JSON.stringify({files:[],covered:[]}));\n" } : {});
  // Replace both the entry point and its relative import in the lane. Neither
  // may run during settle; cwd must still let the base planner inspect the lane.
  const marker = path.join(f.root, 'lane-planner-ran');
  fs.writeFileSync(path.join(f.workspace, 'planner.mjs'), `import fs from 'node:fs'; import { files } from './coverage.mjs'; fs.writeFileSync(${JSON.stringify(marker)},'ran'); console.log(JSON.stringify({files:[],covered:files}));\n`);
  fs.writeFileSync(path.join(f.workspace, 'coverage.mjs'), `export const files = ${JSON.stringify(claimsCoverage ? ['checks.test.mjs'] : [])};\n`);
  f.git(['add', 'planner.mjs', 'coverage.mjs'], f.workspace); f.git(['commit', '-qm', 'Modify lane planner and import'], f.workspace);
  const settled = result(f.settle(f.run));
  assert.equal(settled.result, claimsCoverage ? 'escalate' : 'promotable');
  if (claimsCoverage) assert.equal(settled.reason, TEST_ESCALATION);
  assert.deepEqual(settled.test_evidence.plan.files, claimsCoverage ? [] : ['checks.test.mjs']);
  assert.equal(fs.existsSync(marker), false, 'settle never executes the lane planner');
});
for (const [name, options, error] of [
  ['missing planner', { missingPlanner: true }, /ENOENT/],
  ['failed planner', { plannerSource: "console.error('canonical planner failed'); process.exit(1);\n" }, /canonical planner failed/],
  ['empty output', { plannerSource: '' }, /promotion test planner produced no output/],
  ['whitespace output', { plannerSource: "console.log('  '); console.error('planner did not emit a plan');\n" }, /promotion test planner produced no output: planner did not emit a plan/],
  ['invalid JSON', { plannerSource: "console.log('invalid plan');\n" }, /JSON|Unexpected/],
  ['invalid coverage', { plannerSource: "console.log(JSON.stringify({files:[],covered:['../checks.test.mjs']}));\n" }, /invalid promotion test coverage/],
  ['oversized output', { plannerSource: "console.log('x'.repeat(2*1024*1024));\n" }, /ENOBUFS/],
]) test(`${name} covers nothing, retains its error and allows recorded re-execution`, t => {
  const f = setup(t, options), settled = result(f.settle(f.run));
  assert.equal(settled.result, 'escalate'); assert.equal(settled.reason, TEST_ESCALATION);
  assert.equal(settled.test_evidence.plan, null); assert.match(settled.test_evidence.planner_error, error);
  const gate = validateTree({ cwd: f.workspace, common: path.join(f.repo, '.git'), command: 'node --test checks.test.mjs', tier: 'fast', env: f.env });
  const receipt = path.join(f.repo, '.git/lane-validation', `${gate.key}.json`);
  f.record(['note', f.run, `Test re-execution evidence: ${receipt}`, '--decision']);
  const retried = result(f.retry(f.run, ['--resolve-tests']));
  assert.equal(retried.result, 'promotable'); assert.equal(retried.test_evidence.reexecuted.receipt, receipt);
  assert.match(retried.test_evidence.planner_error, error);
  assert.equal(f.calls().filter(args => args[1] === 'start').length, 1, 'resolution does not repeat review');
});
test('hand-written receipt with matching filename and log hash must also match its derived key', t => {
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'test-evidence-key-'));
  t.after(() => fs.rmSync(common, { recursive: true, force: true }));
  const directory = path.join(common, 'lane-validation'); fs.mkdirSync(directory);
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const key = 'a'.repeat(64), log = path.join(directory, `${key}.log`), file = path.join(directory, `${key}.json`);
  fs.writeFileSync(log, 'hand-written green log\n');
  const gate = { schema: 'lane-validation/v1', key, head: 'b'.repeat(40), tree: 'c'.repeat(40),
    command: 'node --test checks.test.mjs', environment_fingerprint: 'd'.repeat(64), exit_code: 0, signal: null,
    started_at: '2026-10-07T00:00:00Z', finished_at: '2026-10-07T00:00:01Z', duration_s: 1,
    log, log_hash: digest(fs.readFileSync(log, 'utf8')) };
  const derivedKey = digest({ schema: gate.schema, tree: gate.tree, command: gate.command, fingerprint: gate.environment_fingerprint });
  assert.notEqual(derivedKey, key);
  fs.writeFileSync(file, JSON.stringify(gate));
  assert.equal(recordedTestEvidence({ notes: [{ decision: true, text: `Test re-execution evidence: ${file}` }], common,
    head: gate.head, tree: gate.tree, files: ['checks.test.mjs'] }), null);
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

test('settle forwards scoped evidence as required files before applying optional caps', t => {
  const f = setup(t, { plannerSource: `const required = JSON.parse(process.argv[5]);
console.log(JSON.stringify({files:required,selected:required.map(file=>({file,reason:'bound-required',estimated_ms:342215,estimate:'measured'})),
  budget:{time_ms:1,max_files:1,unknown_file_ms:60000,estimated_ms:required.length*342215,required_over_budget:true}}));\n` });
  const settled = result(f.settle(f.run));
  assert.equal(settled.result, 'promotable');
  assert.deepEqual(settled.test_evidence.plan.required, ['checks.test.mjs']);
  assert.deepEqual(settled.test_evidence.plan.files, ['checks.test.mjs']);
  assert.equal(settled.test_evidence.plan.budget.required_over_budget, true);
});
