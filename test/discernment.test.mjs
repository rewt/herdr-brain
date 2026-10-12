import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { categoryFlag, reportCategoryFlags, CATEGORY_CHECKLIST } from '../lib/discernment.mjs';
import { reportTemplate } from '../lib/report.mjs';
import { fold as oldFold, itemStatus as oldStatus } from './fixtures/state-v0.mjs';
import { setupOrg } from './helpers.mjs';

const config = { approvals: { default: 'ask', categories: { design: 'auto', tooling: 'auto', custom: null,
  security: 'ask', 'funds-and-chain': 'ask', publish: 'ask', 'delete-data': 'ask' } } };

test('auto items flag each risky signal, including case and inflections, without classifying the action', () => {
  for (const [text, signal] of [
    ['Rotate the API_KEY', 'keys'], ['Rotate privateKey', 'keys'], ['Use credentials', 'keys'], ['Change TLS PINS', 'pins'],
    ['Update pinned certificates', 'pins'], ['git push origin main', 'push'], ['Pushing the branch', 'push'],
    ['Publish the package', 'publish'], ['Deploying a release', 'publish'], ['Broadcast the transaction', 'broadcast'],
    ['Address vulnerabilities', 'vulnerability'], ['Fix CVE-2026-12345', 'vulnerability'],
    ['Delete the backup', 'deletion'], ['Deletion of history', 'deletion'], ['Remove the database', 'deletion'],
  ]) {
    assert.ok(categoryFlag(config, { category: 'design', text }, 'decision').signals.includes(signal), text);
  }
  for (const text of ['Refactor the local parser', 'Keyboard handling and pinpoint diagnostics', 'Use a linked list', 'Design a cache']) {
    assert.equal(categoryFlag(config, { category: 'tooling', text }, 'decision'), null, text);
  }
  for (const category of ['security', 'funds-and-chain', 'publish', 'delete-data']) {
    assert.equal(categoryFlag(config, { category, text: 'Keys pins push publish broadcast vulnerability deletion' }, 'question'), null);
  }
  assert.equal(categoryFlag(config, { text: 'Publish' }, 'question'), null);
  assert.equal(categoryFlag(config, { category: 'design', text: 'Publish' }, 'question', { wait: true }), null);
  const fallback = { approvals: { default: 'auto', categories: { custom: null } } };
  assert.ok(categoryFlag(fallback, { category: 'custom', why: 'Delete the backup' }, 'question'));
  assert.equal(categoryFlag(config, { category: 'design', memo: '/keys/publish.md', id: 'keys' }, 'question'), null);
});

test('report checks cover decisions and questions, all prose, legacy extras and newer normalized fields', () => {
  const fields = { decisions: [{ category: 'tooling', text: 'Update the local tool', why: 'It publishes artifacts' }],
    questions: [{ category: 'design', question: 'Use this relay?', on_yes: 'Broadcast transaction', wait: true },
      { category: 'publish', question: 'Push the branch?' }, { category: 'design', question: 'Refactor a parser?' }] };
  const expected = [{ category: 'tooling', source: 'decisions[0]', signals: ['publish'] },
    { category: 'design', source: 'questions[0]', signals: ['broadcast'] }];
  assert.deepEqual(reportCategoryFlags(config, fields), expected);
  assert.deepEqual(reportCategoryFlags(config, { extra: fields }), expected);
});

