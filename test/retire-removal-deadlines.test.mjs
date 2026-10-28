import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, isolatedEnv } from './helpers/retire-fixture.mjs';
import { sweepCommands } from './helpers/retire-sweep-fixture.mjs';
import { createHousekeeping } from '../housekeeping/housekeeping.mjs';

function clock(t, load = 0) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(os, 'loadavg', () => [load, load, load]);
  t.mock.method(os, 'availableParallelism', () => 4);
  return { now: () => now, advance: ms => { now += ms; } };
}

function dependencies(f, count = 3000) {
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\nnode_modules/\n.lane/\n');
  fs.mkdirSync(path.join(f.lane, 'node_modules'));
  for (let index = 0; index < count; index++) fs.writeFileSync(path.join(f.lane, `node_modules/file-${index}`), 'rebuildable');
}

const removing = (exe, args) => exe === 'git' && args[2] === 'worktree' && args[3] === 'remove';
const deletingBranch = (exe, args) => exe === 'git' && args[2] === 'branch' && args[3] === '-D';
const timeout = () => ({ status: null, stdout: '', stderr: '', error: Object.assign(Error('injected deletion timeout'), { code: 'ETIMEDOUT' }) });

function commands(f, { before = () => {}, after = () => {} } = {}) {
  const native = sweepCommands(f).command, calls = [];
  return { calls, command(exe, args, options) {
    calls.push({ exe, args, timeout: options.timeout, locked: fs.existsSync(path.join(f.common, 'lane-promote.lock')) });
    const result = before(exe, args, options) ?? native(exe, args, options);
    after(exe, args, options, result);
    return result;
  } };
}

function slowDeletion(time, worktreeMs = 45000, branchMs = 20000) {
  return {
    before(exe, args, options) {
      const duration = removing(exe, args) ? worktreeMs : deletingBranch(exe, args) ? branchMs : 0;
      if (options.timeout < duration) return timeout();
    },
    after(exe, args) {
      if (removing(exe, args)) time.advance(worktreeMs);
      if (deletingBranch(exe, args)) time.advance(branchMs);
    },
  };
}

function sweep(f, time, adapter = commands(f), log = () => {}, budget = 120000) {
  const logs = [];
  const retirement = f.retirement({ command: adapter.command, deadline: time.now() + budget,
    log: row => { logs.push(row); log(row); } });
  return { results: retirement.sweepIntegratedLanes(), logs, calls: adapter.calls };
}

test('thousands of ignored dependency files get an inventory-sized removal allowance and a separate branch allowance', t => {
  const f = fixture(t, { occupied: false }), time = clock(t);
  dependencies(f);
  const result = sweep(f, time, commands(f, slowDeletion(time)));
  assert.equal(result.results[0].action, 'lane-removed', JSON.stringify(result.results));
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  const proof = result.results[0].evidence, saved = JSON.parse(fs.readFileSync(proof.manifest));
  assert.equal(saved.entries.length, 3001, 'all disposable files and their directory are inventoried');
  assert.ok(saved.entries.every(entry => entry.metadataOnly));
  assert.deepEqual(fs.readdirSync(path.join(proof.directory, 'files')), []);
  const removal = result.calls.find(row => removing(row.exe, row.args));
  assert.equal(removal.timeout, 30000 + (saved.entries.length + 1) * 10, 'the tracked seed file also needs deletion');
  assert.ok(removal.timeout > 45000 && removal.timeout < 120000);
  assert.equal(removal.locked, true);
  assert.equal(removal.args.includes('--force'), false);
  assert.equal(result.calls.find(row => deletingBranch(row.exe, row.args)).timeout, 30000);
  assert.ok(result.calls.filter(row => row.exe === 'git' && row.args.includes('rev-parse')).every(row => row.timeout <= 10000));
  assert.deepEqual(fs.readFileSync(f.eventFile), Buffer.from(f.eventBytes));
});

