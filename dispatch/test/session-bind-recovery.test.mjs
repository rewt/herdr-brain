import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fold } from '../../lib/state.mjs';
import { fold as oldFold } from '../../test/fixtures/state-pre-session-bind.mjs';
import { effectiveWorkerIdentity, workerReceipt, workerIdentityEvidence } from '../../lib/worker-identity.mjs';
import { recoverFinishedSessionBinding } from '../session-bind-recovery.mjs';
import { isolateSessionEnvironment, setSessionEnvironment } from '../../test/helpers/session-environment.mjs';
import { lineDirectory } from '../../line-service/cutoff.mjs';

const source = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, { proposed = true, reported = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'finished-bind-')));
  isolateSessionEnvironment(t, root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.identity-root'), 'fixture');
  const repo = path.join(root, 'project'), workspace = path.join(root, 'lane'); fs.mkdirSync(repo);
  const git = (args, cwd = repo) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  fs.writeFileSync(path.join(repo, 'seed'), 'base'); git(['add', 'seed']); git(['commit', '-qm', 'base']);
  const common = fs.realpathSync(path.join(repo, '.git'));
  fs.appendFileSync(path.join(common, 'info/exclude'), '\n.org/\n.lane/\n');
  git(['worktree', 'add', '-qb', 'lane/topic', workspace]);
  fs.writeFileSync(path.join(workspace, 'seed'), 'finished'); git(['commit', '-qam', 'finished'], workspace);
  const org = path.join(repo, '.org'), journal = path.join(org, 'dispatch/attempt.json');
  fs.mkdirSync(path.dirname(journal), { recursive: true }); fs.mkdirSync(path.join(org, 'reports'));
  const eventFile = path.join(org, 'events.jsonl'), report = path.join(org, 'reports/R-1.md');
  const owner = { controller: 'brain', legacy: false, release: { id: 'source', commit: null, root: source,
    identity: fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], source)) } };
  const events = [
    { type: 'item.added', id: 'ENG-1', role: 'engineer', kind: 'work', meta: {} },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace, meta: { lane: 'topic', dispatch_journal: journal,
      dispatch_attempt: 'attempt', dispatch_project: common, dispatch_record: org } },
    { type: 'run.claimed', run: 'R-1', record: org, project: common, owner },
    { type: 'run.updated', id: 'R-1', meta: { agent: 'original', pane: 'w:p', worker_workspace: 'w', terminal_id: 'terminal' } },
  ];
  const append = e => { events.push(e); saveEvents(); };
  const saveEvents = () => {
    events.forEach((e, i) => Object.assign(e, { seq: i + 1, at: '2026-01-01T00:00:00.000Z', by: e.by ?? 'supervisor-fixture' }));
    fs.writeFileSync(eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  }; saveEvents();
  if (reported) {
    fs.writeFileSync(report, 'Original blocked report: binding missing.\n');
    append({ type: 'report.ingested', run: 'R-1', report: { outcome: 'blocked', summary: 'Original report' },
      sha256: hash(fs.readFileSync(report)), file: 'reports/R-1.md' });
  }
  const state = () => fold(fs.readFileSync(eventFile, 'utf8').trim().split('\n').map(JSON.parse));
  const process = { pid: 123, identity: 'original birth' }, receipt = workerReceipt(state().runs.get('R-1'), state());
  const binding = { status: 'unbound', process, receipt, prompted_at: '2026-01-01T00:00:00.000Z', deadline: '2026-01-01T00:01:00.000Z' };
  const fact = { type: 'run.session_bound', run: 'R-1', dispatch: { journal, attempt: 'attempt', project: common, record: org },
    receipt, process, prompted_at: binding.prompted_at, deadline: binding.deadline, observed_at: '2026-01-01T00:00:30.000Z', session: 'original-session' };
  if (proposed) binding.proposed = structuredClone(fact);
  const job = { run: 'R-1', item: 'ENG-1', repo, workspace, org, common, token: 'attempt', lane: 'topic', stage: 'complete',
    native_launch_attempted: true, launchProcess: process, ownership: { owner, generation: 3 }, sessionBinding: binding,
    worker: { agentName: 'original', pane: 'w:p', workspaceId: 'w', terminalId: 'terminal', agentSessionId: null, cwd: workspace } };
  const save = () => fs.writeFileSync(journal, JSON.stringify(job)); save();
  const supervisor = { name: 'supervisor-fixture', agent: 'codex', pane_id: 'main:p', workspace_id: 'main',
    terminal_id: 'supervisor-terminal', agent_session: { value: 'supervisor-session' }, cwd: repo };
  const native = { name: 'original', agent: 'codex', pane_id: 'w:p', workspace_id: 'w', terminal_id: 'terminal',
    agent_session: { value: 'original-session' }, cwd: workspace, agent_status: 'done' };
  const env = { ...processEnv(), ORG_DIR: org, HERDR_BRAIN_ROOT: source, HERDR_ENV: '1',
    HERDR_PANE_ID: 'main:p', HERDR_WORKSPACE_ID: 'main', CODEX_THREAD_ID: undefined };
  setSessionEnvironment(t, { CODEX_THREAD_ID: undefined, ORG_DIR: undefined });
  const options = { org, journal, role: 'supervisor', id: 'recover-original', decisionSeq: events.length + 1,
    expectedHead: git(['rev-parse', 'HEAD'], workspace), expectedSource: git(['rev-parse', 'HEAD'], source),
    expectedSession: 'original-session', cwd: repo, env };
  append({ type: 'note.added', id: 'ENG-1', decision: true,
    text: ['R-1', journal, options.id, options.expectedHead, options.expectedSource, options.expectedSession].join(' ') });
  const calls = [], controls = { process, onCall: () => {} };
  options.call = (_bin, args) => {
    calls.push(args); controls.onCall(args);
    if (args[0] === 'agent' && args[1] === 'get') return JSON.stringify({ result: { agent: args[2] === 'main:p' ? supervisor : native } });
    if (args[0] === 'pane' && args[1] === 'process-info') return JSON.stringify({ result: { process_info: {
      shell_pid: 1, foreground_processes: [{ name: 'codex', pid: controls.process.pid }] } } });
    throw Error('unexpected native effect');
  };
  options.readOwner = pid => ({ ok: true, value: { ...controls.process, pid, state: 'S' } });
  return { repo, org, common, journal, workspace, eventFile, report, job, native, supervisor, options,
    controls, calls, save, append, state, git, fact, saveEvents, events, recover: () => recoverFinishedSessionBinding(options) };
}
const processEnv = () => ({ ...process.env });

