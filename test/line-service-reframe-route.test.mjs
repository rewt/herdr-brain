import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { transact, loadEvents } from '../lib/store.mjs';
import { gitProject } from '../lib/project.mjs';
import { createLineService, serviceDirectory, sourceRoot } from '../line-service/line-service.mjs';
import { reportRequestsReframe } from '../line-service/reframe-route.mjs';

const POLICY = { by_task_class: { 'reframe-other-family': { codex: 'claude-reframe', claude: 'codex-reframe' } } };
const ROUTES = {
  'codex-eng': { kind: 'codex', model: 'fixture', effort: 'high' },
  'claude-eng': { kind: 'claude', model: 'fixture', effort: 'high' },
  'codex-reframe': { kind: 'codex', model: 'fixture', effort: 'xhigh' },
  'claude-reframe': { kind: 'claude', model: 'fixture', effort: 'xhigh' },
};
// Exact words from the saved reports that did not reach another family.
const R1729 = 'The first scratch repair exposed new failure signatures: two conformance cases return 0 instead of required 75, and one deadline case observes four lookup retry sequences instead of one. The brief requires stopping this trajectory for one fresh other-family reframe.';
const R1798 = 'Stop the current source/check trajectory and route one fresh supported other-family reframe.';
const R1802 = 'The prior stop-rule requires one fresh supported other-family reframe before further correction work; no selected answer is present in the current owning item history. This dispatch is again codex/gpt-6.1-sol.';

function fixture(t, { engineer = 'codex', policy = POLICY } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'line-reframe-'))), repo = path.join(root, 'project'), org = path.join(repo, '.org');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(repo); fs.writeFileSync(path.join(root, '.identity-root'), 'fixture\n');
  const env = { ...process.env, ORG_DIR: org, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['LANE_CONFIG', 'HERDR_ENV', 'HERDR_PANE_ID', 'CODEX_THREAD_ID']) delete env[key];
  const exec = (exe, args) => { const r = spawnSync(exe, args, { cwd: repo, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim(); };
  const git = args => exec('git', args), record = args => exec(process.execPath, [path.join(sourceRoot, 'bin/org.mjs'), ...args]);
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Line fixture']); git(['config', 'user.email', 'line@example.invalid']);
  fs.writeFileSync(path.join(repo, 'source'), 'initial'); git(['add', '.']); git(['commit', '-qm', 'Initial']); record(['init']);
  const config = selection => JSON.stringify({ routes: { engineer: ROUTES[`${engineer}-eng`], ...ROUTES }, ...(selection ? { selection_policy: selection } : {}), dispatch: { max_sessions: 2 } });
  const configure = selection => fs.writeFileSync(path.join(repo, '.lane.json'), config(selection));
  configure(policy);
  const boundary = { id: 'fixture-cutover', project: gitProject(repo).identity, repo, org, source: fs.realpathSync(sourceRoot), main: 'main', canonical_head: git(['rev-parse', 'HEAD']) };
  transact(org, () => ({ add: ['line-service.cutover', 'line-service.phase0'].map(type => ({ ...boundary, type })) }));
  const directory = serviceDirectory(org, boundary.project); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'installation.json'), JSON.stringify({ at: '2026-10-27T00:00:00Z', repo, org, source: sourceRoot, node: process.execPath, file: path.join(directory, 'service.plist'), target: `gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}` }));
  const item = record(['add', 'Stopped engineering', '--role', 'engineer', '--priority', '1']).split(' ')[0];
  const calls = [], notes = [];
  const command = (exe, args) => {
    if (args[0] === path.join(sourceRoot, 'supervisor/closeout.mjs')) return { status: 0, stdout: '{"created":[]}', stderr: '' };
    calls.push(args);
    return { status: 0, stdout: JSON.stringify({ result: 'dispatched' }), stderr: '' };
  };
  const pass = () => createLineService({ repo, org, to: 'supervisor-test', env, command, haltAfter: 100, capacity: () => ({ count: 0, cap: 2 }),
    recordNotice: data => { notes.push(data.reason); return { id: data.id, state: 'record-only' }; } }).pass();
  let runs = 0;
  const report = (harness, report, sha256 = `report-${runs + 1}`) => {
    const id = `R-${++runs}`;
    transact(org, () => ({ add: [{ type: 'run.started', id, item, meta: { harness } },
      { type: 'report.ingested', run: id, sha256, file: `reports/${id}.md`, report }] }));
    return id;
  };
  const show = () => JSON.parse(record(['show', item, '--json']));
  const routes = () => calls.filter(args => args[0].endsWith('dispatch/dispatch.mjs')).map(args => args[args.indexOf('--route') + 1]);
  return { org, repo, item, record, report, pass, show, routes, notes, configure, events: () => loadEvents(org).events };
}
const failed = text => ({ outcome: 'failed', summary: 'Stopped.', blockers: [text] });
const blocked = text => ({ outcome: 'blocked', summary: 'Stopped.', blockers: [text] });

