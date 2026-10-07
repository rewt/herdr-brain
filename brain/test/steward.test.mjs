import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from '../../test/helpers/bounded-test.mjs';
import { stewardTick, readStewardJournal, operatorAlert } from '../lib/steward.mjs';
import { gitProject } from '../../lib/project.mjs';
import { rememberSupervisor } from '../../supervisor/session-binding.mjs';
import { drainInbox, readInbox, enqueueSupervisor } from '../../supervisor/prompt-supervisor.mjs';
import { plist } from '../lib/service.mjs';

const recorded = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}-blocked.json`, import.meta.url)));
const NOW = Date.parse('2026-10-07T14:00:00Z');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-steward-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'brain'), fleetHome = path.join(root, 'fleet');
  fs.mkdirSync(home); fs.mkdirSync(fleetHome);
  const repo = name => {
    const checkout = path.join(root, name, 'same-name');
    fs.mkdirSync(checkout, { recursive: true });
    const git = args => execFileSync('git', ['-C', checkout, ...args], { stdio: 'pipe' });
    git(['init', '-q']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture']);
    const identity = gitProject(checkout).identity, record = path.join(root, name, 'record');
    fs.mkdirSync(record); fs.writeFileSync(path.join(record, 'events.jsonl'), '');
    return { checkout, identity, record, worktrees: path.join(root, name, 'lanes'), temp: path.join(root, name, 'temp'), layers: [] };
  };
  const alpha = repo('alpha'), beta = repo('beta');
  const fleet = { version: 1, session_limit: 6, projects: { alpha, beta } };
  fs.writeFileSync(path.join(fleetHome, 'fleet.json'), JSON.stringify(fleet));
  const env = { ...process.env, HERDR_MONITOR_FLEET: fleetHome };
  const config = value => fs.writeFileSync(path.join(home, 'steward.json'), JSON.stringify(value));
  config({ projects: { alpha: { supervisor: 'alpha-supervisor' }, beta: { supervisor: 'beta-supervisor' } }, debounce_seconds: 60, stalled_seconds: 300, alert_cap: 3 });
  const agent = (name, p = alpha, status = 'blocked') => ({ name, pane_id: `${name}:p1`, terminal_id: `${name}:terminal`, agent_session: `${name}:native`, cwd: p.checkout, agent_status: status, agent: 'claude' });
  const worker = agent('worker'), supervisor = agent('alpha-supervisor', alpha, 'idle');
  const row = (a = worker, extra = {}) => ({ ...recorded('aggregator-gm'), id: 'blocked-one', at: new Date(NOW).toISOString(), session: a.name, where: a.cwd, pane: a.pane_id, terminal_id: a.terminal_id, agent_session: a.agent_session, project: 'beta', ...extra });
  const alerts = [], resumes = [];
  // Enqueue's production clock is wall time; freeze its notice age for the
  // threshold tests while keeping the real durable transport and ID checks.
  const enqueue = (...args) => {
    const receipt = enqueueSupervisor(...args);
    const events = fs.readFileSync(receipt.inbox, 'utf8').trim().split('\n').map(JSON.parse);
    for (const event of events) if (event.type === 'notice') event.at = new Date(NOW).toISOString();
    fs.writeFileSync(receipt.inbox, events.map(JSON.stringify).join('\n') + '\n');
    return receipt;
  };
  const tick = extra => stewardTick({ home, env, now: NOW, rows: [row()], agents: [worker, supervisor],
    enqueue, alert: async payload => { alerts.push(payload); }, resume: async file => { resumes.push(file); }, ...extra });
  const journal = () => readStewardJournal(path.join(home, 'steward/journal.json'));
  return { root, home, env, alpha, beta, fleet, config, agent, row, worker, supervisor, alerts, resumes, tick, journal };
}

test('a blocked worker routes by canonical fleet identity through the durable inbox, never its project label', async t => {
  const f = fixture(t);
  const result = await f.tick();
  const inbox = path.join(f.alpha.record, 'supervisor/inbox.log');
  assert.equal(result.actions[0].type, 'route');
  const entry = readInbox(inbox)[0];
  assert.equal(entry.to, 'alpha-supervisor');
  assert.equal(entry.project.identity, f.alpha.identity);
  assert.match(entry.message, /Allow this read outside/);
  assert.match(entry.message, /Yes, but ask again/);
  assert.equal(fs.existsSync(path.join(f.beta.record, 'supervisor')), false);
  assert.deepEqual(f.resumes, [inbox]);
  assert.deepEqual(f.alerts, []);
  assert.equal((await f.tick()).actions.length, 0, 'restart adopts acknowledged enqueue');
  assert.equal(readInbox(inbox).length, 1);
  assert.equal(fs.readFileSync(path.join(f.alpha.record, 'events.jsonl'), 'utf8'), '', 'no record writes');
});

test('linked worktrees outside the checkout route to the same fleet identity', async t => {
  const f = fixture(t), lane = path.join(f.root, 'external-lane');
  execFileSync('git', ['-C', f.alpha.checkout, 'worktree', 'add', '-qb', 'lane', lane], { stdio: 'pipe' });
  const worker = { ...f.worker, cwd: lane };
  const result = await f.tick({ agents: [worker, f.supervisor], rows: [f.row(worker)] });
  assert.equal(result.actions[0].project, 'alpha');
  assert.equal(readInbox(path.join(f.alpha.record, 'supervisor/inbox.log'))[0].to, 'alpha-supervisor');
});

test('recorded blocked supervisors escalate to operator and steward without enqueuing to themselves', async t => {
  const f = fixture(t);
  for (const name of ['aggregator-gm', 'supervisor-opus']) {
    const r = recorded(name), a = f.agent(name);
    f.config({ projects: { alpha: { supervisor: name } } });
    const result = await f.tick({ agents: [a], rows: [f.row(a, { ...r, session: name, where: a.cwd, pane: a.pane_id })] });
    assert.equal(result.actions[0].kind, 'blocked-supervisor');
    assert.equal(fs.existsSync(path.join(f.alpha.record, 'supervisor/inbox.log')), false);
  }
  assert.match(f.alerts[0].message, /Allow this read outside/);
  assert.match(f.alerts[1].message, /fusion_chipnet/);
  assert.equal(f.journal().filter(e => e.type === 'alert-intent').length, 2);
});

test('native explicit supervisor launch bindings discover the recipient without a name convention', async t => {
  const f = fixture(t), supervisor = f.agent('unusual-recipient', f.alpha, 'idle');
  f.config({});
  rememberSupervisor({ ...gitProject(f.alpha.checkout), role: 'supervisor', org: f.alpha.record }, { HERDR_PANE_ID: supervisor.pane_id, MONITOR_SUPERVISOR_AGENT: supervisor.name });
  const result = await f.tick({ agents: [f.worker, supervisor] });
  assert.equal(result.actions[0].to, 'unusual-recipient');
  const blocked = { ...supervisor, agent_status: 'blocked' };
  assert.equal((await f.tick({ agents: [blocked], rows: [f.row(blocked)] })).actions[0].kind, 'blocked-supervisor');
});

test('missing, ambiguous, stale and foreign recipients escalate instead of guessing', async t => {
  const f = fixture(t);
  f.config({});
  assert.equal((await f.tick()).actions[0].kind, 'unresolved-route');
  const first = f.agent('first-native-supervisor', f.alpha, 'idle'), second = f.agent('second-native-supervisor', f.alpha, 'idle');
  for (const supervisor of [first, second]) rememberSupervisor({ ...gitProject(f.alpha.checkout), role: 'supervisor', org: f.alpha.record }, { HERDR_PANE_ID: supervisor.pane_id, MONITOR_SUPERVISOR_AGENT: supervisor.name });
  assert.equal((await f.tick({ now: NOW + 300000, agents: [f.worker, first, second] })).actions[0].kind, 'unresolved-route');
  f.config({ projects: { alpha: { supervisor: 'foreign' } } });
  assert.equal((await f.tick({ now: NOW + 600000, agents: [f.worker, f.agent('foreign', f.beta, 'idle')] })).actions[0].kind, 'unresolved-route');
  f.config({ projects: { alpha: { supervisor: 'alpha-supervisor' } }, alert_cap: 4 });
  f.fleet.projects.alpha.identity = f.beta.identity + '-stale';
  fs.writeFileSync(path.join(f.env.HERDR_MONITOR_FLEET, 'fleet.json'), JSON.stringify(f.fleet));
  assert.equal((await f.tick({ now: NOW + 1200000 })).actions[0].kind, 'unresolved-route');
});

test('newer DONE observations, resolved blocks, changed panes and new occupants suppress historical queue entries', async t => {
  const f = fixture(t);
  for (const change of [
    { agents: [{ ...f.worker, agent_status: 'working' }, f.supervisor] },
    { agents: [{ ...f.worker, pane_id: 'replacement' }, f.supervisor] },
    { agents: [{ ...f.worker, terminal_id: 'replacement' }, f.supervisor] },
    { agents: [{ ...f.worker, agent_session: 'replacement' }, f.supervisor] },
    { rows: [f.row(), f.row(f.worker, { id: 'done', state: 'done', at: new Date(NOW + 1000).toISOString() })] },
    { rows: [f.row(f.worker, { status: 'answered' })] },
    { rows: [f.row(f.worker, { where: f.beta.checkout })] },
  ]) assert.deepEqual((await f.tick(change)).actions, []);
});

test('stalled native notices share the alert channel and cap; acknowledged notices stop escalating', async t => {
  const f = fixture(t), inbox = path.join(f.alpha.record, 'supervisor/inbox.log');
  await f.tick();
  assert.equal((await f.tick({ now: NOW + 299000 })).actions.filter(a => a.type === 'alert').length, 0);
  assert.equal((await f.tick({ now: NOW + 300000 })).actions[0].kind, 'stalled-inbox');
  assert.equal((await f.tick({ now: NOW + 305000 })).actions.length, 0);
  assert.equal((await f.tick({ now: NOW + 360000 })).actions[0].kind, 'stalled-inbox');
  assert.equal((await f.tick({ now: NOW + 420000 })).actions[0].kind, 'stalled-inbox');
  assert.equal((await f.tick({ now: NOW + 480000 })).actions.length, 0);
  const entry = readInbox(inbox)[0];
  fs.appendFileSync(inbox, JSON.stringify({ type: 'sent', id: entry.id, at: new Date(NOW + 500000).toISOString() }) + '\n');
  assert.equal((await f.tick({ now: NOW + 1000000 })).actions.length, 0);
  assert.equal(f.alerts.length, 3);
});

test('legacy parked outbox notices are observed by age without writing or replaying them', async t => {
  const f = fixture(t), outbox = path.join(f.alpha.checkout, '.lane/supervisor/outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const msg = path.join(outbox, 'one.msg');
  fs.writeFileSync(msg, 'parked report'); fs.utimesSync(msg, (NOW - 600000) / 1000, (NOW - 600000) / 1000);
  const stat = fs.statSync(msg);
  const result = await f.tick({ rows: [] });
  assert.equal(result.actions[0].kind, 'stalled-legacy-outbox');
  assert.deepEqual(fs.readdirSync(outbox), ['one.msg']);
  assert.equal(fs.readFileSync(msg, 'utf8'), 'parked report');
  assert.equal(fs.statSync(msg).mtimeMs, stat.mtimeMs);
  assert.equal(fs.existsSync(path.join(f.alpha.record, 'supervisor')), false);
});

test('alerts survive failures, lost acknowledgements and restart, with durable intent before the local command', async t => {
  const f = fixture(t), supervisor = { ...f.supervisor, agent_status: 'blocked' };
  let attempts = 0;
  const opts = { agents: [supervisor], rows: [f.row(supervisor)], alert: async () => {
    attempts++;
    assert.equal(f.journal().filter(e => e.type === 'alert-intent').length, attempts);
    throw Error('channel unavailable');
  } };
  await f.tick(opts);
  // Simulate death after effect/intent but before its acknowledgement.
  const file = path.join(f.home, 'steward/journal.json'), data = JSON.parse(fs.readFileSync(file));
  data.events = data.events.filter(e => e.type !== 'alert-result'); fs.writeFileSync(file, JSON.stringify(data));
  await f.tick({ ...opts, now: NOW + 1000 });
  await f.tick({ ...opts, now: NOW + 60000 });
  await f.tick({ ...opts, now: NOW + 120000 });
  await f.tick({ ...opts, now: NOW + 180000 });
  assert.equal(attempts, 3);
});

test('enqueue lost acknowledgement retries the stable notice id and respects routing debounce', async t => {
  const f = fixture(t);
  const { enqueueSupervisor } = await import('../../supervisor/prompt-supervisor.mjs');
  const enqueue = (...args) => { enqueueSupervisor(...args); throw Error('lost reply'); };
  await f.tick({ enqueue });
  assert.equal(readInbox(path.join(f.alpha.record, 'supervisor/inbox.log')).length, 1);
  assert.equal((await f.tick({ now: NOW + 1000 })).actions.length, 0);
  await f.tick({ now: NOW + 60000 });
  assert.equal(readInbox(path.join(f.alpha.record, 'supervisor/inbox.log')).length, 1);
});

test('dry run and disabled mode make no writes, start no owners, and send no alerts', async t => {
  const f = fixture(t), result = await f.tick({ dryRun: true });
  assert.equal(result.actions[0].type, 'route');
  assert.equal(fs.existsSync(path.join(f.home, 'steward')), false);
  assert.equal(fs.existsSync(path.join(f.alpha.record, 'supervisor')), false);
  assert.deepEqual(f.resumes, []); assert.deepEqual(f.alerts, []);
  f.config({ enabled: false });
  assert.equal((await f.tick()).disabled, true);
});

test('corrupt configuration, fleet and journals refuse effects', async t => {
  const f = fixture(t);
  f.config({ alert_command: 'sh -c unsafe' });
  await assert.rejects(f.tick(), /argv array/);
  f.config({ projects: { typo: { supervisor: 'no' } } });
  await assert.rejects(f.tick(), /unknown steward fleet/);
  f.config({});
  fs.mkdirSync(path.join(f.home, 'steward'));
  fs.writeFileSync(path.join(f.home, 'steward/journal.json'), '{');
  await assert.rejects(f.tick(), /JSON/);
  fs.rmSync(path.join(f.home, 'steward/journal.json'));
  fs.writeFileSync(path.join(f.env.HERDR_MONITOR_FLEET, 'fleet.json'), '{');
  await assert.rejects(f.tick(), /invalid fleet/);
  assert.deepEqual(f.alerts, []);
});

test('bounded journal compaction preserves active alert caps while evicting old session history', async t => {
  const f = fixture(t), supervisor = { ...f.supervisor, agent_status: 'blocked' };
  const opts = { agents: [supervisor], rows: [f.row(supervisor)] };
  for (let i = 0; i < 3; i++) await f.tick({ ...opts, now: NOW + i * 60000 });
  const file = path.join(f.home, 'steward/journal.json'), data = JSON.parse(fs.readFileSync(file));
  data.events.push(...Array.from({ length: 1900 }, (_, i) => ({ key: `gone-${i}`, type: 'route-result', at: NOW })));
  fs.writeFileSync(file, JSON.stringify(data));
  const other = f.agent('beta-supervisor', f.beta);
  await f.tick({ ...opts, now: NOW + 240000, agents: [supervisor, other], rows: [f.row(supervisor), f.row(other)] });
  assert.ok(f.journal().length <= 136);
  assert.equal(f.alerts.filter(a => a.session === supervisor.name).length, 3);
  assert.equal((await f.tick({ ...opts, now: NOW + 300000 })).actions.length, 0);
});

test('offline inbox observation continues escalating with the same cap when Herdr is down', async t => {
  const f = fixture(t);
  await f.tick();
  await f.tick({ now: NOW + 300000 });
  for (let i = 1; i <= 4; i++) await f.tick({ agents: null, now: NOW + 300000 + i * 60000 });
  assert.equal(f.alerts.length, 3);
});

test('the local alert command receives a single literal JSON argument without shell interpretation', async t => {
  const f = fixture(t), output = path.join(f.root, 'alert.json'), script = path.join(f.root, 'alert.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], process.argv[3]);`);
  const payload = { message: '$(touch NO) `touch NO` " quoted\nnew line' };
  await operatorAlert(payload, { alert_command: [process.execPath, script, output] });
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), payload);
  assert.equal(fs.existsSync(path.join(f.root, 'NO')), false);
});

