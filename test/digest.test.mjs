import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { report, setupOrg } from './helpers.mjs';

const OLD = '2026-10-06T08:00:00Z';
const MORNING = '2026-10-07T08:00:00Z';
const NOW = '2026-10-07T12:00:00Z';
const at = now => ({ now });
function fixture(t) {
  const f = setupOrg();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const file = path.join(f.dir, 'supervisor/inbox.log');
  const journal = (...events) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, events.map(e => JSON.stringify(e) + '\n').join(''));
  };
  const notice = (id, message, time = MORNING) => journal({ type: 'notice', id, at: time, message });
  const finish = (run, outcome = 'done', time = MORNING, extra = '') => {
    const target = path.join(f.dir, `runs/${run}/report.md`);
    fs.writeFileSync(target, report(`run: ${run}\noutcome: ${outcome}\nsummary: Work complete\nheadline: The recorded headline\n${extra}`));
    f.ok(['ingest', target], at(time));
  };
  const read = (args = []) => f.json(['digest', '--json', ...args], at(NOW));
  return { ...f, file, journal, notice, finish, read };
}

test('digest combines recorded reports, promotion outcomes and decisions without equating done with landed', t => {
  const f = fixture(t);
  f.ok(['add', 'Build the chat', '--role', 'engineer'], at(OLD));
  f.ok(['start', 'ENG-1'], at(OLD));
  f.finish('R-1', 'done', MORNING, 'decisions:\n  - text: Use the durable journal\n    category: design\n    why: Keep reads deterministic');
  f.ok(['note', 'R-1', 'Technical detail', '--decision', '--summary', 'Keep the chat quiet'], at(MORNING));
  f.ok(['note', 'ENG-1', 'Ignore this ordinary note'], at(MORNING));
  f.ok(['note', 'ENG-1', 'Old decision', '--decision'], at(OLD));
  f.notice('report', '[org-report] run=R-1 item=ENG-1 outcome=done headline="Notice headline" check=pass');
  f.notice('landed', '[promote-queue] id=j1 lane=chat outcome=promoted reason="green fast-forward"');
  f.notice('refused', '[promote-queue] id=j2 lane=other outcome=refused reason="red check with \\"quotes\\""');
  f.journal({ type: 'sent', id: 'landed', at: NOW }, { type: 'autopilot', id: 'refused', at: NOW, result: { disposition: 'handled' } });
  f.notice('irrelevant', '[unrelated] lane=other outcome=promoted');
  const doc = f.read(['--since', '4h']);
  assert.deepEqual(doc.promotions.map(p => [p.lane, p.outcome]), [['chat', 'promoted'], ['other', 'refused']]);
  assert.equal(doc.promotions[1].reason, 'red check with "quotes"');
  assert.deepEqual(doc.reports.map(r => [r.run, r.item, r.outcome, r.headline, r.check, r.recorded]),
    [['R-1', 'ENG-1', 'done', 'The recorded headline', 'pass', true]]);
  assert.deepEqual(doc.decisions.map(d => d.summary || d.text).sort(), ['Keep the chat quiet', 'Use the durable journal']);
  assert.equal(doc.decisions.find(d => d.summary).text, 'Technical detail', 'JSON keeps the full decision behind its summary');
  assert.deepEqual(doc.blocked, []);
  assert.equal(f.read(['--since', NOW]).promotions.length, 0, 'delivery time is not a new promotion');
  assert.equal(f.read(['--since', '09:00']).reports.length, 0);
  assert.equal(f.read(['--since', MORNING]).reports.length, 1, 'absolute time boundary is inclusive');
});

