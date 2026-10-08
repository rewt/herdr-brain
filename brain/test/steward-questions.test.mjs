import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from '../../test/helpers/bounded-test.mjs';
import { gitProject } from '../../lib/project.mjs';
import { stewardTick, stewardConfig, operatorAlert } from '../lib/steward.mjs';
import { alertPayload, validateAlertPayload, QUESTION_TEXT_LIMIT, RECOMMENDATION_LIMIT } from '../lib/steward-payload.mjs';

const CLI = new URL('../../bin/org.mjs', import.meta.url).pathname;
const BRAIN = new URL('../bin/brain.mjs', import.meta.url).pathname;
const NOW = Date.parse('2026-10-08T17:00:00Z');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-questions-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'brain'), fleetHome = path.join(root, 'fleet');
  fs.mkdirSync(home); fs.mkdirSync(fleetHome);
  const env = { ...process.env, HERDR_MONITOR_FLEET: fleetHome, BRAIN_STATE: home, HERDR_BIN: '/must-not-call-herdr', ORG_ACTOR: 'fixture' };
  const fleet = { version: 1, session_limit: 6, projects: {} };
  const writeFleet = () => fs.writeFileSync(path.join(fleetHome, 'fleet.json'), JSON.stringify(fleet));
  writeFleet();
  const record = (project, ...args) => execFileSync(process.execPath, [CLI, ...args], { env: { ...env, ORG_DIR: fleet.projects[project].record }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const project of ['alpha', 'beta']) {
    const checkout = path.join(root, project), org = path.join(root, `${project}-record`);
    fs.mkdirSync(checkout);
    execFileSync('git', ['-C', checkout, 'init', '-q'], { stdio: 'pipe' });
    fleet.projects[project] = { checkout, record: org, identity: gitProject(checkout).identity, worktrees: path.join(root, `${project}-lanes`), temp: path.join(root, `${project}-temp`), layers: [] };
    writeFleet();
    record(project, 'init', org);
    record(project, 'add', 'Work', '--role', 'engineer');
  }
  const config = extra => fs.writeFileSync(path.join(home, 'steward.json'), JSON.stringify({ debounce_seconds: 1, alert_cap: 3, ...extra }));
  config({});
  const ask = (project, text = 'PRIVATE question?', extra = []) => record(project, 'ask', text, '--parent', 'ENG-1', '--category', 'publish', '--recommend', 'yes', '--why', 'PRIVATE reason', '--wait', ...extra);
  const alerts = [];
  const tick = extra => stewardTick({ home, env, now: NOW, agents: [], rows: [], alert: async payload => { alerts.push(payload); }, ...extra });
  const file = path.join(home, 'steward/questions.json');
  const receipts = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = () => Object.values(receipts().records).flatMap(r => Object.values(r.pending));
  return { root, home, env, fleet, writeFleet, record, config, ask, tick, alerts, file, receipts, entries };
}

test('new questions across two projects alert once, with private defaults, blocking counts and durable receipts', async t => {
  const f = fixture(t);
  assert.equal((await f.tick()).questions.skipped, 0);
  f.record('alpha', 'start', 'ENG-1');
  const a = f.ask('alpha', 'PRIVATE question?', ['--blocks', 'ENG-1']);
  const b = f.ask('beta');
  const snapshots = Object.values(f.fleet.projects).map(p => fs.readFileSync(path.join(p.record, 'events.jsonl'), 'utf8'));
  const result = await f.tick();
  assert.equal(result.questions.discovered, 2);
  assert.equal(result.questions.pending, 0);
  assert.deepEqual(f.alerts, [
    { project: 'alpha', question: a, kind: 'operator-question', category: 'publish', blocked_items: 1, blocked_runs: 1 },
    { project: 'beta', question: b, kind: 'operator-question', category: 'publish', blocked_items: 0, blocked_runs: 0 },
  ]);
  assert.ok(f.entries().every(receipt => receipt.ok && receipt.attempts === 1));
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /PRIVATE/);
  await f.tick({ now: NOW + 8 * 86400000 });
  assert.equal(f.alerts.length, 2, 'question dedupe outlives routing journal retirement');
  Object.values(f.fleet.projects).forEach((p, i) => assert.equal(fs.readFileSync(path.join(p.record, 'events.jsonl'), 'utf8'), snapshots[i]));
});

