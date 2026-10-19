import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exactFixture } from '../../test/helpers/exact-validation-fixture.mjs';
import { readReceiptDeclaration, validateReceiptDeclaration, restrictEnvironment, exactIdentity, exactDigest, explainMiss, RUNNER_ENVIRONMENT } from '../exact-validation.mjs';
import { validateTree } from '../validation.mjs';

const options = f => ({ cwd: f.workspace, common: f.common, command: f.command, tier: 'fast', env: f.env, exact: { base: f.base, declaration: f.declaration } });

test('the committed canonical base alone opts in and declarations are closed', t => {
  const f = exactFixture(t, { declared: false });
  f.commit('.validation-receipts.json', JSON.stringify(f.declaration));
  assert.equal(readReceiptDeclaration({ repo: f.repo, base: f.base }), null);
  fs.writeFileSync(path.join(f.repo, '.validation-receipts.json'), JSON.stringify(f.declaration));
  assert.equal(readReceiptDeclaration({ repo: f.repo, base: f.base }), null, 'untracked canonical files cannot opt in');
  for (const value of [null, [], { ...f.declaration, schema: 'validation-receipts/v2' }, { ...f.declaration, extra: 1 }, { ...f.declaration, exclude: ['all-docs'] }, { ...f.declaration, environment: ['BAD-NAME'] }, { ...f.declaration, environment: ['MONITOR_TEST_SLOT_TOKEN'] }]) assert.throws(() => validateReceiptDeclaration(value));
  assert.deepEqual(validateReceiptDeclaration({ ...f.declaration, environment: ['Z', 'A'] }).environment, ['A', 'Z']);
});

test('identity hashes only declared environment and explains the first changed core input', t => {
  const f = exactFixture(t);
  const opts = { cwd: f.workspace, common: f.common, base: f.base, commands: [f.command], env: f.env, declaration: f.declaration };
  const identity = exactIdentity(opts);
  assert.equal(identity.repo, fs.realpathSync(f.common));
  assert.deepEqual(identity.exclusions.named, ['settle-review-document', 'runner-owned-environment']);
  assert.equal(JSON.stringify(identity).includes('must not reach children'), false);
  assert.equal(identity.environment.EXACT_VALUE.length, 64);
  assert.equal(exactIdentity({ ...opts, declaration: { ...f.declaration, environment: ['toString'] } }).environment.toString, 'absent');
  assert.equal(exactIdentity({ ...opts, env: { ...f.env, EXACT_VALUE: undefined } }).environment.EXACT_VALUE, 'absent');
  assert.notEqual(exactDigest(exactIdentity({ ...opts, env: { ...f.env, EXACT_VALUE: '' } })), exactDigest(exactIdentity({ ...opts, env: { ...f.env, EXACT_VALUE: undefined } })));
  assert.throws(() => exactIdentity({ ...opts, toolchain: {} }), /retain every core field/);
  assert.throws(() => exactIdentity({ ...opts, additional: { base: 'other' } }), /cannot replace or remove core/);
  const extended = exactIdentity({ ...opts, additional: { adapter: { preparation: 'digest' } } });
  assert.equal(extended.base, identity.base); assert.notEqual(exactDigest(extended), exactDigest(identity));
  assert.equal(exactIdentity({ ...opts, env: { ...f.env, UNLISTED: 'different' } }).candidate, identity.candidate);
  assert.equal(exactDigest(exactIdentity({ ...opts, env: { ...f.env, UNLISTED: 'different' } })), exactDigest(identity));
  const restricted = restrictEnvironment({ ...f.env, [RUNNER_ENVIRONMENT[0]]: 'promotion', MONITOR_UNLISTED_SECRET: 'hidden' }, f.declaration);
  assert.equal(restricted.UNLISTED, undefined); assert.equal(restricted.MONITOR_UNLISTED_SECRET, undefined); assert.equal(restricted[RUNNER_ENVIRONMENT[0]], 'promotion');
  for (const [field, mutate] of [
    ['repo', x => x.repo += '/other'], ['base', x => x.base = 'a'.repeat(40)], ['candidate', x => x.candidate = 'changed'],
    ['commands', x => x.commands.push('true')], ['toolchain.node', x => x.toolchain.node.version = 'v999.0.0'],
    ['environment.EXACT_VALUE', x => x.environment.EXACT_VALUE = 'absent'], ['prepare', x => x.prepare.push({ run: 'true' })], ['declared', x => x.declared = 'new salt'],
  ]) { const other = structuredClone(identity); mutate(other); assert.equal(explainMiss(other, identity), field); }
  assert.equal(explainMiss(identity, { exact: { identity: { ...identity, future: 1 } } }), 'declared', 'adapter additions remain bound');
});