test('the native inbox gate refuses a blocked recipient with a recorded dialog, without typing or keys', async t => {
  const f = fixture(t), herdr = path.join(f.root, 'herdr'), calls = path.join(f.root, 'calls');
  fs.writeFileSync(herdr, `#!${process.execPath}\nimport fs from 'node:fs'; const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n'); if(args[0]==='agent'&&args[1]==='get') console.log(JSON.stringify({result:{agent:{pane_id:'sup:p1',agent:'claude',agent_status:'blocked'}}})); else if(args[0]==='notification') console.log('{}'); else throw Error('input must never be touched');\n`, { mode: 0o755 });
  await f.tick({ env: { ...f.env, HERDR_BIN: herdr } });
  const inbox = path.join(f.alpha.record, 'supervisor/inbox.log');
  await drainInbox(inbox, { owner: true, waitSeconds: 0, confirmSeconds: 0, id: readInbox(inbox)[0].id });
  const argv = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(argv.some(a => a[0] === 'agent' && a[1] === 'get'));
  assert.ok(argv.every(a => !['prompt', 'send-keys', 'send-text'].includes(a[1])));
  assert.equal(readInbox(inbox)[0].state, 'pending');
});

test('service installation has no background digest flag and steward defaults need no model', () => {
  assert.doesNotMatch(plist(), /--digest/);
  assert.match(plist(), /<string>watch<\/string>/);
});

