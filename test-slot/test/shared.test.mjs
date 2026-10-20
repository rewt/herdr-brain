import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { occupancyState, readTestSlotOccupancy, sharedOccupancy } from '../occupancy.mjs';
import { publishProvingReservation, readProvingReservations } from '../reservations.mjs';
import { processStartRecord } from '../lock-support.mjs';
import { resolveResource, resourceStanza } from '../resources.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';

const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
const source = fileURLToPath(new URL('../../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + loadTimeout(8000);
  while (Date.now() < deadline) { if (predicate()) return; await sleep(20); }
  assert.fail('shared fixture did not become ready');
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shared-')));
  const lock = path.join(root, 'legacy'), compat = path.join(root, 'compat');
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: compat,
    HERDR_MONITOR_FLEET: path.join(root, 'fleet') };
  const children = [];
  const start = args => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
    return { child, done };
  };
  const run = (command, extra = [], cwd = root) => spawnSync(process.execPath, [cli, 'run', 'shared fixture',
    '--result-path', path.join(root, 'result.json'), ...extra, '--', ...command],
  { cwd, env, encoding: 'utf8', timeout: loadTimeout(15000) });
  t.after(async () => {
    for (const row of readTestSlotOccupancy(compat)) if (row.record?.pgid) try { process.kill(-row.record.pgid, 'SIGKILL'); } catch {}
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? null : new Promise(resolve => child.once('close', resolve))));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, lock, compat, env, start, run, saved: () => JSON.parse(fs.readFileSync(path.join(root, 'result.json'))) };
}

test('occupancy publishes complete occupancy/v1 bytes by same-directory rename, with no token or command', t => {
  const f = fixture(t), rename = fs.renameSync;
  let published = false;
  fs.renameSync = (from, to) => {
    assert.equal(path.dirname(from), `${f.lock}.occupancy`);
    assert.equal(path.dirname(to), `${f.lock}.occupancy`);
    assert.equal(fs.existsSync(to), false);
    const bytes = fs.readFileSync(from, 'utf8'), record = JSON.parse(bytes);
    assert.equal(Object.keys(record)[0], 'schema'); assert.equal(record.schema, 'occupancy/v1');
    assert.equal(record.class, 'shared'); assert.equal(record.pid, process.pid);
    assert.deepEqual(Object.keys(record).sort(), ['schema', 'class', 'pid', 'processStart', 'processBirth', 'pgid', 'groupStart', 'groupBirth',
      'acquiredAt', 'startedAt', 'project', 'label', 'cwd', 'host', 'reason', 'profile_id'].sort(), 'BCH B:552 closed key set');
    assert.equal(record.profile_id, 'fixture/shared'); assert.equal(record.token, undefined); assert.equal(record.command, undefined);
    published = true; return rename(from, to);
  };
  let slot;
  try { slot = sharedOccupancy(f.lock, 'project gate', resolveResource(['fixture'], { resource: resourceStanza('fixture/shared', ['fixture']) })); }
  finally { fs.renameSync = rename; }
  t.after(() => slot?.release());
  assert.equal(published, true); assert.equal(readTestSlotOccupancy(f.lock)[0].state, 'live');
  assert.equal(fs.readdirSync(`${f.lock}.occupancy`).length, 1);
  slot.release(); assert.deepEqual(readTestSlotOccupancy(f.lock), []);
});

