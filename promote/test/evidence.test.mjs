import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { verifyTrainResult } from '../evidence.mjs';

function replay(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-evidence-')));
  fixtureFleet(t, repo); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = args => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Train evidence']); git(['config', 'user.email', 'evidence@example.invalid']);
  fs.writeFileSync(path.join(repo, 'base'), 'base\n'); git(['add', '.']); git(['commit', '-qm', 'Base']);
  git(['switch', '-qc', 'lane/renderer']); fs.writeFileSync(path.join(repo, 'renderer'), 'width = 121\n');
  git(['add', '.']); git(['commit', '-qm', 'Reviewed renderer']); const source = git(['rev-parse', 'HEAD']);
  git(['switch', '-q', 'main']); fs.writeFileSync(path.join(repo, 'upstream'), 'new main\n');
  git(['add', '.']); git(['commit', '-qm', 'Advance main']); const onto = git(['rev-parse', 'HEAD']);
  const tree = git(['merge-tree', '--write-tree', onto, source]);
  const tip = git(['commit-tree', tree, '-p', onto, '-m', 'Replay reviewed renderer']); git(['reset', '--hard', tip]);
  const identity = fs.realpathSync(path.join(repo, '.git')), directory = path.join(identity, 'promote/batches');
  fs.mkdirSync(directory, { recursive: true });
  const receipt = path.join(directory, 'batch.json'), log = path.join(directory, 'gate.log'), text = 'both required checks passed\n';
  fs.writeFileSync(log, text);
  const requiredTests = ['deferred.test.mjs', 'test/board-view.test.mjs'];
  const saved = { head: source, run: 'R-1', org: path.join(repo, '.org'), lane: 'renderer', requiredTests,
    test_evidence: { reexecuted: false, files: [requiredTests[0]] } };
  const job = { id: 'job', expectedHead: source, run: saved.run, org: saved.org, topic: saved.lane, requiredTests };
  const plan = { schema: 'promotion-train/v1', id: 'batch', identity, jobs: [job], attempts: [{
    phase: 'complete', base: onto, tip, tips: { job: tip }, jobs: [{ ...job, sourceHead: source }],
    gate: { exit_code: 0, signal: null, head: tip, tree, log,
      log_hash: createHash('sha256').update(JSON.stringify(text)).digest('hex') },
  }] };
  const result = { id: job.id, source_head: source, tip, batch: plan.id, receipt };
  const write = () => fs.writeFileSync(receipt, JSON.stringify(plan)); write();
  assert.notEqual(tip, source);
  return { project: { identity, canonical: repo }, saved, result, plan, write };
}

test('replayed green promotion verifies the saved union of deferred and component checks', t => {
  const f = replay(t), verify = saved => verifyTrainResult(f.result, { project: f.project, saved });
  assert.equal(verify(f.saved), true);
  assert.equal(verify({ ...f.saved, requiredTests: ['deferred.test.mjs'] }), false);
  f.plan.jobs[0].requiredTests = ['deferred.test.mjs']; f.write();
  assert.equal(verify(f.saved), false, 'a train missing the required component check cannot close promotion');
});

test('legacy receipts fall back to deferred evidence while explicit requirements survive reexecution', t => {
  const f = replay(t), verify = saved => verifyTrainResult(f.result, { project: f.project, saved });
  const { requiredTests, ...legacy } = f.saved;
  assert.equal(verify(legacy), false, 'legacy deferred evidence must still match the bound job');
  assert.equal(verify({ ...legacy, test_evidence: { reexecuted: false, files: requiredTests } }), true);
  assert.equal(verify({ ...f.saved, test_evidence: { reexecuted: true, files: ['deferred.test.mjs'] } }), true);
  f.plan.jobs[0].requiredTests = ['deferred.test.mjs']; f.write();
  assert.equal(verify({ ...f.saved, test_evidence: { reexecuted: true, files: [] } }), false);
});
