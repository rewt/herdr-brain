import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resourceStanza, resolveResource, workerSettings } from '../resources.mjs';
import { measureFamily, readOwnedRss } from '../measurement.mjs';
import { summarize } from '../summarize.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';
import { processStartRecord } from '../lock-support.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
const source = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-resources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, 'slot'), receipt = path.join(root, 'execution.json');
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  const run = (argv, { profiled = true, args = [], environment = env } = {}) => spawnSync(process.execPath, [cli, 'run', 'fixture', '--lock-path', lock,
    '--result-path', receipt, ...(profiled ? ['--resource', JSON.stringify(resourceStanza('fixture/bounded', argv))] : []), ...args, '--', ...argv],
  { cwd: root, env: environment, encoding: 'utf8', timeout: loadTimeout(15000) });
  return { root, lock, receipt, env, run, saved: () => JSON.parse(fs.readFileSync(receipt, 'utf8')) };
}

test('profiles bind actual recipes, arguments, environment and input identity without inventing M or transitive C', t => {
  const argv = ['npm', 'run', 'test:release:steps'];
  const resource = resolveResource(argv, { cwd: source, env: { NODE_OPTIONS: 'secret-value' } });
  assert.equal(resource.reason, 'profiled');
  assert.equal(resource.profile.M_bytes, null); assert.equal(resource.profile.C, null);
  assert.equal(resource.profile.admission_class, 'EXCLUSIVE');
  assert.equal(resource.profile.worker_caps.maximum, 4);
  assert.match(resource.profile.worker_caps.scope, /transitive.*unknown/);
  assert.equal(JSON.stringify(resource).includes('secret-value'), false);
  assert.notEqual(resolveResource(argv, { cwd: source, env: {} }).profile.binding_sha256, resource.profile.binding_sha256);
  assert.equal(resolveResource([...argv, '--', '--extra'], { cwd: source }).reason, 'unprofiled');
  assert.equal(resolveResource(['/bin/sh', '-c', 'npm run test:release'], { cwd: source }).reason, 'profiled');
  assert.equal(resolveResource(['/bin/sh', '-c', 'npm run test:release; arbitrary'], { cwd: source }).reason, 'unprofiled');
  const f = fixture(t), pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  pkg.scripts['test:release:steps'] += ' && arbitrary';
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify(pkg));
  assert.equal(resolveResource(argv, { cwd: f.root }).reason, 'unprofiled');
  const workers = workerSettings(); assert.ok(workers.test_file_cap >= 1 && workers.test_file_cap <= 4); assert.equal(workers.transitive_cpu_bound, null);
});

test('all participating named npm recipes have a bound exclusive profile', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  for (const name of Object.keys(pkg.resources)) assert.equal(resolveResource(['npm', 'run', name], { cwd: source }).reason, 'profiled', name);
  const script = ['node', 'test/helpers/release-suites.mjs', '--file-timeout=480000', '--suite-timeout=540000'];
  assert.equal(resolveResource(script, { cwd: source }).reason, 'profiled');
  assert.equal(resolveResource([...script, '--unknown'], { cwd: source }).reason, 'unprofiled');
});

