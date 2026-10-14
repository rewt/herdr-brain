import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';
import { inspectReviewScope, validateReviewScope } from '../review-scope.mjs';
import { autopilotNotice } from '../../supervisor/autopilot.mjs';
import { gitProject } from '../../lib/project.mjs';
import { queueFor } from '../../promote/promote.mjs';
import { ROUTE_PRESET } from '../../lanes/preset.mjs';

const result = r => { assert.equal(r.status, 0, r.stderr || r.stdout); return JSON.parse(r.stdout); };
const receipt = (f, run) => JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${run}.json`), 'utf8'));
function configure(f, paths = ['work.txt']) {
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ settle: { review: { mode: 'scoped', paths } } }));
  f.git(['add', '.lane.json']); f.git(['commit', '-qm', 'Configure scoped review']);
  f.git(['rebase', 'main'], f.workspace);
}
function writeCommit(f, file, text, cwd = f.workspace) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  f.git(['add', '--', file], cwd); f.git(['commit', '-qm', `Change ${file}`], cwd);
}

test('scoped review accepts only explicit literal paths and defaults to required', () => {
  assert.deepEqual(validateReviewScope(), { mode: 'required', paths: [] });
  for (const value of [null, false, {}, { mode: 'skip' }, { mode: 'scoped' },
    { mode: 'required', paths: ['work.txt'] }, { mode: 'scoped', paths: ['../work.txt'] },
    { mode: 'scoped', paths: ['docs/**'] }, { mode: 'scoped', paths: ['/docs/'] },
    { mode: 'scoped', paths: ['docs//'] }, { mode: 'scoped', paths: ['docs/../'] },
    { mode: 'scoped', paths: ['docs/'], extra: true }]) assert.throws(() => validateReviewScope(value));
  assert.deepEqual(validateReviewScope({ mode: 'scoped', paths: ['docs/', 'work.txt', 'docs/'] }),
    { mode: 'scoped', paths: ['docs/', 'work.txt'] });
});

test('scoped settlement records no review, changes no source commit, and replays without a model', t => {
  const f = fixture(t); configure(f);
  const run = f.start(); f.commit('correct\n'); f.report(run);
  const head = f.git(['rev-parse', 'HEAD'], f.workspace), settled = result(f.settle(run));
  assert.equal(settled.result, 'promotable'); assert.equal(settled.review, null); assert.equal(settled.reviewed_commit, null);
  assert.equal(settled.independent_review.required, false); assert.deepEqual(settled.independent_review.paths, ['work.txt']);
  assert.equal(settled.head, head); assert.equal(settled.validation.executed, false);
  assert.equal(settled.validation.deferred_to, 'promotion queue');
  assert.equal(fs.existsSync(path.join(f.workspace, 'docs/reviews')), false);
  assert.equal(result(f.settle(run)).head, head);
  assert.deepEqual(f.calls(), []); assert.equal(f.show(f.show(run).item).closed, null);
  assert.match(receipt(f, run).settleDecision, /independent review not performed/);
});

test('scoped settlement rechecks preserved source after main moves without launching a reviewer', t => {
  const f = fixture(t); configure(f);
  const run = f.start(); f.commit('correct\n'); f.report(run);
  const first = result(f.settle(run));
  writeCommit(f, 'upstream.txt', 'unrelated\n', f.repo);
  const base = f.git(['rev-parse', 'main']);
  const replay = result(f.retry(run));
  assert.equal(replay.result, 'promotable'); assert.equal(replay.review, null);
  assert.notEqual(replay.head, first.head); assert.equal(f.git(['merge-base', 'main', replay.head]), base);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'correct\n');
  assert.deepEqual(f.calls(), []); assert.equal(result(f.settle(run)).head, replay.head);
});

test('a committed scoped-policy revocation invalidates retained readiness', t => {
  const f = fixture(t); configure(f);
  const run = f.start(); f.commit('correct\n'); f.report(run); result(f.settle(run));
  writeCommit(f, '.lane.json', JSON.stringify({ settle: { review: { mode: 'required' } } }), f.repo);
  const retry = f.retry(run);
  assert.notEqual(retry.status, 0); assert.match(retry.stderr, /review policy or change scope changed/);
  assert.deepEqual(f.calls(), []);
});

for (const origin of ['lane', 'environment', 'parent']) test(`${origin} config cannot authorize scoped settlement`, t => {
  const f = fixture(t), config = JSON.stringify({ ...ROUTE_PRESET, settle: { review: { mode: 'scoped', paths: ['work.txt', '.lane.json'] } } });
  if (origin === 'lane') writeCommit(f, '.lane.json', config);
  if (origin === 'parent') fs.writeFileSync(path.join(f.root, '.lane.json'), config);
  if (origin === 'environment') {
    const file = path.join(f.root, 'selected.json'); fs.writeFileSync(file, config); f.env.LANE_CONFIG = file;
  }
  const run = f.start(); f.commit('correct\n'); f.report(run);
  const settled = result(f.settle(run));
  assert.equal(settled.review.verdict, 'PASS'); assert.equal(settled.independent_review.required, true);
});

test('scoped path coverage includes both sides of renames and protects instructions and policy files', t => {
  const f = fixture(t); configure(f, ['work.txt', 'docs/']);
  writeCommit(f, 'docs/ordinary.md', 'hello\n');
  assert.equal(inspectReviewScope(f.repo, f.git(['rev-parse', 'HEAD'], f.workspace)).required, false);
  f.git(['mv', 'work.txt', 'outside.txt'], f.workspace); f.git(['commit', '-qm', 'Move outside scope'], f.workspace);
  assert.equal(inspectReviewScope(f.repo, f.git(['rev-parse', 'HEAD'], f.workspace)).required, true);
  f.git(['mv', 'outside.txt', 'work.txt'], f.workspace); f.git(['commit', '-qm', 'Restore path'], f.workspace);
  writeCommit(f, 'docs/AGENTS.md', 'new authority\n');
  assert.equal(inspectReviewScope(f.repo, f.git(['rev-parse', 'HEAD'], f.workspace)).required, true);
});

test('an out-of-scope edit still receives independent review', t => {
  const f = fixture(t); configure(f, ['docs/']);
  const run = f.start(); f.commit('correct\n'); f.report(run);
  const settled = result(f.settle(run));
  assert.equal(settled.review.verdict, 'PASS'); assert.equal(settled.independent_review.required, true);
});

test('scoped policy cannot exempt its own edits or nested agent instructions', t => {
  const f = fixture(t); configure(f, ['.lane.json', 'docs/']);
  writeCommit(f, '.lane.json', JSON.stringify({ settle: { review: { mode: 'scoped', paths: ['work.txt'] } } }));
  assert.equal(inspectReviewScope(f.repo, f.git(['rev-parse', 'HEAD'], f.workspace)).required, true);
  f.git(['restore', '--source=main', '--staged', '--worktree', '.lane.json'], f.workspace);
  f.git(['commit', '-qm', 'Restore canonical policy'], f.workspace);
  writeCommit(f, 'docs/.codex/config.toml', 'instructions = "new"\n');
  assert.equal(inspectReviewScope(f.repo, f.git(['rev-parse', 'HEAD'], f.workspace)).required, true);
});

// Defer drain only; run actual supervisor intake/enqueue, train, Git and record.
function integration(f, run) {
  const cli = path.join(f.root, 'deferred-promote.mjs');
  fs.writeFileSync(cli, `import {parseArgs} from 'node:util'; import {queueFor,enqueue} from ${JSON.stringify(path.join(f.source, 'promote/promote.mjs'))};
