import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseOnce, quietPoint } from '../release.mjs';
import { releaseSettings, RELEASE_DEFAULTS } from '../config.mjs';
import { gitProject, ignoreRuntime } from '../../lib/project.mjs';
import { acquireLock } from '../../lanes/promotion-lock.mjs';
import { coldStart, renderColdStart } from '../../supervisor/context.mjs';
import { entryPolicy } from '../../discovery/policy.mjs';
import { fold as oldFold } from '../../test/fixtures/state-v0.mjs';
import { createModernSession } from '../../console/modern/session.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
process.env.ORG_ACTOR = 'release-tests';
function fixture(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-release-test-'));
  const repo = path.join(root, 'project'); fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ORG_DIR: '', ORG_ACTOR: 'release-fixture', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANE_VALIDATE: undefined, LANE_CONFIG: undefined };
  const exec = (cmd, args, cwd = repo, extra = {}) => spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 12000 });
  const ok = (cmd, args, cwd = repo, extra) => { const r = exec(cmd, args, cwd, extra); assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`); return r.stdout.trim(); };
  const git = (args, cwd = repo) => ok('git', args, cwd);
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Release test']); git(['config', 'user.email', 'release@example.invalid']);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node gate.cjs' } }));
  fs.writeFileSync(path.join(repo, 'gate.cjs'), `const fs=require('fs');fs.appendFileSync(process.env.RELEASE_TEST_COUNT,'gate\\n');console.log('candidate '+fs.readFileSync('.release-commit','utf8').trim());process.exit(Number(process.env.RELEASE_TEST_EXIT||0));\n`);
  const count = path.join(root, 'gates.txt'); env.RELEASE_TEST_COUNT = count;
  if (config) fs.writeFileSync(path.join(repo, '.release.json'), JSON.stringify(config));
  git(['add', '.']); git(['commit', '-qm', 'Initialize release project']);
  const project = gitProject(repo); ignoreRuntime(project);
  const org = (args, extra) => ok(process.execPath, [path.join(ROOT, 'bin/org.mjs'), ...args], repo, extra);
  const record = (args, extra) => JSON.parse(org(args, extra));
  const attempt = opts => releaseOnce({ cwd: repo, role: 'supervisor', env, measurement: { load: 0, cpus: 1 }, ...opts });
  const commit = (name = 'promotion') => { fs.writeFileSync(path.join(repo, name), name); git(['add', name]); git(['commit', '-qm', name]); return git(['rev-parse', 'HEAD']); };
  return { root, repo, env, exec, ok, git, project, org, record, attempt, commit, count };
}

test('unconfigured release uses npm test, initializes its record and never executes ship', t => {
  const f = fixture(t);
  assert.deepEqual(releaseSettings(f.repo).config, RELEASE_DEFAULTS);
  const result = f.attempt({ tag: 'rc-default' });
  assert.equal(result.result, 'awaiting-operator');
  const c = f.record(['releases', '--json']).candidates[0];
  assert.equal(c.commit, f.git(['rev-parse', 'HEAD'])); assert.equal(f.git(['rev-parse', c.tag]), c.commit);
  assert.equal(fs.readFileSync(path.join(c.snapshot, '.release-commit'), 'utf8').trim(), c.commit);
  assert.equal(c.gate.result, 'passed'); assert.match(fs.readFileSync(c.gate.log, 'utf8'), new RegExp(c.commit));
  assert.equal(c.status, 'awaiting-operator'); assert.equal(c.ship, null);
  assert.equal(f.attempt().candidate.id, c.id); assert.equal(fs.readFileSync(f.count, 'utf8'), 'gate\n');
  assert.match(f.org(['status']), /RELEASE CANDIDATES/);
});

test('two real lane promotions become one tagged batch and one operator question', t => {
  const f = fixture(t, { gate: ['node', 'gate.cjs'], ship: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(path.join(os.tmpdir(), 'never-release-ship'))},'unsafe')`] });
  const tips = [];
  for (const topic of ['first-batch', 'second-batch']) {
    const lane = path.join(f.root, topic);
    f.git(['worktree', 'add', '-qb', `lane/${topic}`, lane, 'main']);
    fs.writeFileSync(path.join(lane, `${topic}.txt`), topic);
    f.git(['add', '.'], lane); f.git(['commit', '-qm', `Promote ${topic}`], lane);
    tips.push(f.git(['rev-parse', 'HEAD'], lane));
    f.ok(process.execPath, [path.join(ROOT, 'lanes/lane.mjs'), 'promote', topic], f.repo, { LANE_VALIDATE: 'true' });
  }
  const result = f.attempt({ tag: 'rc-batch' });
  assert.equal(result.result, 'awaiting-operator');
  const c = result.candidate;
  assert.ok(tips.every(tip => c.commits.includes(tip))); assert.equal(c.commit, tips[1]);
  assert.ok(fs.existsSync(path.join(c.snapshot, 'first-batch.txt'))); assert.ok(fs.existsSync(path.join(c.snapshot, 'second-batch.txt')));
  const status = f.record(['status', '--json']);
  assert.equal(status.items.filter(i => i.meta.release === c.id).length, 1);
  assert.equal(f.exec(process.execPath, [path.join(ROOT, 'bin/org.mjs'), 'answer', c.question, 'yes']).status, 1);
  f.org(['answer', c.question, 'yes'], { ORG_ACTOR: 'human' });
  assert.equal(f.attempt().result, 'approved'); assert.equal(fs.readFileSync(f.count, 'utf8'), 'gate\n');
});

