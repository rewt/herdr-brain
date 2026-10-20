import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveResource, resourceStanza } from '../resources.mjs';
import { sharedOccupancy } from '../occupancy.mjs';
import { validateTree } from '../../lanes/validation.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';

const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(t, admissionClass) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-profile-rejection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, 'slot'), receipt = path.join(root, 'receipt.json'), marker = path.join(root, 'started');
  const recipe = 'node marker.cjs';
  const resource = { ...resourceStanza('fixture/proving', undefined, admissionClass), command_sha256: hash(recipe) };
  const pkg = { scripts: { prove: recipe }, resources: { prove: resource } };
  const save = () => fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  save(); fs.writeFileSync(path.join(root, 'marker.cjs'), `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}\nrequire(${JSON.stringify(path.join(root, 'marker.cjs'))})\n`, { mode: 0o700 });
  // A null-start live fixture holder is conservatively reserved. It needs no
  // native process-source read and cannot be mistaken for an enclosing holder.
  const holder = JSON.stringify({ pid: process.pid, processStart: null, pgid: null, token: 'fixture-holder', label: 'peer' });
  fs.writeFileSync(lock, holder);
  const env = { ...testSlotEnvironment(), PATH: `${bin}:${process.env.PATH}`, HERDR_MONITOR_FLEET: path.join(root, 'fleet'),
    MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  const run = (argv = ['npm', 'run', 'prove']) => spawnSync(process.execPath, [cli, 'run', 'rejection witness', '--wait', '0',
    '--result-path', receipt, '--', ...argv], { cwd: root, env, encoding: 'utf8', timeout: loadTimeout(15000) });
  return { root, lock, receipt, marker, resource, pkg, save, run, holder, env };
}

for (const admissionClass of ['EXCLUSIVE', 'SHARED']) test(`stale-hash ${admissionClass} declaration warns and preserves its admission class`, t => {
  const f = fixture(t, admissionClass); f.pkg.resources.prove.command_sha256 = hash('old script'); f.save();
  const result = f.run();
  assert.equal((result.stderr.match(/TEST_SLOT_PROFILE_REJECTED/g) ?? []).length, 1, result.stderr);
  assert.match(result.stderr, /fixture\/proving.*command_sha256/);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), f.holder, 'a rejected declaration never overwrites the peer holder');
  if (admissionClass === 'EXCLUSIVE') {
    assert.equal(result.status, 75, result.stderr); assert.equal(fs.existsSync(f.marker), false);
    // Once the fixture peer releases, the same rejected stanza takes the
    // exclusive path and records the rejection reason on successful execution.
    fs.unlinkSync(f.lock); const admitted = f.run(); assert.equal(admitted.status, 0, admitted.stderr);
    assert.equal((admitted.stderr.match(/TEST_SLOT_PROFILE_REJECTED/g) ?? []).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(f.receipt)).class, 'exclusive');
  } else {
    assert.equal(result.status, 0, result.stderr); assert.equal(fs.existsSync(f.marker), true);
    assert.equal(JSON.parse(fs.readFileSync(f.receipt)).class, 'shared');
  }
  const saved = JSON.parse(fs.readFileSync(f.receipt));
  assert.match(saved.resource.reason, /TEST_SLOT_PROFILE_REJECTED.*fixture\/proving.*command_sha256/);
  assert.equal(saved.resource.profile, undefined, 'rejection cannot invent a valid measurement binding');
});

for (const admissionClass of ['EXCLUSIVE', 'SHARED', undefined])
  for (const check of ['command_sha256', 'command', 'M_bytes']) test(`rejected ${admissionClass ?? 'missing class'} ${check} has a coded reason`, t => {
    const f = fixture(t, admissionClass); delete f.pkg.resources.prove.admission_class;
    if (admissionClass) f.pkg.resources.prove.admission_class = admissionClass;
    const argv = ['npm', 'run', 'prove'];
    if (check === 'command_sha256') f.pkg.resources.prove.command_sha256 = 'stale';
    if (check === 'command') argv.push('--', '--extra');
    if (check === 'M_bytes') f.pkg.resources.prove.M_bytes = -1;
    f.save();
    const resolved = resolveResource(argv, { cwd: f.root, env: {} });
    assert.equal(resolved.admission_class, admissionClass === 'EXCLUSIVE' ? 'EXCLUSIVE' : 'SHARED');
    assert.match(resolved.reason, new RegExp(`TEST_SLOT_PROFILE_REJECTED.*fixture/proving.*${admissionClass ? check : '(admission_class|command_sha256|command)'}`));
  });