test('retired session cap receipts survive unrelated journal compaction and later restoration', async t => {
  const f = fixture(t), supervisor = { ...f.supervisor, agent_status: 'blocked' };
  const opts = { agents: [supervisor], rows: [f.row(supervisor)] };
  for (let i = 0; i < 3; i++) await f.tick({ ...opts, now: NOW + i * 60000 });
  const other = f.agent('beta-supervisor', f.beta);
  await f.tick({ agents: [other], rows: [f.row(other)], now: NOW + 240000 });
  assert.equal(f.journal().filter(e => e.type === 'alert-intent' && e.session === supervisor.name).length, 3);
  assert.deepEqual((await f.tick({ ...opts, now: NOW + 300000 })).actions, []);
});

test('journal saturation refuses an effect before the command and preserves the existing cap receipts', async t => {
  const f = fixture(t);
  const file = path.join(f.home, 'steward/journal.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ version: 1, events: Array.from({ length: 2048 }, (_, i) => ({ key: `old-${i}`, type: 'alert-intent', at: NOW })) }));
  const before = fs.readFileSync(file);
  await assert.rejects(f.tick({ rows: [f.row(f.supervisor)], agents: [{ ...f.supervisor, agent_status: 'blocked' }] }), /journal full/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(f.alerts, []);
});

test('the watcher captures first-seen and replacement-session blocks without a digest model', async t => {
  const f = fixture(t), herdr = path.join(f.root, 'herdr'), alertFile = path.join(f.root, 'operator-alert.json'), alertScript = path.join(f.root, 'alert.mjs'), agentFile = path.join(f.root, 'agent.json');
  f.config({ projects: { alpha: { supervisor: f.worker.name } }, alert_command: [process.execPath, alertScript, alertFile] });
  fs.writeFileSync(agentFile, JSON.stringify(f.worker));
  fs.writeFileSync(alertScript, `import fs from 'node:fs'; fs.appendFileSync(process.argv[2], process.argv[3]+'\\n');`);
  fs.writeFileSync(herdr, `#!${process.execPath}\nimport fs from 'node:fs'; const args=process.argv.slice(2); if(args[0]==='agent'&&args[1]==='list') console.log(JSON.stringify({result:{agents:[JSON.parse(fs.readFileSync(${JSON.stringify(agentFile)}))]}})); else if(args[0]==='agent'&&args[1]==='read') process.stdout.write(${JSON.stringify(recorded('aggregator-gm').screen)}); else if(args[0]==='tab'&&args[1]==='list') console.log(JSON.stringify({result:{tabs:[]}})); else throw Error('unexpected command');\n`, { mode: 0o755 });
  const { spawnChild, waitForExit } = await import('../../test/helpers/child.mjs');
  const child = spawnChild(t, process.execPath, [new URL('../bin/brain.mjs', import.meta.url).pathname, 'watch', '--every', '0.02'], { env: { ...f.env, BRAIN_STATE: f.home, HERDR_BIN: herdr } });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(alertFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  fs.writeFileSync(agentFile, JSON.stringify({ ...f.worker, terminal_id: 'replacement-terminal', agent_session: 'replacement-native' }));
  while (Date.now() < deadline && (!fs.existsSync(alertFile) || fs.readFileSync(alertFile, 'utf8').trim().split('\n').length < 2)) await new Promise(resolve => setTimeout(resolve, 20));
  child.kill('SIGTERM');
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stderr);
  const alerts = fs.readFileSync(alertFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(alerts.length, 2);
  assert.ok(alerts.every(a => a.kind === 'blocked-supervisor'));
  assert.match(result.stdout, /no digest/);
  const seen = JSON.parse(fs.readFileSync(path.join(f.home, 'watch.json')));
  assert.equal(seen.digest, false);
  const events = fs.readFileSync(path.join(f.home, 'queue.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.type === 'result').length, 2);
  assert.equal(events[0].terminal_id, f.worker.terminal_id);
  assert.equal(events[0].agent_session, f.worker.agent_session);
  assert.equal(events.filter(e => e.type === 'result')[1].terminal_id, 'replacement-terminal');
  assert.notEqual(events.filter(e => e.type === 'result')[0].id, events.filter(e => e.type === 'result')[1].id);
});
