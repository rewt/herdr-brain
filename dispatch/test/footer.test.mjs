import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, promptCalls } from './dispatch-fixture.mjs';
import { configFixture } from '../../test/helpers/config-home-fixture.mjs';
import { policyLocation } from '../../lib/config-home.mjs';

function lanePolicy(f, change) {
  const file = path.join(f.repo, '.lane.json'), config = JSON.parse(fs.readFileSync(file));
  change(config); fs.writeFileSync(file, JSON.stringify(config));
}
function promotePolicy(f, value) {
  fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify(value));
  f.git(['add', '.promote.json']); f.git(['commit', '-qm', 'Project exception address']);
}
function delivered(f, result, address) {
  assert.equal(result.status, 0, result.stderr);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0])), prompt = promptCalls(f)[0].a[3];
  assert.equal(job.exceptionAddress.to, address);
  assert.equal(job.to, job.worker.agentName);
  assert.ok(prompt.includes(`watcher targets ${job.worker.agentName}`));
  assert.ok(prompt.includes(`Use --to ${job.worker.agentName} for your ordinary`));
  if (address) assert.ok(prompt.includes(`your PROJECT SUPERVISOR at ${JSON.stringify(address)}`));
  else assert.match(prompt, /project-specific exception address is UNKNOWN/);
  assert.doesNotMatch(prompt, /use check without --cmd|default test command without configuration/);
  assert.match(prompt, /If no check is selected or applicable, report the selection\/scope and unrun truth/);
  assert.match(prompt, /do not substitute a blanket default\/fast\/npm suite or label unrun checks PASS/);
  assert.equal(f.show(job.run).meta.agent, job.worker.agentName);
  return { job, prompt };
}

test('dispatch footer respects the explicit parent address over child env and project promote.to', t => {
  const f = fixture(t, { noticeRecipient: 'ops-explicit' });
  lanePolicy(f, config => { config.dispatch = { env: ['MONITOR_SUPERVISOR_AGENT=ops-child'] }; });
  promotePolicy(f, { to: 'ops-project' });
  const { job } = delivered(f, f.start(), 'ops-explicit');
  assert.equal(job.exceptionAddress.source, 'parent MONITOR_SUPERVISOR_AGENT');
});

for (const routeOverride of [false, true]) test(`dispatch footer resolves effective launch env (route override ${routeOverride})`, t => {
  const f = fixture(t);
  lanePolicy(f, config => {
    config.dispatch = { env: ['MONITOR_SUPERVISOR_AGENT=ops-default'] };
    if (routeOverride) config.routes.engineer.env = ['MONITOR_SUPERVISOR_AGENT=ops-route'];
  });
  promotePolicy(f, { to: 'ops-project' });
  const { job } = delivered(f, f.start(), routeOverride ? 'ops-route' : 'ops-default');
  assert.equal(job.exceptionAddress.source, 'effective launch MONITOR_SUPERVISOR_AGENT');
});

test('dispatch footer uses committed target project promote.to when launch address is empty', t => {
  const f = fixture(t);
  lanePolicy(f, config => { config.dispatch = { env: ['MONITOR_SUPERVISOR_AGENT='] }; });
  promotePolicy(f, { to: 'ops-project' });
  const { job } = delivered(f, f.start(), 'ops-project');
  assert.equal(job.exceptionAddress.source, 'project promote.to');
});

for (const invalid of [false, true]) test(`dispatch footer reports unknown address without a readiness gate (invalid policy ${invalid})`, t => {
  const f = fixture(t);
  if (invalid) promotePolicy(f, { to: 42 });
  else fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ to: 'uncommitted-foreign-address' }));
  const { job, prompt } = delivered(f, f.start(), null);
  assert.equal(job.exceptionAddress.source, 'unknown');
  assert.doesNotMatch(prompt, /supervisor-herdr|uncommitted-foreign-address/);
  assert.ok(job.exceptionAddress.reason);
});

