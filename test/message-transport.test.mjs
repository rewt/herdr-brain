import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Receiver, addressKey, transportStatus, readTransport } from '../messages/receiver.mjs';
import { canonical, digest } from '../messages/schema.mjs';
import { quietTransport } from '../messages/transport.mjs';
import { SupervisorTransfer } from '../messages/transfer.mjs';
import { enqueueSupervisor, promptSupervisor, drainInbox, resumeInbox, readInbox } from '../supervisor/prompt-supervisor.mjs';
import { noticeLock } from '../supervisor/notice-lock.mjs';

const screen = (harness, kind = 'empty') => fs.readFileSync(new URL(`../supervisor/test/fixtures/${harness}-${kind}.ansi`, import.meta.url), 'utf8');
async function fixture(t, harness = 'codex') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-transport-')));
  t.after(async () => { fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'FIXTURE'), 'brain.transport-fixture/v1\n', { mode: 0o600 });
  const commonDir = path.join(root, '.git'); fs.mkdirSync(commonDir);
  const supervisor = { identity: 'example', projectRef: commonDir, role: { name: 'project-supervisor', bindingRef: 'supervisor-enrollment' } };
  const worker = { identity: 'example', projectRef: commonDir, session: { uid: 'worker', incarnation: 'first' } };
  const legacy = { identity: 'example', projectRef: commonDir, role: { name: 'supervisor-inbox-importer', bindingRef: 'local-import' } };
  const key = addressKey(supervisor), workerKey = addressKey(worker), inbox = path.join(root, 'inbox.log');
  const receiver = new Receiver({ root });
  const senders = [[worker, 'worker', 'worker-launch'], [supervisor, 'supervisor', 'supervisor-launch'], [legacy, 'legacy', 'legacy-import']].map(([address, producer, receipt]) =>
    ({ address, producer, epoch: 'epoch-1', receipt, recipients: [key, workerKey], bodyRoots: [root] }));
  await receiver.initialize({ supervisor, recipients: [{ address: supervisor, consumer: 'supervisor-reader' }, { address: worker, consumer: 'worker-reader' }],
    senders, legacy: { inbox, target: 'supervisor', sender: 'legacy-import' } });
  let sequence = 0;
  const event = (kind = 'question', overrides = {}) => {
    const n = ++sequence;
    return { schema: 'brain.log/v1', eventId: `worker:${n}`, producer: { id: 'worker', epoch: 'epoch-1', sequence: n },
      occurredAt: '2026-10-16T18:00:00Z', type: 'session.message.v1', level: 'info', identity: 'example', project: { commonDir },
      correlationId: `thread:${n}`, payload: { from: worker, to: [supervisor], kind, refs: [], reply_to: null,
        priority: 'normal', reply_by: null, summary: 'Same question text?', body_ref: null, decision_ref: null }, ...overrides };
  };
  const accept = e => receiver.accept(e, { sender: 'worker-launch', recipient: key });
  const binding = { name: 'supervisor', pane: 'p1', terminal: 't1', nativeSession: 'n1', workspace: 'w1', cwd: root, generation: 'g1', herdr: 'fixture-herdr' };
  const runtime = { ...binding, status: 'idle', text: screen(harness), interactive: true, mode: '', gets: 0 }, calls = [], sent = [];
  const call = (_bin, args) => {
    calls.push(args);
    if (args[0] === 'agent' && args[1] === 'get') {
      runtime.gets++;
      if (runtime.mode === 'final-change' && runtime.gets === 3) runtime.terminal = 'replacement';
      if (runtime.mode === 'gone') throw Error('agent missing');
      return JSON.stringify({ result: { agent: { name: runtime.name, pane_id: runtime.pane, terminal_id: runtime.terminal,
        agent_session: { value: runtime.nativeSession }, workspace_id: runtime.workspace, cwd: runtime.cwd,
        agent: harness, agent_status: runtime.status, interactive_ready: runtime.interactive } } });
    }
    if (args[0] === 'pane') return runtime.text;
    if (args[0] === 'agent' && args[1] === 'prompt') {
      const last = receiver.state().entries.find(e => e.state === 'uncertain');
      assert.ok(last, 'intent is durable before prompt');
      assert.equal(last.receipts.at(-1).state, 'wake-attempt');
      assert.deepEqual(calls.at(-2).slice(0, 2), ['pane', 'read'], 'final pane read immediately precedes input');
      if (runtime.mode === 'refuse') { const e = Error('native refusal'); e.code = 'agent_blocked'; throw e; }
      sent.push(args[3]);
      if (runtime.mode === 'lost-ack') throw Error('acknowledgement lost');
      return '{}';
    }
    throw Error('undeclared physical operation');
  };
  const adapter = quietTransport({ call, confirmSeconds: 0 });
  return { root, inbox, receiver, transfer: new SupervisorTransfer({ root }), supervisor, worker, key, workerKey, event, accept, binding, runtime, calls, sent, adapter,
    deliver: () => receiver.deliverNext(adapter, async () => binding) };
}

