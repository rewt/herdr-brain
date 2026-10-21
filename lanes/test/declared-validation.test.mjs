import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateValidation, resolveValidation } from '../validation.mjs';
import { validateValidation as oldReader } from './fixtures/pre-profile-validation.mjs';
import { declaration, declaredFixture } from '../../promote/test/helpers/declared-fixture.mjs';
import { readDeclared } from '../validation.mjs';

test('closed declared schema and old-reader refusal', () => {
  const value = declaration();
  assert.doesNotThrow(() => validateValidation(value));
  assert.throws(() => oldReader(value), /unknown validation field: schema/);
  for (const change of [{ schema: 'declared-gates/v2' }, { release: '' }, { promotion: null }, { typo: true },
    { runners: { wrong: { command: ['node'], cwd: '../escape' } } }, { runners: { wrong: { command: 'node', cwd: '.' } } },
    { promotion_tests: 'planner.mjs' }, { gate: { env: { NODE_OPTIONS: '--import=lane.mjs' } } },
    { gate: { prepare: [{ run: 'pnpm install --offline', unless: 'node_modules' }] } }])
    assert.throws(() => validateValidation({ ...value, ...change }));
});

test('one committed authority ignores lane edits and inherited preparation', t => {
  const f = declaredFixture(t);
  f.write('.lane.validation.json', JSON.stringify({ ...declaration(), promotion: 'false' }), f.workspace);
  const resolved = resolveValidation({ root: f.repo, env: f.env, config: { prepare: [{ run: 'false' }], validate: 'false' } });
  assert.equal(resolved.tiers.promotion.command, 'node baseline.mjs');
  assert.equal(resolved.declared.source.revision, f.base());
  assert.equal(resolved.declared.source.file, path.join(f.repo, '.lane.validation.json'));
  f.write('.lane.validation.json', JSON.stringify({ ...declaration(), promotion: 'false' }));
  assert.equal(resolveValidation({ root: f.repo, env: f.env }).tiers.promotion.command, 'node baseline.mjs');
  assert.throws(() => resolveValidation({ root: f.repo, env: { ...f.env, LANE_VALIDATE: 'true' } }), /overrides/);
  assert.throws(() => f.add({ validate: 'node baseline.mjs' }), /overrides/);
});

for (const [file, value] of [['.promote.json', { validate: 'node baseline.mjs' }], ['.promote.json', { gate: {} }],
  ['.lane.json', { validate: 'true' }], ['.lane.json', { validation: { promotion: 'true' } }], ['.lane.json', { prepare: [] }]]) {
  test(`competing ${file} ${Object.keys(value)[0]} refuses without fallback`, t => {
    const f = declaredFixture(t); f.write(file, JSON.stringify(value)); f.commit();
    assert.throws(() => readDeclared(f.repo, { env: f.env }), /competes/);
    assert.equal(fs.existsSync(path.join(f.repo, '.git/promote/queue.json')), false);
    assert.deepEqual(f.lines(), []);
  });
}

test('explicit local check remains development evidence and cannot omit declared promotion planning', t => {
  const f = declaredFixture(t);
  f.good(f.lane(['check', '--cmd', 'node baseline.mjs']));
  const gate = JSON.parse(fs.readFileSync(path.join(f.workspace, '.lane/gate.json'), 'utf8'));
  assert.equal(gate.exit_code, 0); assert.equal(gate.declared_gate, undefined);
  const result = f.lane(['check', '--tier', 'promotion']);
  assert.equal(result.status, 1); assert.match(result.stderr, /promotion queue/);
  assert.equal(f.lines().length, 1);
});
