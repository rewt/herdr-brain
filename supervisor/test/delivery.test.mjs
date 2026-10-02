import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from '../../test/helpers/bounded-test.mjs';
import { composerEmpty } from '../composer.mjs';
import { promptSupervisor, readInbox, resolveNotice } from '../prompt-supervisor.mjs';

process.env.ORG_ACTOR = 'supervisor-delivery-test';
const fixtureText = (name) => fs.readFileSync(new URL(`./fixtures/${name}.ansi`, import.meta.url), 'utf8');
for (const harness of ['claude', 'codex']) {
  test(`${harness}: captured ANSI empty, typed and placeholder composers`, () => {
    assert.equal(composerEmpty(fixtureText(`${harness}-empty`), harness), true);
    assert.equal(composerEmpty(fixtureText(`${harness}-placeholder`), harness), true);
    assert.equal(composerEmpty(fixtureText(`${harness}-typed`), harness), false);
    assert.equal(composerEmpty('', harness), false);
    assert.equal(composerEmpty('old output without a composer', harness), false);
  });
}
test('compound styles, wrapped typing, and normal text identical to a placeholder remain busy', () => {
  const claude = fixtureText('claude-empty');
  assert.equal(composerEmpty(claude.replace('❯\u00a0', '❯\u00a0\x1b[0;2;38;2;153;153;153mTry this\x1b[0m'), 'claude'), true);
  assert.equal(composerEmpty(claude.replace('❯\u00a0', '❯\u00a0\x1b[2mTry this\x1b[22;39mtyped'), 'claude'), false);
  assert.equal(composerEmpty(claude.replace('❯\u00a0', '❯\u00a0\n  wrapped input'), 'claude'), false);
  const codex = fixtureText('codex-placeholder');
  assert.equal(composerEmpty(codex.replace('\x1b[2m', '\x1b[22m'), 'codex'), false);
  assert.equal(composerEmpty(fixtureText('codex-empty').replace('›', '›\n  wrapped input'), 'codex'), false);
  assert.equal(composerEmpty(claude, 'unrecognized-harness'), false);
});

