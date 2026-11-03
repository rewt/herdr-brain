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
import { actionableCloseout, closeoutSourceEnabled, currentCloseoutEntries } from '../lib/closeout.mjs';
import { dispatchSourceBinding } from '../lib/source-provenance.mjs';
import { fold } from '../lib/state.mjs';
import { admittedRelease } from '../lib/run-owner.mjs';

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

function fixture(t, { engineer = 'codex', policy = POLICY, named: initial = ROUTES } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'line-reframe-'))), repo = path.join(root, 'project'), org = path.join(repo, '.org');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(repo); fs.writeFileSync(path.join(root, '.identity-root'), 'fixture\n');
  const env = { ...process.env, ORG_DIR: org, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['LANE_CONFIG', 'HERDR_ENV', 'HERDR_PANE_ID', 'CODEX_THREAD_ID']) delete env[key];
  const exec = (exe, args) => { const r = spawnSync(exe, args, { cwd: repo, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim(); };
  const git = args => exec('git', args), record = args => exec(process.execPath, [path.join(sourceRoot, 'bin/org.mjs'), ...args]);
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Line fixture']); git(['config', 'user.email', 'line@example.invalid']);
  fs.writeFileSync(path.join(repo, 'source'), 'initial'); git(['add', '.']); git(['commit', '-qm', 'Initial']); record(['init']);
  const config = (selection, named) => JSON.stringify({ routes: { engineer: ROUTES[`${engineer}-eng`], ...named }, ...(selection ? { selection_policy: selection } : {}), dispatch: { max_sessions: 2 }, retirement: { closeout_queue: true } });
  const configure = (selection, named = initial) => fs.writeFileSync(path.join(repo, '.lane.json'), config(selection, named));
  configure(policy);
  const boundary = { id: 'fixture-cutover', project: gitProject(repo).identity, repo, org, source: fs.realpathSync(sourceRoot), main: 'main', canonical_head: git(['rev-parse', 'HEAD']) };
  transact(org, () => ({ add: ['line-service.cutover', 'line-service.phase0'].map(type => ({ ...boundary, type })) }));
  const directory = serviceDirectory(org, boundary.project); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'installation.json'), JSON.stringify({ at: '2026-10-27T00:00:00Z', repo, org, source: sourceRoot, node: process.execPath, file: path.join(directory, 'service.plist'), target: `gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}` }));
  const item = record(['add', 'Stopped engineering', '--role', 'engineer', '--priority', '1']).split(' ')[0];
  const calls = [], notes = [];
  let full = false;
  const command = (exe, args, options) => {
    if (args[0] === path.join(sourceRoot, 'supervisor/closeout.mjs')) return hooks.closer ? spawnSync(exe, args, options) : { status: 0, stdout: '{"created":[]}', stderr: '' };
    calls.push(args);
    if (args[0] === path.join(sourceRoot, 'bin/org.mjs') && args[1] === 'close') return spawnSync(exe, args, options); // The real conditional record transaction.
    return { status: 0, stdout: JSON.stringify({ result: 'dispatched' }), stderr: '' };
  };
  const hooks = {};
  const service = () => createLineService({ repo, org, to: 'supervisor-test', env, command, haltAfter: 100, capacity: () => { hooks.capacity?.(); if (full) throw Object.assign(Error('build pool occupied'), { code: 'DISPATCH_SESSION_CAP', sessions: { kind: 'build', count: 2, cap: 2, sessions: [] } }); return { count: 0, cap: 2 }; },
    recordNotice: data => { notes.push(data.reason); return { id: data.id, state: 'record-only' }; } });
  const pass = () => service().pass();
  let runs = 0;
  const report = (harness, report, sha256 = `report-${runs + 1}`) => {
    const id = `R-${++runs}`;
    transact(org, () => ({ add: [{ type: 'run.started', id, item, meta: { harness } },
      { type: 'report.ingested', run: id, sha256, file: `reports/${id}.md`, report: { learnings: [], proposals: [], artifacts: [], ...report } }] }));
    return id;
  };
  const show = () => JSON.parse(record(['show', item, '--json']));
  const routes = () => calls.filter(args => args[0].endsWith('dispatch/dispatch.mjs')).map(args => args[args.indexOf('--route') + 1]);
  const closes = () => calls.filter(args => args[1] === 'close').map(args => args[2]);
  return { org, repo, env, git, item, record, report, pass, service, show, routes, closes, notes, configure, hooks, capacity: value => { full = value; }, events: () => loadEvents(org).events };
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

