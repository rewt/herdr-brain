import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { initOrg, loadEvents, transact } from '../../lib/store.mjs';
import { preparePromotionGuard } from '../../promote/guard.mjs';
import { provingHold, clearProvingHold, provingHoldStatus, provingScope, packetDigest, requestKey, resourceConflicts, validateProvingReadback } from '../proving-hold.mjs';

const laneCLI = fileURLToPath(new URL('../../lanes/lane.mjs', import.meta.url));
function fixture(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proving-hold-')));
  fixtureFleet(t, repo);
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(repo, '.identity-root'), '');
  fs.writeFileSync(path.join(repo, '.promote.json'), JSON.stringify({ to: 'owner' }));
  fs.writeFileSync(path.join(repo, '.gitignore'), '.org/\n.lane/\n');
  git(['add', '.identity-root', '.promote.json', '.gitignore']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const identity = path.join(repo, '.git'), org = path.join(repo, '.org'); initOrg(org);
  const owner = { name: 'owner', pane_id: 'fake:p1', workspace_id: 'fake', terminal_id: 'terminal',
    agent_session: { value: 'owner-session' }, cwd: repo, agent_status: 'working' };
  const agents = [owner], calls = [];
  const row = (pid, ppid) => ({ pid, ppid, pgid: 20, identity: `fixture-${pid}`, command: 'fixture', state: 'S' });
  const readProcess = () => ({ ok: true, value: new Map([row(10, 1), row(20, 10), row(30, 20), row(process.pid, 30)].map(r => [r.pid, r])) });
  const env = { ...process.env, ORG_DIR: org, HERDR_ENV: '1', HERDR_PANE_ID: owner.pane_id, HERDR_WORKSPACE_ID: owner.workspace_id,
    CODEX_THREAD_ID: owner.agent_session.value, MONITOR_TEST_SLOT_PATH: path.join(repo, 'slot'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(repo, 'compat') };
  const call = (_exe, args) => {
    calls.push(args);
    if (args[0] === 'agent' && args[1] === 'get') return JSON.stringify({ result: { agent: owner } });
    if (args.join(' ') === 'agent list') return JSON.stringify({ result: { agents } });
    if (args[0] === 'pane' && args[1] === 'get') {
      const a = agents.find(a => a.pane_id === args[2]);
      return JSON.stringify({ result: { pane: { pane_id: a.pane_id, workspace_id: a.workspace_id, terminal_id: a.terminal_id } } });
    }
    if (args[0] === 'pane' && args[1] === 'process-info') return JSON.stringify({ result: { process_info: { shell_pid: 10, foreground_processes: [{ pid: 20 }] } } });
    throw Error(`unexpected native effect ${args.join(' ')}`);
  };
  const events = () => loadEvents(org).events;
  const append = (add, actor = owner.name) => transact(org, () => ({ add }), { actor }).added;
  append([{ type: 'item.added', id: 'ENG-1', title: 'Proving agreement', role: 'engineer' }]);
  const endorse = packet => append([{ type: 'note.added', id: 'ENG-1', decision: true, text: `PROVING HOLD ${packet.kind} ${packetDigest(packet)}` }])[0].seq;
  const packet = { schema: 'brain.proving-hold/v1', kind: 'request', source_project: '/owner-supplied/bch/.git', issuer: 'bch-owner',
    request_id: 'prove-1', consumer: identity, authority_ref: 'owner-linked-standing-agreement:decision-17', scope: provingScope,
    notice_id: 'original-owner-notice-1', delivery: 'linked-record' };
  const decisions = new Map();
  const options = (p = packet, extra = {}) => {
    if (!decisions.has(packetDigest(p))) decisions.set(packetDigest(p), endorse(p));
    return { repo, org, cwd: repo, env, call, readProcess, packet: p, decisionSeq: decisions.get(packetDigest(p)), ...extra };
  };
  const request = (p = packet, extra = {}) => provingHold({ ...options(p), action: 'request', ...extra });
  const ack = (p = packet, extra = {}) => provingHold({ ...options(p), action: 'ack', ...extra });
  const releasePacket = (p = packet, extra = {}) => ({ ...p, kind: 'release', reply_to: `proving:${requestKey(p)}:acknowledged`,
    result: 'completed', completion_ref: 'owner-linked-positive-proving-completion', notice_id: p.notice_id + ':complete', ...extra });
  const release = (p = releasePacket(), extra = {}) => clearProvingHold({ ...options(p), ...extra });
  const hold = path.join(repo, '.lane/supervisor/HOLD');
  return { repo, org, identity, git, owner, agents, calls, env, append, events, packet, options, request, ack, releasePacket, release, hold };
}
const protocol = f => f.events().filter(e => e.type.startsWith('proving-hold.'));

test('owner-linked request, one exact containment acknowledgement and positive release survive duplicate calls', t => {
  const f = fixture(t); f.request(); f.request();
  assert.ok(fs.statSync(f.hold).isDirectory()); f.ack(); f.ack();
  const [request, ack] = protocol(f);
  assert.equal(ack.reply_to, request.id); assert.equal(ack.request_seq, request.seq);
  assert.equal(ack.containment.control_pass_promotion_locked, true);
  assert.match(ack.containment.existing_work, /no worker or drain killed/);
  f.release(); f.release();
  assert.equal(fs.existsSync(f.hold), false);
  assert.deepEqual(protocol(f).map(e => e.type), ['proving-hold.requested', 'proving-hold.acknowledged', 'proving-hold.released']);
  f.request(); assert.equal(fs.existsSync(f.hold), false, 'old duplicate must not resurrect released request');
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  assert.deepEqual(provingHoldStatus({ repo: f.repo, org: f.org, packet: f.packet }).history, protocol(f));
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), before);
  assert.ok(f.calls.every(a => a[0] === 'agent' && ['get', 'list'].includes(a[1]) || a[0] === 'pane' && ['get', 'process-info'].includes(a[1])), 'no native input or lifecycle effect');
});