test('sampling walks owned births only, retains escaped descendants and excludes replacement PIDs and foreign groups', () => {
  const row = (pid, ppid, pgid, identity = `birth:${pid}`) => ({ pid, ppid, pgid, identity });
  let rows = new Map([row(10, 1, 10), row(11, 10, 10), row(12, 11, 12), row(99, 1, 99)].map(r => [r.pid, r]));
  const requested = [];
  const meter = measureFamily({ pid: 10, identity: 'birth:10', intervalMs: 60000,
    lookup: () => ({ ok: true, value: rows }), rss: pids => { requested.push(pids); return new Map(pids.map(pid => [pid, pid * 100])); },
    memory: () => ({ available: 10000, source: '/proc/meminfo' }), workers: () => ({}), load: () => 2 });
  // Escaped child reparented after observation remains tied to its exact birth.
  rows = new Map([row(11, 1, 11), row(12, 1, 12), row(13, 12, 13), row(99, 1, 10)].map(r => [r.pid, r]));
  const result = meter.finish();
  assert.deepEqual(requested, [[10, 11, 12], [11, 12, 13]]);
  assert.equal(result.sampled_sum_owned_rss_peak_bytes, 3600);
  assert.equal(result.individual_peak_rss_bytes, 1300);
  assert.equal(result.host_available_min_bytes, 10000);
  assert.equal(result.host_available_drawdown_bytes, 0);
  assert.equal(result.per_process_peak_rss.some(r => r.pid === 99), false);
  let calls = 0;
  const changed = measureFamily({ pid: 10, identity: 'birth:10', intervalMs: 60000, workers: () => ({}),
    memory: () => ({ available: 9000, source: '/proc/meminfo' }),
    lookup: () => ({ ok: true, value: new Map([row(10, 1, 10, ++calls === 1 ? 'birth:10' : 'reused')].map(r => [r.pid, r])) }),
    rss: () => new Map([[10, 999999]]) });
  const replaced = changed.finish(); assert.equal(replaced.rss_samples, 0); assert.ok(replaced.failure_count > 0);
});

test('RSS native source requests only numeric owned PIDs and rejects unrequested output', () => {
  assert.equal(readOwnedRss([10], (command, args) => {
    assert.equal(command, '/bin/ps'); assert.deepEqual(args, ['-o', 'pid=,rss=', '-p', '10']);
    return { status: 0, stdout: ' 10 123\n', stderr: '' };
  }).get(10), 123 * 1024);
  assert.throws(() => readOwnedRss([10], () => ({ status: 0, stdout: '99 123\n' })), /invalid owned/);
  assert.throws(() => readOwnedRss(['10,99']), /invalid owned PID/);
});