for (const proposed of [true, false]) test(`finished original recovers with saved proposal=${proposed}, preserving journal/report/run and exact retries`, t => {
  const f = fixture(t, { proposed }), journal = fs.readFileSync(f.journal), report = fs.readFileSync(f.report), before = f.state().runs.get('R-1');
  assert.equal(f.recover().recorded, true);
  const state = f.state(), binds = state.sessionBindings.get('R-1');
  assert.equal(binds.length, 1); assert.equal(effectiveWorkerIdentity(state.runs.get('R-1'), state).agent_session_id, 'original-session');
  assert.equal(effectiveWorkerIdentity(state.runs.get('R-1'), state).identity_conflict, false);
  const snapshot = JSON.parse(JSON.stringify({ items: [...state.items.values()], ...workerIdentityEvidence(state) }));
  assert.equal(effectiveWorkerIdentity(state.runs.get('R-1'), snapshot).agent_session_id, 'original-session');
  assert.deepEqual(state.runs.get('R-1'), before); assert.deepEqual(fs.readFileSync(f.journal), journal); assert.deepEqual(fs.readFileSync(f.report), report);
  assert.equal(oldFold(JSON.parse('[' + fs.readFileSync(f.eventFile, 'utf8').trim().split('\n').join(',') + ']')).sessionBindings, undefined);
  const bytes = fs.readFileSync(f.eventFile), reads = f.calls.length;
  assert.equal(f.recover().recorded, false); assert.deepEqual(fs.readFileSync(f.eventFile), bytes);
  assert.equal(f.calls.length, reads + 1, 'an exact retry only authenticates its caller');
  f.options.id = 'second-attempt'; assert.throws(f.recover, /scoped decision|different or conflicting/);
  assert.deepEqual(fs.readFileSync(f.eventFile), bytes);
});

