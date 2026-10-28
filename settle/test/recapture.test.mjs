import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';

const receipt = (f, run) => JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${run}.json`)));
const result = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
function advance(f, file = 'upstream', text = 'upstream\n') {
  fs.writeFileSync(path.join(f.repo, file), text); f.git(['add', '--', file]); f.git(['commit', '-qm', 'Advance main']);
}
function uncertain(f, run) {
  fs.writeFileSync(path.join(f.root, 'review-fail'), 'fail');
  assert.equal(f.settle(run).status, 1); assert.equal(receipt(f, run).stage, 'reviewing');
  fs.unlinkSync(path.join(f.root, 'review-fail'));
}

for (const conflict of [false, true]) test(`recovery: moved main cannot swallow a capped findings correction${conflict ? ' even with a replay conflict' : ''}`, t => {
  const f = fixture(t), run = f.start(); f.commit('wrong\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'review-result.json'), JSON.stringify({ verdict: 'NEEDS-WORK',
    findings: '- [Moderate] work.txt:1 - Remaining issue; Fix: write correct' }));
  assert.equal(result(f.settle(run, ['--review-round-cap', '1'])).result, 'promotable_with_findings');
  const before = receipt(f, run), starts = f.calls().filter(a => a[1] === 'start').length;
  advance(f, conflict ? 'work.txt' : 'upstream', 'upstream change\n');
  const fixed = result(f.retry(run, ['--fix-findings'])); assert.equal(fixed.result, 'fix_round');
  const dispatched = JSON.parse(fs.readFileSync(fixed.fix.journal));
  assert.equal(dispatched.base, before.finalHead, 'correction starts from the verified lane, not moved main');
  assert.equal(dispatched.fromRun, run); assert.equal(dispatched.workspace, f.workspace);
  assert.equal(f.calls().filter(a => a[1] === 'start').length, starts + 1);
  assert.equal(f.calls().filter(a => a[1] === 'prompt' && a[3]?.startsWith('You are run ')).length, 1);
  assert.equal(f.show(f.show(run).item).runs.length, 2);
  assert.equal(receipt(f, run).mainHead, before.mainHead); assert.equal(receipt(f, run).recaptures, undefined);
  assert.equal(receipt(f, run).rebase, undefined);
  assert.deepEqual(result(f.retry(run, ['--fix-findings'])), fixed);
  assert.equal(f.calls().filter(a => a[1] === 'start').length, starts + 1);
});

test('recovery: record-stage recapture waits for ingestion and follows the latest main', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const marker = path.join(f.root, 'fail-check'), adapter = path.join(f.root, 'record-adapter.mjs');
  fs.writeFileSync(marker, 'fail');
  fs.writeFileSync(adapter, `#!${process.execPath}
import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]==='check'&&fs.existsSync(${JSON.stringify(marker)})){console.error('injected report check failure');process.exit(1);}
const r=spawnSync(process.execPath,[${JSON.stringify(path.join(f.source, 'bin/org.mjs'))},...args],{stdio:'inherit'});process.exit(r.status??1);
`, { mode: 0o755 });
  const options = ['--org-cli', adapter];
  assert.equal(f.settle(run, options).status, 1); assert.equal(receipt(f, run).stage, 'record');
  assert.equal(f.show(run).report, null);
  const before = receipt(f, run), head = f.git(['rev-parse', 'HEAD'], f.workspace); advance(f);
  const pending = f.retry(run, options); assert.equal(pending.status, 1); assert.match(pending.stderr, /report check failure/);
  assert.equal(receipt(f, run).stage, 'record'); assert.equal(receipt(f, run).mainHead, before.mainHead);
  assert.equal(receipt(f, run).recapture.onto, f.git(['rev-parse', 'main']));
  assert.equal(receipt(f, run).rebase, undefined); assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), head);
  advance(f, 'upstream', 'latest upstream\n'); fs.unlinkSync(marker);
  const ready = result(f.retry(run, options)); assert.equal(ready.result, 'promotable');
  assert.equal(f.show(run).report.sha256, before.reportHash);
  assert.equal(receipt(f, run).mainHead, f.git(['rev-parse', 'main'])); assert.equal(receipt(f, run).recaptures.length, 1);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'upstream'), 'utf8'), 'latest upstream\n');
  assert.equal(f.calls().filter(a => a[1] === 'start').length, 1);
  assert.equal(f.git(['rev-list', '--merges', `main..${ready.head}`]), '');
});

for (const mutation of ['none', 'unrelated', 'review-bytes', 'merge']) test(mutation === 'none'
  ? 'recovery: a lost review commit response is adopted before recapturing moved main'
  : `lost review commit recovery refuses ${mutation} changes after main moves`, t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const realGit = f.exec('which', ['git']).stdout.trim(), marker = path.join(f.root, 'lost-commit');
  fs.writeFileSync(path.join(f.root, 'bin/git'), `#!${process.execPath}
