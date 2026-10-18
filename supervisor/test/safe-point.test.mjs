import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safePoint } from '../safe-point.mjs';
import { renderSafePoint } from '../../lib/render.mjs';

const row = (pid, ppid, command = 'opaque-process', state = 'S') => ({ pid, ppid, pgid: 20, identity: `birth-${pid}`, command, state });
function fixture(t) {
  const org = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-point-')));
  t.after(() => fs.rmSync(org, { recursive: true, force: true }));
  fs.writeFileSync(path.join(org, 'events.jsonl'), '');
  fs.mkdirSync(path.join(org, 'supervisor'));
  const inbox = path.join(org, 'supervisor/inbox.log'), calls = [];
  const state = { pane: { pane_id: 'w:p', workspace_id: 'w', terminal_id: 't' },
    agents: [{ pane_id: 'w:p', workspace_id: 'w', terminal_id: 't', name: 'supervisor', agent_session: { value: 'session' }, agent: 'opaque' }],
    info: { shell_pid: 10, foreground_processes: [{ pid: 20 }] }, rows: [row(10, 1, 'shell'), row(20, 10, 'harness')] };
  const call = args => {
    calls.push(args);
    if (args.join(' ') === 'pane get w:p') return { pane: { ...state.pane } };
    if (args.join(' ') === 'agent list') return { agents: structuredClone(state.agents) };
    if (args.join(' ') === 'pane process-info --pane w:p') return { process_info: state.info };
    throw Error(`unexpected Herdr operation: ${args.join(' ')}`);
  };
  const readProcess = () => ({ ok: true, value: new Map(state.rows.map(r => [r.pid, r])) });
  const check = (options = {}) => safePoint({ org, pane: 'w:p', call, readProcess, ...options });
  const notices = events => fs.writeFileSync(inbox, events.map(e => JSON.stringify(e) + '\n').join(''));
  return { org, state, inbox, calls, call, check, notices };
}
function bytes(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true }).sort().map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    return [name, { mode: stat.mode, mtime: stat.mtimeMs, bytes: stat.isFile() ? fs.readFileSync(file).toString('hex') : null }];
  }));
}

test('safe point reports an idle harness as safe using only read APIs and changes no files', t => {
  const f = fixture(t), before = bytes(f.org), doc = f.check();
  assert.equal(doc.safe, true); assert.deepEqual(doc.reasons, []); assert.equal(doc.agent, 'supervisor');
  assert.match(renderSafePoint(doc), /SAFE/); assert.deepEqual(bytes(f.org), before);
  assert.deepEqual(f.calls, [['pane', 'get', 'w:p'], ['agent', 'list'], ['pane', 'process-info', '--pane', 'w:p'], ['pane', 'get', 'w:p'], ['agent', 'list']]);
});

test('safe point finds background children and grandchildren, excludes unrelated and dead processes', t => {
  const f = fixture(t);
  f.state.rows.push(row(30, 20, 'background build'), row(31, 30, 'nested job'), row(40, 10, 'unrelated shell job'), row(50, 20, 'defunct', 'Z'));
  const doc = f.check();
  assert.equal(doc.safe, false); assert.deepEqual(doc.reasons.map(r => r.pid), [30, 31]);
  assert.ok(doc.reasons.every(r => r.kind === 'child_process')); assert.match(renderSafePoint(doc), /PID 31.*nested job/);
});

test('safe point excludes its own observer ancestry but retains sibling jobs and opaque nested harness children', t => {
  const f = fixture(t);
  f.state.rows.push(row(30, 20, 'observer shell'), row(process.pid, 30, 'check itself'), row(98, process.pid, 'native observation helper'),
    row(31, 30, 'sibling job'), row(32, 20, 'opaque native child'));
  assert.deepEqual(f.check().reasons.map(r => r.pid), [31, 32]);
});

for (const owner of ['live', 'stale', 'missing']) test(`safe point reports a held record lock with ${owner} owner without recovering it`, t => {
  const f = fixture(t), lock = path.join(f.org, 'lock'); fs.mkdirSync(lock);
  if (owner !== 'missing') fs.writeFileSync(path.join(lock, 'pid'), owner === 'live' ? String(process.pid) : '2147483647');
  const before = bytes(f.org), doc = f.check();
  assert.equal(doc.safe, false); assert.equal(doc.reasons[0].kind, 'record_lock'); assert.match(doc.reasons[0].message, /record lock present/);
  assert.deepEqual(bytes(f.org), before);
});