test('digest keeps old open questions and current blocked sessions, then drops resolved and superseded blocks', t => {
  const f = fixture(t);
  f.ok(['add', '--goal', 'Chat project'], at(OLD));
  f.ok(['ask', 'Publish?', '--parent', 'G-1', '--category', 'publish', '--recommend', 'no', '--why', 'Needs review', '--wait'], at(OLD));
  for (let n = 1; n <= 5; n++) {
    f.ok(['add', `Task ${n}`, '--role', 'engineer'], at(OLD));
    f.ok(['start', `ENG-${n}`], at(OLD));
    f.notice(`block${n}`, `[watch-blocked] run=R-${n} item=ENG-${n} worker=worker-${n}`, OLD);
  }
  f.finish('R-2', 'done'); // final report clears a prompt block
  f.ok(['abandon', 'R-3'], at(MORNING));
  f.ok(['close', 'ENG-4'], at(MORNING));
  f.finish('R-5', 'blocked', MORNING, 'blockers: [Waiting for access]');
  const doc = f.read(['--since', NOW]);
  assert.deepEqual(doc.questions.map(q => [q.id, q.recommend, q.why]), [['HUM-1', 'no', 'Needs review']]);
  assert.deepEqual(doc.blocked.map(b => [b.run, b.source, b.reason]),
    [['R-5', 'record', 'Waiting for access'], ['R-1', 'inbox', `Watch reported a prompt block at ${OLD}`]]);
  const text = f.ok(['digest', '--since', NOW], at(NOW));
  assert.match(text, /Watch reported a prompt block at 08:00 UTC/);
  assert.doesNotMatch(text, /Worker is blocked/);
  assert.equal(doc.reports.length, 0, 'old outstanding facts are distinct from new reports');
  f.ok(['answer', 'HUM-1', 'yes'], at(NOW));
  f.ok(['start', 'ENG-5'], at(NOW)); // replacement run hides R-5's unresolved report
  f.notice('working', '[watch-long-running] run=R-1 item=ENG-1 worker=worker-1 still-running=10', NOW);
  const updated = f.read(['--since', NOW]);
  assert.deepEqual(updated.questions, []);
  assert.deepEqual(updated.blocked, []);
  assert.match(updated.decisions[0].text, /Answered yes/);
});

test('digest reports awaiting ingestion and late checks explicitly, never invents a check', t => {
  const f = fixture(t);
  f.ok(['add', 'Build', '--role', 'engineer'], at(OLD));
  f.ok(['start', 'ENG-1'], at(OLD));
  f.finish('R-1', 'done', OLD);
  const initial = f.read();
  assert.equal(initial.reports.length, 0);
  f.notice('check', '[org-report] run=R-1 item=ENG-1 outcome=done check=pass');
  f.notice('waiting', '[org-report] run=R-2 item=ENG-2 outcome=failed headline="Worker failed" check=fail');
  const updated = f.read(['--after', initial.cursor]);
  assert.deepEqual(updated.reports.map(r => [r.run, r.check, r.recorded]), [['R-1', 'pass', true], ['R-2', 'fail', false]]);
  assert.equal(updated.reports[0].headline, 'The recorded headline');
  f.ok(['start', 'ENG-1'], at(NOW));
  f.finish('R-2', 'done', NOW);
  const noCheck = f.read(['--since', NOW]);
  assert.equal(noCheck.reports[0].check, 'unknown', 'a mismatched item cannot provide check evidence');
});

test('digest selects blocked sessions by current report outcome, independent of dependency status', t => {
  const f = fixture(t);
  f.ok(['add', 'Dependency', '--role', 'engineer'], at(OLD));
  for (let n = 2; n <= 4; n++) {
    f.ok(['add', `Task ${n}`, '--role', 'engineer', '--blocked-by', 'ENG-1'], at(OLD));
    f.ok(['start', `ENG-${n}`], at(OLD));
  }
  f.finish('R-1', 'done');
  f.ok(['reopen', 'ENG-2'], at(MORNING));
  f.finish('R-2', 'needs_human');
  f.finish('R-3', 'blocked');
  assert.equal(f.json(['show', 'ENG-2', '--json']).status, 'blocked', 'the done run belongs to a link-blocked item');
  assert.deepEqual(f.read().blocked.map(b => [b.run, b.status]), [['R-2', 'needs_human'], ['R-3', 'blocked']]);
  f.ok(['close', 'ENG-1'], at(NOW));
  assert.equal(f.json(['show', 'ENG-4', '--json']).status, 'ready', 'resolved links affect item status');
  assert.deepEqual(f.read().blocked.map(b => [b.run, b.status]), [['R-2', 'needs_human'], ['R-3', 'blocked']],
    'the reports remain recorded evidence until replaced or closed');
});