test('first scan skips pre-existing questions and durably reports the count per record', async t => {
  const f = fixture(t);
  f.ask('alpha'); f.ask('beta');
  const closed = f.ask('beta');
  f.record('beta', 'answer', closed, 'yes');
  assert.equal((await f.tick()).questions.skipped, 2);
  assert.equal(Object.values(f.receipts().records).reduce((n, r) => n + r.skipped, 0), 2);
  assert.equal((await f.tick()).questions.skipped, 0);
  assert.equal(f.alerts.length, 0);
  f.ask('alpha');
  await f.tick();
  assert.equal(f.alerts.length, 1);
});

test('a fresh Brain process adopts successful question receipts without sending either channel again', async t => {
  const f = fixture(t), output = path.join(f.root, 'alerts.jsonl'), script = path.join(f.root, 'channel.mjs');
  fs.writeFileSync(script, "import fs from 'node:fs'; fs.appendFileSync(process.argv[2], process.argv.at(-1) + '\\n');");
  f.config({ alert_command: [process.execPath, script, output], imessage_command: [process.execPath, script, output], imessage_recipient: 'fixture@example.test' });
  const pass = () => JSON.parse(execFileSync(process.execPath, [BRAIN, 'steward'], { env: f.env, encoding: 'utf8' }));
  pass(); f.ask('alpha'); pass(); pass();
  const alerts = fs.readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts[0], alerts[1]);
});

test('opted-in question and recommendation are one line, control-free and truncated for both channels', async t => {
  const f = fixture(t), output = path.join(f.root, 'alerts.jsonl'), script = path.join(f.root, 'channel.mjs');
  fs.writeFileSync(script, "import fs from 'node:fs'; fs.appendFileSync(process.argv[2], process.argv.at(-1) + '\\n');");
  f.config({ question_text: true, alert_command: [process.execPath, script, output], imessage_command: [process.execPath, script, output], imessage_recipient: 'fixture@example.test' });
  await f.tick();
  f.ask('alpha', 'PRIVATE\n\t\x1b\x7f\u0085\u2028\u202e' + 'x'.repeat(500));
  await f.tick({ alert: operatorAlert });
  for (const payload of fs.readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse)) {
    assert.equal(payload.text.length, QUESTION_TEXT_LIMIT);
    assert.match(payload.text, /^PRIVATE x/);
    assert.equal(payload.recommendation, 'yes');
    validateAlertPayload(payload);
  }
  const payload = alertPayload({ project: 'alpha', question: 'HUM-1', kind: 'operator-question', category: 'design', blocked_items: 0, blocked_runs: 0, recommendation: 'r'.repeat(300) }, { question_text: true });
  assert.equal(payload.recommendation.length, RECOMMENDATION_LIMIT);
  f.config({ question_text: 'yes' });
  assert.throws(() => stewardConfig(f.home), /question_text must be boolean/);
});

test('failed question channels retry after debounce within the cap, without repeating the successful channel', async t => {
  const f = fixture(t), output = path.join(f.root, 'alerts.jsonl'), script = path.join(f.root, 'channel.mjs'), fail = path.join(f.root, 'fail');
  fs.writeFileSync(script, "import fs from 'node:fs'; if(process.argv[3] === 'message' && fs.existsSync(process.argv[4])) process.exit(1); fs.appendFileSync(process.argv[2], process.argv[3] + '\\n');");
  fs.writeFileSync(fail, '');
  f.config({ alert_command: [process.execPath, script, output, 'local', fail], imessage_command: [process.execPath, script, output, 'message', fail], imessage_recipient: 'fixture@example.test' });
  await f.tick(); f.ask('alpha');
  const opts = { alert: async (...args) => {
    assert.ok(f.entries().some(receipt => receipt.attempts > 0 && !receipt.ok), 'intent is durable before effects');
    return operatorAlert(...args);
  } };
  assert.equal((await f.tick(opts)).questions.pending, 1);
  assert.deepEqual(f.entries()[0].delivered, ['notification']);
  await f.tick({ ...opts, now: NOW + 500 });
  assert.equal(f.entries()[0].attempts, 1);
  fs.unlinkSync(fail);
  await f.tick({ ...opts, now: NOW + 1000 });
  assert.equal(f.entries()[0].attempts, 2);
  assert.equal(f.entries()[0].ok, true);
  await f.tick({ ...opts, now: NOW + 5000 });
  assert.equal(fs.readFileSync(output, 'utf8'), 'local\nmessage\n');
});

