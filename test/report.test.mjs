import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYamlSubset, readReport, reportTemplate } from '../lib/report.mjs';

test('parses the envelope shapes reports use', () => {
  const data = parseYamlSubset(`run: R-4
outcome: blocked   # a trailing comment
summary: |
  Two lines
  of summary.

  After a blank line.
blockers:
  - Storage backend undecided
  - "quoted: text"
proposals:
  - role: architect
    title: Decide storage #42
    why: >
      folded
      text
    accept: [survives restart, 'no data loss']
  - researcher: Benchmark sqlite against redis
learnings: []
usage:
  tokens_in: 12000
`);
  assert.deepEqual(data, {
    run: 'R-4',
    outcome: 'blocked',
    summary: 'Two lines\nof summary.\n\nAfter a blank line.',
    blockers: ['Storage backend undecided', 'quoted: text'],
    proposals: [
      { role: 'architect', title: 'Decide storage #42', why: 'folded text', accept: ['survives restart', 'no data loss'] },
      { researcher: 'Benchmark sqlite against redis' },
    ],
    learnings: [],
    usage: { tokens_in: 12000 },
  });
});

test('the brief template becomes a valid report once outcome, summary and headline are filled in', () => {
  const blank = readReport(reportTemplate('R-1'));
  assert.match(blank.errors.join('\n'), /outcome is required/);
  const filled = reportTemplate('R-1')
    .replace('outcome:            #', 'outcome: done #')
    .replace('(what you did and where things stand, in a few sentences)', 'Implemented it.')
    .replace(/^headline:.*$/m, 'headline: It works');
  const r = readReport(filled);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.report.run, 'R-1');
  assert.equal(r.report.outcome, 'done');
  assert.equal(r.report.summary, 'Implemented it.');
  assert.equal(r.report.headline, 'It works');
  assert.deepEqual(r.report.proposals, []);
  assert.equal(r.body, '(free-form details: evidence, dead ends, anything worth keeping)');
});

test('accepts lenient input and keeps unknown fields', () => {
  const r = readReport(`\`\`\`markdown
---
run: R-2
outcome: Needs-Human
summary: Need a decision.
blockers:
  - Budget: who pays for the GPU time
proposals:
  - architect: Pick a queue
  - title: Untyped follow-up
confidence: medium
---
Body text.
\`\`\``);
  assert.deepEqual(r.errors, []);
  assert.equal(r.report.outcome, 'needs_human');
  assert.deepEqual(r.report.blockers, ['Budget: who pays for the GPU time']);
  assert.deepEqual(r.report.proposals, [{ role: 'architect', title: 'Pick a queue' }, { title: 'Untyped follow-up' }]);
  assert.deepEqual(r.report.extra, { confidence: 'medium' });
  assert.match(r.warnings.join('\n'), /has no role/);
  assert.equal(r.body, 'Body text.');
});

test('explains problems precisely instead of guessing', () => {
  assert.match(readReport('no front matter here').errors[0], /must start with a front matter/);
  assert.match(readReport('---\noutcome: done\n').errors[0], /not closed/);
  assert.match(readReport('---\noutcome: done\nsummary: ok\n  stray: indent\n---\n').errors[0], /line 4: unexpected indentation/);
  assert.match(readReport('---\noutcome: finished\nsummary: x\n---\n').errors[0], /must be one of/);
  assert.match(readReport('---\noutcome: blocked\nsummary: x\nproposals:\n  - why: no title\n---\n').errors.join('\n'), /needs a title/);
  assert.match(readReport('---\noutcome: blocked\nsummary: x\n---\n').warnings.join('\n'), /no blockers or proposals/);
});