test('publish auto policy cannot approve a release and agents cannot forge, close or overrule its decision', t => {
  const f = fixture(t, { gate: ['node', 'gate.cjs'] });
  f.org(['init', path.join(f.repo, '.org')]);
  const configFile = path.join(f.repo, '.org/config.json'), config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.approvals.categories.publish = 'auto'; fs.writeFileSync(configFile, JSON.stringify(config));
  const c = f.attempt().candidate;
  assert.equal(f.record(['show', c.question, '--json']).closed, null);
  for (const args of [['answer', c.question, 'yes'], ['close', c.question], ['set', c.question, 'meta.operator_reserved=false'], ['set', c.question, 'meta.answer=yes', 'meta.answered_by=human']]) {
    const r = f.exec(process.execPath, [path.join(ROOT, 'bin/org.mjs'), ...args]); assert.equal(r.status, 1, r.stderr);
  }
  f.org(['answer', c.question, 'no', '--note=Keep it for inspection'], { ORG_ACTOR: 'human' });
  assert.equal(f.attempt().result, 'declined');
  assert.equal(f.exec(process.execPath, [path.join(ROOT, 'bin/org.mjs'), 'answer', c.question, 'yes', '--overrule']).status, 1);
  f.org(['answer', c.question, 'yes', '--overrule'], { ORG_ACTOR: 'human' });
  assert.equal(f.attempt().result, 'approved');
});

for (const answer of ['yes', 'no']) test(`agents cannot start a run on an operator-reserved question answered ${answer}`, t => {
  const f = fixture(t, { gate: ['node', 'gate.cjs'] });
  const c = f.attempt().candidate;
  assert.equal(c.gate.result, 'passed', fs.readFileSync(c.gate.log, 'utf8'));
  const eventFile = path.join(f.repo, '.org/events.jsonl');
  const refuseStart = () => {
    const before = fs.readFileSync(eventFile);
    const runs = fs.readdirSync(path.join(f.repo, '.org/runs'));
    for (const flags of [[], ['--harness', 'opaque'], ['--if-current-run', 'R-1']]) {
      const r = f.exec(process.execPath, [path.join(ROOT, 'bin/org.mjs'), 'start', c.question, ...flags]);
      assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /reserved for the operator/);
      assert.deepEqual(fs.readFileSync(eventFile), before, 'refusal appends no event');
      assert.deepEqual(fs.readdirSync(path.join(f.repo, '.org/runs')), runs, 'refusal creates no run directory');
    }
  };
  refuseStart();
  f.org(['answer', c.question, answer], { ORG_ACTOR: 'human' });
  refuseStart();
  assert.equal(f.attempt().result, answer === 'yes' ? 'approved' : 'declined');
  f.commit('next-batch');
  const next = f.attempt();
  assert.equal(next.result, 'awaiting-operator', `the prior decision does not block the next batch: ${fs.readFileSync(next.candidate.gate.log, 'utf8')}`);
});