test('question failure caps survive restart and do not suppress another new question', async t => {
  const f = fixture(t); f.config({ alert_cap: 2 });
  await f.tick(); f.ask('alpha');
  let calls = 0;
  const alert = async () => { calls++; throw Error('offline channel'); };
  for (const offset of [0, 1000, 2000, 3000]) await f.tick({ alert, now: NOW + offset });
  assert.equal(calls, 2);
  assert.equal(f.entries()[0].attempts, 2);
  assert.match(f.entries()[0].error, /offline channel/);
  f.ask('alpha');
  await f.tick({ alert, now: NOW + 4000 });
  assert.equal(calls, 3);
});

test('interrupted question attempts resume from pending receipts after debounce', async t => {
  const f = fixture(t);
  await f.tick(); f.ask('alpha');
  await f.tick({ alert: async () => { throw Error('lost acknowledgement'); } });
  const state = f.receipts(), pending = Object.values(state.records).flatMap(r => Object.values(r.pending))[0];
  delete pending.error; // Durable intent with no result, as after interruption.
  fs.writeFileSync(f.file, JSON.stringify(state));
  await f.tick({ now: NOW + 1000 });
  assert.equal(f.alerts.length, 1);
  assert.equal(f.entries()[0].ok, true);
});

test('dry-run does not establish a baseline or consume pending question receipts', async t => {
  const f = fixture(t); f.ask('alpha');
  assert.equal((await f.tick({ dryRun: true })).questions.skipped, 1);
  assert.equal(fs.existsSync(path.join(f.home, 'steward')), false);
  await f.tick(); f.ask('beta');
  const before = fs.readFileSync(f.file, 'utf8');
  assert.equal((await f.tick({ dryRun: true })).actions.length, 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(f.alerts.length, 0);
  await f.tick(); assert.equal(f.alerts.length, 1);
});

test('answered and automatically closed questions do not alert; receipts compact without reopening repeats', async t => {
  const f = fixture(t); await f.tick();
  const id = f.ask('alpha'); await f.tick();
  f.record('alpha', 'answer', id, 'yes'); await f.tick();
  assert.equal(f.entries().length, 0);
  f.record('alpha', 'reopen', id); await f.tick();
  assert.equal(f.alerts.length, 1);
  const other = f.ask('beta'); f.record('beta', 'answer', other, 'no'); await f.tick();
  const config = path.join(f.fleet.projects.beta.record, 'config.json');
  const raw = JSON.parse(fs.readFileSync(config, 'utf8'));
  raw.approvals.categories.design = 'auto'; fs.writeFileSync(config, JSON.stringify(raw));
  f.record('beta', 'ask', 'Auto question?', '--parent', 'ENG-1', '--category', 'design', '--recommend', 'yes', '--why', 'Auto policy');
  await f.tick();
  assert.equal(f.alerts.length, 1);
});

test('unreadable and stale projects do not advance question cursors or block healthy projects', async t => {
  const f = fixture(t); await f.tick();
  f.ask('alpha'); f.ask('beta');
  const file = path.join(f.fleet.projects.alpha.record, 'events.jsonl'), bytes = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{broken}\n');
  assert.equal((await f.tick()).questions.errors.length, 1);
  assert.equal(f.alerts.length, 1); assert.equal(f.alerts[0].project, 'beta');
  fs.writeFileSync(file, bytes); await f.tick();
  assert.equal(f.alerts.length, 2);
  f.fleet.projects.alpha.identity += '-stale'; f.writeFleet();
  assert.match((await f.tick()).questions.errors[0].error, /stale fleet/);
});

test('disabled steward does not baseline questions; corrupt receipts isolate question effects', async t => {
  const f = fixture(t); f.config({ enabled: false }); f.ask('alpha');
  assert.equal((await f.tick()).disabled, true); assert.equal(fs.existsSync(f.file), false);
  f.config({}); await f.tick(); f.ask('alpha');
  for (const bytes of ['{', 'null', '{"version":1,"records":[]}']) {
    fs.writeFileSync(f.file, bytes);
    assert.match((await f.tick()).questions.errors[0].error, /question receipts/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
  }
  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts[0].kind, 'journal-refused');
});

test('unchanged records skip reads and folds; append scans read only the tail and extend derived state', async t => {
  const f = fixture(t);
  const first = await f.tick();
  assert.equal(first.questions.scans.full, 2);
  const inodes = new Set(Object.values(f.fleet.projects).map(p => fs.statSync(path.join(p.record, 'events.jsonl')).ino));
  const reads = [], read = fs.readSync;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    if (inodes.has(fs.fstatSync(fd).ino)) reads.push({ length, position });
    return read(fd, buffer, offset, length, position);
  });
  assert.deepEqual((await f.tick()).questions.scans, { skipped: 2, full: 0, tail: 0, bytes: 0 });
  assert.deepEqual(reads, [], 'unchanged event logs perform no reads');
  const file = path.join(f.fleet.projects.alpha.record, 'events.jsonl'), size = fs.statSync(file).size;
  f.record('alpha', 'start', 'ENG-1');
  const id = f.ask('alpha', 'Question?', ['--blocks', 'ENG-1']);
  const next = await f.tick();
  assert.deepEqual(next.questions.scans, { skipped: 1, full: 0, tail: 1, bytes: fs.statSync(file).size - size });
  assert.deepEqual(reads, [{ length: fs.statSync(file).size - size, position: size }], 'only the appended bytes are read');
  assert.equal(next.questions.discovered, 1);
  assert.equal(f.alerts[0].blocked_items, 1);
  assert.equal(f.alerts[0].blocked_runs, 1);
  f.record('alpha', 'answer', id, 'no');
  assert.equal((await f.tick()).questions.scans.tail, 1);
  assert.equal(f.entries().length, 0, 'tail fold resolves and retires answered questions');
  const fresh = JSON.parse(execFileSync(process.execPath, [BRAIN, 'steward'], { env: f.env, encoding: 'utf8' }));
  assert.deepEqual(fresh.questions.scans, { skipped: 2, full: 0, tail: 0, bytes: 0 }, 'durable metadata skips even after restart');
});

