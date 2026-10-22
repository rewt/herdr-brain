import test from '../../test/helpers/bounded-test.mjs';
import { configFixture } from '../../test/helpers/config-home-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publishProvingReservation, RESERVATION_WAIT_EXPIRED_CODE } from '../../test-slot/reservations.mjs';
import { readTiming, readAdmissionTiming } from '../../lib/run-timing.mjs';
import { policyLocation } from '../../lib/config-home.mjs';
import { fixture, promptCalls, unlandedSetting, pendingItem, until, pauseHook, admissionHook, admissionAttempts } from './dispatch-fixture.mjs';

const DISPATCH = fileURLToPath(new URL('../dispatch.mjs', import.meta.url));
const RECORD = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
const WATCH = fileURLToPath(new URL('../../watch/watch.mjs', import.meta.url));
function capSetting(f, cap) {
  const file = path.join(f.repo, '.lane.json'), config = JSON.parse(fs.readFileSync(file));
  config.dispatch = { ...config.dispatch, max_sessions: cap };
  fs.writeFileSync(file, JSON.stringify(config));
}
function occupiedRun(f, { project = f.git(['rev-parse', '--path-format=absolute', '--git-common-dir']), process: owner } = {}) {
  const run = f.rec(['start', f.item, '--workspace', f.repo, '--meta', `dispatch_project=${project}`]).match(/^(R-\d+) started/m)[1];
  f.rec(['worker', run, '--agent', `occupied-${run}`, '--pane', `p-${run}`, '--worker-workspace', 'w', '--terminal-id', `t-${run}`, '--cwd', f.repo]);
  if (owner) {
    fs.mkdirSync(path.join(f.org, 'dispatch'), { recursive: true });
    fs.writeFileSync(path.join(f.org, 'dispatch', `${run}.json`), JSON.stringify({ run, common: project, launchProcess: owner }));
  }
  return run;
}
async function homeCapFixture(t, cap) {
  // This helper isolates HOME, fleet and record in this process before calling
  // adoption, as well as in every dispatch/record child. No LANE_CONFIG override.
  const project = configFixture(t), file = path.join(project.cwd, '.lane.json');
  if (cap === undefined) fs.unlinkSync(file); // Never publish a lane policy in the default control.
  else {
    const config = JSON.parse(fs.readFileSync(file));
    config.dispatch.max_unlanded = cap;
    fs.writeFileSync(file, JSON.stringify(config));
  }
  project.git('add', '.lane.json'); project.git('commit', '-qm', 'Configure unlanded fixture cap');
  await project.adopt();
  return { ...fixture(t, { project }), project };
}

