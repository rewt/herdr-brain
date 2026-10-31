import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initOrg, loadEvents, transact } from '../../lib/store.mjs';
import { fold } from '../../lib/state.mjs';
import { prepareHandoff } from '../../lib/handoffs.mjs';
import { gitProject } from '../../lib/project.mjs';
import { recordStandardSlot } from '../../sessions/receipts.mjs';
import { durableWrite, emptyJournal, runtimePaths } from '../../sessions/runtime.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { parseDuty, inspectDuty, runDuty, finishDuty, recoveryPlan } from '../finite-duty.mjs';
import { enterSupervisor } from '../entry.mjs';

const source = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
function fixture(t) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'finite-duty-')));
  fixtureFleet(t, scratch);
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  fs.writeFileSync(path.join(scratch, '.identity-root'), 'fixture\n');
  const cwd = path.join(scratch, 'project'); fs.mkdirSync(cwd);
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-qb', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(cwd, '.git/info/exclude'), '.org/\n.lane/\n');
  fs.writeFileSync(path.join(cwd, '.promote.json'), '{"to":"fixture-supervisor"}\n');
  fs.writeFileSync(path.join(cwd, '.housekeeping.json'), '{"enabled":false}\n');
  fs.writeFileSync(path.join(cwd, 'seed'), 'seed\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  const org = path.join(cwd, '.org'), common = gitProject(cwd).identity;
  initOrg(org);
  const native = { name: 'fixture-supervisor', cwd, pane_id: 'w:p', workspace_id: 'w', tab_id: 'tab',
    terminal_id: 'terminal', agent_session: { value: 'session-a' } };
  const env = { ...process.env, ORG_DIR: org, HERDR_ENV: '1', HERDR_PANE_ID: native.pane_id, HERDR_WORKSPACE_ID: 'w',
    HERDR_BRAIN_ROOT: source, CODEX_THREAD_ID: '', MONITOR_SESSION_ROLE: 'supervisor' };
  const bin = path.join(scratch, 'bin'), nativeFile = path.join(scratch, 'native.json'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.FINITE_DUTY_FIXTURE_NATIVE, 'utf8'));
const [kind, action] = process.argv.slice(2);
const result = kind === 'agent' && action === 'get' ? {agent: state.native}
  : kind === 'agent' && action === 'list' ? {agents: state.inventory}
  : kind === 'pane' && action === 'get' ? {pane: state.pane} : null;
