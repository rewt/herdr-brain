import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { hold } from './helpers/retire-fixture.mjs';
import { initOrg } from '../lib/store.mjs';
import { digest } from '../lib/completion.mjs';
import { readCloseoutEntries, closeoutPolicy } from '../lib/closeout.mjs';
import { readCloseoutOwnerStatus } from '../lib/closeout-code.mjs';
import { prepareCloseoutPacket, readCloseoutCapabilities } from '../lib/closeout-packet.mjs';
import { gitProject } from '../lib/project.mjs';
import { readProjectPolicy } from '../lib/config-policy.mjs';
import { kickCloseout } from '../lib/closeout.mjs';
import { closer, setup, evaluations, effects, selectCurrentCleanup, assertRemoved } from './helpers/closeout-fixture.mjs';

test('current cleanup selection suppresses the frozen c160 kick and binds future sources for the named current closer', t => {
  const f = setup(t, { occupied: false }), project = gitProject(f.repo);
  selectCurrentCleanup(f);
  const legacy = JSON.parse(fs.readFileSync(new URL('./fixtures/closeout-c160-selection.json', import.meta.url)));
  const policy = new Function('readProjectPolicy', 'fs', `return (${legacy.policy})`)(readProjectPolicy, fs);
  const kick = new Function('closeoutPolicy', 'closeoutRecordMatches', 'queueTransaction', `return (${legacy.kick})`)(
    policy, () => true, () => { throw Error('legacy kick reached queue/spawn'); });
  assert.equal(policy(f.repo), false);
  assert.deepEqual(kick(project, f.org), { evaluated: [] });
  assert.equal(closeoutPolicy(f.repo, 'report.ingested'), true);
  const source = f.report()[0];
  assert.equal(source.closeout_targets.length, 1);
  f.land();
  assert.equal(kickCloseout(project, f.org, { env: f.env }).owned_by, 'line-service');
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/worker.log')), false);
  assert.equal(f.drain().owned_by, 'line-service');
  const keys = readCloseoutEntries(f.common).map(e => e.key);
  assert.ok(keys.includes(source.closeout_targets[0].key));
  const result = f.drain({ keys });
  assert.ok(result.evaluated.some(e => e.completed), JSON.stringify(result));
  assertRemoved(f);
});

test('current cleanup selection keeps defaults opt-outs malformed foreign and redirected declarations safe and lossless', t => {
  const f = setup(t, { occupied: false, terminal: true }), selected = selectCurrentCleanup(f);
  const entries = readCloseoutEntries(f.common), keys = entries.map(e => e.key);
  const files = entries.map(e => path.join(f.common, 'closeout/entries', `${e.key}.json`));
  const bytes = files.map(file => fs.readFileSync(file)), record = fs.readFileSync(f.eventFile);
  const policyFile = path.join(f.repo, '.lane.json');
  for (const retirement of [{}, { closeout_queue: false }, { closeout_queue: false, line_service_cleanup: false }]) {
    fs.writeFileSync(policyFile, JSON.stringify({ retirement }));
    assert.equal(closeoutPolicy(f.repo, 'report.ingested'), false);
    if (retirement.closeout_queue === false) assert.equal(f.drain({ keys }).disabled, true);
  }
  for (const retirement of [{ line_service_cleanup: true }, { closeout_queue: true, line_service_cleanup: true },
    { closeout_queue: false, line_service_cleanup: 'true' }]) {
    fs.writeFileSync(policyFile, JSON.stringify({ retirement }));
    assert.throws(() => closeoutPolicy(f.repo), /invalid|requires|boolean/);
  }
  selectCurrentCleanup(f);
  for (const change of [{ source: f.repo }, { repo: f.lane }, { org: f.scratch }, { node: '/foreign/node' },
    { target: 'foreign' }, { file: path.join(f.scratch, 'service.plist') }]) {
    fs.writeFileSync(selected.file, JSON.stringify({ ...selected.receipt, ...change }));
    assert.throws(() => f.drain({ keys }), /ownership is UNKNOWN/);
  }
  fs.unlinkSync(selected.file);
  assert.equal(closeoutPolicy(f.repo), false, 'no declared current owner means no fallback consumer');
  const redirected = path.join(f.scratch, 'installation.json');
  fs.writeFileSync(redirected, JSON.stringify(selected.receipt)); fs.symlinkSync(redirected, selected.file);
  assert.throws(() => f.drain({ keys }), /redirected/);
  fs.unlinkSync(selected.file); fs.writeFileSync(selected.file, '{');
  assert.throws(() => closeoutPolicy(f.repo), /JSON/);
  assert.deepEqual(fs.readFileSync(f.eventFile), record);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), bytes[i]));
  assert.deepEqual(f.read().actions, []);
});