const {values:o,positionals:p}=parseArgs({allowPositionals:true,options:Object.fromEntries(['repo','org','to','expected-head','if-current-run'].map(k=>[k,{type:'string'}]))});
const q=queueFor(o.repo); const jobs=enqueue(q,p,{org:o.org,expectedHead:o['expected-head'],run:o['if-current-run'],to:o.to??'supervisor',attempts:1,retry:0,herdr:'herdr',laneCLI:${JSON.stringify(path.join(f.source, 'lanes/lane.mjs'))},validate:null});console.log(JSON.stringify({jobs,queue:q.file}));\n`);
  const config = JSON.parse(fs.readFileSync(path.join(f.org, 'config.json')));
  config.approvals.categories.tooling = 'auto'; fs.writeFileSync(path.join(f.org, 'config.json'), JSON.stringify(config));
  const identity = gitProject(f.repo).identity, item = f.show(run).item;
  const entry = { id: 'scoped-report', to: 'supervisor-test', project: { repo: f.repo, org: f.org, identity },
    message: `[org-report] run=${run} item=${item} outcome=done headline=Ready` };
  const execute = (file, args) => f.exec(process.execPath, [file, ...args, ...(args[0] === 'promote' ? ['--promote-cli', cli] : [])]);
  return { queue: queueFor(f.repo), apply: () => autopilotNotice(entry, { execute }),
    drain: () => result(f.exec(process.execPath, [path.join(f.source, 'promote/promote.mjs'), '--repo', f.repo, '--drain'])) };
}

for (const outcome of ['green', 'red', 'blocked', 'revoked']) test(`scoped autonomous delivery: ${outcome}`, { timeout: 45000 }, t => {
  const f = fixture(t);
  writeCommit(f, 'test.mjs', "import assert from 'node:assert/strict'; import fs from 'node:fs'; assert.equal(fs.readFileSync('work.txt','utf8'), 'correct\\n');\n", f.repo);
  configure(f);
  const run = f.start(); f.commit(outcome === 'red' ? 'wrong\n' : 'correct\n'); f.report(run);
  const h = integration(f, run), automatic = h.apply();
  assert.equal(automatic.disposition, 'handled', JSON.stringify(JSON.parse(fs.readFileSync(automatic.receipt))));
  assert.deepEqual(f.calls(), [], 'no reviewer or worker launched');
  assert.equal(h.queue.load().pending.length, 1);
  assert.equal(h.apply().disposition, 'handled'); assert.equal(h.queue.load().pending.length, 1, 'notice replay does not enqueue twice');
  const item = f.show(run).item;
  if (outcome === 'blocked') {
    const blocker = f.record(['add', 'Required assessment', '--role', 'reviewer']).split(' ')[0];
    f.record(['block', item, '--by', blocker]);
  }
  if (outcome === 'revoked') writeCommit(f, '.lane.json', JSON.stringify({ settle: { review: { mode: 'required' } } }), f.repo);
  const base = f.git(['rev-parse', 'main']);
  const drained = h.drain();
  if (outcome === 'green') {
    assert.equal(drained.outcome, 'promoted', JSON.stringify(drained));
    assert.notEqual(f.git(['rev-parse', 'main']), base);
    assert.equal(fs.readFileSync(path.join(f.repo, 'work.txt'), 'utf8'), 'correct\n');
    assert.equal(f.show(item).closed?.as, 'done');
  } else {
    assert.equal(drained.outcome, 'refused', JSON.stringify(drained));
    assert.equal(f.git(['rev-parse', 'main']), base); assert.equal(f.show(item).closed, null);
  }
  assert.equal(f.calls().filter(args => args[0] === 'agent' && args[1] === 'start').length, 0);
});