for (const location of ['project', 'subdirectory', 'linked worktree', 'promotion scratch', 'symlink', 'non-Git'])
  test(`shared occupancy names the canonical project from a ${location} cwd`, t => {
    const f = fixture(t), repo = path.join(f.root, 'project');
    const git = args => {
      const result = spawnSync('git', args, { cwd: f.root, env: f.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    let cwd = f.root, expected = path.basename(f.root);
    if (location !== 'non-Git') {
      git(['init', '-q', '-b', 'main', repo]);
      expected = fs.realpathSync(path.join(repo, '.git'));
      cwd = repo;
      if (location === 'subdirectory') {
        cwd = path.join(repo, 'nested'); fs.mkdirSync(cwd);
      } else if (location === 'linked worktree' || location === 'promotion scratch') {
        git(['-C', repo, '-c', 'user.name=Occupancy fixture', '-c', 'user.email=occupancy@example.invalid',
          '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture']);
        cwd = location === 'promotion scratch' ? path.join(expected, 'promote/batches/fixture/scratch-0')
          : path.join(f.root, 'linked');
        git(['-C', repo, 'worktree', 'add', '--detach', cwd, 'HEAD']);
      } else if (location === 'symlink') {
        cwd = path.join(f.root, 'alias'); fs.symlinkSync(repo, cwd, 'dir');
      }
    }
    const result = f.run([process.execPath, '-e',
      "process.stdout.write(require('fs').readFileSync(process.env.MONITOR_TEST_SLOT_OCCUPANCY_PATH, 'utf8'))"], [], cwd);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.schema, 'occupancy/v1'); assert.equal(record.class, 'shared');
    assert.equal(record.project, expected); assert.equal(record.cwd, fs.realpathSync(cwd));
    assert.deepEqual(readTestSlotOccupancy(f.compat), []);
    for (const file of [f.lock, f.compat, `${f.lock}.queue`]) assert.equal(fs.existsSync(file), false);
  });

test('a shared build starts immediately during live proving and publishes only beside compat', t => {
  const f = fixture(t), held = publishProvingReservation({ lockPath: f.compat, label: 'proof', reason: 'ENG-424 R-601', expiresAt: new Date(Date.now() + 60000).toISOString() });
  try {
    const bytes = fs.readFileSync(held.path, 'utf8');
    const result = f.run([process.execPath, '-e', `const fs=require('fs');console.log('build');if(!process.env.MONITOR_TEST_SLOT_OCCUPANCY_PATH.startsWith(${JSON.stringify(f.compat + '.occupancy/')}))throw Error('wrong occupancy namespace');`]);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'build\n');
    assert.equal(fs.existsSync(`${f.lock}.occupancy`), false);
    assert.equal(fs.readFileSync(held.path, 'utf8'), bytes); assert.equal(readProvingReservations(f.compat)[0].state, 'live');
  } finally { held.release(); }
});

test('occupancy readers accept both legacy project labels and canonical project paths', t => {
  const f = fixture(t), slot = sharedOccupancy(f.lock, 'project gate', { reason: 'unprofiled' });
  t.after(() => slot.release());
  const legacy = { ...slot.holder, project: 'scratch-0' };
  fs.writeFileSync(path.join(`${f.lock}.occupancy`, 'legacy.json'), JSON.stringify(legacy));
  const rows = readTestSlotOccupancy(f.lock);
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.state === 'live'));
  assert.deepEqual(new Set(rows.map(row => row.record.project)), new Set([slot.holder.project, 'scratch-0']));
});