test('safe point names undelivered and unacknowledged notices only for the pane agent', t => {
  const f = fixture(t);
  f.notices([
    { type: 'notice', id: 'pending', to: 'supervisor' },
    { type: 'notice', id: 'uncertain', to: 'supervisor' }, { type: 'sending', id: 'uncertain' },
    { type: 'notice', id: 'delivered', to: 'supervisor' }, { type: 'sent', id: 'delivered' },
    { type: 'notice', id: 'handled', to: 'supervisor' }, { type: 'autopilot', id: 'handled', result: { disposition: 'handled' } },
    { type: 'notice', id: 'other-agent', to: 'peer' },
  ]);
  const before = bytes(f.org), doc = f.check();
  assert.deepEqual(doc.reasons.map(r => [r.kind, r.id]), [['undelivered_notice', 'pending'], ['unacknowledged_notice', 'uncertain']]);
  assert.deepEqual(bytes(f.org), before);
  f.notices([{ type: 'notice', id: 'delivered', to: 'supervisor' }, { type: 'sent', id: 'delivered' }]);
  assert.equal(f.check().safe, true, 'sent is Herdr delivery acknowledgement; model consumption is unknown');
});

test('safe point accumulates all independent reasons without mutating or prompting', t => {
  const f = fixture(t); f.state.rows.push(row(30, 20, 'build'));
  fs.mkdirSync(path.join(f.org, 'lock')); f.notices([{ type: 'notice', id: 'pending', to: 'supervisor' }]);
  const before = bytes(f.org), doc = f.check();
  assert.deepEqual(doc.reasons.map(r => r.kind), ['child_process', 'record_lock', 'undelivered_notice']);
  assert.deepEqual(bytes(f.org), before); assert.match(renderSafePoint(doc), /HOLD/);
});

for (const variant of ['process-source', 'missing-process', 'ambiguous-root', 'bad-inbox', 'torn-inbox', 'dangling-inbox', 'unaddressed-notice', 'no-agent', 'two-agents', 'changed-agent']) {
  test(`safe point preserves uncertainty for ${variant}`, t => {
    const f = fixture(t); let options = {};
    if (variant === 'process-source') options.readProcess = () => ({ ok: false, error: 'sandbox denied native observation' });
    if (variant === 'missing-process') f.state.rows.pop();
    if (variant === 'ambiguous-root') { f.state.rows.push(row(21, 10)); f.state.info.foreground_processes.push({ pid: 21 }); }
    if (variant === 'bad-inbox') fs.writeFileSync(f.inbox, '{broken}\n');
    if (variant === 'torn-inbox') fs.writeFileSync(f.inbox, '{"type":"notice"');
    if (variant === 'dangling-inbox') fs.symlinkSync(path.join(f.org, 'missing'), f.inbox);
    if (variant === 'unaddressed-notice') f.notices([{ type: 'notice', id: 'lost-address' }]);
    if (variant === 'no-agent') f.state.agents = [];
    if (variant === 'two-agents') f.state.agents.push({ ...f.state.agents[0], name: 'other' });
    if (variant === 'changed-agent') options.call = args => {
      if (f.calls.length === 3) f.state.agents[0].agent_session.value = 'replacement';
      return f.call(args);
    };
    const before = bytes(f.org), doc = f.check(options);
    assert.equal(doc.safe, false); assert.ok(doc.reasons.some(r => r.kind === 'unknown'));
    assert.deepEqual(bytes(f.org), before);
  });
}

test('safe-point CLI emits reasons and a hold exit code without requiring Git or supervisor mutation role', t => {
  const f = fixture(t), bin = path.join(f.org, 'fake-herdr.mjs');
  fs.writeFileSync(bin, `#!${process.execPath}\nconst args=process.argv.slice(2).join(' ');let result;
if(args==='pane get w:p')result=${JSON.stringify({ pane: f.state.pane })};
else if(args==='agent list')result=${JSON.stringify({ agents: f.state.agents })};
else if(args==='pane process-info --pane w:p')result={process_info:{}};
else throw Error('mutation or unexpected command: '+args);
console.log(JSON.stringify({result}));\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(f.org, 'lock')); f.notices([{ type: 'notice', id: 'waiting', to: 'supervisor' }]);
  const before = bytes(f.org), cli = fileURLToPath(new URL('../supervisor.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'safe-point', '--pane', 'w:p', '--org', f.org, '--herdr', bin, '--json'], { encoding: 'utf8', cwd: f.org });
  assert.equal(result.status, 1, result.stderr); assert.equal(result.stderr, '');
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.safe, false); assert.ok(doc.reasons.some(r => r.kind === 'record_lock'));
  assert.ok(doc.reasons.some(r => r.kind === 'undelivered_notice')); assert.deepEqual(bytes(f.org), before);
});
