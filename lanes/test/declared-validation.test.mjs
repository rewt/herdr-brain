import test from '../../test/helpers/bounded-test.mjs';
import pendingTest from '../../test/helpers/pending-declared.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { declaredFixture, declaration } from '../../promote/test/helpers/declared-fixture.mjs';
import { readDeclared, resolveValidation } from '../validation.mjs';
import { snapshotDeclaration, sameDeclaration, validateDeclared, CAPABILITIES } from '../../promote/declaration.mjs';
import { executionIdentity } from '../../promote/execution-identity.mjs';
import { checkDeclaredJobs, requireDeclaredWorker, queueFor, finishCleanup, retryCleanup } from '../../promote/promote.mjs';
import { validateDeclared as parkedReader } from './fixtures/parked-v1-declaration.mjs';
import { bundleRelease } from '../../lib/releases.mjs';
import { configFixture } from '../../test/helpers/config-home-fixture.mjs';
import { policyLocation } from '../../lib/config-home.mjs';
import { spawnSync } from 'node:child_process';
import { product } from '../../promote/test/helpers/declared-fixture.mjs';
import { pendingConfigWrite, writeAuditedConfig } from '../../lib/config-audit.mjs';

pendingTest('only the canonical base declaration selects commands; working, lane and inherited overrides cannot authorize them', t => {
  const f = declaredFixture(t), original = readDeclared(f.repo);
  f.write('.lane.validation.json', JSON.stringify({ ...declaration(), promotion: 'false' }), f.workspace); f.commit(f.workspace);
  f.write('.lane.validation.json', JSON.stringify({ ...declaration(), promotion: 'also false' }));
  const resolved = resolveValidation({ root: f.repo, config: { validate: 'wrong', prepare: [{ run: 'wrong' }], validation: { promotion: 'wrong' } } });
  assert.equal(resolved.tiers.promotion.command, original.value.promotion);
  assert.equal(resolved.tiers.release.command, original.value.release);
  assert.deepEqual(readDeclared(f.repo).value, original.value);
  assert.throws(() => readDeclared(f.repo, { env: { ...f.env, LANE_VALIDATE: original.value.promotion } }), /overrides/);
});

for (const [file, value] of [['.promote.json', { validate: 'node baseline.mjs' }], ['.promote.json', { gate: {} }],
  ['.lane.json', { validate: 'node baseline.mjs' }], ['.lane.json', { validation: {} }], ['.lane.json', { prepare: [] }]]) pendingTest(`explicit competing ${file} ${Object.keys(value)[0]} refuses without fallback`, t => {
  const f = declaredFixture(t); f.write(file, JSON.stringify(value)); f.commit();
  assert.throws(() => readDeclared(f.repo), /competes/); assert.deepEqual(f.lines(), []);
});

test('closed v2 declarations require policy, coverage, explicit commands and contained cwd', () => {
  const value = declaration();
  for (const bad of [{ ...value, receipt_reuse: undefined }, { ...value, promotion: '' }, { ...value, release: undefined },
    { ...value, schema: 'declared-gates/v999' }, { ...value, typo: true }, { ...value, coverage: { ...value.coverage, promotion: ['x', 'x'] } },
    { ...value, gates: { promotion: value.gates.tool } }, { ...value, gates: { tool: { ...value.gates.tool, cwd: '../escape' } } }]) assert.throws(() => validateDeclared(bad));
});

test('parked v1 and incapable worker handshakes refuse v2 before admission', t => {
  const f = declaredFixture(t); assert.throws(() => parkedReader(declaration()), /invalid declaration fields|unsupported declaration schema/);
  const release = path.join(f.root, 'old-release'); fs.mkdirSync(path.join(release, 'promote'), { recursive: true });
  fs.writeFileSync(path.join(release, 'promote/promote.mjs'), "console.log(JSON.stringify({declaration:'declared-gates/v1',selection:'promotion-tests/v2',execution:'declared-gate-execution/v1'}));");
  assert.throws(() => requireDeclaredWorker(bundleRelease(release), f.repo), /does not support/);
  assert.equal(fs.existsSync(path.join(f.repo, '.git/promote/queue.json')), false); assert.deepEqual(f.lines(), []);
});

pendingTest('unmarked caller and project share the standard default identity', t => {
  const f = declaredFixture(t, { marked: false }), binding = executionIdentity(f.queue().project);
  assert.equal(binding.caller_root, null); assert.equal(binding.project_root, null);
});

