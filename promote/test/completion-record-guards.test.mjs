import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, source } from './completion-fixture.mjs';

for (const mode of ['pass-review', 'fail-review', 'no-verdict-review', 'open-question', 'review-question'])
for (const relation of mode === 'open-question' ? ['linked'] : ['linked', 'child-only']) test(`a ${relation} ${mode} recorded after enqueue is checked by the native worker`, t => {
  const f = fixture(t), m = f.lane(mode), base = f.git(['rev-parse', 'main']);
  if (mode === 'open-question') f.recover(m, ['ask', 'Allow this change?', '--parent', m.item, '--category', 'security', '--recommend', 'no', '--why', 'Raised after enqueue', '--wait']);
  else {
    // The no-verdict case uses a role alias: every spelling of the reviewer role counts.
    const rev = f.recover(m, ['add', 'Review', '--role', mode === 'no-verdict-review' ? 'Review' : 'reviewer', '--parent', m.item]).match(/^REV-\d+/)[0];
    if (relation === 'linked') f.recover(m, ['block', m.item, '--by', rev]);
    for (const verdict of { 'pass-review': ['PASS'], 'fail-review': ['PASS', 'FAIL'], 'no-verdict-review': [null], 'review-question': ['PASS'] }[mode]) {
      const report = path.join(f.root, `review-${verdict}.md`);
      const run = f.recover(m, ['start', rev, '--workspace', f.root, '--report', report]).match(/^R-\d+/)[0];
      fs.writeFileSync(report, `---\nrun: ${run}\noutcome: done\n${verdict ? `verdict: ${verdict}\n` : ''}summary: Review ${verdict}\nheadline: Review ${verdict}\n---\n`);
      f.record(['ingest', report]);
    }
    // A done review without a verdict releases status; promotion still requires explicit PASS.
    if (mode === 'no-verdict-review') assert.equal(f.show(m.item).status, 'done');
    // A question filed under the blocking review, not the work, after its PASS.
    if (mode === 'review-question') f.recover(m, ['ask', 'Ship despite this?', '--parent', rev, '--category', 'security', '--recommend', 'no', '--why', 'Raised under the review', '--wait']);
  }
  f.drain();
  const result = f.queue.load().results[0];
  if (mode === 'pass-review') {
    assert.equal(result.outcome, 'promoted', result.reason); assert.equal(f.show(m.item).closed.as, 'done');
    return;
  }
  assert.equal(result.outcome, 'refused');
  assert.match(result.reason, { 'fail-review': /review REV-\d+ has no recorded PASS verdict/, 'no-verdict-review': /review REV-\d+ has no recorded PASS verdict/, 'open-question': /open operator question HUM-\d+/, 'review-question': /open operator question HUM-\d+/ }[mode]);
  assert.equal(f.gates(), 0); assert.equal(f.git(['rev-parse', 'main']), base);
  assert.equal(f.show(m.item).closed, null); assert.ok(fs.existsSync(m.workspace));
});

for (const under of ['work', 'review']) test(`an operator question raised under the ${under} after the fast-forward holds batch completion until it is answered`, t => {
  const f = fixture(t), m = f.lane('asked'), other = f.lane('other');
  let parent = m.item;
  if (under === 'review') {
    parent = f.recover(m, ['add', 'Review', '--role', 'reviewer', '--parent', m.item]).match(/^REV-\d+/)[0];
    f.recover(m, ['block', m.item, '--by', parent]);
    const report = path.join(f.root, 'review.md'), run = f.recover(m, ['start', parent, '--workspace', f.root, '--report', report]).match(/^R-\d+/)[0];
    fs.writeFileSync(report, `---\nrun: ${run}\noutcome: done\nverdict: PASS\nsummary: Review PASS\nheadline: Review PASS\n---\n`);
    f.record(['ingest', report]);
  }
  fs.writeFileSync(f.fault, 'refuse'); f.drain();
  assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 1);
  const question = f.recover(m, ['ask', 'Hold this?', '--parent', parent, '--category', 'security', '--recommend', 'no', '--why', 'Raised after the fast-forward', '--wait']).match(/^HUM-\d+/)[0];
  fs.unlinkSync(f.fault); f.drain();
  assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 1);
  for (const x of [m, other]) { assert.equal(f.show(x.item).closed, null); assert.ok(fs.existsSync(x.workspace)); }
  f.recover(m, ['answer', question, 'yes']); f.drain();
  assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  for (const x of [m, other]) assert.equal(f.show(x.item).closed.as, 'done');
});