test('low load, drained promotion queue, clean base and supervisor ownership are required', t => {
  const f = fixture(t), config = releaseSettings(f.repo).config;
  assert.match(quietPoint(f.project, config, { load: 2, cpus: 1 }), /load/);
  assert.equal(f.attempt({ measurement: { load: 2, cpus: 1 } }).result, 'deferred');
  const unlock = acquireLock(path.join(f.project.identity, 'lane-promote.lock'));
  try { assert.equal(f.attempt().result, 'deferred'); } finally { unlock(); }
  const q = path.join(f.project.identity, 'promote/queue.json'); fs.mkdirSync(path.dirname(q));
  fs.writeFileSync(q, JSON.stringify({ identity: f.project.identity, current: {}, pending: [] }));
  assert.match(f.attempt().reason, /promotion queue/); fs.unlinkSync(q);
  fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.lane/supervisor/STOP'), '');
  assert.match(f.attempt().reason, /STOP/); fs.rmSync(path.join(f.repo, '.lane'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, 'dirty'), 'dirty'); assert.throws(() => f.attempt(), /clean/); fs.unlinkSync(path.join(f.repo, 'dirty'));
  assert.throws(() => f.attempt({ role: 'worker' }), /supervisor/);
  const lane = path.join(f.root, 'lane'); f.git(['worktree', 'add', '-qb', 'lane/worker', lane]);
  assert.throws(() => f.attempt({ cwd: lane }), /canonical/);
  assert.equal(fs.existsSync(f.count), false);
});

test('red gate is durable, never repeated, and a later promotion may become a new candidate', t => {
  const f = fixture(t, { gate: ['node', 'gate.cjs'] }); f.env.RELEASE_TEST_EXIT = '3';
  const first = f.attempt({ tag: 'rc-red' }); assert.equal(first.result, 'gate-failed');
  assert.equal(first.candidate.question, null); assert.equal(first.candidate.gate.exit_code, 3);
  assert.equal(f.attempt().candidate.id, first.candidate.id); assert.equal(fs.readFileSync(f.count, 'utf8'), 'gate\n');
  f.env.RELEASE_TEST_EXIT = '0'; const promoted = f.commit('fix');
  const second = f.attempt({ tag: 'rc-green' });
  assert.equal(second.result, 'awaiting-operator'); assert.equal(second.candidate.previous, first.candidate.commit);
  assert.deepEqual(second.candidate.commits, [promoted]); assert.equal(fs.readFileSync(f.count, 'utf8'), 'gate\ngate\n');
  f.commit('another'); assert.match(f.attempt().reason, /operator decision/);
});