pendingTest('config-home resolution owns the complete declaration and lost or invalid home policy cannot fall back', async t => {
  const f = configFixture(t); await f.adopt();
  const file = policyLocation(f.cwd, 'validation', f.env).file, value = declaration();
  fs.writeFileSync(file, JSON.stringify(value));
  const owner = readDeclared(f.cwd, { env: f.env });
  assert.equal(owner.source.storage, 'config-home'); assert.equal(owner.source.file, file); assert.match(owner.source.revision, /^sha256:/);
  fs.writeFileSync(path.join(f.cwd, '.lane.validation.json'), JSON.stringify({ ...value, promotion: 'wrong retained copy' }));
  assert.equal(readDeclared(f.cwd, { env: f.env }).value.promotion, value.promotion);
  fs.writeFileSync(file, '{'); assert.throws(() => readDeclared(f.cwd, { env: f.env }), /invalid|JSON|held/);
  fs.unlinkSync(file); assert.throws(() => readDeclared(f.cwd, { env: f.env }), /missing|owner repair/);
});

pendingTest('a declared project cannot forward admission into a pinned incapable worker', async t => {
  const f = configFixture(t); await f.adopt();
  fs.writeFileSync(policyLocation(f.cwd, 'validation', f.env).file, JSON.stringify(declaration()));
  const old = f.release('old-worker'), marker = path.join(f.scratch, 'old-admission');
  fs.writeFileSync(path.join(old, 'promote/promote.mjs'), `import fs from 'node:fs';if(process.argv.includes('--capabilities'))console.log(JSON.stringify({declaration:'declared-gates/v1'}));else fs.writeFileSync(${JSON.stringify(marker)},'old admission ran');`);
  const manifest = spawnSync(process.execPath, [path.join(product, 'herdr/releases.mjs'), 'manifest', old, path.join(old, '.release-acceptance.json')], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  assert.equal(manifest.status, 0, manifest.stderr);
  fs.writeFileSync(policyLocation(f.cwd, 'pin', f.env).file, JSON.stringify({ release: 'old-worker' }));
  // An alias of the immutable current entry point exercises forwarding while
  // retaining the fixture installation home (releaseHome is OS-owned).
  const entry = path.join(f.scratch, 'promote-entry.mjs'); fs.symlinkSync(path.join(f.bundle, 'promote/promote.mjs'), entry);
  const result = spawnSync(process.execPath, [entry, 'new-lane', '--repo', f.cwd], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /does not support/);
  assert.equal(fs.existsSync(marker), false); assert.equal(fs.existsSync(path.join(f.cwd, '.git/promote/queue.json')), false);
});

pendingTest('foreign roots, same-identity foreign projects, missing roots and changed bound roots refuse before effects', t => {
  const f = declaredFixture(t), q = f.queue(), before = JSON.stringify(q.load());
  const bound = executionIdentity(q.project);
  assert.equal(bound.caller_root, f.owner); assert.equal(bound.project_root, f.owner);
  assert.throws(() => executionIdentity(q.project, { cwd: f.foreign }), /IDENTITY_MISMATCH/);
  assert.throws(() => executionIdentity(q.project, { cwd: f.owner }), /PROJECT_MISMATCH/);
  assert.throws(() => executionIdentity(q.project, { bound: { ...bound, project_root: null } }), /BINDING_CHANGED/);
  const cli = f.cli(['topic', '--repo', f.repo], f.foreign);
  assert.equal(cli.status, 1); assert.match(cli.stderr, /PROMOTION_IDENTITY_MISMATCH/);
  assert.equal(JSON.stringify(q.load()), before); assert.deepEqual(f.lines(), []);
});

for (const change of ['declaration edit', 'pending config write']) pendingTest(`foreign admission preserves target record bytes with a ${change}`, async t => {
  const f = configFixture(t, { custom: 'owner' }); await f.adopt();
  const previous = process.cwd(); t.after(() => process.chdir(previous)); process.chdir(f.cwd);
  const file = policyLocation(f.cwd, 'validation', f.env).file, value = declaration();
  fs.writeFileSync(file, JSON.stringify(value)); readDeclared(f.cwd, { env: f.env });
  const next = { ...value, environment: 'edited declaration' };
  if (change === 'declaration edit') fs.writeFileSync(file, JSON.stringify(next));
  else assert.throws(() => writeAuditedConfig({ file, value: next, kind: 'validation', binding: f.binding(), cwd: f.cwd, env: f.env, validate: validateDeclared,
    afterReplace() { throw Error('interrupted config write'); } }), /interrupted config write/);
  const record = path.join(f.env.ORG_DIR, 'events.jsonl'), before = fs.readFileSync(record);
  const foreign = path.join(f.scratch, 'foreign'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, '.identity-root'), '');
  const result = spawnSync(process.execPath, [path.join(product, 'promote/promote.mjs'), 'topic', '--repo', f.cwd], { cwd: foreign, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /PROMOTION_IDENTITY_MISMATCH/);
  process.chdir(foreign);
  assert.throws(() => queueFor(f.cwd), /PROMOTION_IDENTITY_MISMATCH/);
  assert.deepEqual(fs.readFileSync(record), before);
  assert.equal(fs.existsSync(path.join(f.cwd, '.git/promote')), false);
  if (change === 'pending config write') assert.equal(pendingConfigWrite(f.env.ORG_DIR, file).length, 1);
  // Owner reads still audit/recover exactly the same revision after the fence.
  process.chdir(f.cwd); assert.equal(readDeclared(f.cwd, { env: f.env }).value.environment, next.environment);
  assert.ok(fs.readFileSync(record).length > before.length);
  assert.equal(pendingConfigWrite(f.env.ORG_DIR, file).length, 0);
});

pendingTest('declaration inspection preserves both records on invalid or missing policy and identity files', async t => {
  const f = configFixture(t, { custom: 'owner' }); await f.adopt();
  const binding = f.binding(), file = policyLocation(f.cwd, 'validation', f.env).file;
  fs.writeFileSync(file, JSON.stringify(declaration())); readDeclared(f.cwd, { env: f.env });
  const records = [path.join(f.env.ORG_DIR, 'events.jsonl'), path.join(path.dirname(binding.identityFile), '.org/events.jsonl')];
  const before = records.map(record => fs.readFileSync(record));
  for (const target of [file, binding.identityFile]) {
    const bytes = fs.readFileSync(target);
    for (const damage of ['invalid', 'missing']) {
      if (damage === 'invalid') fs.writeFileSync(target, '{'); else fs.unlinkSync(target);
      assert.throws(() => readDeclared(f.cwd, { env: f.env, audit: false }));
      records.forEach((record, i) => assert.deepEqual(fs.readFileSync(record), before[i]));
      fs.writeFileSync(target, bytes);
    }
  }
});

for (const change of ['foreign caller after rollback', 'changed identity root']) pendingTest(`pending cleanup refuses ${change} before any effect`, t => {
  const f = declaredFixture(t); f.add(); const q = f.queue(), job = q.load().pending[0];
  const saved = { ...job, outcome: 'promoted', finished: new Date().toISOString(), workspace: f.workspace, tip: f.head(), cleanup: { state: 'pending' } };
  q.transaction(data => { data.pending = []; data.results.push(saved); });
  f.git(['rm', '.lane.validation.json']); f.commit();
  if (change === 'foreign caller after rollback') process.chdir(f.foreign);
  else fs.unlinkSync(path.join(f.owner, '.identity-root'));
  const code = change === 'foreign caller after rollback' ? /PROMOTION_IDENTITY_MISMATCH/ : /PROMOTION_IDENTITY_BINDING_CHANGED/;
  const before = fs.readFileSync(q.file), entries = fs.readdirSync(q.directory).sort();
  const cli = f.cli(['--cleanup-job', job.id, '--repo', f.repo], process.cwd());
  assert.equal(cli.status, 1); assert.match(cli.stderr, code);
  assert.throws(() => queueFor(f.repo), code);
  assert.throws(() => finishCleanup(saved, saved, q), code);
  assert.throws(() => retryCleanup(q), code);
  assert.deepEqual(fs.readFileSync(q.file), before); assert.deepEqual(fs.readdirSync(q.directory).sort(), entries);
  assert.ok(fs.existsSync(f.workspace)); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head()); assert.deepEqual(f.lines(), []);
});

