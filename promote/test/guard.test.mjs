import { recipientAgent } from '../../test/helpers/recipient-agent.mjs';
import { fixtureEnvironment } from '../../test/helpers/fixture-environment.mjs';
import { healthyMemoryEnvironment } from '../../test/helpers/promotion-memory-fixture.mjs';
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildManifest, boundaryInput, BOOTSTRAP_FILES, activationNote, recordedActivation, INTERIM_MS } from '../../supervisor/green-manifest.mjs';
import { GREEN_CONTRACTS } from '../../supervisor/green-pass.mjs';
import { renderer } from '../../supervisor/test/green-fixture.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { isolateSessionEnvironment } from '../../test/helpers/session-environment.mjs';
import { spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { stopOwnedInbox } from '../../test/helpers/inbox.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { lookupProcess } from '../../lib/processes.mjs';

// Containment is installed already; green checks require absent loader inputs.
delete process.env.NODE_OPTIONS;
// The file runner has already installed its signal observer. Neither that
// preload nor name selection is passed to the private Brain's native children.
// Pin their actual launcher, retaining every argument outside these two known
// runner inputs so the production drift check still rejects other differences.
const signalObserver = `--import=${fileURLToPath(new URL('../../test/helpers/runner-limits.mjs', import.meta.url))}`;
process.execArgv = process.execArgv.filter(arg => arg !== signalObserver && !arg.startsWith('--test-name-pattern='));
const source = fileURLToPath(new URL('../../', import.meta.url));
const loader = fileURLToPath(new URL('./helpers/green-loader.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Reading the index may update atime; only identity and write-version fields
// distinguish an optional refresh from a read-only scope query.
const indexVersion = file => {
  const stat = fs.statSync(file, { bigint: true });
  return ['dev', 'ino', 'mode', 'size', 'birthtimeNs', 'mtimeNs', 'ctimeNs'].map(key => stat[key]);
};

// Release sources are git archives, plus generated release/test state. Keep the
// full archive universe: productFiles() omits root config and test/helpers/ that
// the reviewed boundary includes.
const snapshotOmit = new Set(['.git', '.org', '.lane', '.test-slot-executions', 'node_modules', '.DS_Store',
  '.release-commit', '.release-acceptance.json', '.release-manifest.json']);
function snapshotFiles(root, relative = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (snapshotOmit.has(entry.name)) continue;
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...snapshotFiles(root, file));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(file);
  }
  return files.sort();
}

async function fixture(t, { foreign = false, cohort = 'green-pass' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-green-guard-')));
  fixtureFleet(t, root);
  isolateSessionEnvironment(t, root);
  const repo = path.join(root, 'brain'); fs.mkdirSync(repo);
  const env = { ...healthyMemoryEnvironment({ ...fixtureEnvironment(), NODE_OPTIONS: `--import=${JSON.stringify(loader)}` }),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SUPERVISOR_INPUT_WAIT_SECONDS: '0' };
  for (const key of Object.keys(env)) if (/^(ORG_|LANE_|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(key)) delete env[key];
  const exec = (command, args, cwd = repo) => spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const ok = r => { assert.equal(r.status, 0, r.stderr || r.stdout || r.error?.message); return r.stdout.trim(); };
  const git = (args, cwd = repo) => ok(exec('git', args, cwd));
  const put = (file, bytes, cwd = repo) => { const target = path.join(cwd, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); };
  // Run the actual promotion/guard modules from a private canonical Brain.
  // No candidate module, checker or native-process implementation is stubbed.
  const worktree = exec('git', ['rev-parse', '--is-inside-work-tree'], source);
  const inventoryFiles = worktree.status === 0 && worktree.stdout.trim() === 'true'
    ? git(['ls-files', '-z'], source).split('\0') : snapshotFiles(source);
  const files = inventoryFiles.filter(file => file && !['.lane.json', '.housekeeping.json'].includes(file) &&
    !['.agents', '.claude'].includes(file.split('/')[0]) &&
    (boundaryInput(file) || BOOTSTRAP_FILES.includes(file)));
  for (const file of files) {
    const target = path.join(repo, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, file), target); fs.chmodSync(target, fs.statSync(path.join(source, file)).mode & 0o777);
  }
  // This private project owns its policy: live desks, routes and closeout
  // settings must never enter its configuration or reviewed boundary.
  put('.lane.json', '{"retirement":{"closeout_queue":false}}\n');
  put('.housekeeping.json', '{"enabled":true}\n');
  put('board/render.mjs', renderer);
  put('docs/guide.md', 'Ordinary documentation outside the reviewed component.\n');
  put('test/board-view.test.mjs', "import assert from 'node:assert/strict';\nimport { render } from '../board/render.mjs';\nassert.ok(render({ memory: null, herdr: 'offline', slot: { state: 'free' }, rows: [] }).includes('Promotion board'));\nconsole.log('# tests 1');\n");
  const gate = path.join(root, 'gate.cjs'), checked = path.join(root, 'checked');
  fs.writeFileSync(gate, `require('child_process').execFileSync(process.execPath,['test/board-view.test.mjs'],{stdio:'inherit'});require('fs').appendFileSync(${JSON.stringify(checked)},'gate\\n');`);
  put('.lane.validation.json', JSON.stringify({ promotion: `${process.execPath} ${gate}` }));
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Green guard fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  const ignore = cwd => fs.appendFileSync(path.join(cwd, '.git/info/exclude'), '\n.org/\n.lane/\n.supervisor.json\n.housekeeping.json\n');
  ignore(repo);
  const record = (args, cwd = repo, actor = 'green-fixture') => ok(spawnSync(process.execPath, [path.join(repo, 'bin/org.mjs'), ...args], {
    cwd, env: { ...env, ORG_DIR: path.join(cwd, '.org'), ORG_ACTOR: actor }, encoding: 'utf8' }));
  record(['init', path.join(repo, '.org')]);
  const activationItem = record(['add', 'Reviewed private activation', '--role', 'engineer']).split(' ')[0];
  const brain = { repo, identity: fs.realpathSync(path.join(repo, '.git')), org: path.join(repo, '.org') };
  git(['add', '.']);
  const inventory = git(['ls-files', '-s', '-z']).split('\0').filter(Boolean).map(row => /^(\d+) \w+ 0\t(.+)$/.exec(row));
  const tree = { root: repo, files: new Map(inventory.map(row => [row[2], { mode: row[1] }])),
    bytes: file => fs.readFileSync(path.join(repo, file)), read: file => fs.readFileSync(path.join(repo, file), 'utf8') };
  const manifest = { ...buildManifest(tree, { bindings: { brain }, activation: { item: activationItem, actor: 'supervisor-fixture' }, externalInputs: [gate, loader] }), exclusions: GREEN_CONTRACTS.exclusions };
  put('supervisor/green-contracts.json', JSON.stringify(manifest));
  git(['add', '.']); git(['commit', '-qm', 'Reviewed private bootstrap']);
  record(['note', activationItem, activationNote(hash(JSON.stringify(manifest))), '--decision'], repo, 'supervisor-fixture');
  const activation = recordedActivation(brain.org, hash(JSON.stringify(manifest)), manifest.activation);
  const settings = { enabled: true, cohort, ...(cohort === 'green-pass' ? { green: { brain, lab: null, activatedAt: activation.at, activationId: activation.id } } : {}) };
  let project = repo;
  if (foreign) {
    project = path.join(root, 'foreign'); git(['clone', '--no-local', '-q', repo, project]); ignore(project);
    git(['config', 'user.name', 'Foreign fixture'], project); git(['config', 'user.email', 'foreign@example.invalid'], project);
    record(['init', path.join(project, '.org')], project);
    put('.housekeeping.json', '{"enabled":true}\n', project);
  }
  const configure = () => put('.supervisor.json', JSON.stringify({ autopilot: settings }), project); configure();
  const org = path.join(project, '.org'), workspace = path.join(root, 'candidate');
  git(['worktree', 'add', '-qb', 'lane/candidate', workspace], project);
  const base = git(['rev-parse', 'HEAD'], project);
  const change = (file, bytes) => { put(file, bytes, workspace); git(['add', '.'], workspace); git(['commit', '-qm', 'Candidate'], workspace); };
  change('board/render.mjs', renderer.replace('width = 120,', 'width = 121,'));
  const item = record(['add', 'Reviewed candidate', '--role', 'engineer'], project).split(' ')[0];
  const run = record(['start', item, '--workspace', workspace], project).match(/^R-\d+/)[0];
  record(['claim', run, '--controller', 'brain'], project);
  const show = id => JSON.parse(record(['show', id, '--json'], project));
  const reportPath = show(run).report_path;
  fs.writeFileSync(reportPath, `---\nrun: ${run}\noutcome: done\nsummary: Private fixture completed\nheadline: Private fixture completed\n---\n`);
  record(['ingest', reportPath], project);
  assert.equal(fs.existsSync(path.join(project, '.git', 'closeout')), false, 'promotion fixture starts no closeout consumer');
  const reviewText = '## Findings\nNone\n\n## Analysis\nOffline independent review stand-in.\n';
  const review = { verdict: 'PASS', text: reviewText, sha256: hash(reviewText), path: path.join(workspace, 'docs/reviews/guard.md') };
  const reviewed = git(['rev-parse', 'HEAD'], workspace); change('docs/reviews/guard.md', reviewText);
  const head = git(['rev-parse', 'HEAD'], workspace), identity = fs.realpathSync(path.join(project, '.git'));
  const settled = { common: identity, org, run, stage: 'complete', mainHead: base, head: reviewed, finalHead: head, review,
    result: { result: 'promotable', head, reviewed_commit: reviewed, review } };
  const save = () => put(`settle/${run}.json`, JSON.stringify(settled), org); save();
  const guard = { canonical: project, identity, org, workspace, topic: 'candidate', expectedHead: head, run, existingWorker: true };
  const { withPromotionGuard } = await import(pathToFileURL(path.join(repo, 'promote/guard.mjs')));
  const check = operation => withPromotionGuard(guard, operation);
  const herdr = path.join(root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
const a=process.argv.slice(2);if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{...${JSON.stringify(recipientAgent('offline', project, { pane_id: 'fake' }))},name:a[2]}}}));
else if(a[0]==='pane'&&a[1]==='read')console.log('────────────────────\\n❯ \\n────────────────────');
else console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));`, { mode: 0o755 });
  let workerDone;
  t.after(async () => {
    fs.writeFileSync(path.join(root, 'release-anchor'), 'release');
    if (workerDone) await workerDone;
    // Worker completion hands notices to a durable owner. Delivery is outside
    // these guard assertions; stop that fixture owner after all senders exit.
    await stopOwnedInbox(path.join(org, 'supervisor/inbox.log'), {
      script: path.join(repo, 'supervisor/prompt-supervisor.mjs'),
    });
    for (const canonical of new Set([repo, project])) {
      const closeout = path.join(canonical, '.git/closeout');
      assert.equal(fs.existsSync(path.join(closeout, 'consumer.lock')), false, 'private fixture has no closeout owner');
      // kickCloseout opens this log before spawning, even if the consumer exits.
      assert.equal(fs.existsSync(path.join(closeout, 'worker.log')), false, 'record mutations never started a closeout consumer');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, project, org, workspace, env, exec, ok, git, put, record, show, run, item, base, head, settings, configure,
    settled, save, guard, check, change, gate, checked, brain, manifest, herdr, worker: done => { workerDone = done; } };
}

function damage(f, kind) {
  if (kind === 'boundary-input') {
    const bytes = fs.readFileSync(f.gate);
    fs.appendFileSync(f.gate, '// changed external boundary\n');
    return () => fs.writeFileSync(f.gate, bytes);
  }
  if (kind === 'self-authority' || kind === 'out-of-scope') {
    const previous = { head: f.guard.expectedHead, finalHead: f.settled.finalHead, resultHead: f.settled.result.head };
    f.change(kind === 'self-authority' ? 'promote/guard.mjs' : 'docs/guide.md', '// candidate edit\n');
    const head = f.git(['rev-parse', 'HEAD'], f.workspace);
    f.guard.expectedHead = head; f.settled.finalHead = head; f.settled.result.head = head; f.save();
    if (kind === 'out-of-scope') return () => {
      // Restore only this private fixture's added scope change and its head binding.
      f.git(['reset', '--hard', previous.head], f.workspace);
      f.guard.expectedHead = previous.head; f.settled.finalHead = previous.finalHead; f.settled.result.head = previous.resultHead; f.save();
    };
  }
  if (kind === 'expired') {
    const at = new Date(Date.now() - INTERIM_MS).toISOString();
    const events = path.join(f.brain.org, 'events.jsonl');
    fs.writeFileSync(events, fs.readFileSync(events, 'utf8').trim().split('\n').map(line => {
      const event = JSON.parse(line); if (event.seq === f.settings.green.activationId) event.at = at; return JSON.stringify(event);
    }).join('\n') + '\n');
    f.settings.green.activatedAt = at; f.configure();
  }
  if (kind === 'stale-PASS') { f.settled.result.head = f.base; f.save(); }
}
const refusals = {
  'boundary-input': { code: 'GREEN_REACH_UNKNOWN', reason: f => `external configuration drift: ${f.gate}` },
  'self-authority': { code: 'GREEN_SELF_AUTHORITY', reason: 'eligibility/evidence authority: promote/guard.mjs' },
  foreign: { code: 'GREEN_IDENTITY_MISMATCH', reason: 'admission is outside the declared canonical project and record' },
  expired: { code: 'GREEN_EXPIRED', reason: 'activation is missing, in the future or outside the ten-day interim' },
  'stale-PASS': { code: 'AUTOPILOT_PASS_STALE', reason: 'current clean PASS or head changed' },
  'out-of-scope': { code: 'GREEN_REACH_UNKNOWN', reason: 'outside reviewed component contracts: docs/guide.md' },
};
const refusalMessage = (f, kind) => {
  const { code, reason } = refusals[kind];
  return `${code}: ${typeof reason === 'function' ? reason(f) : reason}; nothing merged`;
};

test('ordinary and clean-pass guards work without green modules, and disabled requests do no Git work', async t => {
  const f = await fixture(t, { cohort: 'clean-pass' });
  // Unchanged bytes with stale stat data force status to refresh its cache if
  // optional index writes are allowed; this must not depend on Git timing.
  fs.utimesSync(path.join(f.workspace, 'docs/guide.md'), 0, 0);
  const index = f.git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], f.workspace);
  // A fresh process cannot hide eager initialization behind an import cache.
  for (const file of ['supervisor/green-pass.mjs', 'supervisor/green-contracts.json']) fs.rmSync(path.join(f.repo, file));
  const probe = path.join(f.root, 'unused-green.mjs');
  fs.writeFileSync(probe, `import fs from 'node:fs';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { withPromotionGuard } from ${JSON.stringify(pathToFileURL(path.join(f.repo, 'promote/guard.mjs')).href)};