// Only Codex routes, so nothing can qualify for a Codex request.
const CODEX_ONLY = { 'codex-eng': ROUTES['codex-eng'], 'codex-reframe': ROUTES['codex-reframe'] };

test('clearing only the hold never starts the requesting family, and a configured route then recovers once', t => {
  const f = fixture(t, { policy: null, named: CODEX_ONLY }); const request = f.report('codex', failed(R1729)); f.pass();
  assert.equal(f.show().meta.hold, true);
  const reportOf = () => JSON.parse(f.record(['show', request, '--json'])).report.sha256, before = reportOf();
  for (let cleared = 0; cleared < 2; cleared++) {
    f.record(['set', f.item, 'meta.hold=false']); f.pass();
    assert.deepEqual(f.routes(), [], 'no same-family session after the owner cleared only the hold');
    const { meta } = f.show();
    assert.equal(meta.hold, true); assert.match(meta.hold_reason, /No configured engineering route is outside the codex family/); assert.ok(meta.owner);
  }
  f.configure(POLICY, ROUTES); f.record(['set', f.item, 'meta.hold=false']); f.pass(); f.pass();
  assert.deepEqual(f.routes(), ['claude-reframe'], 'exactly one start on the other family');
  const { meta } = f.show();
  assert.equal(meta.reframe.request_run, request); assert.equal(meta.reframe.family, 'codex');
  assert.equal(reportOf(), before, 'the original request and report are preserved');
});

test('clearing the hold on an unknown requesting family stays held until the item is reshaped', t => {
  const f = fixture(t); f.report(undefined, failed(R1729)); f.pass();
  assert.match(f.show().meta.hold_reason, /no recorded model family/);
  f.record(['set', f.item, 'meta.hold=false']); f.pass(); f.pass();
  assert.deepEqual(f.routes(), []);
  const { meta } = f.show();
  assert.equal(meta.hold, true); assert.match(meta.hold_reason, /no recorded model family/); assert.ok(meta.owner); assert.match(meta.next_action, /Reshape/);
  f.record(['set', f.item, 'title=Reshaped engineering']); f.record(['set', f.item, 'meta.hold=false']); f.pass();
  assert.deepEqual(f.routes(), ['engineer'], 'a reshape starts a new trajectory');
});

test('clearing the hold on a spent reframe stays held until the item is reshaped', t => {
  const f = fixture(t); f.report('codex', failed(R1729)); f.report('claude', failed('The reframe premise also failed.')); f.pass();
  assert.match(f.show().meta.hold_reason, /already spent on R-2/);
  f.record(['set', f.item, 'meta.hold=false']); f.pass();
  assert.deepEqual(f.routes(), []); assert.equal(f.show().meta.hold, true);
  f.record(['set', f.item, 'title=Reshaped engineering']); f.record(['set', f.item, 'meta.hold=false']); f.pass();
  assert.deepEqual(f.routes(), ['engineer']);
});

test('a saved route is revalidated against its current family before any start', t => {
  const SAME = { ...ROUTES, 'claude-reframe': { kind: 'codex', model: 'fixture', effort: 'xhigh' } };
  for (const report of [failed, blocked]) {
    // Repointed with nothing else qualifying: a named hold, then recovery on the original route.
    const f = fixture(t); f.capacity(true); f.report('codex', report(R1802)); f.pass();
    assert.deepEqual(f.routes(), []); assert.equal(f.show().meta.route, 'claude-reframe');
    f.configure(POLICY, SAME); f.capacity(false); f.pass(); f.pass();
    assert.deepEqual(f.routes(), [], 'no same-family start through the saved route');
    const { meta } = f.show();
    assert.equal(meta.hold, true); assert.match(meta.hold_reason, /outside the codex family/); assert.ok(meta.owner);
    f.configure(POLICY, ROUTES); f.record(['set', f.item, 'meta.hold=false']); f.pass(); f.pass();
    assert.deepEqual(f.routes(), ['claude-reframe']);
    // Repointed with another supported route: that route, once.
    const moved = fixture(t); moved.capacity(true); moved.report('codex', report(R1802)); moved.pass();
    moved.configure({ by_task_class: { 'reframe-other-family': { codex: 'claude-eng' } } }, SAME); moved.capacity(false); moved.pass(); moved.pass();
    assert.deepEqual(moved.routes(), ['claude-eng']);
    assert.equal(moved.show().meta.reframe.route, 'claude-eng'); assert.equal(moved.show().meta.hold, undefined);
    // Unchanged route: the saved route starts once.
    const same = fixture(t); same.capacity(true); same.report('codex', report(R1802)); same.pass();
    same.capacity(false); same.pass(); same.pass();
    assert.deepEqual(same.routes(), ['claude-reframe']);
  }
});