test('receiver retains per-recipient stable IDs and producer tuples; text is never a dedup key', async t => {
  const f = await fixture(t), first = f.event(), second = f.event();
  const a = await f.accept(first), b = await f.accept(second);
  assert.notEqual(a.acceptance, b.acceptance);
  assert.deepEqual(await f.accept(first), { ...a, duplicate: true });
  for (const change of [e => { e.payload.summary = 'changed'; }, e => { e.eventId = 'other'; }, e => { e.producer.sequence = 99; }]) {
    const conflicting = structuredClone(first); change(conflicting);
    await assert.rejects(f.accept(conflicting), /conflicting eventId or producer sequence/);
  }
  assert.equal(f.receiver.state().entries.length, 2);
  assert.equal(transportStatus(f.root).receipts.filter(r => r.state === 'refused').length, 3);
  const fanout = f.event('fyi'); fanout.payload.to.push(f.worker);
  const s = await f.accept(fanout), w = await f.receiver.accept(fanout, { sender: 'worker-launch', recipient: f.workerKey });
  assert.notEqual(s.acceptance, w.acceptance);
  assert.equal((await f.receiver.accept(fanout, { sender: 'worker-launch', recipient: f.workerKey })).duplicate, true);
  const restarted = new Receiver({ root: f.root });
  assert.equal((await restarted.accept(first, { sender: 'worker-launch', recipient: f.key })).acceptance, a.acceptance);
});

test('acceptance fsyncs envelope and body together before acknowledgement and survives source loss', async t => {
  const f = await fixture(t), e = f.event(), body = Buffer.from('literal data; $(touch never-run)\n');
  const bodyPath = path.join(f.root, 'source.txt'); fs.writeFileSync(bodyPath, body);
  e.payload.body_ref = { path: bodyPath, sha256: digest(body), bytes: body.length, mediaType: 'text/plain' };
  const sync = fs.fsyncSync, writes = [];
  t.mock.method(fs, 'fsyncSync', fd => { writes.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return sync(fd); });
  const receipt = await f.accept(e);
  assert.deepEqual(writes.slice(-2), ['file', 'directory']);
  const accepted = readTransport(f.root).find(r => r.type === 'accepted');
  assert.equal(Buffer.from(accepted.bodies[0].base64, 'base64').toString(), body.toString());
  assert.equal(receipt.state, 'accepted');
  fs.unlinkSync(bodyPath);
  assert.equal((await f.accept(e)).duplicate, true, 'duplicate acceptance is not new consumption of source');
  const consumed = await f.receiver.consume(e.eventId, f.key, { consumer: 'supervisor-reader' });
  assert.deepEqual(consumed.event, e); assert.deepEqual(consumed.bodies[0].bytes, body);
  assert.equal(fs.existsSync(path.join(f.root, 'never-run')), false);
  assert.equal(transportStatus(f.root).openThreads.length, 1, 'consumption leaves unanswered thread open');
  await assert.rejects(f.receiver.consume(e.eventId, f.key, { consumer: 'unknown' }), /consumer/);
});

test('unacknowledged acceptance returns the same durable receipt, while torn tails and contention hold', async t => {
  const f = await fixture(t), e = f.event();
  await f.accept(e); // Simulate losing the caller acknowledgement after commit.
  assert.equal((await f.accept(e)).duplicate, true);
  fs.writeFileSync(path.join(f.root, 'writer.lock'), 'crash evidence');
  await assert.rejects(f.accept(f.event()), /EEXIST/);
  fs.unlinkSync(path.join(f.root, 'writer.lock'));
  fs.appendFileSync(path.join(f.root, 'transport.jsonl'), '{"torn":');
  const bytes = fs.readFileSync(path.join(f.root, 'transport.jsonl'));
  await assert.rejects(f.accept(f.event()), /torn transport tail/);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'transport.jsonl')), bytes);
});

