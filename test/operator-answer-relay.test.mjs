import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupOrg } from './helpers.mjs';
import { fixtureFleet } from './helpers/offline-herdr.mjs';
import { fold as foldV0, itemStatus as statusV0 } from './fixtures/state-v0.mjs';
import { humanAnswerEvidence } from '../lib/human-answer.mjs';

const saidAt = '2026-09-15T08:50:00-00:00';
const relayOptions = ['--relay-operator', '--source', 'Operator conversation, message 17', '--said-at', saidAt];
function fixture(t) {
  const f = setupOrg(), root = fs.realpathSync(f.root);
  fixtureFleet(t, root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const binding = { actor: 'operator-chat', common: path.join(root, '.git'), server: path.join(root, 'native.sock'),
    workspace: 'chat', pane: 'chat:p1', terminal_id: 'chat-terminal', agent_session_id: 'chat-session' };
  const native = { name: binding.actor, cwd: root, pane_id: binding.pane, workspace_id: binding.workspace,
    terminal_id: binding.terminal_id, agent_session: { value: binding.agent_session_id } };
  const nativeFile = path.join(root, 'native.json'), callsFile = path.join(root, 'calls');
  const writeNative = () => fs.writeFileSync(nativeFile, JSON.stringify(native));
  writeNative();
  const herdr = path.join(root, 'fake-herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
if (fs.existsSync(${JSON.stringify(path.join(root, '.org/lock'))})) throw Error('native lookup under record lock');
if (fs.existsSync(${JSON.stringify(path.join(root, 'refused'))})) { console.error('native refusal'); process.exit(1); }
if (fs.existsSync(${JSON.stringify(path.join(root, 'race'))})) fs.appendFileSync(${JSON.stringify(path.join(root, '.org/events.jsonl'))}, JSON.stringify({seq:999,at:'2026-09-15T09:00:00.000Z',by:'other',type:'note.added',id:'G-1',text:'Concurrent note'})+'\\n');
if (fs.existsSync(${JSON.stringify(path.join(root, 'race-config'))})) { const file=${JSON.stringify(path.join(root, '.org/config.json'))}, config=JSON.parse(fs.readFileSync(file)); config.approvals.operator_relay.agent_session_id='replacement'; fs.writeFileSync(file,JSON.stringify(config)); }
console.log(JSON.stringify({ result: { agent: JSON.parse(fs.readFileSync(${JSON.stringify(nativeFile)}, 'utf8')) } }));
`, { mode: 0o755 });
  const env = { ORG_ACTOR: binding.actor, HERDR_ENV: '1', HERDR_SOCKET_PATH: binding.server,
    HERDR_PANE_ID: binding.pane, HERDR_WORKSPACE_ID: binding.workspace, CODEX_THREAD_ID: binding.agent_session_id,
    HERDR_BIN_PATH: herdr, HERDR_MONITOR_FLEET: process.env.HERDR_MONITOR_FLEET };
  const configFile = path.join(f.dir, 'config.json');
  const configure = value => {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (value === undefined) delete config.approvals.operator_relay;
    else config.approvals.operator_relay = value;
    fs.writeFileSync(configFile, JSON.stringify(config));
  };
  configure(binding);
  f.ok(['add', '--goal', 'Proving window']);
  f.ok(['add', 'Run the proving window', '--role', 'engineer', '--parent', 'G-1']);
  const ask = (category = 'priorities') => f.ok(['ask', 'Use one coordinated proving window?', '--parent', 'G-1',
    '--category', category, '--recommend', 'yes', '--why', 'Coordinate the work.', '--wait', '--blocks', 'ENG-1']).trim();
  const answer = (id, reply = 'Yes to both', extra = [], overrides = {}) =>
    f.org(['answer', id, reply, ...relayOptions, ...extra], { env: { ...env, ...overrides } });
  const calls = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { ...f, root, env, binding, native, writeNative, configure, ask, answer, calls };
}

test('a bound chat relays the operator priority answer with exact provenance and old-fold compatibility', t => {
  const f = fixture(t), id = f.ask(), before = f.events().length, verbatim = '  Yes to both.\nKeep the timing.  ';
  const result = f.answer(id, verbatim);
  assert.equal(result.code, 0, result.err);
  const events = f.events().slice(before), item = f.json(['show', id, '--json']);
  assert.deepEqual(events.map(e => e.type), ['note.added', 'item.updated', 'item.closed']);
  assert.ok(events.every(e => e.by === f.binding.actor));
  assert.equal(item.meta.answered_by, 'human');
  assert.equal(item.meta.answer, 'yes');
  assert.deepEqual(item.meta.answer_relay, { schema: 'operator-answer-relay/v1', operator: 'human', relayer: f.binding.actor,
    verbatim, source: 'Operator conversation, message 17', said_at: saidAt, record: fs.realpathSync(f.dir), binding: f.binding });
  assert.ok(item.notes.find(n => n.decision).text.includes(JSON.stringify(verbatim)));
  assert.equal(f.json(['show', 'ENG-1', '--json']).status, 'ready');
  assert.equal(statusV0(foldV0(f.events()), 'ENG-1'), 'ready');
  assert.equal(foldV0(f.events()).items.get(id).meta.answer, 'yes');
  assert.deepEqual(f.calls(), [['agent', 'get', f.binding.pane]]);
  // Relay attribution must not satisfy existing privileged human-transaction consumers.
  assert.throws(() => humanAnswerEvidence({ record: f.dir, ref: { id, seq: events[0].seq },
    field: 'session_authorization', validateScope() {} }), /attributed human record answer/);
});

test('relay declines and explicit overruling retain blocking semantics and immutable original provenance', t => {
  const f = fixture(t), id = f.ask();
  assert.equal(f.answer(id, 'No, wait.').code, 0);
  assert.equal(f.json(['show', 'ENG-1', '--json']).status, 'blocked');
  const before = f.events().length;
  assert.match(f.answer(id).err, /already answered no/);
  assert.match(f.answer(id, 'No', ['--overrule']).err, /must change the answer/);
  assert.equal(f.events().length, before);
  assert.equal(f.answer(id, 'Yes, proceed', ['--overrule']).code, 0);
  assert.equal(f.json(['show', 'ENG-1', '--json']).status, 'ready');
  assert.equal(f.events().filter(e => e.fields?.meta?.answer_relay).length, 2);
  f.ok(['answer', id, 'no', '--overrule']);
  assert.equal(f.json(['show', id, '--json']).meta.answer_relay, null, 'direct overrule clears current relay attribution');
  assert.equal(f.events().filter(e => e.fields?.meta?.answer_relay).length, 2, 'prior provenance stays in the log');
});

test('ordinary actors, human impersonation and missing or malformed relay bindings append nothing', t => {
  const f = fixture(t), id = f.ask(), before = f.events().length;
  assert.match(f.fail(['answer', id, 'yes'], { env: f.env }), /wait for the operator/);
  for (const actor of ['worker', 'supervisor', 'human', '']) assert.notEqual(f.answer(id, 'yes', [], { ORG_ACTOR: actor }).code, 0);
  for (const binding of [undefined, {}, { ...f.binding, actor: 'human' }, { ...f.binding, additional: 'untrusted' }]) {
    f.configure(binding);
    assert.match(f.answer(id).err, /explicit approvals.operator_relay native binding/);
  }
  assert.equal(f.events().length, before);
  assert.deepEqual(f.calls(), []);
});

test('relay requires source and timestamp and cannot apply to reserved categories or reserved priority questions', t => {
  const f = fixture(t), id = f.ask(), before = f.events().length;
  for (const options of [[], ['--source', 'Conversation'], ['--said-at', saidAt],
    ['--source', 'Conversation', '--said-at', '2026-09-15T08:50:00'],
    ['--source', 'Conversation', '--said-at', '2026-09-16T08:50:00Z']]) {
    assert.notEqual(f.org(['answer', id, 'yes', '--relay-operator', ...options], { env: f.env }).code, 0);
  }
  assert.match(f.fail(['answer', id, 'yes', '--source', 'Conversation']), /require --relay-operator/);
  assert.equal(f.events().length, before);
  for (const category of ['security', 'funds-and-chain', 'publish', 'delete-data', 'licensing', 'design']) {
    const question = f.ask(category), count = f.events().length;
    assert.match(f.answer(question).err, /limited to non-reserved priority questions/);
    assert.equal(f.events().length, count, category);
  }
  f.ok(['set', id, 'meta.operator_reserved=true']);
  const count = f.events().length;
  assert.match(f.answer(id).err, /limited to non-reserved priority questions/);
  assert.match(f.fail(['answer', id, 'yes'], { env: f.env }), /priority questions wait/);
  assert.match(f.fail(['close', id], { env: f.env }), /reserved for the operator/);
  assert.equal(f.events().length, count);
  assert.deepEqual(f.calls(), []);
  f.ok(['set', id, 'meta.reserved=true']);
  assert.match(f.answer(id).err, /limited to non-reserved priority questions/);
});

test('native environment, source project and occupant changes fail closed even with the chat actor name', t => {
  const f = fixture(t), id = f.ask(), before = f.events().length;
  for (const overrides of [{ HERDR_ENV: '' }, { HERDR_PANE_ID: 'worker:p1' }, { HERDR_WORKSPACE_ID: 'foreign' },
    { HERDR_SOCKET_PATH: '/foreign.sock' }, { CODEX_THREAD_ID: 'replacement' }])
    assert.notEqual(f.answer(id, 'yes', [], overrides).code, 0);
  for (const key of ['pane_id', 'workspace_id', 'terminal_id', 'name', 'cwd']) {
    const old = f.native[key]; f.native[key] = key === 'cwd' ? path.dirname(f.root) : 'replacement'; f.writeNative();
    assert.notEqual(f.answer(id).code, 0, key);
    f.native[key] = old;
  }
  f.native.agent_session.value = 'replacement'; f.writeNative();
  assert.notEqual(f.answer(id).code, 0);
  f.native.agent_session.value = f.binding.agent_session_id; f.writeNative();
  f.configure({ ...f.binding, common: path.dirname(f.binding.common) });
  assert.match(f.answer(id).err, /source Git common-directory differs/);
  assert.equal(f.events().length, before);
});

test('a native refusal and a concurrent record change stop the relay without lookup replay or an answer', t => {
  const f = fixture(t), id = f.ask(), before = f.events().length;
  fs.writeFileSync(path.join(f.root, 'refused'), '');
  assert.match(f.answer(id).err, /native refusal/);
  assert.equal(f.events().length, before); assert.equal(f.calls().length, 1);
  fs.unlinkSync(path.join(f.root, 'refused'));
  fs.writeFileSync(path.join(f.root, 'race-config'), '');
  assert.notEqual(f.answer(id).code, 0);
  assert.equal(f.events().length, before); assert.equal(f.calls().length, 2);
  fs.unlinkSync(path.join(f.root, 'race-config')); f.configure(f.binding);
  fs.writeFileSync(path.join(f.root, 'race'), '');
  assert.notEqual(f.answer(id).code, 0);
  assert.equal(f.calls().length, 3, 'one lookup per explicit invocation, none replayed');
  assert.equal(f.events().length, before + 1, 'only the concurrent note was written');
  assert.equal(f.json(['show', id, '--json']).meta.answer, undefined);
});