test('a request reported during admission waits for its route instead of the same-family default', t => {
  const f = fixture(t); f.record(['add', 'Independent ready work', '--role', 'engineer', '--priority', '9']);
  transact(f.org, () => ({ add: [{ type: 'run.started', id: 'R-1', item: f.item, meta: { harness: 'codex' } }] }));
  let once = false;
  f.hooks.capacity = () => { if (once) return; once = true; transact(f.org, () => ({ add: [{ type: 'report.ingested', run: 'R-1', sha256: 'late', file: 'reports/R-1.md', report: failed(R1729) }] })); };
  f.pass();
  assert.equal(f.show().meta.route, undefined); assert.equal(f.routes().length, 1, 'only the independent work started');
  f.pass();
  assert.deepEqual(f.routes().slice(1), ['claude-reframe']);
});

// A real allocation: the line started this run on the recorded reframe route.
function ownedRun(f, route, branch, meta = {}) {
  const workspace = path.join(path.dirname(f.repo), branch); f.git(['worktree', 'add', '-qb', `lane/${branch}`, workspace]);
  const run = f.record(['start', f.item, '--route', route, '--workspace', workspace, ...Object.entries({ lane: branch, ...meta }).flatMap(([k, v]) => ['--meta', `${k}=${v}`])]).match(/R-\d+/)[0];
  if (meta.dispatch_journal) { const identity = gitProject(f.repo).identity; transact(f.org, () => ({ add: [{ type: 'run.claimed', run, project: identity, record: f.org, owner: { controller: 'brain', legacy: false, release: admittedRelease() } }] })); }
  else f.record(['claim', run, '--controller', 'brain']);
  return { run, workspace, file: JSON.parse(f.record(['show', run, '--json'])).report_path };
}
const ingest = (f, { run, file }, body) => { fs.writeFileSync(file, `---\nrun: ${run}\noutcome: done\n${body}blockers: []\nproposals: []\n---\n`); f.record(['ingest', file]); };
const advice = 'summary: Read-only reframe. The item stays open; the premise to change is the wake boundary.\nheadline: The advice is in\nartifacts: []\n';

function advised(t) {
  const f = fixture(t); fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '\n.org/\n.lane/\n.lane.json\n');
  f.report('codex', failed(R1729)); f.pass();
  const reframe = ownedRun(f, 'claude-reframe', 'reframe'); ingest(f, reframe, advice);
  return { f, reframe };
}

test('an owned read-only reframe done report keeps its advice and closeout and does not close the item', t => {
  const { f, reframe } = advised(t);
  const report = JSON.parse(f.record(['show', reframe.run, '--json'])).report.sha256, start = f.events().length;
  f.pass(); f.pass();
  assert.deepEqual([...new Set(f.events().slice(start).filter(e => e.by === 'line-service' && e.id === f.item).map(e => e.type))].sort(), ['item.reopened', 'item.updated', 'note.added'], 'only existing event types');
  assert.deepEqual(f.closes(), [], 'no close command targets the advised item');
  const { closed, meta, notes, status } = f.show();
  assert.equal(closed, null); assert.notEqual(status, 'done', 'an open item does not read as finished or release its dependents');
  assert.equal(meta.reframe_advice, report); assert.equal(meta.hold, true); assert.ok(meta.owner); assert.match(meta.next_action, /clear meta\.hold/);
  assert.equal(notes.filter(n => n.text.includes(`${reframe.run} finished the reframe`)).length, 1, 'recorded once');
  assert.equal(JSON.parse(f.record(['show', reframe.run, '--json'])).report.sha256, report, 'the advice is preserved');
  // The finite closeout is bound to the report, independently of the item staying open.
  const events = f.events(), identity = gitProject(f.repo).identity, target = currentCloseoutEntries(identity, f.org, events).find(e => e.run === reframe.run);
  assert.equal(target?.reportCloseout, true); assert.equal(target.signal, 'ready'); assert.equal(target.cwd, fs.realpathSync(reframe.workspace));
  assert.ok(actionableCloseout(target, events) && closeoutSourceEnabled(target, events, { requireServiceSource: false }), 'the closer still selects it');
  assert.equal(events.filter(e => e.type === 'item.closed' && e.id === f.item).length, 0);
  // Clearing the hold starts the implementation; it is not a second advice marker or close.
  f.record(['set', f.item, 'meta.hold=false']); const before = f.routes().length; f.pass(); f.pass();
  assert.deepEqual(f.routes().slice(before), ['claude-reframe']); assert.deepEqual(f.closes(), []);
  assert.equal(f.show().meta.hold, false, 'cleared once stays cleared');
});

