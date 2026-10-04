import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pruneSnapshots } from '../retention.mjs';

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'release-retention-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Retention']); git(['config', 'user.email', 'retention@example.invalid']);
  fs.writeFileSync(path.join(repo, 'source'), 'rebuildable');
  fs.writeFileSync(path.join(repo, 'historical.log'), 'already in Git');
  fs.writeFileSync(path.join(repo, 'changed-receipt.json'), '{"old":true}');
  git(['add', '.']); git(['commit', '-qm', 'Source']);
  const commit = git(['rev-parse', 'HEAD']), project = { canonical: repo, identity: path.join(repo, '.git') }, candidates = [];
  const env = { HERDR_MONITOR_HOME: path.join(repo, 'installed') };
  const add = (status = 'gate-failed', result = 'failed') => {
    const number = candidates.length + 1, tag = `rc-${number}`, snapshot = path.join(project.identity, 'release/candidates', tag);
    git(['tag', tag]); fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(snapshot, '.release-commit'), commit + '\n');
    fs.writeFileSync(path.join(snapshot, 'source'), 'rebuildable');
    fs.writeFileSync(path.join(snapshot, 'historical.log'), 'already in Git');
    fs.writeFileSync(path.join(snapshot, 'changed-receipt.json'), '{"old":true}');
    const c = { id: `RC-${number}`, tag, snapshot, identity: project.identity, commit, status,
      created: { seq: number }, started: {}, gate: { result, seq: number } };
    candidates.push(c); return c;
  };
  const prune = options => pruneSnapshots({ project, candidates, env, ...options });
  return { repo, project, candidates, env, add, prune, git, commit };
}

test('retention keeps active, awaiting, pending, interrupted and the latest passed candidate', t => {
  const f = fixture(t), failed = f.add(), older = f.add('declined', 'passed'), active = f.add('approved', 'passed');
  const awaiting = f.add('awaiting-operator', 'passed'), latest = f.add('declined', 'passed');
  const pending = f.add('pending-gate'); pending.started = null; pending.gate = null;
  const interrupted = f.add('inspect-interrupted'); interrupted.gate = null;
  const signaled = f.add('gate-failed', 'interrupted');
  // Same commits are normal here; explicit tag selects just the active candidate.
  const preview = f.prune({ dryRun: true, activeTag: active.tag });
  assert.deepEqual(preview.would_remove.map(c => c.id), [failed.id, older.id]);
  assert.equal(preview.receipt, null);
  assert.equal(fs.existsSync(path.join(f.project.identity, 'release/evidence')), false);
  const result = f.prune({ activeTag: active.tag });
  assert.deepEqual(result.removed.map(c => c.id), [failed.id, older.id]);
  for (const c of [active, awaiting, latest, pending, interrupted, signaled]) assert.ok(fs.existsSync(c.snapshot));
  assert.equal(f.git(['rev-parse', failed.tag]), failed.commit);
  const entries = fs.readFileSync(result.receipt, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries.map(e => e.action), ['remove-intent', 'removed', 'remove-intent', 'removed']);
  assert.equal(f.prune({ activeTag: active.tag }).removed.length, 0, 'repeat pruning is harmless');
});

test('installed current commit protects an active snapshot and malformed active pointers fail closed', t => {
  const f = fixture(t), c = f.add();
  fs.mkdirSync(f.env.HERDR_MONITOR_HOME);
  fs.symlinkSync(c.snapshot, path.join(f.env.HERDR_MONITOR_HOME, 'current'));
  assert.equal(f.prune().kept[0].reason, 'active release');
  fs.unlinkSync(path.join(c.snapshot, '.release-commit'));
  assert.throws(() => f.prune(), /cannot identify active release/);
  assert.ok(fs.existsSync(c.snapshot));
  fs.writeFileSync(path.join(c.snapshot, '.release-commit'), '');
  assert.throws(() => f.prune(), /invalid commit marker/);
  assert.throws(() => f.prune({ activeTag: 'typo' }), /recorded candidate/);
});

