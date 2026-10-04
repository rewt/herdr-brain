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
  ]) fs.writeFileSync(path.join(sessions, `${name}.json`), JSON.stringify({ repo_id: p.identity, name, route, harness, model, created_at }));
  const get = () => supervisorStatus({ cwd: f.repo, org: f.org, now: '2026-10-04T11:05:00Z', agents: [
    { name: 'original', agent: 'claude', cwd: f.workspace, agent_status: 'done' },
    { name: 'reviewer', agent: 'codex', cwd: f.workspace, agent_status: 'working' },
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
  fs.writeFileSync(path.join(f.org, 'settle', `${run}.json`), JSON.stringify({ run, common: p.identity, stage: 'reviewing' }));
  const directory = path.join(f.repo, '.lane/sessions.json.d'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'review.json'), JSON.stringify({ repo_id: p.identity, name: 'reviewer', route: 'review-codex', harness: 'codex', model: 'review-model', created_at: '2026-10-04T10:00:00Z' }));
  fs.writeFileSync(path.join(directory, 'foreign.json'), JSON.stringify({ repo_id: '/foreign/.git', name: 'reviewer', model: 'foreign-model' }));
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  const doc = supervisorStatus({ cwd: f.repo, org: f.org, agents: [{ name: 'original', agent: 'claude', cwd: f.workspace, agent_status: 'done' },
    { name: 'reviewer', agent: 'codex', cwd: f.workspace, agent_status: 'working' }] });
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