for (const [blocking, resolved] of [[false, false], [true, false], [true, true]]) test(`ordinary promotion ${resolved ? 'completes with a resolved blocking' : blocking ? 'refuses a blocking' : 'completes with a non-blocking'} engineer report proposal`, t => {
  const f = fixture(t), m = f.lane('follow-up', false, { proposals: [{ role: 'engineer', title: 'Optional improvement', why: 'Separate follow-up', blocking }] });
  const child = f.events().find(e => e.type === 'item.added' && e.from_run === m.run);
  assert.ok(child); assert.equal(child.role, 'engineer'); assert.ok(m.job.id);
  assert.ok(f.queue.load().pending[0].admittedSeq >= child.seq);
  if (resolved) {
    // Report proposals require explicit selection before work can start.
    f.recover(m, ['set', child.id, 'meta.queue_selected=true']);
    const run = f.recover(m, ['start', child.id]).match(/^R-\d+/)[0], report = path.join(f.root, 'child-done.md');
    fs.writeFileSync(report, `---\nrun: ${run}\noutcome: done\nsummary: Follow-up complete\n---\n`);
    f.record(['ingest', report]);
  }
  const base = f.git(['rev-parse', 'main']); f.drain();
  const result = f.queue.load().results[0];
  const refused = blocking && !resolved;
  assert.equal(result.outcome, refused ? 'refused' : 'promoted', result.reason);
  assert.equal(f.show(child.id).closed, null);
  assert.equal(f.show(m.item).closed?.as ?? null, refused ? null : 'done');
  if (refused) assert.equal(f.git(['rev-parse', 'main']), base);
});

test('ordinary enqueue admits a non-blocking engineer child filed after intake but before admission', t => {
  const f = fixture(t), m = f.lane('supervised', false, { childBeforeAdmission: true });
  const child = f.events().find(e => e.type === 'item.added' && e.parent === m.item);
  assert.ok(child); assert.equal(child.from_run, undefined);
  assert.ok(child.seq > f.show(m.run).report.seq);
  assert.ok(child.seq <= f.queue.load().pending[0].admittedSeq);
  f.drain();
  assert.equal(f.queue.load().results[0].outcome, 'promoted');
  assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(f.show(child.id).closed, null);
});

test('an engineer child created after queue admission refuses before train capture', t => {
  const f = fixture(t), m = f.lane('guarded'), base = f.git(['rev-parse', 'main']);
  f.recover(m, ['add', 'New engineering scope', '--role', 'engineering', '--parent', m.item]);
  f.drain();
  assert.equal(f.queue.load().results[0].outcome, 'refused');
  assert.match(f.queue.load().results[0].reason, /open engineer children/);
  assert.equal(f.gates(), 0); assert.equal(f.git(['rev-parse', 'main']), base);
});

for (const change of ['engineer-child', 'dependency', 'question', 'hold', 'new-run', 'review-PASS'])
test(`final integration refuses a gate-time ${change} change`, t => {
  const f = fixture(t), m = f.lane('guarded'), base = f.git(['rev-parse', 'main']);
  const commands = [];
  if (change === 'engineer-child') commands.push(['add', 'Unfinished child', '--role', 'engineering', '--parent', m.item]);
  if (change === 'dependency') {
    const dependency = f.record(['add', 'Dependency', '--role', 'engineer']);
    f.record(['close', dependency]); f.recover(m, ['block', m.item, '--by', dependency]);
    commands.push(['reopen', dependency]);
  }
  if (change === 'question') commands.push(['ask', 'May this integrate?', '--parent', m.item, '--category', 'security', '--recommend', 'no', '--why', 'Changed during validation', '--wait']);
  if (change === 'new-run') commands.push(['start', m.item, '--workspace', m.workspace]);
  if (change === 'review-PASS') {
    const review = f.recover(m, ['add', 'Review', '--role', 'reviewer', '--parent', m.item]);
    const run = f.recover(m, ['start', review]).match(/^R-\d+/)[0], report = path.join(f.root, 'review.md');
    fs.writeFileSync(report, `---\nrun: ${run}\noutcome: done\nsummary: Reviewed\nverdict: PASS\n---\n`); f.record(['ingest', report]);
    commands.push(['reopen', review]);
  }
  let extra = '';
  if (change === 'hold') extra = `fs.mkdirSync(${JSON.stringify(path.join(f.repo, '.lane/supervisor'))},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(f.repo, '.lane/supervisor/STOP'))},'STOP');`;
  fs.appendFileSync(f.checker, `const cp=require('child_process');for(const args of ${JSON.stringify(commands)})cp.execFileSync(process.execPath,[${JSON.stringify(path.join(source, 'bin/org.mjs'))},...args],{env:{...process.env,ORG_DIR:${JSON.stringify(f.org)},ORG_GUARD_OVERRIDE:JSON.parse(fs.readFileSync(${JSON.stringify(f.queue.file)},'utf8')).current.id}});${extra}`);
  f.drain(); assert.equal(f.gates(), 1); assert.equal(f.git(['rev-parse', 'main']), base);
  const result = f.queue.load().results[0]; assert.equal(result.outcome, 'refused'); assert.equal(f.show(m.item).closed, null);
  if (change === 'engineer-child') assert.match(result.reason, /open engineer children/);
  assert.equal(f.events().some(e => e.type === 'promotion.reconciled'), false);
});
