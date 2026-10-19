import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { reviewScope } from '../review-range.mjs';
import { readReport } from '../../lib/report.mjs';
import { fixture } from './fixture.mjs';
import { moveMainOnSave } from './auto-retry-fixture.mjs';

function history(t) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-scope-')));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
  const git = args => {
    const r = spawnSync('git', args, { cwd: workspace, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-qb', 'main']);
  git(['config', 'user.name', 'Review scope fixture']); git(['config', 'user.email', 'scope@example.invalid']);
  const commit = (name) => {
    fs.writeFileSync(path.join(workspace, name), `${name}\n`);
    git(['add', name]); git(['commit', '-qm', name]); return git(['rev-parse', 'HEAD']);
  };
  const base = commit('base');
  git(['checkout', '-qb', 'foreign']); const foreign = commit('foreign');
  git(['checkout', '-qb', 'lane/topic', base]);
  const first = commit('first'), head = commit('second');
  const scope = artifacts => reviewScope({ workspace, base: 'main', head: 'HEAD', artifacts });
  return { workspace, git, commit, base, first, head, foreign, scope };
}

test('ENG-1670 replay: quoted artifacts claim only delivery; body bases and historical commands never defer', t => {
  const f = history(t), tree = f.git(['rev-parse', 'HEAD^{tree}']);
  const artifacts = ['lane/topic', f.first, `${f.head} on lane/topic`, '/absolute/evidence/R-2440',
    'settle/settle.mjs', `Validated tree: ${tree}`, 'sha256 deadbeef', `evidence/${f.foreign}/report.md`];
  const parsed = readReport(`---\nrun: R-2440\noutcome: done\nsummary: Delivered work\nartifacts:\n${artifacts.map(x => `  - ${JSON.stringify(x)}`).join('\n')}\n---\n\nfull base\n\`${f.base}\`\n\nHistorical command: --base ${f.base} --head ${f.foreign}\nCommit: ${f.foreign}\n`);
  assert.deepEqual(parsed.errors, []);
  const scope = f.scope(parsed.report.artifacts);
  assert.equal(scope.schema, 'brain.review-scope/v1'); assert.equal(scope.base, f.base); assert.equal(scope.head, f.head);
  assert.deepEqual(scope.commits, [f.head, f.first]); assert.deepEqual(scope.claims, [f.first, f.head]);
  assert.deepEqual(scope.outside, []); assert.deepEqual(scope.unresolved, []); assert.equal(scope.deferred, null);
  assert.deepEqual(scope.context, [tree, 'deadbeef']);
});

test('merge-base edge: main-only and merge-base delivery claims defer while lane claims and labelled bases pass', t => {
  const f = history(t);
  f.git(['checkout', 'main']); const mainOnly = f.commit('main-only'); f.git(['checkout', 'lane/topic']);
  const passed = f.scope([`Commit: ${f.first}`, `HEAD ${f.head}`, `Base: ${f.base}`]);
  assert.equal(passed.deferred, null); assert.equal(passed.base, f.base); assert.deepEqual(passed.commits, [f.head, f.first]);
  for (const sha of [mainOnly, f.base]) {
    const scope = f.scope([`Branch head: ${sha}`]);
    assert.equal(scope.deferred, 'named-commit-outside-range'); assert.deepEqual(scope.outside, [sha]);
  }
});

test('a lane that merged main retains its pre-merge delivery commits in scope', t => {
  const f = history(t);
  f.git(['checkout', 'main']); const mainOnly = f.commit('main-only'); f.git(['checkout', 'lane/topic']);
  f.git(['merge', '--no-ff', '-qm', 'Merge main into lane', 'main']);
  const merged = f.git(['rev-parse', 'HEAD']), scope = f.scope([f.first, f.head, `Head: ${merged}`]);
  assert.equal(scope.base, mainOnly); assert.equal(scope.deferred, null);
  assert.deepEqual(new Set(scope.commits), new Set([f.first, f.head, merged]));
});

test('rebase replay: current delivery passes, pre-rebase delivery defers, tested implementation remains informational', t => {
  const f = history(t), startHead = f.base;
  f.git(['checkout', 'main']); const main = f.commit('main-only'); f.git(['checkout', 'lane/topic']);
  f.git(['rebase', 'main']); const rebased = f.git(['rev-parse', 'HEAD']);
  assert.notEqual(rebased, f.head); assert.equal(f.git(['rev-parse', `${f.head}^{commit}`]), f.head);
  const scope = f.scope([`Commit: ${rebased}`, `Tested implementation ${f.head}`, `Main ${main}`, `start_head: ${startHead}`]);
  assert.equal(scope.base, main); assert.equal(scope.deferred, null); assert.deepEqual(scope.claims, [rebased]);
  assert.deepEqual(scope.context, [f.head, main, startHead]);
  const oldClaim = f.scope([`Commit: ${f.head}`]);
  assert.equal(oldClaim.deferred, 'named-commit-outside-range'); assert.deepEqual(oldClaim.outside, [f.head]);
});

test('resolution distinguishes abbreviations, unknown delivery claims and non-commit objects', t => {
  const f = history(t), unknown = 'f'.repeat(40), short = f.first.slice(0, 9);
  const tree = f.git(['rev-parse', 'HEAD^{tree}']), blob = f.git(['rev-parse', 'HEAD:first']);
  const good = f.scope([short, `Commit: ${f.head.toUpperCase()}`, `HEAD: ${tree}`, `Commit: ${blob}`]);
  assert.equal(good.deferred, null); assert.deepEqual(good.claims, [f.first, f.head]);
  assert.deepEqual(good.context, [tree, blob]);
  for (const entry of [`Commit: ${unknown}`, `head=${unknown}`, unknown, `${unknown} on lane/topic`]) {
    const scope = f.scope([entry]);
    assert.equal(scope.deferred, 'named-commit-unresolved'); assert.deepEqual(scope.unresolved, [unknown]);
  }
  assert.equal(f.scope([`Evidence ${unknown}`]).deferred, null);
  assert.equal(f.scope(['12345678']).deferred, null);
  assert.deepEqual(f.scope(['Commit: 12345678']).unresolved, ['12345678']);
});

test('context labels, quoted commands and path/identifier boundaries never claim the delivered change', t => {
  const f = history(t), labels = ['base', 'baseline', 'main', 'merge-base', 'start', 'start_head', 'reviewed',
    'onto', 'upstream', 'parent', 'previous', 'pre-rebase', 'superseded', 'tree', 'sha256', 'digest', 'checksum',
    'Tested implementation', 'Earlier round commit'];
  const contextual = f.scope(labels.map(label => `${label}: ${f.foreign}`));
  assert.equal(contextual.deferred, null); assert.deepEqual(contextual.claims, []); assert.deepEqual(contextual.context, [f.foreign]);
  for (const boundary of ['Z', '/', '.', '_', '~', '-']) {
    const scope = f.scope([`Commit: ${boundary}${f.foreign}`, `HEAD: ${f.foreign}${boundary}`]);
    assert.equal(scope.deferred, null); assert.deepEqual(scope.claims, []); assert.deepEqual(scope.unresolved, []);
  }
  for (const entry of ['Commit: eeeeee', `HEAD: ${'e'.repeat(65)}`, `Commit: 0x${f.foreign}`, `HEAD: g${f.foreign}`]) {
    assert.deepEqual(f.scope([entry]).unresolved, []);
  }
  const commands = f.scope([`Quoted command: --base ${f.base} --head ${f.foreign}`, `git show ${f.foreign}`, `--head ${f.foreign}`]);
  assert.equal(commands.deferred, null); assert.deepEqual(commands.claims, []);
  assert.equal(f.scope([`Commit: \`${f.foreign}\``]).deferred, 'named-commit-outside-range');
  assert.equal(f.scope([]).deferred, null, 'HEAD need not be named');
});

const settled = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
test('settle ingests an outside delivery claim and escalates with scope evidence before any reviewer launches', t => {
  const f = fixture(t), run = f.start(), outside = f.git(['rev-parse', 'main']);
  f.commit('correct\n'); f.report(run, 'done', { artifacts: [`Commit: ${outside}`] });
  const result = settled(f.settle(run));
  assert.equal(result.result, 'escalate');
  assert.match(result.reason, new RegExp(`Review scope deferred: named-commit-outside-range: ${outside.slice(0, 12)}`));
  assert.deepEqual(result.review_scope.outside, [outside]); assert.equal(result.review, null);
  assert.deepEqual(f.calls(), []); assert.ok(f.show(run).report, 'report is ingested');
  const job = JSON.parse(fs.readFileSync(result.journal, 'utf8'));
  assert.deepEqual(job.reviewScope, result.review_scope);
  const handoff = fs.readFileSync(result.handoff, 'utf8');
  assert.match(handoff, /"review_scope":/); assert.ok(handoff.includes(outside));
});

test('R-2444 replay: a continuation without lane metadata and quoted in-range artifacts reaches review', t => {
  const f = fixture(t), previous = f.start();
  f.report(previous); f.record(['ingest', f.show(previous).report_path]);
  const run = f.record(['start', f.show(previous).item, '--workspace', f.workspace]).match(/R-\d+/)[0];
  assert.equal(f.show(run).meta?.lane, undefined);
  const base = f.git(['rev-parse', 'main']);
  f.commit('first delivery\n'); const first = f.git(['rev-parse', 'HEAD'], f.workspace);
  f.commit('correct\n'); const head = f.git(['rev-parse', 'HEAD'], f.workspace);
  f.report(run, 'done', { artifacts: ['lane/topic', first, `HEAD: ${head}`, `Base: ${base}`],
    body: `Claim: work.txt contains correct.\nfull base\n\`${base}\`\nHistorical command --head ${base}` });
  const result = settled(f.settle(run));
  assert.equal(result.result, 'promotable'); assert.equal(result.review.verdict, 'PASS');
  assert.deepEqual(result.review_scope.claims, [first, head]); assert.equal(result.review_scope.head, head);
  assert.equal(result.review_scope.deferred, null);
  assert.equal(f.calls().filter(args => args[0] === 'agent' && args[1] === 'prompt' && args[3]?.includes('Private record file: ')).length, 1);
});

const receipt = (f, run) => JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${run}.json`), 'utf8'));
const reviews = f => f.calls().filter(args => args[0] === 'agent' && args[1] === 'prompt' && args[3]?.includes('Private record file: '));
function advance(f, file = 'upstream') {
  fs.writeFileSync(path.join(f.repo, file), 'main advanced\n');
  f.git(['add', file]); f.git(['commit', '-qm', 'Advance main']);
}

test('settle preserves delivery claims when a retry recaptures main and replays an unreviewed head', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n');
  const delivered = f.git(['rev-parse', 'HEAD'], f.workspace);
  f.report(run, 'done', { artifacts: [`Commit: ${delivered}`] });
  const marker = path.join(f.root, 'review-fail'); fs.writeFileSync(marker, 'fail');
  assert.equal(f.settle(run).status, 1);
  const original = receipt(f, run).reviewScope;
  assert.equal(reviews(f).length, 1);
  fs.unlinkSync(marker);
  advance(f);
  const result = settled(f.retry(run, ['--review-again']));
  const saved = receipt(f, run);
  assert.equal(result.result, 'promotable'); assert.equal(result.review.verdict, 'PASS');
  assert.deepEqual(result.review_scope, original); assert.equal(result.review_scope.deferred, null);
  assert.deepEqual(result.review_scope.claims, [delivered]); assert.deepEqual(result.review_scope.outside, []);
  assert.equal(result.review_scope.head, delivered); assert.notEqual(saved.head, delivered);
  assert.equal(saved.rebase.from, delivered); assert.equal(saved.rebase.to, result.reviewed_commit);
  assert.equal(saved.rebase.state, 'applied'); assert.equal(saved.rebase.expected_tree, saved.rebase.actual_tree);
  assert.equal(reviews(f).length, 2);
});

for (const stage of ['validate', 'review']) test(`automatic main-move retry at ${stage} preserves the original delivered commit claim`, t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n');
  const delivered = f.git(['rev-parse', 'HEAD'], f.workspace), base = f.git(['rev-parse', 'main']);
  f.report(run, 'done', { artifacts: [`Commit: ${delivered}`] });
  const marker = moveMainOnSave(f, run, stage);
  const result = settled(f.settle(run)), saved = receipt(f, run);
  assert.equal(result.result, 'promotable'); assert.equal(result.review.verdict, 'PASS');
  assert.equal(saved.automaticBaseRetry.stage, stage); assert.equal(saved.recaptures.length, 1);
  assert.deepEqual(saved.deliveryRange, { base, head: delivered });
  assert.equal(result.review_scope.deferred, null); assert.deepEqual(result.review_scope.claims, [delivered]);
  assert.equal(result.review_scope.base, base); assert.equal(result.review_scope.head, delivered);
  assert.deepEqual(result.review_scope.outside, []); assert.notEqual(saved.head, delivered);
  assert.equal(saved.rebase.from, delivered); assert.equal(saved.rebase.to, result.reviewed_commit);
  assert.equal(saved.rebase.state, 'applied'); assert.equal(saved.rebase.expected_tree, saved.rebase.actual_tree);
  const beforeMove = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (stage === 'review') assert.deepEqual(result.review_scope, beforeMove.reviewScope);
  else assert.equal(beforeMove.reviewScope, undefined, 'move precedes the initial scope check');
  assert.ok(fs.readFileSync(path.join(f.root, 'review-prompt'), 'utf8').includes(`Reviewed commit: ${saved.head}`));
  assert.equal(reviews(f).length, 1); assert.deepEqual(f.show(result.item).runs, [run]);
});

test('legacy journals without scope or range recover the original claims from proved replay receipts across recaptures', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n');
  const delivered = f.git(['rev-parse', 'HEAD'], f.workspace), base = f.git(['rev-parse', 'main']);
  f.report(run, 'done', { artifacts: [`Commit: ${delivered}`] });
  const marker = path.join(f.root, 'review-fail'); fs.writeFileSync(marker, 'fail');
  assert.equal(f.settle(run).status, 1);
  advance(f);
  assert.equal(f.retry(run, ['--review-again']).status, 1);
  const file = path.join(f.org, 'settle', `${run}.json`), legacy = receipt(f, run);
  assert.equal(legacy.rebase.state, 'applied'); assert.notEqual(legacy.head, delivered);
  delete legacy.reviewScope; delete legacy.deliveryRange;
  fs.writeFileSync(file, JSON.stringify(legacy));
  advance(f, 'second-upstream'); fs.unlinkSync(marker);
  const result = settled(f.retry(run, ['--review-again'])), saved = receipt(f, run);
  assert.equal(result.result, 'promotable'); assert.equal(result.review.verdict, 'PASS');
  assert.equal(saved.recaptures.length, 2); assert.equal(saved.recaptures[1].rebase.from, delivered);
  assert.equal(result.review_scope.base, base); assert.equal(result.review_scope.head, delivered);
  assert.deepEqual(result.review_scope.claims, [delivered]); assert.equal(result.review_scope.deferred, null);
  assert.equal(reviews(f).length, 3);
});

test('a retained scope never authorizes a lane head moved by someone other than settle', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n');
  const delivered = f.git(['rev-parse', 'HEAD'], f.workspace);
  f.report(run, 'done', { artifacts: [`Commit: ${delivered}`] });
  const marker = path.join(f.root, 'review-fail'); fs.writeFileSync(marker, 'fail');
  assert.equal(f.settle(run).status, 1); fs.unlinkSync(marker);
  f.commit('external change\n'); const moved = f.git(['rev-parse', 'HEAD'], f.workspace);
  advance(f);
  const result = f.retry(run, ['--review-again']);
  assert.equal(result.status, 1); assert.match(result.stderr, /lane HEAD or branch moved/);
  assert.equal(JSON.parse(result.stdout).result, 'escalate');
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), moved);
  assert.equal(receipt(f, run).rebase, undefined); assert.equal(reviews(f).length, 1);
});
