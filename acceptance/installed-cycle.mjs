// Runs as a separate, scratch-only process. Imports only the installed payload.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const config = JSON.parse(fs.readFileSync(process.argv[2]));
const { root, bundle, repo, org, home, commit, mode, forbidden } = config;
const evidence = path.join(root, 'evidence');
const write = (name, value) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + '\n');
const stages = [];
const stage = (name, detail) => { stages.push({ name, ...detail }); write('stages.json', stages); };
const module = relative => import(pathToFileURL(path.join(bundle, relative)).href);
// Positive kernel probes: neither in-process nor child fallback can read the
// development checkout or real user configuration. These precede product calls.
for (const file of forbidden) {
  assert.throws(() => fs.readFileSync(file), error => ['EPERM', 'EACCES'].includes(error.code), file);
  const child = spawnSync(process.execPath, ['-e', 'require("fs").readFileSync(process.argv[1])', file], { encoding: 'utf8' });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /EPERM|EACCES/);
}
const childEnvironment = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({fleet:process.env.HERDR_MONITOR_FLEET,preload:process.env.NODE_OPTIONS}))'], { encoding: 'utf8' });
assert.equal(childEnvironment.status, 0, childEnvironment.stderr);
const childHomes = JSON.parse(childEnvironment.stdout);
assert.equal(childHomes.fleet, process.env.HERDR_MONITOR_FLEET);
assert.match(childHomes.preload, /installed-observations\.mjs/);
assert.equal(fs.existsSync(config.development), false);
const { fleetPath } = await module('lib/fleet.mjs');
assert.ok(fleetPath().startsWith(root + path.sep));
stage('isolation', { forbidden, development: config.development, fleet: fleetPath(), childFleet: process.env.HERDR_MONITOR_FLEET, node: process.version });
const env = { ...process.env, ORG_DIR: org, ORG_ACTOR: 'line-service' };
const run = (exe, args, options = {}) => {
  const result = spawnSync(exe, args, { cwd: repo, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  fs.appendFileSync(path.join(evidence, 'commands.jsonl'), JSON.stringify({ exe, args, cwd: options.cwd ?? repo, status: result.status,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message }) + '\n');
  return result;
};
const checked = (exe, args, options) => { const r = run(exe, args, options); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout.trim(); };
const git = (args, cwd = repo) => checked('git', ['-C', cwd, ...args]);
const record = args => checked(process.execPath, [path.join(bundle, 'bin/org.mjs'), ...args]);
const { initOrg, loadRecord, transact } = await module('lib/store.mjs');
const { createLineService, serviceDirectory } = await module('line-service/line-service.mjs');
const { gitProject } = await module('lib/project.mjs');
const { ownerAlive } = await module('lib/process-owner.mjs');
const project = gitProject(repo);
initOrg(org);
const base = git(['rev-parse', 'HEAD']);
const directory = serviceDirectory(org, project.identity);
fs.mkdirSync(directory, { recursive: true });
// An offline service binding, not a launchd installation or release attestation.
fs.writeFileSync(path.join(directory, 'installation.json'), JSON.stringify({ at: '2026-10-30T00:00:00Z', repo, org, source: bundle, node: process.execPath,
  file: path.join(directory, 'service.plist'), target: `gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}` }));
const boundary = { id: 'installed-scenario', project: project.identity, repo, org, source: bundle, main: 'main', canonical_head: base };
transact(org, () => ({ add: ['line-service.cutover', 'line-service.phase0'].map(type => ({ type, ...boundary })) }));
const state = () => loadRecord(org).state;
const item = record(['add', 'Complete the installed scratch cycle', '--role', 'engineer']).match(/ENG-\d+/)[0];
const journals = () => fs.readdirSync(path.join(org, 'dispatch')).filter(n => n.endsWith('.json') && !n.endsWith('.routes.json'))
  .map(n => ({ file: path.join(org, 'dispatch', n), ...JSON.parse(fs.readFileSync(path.join(org, 'dispatch', n))) }));
// Join dispatch in the original call so each stage is observed before moving
// on. All other product commands execute unchanged; native/model IO is scripted.
const command = (exe, args, options) => run(exe, args[0]?.endsWith('/dispatch/dispatch.mjs')
  ? [...args.filter(a => a !== '--detach'), '--watch-cli', path.join(root, 'bin/watch')] : args, options);
const service = maxStarts => createLineService({ repo, org, to: 'scratch-supervisor', runtimeHome: home,
  env: { ...env, HERDR_BRAIN_ROOT: config.development }, maxStarts, haltAfter: 100, command });
service(1).pass();
const audit = () => fs.readFileSync(path.join(directory, 'passes.jsonl'), 'utf8');
if (mode === 'broken') {
  assert.match(audit(), /HERDR_BRAIN_ROOT|source root|source override|EPERM|EACCES/);
  assert.equal(state().items.get(item).runs.length, 0);
  stage('historical-dispatch', { commit, expected: 'source override refused before run creation', runs: 0, audit: audit() });
  process.exit(0);
}
const producer = journals().find(j => j.item === item);
assert.ok(producer, audit()); assert.equal(producer.stage, 'complete', JSON.stringify(producer));
assert.equal(producer.release.root, bundle); assert.equal(producer.release.commit, commit);
assert.equal(producer.sourceSelection, null);
stage('dispatch', { item, run: producer.run, attempt: producer.token, bundle, workspace: producer.worker.cwd, journal: producer.file });
const until = async (predicate, label) => {
  const deadline = Date.now() + 120_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, label + '\n' + audit()); await new Promise(resolve => setTimeout(resolve, 100)); }
};
const idle = job => {
  const file = path.join(root, 'native.json'), native = JSON.parse(fs.readFileSync(file));
  native.workspaces[job.worker.workspaceId].agent.agent_status = 'idle'; fs.writeFileSync(file, JSON.stringify(native));
};
const report = (job, artifacts, extra = '') => {
  const r = state().runs.get(job.run), file = r.report_path;
  fs.writeFileSync(file, `---\nrun: ${job.run}\noutcome: done\nsummary: Scripted installed work completed.\nheadline: The scratch work completed\nblockers: []\nproposals: []\nlearnings: []\nartifacts: ${JSON.stringify(artifacts)}\n${extra}---\n`);
  record(['check', file]); idle(job); return file;
};
if (mode === 'fixed') {
  // The historical witness stops at real installed dispatch; it must not be
  // described as current lifecycle coverage.
  record(['abandon', producer.run, '--note', 'Historical dispatch witness complete']);
  await until(() => !ownerAlive(producer.watcher), 'historical watcher');
  stage('historical-dispatch', { commit, expected: 'installed dispatch created', runs: 1 });
  process.exit(0);
}
const lane = producer.worker.cwd;
fs.writeFileSync(path.join(lane, 'answer.txt'), 'Installed consumer change\n');
git(['add', 'answer.txt'], lane); git(['commit', '-qm', 'Scripted installed change'], lane);
const head = git(['rev-parse', 'HEAD'], lane);
const workerEnv = { ...env, HERDR_ENV: '1', HERDR_PANE_ID: producer.worker.pane, HERDR_WORKSPACE_ID: producer.worker.workspaceId,
  HERDR_TAB_ID: producer.worker.tabId, CODEX_THREAD_ID: producer.worker.agentSessionId, ORG_ACTOR: producer.worker.agentName };