test('adopted home cap without LANE_CONFIG refuses at two and shares three fix/follow-up slots', async t => {
  const f = await homeCapFixture(t, 2);
  assert.equal(Object.hasOwn(process.env, 'LANE_CONFIG'), false);
  assert.equal(Object.hasOwn(f.env, 'LANE_CONFIG'), false);
  const selected = policyLocation(f.repo, 'lane', f.env);
  assert.equal(selected.home, true);
  assert.equal(selected.file, path.join(f.project.binding().directory, 'lane.json'));
  assert.equal(JSON.parse(fs.readFileSync(selected.file)).dispatch.max_unlanded, 2);
  unlandedSetting(f, 8); // A repo fallback would incorrectly admit the third item.
  const pending = [pendingItem(f, { item: f.item }), pendingItem(f)];
  const next = f.rec(['add', 'Third unlanded item', '--role', 'engineer']);
  const refused = f.dispatch([next, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief]);
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.equal(JSON.parse(refused.stdout).code, 'DISPATCH_UNLANDED_CAP');
  assert.match(refused.stderr, /unlanded count 2, cap 2/);
  for (const { item } of pending) assert.ok(JSON.parse(refused.stdout).reason.includes(item));
  assert.deepEqual(f.show(next).runs, []);
  assert.equal(f.calls().some(c => c.type === 'lane'), false);

  f.rec(['claim', pending[0].run, '--controller', 'brain']);
  const fix = f.start(['--from-run', pending[0].run]);
  assert.equal(fix.status, 0, fix.stderr);
  const fixed = JSON.parse(fix.stdout), fixJob = JSON.parse(fs.readFileSync(fixed.journal));
  assert.equal(fixJob.unlandedCap.cap, 2);
  assert.equal(fixJob.unlandedCap.count, 2);
  assert.equal(fixJob.unlandedCap.admission.kind, 'fix');
  assert.equal(fixJob.unlandedCap.exceptions.count, 0);
  assert.equal(fixJob.sessionCap.cap, 4);
  assert.equal(f.show(fixed.run).meta.dispatch_unlanded_admitted, true);
  assert.equal(f.show(fixed.run).meta.dispatch_unlanded_exception, 'fix');
  const active = [fixed.run];
  for (let n = 1; n <= 2; n++) {
    const item = f.rec(['add', 'Home-cap landing follow-up', '--role', 'engineer']);
    const result = f.dispatch([item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief, '--unblocks', pending[1].item]);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout), job = JSON.parse(fs.readFileSync(receipt.journal));
    active.push(receipt.run);
    assert.equal(job.unlandedCap.cap, 2);
    assert.equal(job.unlandedCap.admission.kind, 'unblocks');
    assert.equal(job.unlandedCap.exceptions.count, n);
    assert.equal(f.show(receipt.run).meta.dispatch_unlanded_admitted, true);
    assert.equal(f.show(receipt.run).meta.dispatch_unblocks, pending[1].item);
    assert.ok(f.state().links.some(l => l.blocker === item && l.blocked === pending[1].item));
  }
  const fourth = f.dispatch([next, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief, '--unblocks', pending[1].item]);
  assert.equal(fourth.status, 1, fourth.stderr);
  assert.equal(JSON.parse(fourth.stdout).code, 'DISPATCH_UNLANDED_CAP');
  assert.match(fourth.stderr, /unlanded count 4, cap 2/);
  assert.match(fourth.stderr, /All 3 active fix\/follow-up slots are occupied/);
  for (const run of active) assert.ok(JSON.parse(fourth.stdout).reason.includes(run));
  assert.deepEqual(f.show(next).runs, []);
  assert.equal(f.state().links.some(l => l.blocker === next), false);
});

test('absent home policy without LANE_CONFIG defaults to eight unlanded items', async t => {
  const f = await homeCapFixture(t);
  assert.equal(Object.hasOwn(process.env, 'LANE_CONFIG'), false);
  assert.equal(Object.hasOwn(f.env, 'LANE_CONFIG'), false);
  const binding = f.project.binding();
  assert.equal(binding.sources.lane.present, false);
  assert.equal(binding.published.includes('lane'), false);
  assert.equal(fs.existsSync(path.join(binding.directory, 'lane.json')), false);
  assert.equal(policyLocation(f.repo, 'lane', f.env).home, false);
  assert.equal(fs.existsSync(path.join(f.repo, '.lane.json')), false);
  const pending = Array.from({ length: 7 }, () => pendingItem(f));
  const admitted = f.start(); assert.equal(admitted.status, 0, admitted.stderr);
  const job = JSON.parse(fs.readFileSync(JSON.parse(admitted.stdout).journal));
  assert.equal(job.unlandedCap.cap, 8);
  assert.equal(job.unlandedCap.count, 7);
  const next = f.rec(['add', 'Ninth home-less item', '--role', 'engineer']);
  const refused = f.dispatch([next, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief]);
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).code, 'DISPATCH_UNLANDED_CAP');
  assert.match(refused.stderr, /unlanded count 8, cap 8/);
  for (const item of [...pending.map(p => p.item), f.item]) assert.ok(JSON.parse(refused.stdout).reason.includes(item));
  assert.deepEqual(f.show(next).runs, []);
});

test('default unlanded cap admits the eighth item, then refuses a new item before lane/run or awaited writes', t => {
  const f = fixture(t);
  const pending = Array.from({ length: 7 }, () => pendingItem(f));
  const admitted = f.start(); assert.equal(admitted.status, 0, admitted.stderr);
  const receipt = JSON.parse(admitted.stdout), job = JSON.parse(fs.readFileSync(receipt.journal));
  assert.equal(job.unlandedCap.cap, 8); assert.equal(job.unlandedCap.count, 7);
  assert.equal(f.show(receipt.run).meta.dispatch_unlanded_admitted, true);
  assert.equal(f.show(receipt.run).meta.dispatch_unlanded_exception, undefined);
  const next = f.rec(['add', 'Ninth item', '--role', 'engineer']);
  const events = fs.readFileSync(path.join(f.org, 'events.jsonl')), calls = f.calls().length;
  const refused = f.dispatch([next, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief, '--awaited']);
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).code, 'DISPATCH_UNLANDED_CAP');
  assert.match(refused.stderr, /unlanded count 8, cap 8/);
  for (const id of [...pending.map(p => p.item), f.item]) assert.ok(JSON.parse(refused.stdout).reason.includes(id));
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), events);
  assert.equal(f.calls().slice(calls).some(c => c.type === 'lane'), false);
  assert.equal(f.jobs().length, 1);
});