test('direct-node extra argv and stale script digest preserve a found proving declaration', t => {
  const f = fixture(t, 'EXCLUSIVE');
  for (const [argv, digest, check] of [
    [['node', 'marker.cjs', '--extra'], hash(f.pkg.scripts.prove), 'command'],
    [['node', 'marker.cjs'], 'stale', 'command_sha256'],
  ]) {
    f.pkg.resources.prove.command_sha256 = digest; f.save();
    const resolved = resolveResource(argv, { cwd: f.root, env: {} });
    assert.equal(resolved.admission_class, 'EXCLUSIVE'); assert.match(resolved.reason, new RegExp(check));
  }
});

test('malformed explicit stanza preserves EXCLUSIVE and an absent stanza stays quietly unprofiled', t => {
  const f = fixture(t, 'EXCLUSIVE'), argv = ['node', 'unknown.cjs'];
  const rejected = resolveResource(argv, { cwd: f.root, resource: { ...resourceStanza('fixture/direct', argv, 'EXCLUSIVE'), C: 0 } });
  assert.equal(rejected.admission_class, 'EXCLUSIVE'); assert.match(rejected.reason, /TEST_SLOT_PROFILE_REJECTED.*fixture\/direct.*C/);
  assert.deepEqual(resolveResource(argv, { cwd: f.root }), { admission_class: 'SHARED', reason: 'unprofiled' });
});

for (const floor of [-1, null, 0.5, Number.MAX_SAFE_INTEGER + 1, '0'])
  test(`invalid proving floor ${JSON.stringify(floor)} refuses before either lock`, t => {
    const f = fixture(t, 'EXCLUSIVE'); f.pkg.resources.prove.memory_floor_bytes = floor; f.save();
    fs.unlinkSync(f.lock);
    const result = f.run(); assert.equal(result.status, 75, result.stderr);
    assert.match(result.stderr, /TEST_SLOT_PROFILE_REJECTED:.*memory_floor_bytes/);
    assert.equal(fs.existsSync(f.marker), false); assert.equal(fs.existsSync(f.lock), false);
    assert.equal(fs.existsSync(`${f.lock}.occupancy`), false); assert.equal(fs.existsSync(`${f.lock}.queue`), false);
  });

test('SHARED cannot carry a floor or inherit its wait, and a rejected floor-bearing proving binding cannot bypass its floor', t => {
  const f = fixture(t, 'SHARED'); f.pkg.resources.prove.memory_floor_bytes = Number.MAX_SAFE_INTEGER; f.save();
  const shared = f.run(); assert.equal(shared.status, 0, shared.stderr); assert.match(shared.stderr, /TEST_SLOT_PROFILE_REJECTED:.*memory_floor_bytes/);
  assert.doesNotMatch(shared.stderr, /TEST_SLOT_MEMORY_/); assert.equal(JSON.parse(fs.readFileSync(f.receipt)).class, 'shared');
  fs.unlinkSync(f.marker); f.pkg.resources.prove.admission_class = 'EXCLUSIVE'; f.pkg.resources.prove.command_sha256 = 'stale'; f.save();
  const exclusive = f.run(); assert.equal(exclusive.status, 75, exclusive.stderr); assert.match(exclusive.stderr, /TEST_SLOT_PROFILE_REJECTED:.*command_sha256/);
  assert.doesNotMatch(exclusive.stderr, /TEST_SLOT_HELD/); assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), f.holder);
});