test('a pass with 30 seconds left defers before worktree removal and replans successfully', t => {
  const f = fixture(t, { occupied: false }), time = clock(t);
  dependencies(f);
  const result = sweep(f, time, commands(f), row => { if (row.action === 'lane-preflight') time.advance(90000); });
  assert.equal(result.results[0].action, 'deferred', JSON.stringify(result.results));
  assert.equal(result.results[0].why, 'removal needs 61 s; pass has 30 s');
  assert.equal(result.calls.some(row => removing(row.exe, row.args) || deletingBranch(row.exe, row.args)), false);
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(f.git(['rev-parse', 'refs/heads/lane/topic']), f.head);
  assert.equal(fs.readdirSync(path.join(f.lane, 'node_modules')).length, 3000);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-promote.lock')), false);
  const proof = result.logs.find(row => row.action === 'lane-preflight').evidence;
  assert.equal(fs.existsSync(proof.directory), false, 'only the duplicate evidence copy is discarded');
  assert.equal(sweep(f, time, commands(f, slowDeletion(time))).results[0].action, 'lane-removed');
  assert.deepEqual(fs.readFileSync(f.eventFile), Buffer.from(f.eventBytes));
});

test('a pass with 80 seconds left completes both commands when worktree removal leaves the branch allowance', t => {
  const f = fixture(t, { occupied: false }), time = clock(t);
  dependencies(f);
  const result = sweep(f, time, commands(f, slowDeletion(time)), row => { if (row.action === 'lane-preflight') time.advance(40000); });
  assert.equal(result.results[0].action, 'lane-removed', JSON.stringify(result.results));
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  assert.equal(result.calls.find(row => removing(row.exe, row.args)).timeout, 80000);
  assert.equal(result.calls.find(row => deletingBranch(row.exe, row.args)).timeout, 30000);
  assert.ok(result.calls.filter(row => removing(row.exe, row.args) || deletingBranch(row.exe, row.args)).every(row => row.locked));
  assert.equal(fs.existsSync(path.join(f.common, 'lane-promote.lock')), false);
  assert.deepEqual(fs.readFileSync(f.eventFile), Buffer.from(f.eventBytes));
});

test('a pass with 80 seconds left retains the exact branch and evidence when removal leaves less than 30 seconds', t => {
  const f = fixture(t, { occupied: false }), time = clock(t);
  dependencies(f);
  fs.mkdirSync(path.join(f.lane, '.lane'));
  fs.writeFileSync(path.join(f.lane, '.lane/report.md'), 'unique branch recovery evidence');
  const result = sweep(f, time, commands(f, slowDeletion(time, 55000)), row => { if (row.action === 'lane-preflight') time.advance(40000); });
  assert.equal(result.results[0].action, 'deferred', JSON.stringify(result.results));
  assert.equal(result.results[0].why, 'removal needs 30 s; pass has 25 s');
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['rev-parse', 'refs/heads/lane/topic']), f.head);
  assert.equal(result.calls.filter(row => removing(row.exe, row.args)).length, 1);
  assert.equal(result.calls.find(row => removing(row.exe, row.args)).timeout, 80000);
  assert.equal(result.calls.some(row => deletingBranch(row.exe, row.args)), false);
  const { action, ...proof } = result.logs.find(row => row.action === 'lane-preflight');
  const saved = path.join(proof.evidence.directory, 'files/.lane/report.md');
  assert.equal(fs.readFileSync(saved, 'utf8'), 'unique branch recovery evidence');
  assert.equal(result.logs.some(row => row.action === 'lane-evidence-discarded'), false);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-promote.lock')), false);
  const adapter = commands(f, slowDeletion(time)), logs = [];
  f.retirement({ command: adapter.command, deadline: time.now() + 120000, requireRecord: true,
    log: row => logs.push(row) }).resumeLaneRemoval(proof);
  assert.equal(adapter.calls.some(row => removing(row.exe, row.args)), false, 'recovery must not replay worktree removal');
  assert.equal(adapter.calls.filter(row => deletingBranch(row.exe, row.args)).length, 1);
  assert.equal(adapter.calls.find(row => deletingBranch(row.exe, row.args)).timeout, 30000);
  assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  assert.equal(logs.some(row => row.action === 'lane-removed' && row.reconciled), true);
  assert.equal(fs.readFileSync(saved, 'utf8'), 'unique branch recovery evidence');
  assert.equal(fs.existsSync(path.join(f.common, 'lane-promote.lock')), false);
  assert.deepEqual(fs.readFileSync(f.eventFile), Buffer.from(f.eventBytes));
});