for (const variant of ['unendorsed', 'foreign-consumer', 'foreign-native', 'worker', 'changed-session', 'changed-packet']) {
  test(`unauthenticated or foreign ${variant} cannot gain executor authority`, t => {
    const f = fixture(t), options = f.options();
    if (variant === 'unendorsed') options.decisionSeq = 1;
    if (variant === 'foreign-consumer') options.packet = { ...f.packet, consumer: '/foreign/.git' };
    if (variant === 'foreign-native') f.owner.cwd = path.dirname(f.repo);
    if (variant === 'worker') f.owner.name = 'worker';
    if (variant === 'changed-session') f.owner.agent_session.value = 'replacement';
    if (variant === 'changed-packet') options.packet = { ...f.packet, issuer: 'forged-issuer' };
    assert.throws(() => provingHold({ ...options, action: 'request' }));
    assert.equal(protocol(f).length, 0); assert.equal(fs.existsSync(f.hold), false);
  });
}

test('early, wrong issuer/request/reply/authority and non-positive releases preserve the original HOLD', t => {
  const f = fixture(t); f.request();
  assert.throws(() => f.release(), /exact acknowledgement/); f.ack();
  for (const extra of [{ issuer: 'someone-else' }, { request_id: 'other' }, { reply_to: 'unrelated' },
    { authority_ref: 'different-authority' }, { result: 'deadline' }, { completion_ref: '' }]) {
    assert.throws(() => f.release(f.releasePacket(f.packet, extra)));
    assert.ok(fs.existsSync(f.hold));
  }
  assert.equal(protocol(f).length, 2); f.release(); assert.equal(fs.existsSync(f.hold), false);
});

test('each issuer clears only its own entry; overlapping HOLD and STOP remain', t => {
  const f = fixture(t), other = { ...f.packet, issuer: 'second-owner', request_id: 'same-opaque-id' };
  f.request(); f.request(other); f.ack(); f.ack(other);
  const stop = path.join(f.repo, '.lane/supervisor/STOP'); fs.writeFileSync(stop, 'operator STOP');
  fs.writeFileSync(path.join(f.hold, 'operator-hold'), 'independent hold');
  f.release(); assert.ok(fs.existsSync(f.hold));
  f.release(f.releasePacket(other)); assert.ok(fs.existsSync(f.hold));
  assert.equal(fs.readFileSync(stop, 'utf8'), 'operator STOP');
  assert.equal(fs.readFileSync(path.join(f.hold, 'operator-hold'), 'utf8'), 'independent hold');
});

