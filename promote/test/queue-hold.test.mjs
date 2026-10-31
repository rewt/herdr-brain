import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueFor, enqueue } from '../promote.mjs';
import { OPERATOR_LANDING_WAIVER } from '../../lib/validation-declaration.mjs';
import { fixtureEnvironment } from '../../test/helpers/fixture-environment.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { healthyMemoryEnvironment } from '../../test/helpers/promotion-memory-fixture.mjs';
import { commandAllowance } from '../../test/helpers/command-allowance.mjs';
import { recipientAgent } from '../../test/helpers/recipient-agent.mjs';
import { waitForInboxIdle } from '../../test/helpers/inbox.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));

function fixture(t, waived) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-hold-')));
  fixtureFleet(t, root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const env = healthyMemoryEnvironment(fixtureEnvironment());
  for (const key of Object.keys(env)) if (/^(LANE_|ORG_|HERDR_|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(key)) delete env[key];
  Object.assign(env, { HERDR_MONITOR_FLEET: process.env.HERDR_MONITOR_FLEET,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    SUPERVISOR_INPUT_WAIT_SECONDS: '10', SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.001', SUPERVISOR_INPUT_POLL_SECONDS: '0.001' });
  const exec = (file, args, cwd = repo) => spawnSync(file, args, {
    cwd, env, encoding: 'utf8', [commandAllowance]: 60000,
  });
  const git = (args, cwd = repo) => {
    const result = exec('git', args, cwd);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-qb', 'main']);
  git(['config', 'user.name', 'Queue hold']);
  git(['config', 'user.email', 'queue-hold@example.invalid']);
  const counts = path.join(root, 'checks'), checker = path.join(root, 'check.cjs');
  fs.writeFileSync(checker, `require('fs').appendFileSync(${JSON.stringify(counts)}, 'gate\\n');console.log('# tests 1\\n# pass 1');`);
  fs.writeFileSync(path.join(repo, '.lane.validation.json'), JSON.stringify({
    promotion: `${process.execPath} ${checker}`, ...(waived ? { landing_waiver: OPERATOR_LANDING_WAIVER } : {}),
  }));
  fs.writeFileSync(path.join(repo, 'base'), 'base');
  git(['add', '.']); git(['commit', '-qm', 'Base']);
  const herdr = path.join(root, 'herdr'), notices = path.join(root, 'notices');
  fs.writeFileSync(herdr, `#!${process.execPath}
const fs=require('fs'),a=process.argv.slice(2);
if(a[0]==='agent'&&a[1]==='prompt')fs.appendFileSync(${JSON.stringify(notices)},JSON.stringify(a)+'\\n');
if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:${JSON.stringify(recipientAgent('test', repo, { pane_id: 'fake', terminal_id: path.join(root, 'recipient-terminal') }))}}}));
else if(a[0]==='pane'&&a[1]==='read')console.log('────────────────────\\n❯ \\n────────────────────');
else console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));`, { mode: 0o755 });
  const queue = queueFor(repo);
  const lane = topic => {
    const workspace = path.join(root, topic);
    git(['worktree', 'add', '-qb', `lane/${topic}`, workspace]);
    fs.writeFileSync(path.join(workspace, topic), topic);
    git(['add', '.'], workspace); git(['commit', '-qm', topic], workspace);
    return { topic, workspace, head: git(['rev-parse', 'HEAD'], workspace) };
  };
  const add = lane => enqueue(queue, [lane.topic], { to: 'test', herdr, attempts: 1, retry: 0,
    laneCLI: path.join(source, 'lanes/lane.mjs'), org: null, expectedHead: lane.head })[0];
  const drain = () => {
    const result = exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  t.after(async () => {
    await waitForInboxIdle(path.join(repo, '.git/supervisor/inbox.log'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, git, queue, lane, add, drain, counts };
}

for (const waived of [false, true])
test(`queued HOLD is a terminal refusal; clearing requires fresh requests (waived=${waived})`, t => {
  const f = fixture(t, waived), lanes = ['first', 'second'].map(f.lane);
  const jobs = lanes.map(f.add), before = f.git(['rev-parse', 'main']);
  const marker = path.join(f.repo, '.lane/supervisor/HOLD'), bytes = 'pause for proving\n';
  fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, bytes);
  f.drain();
  const refused = f.queue.load();
  assert.equal(refused.current, null); assert.deepEqual(refused.pending, []);
  assert.equal(refused.interrupted?.length ?? 0, 0);
  assert.deepEqual(refused.results.map(row => [row.id, row.outcome, row.code]),
    jobs.map(job => [job.id, 'refused', 'PROMOTION_HELD']));
  for (const row of refused.results) {
    assert.match(row.reason, /PROMOTION_HELD: supervisor HOLD exists; nothing merged/);
    const train = JSON.parse(fs.readFileSync(row.receipt, 'utf8'));
    assert.equal(train.phase, 'complete'); assert.deepEqual(train.attempts, []);
  }
  for (const lane of lanes) {
    assert.equal(f.git(['rev-parse', 'HEAD'], lane.workspace), lane.head);
    assert.equal(f.git(['branch', '--show-current'], lane.workspace), `lane/${lane.topic}`);
    assert.equal(f.git(['status', '--porcelain'], lane.workspace), '');
  }
  assert.equal(f.git(['rev-parse', 'main']), before);
  assert.equal(fs.readFileSync(marker, 'utf8'), bytes);
  assert.equal(fs.existsSync(f.counts), false, 'HOLD starts no validation');
  for (const lock of ['lane-promote.lock', 'promote/worker.lock', 'promote/queue.lock'])
    assert.equal(fs.existsSync(path.join(f.repo, '.git', lock)), false);

  fs.unlinkSync(marker);
  f.drain();
  assert.deepEqual(f.queue.load().results, refused.results, 'clearing cannot replay terminal requests');
  assert.equal(f.git(['rev-parse', 'main']), before);
  assert.equal(fs.existsSync(f.counts), false);

  const fresh = lanes.map(f.add);
  for (let i = 0; i < jobs.length; i++) assert.notEqual(fresh[i].id, jobs[i].id);
  f.drain();
  const recovered = f.queue.load();
  assert.deepEqual(recovered.results.slice(0, jobs.length), refused.results, 'original refusals remain immutable');
  assert.deepEqual(recovered.results.slice(jobs.length).map(row => [row.id, row.outcome]),
    fresh.map(job => [job.id, 'promoted']));
  assert.equal(recovered.current, null); assert.deepEqual(recovered.pending, []);
  for (const lane of lanes) assert.equal(fs.readFileSync(path.join(f.repo, lane.topic), 'utf8'), lane.topic);
  assert.equal(f.git(['rev-list', '--merges', 'main']), '');
  assert.equal(fs.existsSync(f.counts), !waived);
  if (!waived) assert.equal(fs.readFileSync(f.counts, 'utf8'), 'gate\n', 'one fresh batch validation');
});
