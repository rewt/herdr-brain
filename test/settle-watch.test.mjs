import { loadTimeout } from '../lib/deadline.mjs';
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { turnBlockers } from '../contrib/settle-turn.mjs';

const WATCH = fileURLToPath(new URL('../contrib/settle-watch.mjs', import.meta.url));

function script(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

test('settle-watch tells org which session is acting (dry run, fake Herdr)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-watch-'));
  const bin = path.join(root, 'bin');
  const cwd = path.join(root, 'checkout');
  const supervisor = path.join(root, 'supervisor');
  for (const d of [bin, cwd, supervisor]) fs.mkdirSync(d);
  const checklist = path.join(supervisor, 'SETTLE.md');
  const laneConfig = path.join(root, 'lane.json');
  fs.writeFileSync(checklist, '# checklist\n');
  fs.writeFileSync(laneConfig, '{}');
  script(path.join(bin, 'herdr'), `case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"workspace_id":"w1","worktree":{"is_linked_worktree":false,"checkout_path":"${cwd}"}}]}}' ;;
  "tab list") echo '{"result":{"tabs":[]}}' ;;
  "pane list") echo '{"result":{"panes":[]}}' ;;
  "agent list") echo '{"result":{"agents":[]}}' ;;
  *) echo '{"result":{}}' ;;
esac`);
  script(path.join(root, 'launcher'), `echo CLAUDE_CONFIG_DIR=${root}/claude`);
  script(path.join(root, 'cmem'), 'exit 1');

  const r = spawnSync(process.execPath, [WATCH, '--open', '--dry-run', '--org', path.join(root, '.org'), '--cwd', cwd,
    '--lane-config', laneConfig, '--checklist', checklist, '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8',
    env: { ...process.env, ORG_ACTOR: 'supervisor-test-agent', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const openTab = r.stdout.split('\n').find((l) => l.includes('[dry-run] open tab:'));
  assert.ok(openTab, r.stdout);
  assert.match(openTab, /--env ORG_DIR=\S+/);
  assert.match(openTab, /--env ORG_ACTOR=exec-\d{4}\b/);
  assert.match(openTab, /--env MONITOR_ENTRY_BYPASS=1\b/);

  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'STOP'), 'stop\n');
  const stopped = spawnSync(process.execPath, [WATCH, '--open', '--dry-run', '--org', path.join(root, '.org'), '--cwd', cwd,
    '--lane-config', laneConfig, '--checklist', checklist, '--ledger-dir', runtime,
    '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8',
    env: { ...process.env, ORG_ACTOR: 'supervisor-test-agent', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(stopped.status, 1, stopped.stdout + stopped.stderr);
  assert.match(stopped.stdout, new RegExp(`${runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/STOP exists`));

  const defaultStop = path.join(supervisor, 'STOP');
  fs.writeFileSync(defaultStop, 'stop\n');
  const defaultStopped = spawnSync(process.execPath, [WATCH, '--open', '--dry-run', '--org', path.join(root, '.org'), '--cwd', cwd,
    '--lane-config', laneConfig, '--checklist', checklist,
    '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8',
    env: { ...process.env, ORG_ACTOR: 'supervisor-test-agent', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(defaultStopped.status, 1, defaultStopped.stdout + defaultStopped.stderr);
  assert.match(defaultStopped.stdout, new RegExp(`${defaultStop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} exists`));
  fs.unlinkSync(defaultStop);

  const missingRuntime = path.join(root, 'missing-runtime');
  assert.equal(fs.existsSync(missingRuntime), false);
  const prepared = spawnSync(process.execPath, [WATCH, '--open', '--org', path.join(root, '.org'),
    '--cwd', path.join(root, 'not-the-checkout'), '--lane-config', laneConfig, '--checklist', checklist,
    '--ledger-dir', missingRuntime, '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8',
    env: { ...process.env, ORG_ACTOR: 'supervisor-test-agent', PATH: `${bin}:${process.env.PATH}` },
    timeout: loadTimeout(2_000),
  });
  assert.equal(prepared.status, 1, prepared.stdout + prepared.stderr);
  assert.equal(prepared.error, undefined);
  assert.equal(fs.statSync(missingRuntime).isDirectory(), true);
  assert.match(prepared.stdout, /no Herdr workspace has .*not-the-checkout/);
});

test('a codex route starts a codex session with its model, effort, route args and always_args (dry run)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-watch-codex-'));
  const bin = path.join(root, 'bin'), cwd = path.join(root, 'checkout'), supervisor = path.join(root, 'supervisor');
  for (const d of [bin, cwd, supervisor]) fs.mkdirSync(d);
  const checklist = path.join(supervisor, 'SETTLE.md'), laneConfig = path.join(root, 'lane.json');
  fs.writeFileSync(checklist, '# checklist\n');
  fs.writeFileSync(laneConfig, JSON.stringify({
    routes: { executive: { kind: 'codex', model: 'gpt-x', effort: 'high', args: ['-c', 'model_reasoning_effort=xhigh'] } },
    always_args: { codex: ['-p', 'prof', '-c', 'model_reasoning_effort=low'] },
  }));
  script(path.join(bin, 'herdr'), `case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"workspace_id":"w1","worktree":{"is_linked_worktree":false,"checkout_path":"${cwd}"}}]}}' ;;
  *) echo '{"result":{"tabs":[],"panes":[],"agents":[]}}' ;;
esac`);
  script(path.join(root, 'launcher'), `echo CLAUDE_CONFIG_DIR=${root}/claude`);
  script(path.join(root, 'cmem'), 'exit 1');
  const r = spawnSync(process.execPath, [WATCH, '--open', '--dry-run', '--org', path.join(root, '.org'), '--cwd', cwd,
    '--lane-config', laneConfig, '--checklist', checklist, '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8', env: { ...process.env, ORG_ACTOR: 'supervisor-test-agent', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const start = r.stdout.split('\n').find((l) => l.includes('[dry-run] start agent:'));
  assert.ok(start, r.stdout);
  assert.match(start, /--kind codex .* -- -m gpt-x -c model_reasoning_effort=high -c model_reasoning_effort=xhigh -p prof$/,
    'route args follow the effort; always_args are added only for options the route did not set');
  assert.doesNotMatch(start, /--permission-mode|--add-dir|--effort/);
});

test('a run lock held by a watcher this caller may not signal is not treated as stale', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-watch-lock-'));
  const tmp = path.join(root, 'tmp'), bin = path.join(root, 'bin'), org = path.join(root, '.org');
  for (const d of [tmp, bin]) fs.mkdirSync(d);
  script(path.join(bin, 'herdr'), 'echo \'{"result":{}}\'');
  const lock = path.join(tmp, `settle-watch-${createHash('sha256').update(path.resolve(org)).digest('hex').slice(0, 12)}-R-1.lock`);
  // pid 1 always exists and belongs to root, so an ordinary or sandboxed caller gets EPERM for signal 0.
  fs.writeFileSync(lock, '1');
  const r = spawnSync(process.execPath, [WATCH, 'R-1', '--org', org, '--cwd', root, '--lane-config', path.join(root, 'lane.json'),
    '--checklist', path.join(root, 'SETTLE.md')], {
    encoding: 'utf8', timeout: loadTimeout(10000), env: { ...process.env, TMPDIR: tmp, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /another watcher \(pid 1\) already owns R-1/);
  assert.equal(fs.readFileSync(lock, 'utf8'), '1');
  fs.rmSync(root, { recursive: true, force: true });
});

function turnFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-turn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  };
  const repos = ['own/checkout', 'foreign/checkout'].map(relative => {
    const cwd = path.join(root, relative);
    fs.mkdirSync(cwd, { recursive: true });
    git(cwd, 'init', '-q');
    git(cwd, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'initial');
    return cwd;
  });
  const [cwd, foreign] = repos, org = path.join(root, '.org');
  fs.mkdirSync(org);
  const events = path.join(org, 'events.jsonl');
  fs.writeFileSync(events, '');
  const agent = { name: 'settle-r-1-1200', agent_status: 'working', cwd: foreign };
  return { root, cwd, foreign, org, events, agent, git,
    blockers: (row = agent) => turnBlockers({ cwd, org, agents: [row], getAgent: () => row }) };
}

test('turn check skips positively foreign projects but keeps canonical, linked and symlinked project sessions', t => {
  const f = turnFixture(t);
  assert.deepEqual(f.blockers(), [], 'another repository with the same basename is unrelated');
  assert.deepEqual(f.blockers({ ...f.agent, name: 'exec-1200' }), []);
  assert.equal(f.blockers({ ...f.agent, cwd: f.cwd }).length, 1);
  const lane = path.join(f.root, 'lane'), alias = path.join(f.root, 'alias');
  f.git(f.cwd, 'worktree', 'add', '-qb', 'lane', lane);
  fs.symlinkSync(lane, alias);
  for (const cwd of [lane, alias]) assert.equal(f.blockers({ ...f.agent, cwd }).length, 1);
  const before = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(f.cwd, '.git');
  try { assert.deepEqual(f.blockers(), [], 'inherited Git selectors cannot supply identity'); }
  finally { if (before === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = before; }
});

test('turn check conservatively waits for unknown or conflicting native and durable identities', t => {
  const f = turnFixture(t);
  for (const cwd of [undefined, 'relative', path.join(f.root, 'missing'), f.root]) {
    assert.equal(f.blockers({ ...f.agent, cwd }).length, 1);
  }
  const summary = { ...f.agent, pane_id: 'w1:p1' };
  assert.equal(turnBlockers({ cwd: f.cwd, org: f.org, agents: [summary], getAgent: () => ({ ...summary, pane_id: 'w2:p1' }) }).length, 1);
  assert.equal(turnBlockers({ cwd: f.cwd, org: f.org, agents: [f.agent], getAgent: () => undefined }).length, 1);
  fs.writeFileSync(f.events, [
    { seq: 1, type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: f.cwd, meta: { settled_by: f.agent.name } },
    { seq: 2, type: 'run.claimed', run: 'R-1', record: f.org, project: path.join(f.cwd, '.git'), owner: { controller: 'brain' } },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  assert.equal(f.blockers().length, 1, 'a local same-run binding cannot be bypassed by a foreign cwd');
  fs.writeFileSync(f.events, '');
  const occupants = path.join(f.org, 'retirement/occupants');
  fs.mkdirSync(occupants, { recursive: true });
  fs.writeFileSync(path.join(occupants, 'callback.json'), JSON.stringify({ schema: 'retirement-occupant/v1', common: path.join(f.cwd, '.git'), agent: f.agent.name, run: 'R-1' }));
  assert.equal(f.blockers().length, 1, 'a durable callback also protects the same run');
  fs.rmSync(occupants, { recursive: true });
  fs.writeFileSync(f.events, '{torn');
  assert.equal(f.blockers().length, 1);
  fs.unlinkSync(f.events);
  assert.equal(f.blockers().length, 1);
});

for (const scope of ['foreign', 'same', 'unknown']) test(`live turn path: ${scope} session ${scope === 'foreign' ? 'does not delay' : 'waits before'} the STOP brake`, t => {
  const f = turnFixture(t), bin = path.join(f.root, 'bin'), ledger = path.join(f.root, 'ledger');
  fs.mkdirSync(bin); fs.mkdirSync(ledger);
  fs.writeFileSync(path.join(ledger, 'STOP'), 'test stops before launch\n');
  const agent = { ...f.agent, ...(scope === 'same' ? { cwd: f.cwd } : scope === 'unknown' ? { cwd: undefined } : {}) };
  const waited = path.join(f.root, 'waited');
  script(path.join(bin, 'herdr'), `case "$1 $2" in
  "agent list") if [ -f '${waited}' ]; then echo '{"result":{"agents":[]}}'; else echo '${JSON.stringify({ result: { agents: [agent] } })}'; fi ;;
  "agent get") echo '${JSON.stringify({ result: { agent } })}' ;;
  "agent wait") touch '${waited}'; echo '{"result":{}}' ;;
  "notification show") echo '{"result":{}}' ;;
  *) exit 99 ;;
esac`);
  const r = spawnSync(process.execPath, [WATCH, '--open', '--org', f.org, '--cwd', f.cwd,
    '--lane-config', path.join(f.root, 'unused.json'), '--checklist', path.join(f.root, 'unused.md'), '--ledger-dir', ledger], {
    encoding: 'utf8', timeout: loadTimeout(10_000), env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /STOP exists, so no session was opened/);
  assert.equal(fs.existsSync(waited), scope !== 'foreign', r.stdout);
  assert.equal(fs.existsSync(path.join(ledger, '.session-open.lock')), false);
});
