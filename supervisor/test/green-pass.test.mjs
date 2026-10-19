import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { gitProject } from '../../lib/project.mjs';
import { createGreenCohort, greenContractRefusal, GREEN_CONTRACTS, lifecycleEvidence, LIFECYCLE_CASES } from '../green-pass.mjs';
import { buildManifest, BOOTSTRAP_FILES, INTERIM_MS, checkActivation, componentShape, activationNote, recordedActivation } from '../green-manifest.mjs';
import { sourceReach, executionClosure } from '../green-reach.mjs';
import { autopilotNotice, autopilotSettings } from '../autopilot.mjs';


// The bounded runner policy is already loaded and continues containing every
// child. Model the production parent's required-absent loader environment here.
delete process.env.NODE_OPTIONS;
const digest = value => createHash('sha256').update(value).digest('hex');
const sourceRenderer = fs.readFileSync(new URL('../../board/render.mjs', import.meta.url), 'utf8');
const sourceWidth = componentShape(sourceRenderer, 'board-default-width/v1').width;
const renderer = sourceRenderer.replace(`export function render(snapshot, { width = ${sourceWidth},`, 'export function render(snapshot, { width = 120,');
function setup(t, { binary = false, active = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'green-manifest-')));
  fixtureFleet(t, root); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'brain'), workspace = path.join(root, 'lane');
  fs.mkdirSync(repo);
  const put = (file, bytes, dir = repo) => { const target = path.join(dir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); };
  const git = (args, dir = repo) => {
    const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout.trim();
  };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Offline fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  fs.appendFileSync(path.join(repo, '.git/info/exclude'), '\n.org/\n.supervisor.json\n');
  put('.org/events.jsonl', '');
  for (const file of BOOTSTRAP_FILES) put(file, '// trusted bootstrap fixture\n');
  for (const file of ['board/rows.mjs', 'board/board.mjs', 'supervisor/reconcile.mjs', 'bin/org.mjs', 'supervisor/autopilot.mjs', 'housekeeping/config.mjs', 'lib/state.mjs', 'dispatch/record-worker.mjs', 'contrib/settle-watch.mjs']) put(file, 'export const unchanged = true;\n');
  for (const file of ['.lane.validation.json', '.promotion-selector.json', 'package.json']) put(file, '{}');
  put('test/board-view.test.mjs', '// ordinary tests, not promotion authority\n');
  put('board/render.mjs', renderer);
  const record = (args, actor = 'green-fixture') => {
    const result = spawnSync(process.execPath, [new URL('../../bin/org.mjs', import.meta.url).pathname, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, ORG_DIR: path.join(repo, '.org'), ORG_ACTOR: actor } });
    assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout.trim();
  };
  const item = record(['add', 'Offline renderer', '--role', 'engineer']).split(' ')[0];
  const brain = { repo, identity: gitProject(repo).identity, org: path.join(repo, '.org') };
  const sourceFiles = new Map(BOOTSTRAP_FILES.concat(['.lane.validation.json', '.promotion-selector.json', 'package.json', 'board/render.mjs', 'board/rows.mjs', 'board/board.mjs', 'supervisor/reconcile.mjs', 'bin/org.mjs', 'supervisor/autopilot.mjs', 'housekeeping/config.mjs', 'lib/state.mjs', 'dispatch/record-worker.mjs', 'contrib/settle-watch.mjs', 'test/board-view.test.mjs']).map(file => [file, { mode: '100644' }]));
  if (binary) { put('lib/native/launcher', Buffer.from([0xcf, 0xfa, 0, 0xfe])); fs.chmodSync(path.join(repo, 'lib/native/launcher'), 0o755); sourceFiles.set('lib/native/launcher', { mode: '100755' }); }
  const external = path.join(root, 'launcher.json'); fs.writeFileSync(external, '{}');
  const manifest = { ...buildManifest({ files: sourceFiles, bytes: file => fs.readFileSync(path.join(repo, file)), read: file => fs.readFileSync(path.join(repo, file), 'utf8') }, { bindings: { brain }, activation: { item, actor: 'supervisor-fixture' }, externalInputs: [external] }), exclusions: GREEN_CONTRACTS.exclusions };
  put('supervisor/green-contracts.json', JSON.stringify(manifest));
  git(['add', '.']); git(['commit', '-qm', 'Reviewed bootstrap fixture']);
  const base = git(['rev-parse', 'HEAD']); git(['worktree', 'add', '-qb', 'lane/change', workspace]);
  const bindings = { brain, lab: null, activatedAt: new Date().toISOString() }, checker = createGreenCohort(repo);
  const activate = () => {
    const bytes = fs.readFileSync(path.join(repo, 'supervisor/green-contracts.json'));
    record(['note', item, activationNote(digest(bytes)), '--decision'], manifest.activation.actor);
    const activation = recordedActivation(brain.org, digest(bytes), manifest.activation);
    bindings.activatedAt = activation.at; bindings.activationId = activation.id;
  };
  if (active) activate();
  const options = () => ({ ...brain, workspace, base, head: git(['rev-parse', 'HEAD'], workspace), bindings, run: 'R-1' });
  const change = (file = 'board/render.mjs', bytes = renderer.replace('width = 120,', 'width = 121,')) => {
    put(file, bytes, workspace); git(['add', '.'], workspace); git(['commit', '-qm', 'Candidate'], workspace); return git(['rev-parse', 'HEAD'], workspace);
  };
  return { root, repo, workspace, brain, bindings, base, record, item, activate, checker, options, manifest, put, git, change, external,
    scope: (extra = {}) => checker.scope({ ...options(), ...extra }) };
}