test('current cleanup selection retains HOLD native refusal and original unknown effects without rewriting queued bytes', t => {
  for (const kind of ['HOLD', 'native', 'unknown']) {
    const f = setup(t, { merged: true }); selectCurrentCleanup(f); f.report();
    const source = f.append([{ type: 'item.closed', id: 'ENG-1', as: 'done', completed_run: 'R-1' }])[0];
    const entry = readCloseoutEntries(f.common).find(e => e.key === source.closeout_targets[0].key);
    if (kind === 'HOLD') hold(f);
    if (kind === 'native') f.options.command = () => { throw Error('native refusal EPERM'); };
    if (kind === 'unknown') {
      const candidate = f.retirement(f.options).plan(f.lane).close[0];
      f.append([{ type: 'closeout.effect', key: entry.key, identity: f.common, run: 'R-1', item: 'ENG-1', source: entry.source,
        effect: 'original-intent', outcome: { action: 'agent-exit-requested', run: candidate.run, pane: candidate.pane,
          tab_id: candidate.tab_id, occupant: candidate.occupant, shell: candidate.shell } }]);
    }
    const file = path.join(f.common, 'closeout/entries', `${entry.key}.json`), before = fs.readFileSync(file);
    const result = f.drain({ keys: [entry.key], sessionsOnly: true, retrySafe: true });
    assert.equal(result.evaluated[0]?.completed, false, JSON.stringify(result));
    assert.match(result.evaluated[0].reason, /HOLD|held|EPERM|native|unresolved/i);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(f.read().actions, []);
    assert.equal(fs.existsSync(f.lane), true);
  }
});

test('cleanup handoff packet preserves every queue byte and original birth identity across live unknown later and absent owners', t => {
  for (const kind of ['original', 'later', 'absent']) {
    const f = setup(t, { occupied: false, terminal: true });
    const keys = readCloseoutEntries(f.common).map(e => e.key);
    const lock = path.join(f.common, 'closeout/consumer.lock');
    const owner = { pid: 91833, identity: '1793081341:121264', token: 'original',
      argv: [process.execPath, '/installed/c160/supervisor/closeout.mjs', 'drain', '--keys', JSON.stringify(keys), '--deadline', '1'] };
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner));
    const originalFile = path.join(f.scratch, 'original-owner.json');
    fs.writeFileSync(originalFile, JSON.stringify(readCloseoutOwnerStatus({ cwd: f.repo, org: f.org, env: f.env })));
    if (kind === 'later') fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ ...owner, pid: 92400, identity: 'new-birth', token: 'later' }));
    if (kind === 'absent') fs.rmSync(lock, { recursive: true });
    const directory = path.join(f.common, 'closeout/entries'), extra = 'b'.repeat(64) + '.json';
    const opaque = Buffer.from([0, 255, 10, 123]);
    fs.writeFileSync(path.join(directory, extra), opaque);
    const before = new Map(fs.readdirSync(directory).map(n => [n, fs.readFileSync(path.join(directory, n))]));
    const record = fs.readFileSync(f.eventFile), status = fs.readFileSync(originalFile);
    const packet = prepareCloseoutPacket({ cwd: f.repo, org: f.org, env: f.env, originalFile,
      candidateRoot: fileURLToPath(new URL('../', import.meta.url)) });
    assert.deepEqual(packet.keys, keys); assert.equal(packet.effects, 0); assert.equal(packet.effects_authorized, false);
    assert.equal(packet.original_outcome, 'UNKNOWN'); assert.equal(packet.original_release, 'UNKNOWN');
    assert.deepEqual(packet.original.claims.consumer.owner, owner);
    assert.deepEqual(Buffer.from(packet.original.base64, 'base64'), status);
    assert.equal(packet.queue.length, before.size);
    for (const entry of packet.queue) {
      assert.deepEqual(Buffer.from(entry.base64, 'base64'), before.get(entry.name));
      assert.equal(entry.sha256, createHash('sha256').update(before.get(entry.name)).digest('hex'));
      assert.deepEqual(fs.readFileSync(path.join(directory, entry.name)), before.get(entry.name));
    }
    assert.equal(packet.current_claims.consumer.liveness, 'UNKNOWN');
    assert.equal(packet.current_claims.consumer.state, kind === 'absent' ? 'absent' : 'stored');
    if (kind === 'later') assert.equal(packet.current_claims.consumer.owner.token, 'later');
    assert.equal(packet.candidate.supported, true);
    assert.equal(packet.phases.length, 2); assert.ok(packet.phases[0].argv.includes('--sessions-only'));
    assert.equal(packet.phases[1].argv.includes('--sessions-only'), false);
    assert.deepEqual(fs.readFileSync(f.eventFile), record); assert.deepEqual(f.read().actions, []);
    if (kind === 'original') {
      const reply = spawnSync(process.execPath, [closer, 'packet', '--repo', f.repo, '--org', f.org,
        '--original', originalFile, '--candidate', fileURLToPath(new URL('../', import.meta.url))], { env: f.env, encoding: 'utf8' });
      assert.equal(reply.status, 0, reply.stderr); assert.equal(JSON.parse(reply.stdout).effects_authorized, false);
    }
  }
});

