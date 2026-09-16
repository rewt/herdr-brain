// The console session against a real temporary organization: answers go through the
// org CLI, show up under Decided today, and a declined question keeps its work blocked.
// Herdr and the external viewer are stubbed; nothing here needs Ink or a terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ORG_BIN, answerArgs } from '../lib/cli.mjs';
import { ConfigError, EXAMPLE, loadConfig } from '../lib/config.mjs';
import { flatRows } from '../lib/model.mjs';
import { createSession } from '../lib/session.mjs';

function tempOrg() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-session-'));
  const dir = path.join(root, '.org');
  const org = (...argv) => {
    const env = { ...process.env, ORG_DIR: dir };
    delete env.ORG_ACTOR;
    const r = spawnSync(process.execPath, [ORG_BIN, ...argv], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  org('init', dir);
  org('add', '--goal', 'Theft fix shipped');
  org('add', 'Implement the theft fix', '--parent', 'G-1', '--role', 'engineer', '--priority', '50');
  org('add', 'Publish the notes', '--parent', 'G-1', '--role', 'writer', '--priority', '20');
  const memo = path.join(root, 'memo.md');
  fs.writeFileSync(memo, '# Memo\n\nWhy.\n');
  org('ask', 'Adopt the theft fix?', '--parent', 'G-1', '--category', 'design', '--recommend', 'yes', '--why', 'It works.', '--memo', memo, '--blocks', 'ENG-1');
  org('ask', 'Publish the notes now?', '--parent', 'G-1', '--category', 'publish', '--recommend', 'yes', '--why', 'They are ready.', '--blocks', 'DOC-1');
  org('ask', 'Rename the goal?', '--parent', 'G-1', '--category', 'goals', '--recommend', 'no', '--why', 'Names are fine.');
  const config = { projects: [{ name: 'test', org: dir, cwd: root, ledger_dir: null, claude_config_dirs: [], session_cap: 30 }], refresh_seconds: 60 };
  return { root, dir, org, memo, config };
}

const noHerdr = async () => ({ ok: true, agents: [{ name: 'lane-x', status: 'idle' }] });
const keys = async (session, sequence) => {
  for (const [input, key] of sequence) await session.key(input, key ?? {});
};

test('approving and declining from the console record the operator\'s answers', async () => {
  const t = tempOrg();
  const previousActor = process.env.ORG_ACTOR;
  process.env.ORG_ACTOR = 'exec-9999'; // the console must not pass this on
  try {
    const session = createSession({ config: t.config, deps: { herdrAgents: noHerdr } });
    await session.refresh({ reorder: true });
    session.frame(100, 29);
    assert.deepEqual(flatRows(session.sections).map((r) => r.key), ['q:HUM-1', 'q:HUM-2', 'q:HUM-3']);

    await keys(session, [['y']]);
    assert.match(session.frame(100, 29).lines.at(-1).text, /^Approve: Adopt the theft fix\? Enter to confirm, Esc to cancel/);
    assert.equal(JSON.parse(t.org('show', 'HUM-1', '--json')).status, 'ready', 'nothing is recorded before Enter');
    await keys(session, [['', { return: true }]]);
    let hum1 = JSON.parse(t.org('show', 'HUM-1', '--json'));
    assert.equal(hum1.meta.answer, 'yes');
    assert.equal(hum1.meta.answered_by, 'human');
    assert.equal(JSON.parse(t.org('show', 'ENG-1', '--json')).status, 'ready');
    const decided = session.sections.find((s) => s.key === 'decided').rows;
    assert.deepEqual(decided.map((r) => [r.key, r.state]), [['a:HUM-1', 'yes · you']]);
    assert.equal(session.ui.selectedKey, 'q:HUM-2', 'selection moves to the next question');
    assert.match(session.ui.message, /^Recorded yes for “Adopt the theft fix\?”\. The next executive pass acts on it\.$/);

    await keys(session, [['n'], ['', { return: true }]]);
    assert.match(session.ui.message, /reason is required/);
    await keys(session, [['N'], ['o'], ['t'], [' '], ['y'], ['e'], ['t'], ['', { return: true }], ['', { return: true }]]);
    const hum2 = JSON.parse(t.org('show', 'HUM-2', '--json'));
    assert.equal(hum2.meta.answer, 'no');
    assert.match(hum2.notes.find((n) => n.decision).text, /Not yet/);
    assert.equal(JSON.parse(t.org('show', 'DOC-1', '--json')).status, 'blocked', 'a declined question keeps its work blocked');
    assert.ok(session.sections.find((s) => s.key === 'decided').rows.some((r) => r.key === 'a:HUM-2' && r.state === 'no · you'));

    // Answered behind the console's back: the CLI refuses, and nothing changes locally.
    t.org('answer', 'HUM-3', 'no');
    await keys(session, [['y'], ['', { return: true }]]);
    assert.equal(session.ui.messageStyle, 'error');
    assert.match(session.ui.message, /^Not recorded: HUM-3 was already answered no/);
    hum1 = JSON.parse(t.org('show', 'HUM-3', '--json'));
    assert.equal(hum1.meta.answer, 'no');
    session.stop();
  } finally {
    if (previousActor === undefined) delete process.env.ORG_ACTOR;
    else process.env.ORG_ACTOR = previousActor;
  }
});

test('focus refuses a gone agent, open suspends for an editor, and a failed read keeps the last data', async () => {
  const t = tempOrg();
  t.org('start', 'ENG-1', '--meta', 'agent=lane-gone');
  const opened = [];
  let suspended = 0;
  let failRead = false;
  const deps = {
    herdrAgents: noHerdr,
    herdrFocus: async () => assert.fail('must not focus a gone agent'),
    viewer: () => ({ cmd: 'vi', args: [], blocking: true, label: 'vi' }),
    openBlocking: (viewer, file) => {
      opened.push(file);
      return { ok: true };
    },
    suspend: async (fn) => {
      suspended++;
      return fn();
    },
  };
  const { orgToday } = await import('../lib/cli.mjs');
  deps.orgToday = async (p) => {
    if (failRead) throw new Error('events.jsonl line 3 is not valid JSON');
    return orgToday(p);
  };
  const session = createSession({ config: t.config, deps });
  await session.refresh({ reorder: true });
  session.frame(100, 29);
  const run = flatRows(session.sections).find((r) => r.kind === 'run');
  assert.equal(run.state.endsWith('agent gone'), true);
  session.ui = { ...session.ui, selectedKey: run.key };
  await keys(session, [['f']]);
  assert.match(session.ui.message, /That agent is gone \(lane-gone\)/);

  session.ui = { ...session.ui, selectedKey: 'q:HUM-1' };
  await keys(session, [['o']]);
  assert.deepEqual(opened, [t.memo]);
  assert.equal(suspended, 1);

  await keys(session, [['2']]);
  assert.match(session.frame(100, 29).lines.map((l) => l.text).join('\n'), /MEMO\n\s+Why\./);

  failRead = true;
  await session.refresh();
  const header = session.frame(160, 29).lines[0].text;
  assert.match(header, /no session ledger configured/);
  assert.match(header, /org data \d+s old \(events\.jsonl line 3 is not valid JSON\)/);
  assert.equal(flatRows(session.sections).length, 4, 'the last good data stays');

  const down = createSession({ config: t.config, deps: { herdrAgents: async () => ({ ok: false, agents: [], error: 'no server' }) } });
  await down.refresh({ reorder: true });
  assert.match(down.frame(100, 29).lines[0].text, /Herdr unavailable/);
  down.ui = { ...down.ui, selectedKey: flatRows(down.sections).find((r) => r.kind === 'run').key };
  await down.key('f', {});
  assert.match(down.ui.message, /Herdr unavailable \(no server\)/);
  session.stop();
  down.stop();
});

test('answers are passed as an argument array', () => {
  assert.deepEqual(answerArgs({ question: 'HUM-1', answer: 'no', note: "it's; rm -rf /", overrule: true }),
    ['answer', 'HUM-1', 'no', '--note', "it's; rm -rf /", '--overrule']);
  assert.deepEqual(answerArgs({ question: 'HUM-1', answer: 'yes', note: null }), ['answer', 'HUM-1', 'yes']);
});

test('a missing configuration becomes an example that must be edited', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'console-config-')), 'nested', 'console.json');
  assert.throws(() => loadConfig(file), (e) => e instanceof ConfigError && /wrote an example configuration/.test(e.message));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), EXAMPLE);
  assert.throws(() => loadConfig(file), /still the example/);
  fs.writeFileSync(file, JSON.stringify({ projects: [{ name: 'p', org: '~/x' }] }));
  const config = loadConfig(file);
  assert.equal(config.projects[0].org, path.join(os.homedir(), 'x'));
  assert.equal(config.refresh_seconds, 5);
  fs.writeFileSync(file, JSON.stringify({ projects: [{ name: 'p' }] }));
  assert.throws(() => loadConfig(file), /needs "org"/);
});
