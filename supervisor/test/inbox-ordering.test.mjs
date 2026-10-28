import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from '../../test/helpers/bounded-test.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { drainInbox, enqueueSupervisor, readInbox, resolveNotice, resumeInbox } from '../prompt-supervisor.mjs';
import { noticeLock } from '../notice-lock.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { initOrg, transact } from '../../lib/store.mjs';

const empty = fs.readFileSync(new URL('./fixtures/claude-empty.ansi', import.meta.url), 'utf8');
const typed = fs.readFileSync(new URL('./fixtures/claude-typed.ansi', import.meta.url), 'utf8');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-order-')));
  fixtureFleet(t, root);
  const inbox = path.join(root, 'inbox.log'), herdr = path.join(root, 'herdr');
  const target = name => ({ name, agent: 'claude', pane_id: `fake:${name}`, terminal_id: `terminal-${name}`,
    agent_session: { value: `session-${name}` }, workspace_id: 'fake', cwd: root, interactive_ready: true, agent_status: 'idle' });
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  const reset = () => { write('targets', { A: target('A'), alias: target('A'), B: target('B'), C: target('C') }); write('modes', {}); };
  reset();
  fs.writeFileSync(herdr, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const root=${JSON.stringify(root)}, args=process.argv.slice(2), file=n=>path.join(root,n);
const load=n=>JSON.parse(fs.readFileSync(file(n),'utf8')), targets=load('targets'), modes=load('modes');
fs.appendFileSync(file('calls'),JSON.stringify(args)+'\\n');
const fail=(code,message=code)=>{console.error(JSON.stringify({error:{code,message}}));process.exit(1);};
if(args[0]==='agent'&&args[1]==='get') {
 const agent=targets[args[2]];
 if(!agent) fail('agent_not_found');
 if(modes[args[2]]==='get-error') fail('native_unavailable','fixture recipient unavailable');
 if(modes[args[2]]==='changed-final'&&fs.readFileSync(file('inbox.log'),'utf8').trim().split('\\n').map(JSON.parse).at(-1)?.type==='sending') {
  agent.terminal_id+='-changed';fs.writeFileSync(file('targets'),JSON.stringify(targets));
 }
 console.log(JSON.stringify({result:{agent}}));
} else if(args[0]==='pane'&&args[1]==='read') {
 const name=Object.keys(targets).find(n=>targets[n]?.pane_id===args[2]), mode=modes[name];
 if(mode==='read-error') fail('READ_REFUSED','fixture unreadable composer');
 process.stdout.write(mode==='typed'?${JSON.stringify(typed)}:${JSON.stringify(empty)});
} else if(args[0]==='agent'&&args[1]==='prompt') {
 const mode=modes[args[2]];
 if(mode==='refused') fail('agent_blocked','fixture pre-input refusal');
 if(mode==='negative') {console.log(JSON.stringify({error:{code:'NATIVE_DENIED',message:'fixture negative acknowledgement'}}));process.exit(0);}
 const fd=fs.openSync(file('in-input'),'wx');
 fs.appendFileSync(file('sent'),JSON.stringify(args)+'\\n');
 fs.closeSync(fd);fs.unlinkSync(file('in-input'));
 if(mode==='lost-ack') fail('UNKNOWN','fixture acknowledgement lost after input');
 console.log('{}');
} else if(args[0]==='notification') console.log('{}'); else process.exit(2);
`, { mode: 0o755 });
  const rows = name => fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const options = { inbox, herdr, mirror: () => {}, confirmSeconds: .02, pollSeconds: .01, waitSeconds: 2, owner: true };
  const corr = run => ({ run, record: root, project: root });
  const add = (id, to, run, extra = {}) => enqueueSupervisor(to, id, { ...options, id, correlation: run ? corr(run) : undefined, ...extra });
  const drain = (id, extra = {}) => drainInbox(inbox, { ...options, id, ...extra });
  const state = id => readInbox(inbox).find(entry => entry.id === id)?.state;
  t.after(async () => {
    reset();
    for (const entry of readInbox(inbox).filter(entry => entry.state === 'uncertain'))
      resolveNotice(inbox, entry.id, rows('sent').some(args => args[3].endsWith(` notice-id=${entry.id}`)));
    await drain(undefined, { confirmSeconds: 0 });
    assert.ok(readInbox(inbox).every(entry => ['sent', 'handled'].includes(entry.state)), 'fixture finishes its retained journal');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, inbox, herdr, options, write, target, add, drain, state, corr, sent: () => rows('sent'), calls: () => rows('calls') };
}

for (const mode of ['working', 'blocked', 'get-error', 'read-error', 'typed', 'missing-binding'])
  test(`independent B receives while A is ${mode}, with A durably pending`, async t => {
    const f = fixture(t), A = f.target('A');
    if (['working', 'blocked'].includes(mode)) A.agent_status = mode;
    if (mode === 'missing-binding') delete A.terminal_id;
    f.write('targets', { A: mode === 'unavailable' ? null : A, B: f.target('B') });
    f.write('modes', { A: mode });
    f.add('first', 'A', 'R-1'); f.add('second', 'B', 'R-2');
    assert.equal((await f.drain('second')).delivered, true);
    assert.equal(f.state('first'), 'pending'); assert.equal(f.state('second'), 'sent');
    assert.deepEqual(f.sent().map(args => args[2]), ['B']);
    if (mode === 'get-error' || mode === 'read-error')
      assert.match(readInbox(f.inbox)[0].error, /fixture (recipient unavailable|unreadable composer)/);
  });

test('recipient FIFO holds while other recipients progress even with the same run correlation', async t => {
  const f = fixture(t); f.write('modes', { A: 'typed' });
  f.add('a1', 'A', 'R-1'); f.add('a2', 'A', 'R-2');
  f.add('same-run', 'B', 'R-1'); f.add('independent', 'C', 'R-3');
  assert.equal((await f.drain('independent')).delivered, true);
  assert.deepEqual(readInbox(f.inbox).map(e => e.state), ['pending', 'pending', 'sent', 'sent']);
  f.write('modes', {}); await f.drain();
  assert.deepEqual(f.sent().map(args => args[3]), ['same-run notice-id=same-run', 'independent notice-id=independent', 'a1 notice-id=a1', 'a2 notice-id=a2']);
});

test('absent recipients become durably undeliverable without input, rerouting or replay of the stable ID', async t => {
  const f = fixture(t); f.write('targets', { B: f.target('B') });
  f.add('gone', 'A', 'R-1'); f.add('gone-next', 'A', 'R-2'); f.add('independent', 'B', 'R-1');
  const receipt = await f.drain('gone');
  assert.equal(receipt.delivered, false); assert.equal(receipt.queued, false);
  assert.equal(receipt.undeliverable.reason, 'recipient-absent');
  await f.drain('independent');
  assert.deepEqual(readInbox(f.inbox).map(e => e.state), ['handled', 'handled', 'sent']);
  assert.deepEqual(f.sent().map(args => args[2]), ['B']);
  const bytes = fs.readFileSync(f.inbox, 'utf8');
  assert.equal(bytes.includes('"type":"sending","id":"gone"'), false);
  f.write('targets', { A: { ...f.target('A'), terminal_id: 'replacement' }, B: f.target('B') });
  f.add('gone', 'A', 'R-1');
  assert.equal((await f.drain('gone')).delivered, false);
  assert.equal(fs.readFileSync(f.inbox, 'utf8'), bytes);
  assert.equal(f.sent().length, 1);
});

function recordedRecipient(f, terminal) {
  const git = args => execFileSync('git', ['-C', f.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  const org = path.join(f.root, '.org'); initOrg(org);
  const agent = f.target('A');
  const start = id => ({ type: 'run.started', id, item: 'ENG-1', workspace: f.root,
    meta: { agent: agent.name, pane: agent.pane_id, worker_workspace: agent.workspace_id,
      terminal_id: agent.terminal_id, agent_session_id: agent.agent_session.value } });
  transact(org, () => ({ add: [
    { type: 'item.added', id: 'ENG-1', title: 'Recipient', role: 'engineer' }, start('R-1'),
    ...(terminal === 'finished' ? [{ type: 'report.ingested', run: 'R-1', report: { outcome: 'done' } }] :
      terminal === 'abandoned' ? [{ type: 'run.abandoned', id: 'R-1' }] : []),
  ] }));
  return { org, start, options: { org, cwd: f.root } };
}

for (const terminal of ['finished', 'abandoned']) test(`an exactly bound ${terminal} recipient has a recorded undeliverable outcome even with an open unknown pane`, async t => {
  const f = fixture(t), record = recordedRecipient(f, terminal), A = f.target('A'); A.agent_status = 'unknown';
  f.write('targets', { A, B: f.target('B') });
  f.add('terminal', 'A', undefined, record.options); f.add('independent', 'B', 'R-2');
  const receipt = await f.drain('terminal');
  assert.equal(receipt.delivered, false); assert.equal(receipt.queued, false);
  assert.equal(receipt.undeliverable.reason, `recipient-${terminal}`);
  assert.equal(receipt.undeliverable.run, 'R-1'); assert.ok(receipt.undeliverable.evidence_seq);
  await f.drain('independent');
  assert.deepEqual(f.sent().map(args => args[2]), ['B']);
  assert.equal(f.calls().some(args => args[0] === 'pane' && args[2] === A.pane_id), false);
  const events = fs.readFileSync(f.inbox, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.id === 'terminal' && e.type === 'autopilot' && e.result.disposition === 'handled' && e.result.undeliverable));
  assert.equal(events.some(e => e.id === 'terminal' && ['sending', 'sent'].includes(e.type)), false);
});

for (const changed of ['terminal', 'session', 'missing-session']) test(`a ${changed} identity mismatch cannot receive a finished worker's notice`, async t => {
  const f = fixture(t), record = recordedRecipient(f, 'finished'), A = f.target('A');
  if (changed === 'terminal') A.terminal_id += '-new';
  else if (changed === 'session') A.agent_session.value += '-new';
  else delete A.agent_session;
  f.write('targets', { A, B: f.target('B') });
  f.add('old', 'A', undefined, record.options); f.add('independent', 'B', 'R-2');
  await f.drain('independent');
  assert.equal(f.state('old'), 'pending'); assert.deepEqual(f.sent().map(args => args[2]), ['B']);
  assert.match(readInbox(f.inbox)[0].error, /recorded worker identity/);
  // This is a test-owned changed binding; restore it for ordinary teardown.
});

