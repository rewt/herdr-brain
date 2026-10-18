import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from '../../settle/test/fixture.mjs';
import { gitProject } from '../../lib/project.mjs';
import { fileURLToPath } from 'node:url';
import { supervisorStatus, renderStatus } from '../status.mjs';
import { autopilotNotice, POLICY } from '../autopilot.mjs';
import { receiptDirectory } from '../context.mjs';

test('status disables missing and unknown cohorts and enables only clean-pass', t => {
  const f = fixture(t);
  const config = JSON.parse(fs.readFileSync(path.join(f.org, 'config.json')));
  config.approvals.categories.tooling = 'auto';
  fs.writeFileSync(path.join(f.org, 'config.json'), JSON.stringify(config));
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  for (const [enabled, cohort, reason] of [
    [true, undefined, 'cohort unset'], [true, 'unknown', 'cohort unknown'],
    [true, 'clean-pass', null], [false, 'clean-pass', 'project kill switch'],
  ]) {
    const file = path.join(f.repo, '.supervisor.json');
    const settings = JSON.stringify({ autopilot: { enabled, cohort } });
    fs.writeFileSync(file, settings);
    const doc = supervisorStatus({ cwd: f.workspace, org: f.org, agents: [] });
    assert.equal(doc.autopilot.enabled, reason === null);
    assert.equal(doc.autopilot.reason, reason);
    assert.ok(renderStatus(doc).includes(`Autopilot: ${reason === null ? 'enabled' : `disabled (${reason})`}\n`));
    assert.equal(fs.readFileSync(file, 'utf8'), settings);
  }
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
  assert.deepEqual(f.calls(), []);
});

