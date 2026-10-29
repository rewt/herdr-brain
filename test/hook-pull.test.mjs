import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Receiver, addressKey } from '../messages/receiver.mjs';
import * as retired from '../messages/hook-pull.mjs';
import { hookHandoff, readHookSession } from '../messages/hook-pull.mjs';
import { historicalHookClaim } from './helpers/historical-messages.mjs';
import { persistHandoff, verifyHandoff } from '../sessions/lifecycle-evidence.mjs';
const script = new URL('../messages/hook-pull.mjs', import.meta.url).pathname;

async function fixture(t, kind = 'claude') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-transport-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'FIXTURE'), 'brain.transport-fixture/v1\n', { mode: 0o600 });
  const common = path.join(root, '.git'), address = { identity: 'fixture', projectRef: common, session: { uid: 'worker', incarnation: 'first' } };
  fs.mkdirSync(common);
  const sender = { identity: 'fixture', projectRef: common, role: { name: 'project-supervisor', bindingRef: 'supervisor' } };
  const recipient = addressKey(address), receiver = new Receiver({ root });
  await receiver.initialize({ supervisor: sender, recipients: [{ address: sender, consumer: 'sender' }, { address, consumer: 'worker-launch' }],
    senders: [{ receipt: 'sender-launch', address: sender, producer: 'sender', epoch: 'e1', recipients: [recipient], bodyRoots: [root] }] });
  const session = { schema: 'brain.hook-session/v1', root, common, cwd: root, address, recipient, consumer: 'worker-launch', kind,
    role: 'worker', humanTyped: false, rendering: 'plain' };
  const sessionFile = path.join(root, 'session.json');
  fs.writeFileSync(sessionFile, JSON.stringify(session), { mode: 0o600 });
  let sequence = 0;
  const event = (kind = 'request') => ({ schema: 'brain.log/v1', eventId: `sender:${++sequence}`, producer: { id: 'sender', epoch: 'e1', sequence },
    occurredAt: '2026-10-16T18:00:00Z', type: 'session.message.v1', level: 'info', identity: 'fixture', project: { commonDir: common },
    correlationId: `thread:${sequence}`, payload: { from: sender, to: [address], kind, refs: [], reply_to: null,
      priority: 'normal', reply_by: null, summary: 'Read <this> "message"', body_ref: null, decision_ref: null } });
  const input = (hook_event_name = 'Stop', extra = {}) => ({ session_id: 'native-1', cwd: root, hook_event_name, ...extra });
  const accept = e => receiver.accept(e, { sender: 'sender-launch', recipient });
  const run = input => spawnSync(process.execPath, [script, '--session', sessionFile], { input: JSON.stringify(input), encoding: 'utf8' });
  return { root, common, session, sessionFile, receiver, recipient, event, input, accept, run };
}

for (const kind of ['claude', 'codex']) test(`${kind}: saved hook commands are inert and preserve pending work and descriptors`, async t => {
  const f = await fixture(t, kind), e = f.event(); await f.accept(e);
  const journal = path.join(f.root, 'transport.jsonl'), before = fs.readFileSync(journal);
  const descriptor = fs.readFileSync(f.sessionFile);
  for (const input of [f.input(), f.input('UserPromptSubmit', { prompt: 'inbox' })]) {
    const result = f.run(input);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout + result.stderr, '');
  }
  assert.deepEqual(fs.readFileSync(journal), before);
  assert.deepEqual(fs.readFileSync(f.sessionFile), descriptor);
  assert.equal(f.receiver.state().entries[0].state, 'accepted');
  assert.equal(retired.hookOutput, undefined);
  assert.equal(f.receiver.claimNext, undefined);
});

test('historical claims remain inspectable and join hashed handoffs until explicitly consumed', async t => {
  const f = await fixture(t), e = f.event(); await f.accept(e);
  await historicalHookClaim(f.receiver, e.eventId, f.session);
  const journal = path.join(f.root, 'transport.jsonl'), before = fs.readFileSync(journal);
  const handoff = persistHandoff({ file: path.join(f.root, 'handoff.md'), markdown: '# Session handoff\n', recordRefs: [],
    unresolvedMessageIds: ['prior-unresolved'], inboxCursor: 'transport:3', hookSession: f.session });
  assert.deepEqual(handoff.unresolvedMessageIds, ['prior-unresolved', e.eventId]); verifyHandoff(handoff);
  const result = spawnSync(process.execPath, [script, 'handoff', '--session', f.sessionFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /sender:1/);
  assert.deepEqual(fs.readFileSync(journal), before);
  assert.deepEqual(readHookSession(f.sessionFile), f.session);
  assert.deepEqual(hookHandoff({ ...f.session, consumer: 'another-launch' }).claimedIds, []);
  await f.receiver.consume(e.eventId, f.recipient, { consumer: f.session.consumer });
  assert.deepEqual(hookHandoff(f.session).claimedIds, []);
});

test('inspection preserves an unknown delivery and refuses corrupt historical bytes without repair', async t => {
  const f = await fixture(t), e = f.event(); await f.accept(e);
  await historicalHookClaim(f.receiver, e.eventId, f.session);
  const journal = path.join(f.root, 'transport.jsonl'); fs.appendFileSync(journal, '{torn');
  const before = fs.readFileSync(journal);
  const result = spawnSync(process.execPath, [script, 'handoff', '--session', f.sessionFile], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /torn/);
  assert.deepEqual(fs.readFileSync(journal), before);
  assert.equal(f.run(f.input()).stdout, '');
  assert.deepEqual(fs.readFileSync(journal), before);
});