test('receiver refuses unknown scope, forged human provenance and forbidden or changed body references', async t => {
  const f = await fixture(t);
  await assert.rejects(f.receiver.accept(f.event(), { sender: 'unknown', recipient: f.key }), /unknown or out-of-scope/);
  const wrong = f.event(); wrong.payload.from = { ...f.worker, session: { uid: 'other', incarnation: 'first' } };
  await assert.rejects(f.accept(wrong), /out-of-scope/);
  const outside = f.event(); outside.payload.to = [{ ...f.supervisor, identity: 'other-identity' }];
  await assert.rejects(f.accept(outside), /recipient outside sender scope/);
  const human = f.event(); human.payload.evidence = { origin: 'operator', validated: true };
  await assert.rejects(f.accept(human), /human origin is unverified/);
  const wrongEpoch = f.event(); wrongEpoch.producer.epoch = 'invented-epoch';
  await assert.rejects(f.accept(wrongEpoch), /out-of-scope/);
  const body = Buffer.from('private bytes'), ref = path.join(f.root, 'body'); fs.writeFileSync(ref, body);
  const e = f.event(); e.payload.body_ref = { path: ref, sha256: digest(body), bytes: body.length, mediaType: 'text/plain' };
  fs.writeFileSync(ref, 'tampered bytes'); await assert.rejects(f.accept(e), /body (size|digest) changed/);
  fs.writeFileSync(ref, body); const alias = path.join(f.root, 'alias'); fs.symlinkSync(ref, alias);
  e.eventId = 'symlink'; e.producer.sequence++; e.payload.body_ref.path = alias;
  await assert.rejects(f.accept(e), /outside canonical permitted roots/);
  e.eventId = 'forbidden'; e.producer.sequence++; e.payload.body_ref.path = '/etc/hosts';
  await assert.rejects(f.accept(e), /outside canonical permitted roots/);
  const legacy = f.event(); await assert.rejects(f.receiver.accept(legacy, { sender: 'worker-launch', recipient: f.key, legacy: { id: 'forged', message: 'direct text', to: 'supervisor', disposition: null } }), /enrolled inbox importer/);
  assert.equal(f.receiver.state().entries.length, 0);
});

test('replies require the original thread, correlation, expected sender and exact recipient; a second reply conflicts', async t => {
  const f = await fixture(t), question = f.event();
  question.producer.id = 'supervisor'; question.payload.from = f.supervisor; question.payload.to = [f.worker];
  await f.receiver.accept(question, { sender: 'supervisor-launch', recipient: f.workerKey });
  const reply = f.event('reply'); reply.payload.reply_to = question.eventId; reply.correlationId = question.correlationId;
  const bad = structuredClone(reply); bad.correlationId = 'wrong-thread';
  await assert.rejects(f.accept(bad), /pending thread/);
  const wrongTarget = structuredClone(reply); wrongTarget.payload.to = [f.worker];
  await assert.rejects(f.receiver.accept(wrongTarget, { sender: 'worker-launch', recipient: f.workerKey }), /pending thread/);
  const accepted = await f.accept(reply);
  assert.equal((await f.accept(reply)).acceptance, accepted.acceptance);
  const second = f.event('reply'); second.payload.reply_to = question.eventId; second.correlationId = question.correlationId;
  await assert.rejects(f.accept(second), /conflicting reply/);
  assert.deepEqual(transportStatus(f.root).openThreads, []);
});

for (const harness of ['claude', 'codex']) test(`${harness}: one adapter reuses quiet gates, exact binding checks and escaped pointers`, async t => {
  const f = await fixture(t, harness), e = f.event(); e.payload.summary = 'literal "quoted" $(nothing)';
  await f.accept(e);
  for (const condition of ['busy', 'gone', 'composer', 'interactive', 'name', 'terminal', 'nativeSession', 'pane', 'workspace', 'cwd']) {
    const previous = { ...f.runtime };
    if (condition === 'busy') f.runtime.status = 'working';
    else if (condition === 'gone') f.runtime.mode = 'gone';
    else if (condition === 'composer') f.runtime.text = screen(harness, 'typed');
    else if (condition === 'interactive') f.runtime.interactive = false;
    else f.runtime[condition] = 'new-occupant';
    assert.equal((await f.deliver()).state, 'pending', condition);
    assert.equal(f.sent.length, 0); Object.assign(f.runtime, previous);
  }
  f.runtime.mode = 'final-change'; f.runtime.gets = 0;
  assert.equal((await f.deliver()).state, 'pending'); assert.equal(f.sent.length, 0);
  assert.equal(f.receiver.state().entries[0].state, 'pending', 'known no-input result clears intent');
  f.runtime.mode = ''; f.runtime.terminal = 'replacement';
  assert.equal((await f.deliver()).state, 'pending', 'old binding cannot authorize changed occupant');
  f.binding.terminal = 'replacement'; f.binding.generation = 'g2';
  assert.equal((await f.deliver()).state, 'delivered'); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /summary="literal \\"quoted\\" \$\(nothing\)"/);
  const receipt = f.receiver.state().entries[0].receipts.at(-1);
  assert.equal(receipt.binding.generation, 'g2');
  assert.equal(digest(fs.readFileSync(receipt.pointer.path)), receipt.pointer.sha256);
  assert.equal(await f.deliver(), null, 'known delivery is never repeated');
});