test('cleanup handoff packet refuses partial foreign ambiguous or redirected preparations without acquiring claims', t => {
  const f = setup(t, { occupied: false, terminal: true });
  const keys = readCloseoutEntries(f.common).map(e => e.key), lock = path.join(f.common, 'closeout/consumer.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 91833, identity: 'kernel-birth', token: 'original',
    argv: [process.execPath, '/installed/c160/supervisor/closeout.mjs', 'drain', '--keys', JSON.stringify(keys)] }));
  const original = readCloseoutOwnerStatus({ cwd: f.repo, org: f.org, env: f.env }), originalFile = path.join(f.scratch, 'original.json');
  const options = { cwd: f.repo, org: f.org, env: f.env, originalFile, candidateRoot: fileURLToPath(new URL('../', import.meta.url)) };
  for (const kind of ['foreign', 'missing-birth', 'ambiguous', 'partial']) {
    const changed = structuredClone(original);
    if (kind === 'foreign') changed.org = f.scratch;
    if (kind === 'missing-birth') delete changed.claims.consumer.owner.identity;
    if (kind === 'ambiguous') changed.claims.consumer.owner.argv.push('--keys', JSON.stringify(keys));
    if (kind === 'partial') changed.claims.consumer.owner.argv[4] = JSON.stringify([...keys, 'a'.repeat(64)]);
    fs.writeFileSync(originalFile, JSON.stringify(changed));
    assert.throws(() => prepareCloseoutPacket(options), /different project|birth|exact named|every original/);
  }
  fs.writeFileSync(originalFile, JSON.stringify(original));
  const file = path.join(f.common, 'closeout/entries', keys[0] + '.json'), retained = path.join(f.scratch, 'retained.json');
  fs.renameSync(file, retained); fs.symlinkSync(retained, file);
  assert.throws(() => prepareCloseoutPacket(options), /symbolic|regular|ELOOP/);
  assert.deepEqual(f.read().actions, []);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/queue.lock')), false);
});

test('cleanup handoff capability binds current clean code and holds an old undeclared code root without executing it', t => {
  const f = setup(t, { occupied: false, terminal: true }), current = readCloseoutCapabilities();
  assert.equal(current.supported, true); assert.equal(current.capabilities.shared_retirement_owner, true);
  // A small committed pre-declaration product models the c160 closed parser;
  // no installed release, project pin or saved job is read or changed.
  const old = path.join(f.scratch, 'old-code'); fs.mkdirSync(path.join(old, 'supervisor'), { recursive: true });
  fs.writeFileSync(path.join(old, 'supervisor/closeout.mjs'), `import {parseArgs} from 'node:util';\nparseArgs({allowPositionals:true,options:{keys:{type:'string'},deadline:{type:'string'},'no-restart':{type:'boolean'},repo:{type:'string'},org:{type:'string'}}});\n`);
  f.git(['init', '-qb', 'main'], old); f.git(['config', 'user.name', 'Old code'], old); f.git(['config', 'user.email', 'old@example.invalid'], old);
  f.git(['add', '.'], old); f.git(['commit', '-qm', 'Pre-declaration parser'], old);
  const observed = readCloseoutCapabilities(old);
  assert.equal(observed.supported, false); assert.equal(observed.capabilities, null);
  const keys = readCloseoutEntries(f.common).map(e => e.key), lock = path.join(f.common, 'closeout/consumer.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 91833, identity: 'original-birth', token: 'original',
    argv: [process.execPath, '/installed/c160/supervisor/closeout.mjs', 'drain', '--keys', JSON.stringify(keys)] }));
  const originalFile = path.join(f.scratch, 'original.json');
  fs.writeFileSync(originalFile, JSON.stringify(readCloseoutOwnerStatus({ cwd: f.repo, org: f.org, env: f.env })));
  const packet = prepareCloseoutPacket({ cwd: f.repo, org: f.org, env: f.env, originalFile, candidateRoot: old });
  assert.deepEqual(packet.keys, keys); assert.deepEqual(packet.phases, []); assert.equal(packet.effects_authorized, false);
  for (const flag of ['--sessions-only', '--retry-safe', '--owner']) {
    const reply = spawnSync(process.execPath, [path.join(old, 'supervisor/closeout.mjs'), 'drain', flag], { env: f.env, encoding: 'utf8' });
    assert.notEqual(reply.status, 0); assert.match(reply.stderr, /Unknown option/);
  }
  fs.writeFileSync(path.join(old, 'supervisor/closeout-capabilities.json'), JSON.stringify(current.capabilities));
  assert.throws(() => readCloseoutCapabilities(old), /inventory mismatch/);
  assert.deepEqual(f.read().actions, []);
});

