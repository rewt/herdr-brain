import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { report, setupOrg } from './helpers.mjs';
import { fold as foldV0, itemStatus as statusV0 } from './fixtures/state-v0.mjs';
import { readReport, reportTemplate } from '../lib/report.mjs';

function withWork() {
  const t = setupOrg();
  t.ok(['add', '--goal', 'Theft fix shipped']);
  t.ok(['add', 'Implement the theft fix', '--parent', 'G-1', '--role', 'engineer', '--priority', '50']);
  t.ok(['add', 'Review the theft fix', '--parent', 'G-1', '--role', 'reviewer', '--priority', '40']);
  t.ok(['block', 'REV-1', '--by', 'ENG-1']);
  const memo = path.join(t.root, 'DECISION-THEFT.md');
  fs.writeFileSync(memo, '# Theft fix\n\nO1 is the only option where the network refuses the theft.\n');
  return { ...t, memo };
}

const ASK = (memo, extra = []) => ['ask', 'Adopt the theft fix once its review passes?', '--parent', 'G-1',
  '--category', 'design', '--recommend', 'yes', '--why', 'O1 is the only option where the network refuses the theft. The review passed.',
  '--on-yes', 'Implementation starts.', '--on-no', 'The fix path stops.', '--memo', memo, '--blocks', 'ENG-1', ...extra];

test('org ask records a question, its reason and its blocking links in one transaction', () => {
  const t = withWork();
  const before = t.events().length;
  assert.equal(t.ok(ASK(t.memo, ['--priority', '70'])).trim(), 'HUM-1');
  const added = t.events().slice(before);
  assert.deepEqual(added.map((e) => e.type), ['item.added', 'note.added', 'link.added']);
  assert.equal(new Set(added.map((e) => e.seq)).size, 3);
  assert.equal(new Set(added.map((e) => e.at)).size, 1);
  const item = t.json(['show', 'HUM-1', '--json']);
  assert.equal(item.role, 'human');
  assert.equal(item.parent, 'G-1');
  assert.equal(item.priority, 70);
  assert.deepEqual(item.meta, {
    category: 'design', recommend: 'yes', memo: t.memo, on_yes: 'Implementation starts.', on_no: 'The fix path stops.',
  });
  assert.match(item.notes[0].text, /network refuses the theft/);
  assert.deepEqual(item.blocks, ['ENG-1']);
  assert.match(t.ok(['status']), /BLOCKED\n\s+ENG-1 .*← HUM-1 ready/);
});

test('org ask refuses what would hand the operator an unusable question', () => {
  const t = withWork();
  const base = ['ask', 'Ship it?', '--parent', 'G-1', '--why', 'Because.'];
  assert.match(t.fail([...base, '--category', 'design']), /--recommend is required/);
  assert.match(t.fail([...base, '--category', 'weather', '--recommend', 'yes']), /unknown category "weather".*known: design, security, funds-and-chain/);
  assert.match(t.fail([...base, '--recommend', 'yes']), /--category is required/);
  assert.match(t.fail([...base, '--category', 'design', '--recommend', 'yes', '--memo', path.join(t.root, 'missing.md')]), /memo .*missing\.md does not exist/);
  // A memo must be a regular file: the console opens it, so a directory or app bundle is refused.
  fs.mkdirSync(path.join(t.root, 'Tool.app'));
  assert.match(t.fail([...base, '--category', 'design', '--recommend', 'yes', '--memo', path.join(t.root, 'Tool.app')]), /memo .*Tool\.app is not a regular file/);
  assert.match(t.fail([...base, '--category', 'design', '--recommend', 'yes', '--blocks', 'NOPE-1']), /unknown item NOPE-1/);
  assert.match(t.fail(['ask', 'Ship it?', '--category', 'design', '--recommend', 'yes', '--why', 'x']), /--parent is required/);
  assert.match(t.fail(['ask', 'Ship it?', '--parent', 'G-1', '--category', 'design', '--recommend', 'yes']), /--why is required/);
  // A configured category is accepted even when the defaults do not know it.
  const config = JSON.parse(fs.readFileSync(path.join(t.dir, 'config.json'), 'utf8'));
  config.approvals = { categories: { weather: 'ask' } };
  fs.writeFileSync(path.join(t.dir, 'config.json'), JSON.stringify(config));
  assert.equal(t.ok([...base, '--category', 'weather', '--recommend', 'yes']).trim(), 'HUM-1');
  assert.equal(t.events().filter((e) => e.type === 'item.added' && e.role === 'human').length, 1);
});