for (const failure of ['refuse', 'lost-ack']) test(`${failure}: a hold survives restart, adapter replacement and switch; explicit inspection alone resolves uncertainty`, async t => {
  const f = await fixture(t), e = f.event(); await f.accept(e); await f.transfer.enroll();
  f.runtime.mode = failure;
  const result = await f.transfer.drain(f.adapter, async () => f.binding);
  assert.equal(result.state, failure === 'refuse' ? 'refused' : 'uncertain');
  let alternate = 0;
  const restarted = new Receiver({ root: f.root });
  await restarted.deliverNext({ deliver: () => { alternate++; throw Error('fallback must not run'); } }, async () => f.binding);
  assert.equal(alternate, 0);
  assert.equal((await f.transfer.switch()).switched, false);
  assert.equal(f.transfer.status().owner, 'legacy');
  assert.equal(f.calls.filter(a => a[1] === 'prompt').length, 1);
  if (failure === 'lost-ack') {
    await assert.rejects(restarted.resolveUncertain(e.eventId, f.key, { delivered: true }), /inspection evidence/);
    await restarted.resolveUncertain(e.eventId, f.key, { delivered: true, evidence: 'fixture target contains the original pointer' });
    assert.equal((await f.transfer.switch()).owner, 'envelope');
    assert.equal(f.sent.length, 1);
  }
});

test('an abandoned wake intent is an uncertain hold, including a crash before the result write', async t => {
  const f = await fixture(t), e = f.event(); await f.accept(e);
  const append = fs.writeFileSync;
  let breakResult = false;
  t.mock.method(fs, 'writeFileSync', function (file, data, ...rest) {
    if (breakResult && typeof data === 'string' && data.includes('"state":"delivered"')) throw Error('crash before delivered commit');
    return append.call(this, file, data, ...rest);
  });
  const adapter = { deliver: async (_p, _b, { beforePrompt }) => { beforePrompt(); breakResult = true; return { state: 'delivered' }; } };
  await assert.rejects(f.receiver.deliverNext(adapter, async () => f.binding), /crash before delivered/);
  assert.deepEqual(transportStatus(f.root).uncertain, [e.eventId]);
  let calls = 0;
  await f.receiver.deliverNext({ deliver: () => { calls++; } }, async () => f.binding);
  assert.equal(calls, 0);
});

test('fyi, ack, hold and release are retained rule consumption with zero binding lookups or model wakes', async t => {
  const f = await fixture(t);
  for (const kind of ['fyi', 'ack', 'hold', 'release']) await f.accept(f.event(kind));
  for (let i = 0; i < 4; i++) assert.equal((await f.receiver.deliverNext({ deliver: () => assert.fail('control wake') }, () => assert.fail('control binding lookup'))).state, 'consumed');
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(transportStatus(f.root).receipts.filter(r => r.state === 'accepted').length, 4);
  assert.equal(transportStatus(f.root).receipts.filter(r => r.state === 'consumed').length, 4);
});