test('status derives all lane stages and timing without record mutations or model calls', t => {
  const f = fixture(t), run = f.start(), project = gitProject(f.repo);
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  const get = () => supervisorStatus({ cwd: f.workspace, org: f.org, now: '2026-10-04T20:00:00Z',
    agents: [{ name: 'original', agent: 'codex', model: 'gpt-test', cwd: f.workspace, pane_id: 'p1', agent_status: 'working' }] });
  let doc = get(), row = doc.lanes[0];
  assert.equal(row.run, run); assert.equal(row.stage, 'engineering');
  assert.equal(row.provider, 'codex'); assert.equal(row.model, 'gpt-test');
  assert.equal(row.started, f.show(run).started.at); assert.ok(row.running_seconds >= 0);
  fs.mkdirSync(path.join(f.org, 'settle'), { recursive: true });
  const save = value => fs.writeFileSync(path.join(f.org, 'settle', `${run}.json`), JSON.stringify({ run, common: project.identity, ...value }));
  save({ stage: 'reviewing' }); assert.equal(get().lanes[0].stage, 'review');
  save({ stage: 'fix' }); assert.equal(get().lanes[0].stage, 'fix');
  fs.mkdirSync(path.join(project.identity, 'promote'), { recursive: true });
  const queue = results => fs.writeFileSync(path.join(project.identity, 'promote/queue.json'), JSON.stringify({ identity: project.identity, pending: [], current: null, results }));
  queue([{ id: 'job', run, org: f.org, outcome: 'pending' }]); assert.equal(get().lanes[0].stage, 'train');
  queue([{ id: 'job', run, org: f.org, outcome: 'promoted', integrated_at: '2026-10-04T19:00:00Z' }]);
  doc = get(); assert.equal(doc.lanes[0].stage, 'landed');
  assert.match(renderStatus(doc), /RUN\s+ITEM\s+LANE\s+STAGE\s+PROVIDER\s+MODEL\s+STARTED\s+RUNNING/);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
});
test('status shows correction runs as fix and retains recent autopilot receipts', t => {
  const f = fixture(t), original = f.start(); f.report(original); f.record(['ingest', f.show(original).report_path]);
  const p = gitProject(f.repo);
  fs.mkdirSync(path.join(f.org, 'settle'), { recursive: true });
  const correction = f.start();
  fs.writeFileSync(path.join(f.org, 'settle', `${original}.json`), JSON.stringify({ common: p.identity, run: original, stage: 'complete', result: { result: 'fix_round', fix: { run: correction } } }));
  const receipt = autopilotNotice({ id: 'unknown', to: 'supervisor-test', message: '[new] uncertainty', project: { repo: f.repo, identity: p.identity, org: f.org } });
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  const doc = supervisorStatus({ cwd: f.repo, org: f.org, agents: [] });
  assert.equal(doc.lanes.length, 1); assert.equal(doc.lanes[0].stage, 'fix');
  assert.equal(doc.autopilot.actions[0].receipt, receipt.receipt);
  assert.match(renderStatus(doc), /autopilot/i);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
});
test('a correction moves from fix to its own review and displays the active reviewer metadata', t => {
  const f = fixture(t), original = f.start(); f.report(original); f.record(['ingest', f.show(original).report_path]);
  const p = gitProject(f.repo), correction = f.start(), settleDir = path.join(f.org, 'settle');
  fs.mkdirSync(settleDir, { recursive: true });
  fs.writeFileSync(path.join(settleDir, `${original}.json`), JSON.stringify({ common: p.identity, run: original, stage: 'complete', result: { result: 'fix_round', fix: { run: correction } } }));
  const sessions = path.join(f.repo, '.lane/sessions.json.d'); fs.mkdirSync(sessions, { recursive: true });
  for (const [name, route, harness, model, created_at] of [
    ['original', 'engineer', 'claude', 'engineer-model', '2026-10-04T10:00:00Z'],
    ['reviewer', 'review', 'codex', 'review-model', '2026-10-04T11:00:00Z'],
  ]) fs.writeFileSync(path.join(sessions, `${name}.json`), JSON.stringify({ repo_id: p.identity, name, route, harness, model, created_at, agent_session_id: name }));
  const get = () => supervisorStatus({ cwd: f.repo, org: f.org, now: '2026-10-04T11:05:00Z', agents: [
    { name: 'original', agent: 'claude', cwd: f.workspace, agent_status: 'done' },
    { name: 'reviewer', agent: 'codex', cwd: f.workspace, agent_status: 'working', agent_session: { value: 'reviewer' } },
  ] });
  assert.equal(get().lanes[0].stage, 'fix');
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  fs.writeFileSync(path.join(settleDir, `${correction}.json`), JSON.stringify({ run: correction, common: p.identity, stage: 'reviewing' }));
  const row = get().lanes[0];
  assert.equal(row.run, correction); assert.equal(row.stage, 'review');
  assert.equal(row.agent, 'reviewer'); assert.equal(row.live_status, 'working');
  assert.equal(row.provider, 'codex'); assert.equal(row.model, 'review-model');
  assert.equal(row.started, '2026-10-04T11:00:00Z'); assert.equal(row.running_seconds, 300);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
});
test('status warns and omits structurally damaged action receipts before sorting or mapping', t => {
  const f = fixture(t); f.start(); const p = gitProject(f.repo);
  const directory = path.join(receiptDirectory(f.org, p.identity), 'autopilot'); fs.mkdirSync(directory, { recursive: true });
  const at = '2026-10-04T11:00:00Z';
  const good = { policy: POLICY, key: 'notice:good', project: { identity: p.identity, org: f.org }, started: at,
    actions: [{ name: 'handle', phase: 'started', at }] };
  const damaged = [
    { actions: {} }, { actions: 'bad' }, { actions: null }, { actions: undefined },
    { actions: [null] }, { actions: [{}] }, { actions: [{ name: 'handle', phase: 'started', at: false }] },
    { started: undefined }, { started: 123 }, { started: 'bad' },
    { finished: {} }, { finished: 'bad' },
    { actions: [{ name: 'handle', phase: 'acknowledged', at, finished: 'bad' }] },
  ];
  const save = (name, data) => fs.writeFileSync(path.join(directory, name), JSON.stringify(data));
  save('good.json', good);
  save('finished.json', { ...good, key: 'notice:finished', finished: '2026-10-04T11:01:00Z', disposition: 'handled',
    actions: [{ name: 'handle', phase: 'acknowledged', at, finished: '2026-10-04T11:01:00Z' }] });
  damaged.forEach((changes, i) => save(`damaged-${i}.json`, { ...good, ...changes }));
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  const bytes = fs.readdirSync(directory).map(name => [name, fs.readFileSync(path.join(directory, name))]);
  const doc = supervisorStatus({ cwd: f.repo, org: f.org, agents: [] });
  assert.deepEqual(doc.autopilot.actions.map(a => a.key), ['notice:finished', 'notice:good']);
  damaged.forEach((_, i) => assert.ok(doc.warnings.some(w => w.includes(`damaged-${i}.json`) && /damaged/i.test(w))));
  assert.equal(doc.autopilot.actions[1].disposition, 'uncertain'); assert.match(renderStatus(doc), /damaged/i);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
  for (const [name, content] of bytes) assert.deepEqual(fs.readFileSync(path.join(directory, name)), content);
});
test('unavailable Herdr and malformed receipts are visible without changing state', t => {
  const f = fixture(t); f.start();
  fs.mkdirSync(path.join(f.org, 'settle'), { recursive: true });
  fs.writeFileSync(path.join(f.org, 'settle/R-1.json'), '{');
  const doc = supervisorStatus({ cwd: f.repo, org: f.org, herdr: path.join(f.root, 'missing-herdr') });
  assert.equal(doc.lanes[0].live_status, 'unknown');
  assert.ok(doc.warnings.some(w => w.includes('Herdr')));
  assert.ok(doc.warnings.some(w => w.includes('R-1.json')));
});
test('status CLI is read-only from a linked checkout and does not require a supervisor role', t => {
  const f = fixture(t), run = f.start(), before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  const command = fileURLToPath(new URL('../supervisor.mjs', import.meta.url));
  const r = f.exec(process.execPath, [command, 'status', '--json', '--org', f.org], f.workspace);
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).lanes[0].run, run);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
  assert.equal(f.calls().length, 1); assert.deepEqual(f.calls()[0], ['agent', 'list']);
});
test('review display uses matching session provider/model and excludes foreign session metadata', t => {
  const f = fixture(t), run = f.start(), p = gitProject(f.repo);
  fs.mkdirSync(path.join(f.org, 'settle'), { recursive: true });
  fs.writeFileSync(path.join(f.org, 'settle', `${run}.json`), JSON.stringify({ run, common: p.identity, stage: 'reviewing', reviewRoute: 'review-codex' }));
  const directory = path.join(f.repo, '.lane/sessions.json.d'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'review.json'), JSON.stringify({ repo_id: p.identity, name: 'reviewer', agent_session_id: 'reviewer', route: 'review-codex', harness: 'codex', model: 'review-model', created_at: '2026-10-04T10:00:00Z' }));
  fs.writeFileSync(path.join(directory, 'foreign.json'), JSON.stringify({ repo_id: '/foreign/.git', name: 'reviewer', model: 'foreign-model' }));
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  const doc = supervisorStatus({ cwd: f.repo, org: f.org, agents: [{ name: 'original', agent: 'claude', cwd: f.workspace, agent_status: 'done' },
    { name: 'reviewer', agent: 'codex', cwd: f.workspace, agent_status: 'working', agent_session: { value: 'reviewer' } }] });
  assert.equal(doc.lanes[0].stage, 'review'); assert.equal(doc.lanes[0].model, 'review-model');
  assert.equal(doc.lanes[0].provider, 'codex'); assert.equal(doc.lanes[0].started, '2026-10-04T10:00:00Z');
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
});
test('removed completed legacy lanes are history rather than active review lanes', t => {
  const f = fixture(t), run = f.start(); f.report(run); f.record(['ingest', f.show(run).report_path]);
  const archived = path.join(f.root, 'removed-lane'); fs.renameSync(f.workspace, archived);
  try { assert.deepEqual(supervisorStatus({ cwd: f.repo, org: f.org, agents: [] }).lanes, []); }
  finally { fs.renameSync(archived, f.workspace); }
});