if (!result) { process.stderr.write('isolated read-only native fixture refuses effect'); process.exit(1); }
process.stdout.write(JSON.stringify({result}));
`, { mode: 0o755 });
  Object.assign(env, { PATH: `${bin}:${env.PATH}`, FINITE_DUTY_FIXTURE_NATIVE: nativeFile });
  recordStandardSlot({ cwd, action: 'adopt', uid: 'fixture-supervisor', actor: native.name, why: 'isolated fixture only',
    slot: { server: env.HERDR_SOCKET_PATH, workspace: 'w', checkout: cwd, tab: 'tab', standardSlot: 'supervisor', panes: [{ pane: 'w:p', paneSlot: 'primary' }] } });
  const journal = emptyJournal(common);
  const bindLaunch = () => {
    const id = `isolated-launch-${native.agent_session.value}`, generation = journal.operations.length + 1, specDigest = 'a'.repeat(64);
    const binding = { server: env.HERDR_SOCKET_PATH, workspace: 'w', tab: 'tab', pane: 'w:p', checkout: cwd,
      terminalId: native.terminal_id, agentName: native.name, nativeSessionId: native.agent_session.value };
    journal.operations.push({ id, kind: 'start-standard-slot', uid: 'fixture-supervisor', generation, specDigest,
      spec: { role: 'supervisor', standardSlot: 'supervisor' }, state: 'acknowledged',
      target: Object.fromEntries(['server', 'workspace', 'tab', 'pane', 'checkout'].map(k => [k, binding[k]])),
      receipt: { operationId: id, uid: 'fixture-supervisor', generation, specDigest, binding } });
    durableWrite(runtimePaths(common).journal, journal);
  };
  bindLaunch(); // Offline controller evidence only; never enroll a real session.
  const owner = { controller: 'brain', legacy: false, release: { id: 'source', commit: null, root: source, identity: gitProject(source).identity } };
  const add = rows => transact(org, () => ({ add: rows }), { actor: native.name }).added;
  add([{ type: 'item.added', id: 'ENG-1', role: 'engineer', title: 'One recorded canonical duty', meta: {} },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: cwd, meta: {} },
    { type: 'run.claimed', run: 'R-1', owner, project: common, record: org }]);
  const events = () => loadEvents(org).events, run = fold(events()).runs.get('R-1');
  const observedAt = Date.now(), now = () => observedAt;
  const manifest = { schema: 'supervisor-duty/v1', id: 'duty-a', item: run.item, run: run.id,
    intent: 'Record the inspected project sequence through the existing canonical checkpoint tool.',
    project: { canonical: cwd, common, org, head: git('rev-parse', 'HEAD') },
    source_head: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    claim: { owner, generation: run.owner_generation }, duty: { kind: 'checkpoint', through: 3 },
    lifetime: { not_before: new Date(observedAt - 3600000).toISOString(), expires: new Date(observedAt + 3600000).toISOString() }, predecessor: null,
    successor: { owner: native.name, next_event: 'Fresh canonical session reads the next recorded duty.' },
    recovery: { owner: 'operator', planning_channel: 'brain-planning-chat', next_event: 'Pull the immutable handoff if the line cannot dispatch.' }, obligations: [] };
  const markdown = d => `# Recorded finite canonical duty\n\n\`\`\`brain-supervisor-duty\n${JSON.stringify(d, null, 2)}\n\`\`\`\n`;
  const save = d => transact(org, es => ({ add: [prepareHandoff(org, es, { workspace: 'w', slot: 'supervisor',
    bytes: Buffer.from(markdown(d)), author: native.name, at: new Date(now()) })] }), { actor: native.name }).added[0];
  const handoff = save(manifest), calls = [], inventory = [native];
  const pane = { pane_id: 'w:p', workspace_id: 'w', tab_id: 'tab', terminal_id: 'terminal' };
  const call = (_exe, args) => {
    calls.push(args);
    fs.writeFileSync(nativeFile, JSON.stringify({ native, inventory, pane }));
    let result;
    if (args[0] === 'agent' && args[1] === 'get') result = { agent: native };
    else if (args[0] === 'agent' && args[1] === 'list') result = { agents: inventory };
    else if (args[0] === 'pane' && args[1] === 'get') result = { pane };
    else if (args[0] === 'pane' && args[1] === 'process-info') result = { process_info: { shell_pid: 90, foreground_processes: [{ pid: 100 }] } };
    else assert.fail(`unexpected native effect: ${args}`);
    return JSON.stringify({ result });
  };
  const rows = new Map([
    [90, { pid: 90, ppid: 1, state: 'S', identity: 'shell-birth', command: 'fixture shell' }],
    [100, { pid: 100, ppid: 90, state: 'S', identity: 'harness-birth', command: 'fixture harness' }],
  ]);
  const options = { org, handoffSeq: handoff.seq, cwd, env, call, now, readProcess: () => ({ ok: true, value: rows }) };
  const next = result => save({ ...manifest, id: 'duty-b', predecessor: { start_seq: result.start.seq, result_seq: result.receipt.seq } });
  return { scratch, cwd, org, common, git, native, env, manifest, handoff, add, events, save, next, calls, inventory, pane, rows, options, markdown, bindLaunch };
}

test('two fresh native custodians execute only their recorded tool and carry actual receipts through immutable handoffs', t => {
  const f = fixture(t), initial = f.events(), r = runDuty(f.options);
  assert.equal(r.receipt.result.state, 'succeeded', JSON.stringify(r.receipt.result));
  const cursor = path.join(f.org, 'supervisor');
  assert.equal(r.start.native.session, 'session-a');
  assert.equal(r.start.claim.generation, f.manifest.claim.generation);
  assert.equal(r.termination_authorized, false, 'duty result cannot close a native session');
  assert.ok(fs.existsSync(cursor), 'existing checkpoint tool produced its real receipt');
  const next = f.next(r);
  const completed = finishDuty({ ...f.options, successorSeq: next.seq });
  assert.equal(completed.result_seq, r.receipt.seq);
  assert.equal(completed.successor_sha256, next.sha256);
  assert.equal(completed.safe_point.safe, true);
  assert.equal(completed.termination_authorized, false);
  assert.throws(() => runDuty({ ...f.options, handoffSeq: next.seq }), /fresh native session/);
  f.native.agent_session.value = 'session-b';
  f.bindLaunch();
  const second = runDuty({ ...f.options, handoffSeq: next.seq });
  assert.equal(second.receipt.result.state, 'succeeded', JSON.stringify(second.receipt.result));
  assert.equal(second.start.native.session, 'session-b');
  assert.ok(f.events().slice(initial.length).every(e => !['run.claimed', 'run.updated', 'run.abandoned'].includes(e.type)));
  assert.ok(f.calls.every(a => ['get', 'list', 'process-info'].includes(a[1])), 'no native start/input/close calls');
});