checked(process.execPath, [path.join(bundle, 'lanes/lane.mjs'), 'promote', producer.lane, '--expected-head-from-worktree'], { cwd: lane, env: workerEnv });
assert.equal(git(['rev-parse', 'main']), head);
stage('land', { base, head });
report(producer, [`source: ${head}; base: ${base}`]);
// Real watcher publishes availability; the finite line ingests and retires.
await until(() => state().runs.get(producer.run).report || loadRecord(org).events.some(e => e.type === 'report.available' && e.run === producer.run), 'producer availability');
service(0).pass();
await until(() => !fs.existsSync(lane), 'producer folder removal');
stage('producer-cleanup', { folderRemoved: !fs.existsSync(lane), ingested: Boolean(state().runs.get(producer.run).report),
  native: JSON.parse(fs.readFileSync(path.join(root, 'native.json'))) });
// Start the one record-queued review only after its producer folder is gone.
service(1).pass();
const reviews = [...state().items.values()].filter(i => i.meta.review_source_run === producer.run);
assert.equal(reviews.length, 1);
const review = reviews[0], target = review.meta.review_target;
assert.equal(target.head, head); assert.equal(target.base, base); assert.equal(review.meta.review_round_cap, 1);
const reviewer = journals().find(j => j.item === review.id);
assert.ok(reviewer, audit()); assert.equal(reviewer.stage, 'complete', JSON.stringify(reviewer));
assert.equal(review.runs.length, 1);
assert.match(git(['show', `${head}:answer.txt`]), /Installed consumer change/);
assert.equal(fs.existsSync(lane), false);
stage('original-review', { item: review.id, run: reviewer.run, head, base, target, producerFolderAbsent: true });
report(reviewer, [], 'verdict: PASS\n');
await until(() => state().runs.get(reviewer.run).report || loadRecord(org).events.some(e => e.type === 'report.available' && e.run === reviewer.run), 'review availability');
service(0).pass();
await until(() => !fs.existsSync(reviewer.worker.cwd), 'review folder removal');
assert.equal(state().items.get(review.id).closed.as, 'done');
assert.equal(loadRecord(org).events.filter(e => e.type === 'change.reviewed').length, 1);
assert.equal(state().items.get(item).closed.as, 'done');
stage('review-cleanup', { folderRemoved: true, verdicts: 1, sourceClosed: true, reviewClosed: true });
// The next action really reaches scripted input and loses its reply. Observe
// another pass without replacing its request, attempting input again or clearing it.
const uncertain = record(['add', 'Retain an uncertain scratch action', '--role', 'engineer']).match(/ENG-\d+/)[0];
fs.writeFileSync(path.join(root, 'lose-prompt-reply'), 'lose the original reply');
service(1).pass();
const unknown = journals().find(j => j.item === uncertain); assert.ok(unknown, audit());
const bytes = fs.readFileSync(unknown.file), calls = fs.readFileSync(path.join(root, 'native-calls.jsonl'), 'utf8');
service(1).pass();
assert.deepEqual(fs.readFileSync(unknown.file), bytes);
assert.equal(journals().filter(j => j.item === uncertain).length, 1);
const prompts = text => text.split('\n').filter(Boolean).map(JSON.parse).filter(a => a[0] === 'agent' && a[1] === 'prompt' && a[2] === unknown.worker.agentName);
assert.equal(prompts(calls).length, 1);
assert.equal(prompts(fs.readFileSync(path.join(root, 'native-calls.jsonl'), 'utf8')).length, 1);
assert.ok(fs.existsSync(unknown.worker.cwd));
stage('uncertain-retained', { item: uncertain, run: unknown.run, journal: unknown.file, stage: unknown.stage, attempts: 1, prompts: 1, folderKept: true, error: unknown.error });
write('outcome.json', { ready: false, scriptedMechanics: true, dispatch: 1, reports: 2, originalReviews: 1, verdicts: 1,
  producerFoldersRemoved: 1, reviewFoldersRemoved: 1, uncertainAttemptsRetained: 1, base, head, roots: config });

// The uncertain request stays untouched; terminate only its receipt-owned test
// watcher after the retention observation, before archiving/removing scratch.
if (unknown.watcher && ownerAlive(unknown.watcher)) process.kill(unknown.watcher.pid, 'SIGTERM');
await until(() => !unknown.watcher || !ownerAlive(unknown.watcher), 'uncertain watcher shutdown');
await until(() => !fs.existsSync(path.join(directory, 'closeout-turn.lock')), 'finite closeout shutdown');
assert.deepEqual(fs.readFileSync(unknown.file), bytes);
stage('fixture-teardown', { uncertainJournalUnchanged: true, watcherStopped: true });