test('Brain gate starts with legacy holders and a queue waiting, without any lock or queue writes or polls', async t => {
  const f = fixture(t), owner = f.start(['-e', 'setInterval(()=>{},1000)']);
  await new Promise(resolve => owner.child.once('spawn', resolve));
  const identity = processStartRecord(owner.child.pid);
  const bytes = JSON.stringify({ pid: owner.child.pid, processStart: identity.start, processBirth: identity.birth,
    pgid: null, token: 'legacy', label: 'legacy holder' }) + '\n';
  for (const file of [f.lock, f.compat]) fs.writeFileSync(file, bytes);
  const peer = f.start(['-e', 'setInterval(()=>{},1000)']);
  await new Promise(resolve => peer.child.once('spawn', resolve));
  const peerIdentity = processStartRecord(peer.child.pid);
  const queue = `${f.lock}.queue`; fs.mkdirSync(queue);
  const ticket = JSON.stringify({ v: 1, pid: peer.child.pid, processStart: peerIdentity.start, processBirth: peerIdentity.birth,
    token: 'fixture-waiting-peer', label: 'waiting peer', arrivedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() });
  fs.writeFileSync(path.join(queue, 'waiting.json'), ticket);
  const deny = path.join(f.root, 'guard.cjs');
  fs.writeFileSync(deny, `const fs=require('fs'),path=require('path');const locks=${JSON.stringify([f.lock, f.compat])};
const protectedPath=p=>locks.some(lock=>String(p)===lock||String(p).startsWith(lock+'.queue'));
for(const name of ['writeFileSync','appendFileSync','rmSync','unlinkSync','mkdirSync']){const original=fs[name];fs[name]=(p,...args)=>{if(protectedPath(p))throw Error('lock/queue write: '+name);return original(p,...args);};}
const open=fs.openSync;fs.openSync=(p,flags,...args)=>{if(protectedPath(p)&&flags!=='r')throw Error('lock write open');return open(p,flags,...args);};
const read=fs.readFileSync,counts=new Map();fs.readFileSync=(p,...args)=>{if(protectedPath(p)){if(String(p).includes('.queue'))throw Error('queue poll');const count=(counts.get(String(p))||0)+1;counts.set(String(p),count);if(count>1)throw Error('lock polled');}return read(p,...args);};`);
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(deny)}`;
  fs.copyFileSync(path.join(source, 'package.json'), path.join(f.root, 'package.json'));
  const bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}\nimport fs from 'node:fs';const files=fs.readdirSync(${JSON.stringify(f.compat + '.occupancy')}).filter(n=>!n.startsWith('.'));if(files.length!==1)throw Error('expected one occupancy');console.log('Brain gate fired');`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  for (const command of [['npm', 'run', 'test:promotion:steps'], ['npm', 'run', 'test:release:steps'], [process.execPath, '-e', 'console.log("unprofiled fired")']]) {
    const result = f.run(command, ['--wait', '60']);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /fired/);
    const saved = f.saved(); assert.equal(saved.class, 'shared'); assert.match(saved.occupancy_path, /\.occupancy\//);
    assert.equal(saved.resource.reason, command[0] === 'npm' ? 'profiled' : 'unprofiled');
    if (command[0] === 'npm') { assert.ok(saved.measurement.samples > 0); assert.equal(saved.measurement.sampling_interval_ms, 2000); }
    assert.deepEqual(readTestSlotOccupancy(f.compat), []);
  }
  for (const file of [f.lock, f.compat]) assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(queue), ['waiting.json']);
  assert.equal(fs.readFileSync(path.join(queue, 'waiting.json'), 'utf8'), ticket);
});