function record(t) {
  t.ok(['add', '--goal', 'A new project']);
  t.ok(['add', 'Improve the parser', '--role', 'engineer', '--parent', 'G-1']);
  // Project override; no external project or model is involved.
  const file = path.join(t.dir, 'config.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...original, approvals: config.approvals }));
}

test('ask flags but still auto-answers; explicit uncertainty waits and still blocks dependent work', t => {
  const r = setupOrg(); t.after(() => fs.rmSync(r.root, { recursive: true, force: true })); record(r);
  const ask = (title, extra = []) => ['ask', title, '--parent', 'G-1', '--category', 'design', '--recommend', 'yes', '--why', 'Use the recommended approach', ...extra];
  const result = r.org(ask('Push the branch?'));
  assert.equal(result.code, 0); assert.equal(result.out, 'HUM-1\n');
  assert.match(result.err, /Category review.*push/);
  assert.equal(r.json(['show', 'HUM-1', '--json']).status, 'done');
  r.ok(ask('Refactor the parser?'));
  r.ok(ask('Rotate keys?', ['--wait', '--blocks', 'ENG-1']), { env: { ORG_ACTOR: 'worker' } });
  assert.equal(r.json(['show', 'HUM-3', '--json']).meta.answer, undefined);
  assert.equal(r.json(['show', 'ENG-1', '--json']).status, 'blocked');
  const memo = path.join(r.root, 'rationale.md'); fs.writeFileSync(memo, 'Changes a trust pin.');
  r.ok(ask('Use this tool?', ['--memo', memo]));
  assert.deepEqual(r.events().filter(e => e.type === 'category.flagged').map(e => e.signals), [['push'], ['pins']]);
  assert.match(r.ok(['status']), /HUM-1.*Category review/);
  assert.equal(r.json(['today', '--json']).attention.filter(a => a.kind === 'category').length, 2);
});

test('ingest durably flags miscategorized report fixtures, keeps outcome, and is idempotent and backwards compatible', t => {
  const r = setupOrg(); t.after(() => fs.rmSync(r.root, { recursive: true, force: true })); record(r);
  const file = path.join(r.root, 'report.md');
  r.ok(['start', 'ENG-1', '--harness', 'offline', '--model', 'none', '--report', file]);
  fs.writeFileSync(file, `---\n${JSON.stringify({ run: 'R-1', outcome: 'done', summary: 'Completed local work', headline: 'Local work is complete.',
    decisions: [{ category: 'design', text: 'Update pins' }, { category: 'security', text: 'Handle keys' }, { category: 'tooling', text: 'Refactor a parser' }],
    questions: [{ category: 'tooling', question: 'Delete the old backup?', recommend: 'yes' }, { category: 'publish', question: 'Publish?' }] })}\n---\nDetails mention keys; narrative is not structured authority.\n`);
  const before = r.events().length;
  assert.match(r.ok(['check', file]), /^ok:/); assert.equal(r.events().length, before);
  assert.match(r.ok(['ingest', file]), /warning: Category review/);
  const events = r.events();
  const flags = events.filter(e => e.type === 'category.flagged');
  assert.deepEqual(flags.map(e => [e.run, e.id, e.source, e.signals]), [
    ['R-1', 'ENG-1', 'decisions[0]', ['pins']], ['R-1', 'ENG-1', 'questions[0]', ['deletion']] ]);
  assert.ok(flags.every(e => e.by === 'run:R-1'));
  assert.equal(r.json(['show', 'ENG-1', '--json']).status, 'done');
  assert.match(r.ok(['status']), /ENG-1.*R-1 decisions\[0\].*pins/);
  assert.equal(r.json(['status', '--json']).attention.filter(a => a.kind === 'category').length, 2);
  assert.match(r.ok(['ingest', file]), /already recorded/); assert.equal(r.events().length, events.length);
  assert.equal(oldStatus(oldFold(events), 'ENG-1'), 'done');
  assert.ok(events.every(e => e.status === undefined));
});

test('guidance is shared in report templates and CLI question help', t => {
  const r = setupOrg(); t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  const template = reportTemplate('R-1'); const help = r.ok(['help']);
  for (const text of [template.replaceAll('\n# ', '\n'), help, r.ok(['ask', '--help'])]) {
    assert.ok(text.includes(CATEGORY_CHECKLIST)); assert.match(text, /When unsure, pause/); assert.match(text, /--wait/);
  }
  assert.ok(template.indexOf('artifacts:') < template.indexOf('decisions:'));
  assert.ok(template.indexOf('decisions:') < template.indexOf('questions:'));
  assert.ok(template.indexOf('questions:') < template.indexOf('challenges:'));
});
