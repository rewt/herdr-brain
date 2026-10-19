// Disposable offline repos for the opt-in exact receipt contract.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtureFleet } from './offline-herdr.mjs';
import { promotionWorkers } from './promotion-worker.mjs';
import { waitForInboxIdle } from './inbox.mjs';
import { commandAllowance } from './command-allowance.mjs';
import { queueFor, enqueue } from '../../promote/promote.mjs';

export const source = fileURLToPath(new URL('../../', import.meta.url));
export function exactFixture(t, { declared = true, planner = true, prepare = [], layeredPromotion = false, requiredTests = [] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exact-validation-'))), repo = path.join(root, 'repo'), workspace = path.join(root, 'worker');
  fixtureFleet(t, root);
  fs.mkdirSync(repo);
  const config = path.join(root, 'config.json'); fs.writeFileSync(config, '{}');
  const env = { ...process.env, LANE_CONFIG: config, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', UNLISTED: 'must not reach children', EXACT_VALUE: 'one',
    SUPERVISOR_INPUT_WAIT_SECONDS: '10', SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.001', SUPERVISOR_INPUT_POLL_SECONDS: '0.001' };
  for (const name of Object.keys(env)) if (/^(LANE_VALIDATE|ORG_|HERDR_(PANE|TAB|WORKSPACE)_ID|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(name)) delete env[name];
  const workers = promotionWorkers(repo);
  const run = (file, args, cwd = repo, extra = {}) => {
    const result = spawnSync(file, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', [commandAllowance]: 60000 });
    let reply; try { reply = JSON.parse(result.stdout); } catch {}
    workers.remember(reply); return result;
  };
  const good = result => { assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout.trim(); };
  const git = (args, cwd = repo) => good(run('git', args, cwd));
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Exact fixture']); git(['config', 'user.email', 'exact@example.invalid']);
  const counts = path.join(root, 'checks'), selections = path.join(root, 'selections'), planned = path.join(root, 'planned');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.lane/\n');
  fs.writeFileSync(path.join(repo, '.lane.json'), JSON.stringify(prepare.length ? { prepare } : {}));
  const declaration = { schema: 'validation-receipts/v1', exclude: ['settle-review-document'], environment: ['PATH', 'HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'EXACT_VALUE'] };
  if (declared) fs.writeFileSync(path.join(repo, '.validation-receipts.json'), JSON.stringify(declaration));
  const command = `'${process.execPath}' check.cjs`;
  if (layeredPromotion) fs.writeFileSync(config, JSON.stringify({ validation: { promotion: command } }));
  fs.writeFileSync(path.join(repo, '.lane.validation.json'), JSON.stringify({ ...(layeredPromotion ? {} : { promotion: command }), ...(planner ? { promotion_tests: 'planner.mjs' } : {}) }));
  fs.writeFileSync(path.join(repo, 'check.cjs'), `const fs=require('fs');if(process.env.UNLISTED)throw Error('unlisted environment leaked');fs.appendFileSync(${JSON.stringify(counts)},'gate\\n');console.log('green');`);
  fs.writeFileSync(path.join(repo, 'planner.mjs'), `import fs from 'node:fs';
if(process.env.UNLISTED)throw Error('planner environment leaked');
if(process.argv[2]==='--plan'){
 const changed=JSON.parse(process.argv[3]);fs.appendFileSync(${JSON.stringify(planned)},JSON.stringify(changed)+'\\n');
 const required=JSON.parse(process.argv[5]);
 for(const file of required)if(!fs.existsSync(file))throw Error('required test file is missing: '+file);
 console.log(JSON.stringify({files:[...new Set([...required,'test/focus.test.mjs'])],unknown:changed.includes('unmapped')?['unmapped']:[]}));
}else fs.appendFileSync(${JSON.stringify(selections)},'selected\\n');`);
  for (const file of new Set(['test/focus.test.mjs', ...requiredTests])) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), '// offline planner selection fixture\n');
  }
  fs.writeFileSync(path.join(repo, 'work'), 'base'); git(['add', '.']); git(['commit', '-qm', 'Canonical base']);
  const base = git(['rev-parse', 'HEAD']);
  git(['worktree', 'add', '-qb', 'lane/topic', workspace]);
  fs.writeFileSync(path.join(workspace, 'work'), 'candidate'); git(['add', '.'], workspace); git(['commit', '-qm', 'Candidate'], workspace);
  const lane = (args = ['check', '--gate'], extra = {}) => run(process.execPath, [path.join(source, 'lanes/lane.mjs'), ...args], workspace, extra);
  const gate = () => JSON.parse(fs.readFileSync(path.join(workspace, '.lane/gate.json'), 'utf8'));
  const common = path.join(repo, '.git'), queue = queueFor(repo);
  const herdr = path.join(root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
const a=process.argv.slice(2);
if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake'}}}));
else if(a[0]==='pane'&&a[1]==='read')console.log('────────────────────\\n❯ \\n────────────────────');
else console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));`, { mode: 0o755 });
  const add = (topic = 'topic', options = {}) => enqueue(queue, [topic], { to: 'test', herdr, attempts: 1, retry: 0, laneCLI: path.join(source, 'lanes/lane.mjs'), org: null,
    laneConfig: config, validate: env.LANE_VALIDATE ?? null, expectedHead: git(['rev-parse', 'lane/' + topic]), ...options });
  const drain = () => run(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain']);
  const runs = () => fs.existsSync(counts) ? fs.readFileSync(counts, 'utf8').trim().split('\n').length : 0;
  const train = () => {
    const batch = queue.load().results.at(-1).batch;
    return JSON.parse(fs.readFileSync(path.join(queue.directory, 'batches', batch, 'train.json'), 'utf8'));
  };
  const commit = (name, value, cwd = workspace, mode) => {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), value);
    if (mode) fs.chmodSync(path.join(cwd, name), mode);
    git(['add', name], cwd); git(['commit', '-qm', 'Change ' + name], cwd);
  };
  t.after(async () => { await workers.wait(); await waitForInboxIdle(path.join(common, 'supervisor/inbox.log')); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, repo, workspace, common, env, base, declaration, command, counts, selections, planned, good, git, run, lane, gate, add, drain, runs, train, commit, queue };
}