test('native done is deliverable without a terminal record, and an open same-session continuation is preserved', async t => {
  const f = fixture(t), record = recordedRecipient(f, 'finished'), A = f.target('A'); A.agent_status = 'done';
  transact(record.org, () => ({ add: [record.start('R-2')] }));
  f.write('targets', { A }); f.add('continuation', 'A', undefined, record.options);
  assert.equal((await f.drain('continuation')).delivered, true);
  assert.equal(readInbox(f.inbox)[0].undeliverable, undefined);
  assert.equal(f.sent().length, 1);
});

test('an absent recipient never resolves or replaces an uncertain attempt', async t => {
  const f = fixture(t); f.add('unknown', 'A', 'R-1'); f.add('same-recipient', 'A', 'R-2'); f.add('independent', 'B', 'R-3');
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'sending', id: 'unknown',
    occupant: JSON.stringify(['fake:A', 'terminal-A', 'session-A', 'fake', f.root]) }) + '\n');
  f.write('targets', { B: f.target('B') });
  await f.drain('independent');
  assert.deepEqual(readInbox(f.inbox).map(e => e.state), ['uncertain', 'pending', 'sent']);
  assert.deepEqual(f.sent().map(args => args[2]), ['B']);
});

test('equal run numbers in different actual record scopes remain independent', async t => {
  const f = fixture(t), record = path.join(f.root, 'other-record'); fs.mkdirSync(record);
  f.write('modes', { A: 'typed' });
  f.add('a', 'A', 'R-1'); f.add('b', 'B', 'R-1', { correlation: { ...f.corr('R-1'), record } });
  assert.equal((await f.drain('b')).delivered, true); assert.equal(f.state('a'), 'pending');
});