for (const type of ['plain', 'directory', 'symlink']) test(`pre-existing ${type} operator HOLD is never converted or lifted`, t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.hold), { recursive: true });
  if (type === 'plain') fs.writeFileSync(f.hold, 'operator hold');
  if (type === 'directory') fs.mkdirSync(f.hold);
  if (type === 'symlink') { fs.writeFileSync(path.join(f.repo, 'manual'), 'manual'); fs.symlinkSync(path.join(f.repo, 'manual'), f.hold); }
  assert.throws(() => f.request()); assert.ok(fs.lstatSync(f.hold)); assert.equal(protocol(f).length, 0);
});

for (const conflict of ['live-resource', 'unknown-resource', 'unknown-version', 'retained-lock', 'open-worker', 'native-worker', 'unknown-native', 'closeout-drain']) {
  test(`acknowledgement waits for ${conflict}; recovery keeps the request and writes one acknowledgement`, t => {
    const f = fixture(t); f.request();
    const occupancy = `${f.env.MONITOR_TEST_SLOT_PATH}.occupancy`;
    let recover;
    if (conflict.includes('resource') || conflict === 'unknown-version') {
      fs.mkdirSync(occupancy); const file = path.join(occupancy, 'owner.json');
      const record = conflict === 'unknown-resource' ? '{' : JSON.stringify({ schema: conflict === 'unknown-version' ? 'occupancy/v99' : 'occupancy/v1',
        class: 'shared', pid: process.pid, processStart: null, pgid: null });
      fs.writeFileSync(file, record); recover = () => fs.unlinkSync(file);
    } else if (conflict === 'retained-lock') {
      fs.writeFileSync(f.env.MONITOR_TEST_SLOT_PATH, 'unknown lock'); recover = () => fs.unlinkSync(f.env.MONITOR_TEST_SLOT_PATH);
    } else if (conflict === 'closeout-drain') {
      const lock = path.join(f.identity, 'closeout/consumer.lock'); fs.mkdirSync(lock, { recursive: true });
      fs.writeFileSync(path.join(lock, 'owner.json'), 'original drain'); recover = () => fs.rmSync(lock, { recursive: true });
    } else if (conflict === 'open-worker') {
      f.append([{ type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: f.repo }]);
      recover = () => f.append([{ type: 'run.abandoned', id: 'R-1', note: 'fixture positive owner completion' }]);
    } else {
      f.agents.push({ ...f.owner, name: 'existing-worker', pane_id: 'fake:p2', agent_status: conflict === 'native-worker' ? 'working' : 'unknown' });
      recover = () => f.agents.pop();
    }
    assert.throws(() => f.ack(), /containment pending/); assert.equal(protocol(f).length, 1);
    assert.ok(fs.existsSync(f.hold)); recover(); f.ack(); f.ack();
    assert.equal(protocol(f).filter(e => e.type === 'proving-hold.acknowledged').length, 1);
  });
}

for (const state of ['missing', 'pending', 'refused', 'uncertain']) test(`original ${state} native notice retains HOLD without input or retry`, t => {
  const f = fixture(t), p = { ...f.packet, delivery: 'native-inbox' };
  const inbox = path.join(f.org, 'supervisor/inbox.log'); fs.mkdirSync(path.dirname(inbox), { recursive: true });
  const rows = state === 'missing' ? [] : [{ type: 'notice', id: p.notice_id, to: 'owner', message: 'original packet' },
    ...(state === 'pending' ? [] : [{ type: state === 'uncertain' ? 'sending' : 'refused', id: p.notice_id }])];
  fs.writeFileSync(inbox, rows.map(e => JSON.stringify(e) + '\n').join(''));
  f.request(p); const bytes = fs.readFileSync(inbox, 'utf8');
  assert.throws(() => f.ack(p), /original native notice/); assert.equal(fs.readFileSync(inbox, 'utf8'), bytes);
  assert.ok(fs.existsSync(f.hold)); assert.equal(protocol(f).length, 1);
});

