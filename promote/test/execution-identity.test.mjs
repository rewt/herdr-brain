import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { declaredFixture } from './helpers/declared-fixture.mjs';
import { executionIdentity } from '../execution-identity.mjs';
import { drain, enqueue } from '../promote.mjs';
import { runTrain } from '../train.mjs';
import { resolveValidation } from '../../lanes/validation.mjs';

for (const marked of [true, false]) test(`own canonical checkout and linked worktree are allowed (${marked ? 'marked' : 'default'} identity)`, t => {
    const f = declaredFixture(t, { marked });
    const q = f.queue();
    const binding = executionIdentity(q.project);
    assert.equal(binding.project_root, marked ? f.owner : null);
    process.chdir(f.workspace);
    assert.deepEqual(executionIdentity(q.project), binding);
    f.add();
    const job = q.load().pending[0];
    assert.deepEqual(job.execution_identity, binding);
    assert.equal(job.expectedHead, f.head());
    assert.equal(job.declared.schema, 'declared-gates/v1');
});

test('foreign enqueue, drain, resume and --repo refuse before queue or worker side effects', async t => {
  const f = declaredFixture(t), q = f.queue();
  f.add();
  const before = fs.readFileSync(q.file, 'utf8');
  process.chdir(f.foreign);
  assert.throws(() => enqueue(q, ['topic'], {}), { code: 'PROMOTION_IDENTITY_MISMATCH' });
  await assert.rejects(drain(q), { code: 'PROMOTION_IDENTITY_MISMATCH' });
  for (const args of [['topic'], ['--drain'], ['--resume']]) {
    const result = f.cli([...args, '--repo', f.repo], f.foreign);
    assert.equal(result.status, 1); assert.match(result.stderr, /PROMOTION_IDENTITY_MISMATCH/);
  }
  assert.equal(fs.readFileSync(q.file, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(q.directory, 'worker.lock')), false);
  assert.equal(fs.existsSync(path.join(q.directory, 'worker.log')), false);
  assert.deepEqual(f.lines(), []);
});

test('foreign integration and an ambiguous marker leave a train byte-identical', async t => {
  const f = declaredFixture(t), q = f.queue(); f.add();
  const file = path.join(f.root, 'train.json');
  const jobs = q.load().pending;
  const receipt = { schema: 'promotion-train/v1', identity: q.project.identity, jobs,
    attempts: [{ phase: 'validated', execution_identity: jobs[0].execution_identity, tip: f.head(), base: f.base(), gate: { exit_code: 0, signal: null } }] };
  fs.writeFileSync(file, JSON.stringify(receipt));
  const before = fs.readFileSync(file, 'utf8');
  const validation = resolveValidation({ root: f.repo, env: f.env });
  process.chdir(f.foreign);
  await assert.rejects(runTrain({ file, canonical: f.repo, identity: q.project.identity, main: 'main', prepare: [], validation }), { code: 'PROMOTION_IDENTITY_MISMATCH' });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  process.chdir(f.repo);
  fs.unlinkSync(path.join(f.owner, '.identity-root'));
  fs.symlinkSync(path.join(f.foreign, '.identity-root'), path.join(f.owner, '.identity-root'));
  assert.throws(() => executionIdentity(q.project), { code: 'PROMOTION_IDENTITY_AMBIGUOUS' });
  await assert.rejects(drain(q), { code: 'PROMOTION_IDENTITY_AMBIGUOUS' });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(f.lines(), []);
});

test('same identity with a different Git project and changed saved roots refuse', t => {
  const f = declaredFixture(t), q = f.queue(), binding = executionIdentity(q.project);
  assert.throws(() => executionIdentity(q.project, { cwd: f.owner }), { code: 'PROMOTION_PROJECT_MISMATCH' });
  assert.throws(() => executionIdentity(q.project, { bound: { ...binding, project_root: f.foreign } }), { code: 'PROMOTION_IDENTITY_BINDING_CHANGED' });
});
