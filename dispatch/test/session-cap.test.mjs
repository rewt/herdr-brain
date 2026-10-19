import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireSessionCapLock, countSessions, sessionAlive, checkSessionCap, DEFAULT_SESSION_CAP } from '../session-cap.mjs';
import { loadDiscoveredRoutes, validateRoutesConfig, mergeRoutesConfig } from '../../lanes/routes.mjs';

const common = '/project/.git';
const identity = n => ({ agent: `worker-${n}`, pane: `p-${n}`, worker_workspace: 'w', terminal_id: `t-${n}` });
const run = (n, extra = {}) => ({ id: `R-${n}`, workspace: '/project/lane', meta: { ...identity(n), dispatch_project: common }, ...extra });
const state = (...runs) => ({ runs: new Map(runs.map(r => [r.id, r])) });
const row = (pid, identity = '100:1') => ({ ok: true, value: { pid, identity, state: 'S' } });
const error = code => Object.assign(Error(code), { code });
const journal = (n, extra = {}) => ({ run: `R-${n}`, common, launchProcess: { pid: n, identity: '100:1' }, ...extra });
const count = (options = {}) => countSessions({ state: state(run(1)), journals: [journal(1)], common,
  kill: () => {}, readProcess: pid => row(pid), ...options });

test('cap defaults to BCH seven and validates the existing layered dispatch setting', t => {
  assert.equal(DEFAULT_SESSION_CAP, 7);
  for (const value of [0, -1, 1.5, '7', null, true]) {
    assert.throws(() => validateRoutesConfig({ dispatch: { max_sessions: value } }), /positive integer/);
  }
  assert.equal(mergeRoutesConfig([{ dispatch: { max_sessions: 9 } }, { routes: {} }]).dispatch.max_sessions, 9);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cap-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  assert.equal(spawnSync('git', ['init', '-b', 'main', repo]).status, 0);
  fs.writeFileSync(path.join(root, '.lane.json'), JSON.stringify({ dispatch: { max_sessions: 8 } }));
  assert.equal(loadDiscoveredRoutes({ cwd: repo, env: { HERDR_MONITOR_FLEET: path.join(root, 'absent') } }).config.dispatch.max_sessions, 8);
  fs.writeFileSync(path.join(repo, '.lane.json'), JSON.stringify({ dispatch: { max_sessions: 2 } }));
  assert.equal(loadDiscoveredRoutes({ cwd: repo, env: { HERDR_MONITOR_FLEET: path.join(root, 'absent') } }).config.dispatch.max_sessions, 2);
  const file = path.join(root, 'explicit.json'); fs.writeFileSync(file, JSON.stringify({ dispatch: { max_sessions: 3 } }));
  assert.equal(loadDiscoveredRoutes({ cwd: repo, file }).config.dispatch.max_sessions, 3);
});

test('ESRCH frees capacity; EPERM, unknown probes and unreadable identity sources keep it', () => {
  assert.equal(count({ kill: () => { throw error('ESRCH'); } }).length, 0);
  for (const code of ['EPERM', 'EIO']) {
    assert.equal(count({ kill: () => { throw error(code); }, readProcess: () => { throw Error('denied'); } }).length, 1);
  }
  for (const result of [{ ok: false }, { ok: true, value: null }, row(99)]) {
    assert.equal(count({ readProcess: () => result }).length, 1);
  }
  assert.equal(sessionAlive({ pid: 1 }, { kill: () => {} }), true);
  assert.equal(sessionAlive(null), true);
  let probes = 0;
  assert.equal(sessionAlive({ pid: 1, identity: '100:1' }, { kill: () => { if (probes++) throw error('ESRCH'); },
    readProcess: () => ({ ok: false }) }), false, 'recheck a process that exited during observation');
});