test('adoption admits new work despite done closures and pre-cap open runs, listing legacy work as not counted', t => {
  const f = fixture(t); unlandedSetting(f, 1);
  const done = pendingItem(f); f.rec(['close', done.item]);
  const legacy = [pendingItem(f, { admitted: false }), pendingItem(f, { admitted: false })];
  const admitted = f.start(); assert.equal(admitted.status, 0, admitted.stderr);
  const receipt = JSON.parse(admitted.stdout), job = JSON.parse(fs.readFileSync(receipt.journal));
  assert.equal(job.unlandedCap.count, 0);
  assert.equal(job.unlandedCap.admission.kind, 'regular');
  assert.equal(f.show(receipt.run).meta.dispatch_unlanded_admitted, true);
  assert.equal(receipt.legacy.counted, false);
  assert.equal(receipt.legacy.count, 2);
  assert.deepEqual(receipt.legacy.items.map(i => i.item), legacy.map(i => i.item));
  assert.deepEqual(receipt.legacy, job.unlandedCap.legacy);
  const next = f.rec(['add', 'After first admitted start', '--role', 'engineer']);
  const refused = f.dispatch([next, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief]);
  assert.equal(JSON.parse(refused.stdout).code, 'DISPATCH_UNLANDED_CAP');
  assert.match(refused.stderr, /unlanded count 1, cap 1/);
  assert.ok(refused.stderr.includes(`Legacy, not counted (2): ${legacy.map(i => i.item).join(', ')}`));
  assert.deepEqual(f.show(next).runs, []);
});

for (const disposition of ['done', 'dropped', 'landed']) test(`${disposition} items release unlanded capacity`, t => {
  const f = fixture(t); unlandedSetting(f, 1);
  const prior = pendingItem(f);
  const refused = f.start(); assert.equal(JSON.parse(refused.stdout).code, 'DISPATCH_UNLANDED_CAP');
  if (disposition === 'done') f.rec(['close', prior.item]);
  else if (disposition === 'dropped') f.rec(['close', prior.item, '--dropped']);
  else {
    // Fixture a recorded train landing; this test never runs a promotion gate.
    const file = path.join(f.org, 'events.jsonl'), state = f.state();
    fs.appendFileSync(file, JSON.stringify({ type: 'promotion.reconciled', seq: state.eventCount + 1,
      at: new Date().toISOString(), by: 'dispatch-test-agent', identity: f.git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
      items: [prior.item], runs: [prior.run], heads: [{ item: prior.item, run: prior.run, head: 'a'.repeat(40) }] }) + '\n');
  }
  const admitted = f.start(); assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(JSON.parse(fs.readFileSync(JSON.parse(admitted.stdout).journal)).unlandedCap.count, 0);
});

test('a from-run fix dispatches over the unlanded cap and records its admission without changing the session cap', t => {
  const f = fixture(t); unlandedSetting(f, 1);
  const prior = pendingItem(f, { item: f.item });
  f.rec(['claim', prior.run, '--controller', 'brain']);
  const result = f.start(['--from-run', prior.run]); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout), run = f.show(receipt.run), job = JSON.parse(fs.readFileSync(receipt.journal));
  assert.equal(run.meta.dispatch_unlanded_exception, 'fix');
  assert.equal(run.meta.dispatch_from_run, prior.run);
  assert.equal(job.unlandedCap.admission.kind, 'fix');
  assert.equal(job.unlandedCap.count, 1); assert.equal(job.sessionCap.cap, 7);
  assert.equal(f.dispatch(['--retry', receipt.run]).status, 0, 'prompt recovery consumes no exception slot');
  assert.equal(f.show(f.item).runs.length, 2);
});