test('forward fence, durable spool, drain, switch and reverse preserve legacy bytes, IDs, open threads, bodies and dedup', async t => {
  const f = await fixture(t), text = '[org-report] run=R-1 item=ENG-1 outcome=blocked\nexact notice bytes';
  enqueueSupervisor('supervisor', text, { inbox: f.inbox, id: 'notice-1' });
  const q = f.event(); await f.accept(q);
  await f.transfer.enroll();
  assert.equal(await resumeInbox(f.inbox), null);
  assert.equal((await drainInbox(f.inbox)).queued, true);
  assert.equal((await f.transfer.switch()).switched, false);
  const watermark = f.transfer.status().watermark;
  const spooled = f.event(); await f.accept(spooled);
  assert.equal((await promptSupervisor('supervisor', '[watch] exact second', { inbox: f.inbox, id: 'notice-2' })).queued, true);
  await f.transfer.syncIntake();
  assert.equal(f.transfer.status().pending.filter(e => e.spooled).length, 2);
  assert.equal(f.transfer.status().watermark, watermark);
  while (f.receiver.state().entries.some(e => e.acceptance <= watermark && ['accepted', 'pending'].includes(e.state)))
    assert.equal((await f.transfer.drain(f.adapter, async () => f.binding)).state, 'delivered');
  assert.equal((await f.transfer.switch()).owner, 'envelope');
  assert.ok(f.sent.includes(`${text} notice-id=notice-1`));
  assert.equal(readInbox(f.inbox)[0].state, 'sent');
  assert.ok(!f.sent.some(s => s.includes('notice-2')));
  const retained = f.receiver.state().entries.map(e => ({ event: e.event, bodies: e.bodies, acceptance: e.acceptance }));
  assert.equal((await f.transfer.switch('reverse')).switched, false);
  const late = f.event('fyi'); await f.accept(late);
  while (f.receiver.state().entries.some(e => e.acceptance <= f.transfer.status().watermark && ['accepted', 'pending'].includes(e.state)))
    await f.transfer.drain(f.adapter, async () => f.binding);
  assert.equal((await f.transfer.switch('reverse')).owner, 'legacy');
  assert.deepEqual(f.receiver.state().entries.slice(0, retained.length).map(e => ({ event: e.event, bodies: e.bodies, acceptance: e.acceptance })), retained);
  assert.equal((await f.accept(q)).duplicate, true);
  assert.ok(f.transfer.status().openThreads.includes(q.eventId));
  assert.ok(f.transfer.status().openThreads.includes(spooled.eventId));
  assert.ok(f.sent.includes('[watch] exact second notice-id=notice-2'));
  assert.equal((await f.transfer.drain(f.adapter, async () => f.binding)).state, 'consumed');
});

test('intake can spool while the old owner is in flight; switching cannot race an active offer', async t => {
  const f = await fixture(t); await f.transfer.enroll(); const e = f.event(); await f.accept(e);
  let release, started;
  const ready = new Promise(r => { started = r; });
  const adapter = { deliver: async (_p, _b, { beforePrompt }) => { beforePrompt(); started(); await new Promise(r => { release = r; }); return { state: 'delivered' }; } };
  const inFlight = f.transfer.drain(adapter, async () => f.binding); await ready;
  await f.transfer.fence('switch');
  const late = f.event(); await f.accept(late);
  assert.ok(f.transfer.status().pending.find(p => p.eventId === late.eventId).spooled);
  await assert.rejects(f.transfer.finish('switch'), /EEXIST/);
  release(); await inFlight;
  assert.equal((await f.transfer.finish('switch')).owner, 'envelope');
});

test('legacy uncertainty is imported atomically, and active compatibility ownership holds enrollment', async t => {
  const f = await fixture(t); enqueueSupervisor('supervisor', 'old uncertain', { inbox: f.inbox, id: 'old' });
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'sending', id: 'old' }) + '\n');
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'retry', id: 'old', may_have_delivered: true }) + '\n');
  const release = noticeLock(`${f.inbox}.owner.lock`);
  await assert.rejects(f.transfer.enroll(), /locked:/); release();
  assert.equal(fs.existsSync(`${f.inbox}.transport-fixture`), false);
  await f.transfer.enroll();
  const original = f.receiver.state().entries[0];
  assert.equal(original.state, 'uncertain');
  assert.equal(readTransport(f.root).find(e => e.type === 'accepted').initialReceipt.state, 'uncertain');
  assert.equal((await f.transfer.switch()).switched, false);
  assert.equal((await f.transfer.drain(f.adapter, async () => f.binding)).state, 'uncertain');
  assert.equal(f.sent.length, 0);
});