test('saved stop reports request a reframe; retrospective mentions and finished reports do not', () => {
  assert.equal(reportRequestsReframe(failed(R1729)), true);
  assert.equal(reportRequestsReframe({ outcome: 'failed', blockers: ['Other.'], extra: { decisions: [{ text: R1798 }] } }), true);
  assert.equal(reportRequestsReframe(blocked(R1802)), true);
  assert.equal(reportRequestsReframe({ outcome: 'blocked', summary: R1729, blockers: [], learnings: [R1729], extra: { challenges: [R1729] } }), false, 'a summary describes, it does not request');
  assert.equal(reportRequestsReframe(blocked('The completed other-family reframe found a new contract gap.')), false);
  assert.equal(reportRequestsReframe({ outcome: 'done', blockers: [R1729] }), false);
  assert.equal(reportRequestsReframe(blocked('Waiting for the installed runtime.')), false);
});

test('a failed Codex or Claude stop reaches its other family once, with no same-family start', t => {
  for (const [engineer, harness, expected] of [['codex', 'codex', 'claude-reframe'], ['claude', 'claude', 'codex-reframe']]) {
    const f = fixture(t, { engineer });
    f.report(harness, failed(R1729)); f.pass(); f.pass();
    assert.deepEqual(f.routes(), [expected]);
    const { meta, notes } = f.show();
    assert.equal(meta.route, expected);
    assert.equal(meta.reframe.request_run, 'R-1'); assert.equal(meta.reframe.family, harness);
    assert.ok(notes.some(n => /R-1 requested one fresh other-family reframe/.test(n.text)), 'the new brief carries the request');
    assert.equal(meta.hold, undefined);
  }
});

test('a blocked report with the request restarts on the other family and a plain blocked report stays', t => {
  const f = fixture(t); f.report('codex', blocked(R1802)); f.pass(); f.pass();
  assert.deepEqual(f.routes(), ['claude-reframe']);
  const plain = fixture(t); plain.report('codex', blocked('Waiting for the installed runtime.')); plain.pass();
  assert.deepEqual(plain.routes(), []); assert.equal(plain.show().meta.route, undefined);
});

test('the request survives a later same-family run that only reported the mismatch', t => {
  const f = fixture(t); f.report('codex', failed(R1729)); f.report('codex', { outcome: 'blocked', blockers: ['Waiting on the supervisor.'] }); f.pass();
  assert.deepEqual(f.routes(), ['claude-reframe']);
  assert.equal(f.show().meta.reframe.request_run, 'R-1');
});

test('an other-family default or explicit route is kept and a same-family default is not', t => {
  const moved = fixture(t, { engineer: 'claude', policy: null }); moved.report('codex', failed(R1729)); moved.pass();
  assert.deepEqual(moved.routes(), ['engineer'], 'the role default is already other-family');
  const explicit = fixture(t, { engineer: 'codex' });
  explicit.record(['set', explicit.item, 'meta.route=claude-eng']); explicit.report('codex', failed(R1729)); explicit.pass();
  assert.deepEqual(explicit.routes(), ['claude-eng']);
  const sameExplicit = fixture(t, { engineer: 'claude' });
  sameExplicit.record(['set', sameExplicit.item, 'meta.route=codex-eng']); sameExplicit.report('codex', failed(R1729)); sameExplicit.pass();
  assert.deepEqual(sameExplicit.routes(), ['claude-reframe']);
});

