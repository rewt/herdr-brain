import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROUTE_PRESET } from '../../lanes/preset.mjs';
import { fixture } from './fixture.mjs';
import { DESK_DEFAULTS } from '../config.mjs';
import { configFixture } from '../../test/helpers/config-home-fixture.mjs';
import { policyLocation, readConfigJSON } from '../../lib/config-home.mjs';
import { spawnSync } from 'node:child_process';

const result = (r) => {
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
};
const receipt = (f, run) => JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${run}.json`), 'utf8'));
const workerPrompts = (f) => f.calls().filter((args) => args[0] === 'agent' && args[1] === 'prompt' && args[3].startsWith('You are run '));
function selectedConfig(f) {
  const file = path.join(f.repo, '.lane', 'selected config.json');
  const config = structuredClone(ROUTE_PRESET);
  config.validate = 'node --test test.mjs';
  config.routes.review.model = 'selected-review-model';
  config.settle = { review_route: 'review', timeout: 12 };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

test('a project with only settle settings and no parent routes completes independent review', (t) => {
  const f = fixture(t, { actor: 'settle-settings-test' });
  assert.equal(fs.existsSync(path.join(f.root, '.lane.json')), false);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ settle: { review_route: 'review', timeout: 12 } }));
  f.git(['add', '.lane.json']); f.git(['commit', '-qm', 'Configure settlement only']);
  f.git(['rebase', 'main'], f.workspace);
  const run = f.start(); f.commit('correct\n'); f.report(run);
  const settled = result(f.settle(run));
  assert.equal(settled.result, 'promotable');
  assert.equal(settled.review.verdict, 'PASS');
  assert.equal(settled.validation.executed, false);
  assert.equal(workerPrompts(f).length, 0);
  const job = receipt(f, run);
  assert.equal(DESK_DEFAULTS.review_round_cap, 3);
  assert.deepEqual(job.reviewPolicy, { cap: 3, source: 'default', round: 1, prior_runs: [] });
  const routes = JSON.parse(fs.readFileSync(job.routeConfig, 'utf8'));
  assert.ok(routes.routes.review);
  assert.equal(Object.hasOwn(routes, 'settle'), false);
  assert.equal(job.laneConfig, null);
});

test('a project with an explicit zero review cap keeps unlimited semantics', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ settle: { review_round_cap: 0 } }));
  f.git(['add', '.lane.json']); f.git(['commit', '-qm', 'Explicit unlimited reviews']);
  f.git(['rebase', 'main'], f.workspace);
  const run = f.start(); f.commit('correct\n'); f.report(run);
  assert.equal(result(f.settle(run)).review_policy.cap, 0);
  assert.equal(receipt(f, run).reviewPolicy.source, 'project');
});

for (const standalone of [false, true]) test(`settle intake accepts a ${standalone ? 'standalone-only' : 'home identity'} desk route and holds unknown hand edits`, async t => {
  const f = configFixture(t, { routing: standalone }); await f.adopt();
  const lane = policyLocation(f.cwd, 'lane').file;
  const routeFile = standalone ? policyLocation(f.cwd, 'routing').file : f.binding().identityFile;
  const route = standalone ? 'standalone-only' : 'identity-reviewer';
  const routes = readConfigJSON(routeFile);
  routes.routes[route] = { kind: 'codex', model: 'selected-desk-model' };
  if (!standalone) routes.settle = { review_route: 'review', timeout: 17, reuse: true };
  fs.writeFileSync(routeFile, JSON.stringify(routes));
  const config = readConfigJSON(lane);
  config.settle = { review_route: route, fix_route: 'engineer', timeout: 12 };
  fs.writeFileSync(lane, JSON.stringify(config));
  const workspace = path.join(f.scratch, 'linked'); f.git('worktree', 'add', '-qb', 'lane/intake', workspace);
  const exec = (file, args) => spawnSync(process.execPath, [path.join(f.bundle, file), ...args], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  const record = args => { const r = exec('bin/org.mjs', args); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim(); };
  const start = () => {
    const item = record(['add', 'Exercise desk intake', '--role', 'engineer']).split(' ')[0];
    const run = record(['start', item, '--workspace', workspace, '--meta', 'lane=intake']).match(/R-\d+/)[0];
    record(['claim', run, '--controller', 'brain']);
    const report = JSON.parse(record(['show', run, '--json'])).report_path;
    // Stop after intake, before independent review or any native launch.
    fs.writeFileSync(report, `---\nrun: ${run}\noutcome: blocked\nsummary: Intake witness.\nblockers: ["Fixture stops before review"]\nproposals: []\n---\n`);
    return run;
  };
  const org = f.env.ORG_DIR, run = start();
  const settled = result(exec('settle/settle.mjs', [run, '--repo', f.cwd, '--org', org]));
  assert.equal(settled.result, 'escalate'); assert.match(settled.reason, /Worker reported blocked/);
  const job = receipt({ org }, run);
  assert.equal(job.reviewRoute, route); assert.equal(job.fixRoute, 'engineer'); assert.equal(job.main, 'main');
  assert.equal(job.timeout, 12); assert.equal(job.reuse, false, 'project desk object replaces identity defaults');
  assert.equal(readConfigJSON(job.routeConfig).routes[route].model, 'selected-desk-model');
  const next = start();
  config.settle.review_route = 'unknown-hand-edit'; fs.writeFileSync(lane, JSON.stringify(config));
  const refused = exec('settle/settle.mjs', [next, '--repo', f.cwd, '--org', org, '--review-route', 'review']);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /unknown route: unknown-hand-edit/);
  assert.equal(fs.existsSync(path.join(org, 'settle', `${next}.json`)), false);
});

test('relative LANE_CONFIG uses the intake file for canonical review without running validation', (t) => {
  const f = fixture(t, { actor: 'settle-relative-config-test' });
  const file = selectedConfig(f);
  f.env.LANE_CONFIG = path.relative(f.repo, file);
  assert.equal(fs.existsSync(path.join(f.workspace, f.env.LANE_CONFIG)), false);
  const run = f.start(); f.commit('correct\n'); f.report(run);
  const settled = result(f.settle(run));
  assert.equal(settled.result, 'promotable');
  assert.equal(settled.review.verdict, 'PASS');
  assert.equal(settled.validation.executed, false);
  assert.equal(receipt(f, run).laneConfig, file);
  assert.equal(fs.existsSync(path.join(f.workspace, '.lane', 'gate.json')), false);
  assert.equal(f.show(f.show(run).item).runs.length, 1);
  assert.equal(workerPrompts(f).length, 0);
});

test('review retry from another checkout retains the selected absolute config and effective routes', (t) => {
  const f = fixture(t, { actor: 'settle-config-retry-test' });
  const file = selectedConfig(f);
  f.env.LANE_CONFIG = path.relative(f.repo, file);
  const run = f.start(); f.commit('correct\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'review-fail'), '');
  const interrupted = f.settle(run);
  assert.equal(interrupted.status, 1);
  const before = receipt(f, run);
  assert.equal(before.stage, 'reviewing');
  assert.equal(before.validation.executed, false);
  assert.equal(before.laneConfig, file);
  fs.unlinkSync(path.join(f.root, 'review-fail'));
  // Neither the new invocation's config nor a same-named file in the linked
  // worktree may replace the configuration accepted at intake.
  const decoy = path.join(f.workspace, '.lane', 'selected config.json');
  fs.mkdirSync(path.dirname(decoy), { recursive: true });
  fs.writeFileSync(decoy, JSON.stringify({ main: 'missing', validate: 'false' }));
  f.env.LANE_CONFIG = 'missing-config.json';
  const cwd = path.join(f.workspace, 'nested'); fs.mkdirSync(cwd);
  const settled = result(f.exec(process.execPath, [path.join(f.source, 'settle/settle.mjs'), run,
    '--retry', '--review-again', '--repo', f.repo, '--org', f.org], cwd));
  assert.equal(settled.result, 'promotable');
  assert.equal(settled.review.verdict, 'PASS');
  assert.equal(settled.validation.executed, false);
  const after = receipt(f, run);
  assert.equal(after.laneConfig, file);
  assert.equal(after.routeConfig, before.routeConfig);
  assert.equal(fs.existsSync(path.join(f.workspace, '.lane', 'gate.json')), false);
  const starts = f.calls().filter((args) => args[0] === 'agent' && args[1] === 'start');
  assert.equal(starts.length, 2);
  for (const args of starts) assert.equal(args[args.indexOf('--model') + 1], 'selected-review-model');
  assert.equal(workerPrompts(f).length, 0);
  assert.equal(f.show(f.show(run).item).runs.length, 1);
});

test('relative LANE_CONFIG resolves from the invoking directory even with --repo elsewhere', (t) => {
  const f = fixture(t, { actor: 'settle-config-caller-test' });
  const file = selectedConfig(f);
  const cwd = path.join(f.workspace, 'nested'); fs.mkdirSync(cwd);
  f.env.LANE_CONFIG = path.relative(cwd, file);
  const run = f.start(); f.commit('correct\n'); f.report(run);
  const settled = result(f.exec(process.execPath, [path.join(f.source, 'settle/settle.mjs'), run,
    '--repo', f.repo, '--org', f.org], cwd));
  assert.equal(settled.result, 'promotable');
  assert.equal(receipt(f, run).laneConfig, file);
  assert.equal(settled.validation.executed, false);
  assert.equal(workerPrompts(f).length, 0);
});

test('a review retry retains discovery when the new invocation sets LANE_CONFIG', (t) => {
  const f = fixture(t, { actor: 'settle-discovery-retry-test' });
  const run = f.start(); f.commit('correct\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'review-fail'), '');
  assert.equal(f.settle(run).status, 1);
  assert.equal(receipt(f, run).laneConfig, null);
  fs.unlinkSync(path.join(f.root, 'review-fail'));
  f.env.LANE_CONFIG = 'missing-config.json';
  const settled = result(f.retry(run, ['--review-again']));
  assert.equal(settled.result, 'promotable');
  assert.equal(settled.validation.executed, false);
  assert.equal(receipt(f, run).laneConfig, null);
  assert.equal(workerPrompts(f).length, 0);
});

test('CLI desk overrides are consumed by settle without adopting routes or losing lifecycle settings', (t) => {
  const f = fixture(t, { actor: 'settle-cli-desks-test' });
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ main: 'main', validate: 'node --test test.mjs' }));
  const configured = f.exec(process.execPath, [path.join(f.source, 'bin/org.mjs'), 'desks', 'set', '--review-route=review-codex', '--fix-route=engineer-xhigh', '--timeout=15', '--review-round-cap=2', '--reuse=false', '--to=project-supervisor']);
  assert.equal(configured.status, 0, configured.stderr);
  const own = JSON.parse(fs.readFileSync(path.join(f.repo, '.lane.json')));
  assert.equal(own.validate, 'node --test test.mjs'); assert.equal(Object.hasOwn(own, 'routes'), false);
  f.git(['add', '.lane.json']); f.git(['commit', '-qm', 'Configure desks through record CLI']); f.git(['rebase', 'main'], f.workspace);
  const run = f.start(); f.commit('correct\n'); f.report(run);
  const settled = f.settle(run);
  if (settled.status !== 0) {
    const log = path.join(f.org, 'settle', `${run}.review-r1.log`);
    assert.fail(`${settled.stderr || settled.stdout}\n${fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'No reviewer log was written'}`);
  }
  assert.equal(result(settled).result, 'promotable');
  const job = receipt(f, run);
  assert.equal(job.reviewRoute, 'review-codex'); assert.equal(job.fixRoute, 'engineer-xhigh'); assert.equal(job.timeout, 15); assert.equal(job.reuse, false); assert.equal(job.to, 'project-supervisor');
  assert.equal(job.reviewPolicy.cap, 2); assert.equal(job.reviewPolicy.source, 'project');
});
