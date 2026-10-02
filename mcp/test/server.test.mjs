import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createCli } from '../cli.mjs';

const SERVER = path.resolve(import.meta.dirname, '../server.mjs');
const BIN = path.resolve(import.meta.dirname, '../../bin/org.mjs');
const markdown = summary => `---\nrun: R-1\noutcome: done\nheadline: The scratch work is complete\nsummary: ${summary}\nproposals: []\n---\nEvidence.\n`;
const body = result => result.content.map(c => c.text).join('\n');

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-mcp-test-'));
  const env = { ...process.env, HOME: root, TMPDIR: root, ORG_DIR: '', ORG_ACTOR: 'arch14-test-agent', ORG_NOW: '2026-10-02T12:00:00Z', TZ: 'UTC',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.ORG_DIR;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function command(executable, args, cwd = root) {
    const r = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    return r.stdout;
  }
  return { root, env, command, org: args => command(process.execPath, [BIN, ...args]) };
}

async function connect(t, s, { args = [], cwd = s.root, env = {} } = {}) {
  const child = spawn(process.execPath, [SERVER, ...args], { cwd, env: { ...s.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', seq = 0;
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let reply;
    try { reply = JSON.parse(line); }
    catch { assert.fail(`Non-protocol stdout: ${line}`); }
    const task = pending.get(reply.id);
    if (task) { pending.delete(reply.id); clearTimeout(task.timer); task.resolve(reply); }
  });
  child.on('exit', code => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(`Server exited ${code}: ${stderr}`)); }
    pending.clear();
  });
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
    lines.close();
  });
  function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }
  function request(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}\n${stderr}`)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }
  const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'offline-stdio-test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'herdr-record');
  assert.ok(init.result.capabilities.tools);
  assert.ok(init.result.capabilities.resources);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    request, child, exited, stderr: () => stderr,
    async call(name, input = {}, { error = false } = {}) {
      const reply = await request('tools/call', { name: `record_${name}`, arguments: input });
      assert.equal(reply.error, undefined, JSON.stringify(reply));
      assert.equal(Boolean(reply.result.isError), error, body(reply.result));
      return reply.result;
    },
    async snapshot() {
      const reply = await request('resources/read', { uri: 'record://snapshot' });
      assert.equal(reply.error, undefined, JSON.stringify(reply));
      assert.equal(reply.result.contents[0].mimeType, 'text/markdown');
      return reply.result.contents[0].text;
    },
  };
}

test('stdio exposes every tool and resource and completes the record workflow offline', { timeout: 30000 }, async t => {
  const s = scratch(t);
  s.org(['init']);
  const client = await connect(t, s);
  const listed = (await client.request('tools/list')).result.tools;
  assert.deepEqual(listed.map(tool => tool.name).sort(), ['add', 'answer', 'ask', 'check', 'ingest', 'ready', 'show', 'start'].map(name => `record_${name}`).sort());
  assert.equal(listed.find(tool => tool.name === 'record_ready').annotations.readOnlyHint, true);
  assert.equal(listed.find(tool => tool.name === 'record_add').inputSchema.additionalProperties, false);
  const resources = (await client.request('resources/list')).result.resources;
  assert.deepEqual(resources.map(r => r.uri), ['record://snapshot']);
  assert.equal((await client.call('ready')).structuredContent.items.length, 0);
  assert.match(body(await client.call('add', { title: 'Scratch goal', goal: true })), /^G-1/);
  assert.match(body(await client.call('add', { title: 'Scratch task', parent: 'G-1', role: 'engineer', accept: ['Offline completion'], budget: { max_runs: 0 } })), /^ENG-1/);
  assert.deepEqual((await client.call('ready', { role: 'engineer' })).structuredContent.items.map(i => i.id), ['ENG-1']);
  assert.equal((await client.call('ready', { role: 'reviewer' })).structuredContent.items.length, 0);
  assert.match(await client.snapshot(), /Scratch task/);
  const question = (await client.call('ask', { question: 'Use this approach?', parent: 'G-1', category: 'design', recommend: 'yes', why: 'The scratch check proves it.', blocks: ['ENG-1'], wait: true })).content[0].text.trim();
  assert.equal(question, 'HUM-1');
  assert.equal((await client.call('ready')).structuredContent.items.length, 0);
  await client.call('answer', { id: question, answer: 'no', note: 'Try again.' });
  assert.equal((await client.call('ready')).structuredContent.items.length, 0);
  await client.call('answer', { id: question, answer: 'yes', overrule: true });
  const started = body(await client.call('start', { id: 'ENG-1', harness: 'scratch-harness', model: 'opaque-model', effort: 'arbitrary-effort', meta: { agent: 'scratch-agent' } }));
  assert.match(started, /R-1 started on ENG-1/);
  assert.match(started, /# Brief: run R-1/);
  assert.match(started, /Offline completion/);
  assert.equal((await client.call('ready')).structuredContent.items.length, 0);
  assert.equal(JSON.parse(body(await client.call('show', { id: 'R-1', json: true }))).meta.model, 'opaque-model');
  const before = fs.readFileSync(path.join(s.root, '.org/events.jsonl'), 'utf8');
  await client.call('check', { report: markdown('Scratch completion.') });
  assert.equal(fs.readFileSync(path.join(s.root, '.org/events.jsonl'), 'utf8'), before);
  assert.match(body(await client.call('ingest', { report: markdown('Scratch completion.'), run: 'R-1' })), /R-1 → done/);
  assert.match(body(await client.call('ingest', { report: markdown('Scratch completion.') })), /already recorded/);
  assert.match(body(await client.call('ingest', { report: markdown('A different result.') }, { error: true })), /already has a report/);
  assert.match(body(await client.call('show', { id: 'ENG-1' })), /Scratch completion/);
  assert.match(await client.snapshot(), /Scratch completion/);
  assert.equal(fs.readFileSync(path.join(s.root, '.org/reports/R-1.md'), 'utf8'), markdown('Scratch completion.'));
  const events = fs.readFileSync(path.join(s.root, '.org/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.every(event => event.by === 'arch14-test-agent' || event.by === 'run:R-1'));
  assert.equal(events.find(event => event.type === 'run.started').by, 'arch14-test-agent');
  assert.ok(!fs.readdirSync(s.root).some(name => name.startsWith('record-mcp-report-')));
  assert.equal(client.stderr(), '');
});

test('ready accepts omitted arguments while advertising and enforcing its strict role schema', { timeout: 20000 }, async t => {
  const s = scratch(t);
  s.env.ORG_ACTOR = 'arch14-ready-regression';
  s.org(['init']);
  const client = await connect(t, s);
  await client.call('add', { title: 'Engineer ready work', role: 'engineer' });
  await client.call('add', { title: 'Reviewer ready work', role: 'reviewer' });
  const tools = (await client.request('tools/list')).result.tools;
  const schema = tools.find(tool => tool.name === 'record_ready').inputSchema;
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required ?? [], []);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.role.type, 'string');
  assert.equal(schema.properties.role.minLength, 1);
  const before = fs.readFileSync(path.join(s.root, '.org/events.jsonl'), 'utf8');
  const reply = await client.request('tools/call', { name: 'record_ready' });
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.ok(!reply.result.isError, body(reply.result));
  assert.deepEqual(reply.result, await client.call('ready', {}));
  assert.deepEqual(reply.result.structuredContent.items.map(item => item.id).sort(), ['ENG-1', 'REV-1']);
  assert.deepEqual((await client.call('ready', { role: 'engineer' })).structuredContent.items.map(item => item.id), ['ENG-1']);
  for (const input of [{ role: 42 }, { role: '' }, { extra_field: true }]) {
    await client.call('ready', input, { error: true });
  }
  const invalid = await client.request('tools/call', { name: 'record_ready', arguments: null });
  assert.ok(invalid.error || invalid.result?.isError, 'explicit null remains invalid');
  const required = await client.request('tools/call', { name: 'record_show' });
  assert.ok(required.result.isError, 'required-input tools still reject omitted arguments');
  assert.equal(fs.readFileSync(path.join(s.root, '.org/events.jsonl'), 'utf8'), before);
});

test('stdio preserves CLI refusals, policy and literal arguments without partial writes', { timeout: 30000 }, async t => {
  const s = scratch(t);
  s.org(['init']);
  const client = await connect(t, s, { args: ['--actor', 'mcp-literal-test'] });
  await client.call('add', { title: 'Goal', goal: true });
  const title = '--goal $(touch INJECTED) `touch INJECTED2` "quoted"\nnext line';
  await client.call('add', { title, role: 'engineer', accept: ['--goal'], meta: { literal: 'a=b $(touch INJECTED3)' } });
  const doc = JSON.parse(body(await client.call('show', { id: 'ENG-1', json: true })));
  assert.equal(doc.title, title);
  assert.equal(doc.meta.literal, 'a=b $(touch INJECTED3)');
  for (const file of ['INJECTED', 'INJECTED2', 'INJECTED3']) assert.equal(fs.existsSync(path.join(s.root, file)), false);
  const log = () => fs.readFileSync(path.join(s.root, '.org/events.jsonl'), 'utf8');
  const before = log();
  await client.call('add', { title: 'Bad parent', parent: 'ENG-999' }, { error: true });
  await client.call('show', { id: '--json' }, { error: true });
  await client.call('start', { id: 'ENG-1', route: 'engineer', harness: 'other' }, { error: true });
  await client.call('check', { report: 'broken Markdown' }, { error: true });
  await client.call('check', {}, { error: true });
  await client.call('check', { file: 'missing', report: 'text' }, { error: true });
  await client.call('add', { title: 'Unknown argument', command: 'init' }, { error: true });
  await client.call('answer', { id: 'ENG-1', answer: 'yes' }, { error: true });
  assert.equal(log(), before);
  const question = { question: 'Use it?', parent: 'G-1', category: 'design', recommend: 'yes', why: 'An offline choice.' };
  await client.call('ask', question);
  assert.equal(JSON.parse(body(await client.call('show', { id: 'HUM-1', json: true }))).meta.answer, undefined);
  const configPath = path.join(s.root, '.org/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.approvals = { categories: { design: 'auto' } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  await client.call('ask', question);
  assert.equal(JSON.parse(body(await client.call('show', { id: 'HUM-2', json: true }))).meta.answered_by, 'auto');
  await client.call('ask', { ...question, wait: true });
  assert.equal(JSON.parse(body(await client.call('show', { id: 'HUM-3', json: true }))).meta.answer, undefined);
  assert.match(log(), /"by":"mcp-literal-test"/);
  assert.ok((await client.request('resources/read', { uri: 'record://missing' })).error);
  assert.ok((await client.request('unknown/method')).error);
});

test('stdio discovers a new Git project from a nested linked worktree with no user setup', { timeout: 30000 }, async t => {
  const s = scratch(t);
  s.command('git', ['init', '--initial-branch=main']);
  fs.writeFileSync(path.join(s.root, 'README.md'), 'Scratch project\n');
  s.command('git', ['add', 'README.md']);
  s.command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.test', 'commit', '-m', 'Scratch project']);
  const worker = path.join(s.root, 'worker');
  s.command('git', ['worktree', 'add', '-b', 'worker', worker]);
  const nested = path.join(worker, 'nested');
  fs.mkdirSync(nested);
  const client = await connect(t, s, { cwd: nested });
  assert.equal(fs.existsSync(path.join(s.root, '.org')), false, 'initialization handshake does not create a record');
  const ready = (await client.call('ready')).structuredContent;
  assert.equal(fs.realpathSync(ready.org), fs.realpathSync(path.join(s.root, '.org')));
  await client.call('add', { title: 'Discovered task' });
  assert.equal(fs.existsSync(path.join(worker, '.org')), false);
  assert.match(await client.snapshot(), /Discovered task/);
  assert.equal(fs.existsSync(path.join(s.root, '.config')), false);
});

test('explicit project and record paths support relative report files and exit on EOF', { timeout: 20000 }, async t => {
  const s = scratch(t);
  s.org(['init', 'chosen-record']);
  const client = await connect(t, s, { args: ['--cwd', s.root, '--org', 'chosen-record'], cwd: os.tmpdir() });
  await client.call('add', { title: 'File task', role: 'engineer' });
  await client.call('start', { id: 'ENG-1' });
  fs.writeFileSync(path.join(s.root, '--report.md'), markdown('File completion.'));
  await client.call('check', { file: '--report.md' });
  await client.call('ingest', { file: '--report.md' });
  assert.match(await client.snapshot(), /File completion/);
  client.child.stdin.end();
  assert.deepEqual(await client.exited, [0, null]);
});

test('CLI calls have a bound and report interrupted operations as uncertain', { timeout: 10000 }, async t => {
  const s = scratch(t);
  const cli = createCli({ cwd: s.root, env: s.env, timeout: 1 });
  t.after(() => cli.close());
  await assert.rejects(cli.run(['status']), /Inspect the record before retrying/);
});

test('stdio exits on SIGTERM without a daemon and defaults to an agent actor', { timeout: 10000 }, async t => {
  const s = scratch(t);
  s.org(['init']);
  const client = await connect(t, s, { env: { ORG_ACTOR: '' } });
  await client.call('add', { title: 'Default attribution' });
  const events = fs.readFileSync(path.join(s.root, '.org/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.find(event => event.type === 'item.added').by, 'record-mcp');
  client.child.kill('SIGTERM');
  assert.deepEqual(await client.exited, [0, null]);
});
