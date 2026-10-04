import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from '../../settle/test/fixture.mjs';
import { gitProject } from '../../lib/project.mjs';
import { fileURLToPath } from 'node:url';
import { supervisorStatus, renderStatus } from '../status.mjs';
import { autopilotNotice } from '../autopilot.mjs';

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