for (const withEnv of [false, true]) test(`dispatch footer reads effective adopted home policy (launch env ${withEnv})`, async t => {
  const project = configFixture(t);
  const lane = path.join(project.cwd, '.lane.json'), config = JSON.parse(fs.readFileSync(lane));
  if (withEnv) config.dispatch.env = ['MONITOR_SUPERVISOR_AGENT=ops-home-env'];
  fs.writeFileSync(lane, JSON.stringify(config));
  fs.writeFileSync(path.join(project.cwd, '.promote.json'), JSON.stringify({ to: 'ops-home-promote' }));
  project.git('add', '.lane.json', '.promote.json'); project.git('commit', '-qm', 'Home project addresses');
  await project.adopt();
  assert.equal(policyLocation(project.cwd, 'promote', project.env).home, true);
  const f = fixture(t, { project, sourceEntry: true });
  f.env.HERDR_BRAIN_ROOT = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const { job } = delivered(f, f.start(), withEnv ? 'ops-home-env' : 'ops-home-promote');
  if (!withEnv) assert.equal(job.exceptionAddress.file, policyLocation(f.repo, 'promote', f.env).file);
});

test('dispatch footer preserves saved exception address, worker recipient and runtime across retries', t => {
  const f = fixture(t, { noticeRecipient: 'ops-original' }); f.fail('watch');
  assert.equal(f.start().status, 1);
  const file = f.jobs()[0], before = JSON.parse(fs.readFileSync(file));
  f.env.MONITOR_SUPERVISOR_AGENT = 'ops-changed';
  f.env.HERDR_BRAIN_ROOT = f.repo; // A retry must keep the saved source, not select this root.
  f.fail('');
  const { job } = delivered(f, f.dispatch(['--retry', before.run]), 'ops-original');
  assert.deepEqual(job.release, before.release);
  assert.deepEqual(job.ownership, before.ownership);
  assert.equal(job.to, before.to);
  assert.deepEqual(job.worker, before.worker);
  const again = f.dispatch(['--retry', job.run]); assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).watcher, job.watcher);
  assert.equal(promptCalls(f).length, 1);
});

test('dispatch footer preserves explicit ask and extra check scope without prescribing a default suite', t => {
  const f = fixture(t), ask = '# Selected check\nRun only node test/helpers/run.mjs focused.test.mjs once.';
  fs.writeFileSync(f.brief, ask);
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ fast: 'npm run blanket-fast' }));
  const extra = 'Selected footer check only; no baseline or full suite.';
  const { prompt } = delivered(f, f.start(['--extra', extra]), null);
  assert.ok(prompt.includes(extra)); assert.equal(fs.readFileSync(f.brief, 'utf8'), ask);
  assert.doesNotMatch(prompt, /npm run blanket-fast|Only when the ask names no test selection/);
  assert.match(prompt, /existing project runner and preserving file groups and limits/);
  assert.match(prompt, /one full final-release obligation stays with its release coordinator/);
});

test('dispatch operator inbox producer guidance pins its source command and preserves internal callbacks', t => {
  const f = fixture(t), { job, prompt } = delivered(f, f.start(), null);
  const source = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  assert.deepEqual(job.operatorRecordCommand, [process.execPath, path.join(source, 'bin/org.mjs')]);
  assert.match(prompt, /For OPERATOR-addressed status\/fyi\/done\/questions/);
  assert.ok(prompt.includes(`ORG_ACTOR='${job.worker.agentName}'`));
  assert.ok(prompt.includes(`'${path.join(source, 'bin/org.mjs')}' messages send`));
  assert.ok(prompt.includes(`--id '${job.run}:operator:STABLE_NOTICE_ID'`));
  assert.match(prompt, /Pull messages digest on demand/);
  assert.match(prompt, /record-only and never typed into an operator pane/);
  assert.match(prompt, /already explicitly operator_reserved/);
  assert.match(prompt, /Routine T2 questions do not become reserved/);
  assert.match(prompt, /Internal owned report\/watch callbacks and project T2\/BrainChat delivery retain their existing native paths and recipients; retain the watcher/);
  assert.equal(promptCalls(f).length, 1);
  assert.equal(f.calls().filter(call => call.type === 'org' && call.a[0] === 'messages').length, 0, 'guidance never executes producer prose');
});

test('dispatch operator inbox producer guidance never upgrades an older saved request', t => {
  const f = fixture(t); f.fail('watch');
  assert.equal(f.start().status, 1);
  const file = f.jobs()[0], saved = JSON.parse(fs.readFileSync(file));
  delete saved.operatorRecordCommand;
  fs.writeFileSync(file, JSON.stringify(saved)); f.fail('');
  const { job, prompt } = delivered(f, f.dispatch(['--retry', saved.run]), null);
  assert.equal(job.operatorRecordCommand, undefined);
  assert.doesNotMatch(prompt, /For OPERATOR-addressed|messages send|messages digest/);
  assert.equal(promptCalls(f).length, 1); assert.equal(job.to, job.worker.agentName);
});