for (const legacy of ['first', 'second', 'both']) test(`uncorrelated legacy ${legacy} entries retain recipient FIFO without holding independent recipients`, async t => {
  const f = fixture(t); f.write('modes', { A: 'typed' });
  f.add('a', 'A', legacy !== 'second' ? undefined : 'R-1');
  f.add('a-next', 'A', 'R-3');
  f.add('alias', 'alias', 'R-4');
  f.add('b', 'B', legacy !== 'first' ? undefined : 'R-2');
  assert.equal((await f.drain('b')).delivered, true);
  assert.deepEqual(readInbox(f.inbox).map(e => e.state), ['pending', 'pending', 'pending', 'sent']);
  assert.deepEqual(f.sent().map(args => args[2]), ['B']);
  // A new caller adopting an old ID must not retrospectively add metadata.
  if (legacy !== 'second') f.add('a', 'A', 'R-1');
  assert.equal(Boolean(readInbox(f.inbox)[legacy === 'second' ? 3 : 0].correlation), false);
  f.write('modes', {});
  // A capped drain is allowed to retain the final alias. Require its actual
  // completion with a load-adjusted allowance before asserting the whole FIFO,
  // while a second process competes for the same native-input lock.
  const options = { ...f.options, id: 'alias', waitSeconds: loadTimeout(10_000) / 1000 };
  const code = `import {drainInbox} from ${JSON.stringify(new URL('../prompt-supervisor.mjs', import.meta.url).href)};console.log(JSON.stringify(await drainInbox(process.argv[1],JSON.parse(process.argv[2]))));`;
  const contender = spawnChild(t, process.execPath, ['--input-type=module', '-e', code, f.inbox, JSON.stringify(options)]);
  const drained = await f.drain('alias', options), other = await waitForExit(contender);
  assert.equal(other.code, 0, other.stderr);
  assert.equal(JSON.parse(other.stdout).delivered, true, other.stdout);
  assert.equal(drained.delivered, true, JSON.stringify(drained));
  assert.deepEqual(f.sent().map(args => args[2]), ['B', 'A', 'A', 'alias']);
});