test('a lane cwd, borrowed supervisor label and another project cannot acquire canonical custody', t => {
  const f = fixture(t), lane = path.join(f.scratch, 'lane'); f.git('worktree', 'add', '-qb', 'lane/test', lane);
  f.native.cwd = lane;
  assert.throws(() => runDuty({ ...f.options, cwd: lane }), /canonical project supervisor/);
  f.native.cwd = f.cwd; f.native.name = 'worker-with-supervisor-label';
  assert.throws(() => runDuty(f.options), /canonical project supervisor/);
  f.native.name = 'fixture-supervisor';
  const foreign = path.join(f.scratch, 'foreign'); fs.mkdirSync(foreign);
  execFileSync('git', ['init', '-qb', 'main', foreign], { stdio: 'pipe' });
  f.native.cwd = foreign;
  assert.throws(() => runDuty({ ...f.options, cwd: foreign }), /record binding|canonical project supervisor/);
  assert.equal(f.events().some(e => e.type === 'supervisor.duty.started'), false);
});

for (const change of ['terminal', 'session', 'claim', 'head', 'dirty', 'occupant', 'enrollment', 'launch-binding', 'expired', 'STOP', 'HOLD', 'reserved', 'callback', 'unknown-input', 'refused-input'])
  test(`finite duty preserves ${change} refusal before invoking a tool`, t => {
    const f = fixture(t); let invoked = 0, call = f.options.call;
    if (change === 'terminal') f.pane.terminal_id = 'changed';
    if (change === 'session') f.env.CODEX_THREAD_ID = 'another-thread';
    if (change === 'claim') f.add([{ type: 'run.claimed', run: 'R-1', owner: f.manifest.claim.owner, record: f.org, project: f.common }]);
    if (change === 'head') { fs.writeFileSync(path.join(f.cwd, 'seed'), 'new\n'); f.git('commit', '-qam', 'unique source'); }
    if (change === 'dirty') fs.writeFileSync(path.join(f.cwd, 'untracked'), 'unsaved');
    if (change === 'occupant') f.inventory.push({ ...f.native, name: 'another', terminal_id: 'other-terminal' });
    if (change === 'enrollment') fs.unlinkSync(path.join(f.common, 'sessions/standard-slots.json'));
    if (change === 'launch-binding') fs.unlinkSync(runtimePaths(f.common).journal);
    if (change === 'expired') f.options.now = () => Date.parse(f.manifest.lifetime.expires);
    if (['STOP', 'HOLD'].includes(change)) { fs.mkdirSync(path.join(f.cwd, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.cwd, '.lane/supervisor', change), 'held'); }
    if (change === 'reserved') f.add([{ type: 'item.updated', id: 'ENG-1', fields: { meta: { operator_reserved: true } } }]);
    if (change === 'callback') {
      f.manifest.obligations.push({ id: 'saved-watch', owner: f.native.name, attempt: 'original', receipt: 'saved-job.json', next_event: 'original owner completion' });
      f.options.handoffSeq = f.save(f.manifest).seq;
    }
    if (change === 'unknown-input') call = () => JSON.stringify({ error: 'UNKNOWN' });
    if (change === 'refused-input') call = () => { throw Error('native input refused'); };
    assert.throws(() => runDuty({ ...f.options, call, command: () => { invoked++; } }));
    assert.equal(invoked, 0); assert.equal(f.events().some(e => e.type === 'supervisor.duty.started'), false);
  });

test('native change after intent retains the first binding and an UNKNOWN result without an alternate executor', t => {
  const f = fixture(t); let reads = 0, invoked = 0;
  const call = (exe, args) => {
    if (args[0] === 'agent' && args[1] === 'get' && ++reads === 3) f.native.agent_session.value = 'replacement';
    return f.options.call(exe, args);
  };
  const r = runDuty({ ...f.options, call, command: () => { invoked++; } });
  assert.equal(invoked, 0); assert.equal(r.receipt.result.state, 'unknown');
  assert.equal(r.start.native.session, 'session-a');
  f.native.agent_session.value = 'session-a';
  assert.throws(() => runDuty(f.options), /already exists/);
});

for (const state of ['failed', 'unknown']) test(`${state} tool result cannot be retried, rebound or completed from a report`, t => {
  const f = fixture(t); let invoked = 0;
  const r = runDuty({ ...f.options, command: () => { invoked++; return state === 'failed'
    ? { status: 1, stderr: 'native refusal', stdout: 'original evidence' }
    : { status: null, error: Error('UNKNOWN original outcome'), stdout: 'partial original evidence' }; } });
  assert.equal(r.receipt.result.state, state);
  assert.throws(() => runDuty(f.options), /already exists/); assert.equal(invoked, 1);
  const next = f.next(r);
  assert.throws(() => finishDuty({ ...f.options, successorSeq: next.seq }), /failed\/UNKNOWN/);
  f.native.agent_session.value = 'different-session';
  assert.throws(() => finishDuty({ ...f.options, successorSeq: next.seq }), /binding changed/);
  f.bindLaunch();
  assert.throws(() => runDuty({ ...f.options, handoffSeq: next.seq }), /retains canonical custody \(cap1\)/);
  assert.equal(f.events().filter(e => e.type === 'supervisor.duty.started').length, 1);
});