test('shared occupancy supplies the holder-schema cwd for retirement matching', t => {
  const f = fixture(t, 'SHARED'), slot = sharedOccupancy(f.lock, 'gate', { reason: 'unprofiled' });
  try {
    const record = JSON.parse(fs.readFileSync(slot.occupancyPath));
    assert.equal(Object.keys(record)[0], 'schema'); assert.equal(record.schema, 'occupancy/v1');
    assert.equal(record.cwd, process.cwd());
  } finally { slot.release(); }
});

test('adapters can rebind a rejected proving declaration without losing its failed check', t => {
  const f = fixture(t, 'EXCLUSIVE'), directory = path.join(f.root, 'test-slot'); fs.mkdirSync(directory);
  const command = 'node marker.cjs';
  fs.writeFileSync(path.join(directory, 'validation-resources.json'), JSON.stringify({ prove: {
    ...resourceStanza('fixture/validation', command, 'EXCLUSIVE'), M_bytes: -1,
  } }));
  const resolved = resolveResource(['/bin/sh', '-c', command], { cwd: f.root, env: {} });
  assert.equal(resolved.admission_class, 'EXCLUSIVE'); assert.match(resolved.reason, /failed M_bytes$/);
  const train = ['node', 'train.mjs'];
  const rebound = resolveResource(train, { cwd: f.root, resource: { ...resolved.declaration, id: 'fixture/validation/train', command: train } });
  assert.equal(rebound.admission_class, 'EXCLUSIVE'); assert.equal(rebound.reason, resolved.reason);
  assert.equal(rebound.profile, undefined);
});

for (const adapter of ['validation', 'train']) test(`${adapter} passes a rejected EXCLUSIVE recipe to the runner`, t => {
  const f = fixture(t, 'EXCLUSIVE'), command = 'node marker.cjs';
  const git = args => {
    const result = spawnSync('git', ['-C', f.root, '-c', 'user.name=Profile fixture', '-c', 'user.email=fixture@example.invalid', ...args],
      { env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  fs.mkdirSync(path.join(f.root, 'test-slot'));
  fs.writeFileSync(path.join(f.root, 'test-slot/validation-resources.json'), JSON.stringify({ promotion: {
    ...resourceStanza('fixture/recipe', command, 'EXCLUSIVE'), M_bytes: -1,
  } }));
  fs.writeFileSync(path.join(f.root, '.lane.validation.json'), JSON.stringify({ promotion: command }));
  fs.writeFileSync(path.join(f.root, '.promote.json'), JSON.stringify({ gate: { wait_seconds: 0 } }));
  fs.writeFileSync(path.join(f.root, '.gitignore'), 'slot*\nreceipt*\nstarted\nbin/\n');
  git(['init', '-qb', 'main']); git(['add', '.']); git(['commit', '-qm', 'Rejected recipe fixture']);
  if (adapter === 'validation') {
    assert.throws(() => validateTree({ cwd: f.root, common: path.join(f.root, '.git'), command, tier: 'promotion',
      env: { ...f.env, MONITOR_TEST_SLOT_WAIT_SECONDS: '0' } }), error => {
      assert.equal(error.exitCode, 75); assert.match(error.message, /TEST_SLOT_PROFILE_REJECTED.*fixture\/recipe.*M_bytes/); return true;
    });
  } else {
    const plan = path.join(f.root, '.git', 'train.json'); fs.writeFileSync(plan, JSON.stringify({ jobs: [{ id: 'fixture-job' }] }));
    const host = fileURLToPath(new URL('../../promote/host-gate.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [host, f.root, plan, path.join(f.root, 'marker.cjs')],
      { cwd: f.root, env: f.env, encoding: 'utf8', timeout: loadTimeout(15000) });
    assert.equal(result.status, 75, result.stderr);
    assert.equal((result.stderr.match(/TEST_SLOT_PROFILE_REJECTED/g) ?? []).length, 1, result.stderr);
    assert.match(result.stderr, /fixture\/recipe.*M_bytes/);
  }
  assert.equal(fs.existsSync(f.marker), false); assert.equal(fs.readFileSync(f.lock, 'utf8'), f.holder);
});