test('landing follow-ups record their dependency and share three active slots; a fourth refuses until one finishes', t => {
  const f = fixture(t); unlandedSetting(f, 1);
  const landing = pendingItem(f), receipts = [];
  for (let n = 0; n < 3; n++) {
    const item = n === 0 ? f.item : f.rec(['add', 'Landing follow-up', '--role', 'engineer']);
    const result = f.dispatch([item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief, '--unblocks', landing.item]);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout), run = f.show(receipt.run); receipts.push(receipt);
    assert.equal(run.meta.dispatch_unlanded_exception, 'unblocks');
    assert.equal(run.meta.dispatch_unblocks, landing.item);
    assert.ok(f.state().links.some(l => l.blocker === item && l.blocked === landing.item));
    assert.equal(JSON.parse(fs.readFileSync(receipt.journal)).unblocks, landing.item);
  }
  const next = f.rec(['add', 'Fourth landing follow-up', '--role', 'engineer']);
  const args = [next, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief, '--unblocks', landing.item];
  const refused = f.dispatch(args); assert.equal(JSON.parse(refused.stdout).code, 'DISPATCH_UNLANDED_CAP');
  assert.match(refused.stderr, /unlanded count 4, cap 1/);
  assert.match(refused.stderr, /All 3 active fix\/follow-up slots are occupied/);
  assert.deepEqual(f.show(next).runs, []);
  assert.equal(f.state().links.some(l => l.blocker === next), false);
  // A fix uses the same exception pool, not a separate allowance.
  const fix = f.start(['--from-run', receipts[0].run]);
  assert.equal(JSON.parse(fix.stdout).code, 'DISPATCH_UNLANDED_CAP');
  f.rec(['abandon', receipts[0].run]);
  const admitted = f.dispatch(args); assert.equal(admitted.status, 0, admitted.stderr);
  const job = JSON.parse(fs.readFileSync(JSON.parse(admitted.stdout).journal));
  assert.equal(job.unlandedCap.count, 4, 'abandoning a run does not drop its item');
  assert.equal(job.unlandedCap.exceptions.count, 2);
  const changed = f.dispatch(['--retry', receipts[1].run, '--unblocks', next]);
  assert.match(changed.stderr, /--retry uses the saved request/);
});

test('unblocks validates a pending landing before side effects and invalid configured caps fail on reuse too', t => {
  const f = fixture(t), neverDispatched = f.rec(['add', 'No pending landing', '--role', 'engineer']);
  for (const target of [neverDispatched, f.item, 'ENG-999']) {
    const events = fs.readFileSync(path.join(f.org, 'events.jsonl'));
    const result = f.start(['--unblocks', target, '--awaited']);
    assert.equal(JSON.parse(result.stdout).code, 'DISPATCH_UNBLOCKS_INVALID');
    assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), events);
    assert.equal(f.calls().some(c => c.type === 'lane'), false);
  }
  const first = f.start(); assert.equal(first.status, 0, first.stderr);
  const prior = JSON.parse(first.stdout); f.rec(['abandon', prior.run]);
  unlandedSetting(f, 0);
  const result = f.start(['--reuse', prior.run]);
  assert.match(result.stderr, /dispatch.max_unlanded must be a positive integer/);
});

test('reuse bypasses only session admission and needs an explicit continuation at the unlanded cap', t => {
  const f = fixture(t); unlandedSetting(f, 1); capSetting(f, 1);
  const first = f.start(); assert.equal(first.status, 0, first.stderr);
  const prior = JSON.parse(first.stdout); f.rec(['abandon', prior.run]);
  const file = path.join(f.root, 'workers'), workers = JSON.parse(fs.readFileSync(file));
  workers[prior.agent].agent_status = 'idle'; fs.writeFileSync(file, JSON.stringify(workers));
  const next = f.rec(['add', 'Unrelated item', '--role', 'engineer']);
  const refused = f.dispatch([next, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief, '--reuse', prior.run]);
  assert.equal(JSON.parse(refused.stdout).code, 'DISPATCH_UNLANDED_CAP');
  const reused = f.start(['--from-run', prior.run, '--reuse', prior.run]); assert.equal(reused.status, 0, reused.stderr);
  assert.equal(JSON.parse(reused.stdout).agent, prior.agent);
  assert.equal(f.show(JSON.parse(reused.stdout).run).meta.dispatch_unlanded_exception, 'fix');
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
});