test('a bounded real child family records RSS, phases and telemetry; nested runs never sample or release twice', { timeout: loadTimeout(20000) }, t => {
  const f = fixture(t), nestedReceipt = path.join(f.root, 'nested.json'), leaf = path.join(f.root, 'leaf.cjs'), parent = path.join(f.root, 'parent.cjs');
  fs.writeFileSync(leaf, `const allocation=Buffer.alloc(12*1024*1024,17);process.send({pid:process.pid});setInterval(()=>{if(allocation[0]!==17)throw Error('allocation');},100);`);
  fs.writeFileSync(parent, `const fs=require('fs'),cp=require('child_process'),assert=require('assert/strict');
const child=cp.fork(${JSON.stringify(leaf)},[],{stdio:['ignore','ignore','ignore','ipc']});
child.on('message',({pid})=>{
 const nested=[process.execPath,'-e','console.log("nested marker")'];
 const r=cp.spawnSync(process.execPath,[${JSON.stringify(cli)},'run','nested','--lock-path',${JSON.stringify(f.lock)},'--result-path',${JSON.stringify(nestedReceipt)},'--resource',JSON.stringify(${JSON.stringify(resourceStanza('fixture/inner', [process.execPath, '-e', 'console.log("nested marker")']))}),'--',...nested],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert(fs.existsSync(${JSON.stringify(f.lock)}));
 const deadline=Date.now()+10000; const timer=setInterval(()=>{
  const samples=fs.existsSync(${JSON.stringify(f.receipt + '.samples.jsonl')})?fs.readFileSync(${JSON.stringify(f.receipt + '.samples.jsonl')},'utf8'):'';
  if(samples.includes('"pid":'+pid+',')){clearInterval(timer);child.kill();}
  else if(Date.now()>deadline){clearInterval(timer);child.kill();}
 },100);
});`);
  const r = f.run([process.execPath, parent]); assert.equal(r.status, 0, r.stderr + r.stdout);
  const receipt = f.saved(), m = receipt.measurement;
  if (!m.rss_samples && m.failures?.some(f => /Operation not permitted|EPERM/.test(f.message))) { t.skip('sandbox refuses ps; real-family witness requires supervisor rerun under L-27'); t.diagnostic(JSON.stringify(m.failures)); return; }
  assert.ok(m.rss_samples > 0, JSON.stringify(receipt)); assert.ok(m.per_process_peak_rss.length >= 2);
  assert.ok(m.sampled_sum_owned_rss_peak_bytes >= m.individual_peak_rss_bytes);
  assert.ok(m.per_process_peak_rss.some(p => p.peak_rss_bytes >= 12 * 1024 * 1024));
  assert.ok(Date.parse(m.phase_finished_at) >= Date.parse(m.phase_started_at));
  assert.equal(m.sampling_interval_ms, 2000); assert.match(m.notes, /cold\/warm unknown/);
  assert.equal(fs.existsSync(f.lock), false);
  const inner = JSON.parse(fs.readFileSync(nestedReceipt));
  assert.equal(inner.measurement.status, 'inherited; sampled by parent');
  assert.equal(inner.measurement_attempts.length, 0);
  assert.equal(fs.existsSync(nestedReceipt + '.samples.jsonl'), false);
  const samples = fs.readFileSync(m.telemetry_path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(samples.length, m.samples);
  assert.ok(samples.every(s => !s.processes.some(p => p.pid === process.pid)), 'the unrelated test runner is never sampled');
});

test('denied sampling and failed telemetry storage never change exclusive command outcomes', t => {
  const f = fixture(t), deny = path.join(f.root, 'deny.mjs');
  fs.writeFileSync(deny, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const run=cp.spawnSync;cp.spawnSync=(file,...args)=>file==='/bin/ps'?{status:1,stderr:'ps: Operation not permitted',stdout:''}:run(file,...args);syncBuiltinESMExports();`);
  for (const status of [0, 7, 75]) {
    const command = [process.execPath, '-e', `setTimeout(()=>process.exit(${status}),200)`];
    const r = f.run(command, { environment: { ...f.env, NODE_OPTIONS: `--import=${deny}` } });
    assert.equal(r.status, status, r.stderr); assert.equal(f.saved().exit_code, status);
    assert.ok(f.saved().measurement.failure_count > 0); assert.equal(fs.existsSync(f.lock), false);
  }
  fs.rmSync(f.receipt + '.samples.jsonl');
  fs.mkdirSync(f.receipt + '.samples.jsonl');
  const r = f.run([process.execPath, '-e', 'setTimeout(()=>process.exit(0),200)']);
  assert.equal(r.status, 0, r.stderr); assert.ok(f.saved().measurement.failures.some(f => f.component === 'telemetry-write'));
  assert.equal(fs.existsSync(f.lock), false);
});

test('unprofiled execution and profiled admission/refusal decisions preserve exact output, exit and legacy lock bytes', async t => {
  const f = fixture(t), command = [process.execPath, '-e', 'console.log("started")'];
  const legacy = f.run(command, { profiled: false }), profiled = f.run(command);
  assert.deepEqual([profiled.status, profiled.stdout, profiled.stderr], [legacy.status, legacy.stdout, legacy.stderr]);
  const plain = f.run(command, { profiled: false }); assert.equal(plain.status, 0);
  assert.equal(f.saved().resource.reason, 'unprofiled'); assert.equal(f.saved().measurement.status, 'unprofiled');
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: f.env, stdio: 'ignore' });
  await new Promise(resolve => other.once('spawn', resolve));
  t.after(() => other.kill('SIGKILL'));
  const identity = processStartRecord(other.pid);
  for (const holder of [{ pid: other.pid, token: 'legacy-token', pgid: null, label: 'fixed', processStart: identity.start, processBirth: identity.birth }, { invalid: true }]) {
    const bytes = JSON.stringify(holder)+'\n'; fs.writeFileSync(f.lock, bytes);
    const a = f.run(command, { profiled: false }), b = f.run(command);
    assert.deepEqual([b.status, b.stdout, b.stderr], [a.status, a.stdout, a.stderr]);
    assert.equal(b.status, 75); assert.equal(b.stdout, ''); assert.equal(fs.readFileSync(f.lock, 'utf8'), bytes);
  }
});

test('summary keeps metrics separate, counts retries once and invents no envelope or PASS', () => {
  const resource = { profile: { id: 'release', revision: 1, binding_sha256: 'binding' } };
  const measurement = { status: 'observed', rss_samples: 3, sampled_sum_owned_rss_peak_bytes: 1000, individual_peak_rss_bytes: 600, host_available_min_bytes: 4000, host_available_drawdown_bytes: 200 };
  const receipts = [{ resource, measurement_attempts: [measurement, { ...measurement, sampled_sum_owned_rss_peak_bytes: 1200 }] }, { resource, measurement: { status: 'unavailable' } }];
  const [plain] = summarize(receipts); assert.equal(plain.provisional_envelope, null); assert.equal(plain.runs, 2); assert.equal(plain.measured_runs, 1);
  const [chosen] = summarize(receipts, { marginBytes: 300 }); assert.equal(chosen.provisional_envelope.bytes, 1500);
  assert.match(chosen.provisional_envelope.description, /observed max plus chosen margin, from 1 runs.*not a guarantee/);
  assert.equal(chosen.host_available_drawdown_max_bytes, 200); assert.equal(chosen.individual_peak_rss_bytes, 600);
});


test('archive CLI holders retain receipts without a Git common directory and bind the release commit', t => {
  const f = fixture(t), argv = [process.execPath, '-e', 'setTimeout(()=>{},100)'];
  fs.writeFileSync(path.join(f.root, '.release-commit'), 'a'.repeat(40)+'\n');
  const r = spawnSync(process.execPath, [cli, 'run', 'archive', '--lock-path', f.lock, '--resource', JSON.stringify(resourceStanza('fixture/archive', argv)), '--', ...argv],
    { cwd: f.root, env: f.env, encoding: 'utf8', timeout: loadTimeout(10000) });
  assert.equal(r.status, 0, r.stderr);
  const directory = path.join(f.root, '.test-slot-executions'), files = fs.readdirSync(directory).filter(file => file.endsWith('.execution.json'));
  assert.equal(files.length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, files[0])));
  assert.equal(receipt.resource.profile.binding.target_identity.release_commit, 'a'.repeat(40));
  assert.ok(receipt.measurement.samples > 0);
  assert.ok(fs.existsSync(path.join(directory, receipt.measurement.telemetry_file)));
});

test('promotion host retains the exact train profile and measurement beside its existing receipt', t => {
  const f = fixture(t), marker = path.join(f.root, 'marker.mjs'), plan = path.join(f.root, 'train.json');
  const git = args => { const r = spawnSync('git', ['-C', f.root, '-c', 'user.name=Resource', '-c', 'user.email=resource@example.invalid', ...args], { env: f.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git(['init', '-qb', 'main']);
  fs.writeFileSync(path.join(f.root, '.promote.json'), JSON.stringify({ gate: { resource: resourceStanza('fixture/host', null) } }));
  fs.writeFileSync(path.join(f.root, '.lane.validation.json'), JSON.stringify({ promotion: 'node check.cjs' }));
  fs.writeFileSync(marker, 'console.log("train workload marker");');
  git(['add', '.promote.json', '.lane.validation.json', 'marker.mjs']); git(['commit', '-qm', 'resource fixture']);
  fs.writeFileSync(plan, JSON.stringify({ jobs: [{ id: 'job' }] }));
  const host = path.join(source, 'promote/host-gate.mjs');
  const r = spawnSync(process.execPath, [host, f.root, plan, marker], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: loadTimeout(15000) });
  assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /train workload marker/);
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'host-gate.json')));
  assert.equal(saved.resource.profile.id, 'fixture/host/train');
  assert.deepEqual(saved.resource.profile.recipe.prepare, []);
  const execution = JSON.parse(fs.readFileSync(saved.execution_receipt));
  assert.equal(execution.resource.profile.id, saved.resource.profile.id); assert.ok(execution.measurement.samples > 0);
  assert.equal(fs.existsSync(f.lock), false);
});
