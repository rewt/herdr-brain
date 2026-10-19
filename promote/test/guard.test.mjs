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
import { spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { waitForInboxIdle } from '../../test/helpers/inbox.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { lookupProcess } from '../../lib/processes.mjs';

// Containment is installed already; green checks require absent loader inputs.
delete process.env.NODE_OPTIONS;
const source = fileURLToPath(new URL('../../', import.meta.url));
const loader = fileURLToPath(new URL('./helpers/green-loader.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { foreign = false, cohort = 'green-pass' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-green-guard-')));
  fixtureFleet(t, root);
  const repo = path.join(root, 'brain'); fs.mkdirSync(repo);
  const env = { ...process.env, NODE_OPTIONS: `--import=${JSON.stringify(loader)}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SUPERVISOR_INPUT_WAIT_SECONDS: '0' };
  for (const key of Object.keys(env)) if (/^(ORG_|LANE_|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(key)) delete env[key];
  const exec = (command, args, cwd = repo) => spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const ok = r => { assert.equal(r.status, 0, r.stderr || r.stdout || r.error?.message); return r.stdout.trim(); };
  const git = (args, cwd = repo) => ok(exec('git', args, cwd));
  const put = (file, bytes, cwd = repo) => { const target = path.join(cwd, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); };
  // Run the actual promotion/guard modules from a private canonical Brain.
  // No candidate module, checker or native-process implementation is stubbed.
  const files = git(['ls-files', '-z'], source).split('\0').filter(file => file &&
    (boundaryInput(file) || BOOTSTRAP_FILES.includes(file)));
  for (const file of files) {
    const target = path.join(repo, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, file), target); fs.chmodSync(target, fs.statSync(path.join(source, file)).mode & 0o777);
  }
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
  }
  const configure = () => put('.supervisor.json', JSON.stringify({ autopilot: settings }), project); configure();
  const org = path.join(project, '.org'), workspace = path.join(root, 'candidate');
  git(['worktree', 'add', '-qb', 'lane/candidate', workspace], project);
  const base = git(['rev-parse', 'HEAD'], project);
  const change = (file, bytes) => { put(file, bytes, workspace); git(['add', '.'], workspace); git(['commit', '-qm', 'Candidate'], workspace); };
  change('board/render.mjs', renderer.replace('width = 120,', 'width = 121,'));
  const item = record(['add', 'Reviewed candidate', '--role', 'engineer'], project).split(' ')[0];
  const run = record(['start', item, '--workspace', workspace], project).match(/^R-\d+/)[0];
  const show = id => JSON.parse(record(['show', id, '--json'], project));
  const reportPath = show(run).report_path;
  fs.writeFileSync(reportPath, `---\nrun: ${run}\noutcome: done\nsummary: Private fixture completed\nheadline: Private fixture completed\n---\n`);
  record(['ingest', reportPath], project);
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
const a=process.argv.slice(2);if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake'}}}));
else if(a[0]==='pane'&&a[1]==='read')console.log('────────────────────\\n❯ \\n────────────────────');
else console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));`, { mode: 0o755 });
  let workerDone;
  t.after(async () => {
    fs.writeFileSync(path.join(root, 'release-anchor'), 'release');
    if (workerDone) await workerDone;
    await waitForInboxIdle(path.join(org, 'supervisor/inbox.log'));
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

test('green guard admits the exact reviewed head under the record lock', async t => {
  const f = await fixture(t); let called = false;
  f.check(() => { called = true; assert.ok(fs.existsSync(path.join(f.org, 'lock'))); }); assert.equal(called, true);
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
  f.settled.mainHead = f.head; f.save(); f.check();
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
    '--if-current-run', f.run, '--expected-head', f.guard.expectedHead, '--delivery-attempts', '1', '--retry-seconds', '0', '--herdr', f.herdr]);
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