test('a reused PID with a different kernel start identity never occupies the old session', () => {
  assert.equal(count({ readProcess: pid => row(pid, '200:2') }).length, 0);
  assert.equal(count().length, 1);
  assert.equal(sessionAlive({ pid: 1, identity: '42' }, { kill: () => {},
    readProcess: pid => row(pid, '00000000-0000-0000-0000-000000000000:42') }), true);
});

test('admission locks retain live, EPERM, unknown and invalid owners or contenders', t => {
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cap-lock-'));
  t.after(() => fs.rmSync(common, { recursive: true, force: true }));
  const directory = path.join(common, 'dispatch-session-cap'), contenders = `${directory}.contenders`;
  for (const source of ['owner', 'contender']) for (const code of ['live', 'EPERM', 'EIO', 'invalid']) {
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(contenders, { recursive: true });
    const owner = { pid: code === 'invalid' && source === 'owner' ? null : 123 };
    fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify(owner));
    const contender = path.join(contenders, code === 'invalid' ? 'invalid' : '123-original');
    if (source === 'contender') fs.writeFileSync(contender, '');
    assert.throws(() => acquireSessionCapLock(common, { kill: () => {
      if (code !== 'live') throw error(code);
    } }), /locked:/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'))), owner);
    assert.deepEqual(fs.readdirSync(contenders), source === 'contender' ? [path.basename(contender)] : []);
    fs.rmSync(directory, { recursive: true });
    fs.rmSync(contenders, { recursive: true });
  }
});

test('records and journals count each bound session once, excluding terminal runs and other projects', () => {
  const sessions = count({ state: state(run(1), run(2, { report: {} }), run(3, { abandoned: {} }),
    run(4, { meta: { ...identity(4), dispatch_project: '/elsewhere/.git' } }), run(5, { meta: {} })),
    journals: [journal(1), journal(2), journal(3), journal(4)] });
  assert.deepEqual(sessions.map(s => s.run), ['R-1']);
  const fromJournal = run(6, { meta: {} });
  assert.equal(count({ state: state(fromJournal), journals: [journal(6, { worker: { agentName: 'six', pane: 'p6', workspaceId: 'w', terminalId: 't6' } })] }).length, 1);
  assert.equal(count({ state: state(run(1, { meta: identity(1) })), journals: [], projectIdentity: () => '/other/.git' }).length, 0);
  assert.equal(count({ state: state(run(1, { meta: identity(1) })), journals: [], projectIdentity: () => common }).length, 1);
  const shared = run(2, { meta: { ...identity(1), dispatch_project: common } });
  assert.equal(count({ state: state(run(1), shared), journals: [journal(1), journal(2)] }).length, 1);
});

test('record-only workers use their bound native occupant and missing or changed topology stays unknown', () => {
  const a = { name: 'worker-1', agent: 'opaque', pane_id: 'p-1', workspace_id: 'w', terminal_id: 't-1', cwd: '/project/lane' };
  const options = { journals: [], agent: () => a,
    processInfo: () => ({ shell_pid: 99, foreground_processes: [{ pid: 1, name: 'opaque' }] }) };
  assert.equal(count(options)[0].process.pid, 1);
  assert.equal(count({ ...options, agent: () => ({ ...a, terminal_id: 'replacement' }) })[0].evidence, 'unknown liveness');
  assert.equal(count({ ...options, agent: () => { throw Error('not found'); } }).length, 1);
});

test('definitive Herdr agent-not-found retains an orphan without process evidence until explicitly abandoned', () => {
  const orphan = run(335), options = { state: state(orphan), journals: [journal(335, { stage: 'complete', launchProcess: null })],
    agent: () => { throw Object.assign(Error('agent_not_found'), { code: 'agent_not_found' }); } };
  const sessions = count(options);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].occupancy, 'unknown liveness');
  assert.equal(count({ ...options, agent: () => null }).length, 1);
  assert.equal(count({ ...options, state: state({ ...orphan, abandoned: {} }) }).length, 0);
  assert.equal(count({ ...options, journals: [journal(335)], kill: () => { throw error('ESRCH'); } }).length, 0);
});