test('raw binary launcher pins and Git selector environment changes preserve containment', t => {
  const f = setup(t, { binary: true }); f.change(); const opts = f.options();
  fs.mkdirSync(process.env.HERDR_MONITOR_FLEET, { recursive: true });
  fs.writeFileSync(path.join(process.env.HERDR_MONITOR_FLEET, 'fleet.json'), JSON.stringify({ version: 1, session_limit: 4, projects: { brain: { identity: f.brain.identity, checkout: f.repo, record: f.brain.org, worktrees: f.root, layers: [] } } }));
  assert.equal(f.scope().eligible, true);
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_PAGER', 'GIT_R566_NEW_SELECTOR', 'NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S']) {
    const prior = process.env[key];
    try { process.env[key] = '/unreviewed/config'; assert.equal(f.checker.scope(opts).eligible, true, JSON.stringify(f.checker.scope(opts))); assert.equal(f.checker.environment()[key], undefined); }
    finally { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; }
  }
  assert.equal(f.scope().eligible, true);
  f.put('lib/native/launcher', Buffer.from([0xcf, 0xfb, 0, 0xfe]));
  assert.equal(f.scope().code, 'GREEN_REACH_UNKNOWN');
});
test('a real committed renderer candidate qualifies under a candidate-immutable manifest', t => {
  const f = setup(t); f.change(); const result = f.scope();
  assert.equal(result.eligible, true, JSON.stringify(result)); assert.equal(result.area, 'green');
  assert.deepEqual(result.manifest.components, [{ path: 'board/render.mjs', profile: 'board-default-width/v1', before: 120, after: 121 }]);
  assert.deepEqual(result.requiredTests, ['test/board-view.test.mjs']);
  assert.ok(result.authority.paths.includes('.lane.validation.json')); assert.ok(result.authority.paths.includes('.promotion-selector.json'));
  assert.equal(f.manifest.bindings.lab, null); assert.ok(!f.manifest.boundary['test/board-view.test.mjs']);
});
for (const bytes of [
  renderer + 'import(spec);\n', renderer.replace('width = 120,', 'width = (import(spec), 121),'),
  renderer.replace("import { WITHHELD } from './rows.mjs';", "import { WITHHELD } from './other.mjs';"),
  renderer.replace('c.value(row, c.width)', 'process.dlopen(module, row.path)'),
  renderer.replace('width = 120,', 'width = 79,'), renderer.replace('width = 120,', 'width = 241,'),
  renderer.replace('width = 120,', 'width = 0120,'), renderer.replace('width = 120,', 'width = 1e2,'),
  renderer.replace('output.write(ansi', 'eval(ansi'),
  renderer.replace('signals.removeListener', 'signals.addListener'),
]) test(`boundary-expanding or invalid renderer edits remain ordinary: ${digest(bytes).slice(0, 8)}`, t => {
  const f = setup(t); f.change('board/render.mjs', bytes); assert.equal(f.scope().code, 'GREEN_REACH_UNKNOWN');
});
for (const [file, code] of [
  ...['.lane.validation.json', '.promotion-selector.json', 'package.json'].map(file => [file, 'GREEN_SELF_AUTHORITY']),
  ['supervisor/green-contracts.json', 'GREEN_SELF_AUTHORITY'], ['supervisor/green-pass.mjs', 'GREEN_SELF_AUTHORITY'],
  ['supervisor/green-manifest.mjs', 'GREEN_SELF_AUTHORITY'], ['supervisor/GREEN-CONTRACTS.md', 'GREEN_SELF_AUTHORITY'],
  ['dispatch/record-worker.mjs', 'GREEN_SHARED_RUNTIME'], ['contrib/settle-watch.mjs', 'GREEN_BCH_CONSUMED'],
  ['supervisor/autopilot.mjs', 'GREEN_SELF_AUTHORITY'], ['supervisor/reconcile.mjs', 'GREEN_BCH_CONSUMED'],
  ['blue/hotfix.mjs', 'GREEN_BLUE_HOTFIX'], ['discovery/native-sandbox.mjs', 'GREEN_NATIVE_ISOLATION'],
  ['test-slot/ticket-queue.mjs', 'GREEN_HOST_RESOURCE'], ['sessions/authorization.mjs', 'GREEN_CROSS_PROJECT_AUTHORITY'],
  ['herdr/release.sh', 'GREEN_GLOBAL_RELEASE'], ['messages/receiver.mjs', 'GREEN_SHARED_RUNTIME'],
  ['test/helpers/run.mjs', 'GREEN_SELF_AUTHORITY'], ['acceptance/run.mjs', 'GREEN_SELF_AUTHORITY'],
  ['board/rows.mjs', 'GREEN_BOUNDARY_CHANGED'], ['bin/org.mjs', 'GREEN_BCH_CONSUMED'],
]) test(`preserved exclusion ${file} returns ${code}`, t => {
  const f = setup(t); f.change(file, '// candidate edit\n'); assert.equal(f.scope().code, code);
});
for (const file of ['README.md', 'docs/commands.md', 'docs/evidence/run.txt', 'test/board-view.test.mjs', 'sessions/retirement-policy.mjs']) test(`no blanket document, evidence, test or lifecycle permission: ${file}`, t => {
  const f = setup(t); f.change(file, '// not a component\n'); assert.equal(f.scope().eligible, false);
});
for (const operation of ['deleted', 'renamed', 'new-config', 'base-drift', 'running-drift', 'external-drift', 'external-missing', 'source-policy-drift', 'running-component-drift']) test(`boundary ${operation} invalidates an unrelated width candidate`, t => {
  const f = setup(t);
  if (operation === 'deleted') f.git(['rm', 'board/rows.mjs'], f.workspace);
  if (operation === 'renamed') f.git(['mv', 'board/rows.mjs', 'board/other.mjs'], f.workspace);
  if (operation === 'new-config') f.put('board/options.json', '{}', f.workspace);
  if (operation === 'base-drift') { f.change('housekeeping/config.mjs', '// prior ordinary drift\n'); f.base = f.git(['rev-parse', 'HEAD'], f.workspace); }
  if (operation === 'running-drift') f.put('board/rows.mjs', '// running source changed\n');
  if (operation === 'running-component-drift') f.put('board/render.mjs', renderer + 'import(spec);\n');
  if (operation === 'source-policy-drift') f.put('supervisor/green-manifest.mjs', '// stale loaded source\n');
  if (operation === 'external-drift') fs.writeFileSync(f.external, '{"changed":true}');
  if (operation === 'external-missing') fs.unlinkSync(f.external);
  f.change();
  const result = f.scope(operation === 'base-drift' ? { base: f.base } : {});
  assert.equal(result.eligible, false); assert.ok(['GREEN_REACH_UNKNOWN', 'GREEN_BOUNDARY_CHANGED'].includes(result.code), JSON.stringify(result));
});
test('loader environment drift refuses and restoring it does not grant extra components', t => {
  const f = setup(t); f.change(); const prior = process.env.NODE_PATH;
  try { process.env.NODE_PATH = '/foreign/loader'; assert.equal(f.scope().code, 'GREEN_REACH_UNKNOWN'); }
  finally { if (prior === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = prior; }
  assert.equal(f.scope().eligible, true);
});
test('an absent external configuration appearing later invalidates the reviewed absence', t => {
  const f = setup(t); const missing = path.join(f.root, 'new-config.json');
  f.manifest.externalInputs.push({ path: missing, sha256: null });
  f.put('supervisor/green-contracts.json', JSON.stringify(f.manifest)); f.git(['add', '.']); f.git(['commit', '-qm', 'Ordinary reviewed absence']);
  f.git(['rebase', 'main'], f.workspace); const checker = createGreenCohort(f.repo); f.activate(); f.change();
  const base = f.git(['rev-parse', 'main']);
  assert.equal(checker.scope({ ...f.options(), base }).eligible, true);
  fs.writeFileSync(missing, '{}'); assert.equal(checker.scope({ ...f.options(), base }).eligible, false);
});
for (const kind of ['foreign', 'record', 'identity', 'lane-record', 'lab-without-review', 'expiry', 'future']) test(`identity and activation refuse ${kind}`, t => {
  const f = setup(t); f.change(); const opts = f.options(); opts.bindings = structuredClone(opts.bindings);
  if (kind === 'foreign') opts.repo = f.workspace;
  if (kind === 'record') opts.org = f.root;
  if (kind === 'identity') opts.identity = f.root;
  if (kind === 'lane-record') f.put('.org/events.jsonl', '', f.workspace);
  if (kind === 'lab-without-review') opts.bindings.lab = f.brain;
  if (kind === 'expiry') opts.bindings.activatedAt = new Date(Date.now() - INTERIM_MS).toISOString();
  if (kind === 'future') opts.bindings.activatedAt = new Date(Date.now() + INTERIM_MS).toISOString();
  assert.equal(f.checker.scope(opts).code, ['expiry', 'future'].includes(kind) ? 'GREEN_EXPIRED' : 'GREEN_IDENTITY_MISMATCH');
});
test('ten-day interim is measured from activation, including the exact expiry boundary', () => {
  const start = '2026-10-19T12:00:00.000Z', now = Date.parse(start);
  const bindings = { activatedAt: start, activationId: 7 }, recorded = { at: start, id: 7 };
  assert.doesNotThrow(() => checkActivation(bindings, now + INTERIM_MS - 1, recorded));
  for (const value of [undefined, 'invalid', '2026-10-19']) assert.throws(() => checkActivation({ ...bindings, activatedAt: value }, now, recorded), /GREEN_EXPIRED/);
  for (const activationId of [undefined, 8, '7']) assert.throws(() => checkActivation({ ...bindings, activationId }, now, recorded), /GREEN_EXPIRED/);
  assert.throws(() => checkActivation(bindings, now + INTERIM_MS, recorded), /GREEN_EXPIRED/);
});
test('blue metadata, executable modes, dirty candidates and record mismatch remain ordinary', t => {
  const f = setup(t); f.change();
  assert.equal(f.scope({ item: { meta: { blue_hotfix: true } } }).code, 'GREEN_BLUE_HOTFIX');
  f.put('untracked.mjs', '', f.workspace); assert.equal(f.scope().eligible, false); fs.unlinkSync(path.join(f.workspace, 'untracked.mjs'));
  fs.chmodSync(path.join(f.workspace, 'board/render.mjs'), 0o755); f.git(['add', '.'], f.workspace); f.git(['commit', '-qm', 'Mode change'], f.workspace);
  assert.equal(f.scope().code, 'GREEN_NATIVE_ISOLATION');
});
test('an independently hashed generated review may accompany the exact component candidate', t => {
  const f = setup(t); f.change(); const bytes = '## Findings\nNone\n'; const review = { path: path.join(f.workspace, 'docs/reviews/green.md'), sha256: digest(bytes) };
  f.change('docs/reviews/green.md', bytes); assert.equal(f.scope({ review }).eligible, true);
  assert.equal(f.scope({ review: { ...review, sha256: '0'.repeat(64) } }).eligible, false);
});
test('reordered exclusions retain authority and ordinary refusal codes', () => {
  const contracts = structuredClone(GREEN_CONTRACTS); contracts.exclusions.push(contracts.exclusions.shift());
  for (const [file, code] of [['supervisor/green-pass.mjs', 'GREEN_SELF_AUTHORITY'], ['blue/fix.mjs', 'GREEN_BLUE_HOTFIX'], ['lib/state.mjs', 'GREEN_SHARED_RUNTIME']])
    assert.equal(greenContractRefusal(file, { contracts, authority: code === 'GREEN_SELF_AUTHORITY' }).code, code);
});

// Artifact verification remains tested without calling a synthetic lifecycle
// candidate an eligible production component.
for (const damage of ['none', 'missing', 'digest', 'stale-head', 'failed', 'symlink']) test(`future lifecycle artifact validator preserves controls: ${damage}`, t => {
  const f = setup(t); f.change(); const opts = f.options(), reportRoot = path.join(f.root, 'evidence'); fs.mkdirSync(reportRoot);
  const e = { version: 1, run: 'R-1', base: opts.base, head: opts.head, identity: f.brain.identity, org: f.brain.org, controls: {} };
  const artifact = (file, bytes) => { fs.writeFileSync(path.join(reportRoot, file), bytes); return { file, sha256: digest(bytes) }; };
  for (const [control, cases] of Object.entries(LIFECYCLE_CASES)) {
    const log = artifact(control + '.tap', cases.map((name, i) => `ok ${i + 1} - ${name}\n`).join('') + '# fail 0\n' + (damage === 'failed' ? 'not ok 9 - refusal\n' : ''));
    e.controls[control] = artifact(control + '.json', JSON.stringify({ ...e, schema: 'green-control/v1', control, command: ['node', 'controls.mjs'], exit_code: 0, log }));
  }
  if (damage === 'missing') delete e.controls.hold;
  if (damage === 'digest') fs.appendFileSync(path.join(reportRoot, 'hold.json'), ' ');
  if (damage === 'stale-head') e.head = 'f'.repeat(40);
  if (damage === 'symlink') { fs.renameSync(path.join(reportRoot, 'hold.json'), path.join(reportRoot, 'actual.json')); fs.symlinkSync('actual.json', path.join(reportRoot, 'hold.json')); }
  const call = () => lifecycleEvidence({ report: { green_lifecycle: e }, ...opts, binding: f.brain, reportRoot, git: args => f.git(args, f.workspace), after: {} });
  if (damage === 'none') assert.deepEqual(Object.keys(call().controls), Object.keys(LIFECYCLE_CASES));
  else assert.throws(call);
});

for (const mode of ['admit', 'refuse', 'cohort-change', 'binding-change']) test(`autopilot drives the real green checker: ${mode}`, t => {
  const f = setup(t); f.change('board/render.mjs', mode === 'refuse' ? renderer + 'import(spec);\n' : renderer.replace('width = 120,', 'width = 121,'));
  const settings = { autopilot: { enabled: true, cohort: 'green-pass', green: structuredClone(f.bindings) } };
  const configFile = path.join(f.repo, '.supervisor.json'); fs.writeFileSync(configFile, JSON.stringify(settings));
  const run = f.record(['start', f.item, '--workspace', f.workspace]).match(/R-\d+/)[0];
  const runInfo = JSON.parse(f.record(['show', run, '--json']));
  fs.writeFileSync(runInfo.report_path, `---\nrun: ${run}\noutcome: done\nsummary: Renderer change\nheadline: Renderer changed\nblockers: []\n---\n`);
  f.record(['ingest', runInfo.report_path]);
  const config = { approvals: { categories: { tooling: 'auto' } } }; fs.writeFileSync(path.join(f.brain.org, 'config.json'), JSON.stringify(config));
  const entry = { id: 'green-report', to: 'supervisor-test', project: f.brain, message: `[org-report] run=${run} item=${f.item} outcome=done headline=Changed` };
  const calls = [], scopes = [];
  const execute = (_file, args, options) => {
    calls.push({ args, options }); if (args[0] === 'promote') return JSON.stringify({ phase: 'acknowledged' });
    const head = f.git(['rev-parse', 'HEAD'], f.workspace), text = '## Findings\nNone\n\n## Analysis\nOffline independent-review stand-in.\n';
    const review = { verdict: 'PASS', text, sha256: digest(text), path: path.join(f.workspace, 'docs/reviews/green.md') };
    const result = { result: 'promotable', run, head, reviewed_commit: head, review };
    fs.mkdirSync(path.join(f.brain.org, 'settle'), { recursive: true }); fs.writeFileSync(path.join(f.brain.org, 'settle', run + '.json'), JSON.stringify({ common: f.brain.identity, org: f.brain.org, run, stage: 'complete', head, finalHead: head, mainHead: f.base, review, result }));
    return JSON.stringify(result);
  };
  // Observe the actual inputs while delegating all eligibility to the checker.
  const green = { ...f.checker, scope: options => { const result = f.checker.scope(options); scopes.push({ options, result }); return result; } };
  const result = autopilotNotice(entry, { execute, nativeWorker: () => {
    if (mode === 'cohort-change') { settings.autopilot = { enabled: true, cohort: 'clean-pass' }; fs.writeFileSync(configFile, JSON.stringify(settings)); }
    if (mode === 'binding-change') { settings.autopilot.green.brain.org = f.root; fs.writeFileSync(configFile, JSON.stringify(settings)); }
    return { pid: 1 };
  }, green });
  const receipt = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(result.disposition, mode === 'admit' ? 'handled' : 'wake', JSON.stringify(receipt));
  assert.equal(receipt.exception, mode === 'refuse' ? 'GREEN_REACH_UNKNOWN' : mode === 'cohort-change' ? 'AUTOPILOT_COHORT_CHANGED' : mode === 'binding-change' ? 'GREEN_IDENTITY_MISMATCH' : undefined);
  assert.ok(scopes.length);
  for (const { options } of scopes) {
    assert.deepEqual(options.bindings, f.bindings); assert.equal(options.run, run); assert.equal(options.report.outcome, 'done');
    assert.equal(options.reportRoot, path.dirname(runInfo.report_path));
  }
  if (mode === 'admit') {
    assert.deepEqual(calls.map(call => call.args[0]), ['handle', 'promote']);
    const args = calls[1].args; assert.ok(args.includes('--existing-worker'));
    assert.deepEqual(JSON.parse(args[args.indexOf('--required-tests') + 1]), ['test/board-view.test.mjs']);
    assert.equal(calls[1].options.env.NODE_OPTIONS, undefined); assert.equal(calls[1].options.env.GIT_CONFIG_COUNT, undefined);
  } else assert.ok(!calls.some(call => call.args[0] === 'promote'));
});
test('clean-pass rejects a green configuration key', t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.repo, '.supervisor.json'), JSON.stringify({ autopilot: { enabled: true, cohort: 'clean-pass', green: f.bindings } }));
  assert.throws(() => autopilotSettings(f.repo), /autopilot.enabled/);
});
test('cohort activation cannot be restarted by configuration, a later note or a reviewed manifest refresh', t => {
  const f = setup(t); f.change();
  const first = { at: f.bindings.activatedAt, id: f.bindings.activationId };
  f.activate(); assert.equal(f.bindings.activatedAt, first.at); assert.equal(f.bindings.activationId, first.id);
  assert.equal(f.scope().eligible, true);
  const changed = structuredClone(f.bindings); changed.activatedAt = new Date(Date.parse(first.at) + 1).toISOString();
  assert.equal(f.scope({ bindings: changed }).code, 'GREEN_EXPIRED');
  assert.throws(() => recordedActivation(f.brain.org, 'f'.repeat(64), f.manifest.activation), /no recorded activation/);
  // An ordinary-reviewed refresh changes the exact digest, while keeping the
  // cohort's first event identity and start. No new note means no admission.
  f.put('housekeeping/config.mjs', 'export const ordinaryReviewedRefresh = true;\n');
  f.manifest.boundary['housekeeping/config.mjs'].sha256 = digest('export const ordinaryReviewedRefresh = true;\n');
  f.put('supervisor/green-contracts.json', JSON.stringify(f.manifest));
  const refreshedDigest = digest(JSON.stringify(f.manifest));
  assert.throws(() => recordedActivation(f.brain.org, refreshedDigest, f.manifest.activation), /no recorded activation/);
  f.git(['add', 'supervisor/green-contracts.json', 'housekeeping/config.mjs']); f.git(['commit', '-qm', 'Reviewed manifest refresh']);
  f.git(['rebase', 'main'], f.workspace);
  const checker = createGreenCohort(f.repo), base = f.git(['rev-parse', 'main']);
  f.activate();
  const recorded = recordedActivation(f.brain.org, refreshedDigest, f.manifest.activation);
  assert.deepEqual(recorded, first);
  assert.equal(checker.scope({ ...f.options(), base }).eligible, true);
  assert.throws(() => checkActivation(f.bindings, Date.parse(first.at) + INTERIM_MS, recorded), /GREEN_EXPIRED/);
  const reset = { ...f.bindings, activationId: recorded.id + 1, activatedAt: new Date(Date.parse(first.at) + 1000).toISOString() };
  assert.throws(() => checkActivation(reset, Date.parse(first.at) + 1000, recorded), /GREEN_EXPIRED/);
});

