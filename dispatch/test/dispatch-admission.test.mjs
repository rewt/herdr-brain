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

test('running admission reaches lane preparation despite many unfinished unlanded records', t => {
  const f=fixture(t);unlandedSetting(f,1);
  const history=Array.from({length:10},()=>pendingItem(f));
  const before=f.state();f.fail('prepare');
  const result=f.start();assert.equal(result.status,1);assert.match(result.stderr,/injected prepare/);assert.notEqual(JSON.parse(result.stdout).code,'DISPATCH_UNLANDED_CAP');
  assert.ok(f.calls().some(c=>c.type==='lane'&&c.a[0]==='open'));
  for(const {item,run}of history){assert.equal(f.show(item).closed,false);assert.equal(f.show(run).meta.dispatch_unlanded_admitted,true);}
  assert.equal(f.state().runs.size,before.runs.size,'no false completion or new run at failed preparation');
});

test('running admission keeps adopted home history diagnostic rather than freezing new work', async t => {
  const f=await homeCapFixture(t,1);assert.equal(Object.hasOwn(f.env,'LANE_CONFIG'),false);
  assert.equal(policyLocation(f.repo,'lane',f.env).home,true);
  for(let n=0;n<3;n++)pendingItem(f);f.fail('prepare');
  const result=f.start();assert.equal(result.status,1);assert.match(result.stderr,/injected prepare/);assert.notEqual(JSON.parse(result.stdout).code,'DISPATCH_UNLANDED_CAP');
  assert.ok(f.calls().some(c=>c.type==='lane'&&c.a[0]==='open'));
});

test('running admission retains same-item origin and real unblocks target guards', t => {
  const f=fixture(t);const other=pendingItem(f);f.fail('prepare');
  const foreign=f.start(['--from-run',other.run]);assert.equal(foreign.status,1);assert.equal(JSON.parse(foreign.stdout).code,'FROM_RUN_OTHER_ITEM');
  const bad=f.start(['--unblocks',f.item]);assert.equal(bad.status,1);assert.equal(JSON.parse(bad.stdout).code,'DISPATCH_UNBLOCKS_INVALID');
  assert.equal(f.calls().some(c=>c.type==='lane'),false);
});

test('running admission help names native occupancy and preserves relation flags without cap bypass', t => {
  const result=fixture(t).dispatch(['--help']);assert.equal(result.status,0,result.stderr);
  for(const text of ['running native','dispatch.max_sessions','diagnostic only','--from-run','--unblocks','never bypasses'])assert.ok(result.stdout.includes(text));
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