test('no qualifying route holds with a named reason and owner, then recovers when the owner configures one', t => {
  const f = fixture(t, { policy: null }); f.report('codex', blocked(R1802)); f.pass(); f.pass();
  assert.deepEqual(f.routes(), [], 'no session is spent to discover the mismatch');
  const { meta, notes } = f.show();
  assert.equal(meta.hold, true); assert.match(meta.hold_reason, /No configured engineering route is outside the codex family/);
  assert.ok(meta.owner); assert.match(meta.next_action, /reframe-other-family/);
  assert.equal(notes.filter(n => /Line held the requested other-family reframe/.test(n.text)).length, 1, 'held once');
  const effects = JSON.parse(fs.readFileSync(path.join(f.pass().directory, 'effects.json')));
  assert.ok(Object.values(effects.record_notices).some(n => n.boundary === `reframe:${f.item}` && n.inspection_due && /No configured engineering route/.test(n.reason)), 'the owner gets one inspection-due notice');
  // Failure and recovery on the same report: the negative observation must not outlive the owner's change.
  f.configure(POLICY); f.record(['set', f.item, 'meta.hold=false']); f.pass();
  assert.deepEqual(f.routes(), ['claude-reframe']);
});

test('clearing the hold with no route is the owner choice and does not hold again', t => {
  const f = fixture(t, { policy: null }); f.report('codex', failed(R1729)); f.pass();
  assert.equal(f.show().meta.hold, true);
  f.record(['set', f.item, 'meta.hold=false']); f.pass(); f.pass();
  assert.deepEqual(f.routes(), ['engineer']);
  assert.equal(f.show().meta.hold, false);
});

test('a failed reframe holds for a reshape instead of extending the trajectory', t => {
  const f = fixture(t); f.report('codex', failed(R1729)); f.report('claude', failed('The reframe premise also failed.')); f.pass();
  assert.deepEqual(f.routes(), []);
  assert.match(f.show().meta.hold_reason, /already spent on R-2/);
  const answered = fixture(t); answered.report('codex', failed(R1729)); answered.report('claude', blocked('Waiting for the installed runtime.')); answered.pass();
  assert.deepEqual(answered.routes(), []); assert.equal(answered.show().meta.hold, undefined, 'an ordinary blocked reframe keeps its own owner');
});

test('a reshape or a finished run ends the request', t => {
  const f = fixture(t); f.report('codex', failed(R1729));
  f.record(['set', f.item, 'title=Reshaped engineering']); f.pass();
  assert.deepEqual(f.routes(), ['engineer']); assert.equal(f.show().meta.reframe, undefined);
  const done = fixture(t); done.report('codex', failed(R1729)); done.report('codex', { outcome: 'done', summary: 'Fixed.' });
  done.report('codex', failed('A later unrelated failure.')); done.pass();
  assert.deepEqual(done.routes(), ['engineer']); assert.equal(done.show().meta.reframe, undefined);
});

test('unselected and held work is left alone and the only new events are existing types', t => {
  const f = fixture(t); f.record(['set', f.item, 'meta.queue_selected=false']); f.report('codex', failed(R1729)); f.pass();
  assert.deepEqual(f.routes(), []); assert.equal(f.show().meta.reframe, undefined);
  const held = fixture(t); held.record(['set', held.item, 'meta.hold=true']); held.report('codex', failed(R1729)); held.pass();
  assert.deepEqual(held.routes(), []); assert.equal(held.show().meta.reframe, undefined);
  const routed = fixture(t); routed.report('codex', failed(R1729)); const before = routed.events().length; routed.pass();
  const added = routed.events().slice(before).filter(e => e.by === 'line-service' && e.id === routed.item);
  assert.deepEqual([...new Set(added.map(e => e.type))].sort(), ['item.updated', 'note.added']);
});
