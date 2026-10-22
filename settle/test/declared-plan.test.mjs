import test from '../../test/helpers/bounded-test.mjs';
import pendingTest from '../../test/helpers/pending-declared.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { declaredFixture, declaration } from '../../promote/test/helpers/declared-fixture.mjs';
import { canonicalTestPlan } from '../test-plan.mjs';
import { deferredTests } from '../test-evidence.mjs';
import { readDeclared } from '../../lanes/validation.mjs';

test('declared deferrals retain whole-file tokens, recipe tokens and complete gate requirements without changing legacy parsing', () => {
  const text = '- Test evidence not re-executed: suite.test.ts\n- Test evidence not re-executed: recipe:controls\n- Test evidence not re-executed: {"gate":"tool"}';
  assert.equal(deferredTests(text, ''), null);
  const required = deferredTests(text, '', { declared: true });
  assert.ok(required.some(row => row === 'suite.test.ts')); assert.ok(required.some(row => row === 'recipe:controls')); assert.ok(required.some(row => row.gate === 'tool'));
  assert.equal(deferredTests('- Test evidence not re-executed: {"gate":"tool","command":"true"}', '', { declared: true }), null);
  assert.deepEqual(deferredTests('- Test evidence not re-executed: old.test.mjs', ''), ['old.test.mjs']);
});

pendingTest('settle observes canonical declared coverage through host admission without executing candidate gates', t => {
  const f = declaredFixture(t);
  let plan;
  try { plan = canonicalTestPlan({ repo: f.repo, base: f.base(), cwd: f.workspace, planner: declaration().promotion_tests,
    changed: ['product.txt'], required: ['whole.test.ts'], env: f.env }); }
  catch (error) { if (error.code?.startsWith('PROMOTE_NATIVE_')) { t.skip(error.message); return; } throw error; }
  assert.deepEqual(plan.gates.map(row => row.id), ['tool']); assert.ok(plan.coverage.includes('whole.test.ts'));
  assert.deepEqual(f.lines(), []); const saved = JSON.parse(fs.readFileSync(plan.planning_evidence.receipt, 'utf8'));
  assert.equal(saved.phase, 'planning-only'); assert.equal(saved.evidence.schema, 'declared-gate-attempt/v2');
});

pendingTest('without a planner the mandatory declared command must supply every required token', t => {
  const value = declaration(); delete value.promotion_tests;
  const f = declaredFixture(t, { declared: value }), owner = readDeclared(f.repo);
  let plan;
  try { plan = canonicalTestPlan({ repo: f.repo, base: f.base(), cwd: f.workspace, declared: owner, changed: [], required: ['baseline'], env: f.env }); }
  catch (error) { if (error.code?.startsWith('PROMOTE_NATIVE_')) { t.skip(error.message); return; } throw error; }
  assert.ok(plan.coverage.includes('baseline')); assert.deepEqual(plan.gates, []); assert.deepEqual(f.lines(), []);
});