// The guarded landing receipt a real delivered implementation carries.
function deliver(f, route, branch) {
  const identity = gitProject(f.repo).identity, base = f.git(['rev-parse', 'HEAD']);
  const meta = { dispatch_project: identity, dispatch_record: f.org, dispatch_attempt: branch, dispatch_journal: path.join(f.org, `dispatch/${branch}.json`), agent: 'worker', pane: 'pane', worker_workspace: 'workspace', terminal_id: 'terminal', agent_session_id: 'session' };
  fs.mkdirSync(path.dirname(meta.dispatch_journal), { recursive: true });
  const owned = ownedRun(f, route, branch, meta);
  fs.writeFileSync(meta.dispatch_journal, JSON.stringify({ run: owned.run, item: f.item, common: identity, org: f.org, workspace: owned.workspace, base, token: branch }));
  fs.writeFileSync(path.join(owned.workspace, branch), 'source');
  const git = args => { const r = spawnSync('git', ['-C', owned.workspace, ...args], { env: f.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['add', '.']); git(['commit', '-qm', 'Delivered']);
  const head = git(['rev-parse', 'HEAD']); f.git(['merge', '-q', '--ff-only', head]);
  const events = f.events(), run = fold(events).runs.get(owned.run);
  const source = { ...dispatchSourceBinding({ run, events, identity, org: f.org }), base, head };
  transact(f.org, () => ({ add: [{ type: 'change.landed', project: identity, run: owned.run, item: f.item, head, base, previous_main: base, landing_tip: head, landed_at: new Date().toISOString(), source,
    producer: { agent: 'worker', pane: 'pane', terminal: 'terminal', session: 'session', ownership_generation: run.owner_generation } }] }));
  ingest(f, owned, `summary: Delivered.\nheadline: Delivered\nartifacts:\n  - "source: ${head}; base: ${base}"\n`);
  return { ...owned, head };
}

test('a later owned implementation after the advice completes normally', t => {
  const { f } = advised(t); f.pass();
  f.record(['set', f.item, 'meta.hold=false']);
  const later = deliver(f, 'claude-reframe', 'later'); f.pass(); f.pass();
  assert.deepEqual(f.closes(), [f.item]);
  const { closed } = f.show();
  assert.equal(closed.as, 'done'); assert.match(closed.note, new RegExp(`${later.run} .*immutable source ${later.head}`));
});

test('a later run with nothing to deliver is ordinary completion; only the reframe run is advice', t => {
  const { f } = advised(t); f.pass();
  f.record(['set', f.item, 'meta.hold=false']);
  ingest(f, ownedRun(f, 'claude-reframe', 'later'), 'summary: Implemented with no source to deliver.\nheadline: Finished\nartifacts: []\n');
  f.pass(); f.pass();
  assert.deepEqual(f.closes(), [f.item]); assert.equal(f.show().closed.as, 'done');
});

test('a reframe run that delivers source completes the item', t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '\n.org/\n.lane/\n.lane.json\n');
  f.report('codex', failed(R1729)); f.pass();
  deliver(f, 'claude-reframe', 'delivered'); f.pass(); f.pass();
  assert.deepEqual(f.closes(), [f.item]); assert.equal(f.show().closed.as, 'done'); assert.equal(f.show().meta.reframe_advice, undefined);
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