test('an incomplete append preserves the cursor and rereads the tail after completion', async t => {
  const f = fixture(t); await f.tick();
  const file = path.join(f.fleet.projects.alpha.record, 'events.jsonl');
  const before = f.receipts();
  fs.appendFileSync(file, '{"seq":');
  assert.match((await f.tick()).questions.errors[0].error, /incomplete event tail/);
  assert.deepEqual(f.receipts(), before);
  f.ask('alpha'); // The CLI repairs its interrupted tail before appending.
  assert.equal((await f.tick()).questions.discovered, 1);
  assert.equal(f.alerts.length, 1);
});

test('a complete event without its final newline remains readable when the CLI later appends', async t => {
  const f = fixture(t), file = path.join(f.fleet.projects.alpha.record, 'events.jsonl');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trimEnd());
  assert.deepEqual((await f.tick()).questions.errors, []);
  f.ask('alpha');
  const result = await f.tick();
  assert.deepEqual(result.questions.errors, []);
  assert.equal(result.questions.discovered, 1);
  assert.equal(f.alerts.length, 1);
});

test('question sends use a parallel batch capped at eight, with durable intents and later ticks draining the rest', async t => {
  const f = fixture(t); await f.tick();
  for (let i = 0; i < 10; i++) f.ask('alpha');
  let release, started, calls = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const pass = f.tick({ alert: async () => {
    calls++;
    assert.equal(f.entries().filter(r => r.attempts === 1).length, 8);
    if (calls === 8) started();
    await barrier;
  } });
  await ready;
  assert.equal(calls, 8);
  release();
  assert.equal((await pass).questions.pending, 2);
  assert.equal((await f.tick()).questions.pending, 0);
  assert.equal(f.alerts.length, 2);
});