test('a legacy ambiguous attempt without an occupant holds all recipients until inspected recovery', async t => {
  const f = fixture(t); f.add('legacy', 'A'); f.add('b', 'B', 'R-2');
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'sending', id: 'legacy' }) + '\n');
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'retry', id: 'legacy', may_have_delivered: true }) + '\n');
  assert.equal((await f.drain('b', { waitSeconds: .15 })).delivered, false);
  assert.equal(f.state('legacy'), 'uncertain'); assert.deepEqual(f.sent(), []);
  assert.equal(fs.readFileSync(f.inbox, 'utf8').trim().split('\n').map(JSON.parse).some(e => e.type === 'sent'), false);
  resolveNotice(f.inbox, 'legacy', false);
  await f.drain();
  assert.deepEqual(f.sent().map(args => args[2]), ['A', 'B']);
});

test('a legacy ambiguous attempt with a saved occupant holds its recipient and aliases without replay', async t => {
  const f = fixture(t); f.add('legacy', 'A'); f.add('next', 'A', 'R-2');
  f.add('alias', 'alias', 'R-3'); f.add('b', 'B', 'R-4');
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'sending', id: 'legacy',
    occupant: JSON.stringify(['fake:A', 'terminal-A', 'session-A', 'fake', f.root]) }) + '\n');
  assert.equal((await f.drain('b')).delivered, true);
  assert.deepEqual(readInbox(f.inbox).map(e => e.state), ['uncertain', 'pending', 'pending', 'sent']);
  assert.deepEqual(f.sent().map(args => args[2]), ['B']);
  f.add('legacy', 'A', 'R-99');
  assert.equal(readInbox(f.inbox)[0].correlation, null);
  assert.equal(f.state('legacy'), 'uncertain');
});