test('status is read only; switch and reverse have no live/default root and accept initialized fixtures only', async t => {
  const f = await fixture(t), cli = path.resolve('messages/messages.mjs');
  await f.transfer.enroll();
  const before = fs.readdirSync(f.root).map(n => [n, fs.lstatSync(path.join(f.root, n)).mtimeMs]);
  const status = spawnSync(process.execPath, [cli, 'status', '--root', f.root, '--json'], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr); assert.deepEqual(JSON.parse(status.stdout), transportStatus(f.root));
  assert.deepEqual(fs.readdirSync(f.root).map(n => [n, fs.lstatSync(path.join(f.root, n)).mtimeMs]), before);
  for (const direction of ['switch', 'reverse']) {
    const result = spawnSync(process.execPath, [cli, direction, '--root', f.root, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).switched, true);
    const noRoot = spawnSync(process.execPath, [cli, direction], { encoding: 'utf8' }); assert.notEqual(noRoot.status, 0); assert.match(noRoot.stderr, /explicit --root/);
  }
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-guard-')));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  for (const direction of ['switch', 'reverse']) {
    const blocked = spawnSync(process.execPath, [cli, direction, '--root', elsewhere], { encoding: 'utf8' });
    assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /fixture root/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'events.jsonl')), false);
});

test('fsync failure never acknowledges acceptance; a same-ID retry reestablishes durability', async t => {
  const f = await fixture(t), e = f.event();
  const sync = fs.fsyncSync; let fail = true, acknowledged = false;
  const mocked = t.mock.method(fs, 'fsyncSync', fd => { if (fail) { fail = false; throw Error('injected fsync failure'); } return sync(fd); });
  await assert.rejects(f.accept(e).then(() => { acknowledged = true; }), /injected fsync failure/);
  assert.equal(acknowledged, false);
  const calls = mocked.mock.callCount();
  assert.equal((await f.accept(e)).duplicate, true);
  assert.ok(mocked.mock.callCount() >= calls + 2, 'duplicate receipt waits for file and directory fsync');
  assert.equal(f.receiver.state().entries.length, 1);
});

test('retained body corruption cannot produce a consumption receipt', async t => {
  const f = await fixture(t), e = f.event(), body = Buffer.from('original');
  const source = path.join(f.root, 'source'); fs.writeFileSync(source, body);
  e.payload.body_ref = { path: source, sha256: digest(body), bytes: body.length, mediaType: 'text/plain' };
  await f.accept(e); f.receiver.project(f.receiver.state().entries[0]);
  fs.writeFileSync(path.join(f.root, 'bodies', `${digest(body)}.body`), 'tampered');
  await assert.rejects(f.receiver.consume(e.eventId, f.key, { consumer: 'supervisor-reader' }), /projection changed/);
  assert.equal(f.receiver.state().entries[0].state, 'accepted');
});

test('legacy policy escalation preserves its existing delivery bytes and does not re-run policy', async t => {
  const f = await fixture(t);
  enqueueSupervisor('supervisor', '[org-report] original', { inbox: f.inbox, id: 'escalation' });
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'autopilot', id: 'escalation', result: { disposition: 'escalate', summary: '[org-report] policy escalation' } }) + '\n');
  await f.transfer.enroll();
  await f.transfer.drain(f.adapter, async () => f.binding);
  assert.deepEqual(f.sent, ['[org-report] policy escalation notice-id=escalation']);
  assert.equal(readInbox(f.inbox)[0].message, '[org-report] original');
});

test('a compatibility drain rechecks enrollment after winning its drain lock', async t => {
  const f = await fixture(t);
  enqueueSupervisor('supervisor', 'fenced notice', { inbox: f.inbox, id: 'fenced' });
  await f.transfer.enroll();
  const exists = fs.existsSync; let reads = 0;
  t.mock.method(fs, 'existsSync', function (file) {
    if (file === `${f.inbox}.transport-fixture` && ++reads === 1) return false;
    return exists.call(this, file);
  });
  const result = await drainInbox(f.inbox, { waitSeconds: 0 });
  assert.match(result.delivery_error, /offline fixture intake is fenced/);
  assert.equal(readInbox(f.inbox)[0].state, 'pending');
});

test('an unanswered question without a correlation field remains visible after consumption', async t => {
  const f = await fixture(t), e = f.event(); delete e.correlationId;
  await f.accept(e);
  await f.receiver.consume(e.eventId, f.key, { consumer: 'supervisor-reader' });
  assert.deepEqual(transportStatus(f.root).openThreads, [e.eventId]);
});