test('closeout owner status preserves the retained legacy owner and refuses to turn old outcomes or an expired deadline into release',t=>{
  const f=setup(t,{occupied:false}),directory=path.join(f.common,'closeout'),owner={pid:91833,identity:'1793081341:121264',token:'original-consumer',at:'2026-10-27T06:09:02.691Z',argv:[process.execPath,'/installed/c160/supervisor/closeout.mjs','drain','--keys',JSON.stringify(['a'.repeat(64)]),'--deadline','1793079848822','--no-restart']};
  f.append([{type:'closeout.code-handoff',identity:f.common,keys:['a'.repeat(64)],old:{code:{root:'/installed/c160'},epoch:{tip:'d937'}},current:{code:{root:'/installed/c160'},epoch:{tip:'00e'}}},{type:'closeout.evaluated',key:'a'.repeat(64),identity:f.common,completed:true}]);
  for(const name of ['consumer.lock','queue.lock']){fs.mkdirSync(path.join(directory,name),{recursive:true});fs.writeFileSync(path.join(directory,name,'owner.json'),JSON.stringify(owner),{mode:0o600});}
  fs.writeFileSync(path.join(directory,'worker.log'),'older successor 0 pending false; evaluations complete\n');
  const before=fs.readFileSync(f.eventFile),claims=['consumer.lock','queue.lock'].map(n=>fs.readFileSync(path.join(directory,n,'owner.json'))),kill=process.kill;
  process.kill=()=>{throw Error('read-only status must never probe or signal an owner');};
  let result;try{result=readCloseoutOwnerStatus({cwd:f.repo,org:f.org,env:f.env});}finally{process.kill=kill;}
  assert.equal(result.schema,'closeout-owner-status/v1');assert.equal(result.effects,0);assert.equal(result.original_outcome,'UNKNOWN');assert.equal(result.original_release,'UNKNOWN');assert.equal(result.claims.consumer.state,'stored');assert.deepEqual(result.claims.consumer.owner,owner);assert.equal(result.claims.consumer.liveness,'UNKNOWN');assert.equal(result.claims.queue.owner.pid,91833);assert.equal(result.source.capabilities.named_sessions,true);assert.equal(result.source.capabilities.zero_elapsed_budget,true);assert.equal(result.successor.capabilities,null,'a source status must not assert capabilities of a different selected root');
  assert.deepEqual(fs.readFileSync(f.eventFile),before);for(const [i,n]of ['consumer.lock','queue.lock'].entries())assert.deepEqual(fs.readFileSync(path.join(directory,n,'owner.json')),claims[i]);assert.deepEqual(f.read().actions,[]);
  const reply=spawnSync(process.execPath,[closer,'status','--owner','--repo',f.repo,'--org',f.org],{env:f.env,encoding:'utf8'});assert.equal(reply.status,0,reply.stderr);assert.equal(JSON.parse(reply.stdout).claims.consumer.owner.token,owner.token);assert.deepEqual(fs.readFileSync(f.eventFile),before);
});
test('closeout owner status keeps absent claims distinct from original success and rejects foreign records or redirected owner files',t=>{
  const f=setup(t,{occupied:false}),empty=readCloseoutOwnerStatus({cwd:f.repo,org:f.org,env:f.env});assert.equal(empty.claims.consumer.state,'absent');assert.equal(empty.original_outcome,'UNKNOWN');assert.equal(empty.original_release,'UNKNOWN');
  const foreign=path.join(f.scratch,'foreign-record');initOrg(foreign);assert.throws(()=>readCloseoutOwnerStatus({cwd:f.repo,org:foreign,env:f.env}),/record.*binding/);
  const lock=path.join(f.common,'closeout/consumer.lock');fs.mkdirSync(lock,{recursive:true});const file=path.join(f.scratch,'foreign-owner.json');fs.writeFileSync(file,JSON.stringify({pid:91833}));fs.symlinkSync(file,path.join(lock,'owner.json'));assert.throws(()=>readCloseoutOwnerStatus({cwd:f.repo,org:f.org,env:f.env}),/redirected|regular/);assert.equal(fs.readFileSync(file,'utf8'),JSON.stringify({pid:91833}));assert.deepEqual(f.read().actions,[]);
});