test('safe handback holds on a live child, unhandled sent callback and changed successor receipt', t => {
  const f = fixture(t), r = runDuty(f.options), next = f.next(r);
  f.rows.set(200, { pid: 200, ppid: 100, state: 'S', identity: 'job-birth', command: 'original watcher child' });
  assert.throws(() => finishDuty({ ...f.options, successorSeq: next.seq }), /safe boundary/);
  f.rows.delete(200);
  const inbox = path.join(f.org, 'supervisor/inbox.log'); fs.mkdirSync(path.dirname(inbox), { recursive: true });
  const original = '{"type":"notice","id":"original","to":"fixture-supervisor","message":"callback"}\n{"type":"sent","id":"original"}\n';
  fs.writeFileSync(inbox, original);
  assert.throws(() => finishDuty({ ...f.options, successorSeq: next.seq }), /unhandled/);
  assert.equal(fs.readFileSync(inbox, 'utf8'), original, 'no retarget, acknowledgement or replay');
  fs.writeFileSync(inbox, ''); // Fixture owner supplies a separate clean case.
  const file = path.join(f.org, next.path); fs.chmodSync(file, 0o644); fs.appendFileSync(file, 'changed');
  assert.throws(() => finishDuty({ ...f.options, successorSeq: next.seq }), /sha256 mismatch/);
  assert.equal(f.events().some(e => e.type === 'supervisor.duty.completed'), false);
});

test('successor handback refuses a foreign project or a different recorded successor owner', t => {
  for (const changed of ['project', 'owner']) {
    const f = fixture(t);
    if (changed === 'owner') {
      f.manifest.successor.owner = 'unbound-release-label';
      f.options.handoffSeq = f.save(f.manifest).seq;
    }
    const r = runDuty(f.options);
    const next = f.save({ ...f.manifest, id: 'duty-b', predecessor: { start_seq: r.start.seq, result_seq: r.receipt.seq },
      project: { ...f.manifest.project, ...(changed === 'project' ? { common: path.join(f.scratch, 'foreign/.git') } : {}) } });
    assert.throws(() => finishDuty({ ...f.options, successorSeq: next.seq }), /original supervisor slot/);
    assert.equal(f.events().some(e => e.type === 'supervisor.duty.completed'), false);
  }
});

test('line-unavailable recovery is independently readable, preserves attempts and explicitly counts manual assistance', t => {
  const f = fixture(t), r = runDuty({ ...f.options, command: () => ({ status: null, error: Error('UNKNOWN') }) });
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl')), calls = f.calls.length;
  const plan = recoveryPlan({ org: f.org, handoffSeq: f.handoff.seq });
  assert.equal(plan.supervisor, 'fixture-supervisor'); assert.equal(plan.executed, false);
  assert.equal(plan.manual_assistance, true); assert.equal(plan.zero_nudge_success, false);
  assert.equal(plan.recovery.planning_channel, 'brain-planning-chat');
  assert.ok(plan.attempts.some(e => e.seq === r.receipt.seq));
  assert.equal(f.calls.length, calls, 'no dependency on native input or line dispatch');
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
  const cli = spawnSync(process.execPath, [path.join(source, 'supervisor/finite-duty.mjs'), 'recovery', '--org', f.org,
    '--handoff-seq', String(f.handoff.seq)], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).manual_assistance, true);
});

test('read-only entry never invokes retirement, housekeeping or watcher catch-up before duty authorization', t => {
  const f = fixture(t), calls = [], before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  enterSupervisor({ cwd: f.cwd, org: f.org, role: 'supervisor', readOnly: true, output: () => {},
    command: (_exe, args) => { calls.push(args); return { status: 0, stdout: 'cold start', stderr: '' }; } });
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 'brief');
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
  const cli = spawnSync(process.execPath, [path.join(source, 'supervisor/supervisor.mjs'), 'entry', '--repo', f.cwd,
    '--org', f.org, '--role', 'supervisor', '--read-only'], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /observation only/);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
});

test('handoff validation refuses a shell, extra permission fields, duplicate JSON keys and unrecorded bytes', t => {
  const f = fixture(t);
  assert.throws(() => parseDuty(f.markdown({ ...f.manifest, duty: { kind: 'shell', command: 'anything' } })), /unsupported duty/);
  assert.throws(() => parseDuty(f.markdown({ ...f.manifest, permission: 'supervisor' })), /invalid/);
  assert.throws(() => parseDuty(f.markdown(f.manifest).replace('"schema":', '"id":"forged","schema":')), /duplicate/);
  assert.throws(() => inspectDuty({ org: f.org, handoffSeq: f.handoff.seq + 1 }), /recorded supervisor handoff/);
});