test('finished but unreported original binds without fabricating a report', t => {
  const f = fixture(t, { reported: false, proposed: false }); assert.equal(f.recover().recorded, true);
  assert.equal(f.state().runs.get('R-1').report, null); assert.equal(fs.existsSync(f.report), false);
});

const cases = [
  ['replacement SID', f => { f.native.agent_session.value = 'replacement'; }, /native finished session/],
  ['replacement process birth', f => { f.controls.process = { pid: 123, identity: 'replacement birth' }; }, /native process changed/],
  ['replacement PID', f => { f.controls.process = { pid: 124, identity: 'original birth' }; }, /native process changed/],
  ['replacement terminal', f => { f.native.terminal_id = 'replacement'; }, /native finished session/],
  ['replacement pane', f => { f.native.pane_id = 'other:p'; }, /native finished session/],
  ['replacement workspace', f => { f.native.workspace_id = 'other'; }, /native finished session/],
  ['foreign worktree', f => { f.native.cwd = f.repo; }, /native finished session/],
  ['foreign foreground worktree', f => { f.native.foreground_cwd = f.repo; }, /native finished session/],
  ['UNKNOWN native', f => { f.native.agent_status = 'unknown'; }, /native finished session/],
  ['active native', f => { f.native.agent_status = 'working'; }, /native finished session/],
  ['uncertain prompting', f => { f.job.stage = 'prompting'; f.save(); }, /launch\/delivery continuity/],
  ['UNKNOWN saved reply', f => { f.job.sessionBinding.status = 'observing'; f.job.sessionBinding.reason = 'bind reply unknown'; f.save(); }, /launch\/delivery continuity/],
  ['changed launch receipt', f => { f.job.sessionBinding.receipt.terminal_id = 'replacement'; f.save(); }, /dispatch\/launch receipt/],
  ['changed proposal', f => { f.job.sessionBinding.proposed.session = 'replacement'; f.save(); }, /dispatch\/launch receipt/],
  ['changed proposal shape', f => { f.job.sessionBinding.proposed.seq = 99; f.save(); }, /dispatch\/launch receipt/],
  ['changed saved worker', f => { f.job.worker.terminalId = 'replacement'; f.save(); }, /dispatch\/launch receipt/],
  ['changed process receipt', f => { f.job.launchProcess = { pid: 999, identity: 'other' }; f.save(); }, /launch\/delivery continuity/],
  ['foreign claim', f => { f.append({ type: 'run.claimed', run: 'R-1', record: f.org, project: f.common,
    owner: { ...f.job.ownership.owner, controller: 'foreign' } }); }, /RUN_OWNED_ELSEWHERE/],
  ['newer claim generation', f => { f.append({ type: 'run.claimed', run: 'R-1', record: f.org, project: f.common, owner: f.job.ownership.owner }); }, /RUN_OWNED_ELSEWHERE/],
  ['newer worktree holder', f => { f.append({ type: 'run.started', id: 'R-2', item: 'ENG-1', workspace: f.workspace, meta: {} }); }, /superseded/],
  ['changed report', f => { fs.appendFileSync(f.report, 'changed'); }, /original report changed/],
  ['changed source expectation', f => { f.options.expectedSource = '0'.repeat(40); f.events.at(-1).text += ' ' + f.options.expectedSource; f.saveEvents(); }, /source\/head\/clean journal CAS/],
  ['dirty lane', f => { fs.appendFileSync(path.join(f.workspace, 'seed'), 'dirty'); }, /source\/head\/clean journal CAS/],
  ['lane HOLD', f => { const d = path.join(f.workspace, '.lane'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'HOLD'), 'hold'); }, /STOP\/HOLD/],
  ['line STOP', f => { const d = lineDirectory(f.org, f.common); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'STOP'), 'stop'); }, /STOP\/HOLD/],
  ['missing supervisor mode', f => { f.options.role = 'engineer'; }, /supervisor mode/],
  ['missing source selection', f => { delete f.options.env.HERDR_BRAIN_ROOT; }, /matching explicit development source/],
  ['foreign caller checkout', f => { f.supervisor.cwd = f.workspace; }, /native caller binding/],
  ['wrong decision author', f => { f.events.at(-1).by = 'not-the-supervisor'; f.saveEvents(); }, /scoped decision/],
  ['unknown prior attempt', f => { fs.mkdirSync(path.join(f.org, 'evidence/session-bind/R-1'), { recursive: true }); }, /UNKNOWN/],
  ['pre-launch original without receipt', f => { f.job.stage = 'worker'; delete f.job.sessionBinding; delete f.job.launchProcess; delete f.job.worker; f.save(); }, /launch\/delivery continuity/],
];
for (const [name, mutate, message] of cases) test(`finished recovery refuses ${name} without changing history`, t => {
  const f = fixture(t); mutate(f); const bytes = fs.readFileSync(f.eventFile), journal = fs.readFileSync(f.journal);
  assert.throws(f.recover, message); assert.deepEqual(fs.readFileSync(f.eventFile), bytes); assert.deepEqual(fs.readFileSync(f.journal), journal);
});

