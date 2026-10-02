import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROUTE_PRESET } from '../../lanes/preset.mjs';
import { fixture } from './fixture.mjs';

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
  assert.equal(settled.validation.exit_code, 0);
  assert.equal(workerPrompts(f).length, 0);
  const job = receipt(f, run);
  const routes = JSON.parse(fs.readFileSync(job.routeConfig, 'utf8'));
  assert.ok(routes.routes.review);
  assert.equal(Object.hasOwn(routes, 'settle'), false);
  assert.equal(job.laneConfig, null);
});

test('relative LANE_CONFIG uses the intake file for lane validation and canonical review', (t) => {
  const f = fixture(t, { actor: 'settle-relative-config-test' });
  const file = selectedConfig(f);
  f.env.LANE_CONFIG = path.relative(f.repo, file);
  assert.equal(fs.existsSync(path.join(f.workspace, f.env.LANE_CONFIG)), false);
  const run = f.start(); f.commit('correct\n'); f.report(run);
  const settled = result(f.settle(run));
  assert.equal(settled.result, 'promotable');
  assert.equal(settled.review.verdict, 'PASS');
  assert.equal(settled.validation.exit_code, 0);
  assert.equal(receipt(f, run).laneConfig, file);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace, '.lane', 'gate.json'), 'utf8')).command, 'node --test test.mjs');
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
  assert.equal(before.green, true);
  assert.equal(before.laneConfig, file);
  fs.unlinkSync(path.join(f.root, 'review-fail'));
  // Neither the new invocation's config nor a same-named file in the linked
  // worktree may replace the configuration accepted at intake.
  const decoy = path.join(f.workspace, '.lane', 'selected config.json');
  fs.writeFileSync(decoy, JSON.stringify({ main: 'missing', validate: 'false' }));
  f.env.LANE_CONFIG = 'missing-config.json';
  const cwd = path.join(f.workspace, 'nested'); fs.mkdirSync(cwd);
  const settled = result(f.exec(process.execPath, [path.join(f.source, 'settle/settle.mjs'), run,
    '--retry', '--review-again', '--repo', f.repo, '--org', f.org], cwd));
  assert.equal(settled.result, 'promotable');
  assert.equal(settled.review.verdict, 'PASS');
  assert.equal(settled.validation.exit_code, 0);
  const after = receipt(f, run);
  assert.equal(after.laneConfig, file);
  assert.equal(after.routeConfig, before.routeConfig);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace, '.lane', 'gate.json'), 'utf8')).command, 'node --test test.mjs');
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
  assert.equal(settled.validation.exit_code, 0);
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
  assert.equal(settled.validation.exit_code, 0);
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
  assert.equal(result(f.settle(run)).result, 'promotable');
  const job = receipt(f, run);
  assert.equal(job.reviewRoute, 'review-codex'); assert.equal(job.fixRoute, 'engineer-xhigh'); assert.equal(job.timeout, 15); assert.equal(job.reuse, false); assert.equal(job.to, 'project-supervisor');
  assert.equal(job.reviewPolicy.cap, 2); assert.equal(job.reviewPolicy.source, 'project');
});