test('bootstrap durably creates an empty compatibility log before publishing the intake fence', async t => {
  const f = await fixture(t), sync = fs.fsyncSync, exists = fs.existsSync;
  let logSynced = false, directorySyncedAfterLog = false;
  t.mock.method(fs, 'fsyncSync', fd => {
    const stat = fs.fstatSync(fd);
    if (exists(f.inbox) && stat.ino === fs.statSync(f.inbox).ino && stat.isFile()) logSynced = true;
    if (stat.isDirectory() && logSynced && !exists(`${f.inbox}.transport-fixture`)) directorySyncedAfterLog = true;
    return sync(fd);
  });
  await f.transfer.enroll();
  assert.equal(logSynced, true);
  assert.equal(directorySyncedAfterLog, true, 'file and directory durability precede intake fencing');
  assert.equal(fs.readFileSync(f.inbox, 'utf8'), '');
  assert.equal((await promptSupervisor('supervisor', 'durable spool', { inbox: f.inbox, id: 'new-arrival' })).queued, true);
  assert.equal(readInbox(f.inbox)[0].id, 'new-arrival');
});

test('inspected non-delivery retries the same refused ID only through its original quiet transport, then later work proceeds', async t => {
  const f = await fixture(t), first = f.event(), later = f.event();
  await f.accept(first); await f.accept(later);
  f.runtime.mode = 'refuse';
  assert.equal((await f.deliver()).state, 'refused');
  for (const options of [{ disposition: 'pending' }, { disposition: 'pending', evidence: ' ' }, { disposition: 'delivered', evidence: 'inspected' }])
    await assert.rejects(f.receiver.resolveRefused(first.eventId, f.key, options), /inspection evidence/);
  assert.equal(f.receiver.state().entries[0].state, 'refused');
  const release = fs.openSync(path.join(f.root, 'delivery.lock'), 'wx');
  await assert.rejects(f.receiver.resolveRefused(first.eventId, f.key, { disposition: 'pending', evidence: 'verified no input; original edge cleared' }), /EEXIST/);
  fs.closeSync(release); fs.unlinkSync(path.join(f.root, 'delivery.lock'));
  const receipt = await f.receiver.resolveRefused(first.eventId, f.key, { disposition: 'pending', evidence: 'verified no input; original edge cleared' });
  assert.equal(receipt.retryTransport, f.adapter.id);
  const restarted = new Receiver({ root: f.root });
  let fallback = 0;
  const held = await restarted.deliverNext({ id: 'other-transport', deliver: () => { fallback++; } }, () => assert.fail('alternate edge cannot resolve a binding'));
  assert.equal(held.state, 'pending'); assert.match(held.reason, /original transport/); assert.equal(fallback, 0);
  f.runtime.mode = ''; f.runtime.text = screen('codex', 'typed');
  assert.equal((await f.deliver()).state, 'pending', 'retry still needs an empty composer');
  assert.equal(f.calls.filter(args => args[1] === 'prompt').length, 1);
  f.runtime.text = screen('codex');
  assert.equal((await f.deliver()).eventId, first.eventId);
  assert.equal((await f.deliver()).eventId, later.eventId);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[0], new RegExp(`id=${JSON.stringify(first.eventId)}`));
  assert.match(f.sent[1], new RegExp(`id=${JSON.stringify(later.eventId)}`));
  assert.equal((await f.accept(first)).duplicate, true);
});

test('retained refusal is a known fenced-drain disposition, preserves content and never calls a replacement adapter', async t => {
  const f = await fixture(t), first = f.event(); await f.accept(first); await f.transfer.enroll();
  await f.transfer.fence('switch');
  const late = f.event(); await f.accept(late);
  f.runtime.mode = 'refuse';
  assert.equal((await f.transfer.drain(f.adapter, async () => f.binding)).state, 'refused');
  assert.equal((await f.transfer.finish('switch')).switched, false);
  await assert.rejects(f.receiver.resolveRefused(first.eventId, f.key, { disposition: 'retained-refused' }), /inspection evidence/);
  const retained = f.receiver.state().entries[0];
  const disposition = await f.receiver.resolveRefused(first.eventId, f.key, { disposition: 'retained-refused', evidence: 'inspected native refusal; retain without another offer' });
  assert.equal(disposition.state, 'retained-refused');
  assert.deepEqual(f.transfer.status().retainedRefused, [first.eventId]);
  assert.deepEqual(f.transfer.status().refused, []);
  await assert.rejects(f.receiver.consume(first.eventId, f.key, { consumer: 'supervisor-reader' }), /delivery hold/);
  assert.equal(await f.receiver.deliverNext({ id: 'replacement', deliver: () => assert.fail('retained refusal replayed') }, async () => f.binding), null, 'spooled work remains fenced');
  assert.equal((await f.transfer.finish('switch')).owner, 'envelope');
  f.runtime.mode = '';
  assert.equal((await f.transfer.drain(f.adapter, async () => f.binding)).eventId, late.eventId);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0], new RegExp(`id=${JSON.stringify(late.eventId)}`));
  assert.equal((await f.transfer.switch('reverse')).owner, 'legacy');
  const restarted = new Receiver({ root: f.root }), original = restarted.state().entries[0];
  assert.equal(original.state, 'retained-refused');
  assert.deepEqual(original.event, retained.event); assert.deepEqual(original.bodies, retained.bodies);
  assert.equal((await f.accept(first)).duplicate, true);
  assert.equal(await restarted.deliverNext({ id: 'replacement', deliver: () => assert.fail('retained refusal replayed after reverse') }, async () => f.binding), null);
});

