import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { reviewScope } from '../review-range.mjs';
import { readReport } from '../../lib/report.mjs';
import { fixture } from './fixture.mjs';

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

test('settle rechecks scope when a retry recaptures main and replays an unreviewed head', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n');
  const delivered = f.git(['rev-parse', 'HEAD'], f.workspace);
  f.report(run, 'done', { artifacts: [`Commit: ${delivered}`] });
  const marker = path.join(f.root, 'review-fail'); fs.writeFileSync(marker, 'fail');
  assert.equal(f.settle(run).status, 1);
  const launches = f.calls().filter(args => args[1] === 'start').length;
  fs.unlinkSync(marker);
  fs.writeFileSync(path.join(f.repo, 'upstream'), 'main advanced\n');
  f.git(['add', 'upstream']); f.git(['commit', '-qm', 'Advance main']);
  const result = settled(f.retry(run, ['--review-again']));
  assert.equal(result.result, 'escalate'); assert.equal(result.review, null);
  assert.equal(result.review_scope.deferred, 'named-commit-outside-range');
  assert.deepEqual(result.review_scope.outside, [delivered]);
  assert.notEqual(result.review_scope.head, delivered);
  assert.equal(f.calls().filter(args => args[1] === 'start').length, launches, 'no second reviewer launches');
});