test('unlanded admission retries current config before starting a run and preserves an already recorded reservation', t => {
  const f = fixture(t); f.fail('prepare');
  assert.equal(f.start().status, 1); const journal = f.jobs()[0];
  const landing = pendingItem(f); unlandedSetting(f, 1); f.fail('');
  const retry = f.dispatch(['--retry', journal]); assert.equal(JSON.parse(retry.stdout).code, 'DISPATCH_UNLANDED_CAP');
  assert.deepEqual(f.show(f.item).runs, []);
  f.rec(['close', landing.item, '--dropped']); f.fail('dispatch');
  assert.equal(f.dispatch(['--retry', journal]).status, 1);
  const reserved = JSON.parse(fs.readFileSync(journal)); assert.ok(reserved.run);
  f.fail(''); const resumed = f.dispatch(['--retry', reserved.run, '--fresh']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).run, reserved.run);
  assert.equal(f.show(f.item).runs.length, 1, 'recovery reuses its durable reservation');
});

for (const exceptional of [false, true]) test(`concurrent unlanded ${exceptional ? 'exception' : 'item'} admissions grant only the last available slot`, async t => {
  const f = fixture(t); unlandedSetting(f, 1);
  let target;
  if (exceptional) {
    target = pendingItem(f).item;
    for (let n = 0; n < 2; n++) pendingItem(f, { meta: ['dispatch_unlanded_exception=unblocks'] });
  }
  const other = f.rec(['add', 'Concurrent item', '--role', 'engineer']);
  const hook = admissionHook(f, `const rename=fs.renameSync;let once=true;fs.renameSync=function(from,to) {
 const result=rename.call(this,from,to);
 if(once && String(to).endsWith('/dispatch-session-cap')) {once=false;pause();}
 return result;
};`);
  const args = item => [item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief, ...(target ? ['--unblocks', target] : [])];
  const first = f.concurrent(args(f.item), hook); let second;
  try {
    await until(() => fs.existsSync(hook.PAUSE_MARKER));
    second = f.concurrent(args(other), hook);
    await until(() => admissionAttempts(hook) === 2);
    assert.equal(second.child.exitCode, null);
  } finally {
    fs.writeFileSync(hook.PAUSE_RELEASE, 'go'); await Promise.all([first.done, second?.done]);
  }
  const admitted = await first.done, refused = await second.done;
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).code, 'DISPATCH_UNLANDED_CAP');
  assert.equal(f.show(f.item).runs.length, 1); assert.deepEqual(f.show(other).runs, []);
  assert.equal(promptCalls(f).length, 1);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
});
test('dispatch help documents the unlanded limit, explicit exceptions and stable refusal', t => {
  const result = fixture(t).dispatch(['--help']); assert.equal(result.status, 0, result.stderr);
  for (const text of ['dispatch.max_unlanded defaults to 8', '--from-run', '--unblocks', '3 active exception runs', 'DISPATCH_UNLANDED_CAP']) assert.ok(result.stdout.includes(text));
});

test('session cap refuses before lane/run creation, lists occupants and admits after an ESRCH exit', t => {
  const f = fixture(t); capSetting(f, 2);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const first = occupiedRun(f), second = occupiedRun(f);
  const refused = f.start();
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(JSON.parse(refused.stdout).reason, new RegExp(`session cap 2 reached: ${first}, ${second}`));
  assert.match(refused.stderr, /2 workers, 0 settle reviewers/);
  assert.equal(f.calls().some(c => c.type === 'lane'), false);
  assert.deepEqual(f.show(f.item).runs, [first, second]);
  fs.mkdirSync(path.join(f.org, 'dispatch'), { recursive: true });
  fs.writeFileSync(path.join(f.org, 'dispatch', `${second}.json`), JSON.stringify({ run: second,
    common: f.git(['rev-parse', '--path-format=absolute', '--git-common-dir']), launchProcess: { pid: dead, identity: 'old' } }));
  const admitted = f.start(); assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(promptCalls(f).length, 1);
});

test('another project in the same record does not occupy this project session cap', t => {
  const f = fixture(t); capSetting(f, 1);
  occupiedRun(f, { project: path.join(f.root, 'other-project/.git') });
  const admitted = f.start(); assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(promptCalls(f).length, 1);
});