test('undeclared projects retain command precedence and reject typed gate requirements', t => {
  const f = declaredFixture(t); f.git(['rm', '.lane.validation.json']); f.commit();
  const settings = resolveValidation({ root: f.repo, config: { validate: 'legacy command' }, env: { ...f.env, LANE_VALIDATE: 'environment command' } });
  assert.equal(settings.tiers.promotion.command, 'environment command'); assert.equal(settings.declared, undefined);
  assert.throws(() => f.add({ requiredTests: [{ gate: 'tool' }] }), /invalid required test files/);
});

pendingTest('admission binds full requirements, capable worker, identity and redacts literal environment values', t => {
  const value = declaration(); value.gate.env = { DECLARED_LITERAL: 'nonsecret-test-value' };
  const f = declaredFixture(t, { declared: value }); f.add({ requiredTests: [{ gate: 'tool' }] });
  const q = f.queue(), job = q.load().pending[0];
  assert.deepEqual(job.requiredTests[0].definition, value.gates.tool); assert.equal(job.execution_identity.project_root, f.owner);
  assert.equal(JSON.stringify(job).includes('nonsecret-test-value'), false);
  assert.match(job.declared.value.gate.env.DECLARED_LITERAL, /^sha256:/);
  assert.doesNotThrow(() => sameDeclaration(job.declared, readDeclared(f.repo)));
  const caps = JSON.parse(f.good(f.cli(['--capabilities']))); assert.deepEqual(caps, CAPABILITIES);
  const damaged = structuredClone(job); delete damaged.requiredTests[0].definition;
  assert.throws(() => checkDeclaredJobs(q, [damaged]), /admission definition/);
  const owner = snapshotDeclaration(readDeclared(f.repo));
  f.write('.lane.validation.json', JSON.stringify({ ...value, promotion: 'false' })); f.commit();
  assert.throws(() => sameDeclaration(owner, readDeclared(f.repo)), /re-admission/);
});
