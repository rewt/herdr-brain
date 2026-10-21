import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { declaration, declaredFixture } from '../../promote/test/helpers/declared-fixture.mjs';
import { resolveValidation, readDeclared } from '../validation.mjs';
import { sameDeclaration } from '../../promote/declaration.mjs';
import { resolveGateProfile } from '../../promote/gate-profile.mjs';
import { validateSelection } from '../../promote/declared-selection.mjs';
import { canonicalTestPlan } from '../../settle/test-plan.mjs';

test('authority: uncommitted and inline schemas cannot fall through to legacy execution', t => {
  const f = declaredFixture(t, { declared: { promotion: 'node baseline.mjs' } });
  f.write('.lane.validation.json', JSON.stringify(declaration()));
  assert.throws(() => resolveValidation({ root: f.repo, env: f.env }), /committed owner/);
  assert.throws(() => resolveValidation({ root: f.repo, env: f.env, config: { validation: declaration() } }), /inline validation/);
  assert.equal(fs.existsSync(path.join(f.repo, '.git/promote/queue.json')), false);
});

test('authority: legacy executable and symlink declarations keep their filesystem semantics', t => {
  const f = declaredFixture(t, { declared: { promotion: 'node baseline.mjs' } });
  fs.chmodSync(path.join(f.repo, '.lane.validation.json'), 0o755); f.commit();
  assert.equal(resolveValidation({ root: f.repo, env: f.env }).tiers.promotion.command, 'node baseline.mjs');
  fs.unlinkSync(path.join(f.repo, '.lane.validation.json'));
  const external = path.join(f.root, 'legacy.json'); fs.writeFileSync(external, '{"promotion":"legacy-symlink"}');
  fs.symlinkSync(external, path.join(f.repo, '.lane.validation.json')); f.commit();
  assert.equal(resolveValidation({ root: f.repo, env: f.env }).tiers.promotion.command, 'legacy-symlink');
});

test('authority: legacy working corrections are not replaced by a malformed historical JSON file', t => {
  const f = declaredFixture(t, { declared: { promotion: 'node baseline.mjs' } });
  f.write('.lane.validation.json', '{'); f.commit();
  f.write('.lane.validation.json', '{"promotion":"working-correction"}');
  assert.equal(resolveValidation({ root: f.repo, env: f.env }).tiers.promotion.command, 'working-correction');
});

test('authority: environment values execute in memory while jobs, literal selection and receipts bind only digests', t => {
  const value = declaration(), secret = 'fixture-token-never-persist-this'; value.gate.env = { PRIVATE_VALIDATION_TOKEN: secret };
  const f = declaredFixture(t, { declared: value }); f.add();
  const job = f.queue().load().pending[0];
  assert.equal(JSON.stringify(job).includes(secret), false);
  assert.match(job.declared.value.gate.env.PRIVATE_VALIDATION_TOKEN, /^sha256:[0-9a-f]{64}$/);
  const profile = resolveGateProfile(f.repo, f.env);
  const execution = f.plan({ env: profile.env, profile });
  assert.equal(execution.env.PRIVATE_VALIDATION_TOKEN, secret);
  assert.equal(execution.command.includes(secret), false);
  assert.equal(JSON.stringify(execution.evidence).includes(secret), false);
  assert.doesNotThrow(() => sameDeclaration(job.declared, readDeclared(f.repo, { env: f.env })));
  value.gate.env.PRIVATE_VALIDATION_TOKEN = 'changed'; f.write('.lane.validation.json', JSON.stringify(value)); f.commit();
  assert.throws(() => sameDeclaration(job.declared, readDeclared(f.repo, { env: f.env })), /re-enqueue/);
});

test('authority: selected file details retain the v1 estimate fields', () => {
  const plan = { schema: 'promotion-tests/v2', files: ['whole.test.mjs'], steps: [], selected: [{ file: 'whole.test.mjs', reason: 'extra' }] };
  assert.throws(() => validateSelection(plan, { declaration: declaration() }), /v1 estimate/);
  plan.selected[0] = { ...plan.selected[0], estimated_ms: 100, estimate: 'measured' };
  assert.doesNotThrow(() => validateSelection(plan, { declaration: declaration() }));
});

test('authority: identifying a project driver never executes it with a guessed version flag', t => {
  const value = declaration(); value.runners.tool.command = ['./runner.sh'];
  const f = declaredFixture(t, { declared: value });
  f.write('runner.sh', '#!/bin/sh\nprintf "driver\\n" >> "$CHECK_LOG"\n');
  fs.chmodSync(path.join(f.repo, 'runner.sh'), 0o755); f.commit(); f.git(['rebase', 'main'], f.workspace);
  const execution = f.plan();
  assert.deepEqual(f.lines(), []);
  assert.match(execution.evidence.runtime.tool[0].binding.version, /^sha256:/);
  assert.ok(execution.evidence.runtime.tool[0].binding.interpreter.path);
});

test('authority: settle planning inherits owner host admission and retains provenance without a candidate gate', t => {
  const f = declaredFixture(t);
  let plan;
  try { plan = canonicalTestPlan({ repo: f.repo, base: f.base(), cwd: f.workspace, planner: declaration().promotion_tests,
    changed: ['product.txt'], required: ['whole.test.mjs'], env: f.env }); }
  catch (error) {
    const directory = path.join(f.repo, '.git/promote/planning');
    const names = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
    const latest = names.at(-1) && JSON.parse(fs.readFileSync(path.join(directory, names.at(-1), 'planning.json'), 'utf8'));
    if (latest?.native_context?.ok === false) return t.skip(`${latest.native_context.code}: native sandbox capability refused; rerun natively`);
    throw error;
  }
  assert.deepEqual(plan.files, ['whole.test.mjs']);
  const receipt = JSON.parse(fs.readFileSync(plan.planning_evidence.receipt, 'utf8'));
  assert.equal(receipt.exit_code, 0); assert.ok(receipt.evidence.planner_source.digest);
  assert.ok(receipt.slot_granted_at); assert.ok(receipt.host_receipt);
  assert.deepEqual(f.lines(), []);
});