const fs=require('fs'),cp=require('child_process'),a=process.argv.slice(2),r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});
if(r.status===0&&a[0]==='commit'&&a.includes('Add topic independent review round 1')&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'once');console.error('lost review commit response');process.exit(1);}process.exit(r.status??1);
`, { mode: 0o755 });
  const failed = f.settle(run); assert.equal(failed.status, 1); assert.match(failed.stderr, /lost review commit response/);
  const before = receipt(f, run); assert.equal(before.stage, 'commit-review');
  assert.equal(f.git(['rev-parse', 'HEAD^'], f.workspace), before.head);
  if (mutation === 'unrelated') {
    fs.writeFileSync(path.join(f.workspace, 'unrelated'), 'keep'); f.git(['add', 'unrelated'], f.workspace); f.git(['commit', '-qm', 'Unrelated work'], f.workspace);
  } else if (mutation === 'review-bytes') {
    fs.appendFileSync(before.review.path, '\n'); f.git(['add', '--', before.reviewRelative], f.workspace); f.git(['commit', '--amend', '--no-edit', '-q'], f.workspace);
  } else if (mutation === 'merge') {
    const tree = f.git(['rev-parse', 'HEAD^{tree}'], f.workspace);
    const merged = f.git(['commit-tree', tree, '-p', before.head, '-p', before.mainHead, '-m', 'Forged review merge'], f.workspace);
    f.git(['update-ref', 'refs/heads/lane/topic', merged], f.workspace);
  }
  advance(f);
  if (mutation !== 'none') {
    const head = f.git(['rev-parse', 'HEAD'], f.workspace), refused = f.retry(run);
    assert.equal(refused.status, 1); assert.match(refused.stderr, /unexpected commit after review/);
    assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), head);
    assert.equal(receipt(f, run).mainHead, before.mainHead); assert.equal(receipt(f, run).recapture, undefined);
    assert.equal(f.calls().filter(a => a[1] === 'start').length, 1);
    return;
  }
  const ready = result(f.retry(run)); assert.equal(ready.result, 'promotable');
  assert.equal(receipt(f, run).mainHead, f.git(['rev-parse', 'main'])); assert.equal(receipt(f, run).recaptures.length, 1);
  assert.equal(receipt(f, run).review.sha256, before.review.sha256);
  assert.deepEqual(f.git(['log', '--format=%s', `main..${ready.head}`]).split('\n'), ['Add topic independent review round 1', 'Implement work']);
  assert.equal(f.calls().filter(a => a[1] === 'start').length, 1); assert.equal(f.show(f.show(run).item).runs.length, 1);
});

test('two recaptures after an applied rebase replay only lane and review commits from the same lineage', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  advance(f);
  assert.equal(result(f.settle(run)).result, 'promotable');
  const original = receipt(f, run); assert.equal(original.rebase.state, 'applied');
  for (const text of ['second upstream\n', 'third upstream\n']) {
    advance(f, 'upstream', text);
    const ready = result(f.retry(run)); assert.equal(ready.result, 'promotable');
    assert.deepEqual(f.git(['log', '--format=%s', `main..${ready.head}`]).split('\n'), ['Add topic independent review round 1', 'Implement work']);
    assert.equal(f.git(['rev-list', '--merges', `main..${ready.head}`]), '');
    assert.equal(fs.readFileSync(path.join(f.workspace, 'upstream'), 'utf8'), text);
    assert.equal(receipt(f, run).review.sha256, original.review.sha256);
  }
  assert.equal(receipt(f, run).recaptures.length, 2);
  assert.equal(f.calls().filter(a => a[1] === 'start').length, 1); assert.equal(f.show(f.show(run).item).runs.length, 1);
});

test('uncertain review retry guards lane mutation before recapturing a moved main', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run); uncertain(f, run);
  const before = receipt(f, run), head = f.git(['rev-parse', 'HEAD'], f.workspace);
  advance(f);
  const refused = f.retry(run); assert.equal(refused.status, 1); assert.match(refused.stderr, /review outcome is uncertain/);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), head);
  assert.equal(receipt(f, run).mainHead, before.mainHead); assert.equal(receipt(f, run).recaptures, undefined);
  assert.equal(receipt(f, run).rebase, undefined); assert.equal(f.calls().filter(a => a[1] === 'start').length, 1);
  assert.equal(result(f.retry(run, ['--review-again'])).result, 'promotable');
});

for (const mode of ['preflight', 'replay']) test(`refused recapture ${mode} preserves its old base and gives a terminal conflict handoff`, t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n');
  if (mode === 'replay') f.commit('base\n'); // Net tree merges cleanly; the first replayed commit conflicts.
  f.report(run); uncertain(f, run);
  const before = receipt(f, run), head = f.git(['rev-parse', 'HEAD'], f.workspace), launches = f.calls().filter(a => a[1] === 'start').length;
  advance(f, 'work.txt', 'upstream conflict\n');
  const stopped = result(f.retry(run, ['--review-again'])); assert.equal(stopped.result, 'escalate');
  assert.match(stopped.reason, /conflicts in: work.txt/); assert.match(fs.readFileSync(stopped.handoff, 'utf8'), /conflicts in: work.txt/);
  const after = receipt(f, run); assert.equal(after.mainHead, before.mainHead); assert.equal(after.recaptures, undefined);
  assert.equal(after.recapture.onto, f.git(['rev-parse', 'main']));
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), head);
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
  assert.deepEqual(result(f.retry(run, ['--review-again'])), stopped);
  assert.equal(f.calls().filter(a => a[1] === 'start').length, launches);
});

test('a lost recapture replacement response retains the old base until the proved head is adopted', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run); uncertain(f, run);
  const before = receipt(f, run); advance(f);
  const realGit = f.exec('which', ['git']).stdout.trim(), marker = path.join(f.root, 'lost'), proxy = path.join(f.root, 'lost.cjs');
  fs.writeFileSync(proxy, `const fs=require('fs'),cp=require('child_process'),a=process.argv.slice(2),r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});