test('live aliases share FIFO and concurrent drainers serialize native input to their actual occupant', async t => {
  const f = fixture(t); f.write('targets', { A: f.target('A'), alias: f.target('A') });
  f.add('first', 'A', 'R-1'); f.add('second', 'alias', 'R-2');
  const code = `import {drainInbox} from ${JSON.stringify(new URL('../prompt-supervisor.mjs', import.meta.url).href)};console.log(JSON.stringify(await drainInbox(process.argv[1],JSON.parse(process.argv[2]))));`;
  const children = ['first', 'second'].map(id => spawnChild(t, process.execPath, ['--input-type=module', '-e', code, f.inbox, JSON.stringify({ ...f.options, id })]));
  for (const result of await Promise.all(children.map(waitForExit))) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.sent().map(args => args[3]), ['first notice-id=first', 'second notice-id=second']);
  assert.equal(fs.existsSync(path.join(f.root, 'in-input')), false);
});

test('changed final binding never receives stale confirmed input; independent B continues', async t => {
  const f = fixture(t); f.write('modes', { A: 'changed-final' });
  f.add('a', 'A', 'R-1'); f.add('b', 'B', 'R-2');
  assert.equal((await f.drain('b')).delivered, true);
  assert.equal(f.state('a'), 'pending'); assert.deepEqual(f.sent().map(args => args[2]), ['B']);
  assert.ok(fs.readFileSync(f.inbox, 'utf8').includes('no input attempted'));
});

for (const mode of ['lost-ack', 'negative']) test(`${mode} holds dependent successors and actual aliases while independent B progresses`, async t => {
  const f = fixture(t); f.write('modes', { A: mode });
  f.write('targets', { A: f.target('A'), B: f.target('B'), C: f.target('C'), alias: f.target('A') });
  f.add('ambiguous', 'A', 'R-1'); f.add('same-recipient', 'A', 'R-2');
  f.add('same-run', 'C', 'R-1'); f.add('alias', 'alias', 'R-3'); f.add('independent', 'B', 'R-4');
  assert.equal((await f.drain('independent')).delivered, true);
  assert.deepEqual(readInbox(f.inbox).map(e => e.state), ['uncertain', 'pending', 'pending', 'pending', 'sent']);
  assert.equal(f.sent().filter(args => args[2] === 'A').length, mode === 'lost-ack' ? 1 : 0);
  assert.match(readInbox(f.inbox)[0].error, mode === 'negative' ? /NATIVE_DENIED/ : /acknowledgement lost/);
  const events = fs.readFileSync(f.inbox, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.some(e => e.id === 'ambiguous' && e.type === 'sent'), false);
  // Missing alias resolution cannot erase the attempted occupant dependency.
  f.write('targets', { A: null, alias: { ...f.target('A'), pane_id: 'moved:A', workspace_id: 'moved' }, B: f.target('B'), C: f.target('C') });
  await f.drain('alias', { waitSeconds: .15 }); assert.equal(f.state('alias'), 'pending');
});

test('crash recovery holds sending intent and legacy ambiguous retries without fabricating sent receipts', async t => {
  const f = fixture(t); f.add('crash', 'A', 'R-1'); f.add('b', 'B', 'R-2');
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'sending', id: 'crash', occupant: JSON.stringify(['fake:A', 'terminal-A', 'session-A', 'fake', f.root]) }) + '\n');
  assert.equal((await f.drain('b')).delivered, true); assert.equal(f.state('crash'), 'uncertain');
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'retry', id: 'crash', may_have_delivered: true }) + '\n');
  assert.equal(f.state('crash'), 'uncertain'); assert.deepEqual(f.sent().map(args => args[2]), ['B']);
  resolveNotice(f.inbox, 'crash', false);
  assert.equal((await f.drain('crash')).delivered, true);
});