test('a refusal with unknown historical transport can be retained without guessing an edge for retry', async t => {
  const f = await fixture(t), e = f.event(); await f.accept(e);
  await f.receiver.deliverNext({ deliver: async (_p, _b, { beforePrompt }) => { beforePrompt(); return { state: 'refused' }; } }, async () => f.binding);
  await assert.rejects(f.receiver.resolveRefused(e.eventId, f.key, { disposition: 'pending', evidence: 'no input, but edge identity unavailable' }), /original transport is unknown/);
  assert.equal(f.receiver.state().entries[0].state, 'refused');
  await f.receiver.resolveRefused(e.eventId, f.key, { disposition: 'retained-refused', evidence: 'retain without a guessed replay path' });
  assert.equal(await f.deliver(), null);
});

for (const code of ['agent_blocked', 'agent_not_found']) test(`known-not-delivered legacy ${code} retry imports pending and drains with its original notice ID`, async t => {
  const f = await fixture(t), text = '[watch-blocked] original notice';
  enqueueSupervisor('supervisor', text, { inbox: f.inbox, id: 'old-retry' });
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'sending', id: 'old-retry' }) + '\n');
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'retry', id: 'old-retry', error: code, may_have_delivered: false }) + '\n');
  assert.equal(readInbox(f.inbox)[0].state, 'pending');
  await f.transfer.enroll();
  const imported = f.receiver.state().entries[0];
  assert.equal(imported.state, 'accepted'); assert.equal(imported.legacy.disposition, null);
  assert.deepEqual(f.transfer.status().refused, []); assert.deepEqual(f.transfer.status().uncertain, []);
  assert.equal((await f.transfer.switch()).switched, false);
  assert.equal((await f.transfer.drain(f.adapter, async () => f.binding)).eventId, imported.event.eventId);
  assert.deepEqual(f.sent, [`${text} notice-id=old-retry`]);
  assert.equal((await f.transfer.finish('switch')).owner, 'envelope');
  await f.transfer.syncIntake(); assert.equal(f.receiver.state().entries.length, 1);
});

test('enrollment waits for an in-flight autopilot result before importing immutable legacy delivery bytes', async t => {
  const f = await fixture(t), original = '[org-report] original', escalation = '[org-report] policy escalation';
  enqueueSupervisor('supervisor', original, { inbox: f.inbox, id: 'policy-race' });
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'autopilot-started', id: 'policy-race', pid: process.pid }) + '\n');
  await assert.rejects(f.transfer.enroll(), /autopilot owner is live/);
  assert.equal(fs.existsSync(`${f.inbox}.transport-fixture`), false);
  assert.equal(f.receiver.state().entries.length, 0, 'no provisional summary was imported');
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'autopilot', id: 'policy-race', result: { disposition: 'escalate', summary: escalation } }) + '\n');
  await f.transfer.enroll(); await f.transfer.syncIntake(); await f.transfer.fence('switch');
  assert.equal((await f.transfer.finish('switch')).switched, false);
  await f.transfer.drain(f.adapter, async () => f.binding);
  assert.deepEqual(f.sent, [`${escalation} notice-id=policy-race`]);
  assert.equal((await f.transfer.finish('switch')).owner, 'envelope');
  assert.equal(readInbox(f.inbox)[0].message, original);
  assert.equal(f.receiver.state().entries[0].legacy.deliveryMessage, escalation);
});