test('only supervisor decisions on the reviewed activation item can anchor or bind a digest', t => {
  const f = setup(t, { active: false }); f.change();
  const digestOfManifest = digest(JSON.stringify(f.manifest)), supervisor = f.manifest.activation.actor;
  const other = f.record(['add', 'Unrelated work', '--role', 'engineer']).split(' ')[0];
  const strayNotes = value => {
    const text = activationNote(value);
    f.record(['note', f.item, text], supervisor);
    f.record(['note', other, text, '--decision'], supervisor);
    f.record(['note', f.item, text, '--decision']);
  };
  const recorded = value => recordedActivation(f.brain.org, value, f.manifest.activation);
  strayNotes(digestOfManifest);
  assert.throws(() => recorded(digestOfManifest), /no recorded activation/);
  assert.equal(f.scope().code, 'GREEN_EXPIRED');
  assert.throws(() => recordedActivation(f.brain.org, digestOfManifest), /no reviewed activation item/);
  f.activate();
  const first = recorded(digestOfManifest);
  assert.equal(f.scope().eligible, true);
  const events = fs.readFileSync(path.join(f.brain.org, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(first.id, events.at(-1).seq, 'earlier stray notes must not become the anchor');
  const refreshedDigest = 'f'.repeat(64);
  strayNotes(refreshedDigest);
  assert.throws(() => recorded(refreshedDigest), /no recorded activation/);
  assert.deepEqual(recorded(digestOfManifest), first);
  f.record(['note', f.item, activationNote(refreshedDigest), '--decision'], supervisor);
  assert.deepEqual(recorded(refreshedDigest), first, 'supervisor digest evidence retains the original interim');
});

test('promotion authority follows import and launch edges into routes and review-record validation', () => {
  const sources = new Map([
    ['settle/settle.mjs', "import '../lanes/routes.mjs'; const lane = new URL('../lanes/lane.mjs', import.meta.url);\n"],
    ['lanes/routes.mjs', "import './review-helper.mjs';\n"], ['lanes/lane.mjs', 'export const review = true;\n'],
    ['lanes/review-helper.mjs', 'export const route = true;\n'], ['board/render.mjs', renderer],
    ['test/board-view.test.mjs', "import '../board/render.mjs';\n"],
  ]);
  const tree = { files: new Map([...sources.keys()].map(file => [file, { mode: '100644' }])), read: file => sources.get(file) };
  const manifest = buildManifest(tree, { bindings: { brain: {} } });
  for (const file of ['lanes/routes.mjs', 'lanes/lane.mjs', 'lanes/review-helper.mjs']) assert.equal(manifest.boundary[file].role, 'promotion-authority', file);
  assert.equal(manifest.boundary['test/board-view.test.mjs'], undefined);
  assert.equal(manifest.boundary['board/render.mjs'], undefined);
});

test('pre-activation deployment check refuses stale committed pins before any activation note', t => {
  const f = setup(t), before = fs.readFileSync(path.join(f.brain.org, 'events.jsonl'));
  assert.doesNotThrow(() => f.checker.deployment());
  f.put('board/rows.mjs', '// unreviewed deployment drift\n');
  assert.throws(() => f.checker.deployment(), /running boundary drift/);
  assert.deepEqual(fs.readFileSync(path.join(f.brain.org, 'events.jsonl')), before);
});

test('source scanning never executes a candidate and follows literal loads inside templates', () => {
  const files = new Map([['lib/a.mjs', {}]]);
  const result = sourceReach('entry.mjs', "// import('./absent.mjs')\nconst pattern = /import\\('fake'\\)/;\nconst text = `${import('./lib/a.mjs')}`;\nthrow Error('candidate must never run');\n", files);
  assert.deepEqual(result.unknown, []); assert.deepEqual(result.dependencies, ['lib/a.mjs']);
});
test('a source-level lexical refusal preserves earlier known imports', () => {
  const result = sourceReach('entry.mjs', "import './lib/a.mjs'; const caf\u00e9 = 1;\n", new Map([['lib/a.mjs', {}]]));
  assert.deepEqual(result.dependencies, ['lib/a.mjs']); assert.ok(result.unknown.some(edge => /non-ASCII/.test(edge.reason)));
});
test('constant shadowing cannot resolve an unknown dynamic import to the outer constant', () => {
  const result = sourceReach('entry.mjs', "const file = './lib/a.mjs';\nfunction load(file) { return import(file); }\n", new Map([['lib/a.mjs', {}]]));
  assert.ok(result.unknown.length);
});
test('a referenced non-JavaScript launcher is retained as unknown rather than dropped', () => {
  const files = new Map([['launch.sh', { mode: '100644' }]]);
  assert.equal(executionClosure({ files, read: () => 'node computed-script' }, ['launch.sh']).unknown.length, 1);
});
test('escaped imports and literal URL spawns resolve without executing either target', () => {
  const files = new Map([['lib/a.mjs', {}], ['worker.mjs', {}]]);
  const source = "import './lib/\\u0061.mjs';\nconst delimiter = '\\0';\nimport { spawnSync as launch } from 'node:child_process';\nimport {fileURLToPath} from 'node:url';\nconst entry = fileURLToPath(new URL('./worker.mjs', import.meta.url));\nlaunch(process.execPath, [entry], {stdio: 'ignore'});\n";
  const result = sourceReach('entry.mjs', source, files);
  assert.deepEqual(result.dependencies, ['lib/a.mjs', 'worker.mjs']); assert.deepEqual(result.unknown, []);
});
test('the closed profile accepts pure data, literal modules and anchored named launchers', () => {
  const source = "import './lib/a.mjs'; export * from './lib/b.mjs'; import {fork as run} from 'node:child_process';\n" +
    "const values = [true, -2, 'text', {kind: 'data'}, ']']; export const selected = values[0]; export {selected as enabled};\n" +
    "import('./lib/c.mjs'); await import(`./lib/d.mjs`); run(new URL('./worker.mjs', import.meta.url), ['argument'], {silent: true, timeout: 1});\n";
  const names = ['lib/a.mjs', 'lib/b.mjs', 'lib/c.mjs', 'lib/d.mjs', 'worker.mjs'];
  const result = sourceReach('entry.mjs', source, new Map(names.map(file => [file, {}])));
  assert.deepEqual(result.unknown, []); assert.deepEqual(result.dependencies, names);
});
test('absolute script paths must map inside the bound source tree', () => {
  const files = new Map([['worker.mjs', {}]]), header = "import {spawnSync} from 'node:child_process';\n";
  const inside = sourceReach('entry.mjs', header + "spawnSync(process.execPath, ['/source/worker.mjs']);", files, {root: '/source'});
  assert.deepEqual(inside.unknown, []); assert.deepEqual(inside.dependencies, ['worker.mjs']);
  for (const target of ['/outside/worker.mjs', '/source/../outside/worker.mjs', './worker.mjs']) {
    assert.ok(sourceReach('entry.mjs', header + `spawnSync(process.execPath, [${JSON.stringify(target)}]);`, files, {root: '/source'}).unknown.length);
  }
});
for (const module of ['fs', 'path', 'crypto', 'os', 'url', 'util', 'assert', 'events', 'stream', 'buffer', 'timers', 'fs/promises', 'stream/promises', 'assert/strict']) {
  test(`ordinary builtin leaf ${module} is known`, () => {
    for (const prefix of ['', 'node:']) {
      const result = sourceReach('entry.mjs', `import * as leaf from '${prefix}${module}'; export const known = true;`, new Map());
      assert.deepEqual(result.unknown, []); assert.deepEqual(result.dependencies, []);
    }
  });
}
for (const source of [
  'export function ordinary(value) { const f = x => x + 1; if (value) return f(value); else return 0; }',
  'export class Counter { constructor(value) { this.value = value; } next() { return this.value + 1; } }',
  'let x = 1; x += 1; for (const v of [1, 2]) { x += v; } while (x < 5) { x++; }',
  'try { ordinaryCall(); } catch (error) { report(error.message); } finally { cleanup(); }',
  'const a = {x: 1}; const b = a.x; const c = a?.x; const xs = [1]; const d = xs[0]; const e = xs[-1];',
  'const value = 12 / 2; const pattern = /ordinary[0-9]+/i; const text = `value ${value}`;',
  'const values = condition ? [1, 2] : []; const other = condition ? [] : [3];',
  "const text = 'caf\u00e9'; // Unicode display text is data\nexport default text;",
]) test(`ordinary code stays known: ${source.slice(0, 70)}`, () => {
  assert.deepEqual(sourceReach('entry.mjs', source, new Map()).unknown, []);
});
for (const module of ['vm', 'module', 'worker_threads', 'inspector', 'wasi', 'repl', 'test', 'unknown-future-builtin']) {
  test(`non-leaf builtin ${module} refuses`, () => {
    assert.ok(sourceReach('entry.mjs', `import * as edge from 'node:${module}';`, new Map()).unknown.length);
  });
}
for (const body of [
  'return import(spec);', 'return require(spec);', 'return eval(text);', 'return Function(text);',
  'return process.dlopen(module, file);', 'return process.binding(name);', 'return target[key];',
  'return process._linkedBinding(name);', 'return target?.[key];',
  "Object.assign(process.env, {['NODE_' + 'OPTIONS']: code});",
  'const environment = process.env; return environment;', 'process.env.LD_PRELOAD = file;',
  "process.kill(process.pid, 'SIGUSR1');",
  "return Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), 'constructor').value(text);",
  'return target.constructor(text);', 'return `${import(spec)}`;', 'return `${`${import(spec)}`}`;',
]) test(`execution edge inside an ordinary function refuses: ${body}`, () => {
  assert.ok(sourceReach('entry.mjs', `export function ordinary(spec) { ${body} }`, new Map()).unknown.length);
});
for (const source of ["import {setEngine as load} from 'node:crypto'; load(file);", "import crypto from 'node:crypto'; const load = crypto.setEngine; load(file);", "import crypto from 'node:crypto'; Object.values(crypto)[0](file);", "export * from 'node:crypto';", "export {default as crypto} from 'node:crypto';", "import('node:crypto').then(ns => Object.values(ns)[0](file));"]) {
  test('native engine loading is not a crypto leaf operation', () => {
    assert.ok(sourceReach('entry.mjs', source, new Map()).unknown.length);
  });
}
for (const source of [
  "const entry = new URL('./worker.mjs', import.meta.url); function run(entry) { fork(entry); }",
  "const entry = new URL('./worker.mjs', import.meta.url); const alias = entry; fork(entry);",
  "const entry = new URL('./worker.mjs', import.meta.url); entry.pathname = other; fork(entry);",
  "const entry = new URL('./worker.mjs', import.meta.url); function run() { const fork = 1; } fork(entry);",
  "function run(URL) { fork(new URL('./worker.mjs', import.meta.url)); }",
  "function run(process) { spawnSync(process.execPath, ['/source/worker.mjs']); }",
]) test(`launcher capability cannot borrow a shadowed or escaped binding: ${source.slice(0, 70)}`, () => {
  const header = "import {fork,spawnSync} from 'node:child_process'; ";
  assert.ok(sourceReach('entry.mjs', header + source, new Map([['worker.mjs', {}]]), {root: '/source'}).unknown.length);
});
for (const source of [
  "while (x) { break\n/'/.test(s); import(spec); // '\n}",
  "while (x) { continue\n/'/.test(s); import(spec); // '\n}",
  "outer: while (x) { if (y) break outer\n/'/.test(s); import(spec); // '\n}",
  "outer: while (x) { if (y) continue outer\n/'/.test(s); import(spec); // '\n}",
  "debugger\n/'/.test(s); import(spec); // '\n",
  "const pattern = /[[a]/']/v; import(spec); // '\n",
]) test(`lexical context keeps execution tokens visible or unknown: ${source.slice(0, 55)}`, () => {
  assert.ok(sourceReach('entry.mjs', source, new Map()).unknown.length);
});
for (const source of [
  'const a = [1]; const b = a[key];', 'const a = [1]; const b = a["0"];',
  "// comment\u2028import(spec);", "// comment\rimport(spec);", "const name = '\\u{110000}';",
]) test(`unresolved execution constructs refuse: ${source.slice(0, 60)}`, () => {
  assert.ok(sourceReach('entry.mjs', source, new Map()).unknown.length);
});
for (const prefix of ['{', 'typeof', 'else', 'do', 'in', 'of', 'await', 'yield', 'void', 'delete', 'new', 'return', 'case', 'throw',
  '=', '===', '!==', '==', '!=', '+', '-', '*', '**', '/', '%', '&', '|', '^', '&&', '||', '??', '<', '>', '<=', '>=', '<<', '>>', '>>>', 'instanceof', 'default', '...', 'extends',
  '+=', '-=', '*=', '/=', '**=', '%=', '&=', '|=', '^=', '&&=', '||=', '??=', '<<=', '>>=', '>>>=']) {
  test(`regex prefix ${prefix} keeps a following loader visible or unknown`, () => {
    const frames = {
      '{': "{ /'/.test(s); import(spec); // '\n}\n",
      else: "if (x) {} else /'/.test(s); import(spec); // '\n",
      do: "do /'/.test(s); while (false); import(spec); // '\n",
      of: "for (const x of /'/.test(s)) {} import(spec); // '\n",
      yield: "function* g() { yield /'/.test(s); import(spec); // '\n}\n",
      return: "function g() { return /'/.test(s); import(spec); // '\n}\n",
      case: "switch (x) { case /'/.test(s): break; } import(spec); // '\n",
      default: "export default /'/.test(s); import(spec); // '\n",
      '...': "const items = [.../'/.exec(s)]; import(spec); // '\n",
      extends: "class C extends /'/.constructor {} import(spec); // '\n",
    };
    const unary = ['typeof', 'await', 'void', 'delete', 'new', 'throw'].includes(prefix);
    const source = frames[prefix] ?? `${unary ? prefix : `const result = value ${prefix}`} /'/.test(s); import(spec); // '\n`;
    const result = sourceReach('entry.mjs', source, new Map());
    assert.ok(result.unknown.length, JSON.stringify(result));
  });
}
test('a regex after a closing parenthesis cannot hide a loader in a fake string', () => {
  const result = sourceReach('entry.mjs', "if (x) /'/.test(s); import(spec); // '\n", new Map());
  assert.ok(result.unknown.some(e => /regex\/division/.test(e.reason)));
});
test('division remains outside the profile while preceding static imports remain inventoried', () => {
  for (const code of ['const ratio = (12) / 2;\n', 'const ratio = (12) / 2 / 3;\n']) {
    const result = sourceReach('entry.mjs', "import './lib/a.mjs';\n" + code, new Map([['lib/a.mjs', {}]]));
    assert.ok(result.unknown.length); assert.deepEqual(result.dependencies, ['lib/a.mjs']);
  }
});
test('fork overloads resolve anchored targets and closed literal options', () => {
  const header = "import { fork } from 'node:child_process';\nconst entry = new URL('./worker.mjs', import.meta.url);\n", files = new Map([['worker.mjs', {}]]);
  for (const source of [
    'fork(entry);', 'fork(entry, []);', 'fork(entry, {silent: true});',
    'fork(entry, [], {silent: true});',
  ]) {
    const reach = sourceReach('entry.mjs', header + source, files);
    assert.deepEqual(reach.unknown, [], source); assert.deepEqual(reach.dependencies, ['worker.mjs']);
  }
  for (const source of [
    'fork(entry, computedOptions);', 'fork(entry, {execPath: injected});',
    'fork(entry, [], {execArgv: injected});', 'const argv = []; fork(entry, argv);',
    'const options = {execPath: injected}; fork(entry, options);',
    'const options = {silent: true}; options.execPath = injected; fork(entry, options);',
  ]) assert.ok(sourceReach('entry.mjs', header + source, files).unknown.length, source);
});
test('authority execution closure follows imports and spawned references after source graph changes', () => {
  const files = new Map([
    ['authority.mjs', "import './gate.mjs'; export * from './metrics.mjs'; import {fork} from 'node:child_process'; fork(new URL('./handle.mjs', import.meta.url));\n"],
    ['gate.mjs', 'export const enabled = true;\n'],
    ['metrics.mjs', "import './clock.mjs';\n"], ['clock.mjs', 'export const now = 1;\n'],
    ['handle.mjs', "import './entry.mjs';\n"], ['entry.mjs', 'export const handle = true;\n'],
  ]);
  const tree = { files: new Map([...files.keys()].map(file => [file, {mode: '100644'}])), read(file) { assert.ok(files.has(file), file); return files.get(file); } };
  const first = executionClosure(tree, ['authority.mjs']);
  assert.deepEqual(first.unknown, []); assert.deepEqual(first.paths, ['authority.mjs', 'clock.mjs', 'entry.mjs', 'gate.mjs', 'handle.mjs', 'metrics.mjs']);
  files.set('gate.mjs', "import './new-helper.mjs';\n"); files.set('new-helper.mjs', 'export const enabled = false;\n');
  tree.files.set('new-helper.mjs', {mode: '100644'});
  assert.ok(executionClosure(tree, ['authority.mjs']).paths.includes('new-helper.mjs'));
  files.delete('new-helper.mjs'); assert.ok(executionClosure(tree, ['authority.mjs']).unknown.length);
});
for (const source of [
  "import('node:child_process').then(cp => cp.spawnSync('node', ['missing']));",
  "import cp from 'node:child_process'; cp['spawn' + 'Sync'](program, argv);",
  "const loader = (() => {})['constructor']; loader(text)();",
  "const operations = [load]; operations[index]();",
  "const target = './lib/a.mjs'; function launch(target) { return import(target); }",
  "const COMMANDS = { run: fn }; const alias = COMMANDS; COMMANDS[key]();",
  "const COMMANDS = { run: fn }; COMMANDS[other] = unknown; COMMANDS[key]();",
  "import {spawnSync} from 'node:child_process'; spawnSync('node', ['./worker.mjs'], {...options});",
  "import {spawnSync} from 'node:child_process'; spawnSync('node', ['./worker.mjs'], {['sh'+'ell']: true});",
  "process.dlopen(module, addonPath);",
  "import {fork} from 'node:child_process'; fork(computedPath);",
  "import {fork} from 'node:child_process'; fork('./worker.mjs', [], {execArgv: injected});",
  "import {fork} from 'node:child_process'; fork('git');",
]) test(`unsupported indirect execution fails closed: ${source.slice(0, 50)}`, () => {
  assert.ok(sourceReach('entry.mjs', source, new Map([['lib/a.mjs', {}]])).unknown.length);
});