test('digest summarizes decisions and counts autopilot bookkeeping while JSON retains all evidence', t => {
  const f = fixture(t);
  f.ok(['add', 'Task', '--role', 'engineer'], at(OLD));
  f.ok(['start', 'ENG-1'], at(OLD));
  const hash = 'a'.repeat(40);
  const settle = `Settle: escalate. The reviewer has unverified claims. Review round cap: 1 (project). Reviewed ${hash}; evidence /record/settle/R-1.json`;
  const promotion = `Queue promotion of chat at ${hash}: notice-autopilot/v1: PASS promotes. Reviewed ${hash}.`;
  for (let n = 0; n < 10; n++) f.ok(['note', 'R-1', settle, '--decision'],
    { now: MORNING, env: { ORG_ACTOR: 'supervisor-autopilot' } });
  f.ok(['note', 'R-1', promotion, '--decision', '--summary',
    'Promotion authorized: notice-autopilot/v1: PASS promotes; project tooling authority is auto; settle and queue recheck readiness'],
    { now: MORNING, env: { ORG_ACTOR: 'supervisor-autopilot' } });
  f.ok(['note', 'ENG-1', `Use commit ${hash}. Additional evidence stays in JSON.`, '--decision'], at(MORNING));
  f.ok(['note', 'ENG-1', 'Full reasoning. More details.', '--decision', '--summary',
    'Keep the chat quiet. Additional summary detail.'], at(MORNING));
  f.ok(['note', 'ENG-1', 'Operator judgment is required. Full reasons.', '--decision'],
    { now: MORNING, env: { ORG_ACTOR: 'supervisor-autopilot' } });
  f.ok(['note', 'R-1', settle, '--decision'], { now: MORNING, env: { ORG_ACTOR: 'supervisor' } });
  f.finish('R-1', 'done', MORNING,
    'decisions:\n  - text: Full report reasoning. More evidence.\n    summary: Use the durable journal. Keep other details in JSON.\n    category: design\n    why: Deterministic reads');
  const doc = f.read();
  assert.equal(doc.decisions.length, 16);
  assert.equal(doc.decisions.filter(d => d.text === settle).length, 11);
  assert.equal(doc.decisions.find(d => d.text === promotion).summary.startsWith('Promotion authorized:'), true);
  assert.equal(doc.decisions.find(d => d.category === 'design').text, 'Full report reasoning. More evidence.');
  assert.equal(doc.decisions.find(d => d.summary?.startsWith('Keep the chat')).text, 'Full reasoning. More details.');
  const text = f.ok(['digest', '--width', '72'], at(NOW));
  assert.match(text, /DECISIONS \(16\)/);
  assert.match(text, /10 settle escalate/);
  assert.match(text, /1 promotion authorized/);
  assert.equal(text.match(/Settle: escalate\./g)?.length, 1, 'a supervisor decision is still individual');
  for (const sentence of ['Keep the chat quiet.', 'Use the durable journal.', 'Operator judgment is required.', `Use commit ${hash.slice(0, 8)}.`]) assert.ok(text.includes(sentence));
  assert.doesNotMatch(text, /Additional|More evidence|Full report|Review round cap|unverified claims|notice-autopilot|\/record\/settle|a{40}/);
  const limited = f.ok(['digest', '--limit', '1', '--width', '40'], at(NOW));
  assert.match(limited, /4 more; --json has all facts/);
  assert.match(limited, /Autopilot bookkeeping/);
  assert.ok(limited.split('\n').every(line => [...line].length <= 40));
});