test('interrupted start, duplicate record writes and older folds preserve once-only semantics', t => {
  const f = fixture(t, { gate: ['node', 'gate.cjs'] });
  const commit = f.git(['rev-parse', 'HEAD']);
  const c = { identity: f.project.identity, tag: 'rc-interrupted', base: 'main', commit, tree: f.git(['rev-parse', 'HEAD^{tree}']),
    snapshot: path.join(f.project.identity, 'release/candidates/rc-interrupted'), previous: null, commits: [commit], gate_command: ['node', 'gate.cjs'], prepare: null, ship: null, parent: null };
  const input = path.join(f.root, 'receipt.json'); fs.writeFileSync(input, JSON.stringify(c));
  assert.equal(f.record(['release', 'cut', '--file', input]).id, 'RC-1');
  assert.equal(f.record(['release', 'cut', '--file', input]).id, 'RC-1');
  assert.equal(f.record(['release', 'start', 'RC-1']).started, true);
  assert.equal(f.record(['release', 'start', 'RC-1']).started, false);
  assert.equal(f.attempt().result, 'inspect'); assert.equal(fs.existsSync(f.count), false);
  const events = fs.readFileSync(path.join(f.repo, '.org/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.type === 'release.cut').length, 1);
  assert.doesNotThrow(() => oldFold(events));
});

test('tracked declarations, preparation failure, fixed candidate tags and base overrides are explicit', t => {
  const f = fixture(t);
  assert.throws(() => f.attempt({ tag: '../bad' }), /invalid/);
  f.git(['tag', 'existing']);
  assert.throws(() => f.attempt({ tag: 'existing' }), /already exists/);
  fs.writeFileSync(path.join(f.repo, '.release.json'), JSON.stringify({ gate: ['false'] }));
  assert.equal(releaseSettings(f.repo).source, 'installed defaults'); fs.unlinkSync(path.join(f.repo, '.release.json'));
  fs.writeFileSync(path.join(f.repo, '.release.json'), JSON.stringify({ base: 'trunk', gate: ['node', 'gate.cjs'], prepare: ['node', '-e', 'process.exit(9)'] }));
  f.git(['add', '.']); f.git(['commit', '-qm', 'Declare trunk release']); f.git(['branch', '-m', 'trunk']);
  const result = f.attempt({ tag: 'rc-build-fail' });
  assert.equal(result.result, 'gate-failed'); assert.equal(result.candidate.gate.stage, 'prepare', result.candidate.gate.detail); assert.equal(fs.existsSync(f.count), false);
  assert.equal(f.attempt({ tag: '../bad' }).candidate.id, result.candidate.id, 'existing evidence is reused without creating another tag');
});

test('snapshot extraction gives tar an owned archive file instead of a padded stdin pipe', t => {
  const f = fixture(t, { gate: ['node', 'gate.cjs'] });
  const bin = path.join(f.root, 'tools'); fs.mkdirSync(bin);
  const receipt = path.join(f.root, 'archive-input.json');
  fs.writeFileSync(path.join(bin, 'tar'), `#!${process.execPath}
const fs=require('fs'),assert=require('assert'),cp=require('child_process');
const args=process.argv.slice(2),file=args[args.indexOf('-f')+1];
assert.ok(args.includes('-f'));assert.ok(fs.statSync(file).isFile());
fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({file,bytes:fs.statSync(file).size}));
const r=cp.spawnSync('/usr/bin/tar',args,{stdio:['ignore','inherit','inherit']});process.exit(r.status??1);
  `, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const previousPath = process.env.PATH;
  process.env.PATH = f.env.PATH;
  t.after(() => { process.env.PATH = previousPath; });
  const c = f.attempt().candidate;
  assert.equal(c.gate.result, 'passed', fs.readFileSync(c.gate.log, 'utf8'));
  const input = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(input.file, `${c.snapshot}.archive.tar`); assert.ok(input.bytes > 0);
  assert.equal(fs.existsSync(input.file), false, 'only the successfully extracted owned archive is removed');
  assert.equal(fs.readFileSync(f.count, 'utf8'), 'gate\n');
});

test('supervisor, discovery and console recover gate evidence and the operator decision from the record', async t => {
  const f = fixture(t, { gate: ['node', 'gate.cjs'], max_load_per_cpu: 100 });
  const c = f.attempt().candidate;
  const doc = coldStart({ cwd: f.repo, env: f.env });
  assert.equal(doc.candidates[0].question, c.question); assert.match(renderColdStart(doc), /Release candidates/);
  assert.ok(doc.next.some(n => n.action === 'await_release_operator'));
  const policy = entryPolicy({ ...f.project, workspace: f.repo, org: path.join(f.repo, '.org'), role: 'worker', entry: {}, branch: 'main' }, ROOT);
  assert.match(policy, /workers use.*never run the release gate/);
  const delegated = JSON.parse(f.ok(process.execPath, [path.join(ROOT, 'supervisor/supervisor.mjs'), 'release', '--repo', f.repo, '--role', 'supervisor']));
  assert.equal(delegated.candidate.id, c.id);
  const session = createModernSession({ config: { projects: [{ name: 'Release project', cwd: f.repo, org: path.join(f.repo, '.org') }] }, env: {}, deps: {
    identity: cwd => ({ key: f.project.identity, root: f.repo, cwd, name: 'Release project', git: true }),
    herdrList: async () => [], herdrAgents: async () => ({ ok: true, agents: [] }), brainQueue: async () => ({ rows: [], off: true }),
    orgToday: async () => f.record(['today', '--json']), orgStatus: async () => f.record(['status', '--json']), orgLog: async () => [],
    orgRoutes: async () => null, orgHousekeeping: async () => null, orgDesks: async () => null,
  } });
  t.after(() => session.stop()); await session.refresh(); await session.key('L');
  const text = session.frame(130, 42).lines.map(l => l.spans.map(s => s.text).join('')).join('\n');
  assert.match(text, /Release candidates/); assert.match(text, /Gate: passed/); assert.match(text, /Waiting on you/);
  await session.activate(`item:${c.question}`); assert.equal(session.ui.detail, c.question);
});

test('a running gate excludes a second release and a direct promotion with the shared lock', t => {
  const f = fixture(t, { gate: ['node', 'gate.cjs'], max_load_per_cpu: 100 });
  const lane = path.join(f.root, 'concurrent-lane'); f.git(['worktree', 'add', '-qb', 'lane/concurrent', lane]);
  const output = path.join(f.root, 'contention.json');
  fs.writeFileSync(path.join(f.repo, 'gate.cjs'), `const {spawnSync}=require('child_process');const fs=require('fs');
const release=spawnSync(process.execPath,[${JSON.stringify(path.join(ROOT, 'release/release.mjs'))},'--repo',${JSON.stringify(f.repo)},'--role','supervisor'],{encoding:'utf8'});
const promotion=spawnSync(process.execPath,[${JSON.stringify(path.join(ROOT, 'lanes/lane.mjs'))},'promote','concurrent'],{cwd:${JSON.stringify(f.repo)},encoding:'utf8'});
fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({release:JSON.parse(release.stdout),promotion:{status:promotion.status,stderr:promotion.stderr}}));\n`);
  f.git(['add', 'gate.cjs']); f.git(['commit', '-qm', 'Test contention inside gate']);
  assert.equal(f.attempt().result, 'awaiting-operator');
  const contention = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(contention.release.result, 'deferred'); assert.match(contention.release.reason, /project lock/);
  assert.equal(contention.promotion.status, 1); assert.match(contention.promotion.stderr, /locked/);
  assert.equal(f.record(['releases', '--json']).candidates.length, 1);
});

test('gate result receipts are immutable and duplicate completion creates no extra operator question', t => {
  const f = fixture(t, { gate: ['node', 'gate.cjs'] }); const c = f.attempt().candidate;
  assert.equal(c.gate.result, 'passed', c.gate.detail);
  const input = path.join(f.root, 'result.json'); fs.writeFileSync(input, JSON.stringify(c.gate));
  f.record(['release', 'result', c.id, '--file', input]);
  assert.equal(f.record(['status', '--json']).items.filter(i => i.meta.release === c.id).length, 1);
  fs.writeFileSync(input, JSON.stringify({ ...c.gate, result: 'failed', exit_code: 2 }));
  const r = f.exec(process.execPath, [path.join(ROOT, 'bin/org.mjs'), 'release', 'result', c.id, '--file', input]);
  assert.equal(r.status, 1); assert.match(r.stderr, /different result/);
});

test('preparation env is scoped and a signaled gate records interruption without a replay', t => {
  const f = fixture(t, {
    prepare: ['node', '-e', "require('fs').writeFileSync('built',process.env.ENG109_PREP_ONLY)"],
    prepare_env: { ENG109_PREP_ONLY: 'prepared' },
    gate: ['node', '-e', "require('assert').equal(require('fs').readFileSync('built','utf8'),'prepared');require('assert').equal(process.env.ENG109_PREP_ONLY,undefined);process.kill(process.pid,'SIGTERM')"],
  });
  const c = f.attempt().candidate;
  assert.equal(c.gate.result, 'interrupted'); assert.equal(c.gate.signal, 'SIGTERM'); assert.equal(c.question, null);
  assert.equal(f.attempt().candidate.id, c.id); assert.equal(f.record(['releases', '--json']).candidates.length, 1);
});

test('scratch preview runs preparation with inherited dependency-skip switches removed', t => {
  const f = fixture(t, { prepare: ['node', 'build.cjs'], gate: ['node', 'gate.cjs'] });
  fs.writeFileSync(path.join(f.repo, 'build.cjs'), "require('assert').equal(process.env.RELEASE_NO_NPM,undefined);require('fs').writeFileSync('built','real preparation');");
  fs.writeFileSync(path.join(f.repo, 'gate.cjs'), "require('assert').equal(require('fs').readFileSync('built','utf8'),'real preparation');");
  f.git(['add', '.']); f.git(['commit', '-qm', 'Prepare preview candidate']);
  const r = f.exec(process.execPath, [path.join(ROOT, 'release/release.mjs'), '--dry-run', '--max-load-per-cpu', '100'], f.repo, { RELEASE_NO_NPM: '1' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const preview = JSON.parse(r.stdout);
  t.after(() => fs.rmSync(preview.preview, { recursive: true, force: true }));
  assert.equal(preview.result, 'awaiting-operator');
  assert.equal(preview.source_commit, f.git(['rev-parse', 'HEAD']));
  assert.equal(fs.readFileSync(path.join(preview.candidate.snapshot, 'built'), 'utf8'), 'real preparation');
  assert.equal(f.git(['tag']), '', 'the source project gains no candidate tag');
});

test('a moved candidate tag cannot reuse its green evidence', t => {
  const f = fixture(t, { gate: ['node', 'gate.cjs'] }); const c = f.attempt().candidate;
  assert.equal(c.gate.result, 'passed', fs.readFileSync(c.gate.log, 'utf8'));
  const changed = f.git(['commit-tree', c.tree, '-m', 'Different candidate identity']);
  f.git(['tag', '-f', c.tag, changed]);
  assert.throws(() => f.attempt(), /tag moved/); assert.equal(fs.readFileSync(f.count, 'utf8'), 'gate\n');
});