test('removal and branch command allowances stay capped under load and fit inside the finite pass', t => {
  const f = fixture(t, { occupied: false }), time = clock(t, 400);
  const result = sweep(f, time, commands(f, slowDeletion(time, 590000, 59000)), () => {}, 700000);
  assert.equal(result.results[0].action, 'lane-removed', JSON.stringify(result.results));
  assert.equal(result.calls.find(row => removing(row.exe, row.args)).timeout, 600000);
  assert.equal(result.calls.find(row => deletingBranch(row.exe, row.args)).timeout, 60000);
  assert.ok(result.calls.filter(row => row.exe === 'git').every(row => row.timeout > 0 && row.timeout <= 700000));
});

test('a partial timed-out deletion keeps the verified snapshot and branch and can be replanned', t => {
  const f = fixture(t, { occupied: false }), time = clock(t);
  dependencies(f, 2);
  fs.mkdirSync(path.join(f.lane, '.lane'));
  fs.writeFileSync(path.join(f.lane, '.lane/report.md'), 'unique recovery evidence');
  const result = sweep(f, time, commands(f, { before(exe, args, options) {
    if (removing(exe, args)) {
      fs.unlinkSync(path.join(f.lane, 'node_modules/file-0'));
      time.advance(options.timeout);
      return timeout();
    }
  } }));
  assert.equal(result.results[0].action, 'deferred', JSON.stringify(result.results));
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(f.git(['rev-parse', 'refs/heads/lane/topic']), f.head);
  assert.equal(result.calls.some(row => deletingBranch(row.exe, row.args)), false);
  const proof = result.logs.find(row => row.action === 'lane-preflight').evidence;
  assert.equal(fs.readFileSync(path.join(proof.directory, 'files/.lane/report.md'), 'utf8'), 'unique recovery evidence');
  assert.equal(result.logs.some(row => row.action === 'lane-evidence-discarded'), false);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-promote.lock')), false);
  assert.equal(sweep(f, time).results[0].action, 'lane-removed');
  assert.equal(fs.readFileSync(path.join(proof.directory, 'files/.lane/report.md'), 'utf8'), 'unique recovery evidence');
});

test('housekeeping gives the guarded sweep enough time for slow dependency and branch deletion', t => {
  const f = fixture(t, { occupied: false }); isolatedEnv(t, f);
  const time = clock(t), logs = [];
  dependencies(f);
  const adapter = commands(f, slowDeletion(time));
  const housekeeping = createHousekeeping({ cwd: f.repo, org: f.org, herdr: f.job.herdr, selfTab: null,
    command: adapter.command, log: row => logs.push(row) });
  housekeeping.tick({ cleanup: true, resume: false });
  assert.equal(fs.existsSync(f.lane), false, JSON.stringify(logs));
  assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  assert.equal(logs.filter(row => row.action === 'lane-removed').length, 1);
  assert.equal(logs.some(row => row.action === 'lane-sweep-failed' || row.action === 'deferred'), false);
  assert.equal(adapter.calls.find(row => removing(row.exe, row.args)).timeout, 60020);
  assert.deepEqual(fs.readFileSync(f.eventFile), Buffer.from(f.eventBytes));
});