const guard = ${JSON.stringify(f.guard)}, config = ${JSON.stringify(path.join(f.repo, '.supervisor.json'))};
let admitted = 0;
withPromotionGuard({ ...guard, run: undefined, expectedHead: undefined, existingWorker: false }, () => admitted++);
const original = cp.execFileSync; let git = 0;
cp.execFileSync = function(command, ...args) { if(command === 'git') { git++; throw Error('disabled request inspected Git'); } return original.call(this, command, ...args); };
syncBuiltinESMExports();
for (const policy of [undefined, {}, {enabled:false,cohort:'green-pass'}, {enabled:true,cohort:'unknown'}]) {
  if (policy === undefined) fs.rmSync(config, {force:true}); else fs.writeFileSync(config, JSON.stringify({autopilot:policy}));
  assert.throws(() => withPromotionGuard(guard), {message:'AUTOPILOT_DISABLED: pilot disabled before integration; nothing merged'});
}
assert.equal(git, 0); assert.equal(admitted, 1);
cp.execFileSync = original; syncBuiltinESMExports();
fs.writeFileSync(config, JSON.stringify({autopilot:{enabled:true,cohort:'clean-pass'}}));
const indexVersion = ${indexVersion.toString()};
const index = ${JSON.stringify(index)}, before = indexVersion(index);
withPromotionGuard(guard, () => admitted++);
assert.deepEqual(indexVersion(index), before, 'clean-pass scope must not refresh the index');
assert.equal(admitted, 2);
console.log('ordinary and clean-pass admitted; disabled Git calls=0; green modules absent');
`);
  assert.equal(f.ok(f.exec(process.execPath, [probe])), 'ordinary and clean-pass admitted; disabled Git calls=0; green modules absent');
});

test('private green fixture never reads or copies the live lifecycle policies', async t => {
  const livePolicies = new Set(['.lane.json', '.housekeeping.json'].map(file => path.join(source, file)));
  const originals = new Map(['readFileSync', 'copyFileSync'].map(name => [name, fs[name]]));
  for (const [name, original] of originals) fs[name] = (file, ...args) => {
    assert.equal(livePolicies.has(file), false, `fixture ${name} must not consume a live lifecycle policy`);
    return original(file, ...args);
  };
  try {
    const f = await fixture(t);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.repo, '.lane.json'), 'utf8')), { retirement: { closeout_queue: false } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.repo, '.housekeeping.json'), 'utf8')), { enabled: true });
    f.check();
  } finally {
    for (const [name, original] of originals) fs[name] = original;
  }
});

test('green guard admits the exact reviewed head under the record lock', async t => {
  const f = await fixture(t); let called = false;
  f.check(() => { called = true; assert.ok(fs.existsSync(path.join(f.org, 'lock'))); }); assert.equal(called, true);
});
test('native green guard refuses an unreviewed Node launcher argument', async t => {
  const f = await fixture(t); f.check();
  // Put the flag on the process that executes the guard. A queue worker's
  // flags are not inherited by the separate lane promotion process.
  const probe = path.join(f.root, 'launcher-drift.mjs');
  fs.writeFileSync(probe, `import assert from 'node:assert/strict';