for (const status of [0, 7, 127]) test(`shared occupancy is removed after command exit ${status}`, t => {
  const f = fixture(t), result = f.run(status === 127 ? ['missing-shared-command'] : [process.execPath, '-e', `process.exit(${status})`]);
  assert.equal(result.status, status, result.stderr); assert.equal(f.saved().class, 'shared');
  assert.equal(f.saved().resource.reason, 'unprofiled'); assert.deepEqual(readTestSlotOccupancy(f.compat), []);
  assert.equal(fs.existsSync(f.lock), false); assert.equal(fs.existsSync(`${f.lock}.queue`), false);
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) test(`shared occupancy is removed after ${signal}`, async t => {
  const f = fixture(t), ready = path.join(f.root, 'ready');
  const execution = f.start([cli, 'run', 'signal', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`]);
  await until(() => fs.existsSync(ready) && readTestSlotOccupancy(f.compat)[0]?.record.groupBirth);
  execution.child.kill(signal); const result = await execution.done;
  assert.equal(result.code, 128 + os.constants.signals[signal], result.stderr);
  assert.deepEqual(readTestSlotOccupancy(f.compat), []);
});
test('shared occupancy is removed on a wall timeout', t => {
  const f = fixture(t), result = f.run([process.execPath, '-e', 'setInterval(()=>{},1000)'], ['--timeout-seconds', '.3']);
  assert.equal(result.status, 124, result.stderr); assert.equal(f.saved().gate_timeout.kind, 'wall');
  assert.deepEqual(readTestSlotOccupancy(f.compat), []);
});
test('a killed shared owner stays reserved while its command group lives, then becomes stale', async t => {
  const f = fixture(t), ready = path.join(f.root, 'ready');
  const execution = f.start([cli, 'run', 'killed owner', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`]);
  await until(() => fs.existsSync(ready) && readTestSlotOccupancy(f.compat)[0]?.record.groupBirth);
  const record = readTestSlotOccupancy(f.compat)[0];
  execution.child.kill('SIGKILL');
  await until(() => execution.child.signalCode === 'SIGKILL');
  assert.equal(readTestSlotOccupancy(f.compat, { prune: true })[0].state, 'live');
  assert.equal(fs.existsSync(record.path), true);
  // This fixture has a single leaf. Signal its PID so the same witness also
  // works under the bounded runner's deliberate process-group containment.
  process.kill(record.record.pgid, 'SIGKILL'); await execution.done;
  await until(() => readTestSlotOccupancy(f.compat)[0].state === 'gone');
  readTestSlotOccupancy(f.compat, { prune: true }); assert.equal(fs.existsSync(record.path), false);
});
test('concurrent shared runs each publish one record; a nested declared-exclusive run is refused before admission', async t => {
  const f = fixture(t), finish = path.join(f.root, 'finish'), inner = path.join(f.root, 'inner.json');
  const command = [process.execPath, '-e', 'console.log("nested")'];
  const parent = path.join(f.root, 'parent.cjs');
  fs.writeFileSync(parent, `const fs=require('fs'),cp=require('child_process'),assert=require('assert/strict');
const directory=${JSON.stringify(f.compat + '.occupancy')};const before=fs.readdirSync(directory).filter(n=>!n.startsWith('.')).sort();
const r=cp.spawnSync(process.execPath,[${JSON.stringify(cli)},'run','inner','--result-path',${JSON.stringify(inner)},'--resource',${JSON.stringify(JSON.stringify(resourceStanza('fixture/proving', command, 'EXCLUSIVE')))},'--',...${JSON.stringify(command)}],{encoding:'utf8'});
assert.equal(r.status,75,r.stderr);assert.match(r.stderr,/TEST_SLOT_PROFILE_REJECTED:.*inherited SHARED context/);assert.equal(r.stdout,'');assert.deepEqual(fs.readdirSync(directory).filter(n=>!n.startsWith('.')).sort(),before);
fs.writeFileSync(${JSON.stringify(path.join(f.root, 'ready'))},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)}))clearInterval(timer);},20);`);
  const a = f.start([cli, 'run', 'first', '--', process.execPath, '-e', `const timer=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(finish)}))clearInterval(timer);},20);`]);
  await until(() => readTestSlotOccupancy(f.compat).length === 1);
  const b = f.start([cli, 'run', 'second', '--', process.execPath, parent]);
  await until(() => fs.existsSync(path.join(f.root, 'ready')));
  assert.equal(readTestSlotOccupancy(f.compat).length, 2);
  assert.equal(fs.existsSync(inner), false, 'a refused proving child writes no execution grant');
  assert.equal(fs.existsSync(f.lock), false); assert.equal(fs.existsSync(f.compat), false); assert.equal(fs.existsSync(`${f.lock}.queue`), false);
  fs.writeFileSync(finish, 'finish');
  for (const result of await Promise.all([a.done, b.done])) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readTestSlotOccupancy(f.compat), []);
});

