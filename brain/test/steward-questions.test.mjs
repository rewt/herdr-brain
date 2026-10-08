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

test('disabled steward does not read or baseline questions; corrupt receipts refuse effects', async t => {
  const f = fixture(t); f.config({ enabled: false }); f.ask('alpha');
  assert.equal((await f.tick()).disabled, true); assert.equal(fs.existsSync(f.file), false);
  f.config({}); await f.tick(); f.ask('alpha');
  for (const bytes of ['{', 'null', '{"version":1,"records":[]}']) {
    fs.writeFileSync(f.file, bytes);
    await assert.rejects(f.tick(), /question receipts/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
  }
  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts[0].kind, 'journal-refused');
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