test('the current reviewer matches the configured opaque route and verified occupant, working before idle', t => {
  const f = fixture(t), run = f.start(), p = gitProject(f.repo);
  const settle = path.join(f.org, 'settle'); fs.mkdirSync(settle, { recursive: true });
  fs.writeFileSync(path.join(settle, `${run}.json`), JSON.stringify({ run, common: p.identity, stage: 'reviewing', reviewRoute: 'engineer-xhigh' }));
  const directory = path.join(f.repo, '.lane/sessions.json.d'); fs.mkdirSync(directory, { recursive: true });
  const metadata = [
    ['idle', 'old', 'engineer-xhigh', '2026-10-04T10:00:00Z'],
    ['reused', 'stale', 'engineer-xhigh', '2026-10-04T12:00:00Z'],
    ['wrong-route', 'wrong', 'review-codex', '2026-10-04T12:00:00Z'],
    ['current', 'current', 'engineer-xhigh', '2026-10-04T11:00:00Z'],
  ];
  for (const [name, id, route, created_at] of metadata) fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify({
    repo_id: p.identity, name, agent_session_id: id, terminal_id: `terminal-${id}`, route, created_at, harness: 'codex', model: `${name}-model`,
  }));
  const agents = metadata.map(([name, id]) => ({ name, cwd: f.workspace, agent: 'codex',
    agent_session: { value: name === 'reused' ? 'replacement' : id }, terminal_id: `terminal-${id}`,
    agent_status: name === 'idle' ? 'idle' : 'working' }));
  const get = agents => supervisorStatus({ cwd: f.repo, org: f.org, agents, now: '2026-10-04T11:05:00Z' }).lanes[0];
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  const row = get(agents);
  assert.equal(row.agent, 'current'); assert.equal(row.model, 'current-model'); assert.equal(row.running_seconds, 300);
  assert.equal(get(agents.filter(a => a.name !== 'current')).agent, 'idle');
  assert.equal(get(agents.filter(a => !['current', 'idle'].includes(a.name))).agent, null);
  assert.equal(get([{ ...agents.at(-1), terminal_id: 'replacement' }]).model, null);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
});