test('live reuse and setup-only retries remain admitted at the cap', t => {
  const f = fixture(t); capSetting(f, 1); f.fail('watch');
  assert.equal(f.start().status, 1);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0])); f.fail('');
  const setup = f.dispatch(['--retry', job.run]); assert.equal(setup.status, 0, setup.stderr);
  f.rec(['abandon', job.run]);
  const file = path.join(f.root, 'workers'), workers = JSON.parse(fs.readFileSync(file));
  workers[job.worker.agentName].agent_status = 'idle'; fs.writeFileSync(file, JSON.stringify(workers));
  occupiedRun(f);
  const reused = f.start(['--reuse', job.run]); assert.equal(reused.status, 0, reused.stderr);
  assert.equal(JSON.parse(reused.stdout).agent, job.worker.agentName);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
});

test('a saved request rechecks the current cap before creating a worker', t => {
  const f = fixture(t); f.fail('prepare');
  assert.equal(f.start().status, 1); const journal = f.jobs()[0];
  occupiedRun(f); capSetting(f, 1); f.fail('');
  const retry = f.dispatch(['--retry', journal]); assert.equal(retry.status, 1);
  assert.match(retry.stderr, /session cap 1 reached/);
  assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'dispatch'), false);
});

for (const cap of [1, 2]) test(`overlapping final launches wait for admission, then respect cap ${cap}`, async t => {
  const f = fixture(t); capSetting(f, cap);
  const hook = admissionHook(f, `const rename=fs.renameSync;let once=true;fs.renameSync=function(from,to) {
 const result=rename.call(this,from,to);
 if(once && String(to).endsWith('/dispatch-session-cap')) {once=false;pause();}
 return result;
};`);
  const args = [f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief];
  const first = f.concurrent(args, hook); let second;
  try {
    await until(() => fs.existsSync(hook.PAUSE_MARKER));
    second = f.concurrent(args, hook);
    await until(() => admissionAttempts(hook) === 2);
    assert.equal(second.child.exitCode, null, 'the overlapping launch waits instead of refusing');
    assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'dispatch'), false);
  } finally {
    fs.writeFileSync(hook.PAUSE_RELEASE, 'go');
    await Promise.all([first.done, second?.done]);
  }
  const a = await first.done, b = await second.done;
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, cap === 1 ? 1 : 0, b.stderr);
  if (cap === 1) assert.match(b.stderr, /session cap 1 reached/);
  else assert.notEqual(JSON.parse(a.stdout).agent, JSON.parse(b.stdout).agent);
  const full = f.start(); assert.equal(full.status, 1); assert.match(full.stderr, new RegExp(`session cap ${cap} reached`));
  assert.equal(f.show(f.item).runs.length, 2);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, cap);
  assert.equal(promptCalls(f).length, cap);
});

test('a dead project admission owner and contender are reclaimed before launching', t => {
  const f = fixture(t), dead = spawnSync(process.execPath, ['-e', '']).pid;
  const directory = path.join(f.git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'dispatch-session-cap');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: dead }));
  fs.mkdirSync(`${directory}.contenders`);
  fs.writeFileSync(path.join(`${directory}.contenders`, `${dead}-crashed`), '');
  const admitted = f.start(); assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(promptCalls(f).length, 1);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(fs.readdirSync(`${directory}.contenders`), []);
});