function fixture(t, harness = 'claude') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inbox = path.join(root, 'inbox.log'), herdr = path.join(root, 'herdr');
  fs.writeFileSync(path.join(root, 'screen'), fixtureText(`${harness}-typed`));
  fs.writeFileSync(path.join(root, 'status'), 'idle');
  fs.writeFileSync(herdr, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const root=${JSON.stringify(root)}, args=process.argv.slice(2), file=(name)=>path.join(root,name);
fs.appendFileSync(file('calls'), JSON.stringify(args)+'\\n');
if(args[0]==='agent'&&args[1]==='get') console.log(JSON.stringify({result:{agent:{agent:${JSON.stringify(harness)},pane_id:'fake:p1',terminal_id:fs.existsSync(file('occupant'))?fs.readFileSync(file('occupant'),'utf8'):'same',agent_status:fs.readFileSync(file('status'),'utf8')}}}));
else if(args[0]==='pane'&&args[1]==='read') {
 if(fs.existsSync(file('read-fail'))) process.exit(1);
 process.stdout.write(fs.readFileSync(file('screen'),'utf8'));
}
else if(args[0]==='agent'&&args[1]==='prompt') {
 if(!fs.readFileSync(file('inbox.log'),'utf8').includes(args[3])) throw Error('prompt before durable inbox');
 if(fs.existsSync(file('reject'))) {fs.unlinkSync(file('reject'));console.error(JSON.stringify({error:{code:'agent_blocked'}}));process.exit(1);}
 fs.appendFileSync(file('sent'), JSON.stringify(args[3])+'\\n');
 if(fs.existsSync(file('lost-ack'))) process.exit(1);
 console.log('{}');
} else if(args[0]==='notification'&&args[1]==='show') console.log('{}');
else process.exit(2);
`, { mode: 0o755 });
  const calls = () => fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const sent = () => fs.existsSync(path.join(root, 'sent')) ? fs.readFileSync(path.join(root, 'sent'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const clear = () => fs.writeFileSync(path.join(root, 'screen'), fixtureText(`${harness}-empty`));
  const options = { inbox, herdr, waitSeconds: 5, confirmSeconds: 0.02, pollSeconds: 0.01, retrySeconds: 0.01 };
  return { root, inbox, herdr, calls, sent, clear, options };
}
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (!fn() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fn(), 'bounded wait for fake Herdr evidence');
}

for (const harness of ['claude', 'codex']) {
  test(`${harness}: a notice arriving during typing is durable, notifies without focus, and delivers intact after clearing`, async (t) => {
    const f = fixture(t, harness), logs = [];
    const pending = promptSupervisor('supervisor-test', '[org-report] run=R-125', { ...f.options, id: 'report', log: (line) => logs.push(line) });
    await until(() => f.calls().some((args) => args[0] === 'notification'));
    assert.equal(readInbox(f.inbox)[0].message, '[org-report] run=R-125');
    assert.deepEqual(f.sent(), []);
    f.clear();
    assert.equal((await pending).delivered, true);
    assert.deepEqual(f.sent(), ['[org-report] run=R-125']);
    assert.match(logs.join('\n'), /delivered after waiting .* s for an empty input box/);
    assert.ok(f.calls().every((args) => ['agent', 'pane', 'notification'].includes(args[0]) && !args.includes('focus')));
    assert.deepEqual(f.calls().filter((args) => args[0] === 'pane').at(-1), ['pane', 'read', 'fake:p1', '--lines', '14', '--format', 'ansi']);
  });
}
test('two quiet reads use the default three-second separation', async (t) => {
  const f = fixture(t); f.clear();
  const started = Date.now();
  assert.equal((await promptSupervisor('supervisor', 'default-window', { ...f.options, confirmSeconds: undefined })).delivered, true);
  assert.ok(Date.now() - started >= 3000);
});
test('typing between quiet reads restarts the confirmation window', async (t) => {
  const f = fixture(t); f.clear();
  const pending = promptSupervisor('supervisor', 'notice', { ...f.options, confirmSeconds: 0.25 });
  await until(() => f.calls().some((args) => args[0] === 'pane'));
  fs.writeFileSync(path.join(f.root, 'screen'), fixtureText('claude-typed'));
  await until(() => f.calls().some((args) => args[0] === 'notification'));
  assert.deepEqual(f.sent(), []); f.clear();
  assert.equal((await pending).delivered, true);
});
test('non-idle status, unknown layout and failed reads retain capped notices', async (t) => {
  for (const state of ['working', 'blocked', 'unknown', 'unreadable', 'layout']) {
    const f = fixture(t); f.clear();
    if (state === 'unreadable') fs.writeFileSync(path.join(f.root, 'read-fail'), '1');
    else if (state === 'layout') fs.writeFileSync(path.join(f.root, 'screen'), 'no footer');
    else fs.writeFileSync(path.join(f.root, 'status'), state);
    const result = await promptSupervisor('supervisor', state, { ...f.options, waitSeconds: 0 });
    assert.equal(result.delivered, false); assert.equal(result.queued, true);
    assert.deepEqual(f.sent(), []); assert.equal(readInbox(f.inbox)[0].state, 'pending');
  }
});
test('cap retains FIFO; a later caller drains older notices once, with stable-id deduplication', async (t) => {
  const f = fixture(t);
  const options = { ...f.options, waitSeconds: 0, id: 'first' };
  assert.equal((await promptSupervisor('supervisor', 'first', options)).delivered, false);
  assert.equal((await promptSupervisor('supervisor', 'first', options)).delivered, false);
  assert.equal(readInbox(f.inbox).length, 1);
  f.clear();
  assert.equal((await promptSupervisor('supervisor', 'second', { ...f.options, id: 'second' })).delivered, true);
  assert.deepEqual(f.sent(), ['first', 'second']);
  assert.equal((await promptSupervisor('supervisor', 'first', options)).delivered, true);
  assert.deepEqual(f.sent(), ['first', 'second']);
  await assert.rejects(promptSupervisor('supervisor', 'changed', options), /different content/);
});
test('concurrent callers serialize notices without interleaving or duplicate prompts', async (t) => {
  const f = fixture(t);
  const first = promptSupervisor('supervisor', 'first', { ...f.options, id: 'first' });
  const second = promptSupervisor('supervisor', 'second', { ...f.options, id: 'second' });
  await until(() => readInbox(f.inbox).length === 2);
  f.clear();
  assert.ok((await Promise.all([first, second])).every((result) => result.delivered));
  assert.deepEqual(f.sent(), ['first', 'second']);
});
test('a definite pre-input refusal retries through the empty-composer gate', async (t) => {
  const f = fixture(t); f.clear(); fs.writeFileSync(path.join(f.root, 'reject'), '1');
  assert.equal((await promptSupervisor('supervisor', 'notice', f.options)).delivered, true);
  assert.deepEqual(f.sent(), ['notice']);
  assert.equal(f.calls().filter((args) => args[0] === 'pane').length, 4);
});
test('lost prompt acknowledgement holds FIFO until explicit inspection, without automatic duplication', async (t) => {
  const f = fixture(t); f.clear(); fs.writeFileSync(path.join(f.root, 'lost-ack'), '1');
  const first = await promptSupervisor('supervisor', 'first', { ...f.options, id: 'first' });
  assert.match(first.delivery_error, /uncertain/);
  fs.unlinkSync(path.join(f.root, 'lost-ack'));
  assert.equal((await promptSupervisor('supervisor', 'second', { ...f.options, id: 'second' })).delivered, false);
  assert.deepEqual(f.sent(), ['first']);
  assert.ok(f.calls().some((args) => args[0] === 'notification' && args.includes('second')), 'each queued notice raises a non-focusing notification');
  resolveNotice(f.inbox, 'first', true);
  assert.equal((await promptSupervisor('supervisor', 'second', { ...f.options, id: 'second' })).delivered, true);
  assert.deepEqual(f.sent(), ['first', 'second']);
});
test('torn inbox tails fail closed and preserve their bytes', async (t) => {
  const f = fixture(t); fs.writeFileSync(f.inbox, '{"type":"notice"');
  await assert.rejects(promptSupervisor('supervisor', 'notice', f.options), /torn inbox tail/);
  assert.equal(fs.readFileSync(f.inbox, 'utf8'), '{"type":"notice"');
  assert.deepEqual(f.calls(), []);
});