test('occupancy reserves EPERM and failed start reads, and is stale only after owner and all groups are gone', t => {
  const f = fixture(t), record = { schema: 'occupancy/v1', class: 'shared', pid: 101, processStart: 'ps-utc-c:old', pgid: 102, groupStart: null,
    groups: { other: { pgid: 103, start: null } } };
  const gone = () => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); };
  const denied = () => { throw Object.assign(Error('denied'), { code: 'EPERM' }); };
  const failedStart = () => { throw Error('ps: Operation not permitted'); };
  assert.equal(occupancyState(record, { kill: denied, startRecord: () => { throw Error('must not compare on EPERM'); } }).state, 'live');
  assert.equal(occupancyState(record, { kill: gone }).state, 'gone');
  assert.equal(occupancyState(record, { kill: () => {}, startRecord: failedStart }).state, 'live');
  assert.equal(occupancyState(record, { kill: pid => { if (pid === -103) return; gone(); } }).state, 'live');
  assert.equal(occupancyState({ ...record, pgid: null, groups: {} }, { kill: () => {}, startRecord: () => ({ start: 'ps-utc-c:new' }) }).state, 'gone');
  fs.mkdirSync(`${f.lock}.occupancy`);
  const file = path.join(`${f.lock}.occupancy`, 'holder.json'); fs.writeFileSync(file, JSON.stringify(record));
  readTestSlotOccupancy(f.lock, { prune: true, kill: denied }); assert.equal(fs.existsSync(file), true);
  readTestSlotOccupancy(f.lock, { prune: true, kill: () => {}, startRecord: failedStart }); assert.equal(fs.existsSync(file), true);
  readTestSlotOccupancy(f.lock, { prune: true, kill: gone }); assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, JSON.stringify({ ...record, schema: 'occupancy/v2' }));
  assert.deepEqual(readTestSlotOccupancy(f.lock, { prune: true, kill: gone }), []);
  assert.equal(fs.existsSync(file), true, 'unknown schemas are skipped and never removed');
});

test('inherited shared occupancy refuses exclusive admission even when ancestry reads are denied', t => {
  const f = fixture(t), parent = path.join(f.root, 'parent.cjs'), deny = path.join(f.root, 'deny-snapshot.mjs');
  fs.writeFileSync(deny, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const execute=cp.spawnSync,list=fs.readdirSync;
cp.spawnSync=(file,args,...rest)=>String(file).includes('process-source-')&&!args.some(a=>/^\\d+$/.test(a))?{status:125,stderr:'snapshot: Operation not permitted'}:execute(file,args,...rest);
fs.readdirSync=(file,...rest)=>String(file)==='/proc'?(()=>{throw Object.assign(Error('snapshot denied'),{code:'EPERM'});})():list(file,...rest);syncBuiltinESMExports();`);
  const command = [process.execPath, '-e', `const fs=require('fs');if(fs.readdirSync(${JSON.stringify(f.compat + '.occupancy')}).filter(n=>!n.startsWith('.')).length!==1)throw Error('double occupancy');if(fs.existsSync(${JSON.stringify(f.lock)})||fs.existsSync(${JSON.stringify(f.compat)}))throw Error('nested exclusive acquisition');`];
  fs.writeFileSync(parent, `const fs=require('fs'),cp=require('child_process'),assert=require('assert/strict');
const r=cp.spawnSync(process.execPath,[${JSON.stringify(cli)},'run','denied nested','--result-path',${JSON.stringify(path.join(f.root, 'inner.json'))},'--resource',${JSON.stringify(JSON.stringify(resourceStanza('fixture/proving', command, 'EXCLUSIVE')))},'--',...${JSON.stringify(command)}],{env:{...process.env,NODE_OPTIONS:(process.env.NODE_OPTIONS||'')+' --import='+${JSON.stringify(JSON.stringify(deny))}},encoding:'utf8'});
assert.equal(r.status,75,r.stderr);assert.match(r.stderr,/TEST_SLOT_PROFILE_REJECTED:.*inherited SHARED context/);assert(!fs.existsSync(${JSON.stringify(path.join(f.root, 'inner.json'))}));`);
  const result = f.run([process.execPath, parent]);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(readTestSlotOccupancy(f.compat), []);
});