test('answering yes releases the blocked work', () => {
  const t = withWork();
  t.ok(ASK(t.memo));
  const out = t.ok(['answer', 'HUM-1', 'yes', '--note', 'Go ahead.'], { now: '2026-09-15T10:00:00Z' });
  assert.match(out, /HUM-1 answered yes/);
  assert.match(out, /ENG-1 is no longer blocked by HUM-1 \(now ready\)/);
  const item = t.json(['show', 'HUM-1', '--json']);
  assert.equal(item.status, 'done');
  assert.equal(item.meta.answer, 'yes');
  assert.equal(item.meta.answered_by, 'human');
  const decision = item.notes.find((n) => n.decision);
  assert.match(decision.text, /yes.*Go ahead\./);
  assert.equal(decision.by, 'human');
  assert.match(t.fail(['answer', 'HUM-1', 'no']), /already answered yes .*--overrule/);
});

test('a declined question keeps its dependents blocked until the work is re-planned', () => {
  const t = withWork();
  t.ok(ASK(t.memo));
  const out = t.ok(['answer', 'HUM-1', 'No', '--note', 'Too risky.']);
  assert.match(out, /HUM-1 answered no/);
  assert.match(out, /ENG-1 stays blocked: declined/);
  assert.equal(t.json(['show', 'HUM-1', '--json']).meta.answer, 'no');
  assert.equal(t.json(['show', 'ENG-1', '--json']).status, 'blocked');
  assert.equal(t.json(['show', 'REV-1', '--json']).status, 'blocked');
  assert.match(t.ok(['status']), /ENG-1 .*declined: Adopt the theft fix once its review passes\?/);
  assert.match(t.ok(['show', 'ENG-1']), /blocked by: HUM-1 \(declined \(answered no\)\)/);
  // The brief of a run started anyway names the decline too.
  t.ok(['block', 'REV-1', '--by', 'HUM-1']);
  t.ok(['start', 'REV-1']);
  const brief = fs.readFileSync(path.join(t.dir, 'runs/R-1/brief.md'), 'utf8');
  assert.match(brief, /### Blockers\n(?:- .*\n(?: {2}- .*\n)*)*- \*\*HUM-1\*\* Adopt the theft fix once its review passes\? — declined \(answered no\)/);
  t.ok(['unblock', 'ENG-1', '--by', 'HUM-1']);
  assert.equal(t.json(['show', 'ENG-1', '--json']).status, 'ready');
});

test('a decline says so truthfully for a dependent that is already running', () => {
  const t = withWork();
  t.ok(ASK(t.memo));
  t.ok(['block', 'REV-1', '--by', 'HUM-1']);
  t.ok(['start', 'ENG-1']);
  const out = t.ok(['answer', 'HUM-1', 'no']);
  assert.match(out, /ENG-1 is already running \(R-1\); the decline does not stop it/);
  assert.doesNotMatch(out, /ENG-1 stays blocked/);
  assert.equal(t.json(['show', 'ENG-1', '--json']).status, 'active');
  assert.match(out, /REV-1 stays blocked: declined/);
  assert.equal(t.json(['show', 'REV-1', '--json']).status, 'blocked');
  const decided = t.json(['today', '--json']).decided.find((d) => d.id === 'HUM-1');
  assert.deepEqual(decided.blocks.map((b) => [b.id, b.status, b.open_runs]), [['ENG-1', 'active', ['R-1']], ['REV-1', 'blocked', []]]);
});

test('a decline says so truthfully for a dependent that is already closed', () => {
  const t = withWork();
  t.ok(ASK(t.memo));
  t.ok(['block', 'REV-1', '--by', 'HUM-1']);
  t.ok(['close', 'ENG-1']);
  t.ok(['close', 'REV-1', '--dropped']);
  const out = t.ok(['answer', 'HUM-1', 'no']);
  assert.match(out, /ENG-1 is already closed \(done\); the decline does not reopen it/);
  assert.match(out, /REV-1 is already closed \(dropped\); the decline does not reopen it/);
  assert.doesNotMatch(out, /stays blocked/);
  assert.equal(t.json(['show', 'ENG-1', '--json']).status, 'done');
  assert.equal(t.json(['show', 'REV-1', '--json']).status, 'dropped');
  const decided = t.json(['today', '--json']).decided.find((d) => d.id === 'HUM-1');
  assert.deepEqual(decided.blocks.map((b) => [b.id, b.status, b.open_runs]), [['ENG-1', 'done', []], ['REV-1', 'dropped', []]]);
});

test('a reply that starts with yes or no is that answer, and the rest is kept as the note', () => {
  for (const [reply, answer, note] of [
    ['No.', 'no', null],
    ['no, not yet', 'no', 'not yet'],
    ['NO - wait for the freeze', 'no', 'wait for the freeze'],
    ['Yes!', 'yes', null],
    ['yes: ship it', 'yes', 'ship it'],
    ['nothing yet', 'nothing yet', null],
    ['yesterday\'s build', 'yesterday\'s build', null],
  ]) {
    const t = withWork();
    t.ok(ASK(t.memo));
    t.ok(['answer', 'HUM-1', reply, '--note', 'Operator.']);
    const item = t.json(['show', 'HUM-1', '--json']);
    assert.equal(item.meta.answer, answer, reply);
    assert.equal(item.closed.note, [note, 'Operator.'].filter(Boolean).join('; '), reply);
    assert.equal(t.json(['show', 'ENG-1', '--json']).status, answer === 'no' ? 'blocked' : 'ready', reply);
  }
  const t = withWork();
  assert.match(t.fail(ASK(t.memo).map((a) => (a === 'yes' ? 'yes, after review' : a))), /--recommend should be just yes/);
  t.ok(ASK(t.memo).map((a) => (a === 'yes' ? 'Yes.' : a)));
  assert.equal(t.json(['show', 'HUM-1', '--json']).meta.recommend, 'yes');
});

test('a text answer releases the blocked work like yes', () => {
  const t = withWork();
  t.ok(['ask', 'Which relay should the test use?', '--parent', 'G-1', '--category', 'other', '--recommend', 'the public one',
    '--why', 'It is the only one online.', '--blocks', 'ENG-1']);
  t.ok(['answer', 'HUM-1', 'the private relay']);
  assert.equal(t.json(['show', 'HUM-1', '--json']).meta.answer, 'the private relay');
  assert.equal(t.json(['show', 'ENG-1', '--json']).status, 'ready');
  assert.match(t.fail(['answer', 'ENG-1', 'yes']), /ENG-1 is not a question/);
  assert.match(t.fail(['answer', 'HUM-1', ' ']), /an answer is required/);
});

test('an auto category answers at once and the operator can still overrule it', () => {
  const t = withWork();
  const config = JSON.parse(fs.readFileSync(path.join(t.dir, 'config.json'), 'utf8'));
  config.approvals = { default: 'ask', categories: { tooling: 'auto' } };
  fs.writeFileSync(path.join(t.dir, 'config.json'), JSON.stringify(config));
  const r = t.org(['ask', 'Install storage tool v0.3 now?', '--parent', 'G-1', '--category', 'tooling', '--recommend', 'yes',
    '--why', 'It fixes the crash.', '--blocks', 'ENG-1'], { env: { ORG_ACTOR: 'exec-1610' } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'HUM-1');
  assert.match(r.err, /answered yes automatically \(tooling is auto\)/);
  let item = t.json(['show', 'HUM-1', '--json']);
  assert.equal(item.status, 'done');
  assert.equal(item.meta.answer, 'yes');
  assert.equal(item.meta.answered_by, 'auto');
  assert.equal(item.notes.find((n) => n.decision).by, 'exec-1610');
  assert.equal(t.json(['show', 'ENG-1', '--json']).status, 'ready');
  // Design stays "ask": the configured file only relaxed tooling.
  t.ok(['ask', 'Adopt it?', '--parent', 'G-1', '--category', 'design', '--recommend', 'yes', '--why', 'x']);
  assert.equal(t.json(['show', 'HUM-2', '--json']).status, 'ready');

  assert.match(t.fail(['answer', 'HUM-2', 'no', '--overrule']), /HUM-2 has not been answered; nothing to overrule/);
  assert.match(t.fail(['answer', 'HUM-1', 'Yes', '--overrule']), /HUM-1 is already answered yes; an overrule must change the answer/);
  assert.equal(t.json(['show', 'HUM-1', '--json']).meta.overruled, undefined, 'a refused overrule records nothing');
  t.ok(['answer', 'HUM-1', 'no', '--overrule', '--note', 'Not before the freeze.']);
  item = t.json(['show', 'HUM-1', '--json']);
  assert.equal(item.status, 'done');
  assert.equal(item.meta.answer, 'no');
  assert.equal(item.meta.answered_by, 'human');
  assert.equal(item.meta.overruled, true);
  assert.equal(t.json(['show', 'ENG-1', '--json']).status, 'blocked');
});

test('decision notes can carry a plain summary', () => {
  const t = withWork();
  t.ok(['note', 'ENG-1', '--decision', '--summary', 'Leave the exposed test cells alone until the fix lands', 'Per DECISION-X-20260916 (a1b2c3d4e5)']);
  const note = t.json(['show', 'ENG-1', '--json']).notes[0];
  assert.equal(note.summary, 'Leave the exposed test cells alone until the fix lands');
  assert.equal(note.text, 'Per DECISION-X-20260916 (a1b2c3d4e5)');
  assert.match(t.fail(['note', 'ENG-1', 'plain', '--summary', 'x']), /--summary needs --decision/);
});

test('reports carry an optional headline and missing ones only warn', () => {
  const template = reportTemplate('R-1');
  assert.match(template, /summary: \|[\s\S]*\nheadline: .*# one plain sentence/);
  const filled = template.replace('outcome:            #', 'outcome: done #')
    .replace('(what you did and where things stand, in a few sentences)', 'Implemented it.');
  const without = readReport(filled);
  assert.deepEqual(without.errors, []);
  assert.match(without.warnings.join('\n'), /headline is missing/);
  const withHeadline = readReport(filled.replace(/^headline:.*$/m, 'headline: The storage tool review needs work'));
  assert.deepEqual(withHeadline.warnings, []);
  assert.equal(withHeadline.report.headline, 'The storage tool review needs work');

  const t = withWork();
  t.ok(['start', 'ENG-1']);
  const file = path.join(t.dir, 'runs/R-1/report.md');
  assert.match(fs.readFileSync(path.join(t.dir, 'runs/R-1/brief.md'), 'utf8'), /headline/);
  fs.writeFileSync(file, report('run: R-1\noutcome: done\nsummary: Done.'));
  const checked = t.org(['check', file]);
  assert.equal(checked.code, 0);
  assert.match(checked.err, /warning: headline is missing/);
  fs.writeFileSync(file, report('run: R-1\noutcome: done\nsummary: Done.\nheadline: The fix works'));
  t.ok(['sync']);
  assert.equal(t.json(['show', 'R-1', '--json']).report.headline, 'The fix works');
});

test('older folds ignore the new fields', () => {
  const t = withWork();
  t.ok(ASK(t.memo));
  t.ok(['note', 'ENG-1', '--decision', '--summary', 'Plain', 'Detail']);
  t.ok(['answer', 'HUM-1', 'yes']);
  const s = foldV0(t.events());
  assert.equal(statusV0(s, 'HUM-1'), 'done');
  assert.equal(statusV0(s, 'ENG-1'), 'ready');
  assert.equal(s.items.get('HUM-1').meta.answer, 'yes');
});

test('an older fold treats a "no" as resolved and releases the dependents', () => {
  // This is why every org on PATH must be updated before the first "no" answer (spec, Cutover).
  const t = withWork();
  t.ok(ASK(t.memo));
  t.ok(['answer', 'HUM-1', 'no']);
  const s = foldV0(t.events());
  assert.equal(statusV0(s, 'HUM-1'), 'done');
  assert.equal(statusV0(s, 'ENG-1'), 'ready');
  assert.equal(t.json(['show', 'ENG-1', '--json']).status, 'blocked');
});
