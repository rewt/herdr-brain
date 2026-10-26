import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtureFleet } from './helpers/offline-herdr.mjs';
import { initOrg, loadEvents, transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { nativeSender, makeEnvelope, prepareEnvelope, pushReserved, operatorDigest, recordMessages, pushId } from '../messages/operator-inbox.mjs';
import { enqueueSupervisor, readInbox, drainInbox, resolveNotice } from '../supervisor/prompt-supervisor.mjs';
import { renderOperatorDigest } from '../lib/render.mjs';

const cli = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const empty = fs.readFileSync(new URL('../supervisor/test/fixtures/claude-empty.ansi', import.meta.url), 'utf8');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'operator-inbox-')));
  fixtureFleet(t, root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']); fs.writeFileSync(path.join(root, '.identity-root'), '');
  git(['add', '.identity-root']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const common = path.join(root, '.git'), org = path.join(root, '.org'), inbox = path.join(org, 'supervisor/inbox.log');
  initOrg(org);
  const sender = { name: 'worker', agent: 'codex', pane_id: 'fake:p1', workspace_id: 'fake', cwd: root,
    terminal_id: 'terminal-worker', agent_session: { value: 'session-worker' } };
  const target = { name: 'brain-chat', agent: 'claude', pane_id: 'fake:p2', workspace_id: 'fake', cwd: root,
    terminal_id: 'terminal-brain', agent_session: { value: 'session-brain' }, agent_status: 'idle', interactive_ready: true };
  const targets = { 'fake:p1': sender, 'brain-chat': target };
  const writeTargets = () => fs.writeFileSync(path.join(root, 'targets'), JSON.stringify(targets));
  writeTargets();
  const env = { ...process.env, ORG_DIR: org, ORG_ACTOR: 'worker', HERDR_ENV: '1', HERDR_PANE_ID: 'fake:p1',
    HERDR_WORKSPACE_ID: 'fake', CODEX_THREAD_ID: 'session-worker', PATH: `${root}:${process.env.PATH}` };
  const herdr = path.join(root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
import fs from 'node:fs';
const root=${JSON.stringify(root)}, inbox=${JSON.stringify(inbox)}, a=process.argv.slice(2);
const targets=JSON.parse(fs.readFileSync(root+'/targets','utf8')), mode=fs.existsSync(root+'/mode')?fs.readFileSync(root+'/mode','utf8'):'';
fs.appendFileSync(root+'/calls',JSON.stringify(a)+'\\n');
if(a[0]==='agent'&&a[1]==='get') {
 const agent=targets[a[2]];
 if(mode==='changed-final'&&a[2]==='brain-chat'&&fs.existsSync(inbox)&&fs.readFileSync(inbox,'utf8').trim().split('\\n').map(JSON.parse).at(-1)?.type==='sending') agent.agent_session.value='replacement';
 console.log(JSON.stringify({result:{agent}}));
} else if(a[0]==='pane'&&a[1]==='read') process.stdout.write(${JSON.stringify(empty)});
else if(a[0]==='agent'&&a[1]==='prompt') {
 if(mode==='refused') {console.error(JSON.stringify({error:{code:'agent_blocked'}}));process.exit(1);}
 fs.appendFileSync(root+'/sent',JSON.stringify(a)+'\\n');
 if(mode==='lost-ack') {console.error(JSON.stringify({error:{code:'UNKNOWN',message:'ack lost'}}));process.exit(1);}
 console.log('{}');
} else if(a[0]==='notification') console.log('{}'); else process.exit(2);
`, { mode: 0o755 });
  const invoke = (_binary, args) => execFileSync(herdr, args, { env, encoding: 'utf8' });
  const binding = () => nativeSender(org, { cwd: root, env, call: invoke });
  transact(org, () => ({ add: [
    { type: 'item.added', id: 'ENG-1', title: 'Work', role: 'engineer' },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: root, meta: { agent: sender.name, pane: sender.pane_id,
      worker_workspace: sender.workspace_id, terminal_id: sender.terminal_id, agent_session_id: sender.agent_session.value } },
    { type: 'run.claimed', run: 'R-1', record: org, project: common,
      owner: { controller: 'brain', legacy: false, release: { root, id: 'source', commit: null, identity: common } } },
    { type: 'item.added', id: 'HUM-1', title: 'Reserved decision', role: 'human', meta: { operator_reserved: true, category: 'publish' } },
    { type: 'item.added', id: 'HUM-2', title: 'Technical judgment', role: 'human', meta: { category: 'design' } },
  ] }));
  const append = input => transact(org, events => {
    const b = binding(), e = makeEnvelope({ id: 'message-1', summary: 'Progress', run: 'R-1', item: 'ENG-1', ...input }, b, events);
    return prepareEnvelope(e, b, fold(events), events);
  });
  const push = (envelope, extra = {}) => pushReserved(envelope, binding(), fold(loadEvents(org).events), {
    call: invoke, enqueue: (to, message, options) => enqueueSupervisor(to, message, { ...options, herdr, mirror: () => {} }),
    resume: async () => {}, ...extra,
  });
  const drain = () => drainInbox(inbox, { id: readInbox(inbox)[0]?.id, owner: true, confirmSeconds: 0, waitSeconds: 1, pollSeconds: .01 });
  const sent = () => fs.existsSync(path.join(root, 'sent')) ? fs.readFileSync(path.join(root, 'sent'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, org, inbox, env, sender, target, targets, writeTargets, binding, append, push, drain, sent };
}

test('routine operator status/fyi/done/needs-decision envelopes persist without native input or inbox enqueue', async t => {
  const f = fixture(t);
  for (const [id, kind] of [['status', 'notice'], ['fyi', 'fyi'], ['done', 'notice'], ['needs-decision', 'question']]) {
    const saved = f.append({ id, kind, summary: id, question: 'HUM-2' });
    assert.equal((await f.push(saved.result)).state, 'record-only');
  }
  assert.equal(recordMessages(loadEvents(f.org).events).length, 4);
  assert.deepEqual(readInbox(f.inbox), []); assert.deepEqual(f.sent(), []);
});

test('stable IDs survive repeated/restarted input; changed content, target and producer key are refused', t => {
  const f = fixture(t), first = f.append({ correlation: 'thread', kind: 'reply', replyTo: 'question-before' });
  assert.equal(f.append({ correlation: 'thread', kind: 'reply', replyTo: 'question-before' }).added.length, 0);
  const child = spawnSync(process.execPath, [cli, 'messages', 'send', '--id', 'message-1', '--summary', 'Progress', '--run', 'R-1', '--item', 'ENG-1',
    '--kind', 'reply', '--correlation', 'thread', '--reply-to', 'question-before'], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(recordMessages(loadEvents(f.org).events).length, 1);
  assert.throws(() => f.append({ summary: 'Changed' }), /different content or target/);
  const events = loadEvents(f.org).events, state = fold(events), changed = structuredClone(first.result);
  changed.eventId = 'different-id';
  assert.throws(() => prepareEnvelope(changed, f.binding(), state, events), /producer key/);
  changed.eventId = 'message-1'; changed.payload.to[0].role.bindingRef = 'operator-pane';
  assert.throws(() => prepareEnvelope(changed, f.binding(), state, events), /operator envelope binding/);
});

test('an actual reserved ask queues one native Brain Chat pointer, delivers once and keeps its receipt after restart', async t => {
  const f = fixture(t), e = f.append({ kind: 'question', question: 'HUM-1', correlation: 'decision-thread' }).result;
  const first = await f.push(e);
  assert.equal(first.state, 'pending'); assert.equal(first.id, pushId(f.org, 'HUM-1'));
  await f.push(e); assert.equal(readInbox(f.inbox).length, 1);
  await f.push(f.append({ id: 'another-message-same-ask', kind: 'question', question: 'HUM-1', correlation: 'new-thread' }).result);
  assert.equal(readInbox(f.inbox).length, 1, 'a new envelope cannot push the same reserved ask twice');
  const entry = readInbox(f.inbox)[0];
  assert.equal(entry.to, 'brain-chat');
  assert.deepEqual(entry.correlation, { run: 'R-1', record: f.org, project: path.join(f.root, '.git') });
  assert.equal((await f.drain()).delivered, true);
  assert.equal((await f.push(e)).state, 'sent'); await f.drain();
  assert.equal(f.sent().length, 1); assert.equal(f.sent()[0][2], 'brain-chat');
  assert.doesNotMatch(f.sent()[0][3], /Progress/);
});

test('a reserved reference in routine content, claimed evidence, or a resolved ask never promotes T2 to reserved', async t => {
  const f = fixture(t), status = f.append({ kind: 'fyi', question: 'HUM-1' }).result;
  assert.equal((await f.push(status)).state, 'record-only');
  const question = f.append({ id: 'T2', kind: 'question', question: 'HUM-2' }).result;
  question.payload.evidence = { operator_reserved: true, tier: 'T3' };
  assert.equal((await f.push(question)).state, 'record-only');
  transact(f.org, () => ({ add: [{ type: 'item.closed', id: 'HUM-1', as: 'done' }] }));
  const answered = f.append({ id: 'answered', kind: 'question', question: 'HUM-1' }).result;
  assert.equal((await f.push(answered)).state, 'record-only'); assert.deepEqual(readInbox(f.inbox), []);
});

test('short on-demand digests retain stable record references, correlation and reply IDs without reading bodies', t => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) f.append({ id: `m${i}`, kind: 'reply', correlation: 'thread', replyTo: 'q1', summary: `Done ${i}` });
  const events = loadEvents(f.org).events, doc = operatorDigest(events, f.org);
  assert.equal(doc.messages.length, 5); assert.equal(doc.total, 7); assert.equal(doc.remaining, 2);
  assert.deepEqual(doc.messages.map(m => m.id), ['m2', 'm3', 'm4', 'm5', 'm6']);
  assert.equal(doc.messages[0].correlation, 'thread'); assert.equal(doc.messages[0].reply_to, 'q1');
  assert.equal(doc.messages[0].refs[0].run, 'R-1'); assert.match(renderOperatorDigest(doc), /thread=thread reply=q1/);
  const page = operatorDigest(events, f.org, { after: 0, limit: 2 });
  assert.deepEqual(page.messages.map(m => m.id), ['m0', 'm1']);
  assert.equal(operatorDigest(events, f.org, { after: page.next, limit: 2 }).messages[0].id, 'm2');
  for (const limit of [0, 21, NaN]) assert.throws(() => operatorDigest(events, f.org, { limit }), /digest/);
});

test('foreign/missing origin, claim, references and Brain Chat native binding fail truthfully with envelopes retained', async t => {
  const f = fixture(t), binding = f.binding(), events = loadEvents(f.org).events, state = fold(events);
  const e = makeEnvelope({ id: 'reserved', kind: 'question', summary: 'Ask', run: 'R-1', question: 'HUM-1' }, binding, events);
  const missing = { ...binding, native: { ...binding.native, terminal_id: 'foreign' } };
  assert.throws(() => prepareEnvelope(e, missing, state, events), /origin/);
  const wrong = structuredClone(e); wrong.payload.refs.push({ orgRef: f.org, item: 'ENG-404' });
  assert.throws(() => prepareEnvelope(wrong, binding, state, events), /reference/);
  const wrongRun = structuredClone(events);
  wrongRun.find(entry => entry.type === 'run.started').meta.agent_session_id = 'different';
  assert.throws(() => prepareEnvelope(e, binding, fold(wrongRun), wrongRun), /worker binding/);
  const saved = f.append({ kind: 'question', question: 'HUM-1' }).result;
  delete f.targets['brain-chat']; f.writeTargets();
  await assert.rejects(f.push(saved), /recipient binding/);
  assert.equal(recordMessages(loadEvents(f.org).events).length, 1); assert.deepEqual(readInbox(f.inbox), []);
  assert.throws(() => nativeSender(f.org, { cwd: f.root, env: {} }), /native caller binding/);
});

test('the existing native final-read guard holds instead of sending to a changed occupant', async t => {
  const f = fixture(t), e = f.append({ kind: 'question', question: 'HUM-1' }).result;
  await f.push(e);
  fs.writeFileSync(path.join(f.root, 'mode'), 'changed-final');
  assert.equal((await f.drain()).delivered, false); assert.deepEqual(f.sent(), []);
  assert.match(fs.readFileSync(f.inbox, 'utf8'), /no input attempted/);
  assert.throws(() => enqueueSupervisor('operator-pane', readInbox(f.inbox)[0].message,
    { inbox: f.inbox, id: pushId(f.org, 'HUM-1'), mirror: () => {} }), /different content or target/);
});

test('ambiguous native delivery is never replayed; explicit existing recovery retains the once-only receipt', async t => {
  const f = fixture(t), e = f.append({ kind: 'question', question: 'HUM-1' }).result;
  await f.push(e); fs.writeFileSync(path.join(f.root, 'mode'), 'lost-ack');
  assert.equal((await f.drain()).delivered, false); assert.equal(f.sent().length, 1);
  assert.equal((await f.push(e)).state, 'uncertain'); await f.drain(); assert.equal(f.sent().length, 1);
  assert.equal(operatorDigest(loadEvents(f.org).events, f.org).messages[0].push, 'uncertain');
  resolveNotice(f.inbox, pushId(f.org, 'HUM-1'), true);
  assert.equal((await f.push(e)).state, 'sent'); assert.equal(f.sent().length, 1);
});

test('native pre-input refusal and owner failure preserve their actual pending state without a delivery claim', async t => {
  const f = fixture(t), e = f.append({ kind: 'question', question: 'HUM-1' }).result;
  const receipt = await f.push(e, { resume: async () => { throw Error('kill EPERM'); } });
  assert.equal(receipt.state, 'pending'); assert.equal(receipt.error, 'kill EPERM');
  fs.writeFileSync(path.join(f.root, 'mode'), 'refused');
  assert.equal((await f.drain()).delivered, false); assert.deepEqual(f.sent(), []);
  assert.equal(readInbox(f.inbox)[0].state, 'pending'); assert.match(readInbox(f.inbox)[0].error, /agent_blocked/);
});