test('concurrent producers deduplicate stable IDs and reject changed target, content, correlation and transport', async t => {
  const f = fixture(t);
  const code = `import {enqueueSupervisor} from ${JSON.stringify(new URL('../prompt-supervisor.mjs', import.meta.url).href)};enqueueSupervisor('A','stable',JSON.parse(process.argv[1]));`;
  const options = { ...f.options, id: 'stable', correlation: f.corr('R-1') };
  const children = [1, 2].map(() => spawnChild(t, process.execPath, ['--input-type=module', '-e', code, JSON.stringify(options)]));
  for (const result of await Promise.all(children.map(waitForExit))) assert.equal(result.code, 0, result.stderr);
  assert.equal(readInbox(f.inbox).length, 1);
  assert.throws(() => enqueueSupervisor('B', 'stable', options), /different content or target/);
  assert.throws(() => enqueueSupervisor('A', 'changed', options), /different content or target/);
  assert.throws(() => enqueueSupervisor('A', 'stable', { ...options, correlation: f.corr('R-2') }), /different correlation/);
  assert.throws(() => enqueueSupervisor('A', 'stable', { ...options, herdr: '/different/herdr' }), /different correlation or transport/);
  assert.throws(() => enqueueSupervisor('A', 'invalid', { ...options, correlation: { run: 'R-2' } }), /correlation needs/);
  await f.drain('stable'); await f.drain('stable');
  assert.equal(f.sent().length, 1); assert.equal(readInbox(f.inbox).length, 1);
});

test('a live old drain lock remains authoritative and is never bypassed by new recipient selection', async t => {
  const f = fixture(t); f.add('a', 'A', 'R-1'); f.add('b', 'B', 'R-2');
  const release = noticeLock(`${f.inbox}.drain.lock`);
  try {
    const bytes = fs.readFileSync(`${f.inbox}.drain.lock/owner.json`, 'utf8');
    assert.equal((await f.drain('b', { waitSeconds: .05 })).delivered, false);
    assert.deepEqual(f.sent(), []); assert.equal(fs.readFileSync(`${f.inbox}.drain.lock/owner.json`, 'utf8'), bytes);
  } finally { release(); }
  assert.equal((await f.drain('b')).delivered, true);
});

test('EPERM is an owner hold, never dead-owner recovery or permission to replace its lock', async t => {
  const f = fixture(t); f.add('a', 'A', 'R-1');
  fs.mkdirSync(`${f.inbox}.owner.lock`);
  const bytes = JSON.stringify({ pid: 987654321, argv: ['old-owner'] });
  fs.writeFileSync(`${f.inbox}.owner.lock/owner.json`, bytes);
  const original = process.kill;
  process.kill = () => { throw Object.assign(new Error('fixture owner lookup refused'), { code: 'EPERM' }); };
  try { await assert.rejects(resumeInbox(f.inbox), { code: 'EPERM' }); }
  finally { process.kill = original; }
  assert.equal(fs.readFileSync(`${f.inbox}.owner.lock/owner.json`, 'utf8'), bytes);
  assert.deepEqual(f.calls(), []);
  // This was a test-only inert fixture, never an actual native owner.
  fs.rmSync(`${f.inbox}.owner.lock`, { recursive: true });
});

test('a capped contender cannot append over another sender final-input intent', async t => {
  const f = fixture(t); f.add('a', 'A', 'R-1');
  fs.appendFileSync(f.inbox, JSON.stringify({ type: 'sending', id: 'a',
    occupant: JSON.stringify(['fake:A', 'terminal-A', 'session-A', 'fake', f.root]) }) + '\n');
  const release = noticeLock(`${f.inbox}.drain.lock`);
  try {
    const bytes = fs.readFileSync(f.inbox, 'utf8');
    assert.equal((await f.drain('a', { waitSeconds: 0 })).delivered, false);
    assert.equal(fs.readFileSync(f.inbox, 'utf8'), bytes);
    assert.deepEqual(f.calls(), []);
  } finally { release(); }
});