import { withPromotionGuard } from ${JSON.stringify(pathToFileURL(path.join(f.repo, 'promote/guard.mjs')).href)};
assert.throws(() => withPromotionGuard(${JSON.stringify(f.guard)}, () => assert.fail('drifted launcher integrated')), {
  message: 'GREEN_REACH_UNKNOWN: Node launcher drift; nothing merged'
});
`);
  f.ok(f.exec(process.execPath, ['--no-warnings', probe]));
  assert.equal(f.git(['rev-parse', 'main'], f.project), f.base);
  assert.equal(fs.existsSync(path.join(f.org, 'lock')), false);
  assert.equal(fs.existsSync(f.checked), false);
  assert.equal(f.show(f.item).closed, null);
});
for (const kind of Object.keys(refusals)) test(`green guard refuses ${kind} without integration`, async t => {
  const f = await fixture(t, { foreign: kind === 'foreign' });
  if (kind !== 'foreign') f.check();
  const restore = damage(f, kind);
  assert.throws(() => f.check(() => assert.fail('refused operation executed')), { message: refusalMessage(f, kind) });
  assert.equal(f.git(['rev-parse', 'main'], f.project), f.base);
  assert.equal(fs.existsSync(path.join(f.org, 'lock')), false);
  if (restore) { restore(); f.check(); }
});
const stalePass = 'AUTOPILOT_PASS_STALE: current clean PASS or head changed; nothing merged';
const retainedRefusals = {
  disabled: 'AUTOPILOT_DISABLED: pilot disabled before integration; nothing merged',
  unknown: 'AUTOPILOT_DISABLED: pilot disabled before integration; nothing merged',
  paused: 'AUTOPILOT_PAUSED: housekeeping paused before integration; nothing merged',
  STOP: 'supervisor STOP exists; nothing merged',
  identity: stalePass, 'review-hash': stalePass, 'reviewed-commit': stalePass, findings: stalePass,
};
for (const [kind, message] of Object.entries(retainedRefusals))
test(`existing-worker guard retains ${kind} refusal`, async t => {
  const f = await fixture(t); f.check();
  if (kind === 'disabled') { f.settings.enabled = false; f.configure(); }
  if (kind === 'unknown') { f.settings.cohort = 'unknown'; f.configure(); }
  if (kind === 'paused') f.put('.housekeeping.json', '{"enabled":false}', f.project);
  if (kind === 'STOP') f.put('.lane/supervisor/STOP', 'stop', f.project);
  if (kind === 'identity') f.settled.common = f.root;
  if (kind === 'review-hash') f.settled.review.sha256 = '0'.repeat(64);
  if (kind === 'reviewed-commit') f.settled.result.reviewed_commit = f.base;
  if (kind === 'findings') { f.settled.review.text = f.settled.review.text.replace('None', '- [Minor] Finding'); f.settled.review.sha256 = hash(f.settled.review.text); }
  f.save();
  assert.throws(() => f.check(), { message });
});
test('clean-pass keeps its ordinary documentation scope and named refusals', async t => {
  const f = await fixture(t, { cohort: 'clean-pass' });
  f.change('docs/guide.md', 'A clean-pass documentation edit.\n');
  f.guard.expectedHead = f.git(['rev-parse', 'HEAD'], f.workspace); f.settled.finalHead = f.guard.expectedHead; f.settled.result.head = f.guard.expectedHead; f.save();
  // Use a documentation-only baseline so the existing one-area rule applies.
  f.settled.mainHead = f.head; f.save();
  const guide = path.join(f.workspace, 'docs/guide.md');
  fs.utimesSync(guide, 0, 0);
  const index = f.git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], f.workspace);
  const before = indexVersion(index);
  f.check();
  assert.deepEqual(indexVersion(index), before, 'scope inspection leaves stale index metadata untouched');
  const { preparePromotionGuard } = await import(pathToFileURL(path.join(f.repo, 'promote/guard.mjs')));
  const prepared = preparePromotionGuard(f.guard);
  fs.copyFileSync(index, `${index}.replacement`); fs.renameSync(`${index}.replacement`, index);
  assert.throws(() => prepared.run(() => assert.fail('changed index integrated')), { code: 'RECORD_OBSERVATION_CONFLICT' });
  assert.equal(fs.existsSync(path.join(f.org, 'lock')), false);
  fs.appendFileSync(guide, 'Uncommitted change.\n');
  assert.throws(() => f.check(), /AUTOPILOT_SCOPE_UNKNOWN: candidate worktree is dirty/);
  fs.writeFileSync(guide, 'A clean-pass documentation edit.\n');
  f.change('promote/guard.mjs', '// protected edit\n');
  f.guard.expectedHead = f.git(['rev-parse', 'HEAD'], f.workspace); f.settled.finalHead = f.guard.expectedHead; f.settled.result.head = f.guard.expectedHead; f.save();
  assert.throws(() => f.check(), /AUTOPILOT_SCOPE_EXCLUDED/);
});

for (const kind of ['admitted', ...Object.keys(refusals)]) test(`native --existing-worker green candidate is ${kind}`, async t => {
  const f = await fixture(t, { foreign: kind === 'foreign' });
  const cli = path.join(f.repo, 'promote/promote.mjs');
  const { enqueue, queueFor } = await import(pathToFileURL(cli));
  const { liveNativeWorker } = await import(pathToFileURL(path.join(f.repo, 'promote/native-context.mjs')));
  const queue = queueFor(f.project), anchor = path.join(f.root, 'anchor');
  f.git(['worktree', 'add', '-qb', 'lane/anchor', anchor], f.project);
  f.put('anchor.txt', 'anchor', anchor); f.git(['add', '.'], anchor); f.git(['commit', '-qm', 'Anchor'], anchor);
  const started = path.join(f.root, 'anchor-started'), release = path.join(f.root, 'release-anchor');
  const anchorGate = path.join(f.root, 'anchor.cjs');
  fs.writeFileSync(anchorGate, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'started');const end=Date.now()+${loadTimeout(30000)};while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);process.exitCode=1;`);
  enqueue(queue, ['anchor'], { to: 'offline', herdr: f.herdr, attempts: 1, retry: 0, org: null,
    laneCLI: path.join(f.repo, 'lanes/lane.mjs'), validate: `${process.execPath} ${anchorGate}` });
  const child = spawnScenarioChild(t, process.execPath, [cli, '--drain', '--repo', f.project], { cwd: f.project, env: f.env });
  const done = waitForExit(child); f.worker(done);
  const deadline = Date.now() + loadTimeout(10000);
  while (!fs.existsSync(started) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(started), JSON.stringify({ queue: queue.load(), worker: child.exitCode === null ? 'running' : await done }));
  if (!liveNativeWorker(f.guard.identity)) assert.fail(JSON.stringify({
    reason: 'actual native worker is not confirmed',
    owner: JSON.parse(fs.readFileSync(path.join(queue.directory, 'worker.lock/owner.json'), 'utf8')),
    process: lookupProcess(child.pid),
  }));
  if (kind !== 'foreign') f.check(); // A valid admission precedes late drift.
  const restore = damage(f, kind);
  const result = f.exec(process.execPath, [cli, 'candidate', '--existing-worker', '--repo', f.project, '--org', f.org,
    '--if-current-run', f.run, '--claimed-by', 'brain', '--claim-generation', String(f.show(f.run).owner_generation), '--expected-head', f.guard.expectedHead, '--delivery-attempts', '1', '--retry-seconds', '0', '--herdr', f.herdr]);
  const reply = JSON.parse(f.ok(result)); assert.deepEqual(reply.worker, { already_running: true });
  assert.equal(queue.load().pending.find(job => job.run === f.run).existingWorker, true);
  fs.writeFileSync(release, 'release');
  const exit = await done; assert.equal(exit.code, 0, exit.stderr);
  const row = queue.load().results.find(job => job.run === f.run);
  const evidence = JSON.stringify({ row, log: row?.log && fs.existsSync(row.log) ? fs.readFileSync(row.log, 'utf8') : null });
  assert.ok(row, evidence);
  if (kind === 'admitted') {
    assert.equal(row.outcome, 'promoted', evidence);
    assert.equal(f.git(['rev-parse', 'main'], f.project), f.head);
    assert.equal(f.show(f.item).closed.as, 'done'); assert.ok(fs.existsSync(f.checked));
    assert.equal(f.git(['rev-list', '--merges', 'main'], f.project), '');
  } else {
    assert.equal(row.outcome, 'refused', evidence); assert.equal(row.reason, refusalMessage(f, kind), evidence);
    assert.equal(f.git(['rev-parse', 'main'], f.project), f.base);
    assert.ok(fs.existsSync(f.workspace)); assert.equal(f.show(f.item).closed, null);
    assert.equal(fs.existsSync(f.checked), false, 'refused before candidate validation');
    if (restore) { restore(); f.check(); }
  }
});