test('no iMessage recipient is quiet across ticks and restarts while the local notification delivers', async t => {
  const f = fixture(t), output = path.join(f.root, 'local.jsonl'), script = path.join(f.root, 'local.mjs');
  fs.writeFileSync(script, "import fs from 'node:fs'; fs.appendFileSync(process.argv[2], process.argv.at(-1) + '\\n');");
  f.config({ alert_command: [process.execPath, script, output], imessage_command: ['/must-not-call-imessage'] });
  await f.tick(); f.ask('alpha');
  for (const offset of [0, 1000, 2000, 5000]) {
    const result = await f.tick({ now: NOW + offset, alert: operatorAlert });
    assert.equal(result.questions.pending, 0);
    assert.deepEqual(result.questions.errors, []);
  }
  const fresh = JSON.parse(execFileSync(process.execPath, [BRAIN, 'steward'], { env: f.env, encoding: 'utf8' }));
  assert.deepEqual(fresh.questions.errors, []);
  const [receipt] = f.entries();
  assert.equal(receipt.attempts, 1);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.delivered, ['notification']);
  assert.equal(receipt.error, undefined);
  assert.equal(fs.existsSync(path.join(f.home, 'steward/journal-failure.json')), false);
  assert.equal(fs.readFileSync(output, 'utf8').trim().split('\n').length, 1);
  const stdout = execFileSync(process.execPath, [BRAIN, 'steward', '--test-alert'], { env: f.env, encoding: 'utf8' });
  assert.match(stdout, /Configured channels: local alert_command; iMessage not configured \(skipped\)/);
  assert.match(stdout, /setup alert sent/);
});

test('removing the iMessage recipient retires its failed delivery without further attempts or errors', async t => {
  const f = fixture(t); f.config({ imessage_recipient: 'fixture@example.test' });
  await f.tick(); f.ask('alpha');
  await f.tick({ alert: async () => { const error = Error('iMessage offline'); error.delivered = ['notification']; throw error; } });
  assert.equal(f.entries()[0].ok, false);
  f.config({});
  for (const offset of [500, 1000, 2000]) {
    const result = await f.tick({ now: NOW + offset });
    assert.equal(result.questions.pending, 0);
    assert.deepEqual(result.questions.errors, []);
  }
  assert.equal(f.entries()[0].ok, true);
  assert.equal(f.entries()[0].error, undefined);
  assert.equal(f.entries()[0].attempts, 1);
  assert.equal(f.alerts.length, 0, 'the successful notification does not repeat');
});

test('Messages transport rejects extra private fields, invalid counts and unsanitized text offline', () => {
  const base = { project: 'alpha', question: 'HUM-1', kind: 'operator-question', category: 'publish', blocked_items: 1, blocked_runs: 0 };
  validateAlertPayload(base);
  validateAlertPayload({ ...base, text: 'Question?', recommendation: 'yes' });
  for (const payload of [{ ...base, screen: 'private' }, { ...base, blocked_items: -1 }, { ...base, text: 'question\n', recommendation: 'yes' }]) {
    assert.throws(() => validateAlertPayload(payload));
    assert.throws(() => execFileSync(process.execPath, [new URL('../bin/steward-imessage.mjs', import.meta.url).pathname, 'fixture@example.test', JSON.stringify(payload)], { stdio: 'pipe' }));
  }
});