test('recorded live settle reviewers count independently of the completed worker run', () => {
  const review = { schema: 'retirement-occupant/v1', kind: 'settle', common, run: 'R-2',
    process: { pid: 2, identity: '100:1' }, terminal_id: 'review-terminal' };
  const sessions = count({ state: state(run(1), run(2, { report: {} })), reviewers: [review, { ...review, common: '/other/.git' }] });
  assert.deepEqual(sessions.map(s => [s.run, s.kind]), [['R-1', 'worker'], ['R-2', 'reviewer']]);
  assert.equal(count({ reviewers: [review], readProcess: pid => row(pid, pid === 2 ? 'reused' : '100:1') }).length, 1);
  assert.equal(count({ reviewers: [review], kill: pid => { if (pid === 2) throw error('EPERM'); } }).length, 2);
});

test('uncertain launches reserve capacity and incomplete evidence never becomes an observed zero', () => {
  assert.equal(count({ state: state(run(1, { meta: {} })), journals: [journal(1, { stage: 'launching', launchProcess: null })] }).length, 1);
});

test('cap refusal names all runs and the worker/reviewer breakdown from durable evidence', t => {
  const org = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cap-record-'));
  t.after(() => fs.rmSync(org, { recursive: true, force: true }));
  fs.writeFileSync(path.join(org, 'events.jsonl'), '');
  const dir = path.join(org, 'retirement/occupants'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ schema: 'retirement-occupant/v1', kind: 'settle', common,
    run: 'R-9', process: { pid: 9, identity: '100:1' } }));
  const options = { config: { dispatch: { max_sessions: 1 } }, org, common, kill: () => {}, readProcess: pid => row(pid) };
  assert.throws(() => checkSessionCap(options), e => e.code === 'DISPATCH_SESSION_CAP' &&
    /session cap 1 reached: R-9/.test(e.message) && /0 workers, 1 settle reviewers/.test(e.message));
  assert.equal(checkSessionCap({ ...options, kill: () => { throw error('ESRCH'); } }).count, 0);
  fs.writeFileSync(path.join(dir, 'review.json'), '{');
  assert.throws(() => checkSessionCap(options), /session count unavailable/);
});

test('refusal distinguishes observed, unknown and uncertain runs and explains orphan recovery', t => {
  const org = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cap-reasons-'));
  t.after(() => fs.rmSync(org, { recursive: true, force: true }));
  const events = [run(1), run(2), run(3, { meta: {} })].map(r => ({ type: 'run.started', ...r }));
  fs.writeFileSync(path.join(org, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const dir = path.join(org, 'dispatch'); fs.mkdirSync(dir);
  for (const j of [journal(1), journal(2, { launchProcess: null }), journal(3, { stage: 'launching', launchProcess: null })]) {
    fs.writeFileSync(path.join(dir, `${j.run}.json`), JSON.stringify(j));
  }
  const options = { config: { dispatch: { max_sessions: 3 } }, org, common, kill: () => {}, readProcess: pid => row(pid),
    agent: () => { throw error('agent_not_found'); } };
  assert.throws(() => checkSessionCap(options), e => {
    assert.equal(e.code, 'DISPATCH_SESSION_CAP');
    assert.match(e.message, /session cap 3 reached: R-1, R-2, R-3/);
    assert.match(e.message, /observed live: R-1; unknown liveness: R-2; uncertain launch: R-3/);
    assert.match(e.message, /inspect .*explicitly abandon stale runs after checking their workers/);
    return true;
  });
  fs.writeFileSync(path.join(dir, 'R-2.json'), JSON.stringify(journal(2)));
  assert.throws(() => checkSessionCap({ ...options, kill: pid => { if (pid === 2) throw error('EPERM'); } }),
    /unknown liveness: R-2/);
});