test('pruning retains logs, receipts, build evidence and external evidence while dropping dependencies', t => {
  const f = fixture(t), c = f.add(), release = path.dirname(path.dirname(c.snapshot));
  for (const [name, bytes] of [['.release-build.json', '{"offline":true}'], ['gate.log', 'log'], ['receipt.json', '{"result":"failed"}'], ['evidence/screen.txt', 'proof'], ['node_modules/pkg/index.js', 'dependency'], ['node_modules/pkg/package.json', '{}'], ['.release-npm-cache/_logs/debug.log', 'npm log']]) {
    const file = path.join(c.snapshot, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  fs.mkdirSync(path.join(c.snapshot, 'node_modules/.bin'));
  fs.symlinkSync('../pkg/index.js', path.join(c.snapshot, 'node_modules/.bin/pkg'));
  fs.writeFileSync(path.join(release, 'RC-1.log'), 'external log');
  fs.writeFileSync(path.join(release, 'receipt-input.json'), 'external receipt');
  fs.writeFileSync(path.join(c.snapshot, 'changed-receipt.json'), '{"new":true}');
  const before = fs.readFileSync(path.join(c.snapshot, '.release-build.json'));
  const result = f.prune(), evidence = result.removed[0].evidence;
  assert.deepEqual(fs.readFileSync(path.join(evidence, '.release-build.json')), before);
  for (const name of ['gate.log', 'receipt.json', 'evidence/screen.txt', '.release-npm-cache/_logs/debug.log']) assert.ok(fs.existsSync(path.join(evidence, name)));
  assert.equal(fs.existsSync(path.join(evidence, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(evidence, 'historical.log')), false, 'unchanged historical logs survive in the tag without duplication');
  assert.equal(f.git(['show', `${c.tag}:historical.log`]), 'already in Git');
  assert.equal(fs.readFileSync(path.join(evidence, 'changed-receipt.json'), 'utf8'), '{"new":true}');
  assert.equal(result.removed[0].unchanged_evidence_in_tag, 1);
  assert.equal(fs.readFileSync(path.join(release, 'RC-1.log'), 'utf8'), 'external log');
  assert.equal(fs.readFileSync(path.join(release, 'receipt-input.json'), 'utf8'), 'external receipt');
  assert.equal(fs.existsSync(c.snapshot), false);
});

for (const mode of ['outside', 'snapshot-link', 'root-link', 'nested-link', 'marker-link', 'marker-mismatch', 'tag-moved', 'evidence-link', 'receipt-link', 'evidence-conflict']) test(`retention refuses ${mode} without deleting the snapshot or foreign files`, t => {
  const f = fixture(t), c = f.add(), outside = path.join(f.repo, 'foreign');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'precious'), 'keep');
  const root = path.dirname(c.snapshot), release = path.dirname(root), original = c.snapshot;
  if (mode === 'outside') c.snapshot = outside;
  if (mode === 'snapshot-link') { fs.renameSync(c.snapshot, `${c.snapshot}.saved`); fs.symlinkSync(outside, c.snapshot); }
  if (mode === 'root-link') { fs.renameSync(root, `${root}.saved`); fs.symlinkSync(outside, root); }
  if (mode === 'nested-link') fs.symlinkSync(outside, path.join(c.snapshot, 'evidence'));
  if (mode === 'marker-link') { fs.unlinkSync(path.join(c.snapshot, '.release-commit')); fs.symlinkSync(path.join(outside, 'precious'), path.join(c.snapshot, '.release-commit')); }
  if (mode === 'marker-mismatch') fs.writeFileSync(path.join(c.snapshot, '.release-commit'), 'b'.repeat(40));
  if (mode === 'tag-moved') f.git(['tag', '-d', c.tag]);
  if (mode === 'evidence-link') fs.symlinkSync(outside, path.join(release, 'evidence'));
  if (mode === 'receipt-link') fs.symlinkSync(path.join(outside, 'precious'), path.join(release, 'retention.jsonl'));
  if (mode === 'evidence-conflict') {
    fs.mkdirSync(path.join(release, 'evidence', c.tag), { recursive: true });
    fs.writeFileSync(path.join(release, 'evidence', c.tag, '.release-commit'), 'different');
  }
  assert.equal(f.prune({ dryRun: true }).refused.length, 1, 'preview reports the same safety refusal');
  assert.equal(f.prune().refused.length, 1);
  assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'keep');
  if (mode !== 'root-link') assert.ok(fs.lstatSync(original));
});

test('unrecorded directories and partial extraction stay untouched', t => {
  const f = fixture(t), c = f.add();
  for (const name of ['unknown', `${c.tag}.partial`]) fs.mkdirSync(path.join(path.dirname(c.snapshot), name));
  const foreign = { ...c, identity: path.join(f.repo, 'foreign-git') };
  f.candidates.push(foreign);
  const result = f.prune();
  assert.equal(result.removed.length, 1);
  for (const name of ['unknown', `${c.tag}.partial`]) assert.ok(fs.existsSync(path.join(path.dirname(c.snapshot), name)));
});