test('restart between marker/event and completion/cleanup retains the same request and exact acknowledgement', t => {
  const f = fixture(t);
  assert.throws(() => f.request(f.packet, { fault: edge => { if (edge === 'hold-written') throw Error('crash after HOLD'); } }), /crash/);
  assert.ok(fs.existsSync(f.hold)); assert.equal(protocol(f).length, 0);
  f.request();
  assert.throws(() => f.ack(f.packet, { fault: edge => { if (edge === 'before-ack') throw Error('crash before acknowledgement'); } }), /crash/);
  f.ack();
  assert.throws(() => f.release(f.releasePacket(), { fault: edge => { if (edge === 'before-clear') throw Error('crash before clear'); } }), /crash/);
  assert.ok(fs.existsSync(f.hold)); assert.equal(protocol(f).length, 3);
  f.release(); assert.equal(fs.existsSync(f.hold), false); assert.equal(protocol(f).length, 3);
});

test('occupied original pass/promotion locks keep HOLD and never recover an unknown owner', t => {
  const f = fixture(t); f.request();
  for (const file of [path.join(f.org, 'line-service', fs.readdirSync(path.join(f.org, 'line-service'))[0], 'pass.lock'), path.join(f.identity, 'lane-promote.lock')]) {
    fs.mkdirSync(file); fs.writeFileSync(path.join(file, 'owner.json'), 'original owner');
    assert.throws(() => f.ack(), /locked/); assert.equal(fs.readFileSync(path.join(file, 'owner.json'), 'utf8'), 'original owner');
    fs.rmSync(file, { recursive: true }); // fixture owner settles its own lock
  }
  f.ack(); assert.equal(protocol(f).length, 2);
});

test('late HOLD refuses the real FF guard and direct lane admissions while the candidate stays unmerged', t => {
  const f = fixture(t), head = f.git(['rev-parse', 'HEAD']);
  const guard = preparePromotionGuard({ canonical: f.repo, identity: f.identity, workspace: f.repo, topic: 'candidate', expectedHead: head });
  f.request(); let merged = false;
  assert.throws(() => guard.run(() => { merged = true; }), /PROMOTION_HELD/); assert.equal(merged, false);
  const child = spawnSync(process.execPath, [laneCLI, 'dispatch', 'candidate', '--kind', 'codex', '--memory-checked', '--json'],
    { cwd: f.repo, env: { ...f.env, HERDR_BRAIN_ROOT: undefined }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /"result":"stopped"/);
  assert.equal(f.git(['rev-parse', 'HEAD']), head);
});

test('Brain ACK never substitutes for the proving owner fresh memory and actual matching lock readback', t => {
  const f = fixture(t); f.request(); f.ack(); const ack = protocol(f)[1], now = Date.now();
  const readback = { memory: { observed_at: new Date(now).toISOString(), free_bytes: 20, required_bytes: 10 },
    lock: { observed_at: new Date(now).toISOString(), state: 'held', issuer: f.packet.issuer, request_id: f.packet.request_id, evidence_ref: 'prover-owner-real-lock-receipt' } };
  assert.equal(validateProvingReadback(ack, readback, now), true);
  for (const mutate of [r => r.memory.observed_at = new Date(now - 31000).toISOString(), r => r.memory.free_bytes = 1,
    r => r.lock.state = 'unknown', r => r.lock.issuer = 'foreign', r => r.lock.request_id = 'wrong', r => r.lock.evidence_ref = '']) {
    const bad = structuredClone(readback); mutate(bad); assert.throws(() => validateProvingReadback(ack, bad, now), /fresh memory/);
  }
  assert.deepEqual(resourceConflicts(f.env), []); assert.ok(fs.existsSync(f.hold));
});