test('concurrent dead-owner reclaim cannot remove the new project admission lock', async t => {
  const f = fixture(t), dead = spawnSync(process.execPath, ['-e', '']).pid;
  const directory = path.join(f.git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'dispatch-session-cap');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: dead }));
  const hook = admissionHook(f, `process.kill=function(pid,...args) {
 if(pid===${dead}) {try {return kill.call(process,pid,...args);} catch(error) {pause();throw error;}}
 return kill.call(process,pid,...args);
};`);
  const args = [f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief];
  const first = f.concurrent(args, hook); let second;
  try {
    await until(() => fs.existsSync(hook.PAUSE_MARKER));
    second = f.concurrent(args, hook);
    await until(() => admissionAttempts(hook) === 2);
    assert.equal(second.child.exitCode, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'))).pid, dead);
  } finally {
    fs.writeFileSync(hook.PAUSE_RELEASE, 'go');
    await Promise.all([first.done, second?.done]);
  }
  for (const result of await Promise.all([first.done, second.done])) assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 2);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(fs.readdirSync(`${directory}.contenders`), []);
});
for (const [stage, cap] of [['open', 2], ['worker', 2], ['worker', 1]]) {
  test(`a ${stage} memory wait allows another dispatch below cap ${cap} and recounts before launch`, async t => {
    const f = fixture(t), memory = path.join(f.root, 'memory.json'); capSetting(f, cap);
    fs.writeFileSync(memory, JSON.stringify({ available: (stage === 'open' ? 128 * 1024 ** 2 : 8 * 1024 ** 3), swap_used: 0 }));
    const pending = f.concurrent([f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief],
      { TEST_MEMORY_FILE: memory, ...(stage === 'worker' ? { TEST_MEMORY_WORKER_PRESSURE: '1' } : {}) });
    let stderr = '';
    pending.child.stderr.on('data', data => { stderr += data; });
    try {
      await until(() => stderr.includes('waiting; memory pressure'));
      assert.equal(JSON.parse(fs.readFileSync(f.jobs()[0])).stage, stage);
      const directory = path.join(f.git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'dispatch-session-cap');
      assert.equal(fs.existsSync(directory), false, 'memory waits must not hold admission');
      const concurrent = f.start(); assert.equal(concurrent.status, 0, concurrent.stderr);
      assert.equal(promptCalls(f).length, 1);
    } finally {
      fs.writeFileSync(memory, JSON.stringify({ available: 8 * 1024 ** 3, swap_used: 0 }));
      await pending.done;
    }
    assert.equal((await pending.done).status, cap === 1 ? 1 : 0, stderr);
    if (cap === 1) assert.match(stderr, /session cap 1 reached/);
    assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, cap);
    assert.equal(promptCalls(f).length, cap);
  });
}
test('a proving reservation pauses dispatch before lane open within the existing memory_open clock', async t => {
  const f = fixture(t), lock = path.join(f.root, 'slot');
  const held = publishProvingReservation({ lockPath: lock, label: 'proof', reason: 'ENG-424 R-601', expiresAt: new Date(Date.now() + 60000).toISOString() });
  t.after(() => held.release());
  const pending = f.concurrent([f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief],
    { MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock });
  let stderr = ''; pending.child.stderr.on('data', data => { stderr += data; });
  try {
    const deadline = Date.now() + 10000;
    while (!stderr.includes('waiting; proving') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(stderr, /waiting; proving.*ENG-424 R-601; expiry/);
    assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'open'), false);
    assert.deepEqual(readTiming(f.jobs()[0]).filter(row => row.kind === 'memory_open').map(row => row.outcome), ['entry']);
  } finally { held.release(); await pending.done; }
  assert.equal(pending.child.exitCode, 0, stderr); assert.match(stderr, /proving reservation ended; proceeding/);
  assert.deepEqual(readTiming(f.jobs()[0]).filter(row => row.kind === 'memory_open').map(row => row.outcome), ['entry', 'granted']);
});