test('recorded reports in retained checkouts are not active review without live work or an in-progress settlement', t => {
  const f = fixture(t), run = f.start(); f.report(run); f.record(['ingest', f.show(run).report_path]);
  const p = gitProject(f.repo), agents = [{ name: 'original', cwd: f.workspace, agent_status: 'done' }];
  const get = () => supervisorStatus({ cwd: f.repo, org: f.org, agents }).lanes;
  assert.deepEqual(get(), []);
  const directory = path.join(f.org, 'settle'); fs.mkdirSync(directory, { recursive: true });
  const save = saved => fs.writeFileSync(path.join(directory, `${run}.json`), JSON.stringify({ run, common: p.identity, ...saved }));
  save({ stage: 'complete' }); assert.deepEqual(get(), []);
  save({ stage: 'reviewing', reviewRoute: 'review' }); assert.equal(get()[0].stage, 'review');
  save({ stage: 'complete', result: { result: 'escalate' } }); assert.equal(get()[0].stage, 'blocked');
  save({ stage: 'complete', result: { result: 'promotable' } }); assert.equal(get()[0].stage, 'train');
});

test('open runs precede only today’s landed runs and refused promotion is blocked', t => {
  const f = fixture(t), run = f.start(), p = gitProject(f.repo);
  const item = f.record(['add', 'Another item', '--role', 'engineer']).split(' ')[0];
  const active = f.record(['start', item, '--workspace', f.workspace, '--meta', 'lane=other']).match(/R-\d+/)[0];
  const directory = path.join(p.identity, 'promote'); fs.mkdirSync(directory, { recursive: true });
  const save = job => fs.writeFileSync(path.join(directory, 'queue.json'), JSON.stringify({ identity: p.identity, pending: [], current: null, results: [job] }));
  const get = () => supervisorStatus({ cwd: f.repo, org: f.org, agents: [], now: '2026-10-04T20:00:00Z' }).lanes;
  save({ id: 'j', run, org: f.org, outcome: 'promoted', integrated_at: '2026-10-04T19:00:00Z' });
  assert.deepEqual(get().map(r => [r.run, r.stage]), [[active, 'engineering'], [run, 'landed']]);
  assert.equal(get()[1].title, 'Produce correct work');
  assert.equal(get()[1].running_seconds, Math.max(0, (Date.parse('2026-10-04T19:00:00Z') - Date.parse(f.show(run).started.at)) / 1000));
  save({ id: 'j', run, org: f.org, outcome: 'promoted', integrated_at: '2026-10-03T19:00:00Z' });
  assert.deepEqual(get().map(r => r.run), [active]);
  save({ id: 'j', run, org: f.org, outcome: 'refused' });
  assert.equal(get().find(r => r.run === run).stage, 'blocked');
});

test('a blocked report with no live session keeps its completed duration instead of counting idle hours', t => {
  const f = fixture(t), run = f.start(); f.report(run, 'blocked'); f.record(['ingest', f.show(run).report_path]);
  const reportAt = Date.parse(f.show(run).report.at);
  const get = hours => supervisorStatus({ cwd: f.repo, org: f.org, agents: [], now: new Date(reportAt + hours * 3600000).toISOString() }).lanes[0];
  assert.equal(get(1).stage, 'blocked');
  assert.equal(get(1).running_seconds, get(57).running_seconds);
});

test('a timed-out queue job displays blocked correction work rather than the train', t => {
  const f = fixture(t), run = f.start(), project = gitProject(f.repo);
  const directory = path.join(project.identity, 'promote'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'queue.json'), JSON.stringify({ identity: project.identity, pending: [], current: null,
    results: [{ id: 'timeout', run, org: f.org, outcome: 'timeout', reason: 'gate wall-clock limit exceeded; lane isolated for correction' }] }));
  assert.equal(supervisorStatus({ cwd: f.repo, org: f.org, agents: [] }).lanes[0].stage, 'blocked');
});