test('chat cursor includes same-time and backdated appends, rejects another project and rotated sources, and writes nothing', t => {
  const f = fixture(t);
  f.ok(['add', 'Task', '--role', 'engineer'], at(OLD));
  f.notice('old', '[promote-queue] id=old lane=old outcome=promoted', OLD);
  const files = () => fs.readdirSync(f.dir, { recursive: true }).sort();
  const beforeFiles = files();
  const eventsBefore = fs.readFileSync(path.join(f.dir, 'events.jsonl'));
  const inboxBefore = fs.readFileSync(f.file);
  const first = f.read();
  assert.deepEqual(f.read(), first, 'the cursor and facts are deterministic');
  assert.deepEqual(files(), beforeFiles);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.jsonl')), eventsBefore);
  assert.deepEqual(fs.readFileSync(f.file), inboxBefore);
  f.ok(['note', 'ENG-1', 'Backdated decision', '--decision'], at(OLD));
  f.notice('late', '[promote-queue] id=late lane=late outcome=refused reason="late write"', OLD);
  f.ok(['note', 'ENG-1', 'Same-time decision', '--decision'], at(NOW));
  f.notice('same', '[promote-queue] id=same lane=same outcome=promoted', NOW);
  const second = f.read(['--after', first.cursor]);
  assert.deepEqual(second.decisions.map(d => d.text), ['Same-time decision', 'Backdated decision']);
  assert.deepEqual(second.promotions.map(p => p.lane), ['same', 'late']);
  const third = f.read(['--after', second.cursor]);
  assert.deepEqual(third.promotions, []);
  assert.deepEqual(third.decisions, []);
  const foreign = JSON.parse(Buffer.from(first.cursor, 'base64url').toString('utf8'));
  foreign.org = path.join(f.root, 'another-project');
  const foreignCursor = Buffer.from(JSON.stringify(foreign)).toString('base64url');
  assert.match(f.fail(['digest', '--after', foreignCursor]), /invalid digest cursor/);
  const symlink = path.join(f.root, 'record-alias');
  fs.symlinkSync(f.dir, symlink);
  assert.equal(f.json(['digest', '--json', '--after', second.cursor], { now: NOW, env: { ORG_DIR: symlink } }).project.org,
    fs.realpathSync(f.dir), 'symlink aliases keep the canonical cursor identity');
  const eventFile = path.join(f.dir, 'events.jsonl');
  const log = fs.readFileSync(eventFile);
  fs.writeFileSync(eventFile, eventsBefore);
  assert.match(f.fail(['digest', '--after', second.cursor]), /changed record\/journal/);
  fs.writeFileSync(eventFile, log);
  fs.writeFileSync(f.file, '');
  assert.match(f.fail(['digest', '--after', second.cursor]), /changed record\/journal/);
});

test('digest bounds and sanitizes narrow text while JSON preserves all facts and reports omissions', t => {
  const f = fixture(t);
  for (let n = 0; n < 12; n++) f.notice(`p${n}`, `[promote-queue] id=p${n} lane=lane${n} outcome=refused reason=${JSON.stringify('A long reason '.repeat(80) + '\x1b[31m')}`);
  const text = f.ok(['digest', '--since', '4h', '--limit', '2', '--width', '40'], at(NOW));
  assert.match(text, /PROMOTIONS \(12\)/);
  assert.match(text, /10 more; --json has all facts/);
  assert.doesNotMatch(text, /\x1b/);
  assert.ok(text.split('\n').every(line => [...line].length <= 40));
  assert.equal(f.read(['--limit', '2']).promotions.length, 12);
});

test('digest tolerates absent and incomplete journals, fails explicitly on malformed evidence and invalid options', t => {
  const f = fixture(t);
  const first = f.read();
  assert.match(first.warnings[0], /No inbox journal/);
  assert.equal(fs.existsSync(path.dirname(f.file)), false, 'read does not create a journal directory');
  f.notice('one', '[promote-queue] id=one lane=one outcome=promoted');
  fs.appendFileSync(f.file, '{"type":');
  const partial = f.read();
  assert.equal(partial.promotions.length, 1);
  assert.match(partial.warnings[0], /Incomplete inbox tail/);
  fs.appendFileSync(f.file, '"notice","id":"two","at":"2026-10-07T08:00:00Z","message":"[promote-queue] id=two lane=two outcome=refused"}\n');
  assert.deepEqual(f.read(['--after', partial.cursor]).promotions.map(p => p.lane), ['two']);
  fs.appendFileSync(f.file, 'not JSON\n');
  assert.match(f.fail(['digest']), /malformed digest inbox/);
  for (const args of [['--since', 'never'], ['--since', '1h', '--after', 'bad'], ['--limit', '0'], ['--width', '20'], ['--after', 'bad']]) {
    fs.writeFileSync(f.file, '');
    assert.match(f.fail(['digest', ...args]), /expects|choose|invalid digest cursor/);
  }
  fs.rmSync(f.dir, { recursive: true });
  assert.match(f.fail(['digest']), /not an initialized record/);
  assert.equal(fs.existsSync(f.dir), false, 'digest never auto-initializes a record');
});