if(r.status===0&&a[0]==='update-ref'&&a.includes('--stdin')&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'once');console.error('lost recapture replacement response');process.exit(1);}process.exit(r.status??1);`);
  fs.writeFileSync(path.join(f.root, 'bin/git'), `#!/bin/sh\nif [ "$1" = update-ref ]; then exec '${process.execPath}' '${proxy}' "$@"; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const failed = f.retry(run, ['--review-again']); assert.equal(failed.status, 1); assert.match(failed.stderr, /lost recapture replacement response/);
  const pending = receipt(f, run); assert.equal(pending.mainHead, before.mainHead); assert.equal(pending.rebase.state, 'prepared');
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), pending.rebase.to);
  assert.equal(result(f.retry(run, ['--review-again'])).result, 'promotable');
  assert.equal(receipt(f, run).mainHead, f.git(['rev-parse', 'main'])); assert.equal(receipt(f, run).recaptures.length, 1);
  assert.equal(receipt(f, run).recapture, undefined); assert.equal(f.show(f.show(run).item).runs.length, 1);
});

test('dispatching recovery after main moves exempts only its existing correction run and changed head', t => {
  const f = fixture(t), run = f.start(); f.commit('wrong\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'prompt-fail'), 'fail');
  assert.equal(f.requestCorrection(run).status, 1); const before = receipt(f, run); assert.equal(before.stage, 'dispatching');
  const launches = f.calls().filter(a => a[1] === 'start').length; advance(f);
  const uncertain = f.retry(run); assert.equal(uncertain.status, 1); assert.match(uncertain.stderr, /delivery outcome is unknown/);
  assert.equal(f.calls().filter(a => a[1] === 'start').length, launches);
  fs.unlinkSync(path.join(f.root, 'prompt-fail'));
  const dir = path.join(f.org, 'dispatch'), file = fs.readdirSync(dir).find(n => n.endsWith('.json') && !n.endsWith('.routes.json'));
  const dispatch = result(f.exec(process.execPath, [path.join(f.source, 'dispatch/dispatch.mjs'), '--org', f.org, '--retry', path.join(dir, file), '--resend']));
  assert.notEqual(f.git(['rev-parse', 'HEAD'], f.workspace), before.finalHead);
  const fixed = result(f.retry(run)); assert.equal(fixed.result, 'fix_round'); assert.equal(fixed.fix.run, dispatch.run);
  assert.equal(f.calls().filter(a => a[1] === 'start').length, launches); assert.equal(f.show(f.show(run).item).runs.length, 2);
  assert.equal(receipt(f, run).mainHead, before.mainHead); assert.equal(receipt(f, run).recaptures, undefined);
});

test('a stopped fix tolerates main moving and dispatches one correction after STOP clears', t => {
  const f = fixture(t), run = f.start(); f.commit('wrong\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'review-stop'), 'stop');
  assert.equal(result(f.requestCorrection(run)).result, 'stopped'); const before = receipt(f, run); assert.equal(before.stage, 'fix');
  advance(f); assert.equal(result(f.retry(run)).result, 'stopped');
  assert.equal(f.show(f.show(run).item).runs.length, 1);
  fs.unlinkSync(path.join(f.repo, '.lane/supervisor/STOP'));
  const fixed = result(f.retry(run)); assert.equal(fixed.result, 'fix_round');
  assert.equal(JSON.parse(fs.readFileSync(fixed.fix.journal)).base, before.finalHead);
  assert.equal(f.show(f.show(run).item).runs.length, 2);
  assert.equal(receipt(f, run).mainHead, before.mainHead); assert.equal(receipt(f, run).recaptures, undefined);
});