test('old committed binds remain unchanged and a tampered recovery archive cannot be replayed', t => {
  const f = fixture(t), original = { ...f.fact, seq: f.events.length + 1, by: 'supervisor-fixture' };
  f.append(original); const bytes = fs.readFileSync(f.eventFile);
  assert.throws(f.recover, /different or conflicting session bind/); assert.deepEqual(fs.readFileSync(f.eventFile), bytes);
  const g = fixture(t); const result = g.recover(), manifest = JSON.parse(fs.readFileSync(result.archive));
  fs.chmodSync(manifest.files[0].archive, 0o600); fs.appendFileSync(manifest.files[0].archive, 'tampered');
  assert.throws(g.recover, /archive changed/); assert.equal(g.state().sessionBindings.get('R-1').length, 1);
});

test('original session and journal CAS are rechecked across observation; a native refusal is not retried', t => {
  const f = fixture(t); let reads = 0;
  f.controls.onCall = args => { if (args[0] === 'agent' && args[2] === 'original' && ++reads === 2) f.native.agent_session.value = 'replacement'; };
  assert.throws(f.recover, /native finished session/); assert.equal(reads, 2);
  f.native.agent_session.value = 'original-session';
  f.controls.onCall = args => { if (args[0] === 'agent' && args[2] === 'original') fs.appendFileSync(f.journal, ' '); };
  assert.throws(f.recover, /journal CAS changed/);
  f.save(); let refused = 0;
  f.controls.onCall = args => { if (args[0] === 'agent' && args[2] === 'original') { refused++; throw Error('native refusal EPERM'); } };
  assert.throws(f.recover, /native refusal EPERM/); assert.equal(refused, 1);
  assert.equal(f.state().sessionBindings.size, 0);
});

test('ordinary session-bind still rejects the unbound saved proposal before its deadline guard', t => {
  const f = fixture(t), result = spawnSync(process.execPath, [path.join(source, 'bin/org.mjs'), 'session-bind', '--journal', f.journal],
    { cwd: f.repo, env: { ...f.options.env, HERDR_MONITOR_HOME: path.join(f.repo, 'no-pin') }, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /original dispatch and launch receipt/);
  assert.equal(f.state().sessionBindings.size, 0);
});