for (const stage of ['open', 'worker']) test(`dispatch ${stage} proving wait defers at the existing admission deadline and retains its stage`, async t => {
  const f = fixture(t), lock = path.join(f.root, 'bounded-slot'); let journal;
  if (stage === 'worker') {
    f.fail('dispatch'); assert.equal(f.start().status, 1); f.fail(''); journal = f.jobs()[0];
  }
  const held = publishProvingReservation({ lockPath: lock, label: 'proof', reason: 'bounded dispatch', expiresAt: new Date(Date.now() + 60000).toISOString() });
  t.after(() => held.release());
  try {
    const preload = path.join(f.root, 'fast-admission.mjs');
    fs.writeFileSync(preload, `if(process.argv[1]===${JSON.stringify(DISPATCH)}){const now=performance.now.bind(performance);Object.defineProperty(performance,'now',{value:()=>now()*10000});}`);
    const launches = f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length;
    const args = journal ? ['--retry', journal, '--fresh'] : [f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief];
    const pending = f.concurrent(args, { MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock,
      NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` });
    const result = await pending.done;
    assert.equal(result.status, 75, result.stderr);
    const reply = JSON.parse(result.stdout); assert.equal(reply.result, 'deferred'); assert.equal(reply.code, RESERVATION_WAIT_EXPIRED_CODE);
    assert.equal(reply.stage, stage); assert.ok(reply.elapsed_ms >= 0); assert.match(reply.reason, /bounded dispatch/);
    const job = JSON.parse(fs.readFileSync(f.jobs()[0])); assert.equal(job.stage, stage);
    assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, launches);
    assert.equal(promptCalls(f).length, 0);
    if (stage === 'open') assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'open'), false);
    assert.deepEqual(readTiming(f.jobs()[0]).filter(e => e.kind === `memory_${stage}`).map(e => e.outcome).slice(-2), ['entry', 'failed']);
  } finally { held.release(); }
});

test('dispatch waits under simulated swap pressure before opening a lane and resumes the same request', async t => {
  const f = fixture(t), memory = path.join(f.root, 'memory.json');
  fs.writeFileSync(memory, JSON.stringify({ available: 2 * 1024 ** 3, swap_used: 1024 ** 3 }));
  const pending = f.concurrent([f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief], { TEST_MEMORY_FILE: memory });
  let stderr = '';
  pending.child.stderr.on('data', data => { stderr += data; });
  const end = Date.now() + 10000;
  while (!stderr.includes('waiting; memory pressure') && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(stderr, /swap in use 1024 MiB/);
  assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'open'), false);
  const journal = f.jobs()[0]; assert.equal(JSON.parse(fs.readFileSync(journal)).stage, 'open');
  fs.writeFileSync(memory, JSON.stringify({ available: 8 * 1024 ** 3, swap_used: 1024 ** 2 }));
  await pending.done;
  assert.equal(pending.child.exitCode, 0, stderr);
  assert.match(stderr, /cleared; proceeding/);
  assert.equal(f.jobs().length, 1); assert.equal(promptCalls(f).length, 1);
});
for (const stage of ['open', 'worker']) {
  test(`STOP during dispatch ${stage} memory wait retains the request without a worker launch`, async t => {
    const f = fixture(t), memory = path.join(f.root, 'memory.json');
    fs.writeFileSync(memory, JSON.stringify({ available: (stage === 'open' ? 128 * 1024 ** 2 : 8 * 1024 ** 3), swap_used: 0 }));
    const pending = f.concurrent([f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief],
      { TEST_MEMORY_FILE: memory, ...(stage === 'worker' ? { TEST_MEMORY_WORKER_PRESSURE: '1' } : {}) });
    let stderr = '', stdout = '';
    pending.child.stderr.on('data', data => { stderr += data; });
    pending.child.stdout.on('data', data => { stdout += data; });
    const stop = path.join(f.repo, '.lane/supervisor/STOP');
    try {
      const end = Date.now() + 10000;
      while (!stderr.includes('waiting; memory pressure') && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
      assert.match(stderr, /waiting; memory pressure/);
      assert.equal(JSON.parse(fs.readFileSync(f.jobs()[0])).stage, stage);
      fs.mkdirSync(path.dirname(stop), { recursive: true }); fs.writeFileSync(stop, 'Operator stop');
    } finally {
      fs.writeFileSync(memory, JSON.stringify({ available: 8 * 1024 ** 3, swap_used: 0 }));
      await pending.done;
    }
    assert.equal(pending.child.exitCode, 0, stderr);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.result, 'stopped'); assert.equal(receipt.stage, stage);
    assert.match(receipt.reason, /Supervisor STOP/);
    assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'open').length, stage === 'open' ? 0 : 1);
    assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'dispatch'), false);
    assert.equal(promptCalls(f).length, 0);
    assert.equal(fs.existsSync(`${receipt.journal}.lock`), false, 'stopping releases the request lock');
    const stillStopped = f.dispatch(['--retry', receipt.journal]);
    assert.equal(stillStopped.status, 0, stillStopped.stderr);
    assert.equal(JSON.parse(stillStopped.stdout).result, 'stopped');
    fs.unlinkSync(stop);
    const resumed = f.dispatch(['--retry', receipt.journal]);
    assert.equal(resumed.status, 0, resumed.stderr);
    if (receipt.run) assert.equal(JSON.parse(resumed.stdout).run, receipt.run);
    assert.equal(f.jobs().length, 1); assert.equal(promptCalls(f).length, 1);
    assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'open').length, 1);
  });
}