test('exact reuse verifies source, log and completed sidecar and never calls onStart on a hit', t => {
  const f = exactFixture(t), opts = options(f); let starts = 0;
  const first = validateTree({ ...opts, onStart: () => starts++ });
  assert.equal(first.executed, true); assert.equal(first.exact.outcome, 'executed');
  const second = validateTree({ ...opts, env: { ...f.env, UNLISTED: 'changed' }, onStart: () => starts++ });
  assert.equal(second.reused, true); assert.equal(second.exact.outcome, 'reused'); assert.equal(starts, 1); assert.equal(f.runs(), 1);
  const original = path.join(f.common, 'lane-validation', first.key + '.json'), exact = path.join(f.common, 'lane-validation/exact', first.key + '.json');
  const cases = [
    ['receipt', () => { const doc = JSON.parse(fs.readFileSync(exact)); doc.duration_s++; fs.writeFileSync(exact, JSON.stringify(doc)); }],
    ['log', () => fs.appendFileSync(JSON.parse(fs.readFileSync(exact)).log, 'tampered')],
    ['sidecar', () => fs.appendFileSync(JSON.parse(fs.readFileSync(exact)).execution_receipt, ' ')],
    ...[
      ['red', d => { d.exit_code = 1; d.outcome = 'red'; }],
      ['reused', d => { d.reused = true; }], ['timeout', d => { d.gate_timeout = { kind: 'wall' }; d.outcome = 'timeout'; }],
      ['not-executed', d => { d.executed = false; }], ['identity', d => { d.exact.identity.candidate = 'tampered'; }],
    ].map(([name, change]) => [name, () => { const doc = JSON.parse(fs.readFileSync(exact)); change(doc); for (const p of [original, exact]) fs.writeFileSync(p, JSON.stringify(doc)); }]),
  ];
  let count = 1;
  for (const [name, tamper] of cases) {
    tamper(); const result = validateTree(opts);
    assert.equal(result.reused, false, name); assert.equal(f.runs(), ++count, name + ' executes exactly once');
  }
  const previous = JSON.parse(fs.readFileSync(exact));
  f.commit('work', 'ordinary content change');
  const changed = validateTree(opts);
  assert.equal(changed.reused, false); assert.equal(f.runs(), ++count);
  assert.equal(explainMiss(changed.exact.identity, previous), 'candidate');
});

for (const field of ['version', 'path']) test(`injected node ${field} cannot reuse a source from another toolchain`, t => {
  const f = exactFixture(t), opts = options(f);
  const actual = validateTree(opts), toolchain = structuredClone(actual.exact.identity.toolchain);
  toolchain.node[field] = field === 'version' ? 'v999.0.0' : '/other/node';
  const injected = validateTree({ ...opts, exact: { ...opts.exact, toolchain } });
  assert.equal(injected.reused, false); assert.equal(explainMiss(actual.exact.identity, injected), 'toolchain.node'); assert.equal(f.runs(), 2);
  assert.equal(validateTree({ ...opts, exact: { ...opts.exact, toolchain } }).reused, true);
});
