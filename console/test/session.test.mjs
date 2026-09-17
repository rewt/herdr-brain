// The console session against a real temporary organization: answers go through the
// org CLI, show up in today's history, and a declined question keeps its work blocked.
// Herdr and the external viewer are stubbed (or a fake herdr on PATH); nothing here
// needs Ink or a terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ORG_BIN, answerArgs, goArgs, herdrGo, herdrRightClick, herdrTabs } from '../lib/cli.mjs';
import { ConfigError, EXAMPLE, loadConfig } from '../lib/config.mjs';
import { lineText } from '../lib/frame.mjs';
import { createSession, VERSION } from '../lib/session.mjs';

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

const noHerdr = async () => ({ ok: true, agents: [{ name: 'lane-x', status: 'idle', tool: 'claude', tab: 'w1:t1', pane: 'w1:p1', cwd: '/tmp/nowhere' }] });
const quiet = { herdrAgents: noHerdr, herdrTabs: async () => [], repoOf: () => null };
const screen = (session, cols = 100, rows = 29) => session.frame(cols, rows).lines.map(lineText);
const keys = async (session, sequence) => {
  for (const [input, key] of sequence) await session.key(input, key ?? {});
};

test('approving and declining from the console record the operator\'s answers', async () => {
  const t = tempOrg();
  const previousActor = process.env.ORG_ACTOR;
  process.env.ORG_ACTOR = 'exec-9999'; // the console must not pass this on
  try {
    const session = createSession({ config: t.config, deps: quiet });
    await session.refresh({ reorder: true });
    screen(session);
    assert.deepEqual(session.board.waiting.map((r) => r.key), ['q:HUM-1', 'q:HUM-2', 'q:HUM-3']);
    assert.equal(session.ui.selectedKey, 'q:HUM-1');

    await keys(session, [['y']]);
    assert.match(screen(session).at(-1), /ANSWER .*Approve: Adopt the theft fix\? Enter to confirm, Esc to cancel/);
    assert.equal(JSON.parse(t.org('show', 'HUM-1', '--json')).status, 'ready', 'nothing is recorded before Enter');
    await keys(session, [['', { return: true }]]);
    let hum1 = JSON.parse(t.org('show', 'HUM-1', '--json'));
    assert.equal(hum1.meta.answer, 'yes');
    assert.equal(hum1.meta.answered_by, 'human');
    assert.equal(JSON.parse(t.org('show', 'ENG-1', '--json')).status, 'ready');
    assert.deepEqual(session.board.history.map((r) => [r.key, r.state]), [['a:HUM-1', 'yes · you']]);
    assert.equal(session.ui.selectedKey, 'q:HUM-2', 'selection moves to the next question');
    assert.match(session.ui.message, /^Recorded yes for “Adopt the theft fix\?”\. The next executive pass acts on it\.$/);

    // From the summary popup: n, a reason, Enter, Enter.
    await keys(session, [['s'], ['n'], ['', { return: true }]]);
    assert.match(session.ui.message, /reason is required/);
    await keys(session, [['N'], ['o'], ['t'], [' '], ['y'], ['e'], ['t'], ['', { return: true }], ['', { return: true }]]);
    assert.equal(session.ui.popup, null, 'the answered question\'s popup closes');
    const hum2 = JSON.parse(t.org('show', 'HUM-2', '--json'));
    assert.equal(hum2.meta.answer, 'no');
    assert.match(hum2.notes.find((n) => n.decision).text, /Not yet/);
    assert.equal(JSON.parse(t.org('show', 'DOC-1', '--json')).status, 'blocked', 'a declined question keeps its work blocked');
    assert.ok(session.board.history.some((r) => r.key === 'a:HUM-2' && r.state === 'no · you'));

    // A reason that starts with a dash is recorded as written.
    t.org('ask', 'Tidy the notes?', '--parent', 'G-1', '--category', 'other', '--recommend', 'yes', '--why', 'They are messy.');
    await session.refresh();
    session.ui = { ...session.ui, selectedKey: 'q:HUM-4' };
    await keys(session, [['n'], ...[...'- not now'].map((ch) => [ch]), ['', { return: true }], ['', { return: true }]]);
    assert.equal(session.ui.messageStyle, 'ok', session.ui.message);
    assert.equal(JSON.parse(t.org('show', 'HUM-4', '--json')).closed.note, '- not now');

    // Answered behind the console's back: the CLI refuses, and nothing changes locally.
    t.org('answer', 'HUM-3', 'no');
    session.ui = { ...session.ui, selectedKey: 'q:HUM-3' };
    await keys(session, [['y'], ['', { return: true }]]);
    assert.equal(session.ui.messageStyle, 'error');
    assert.match(session.ui.message, /^Not recorded: HUM-3 was already answered no/);
    hum1 = JSON.parse(t.org('show', 'HUM-3', '--json'));
    assert.equal(hum1.meta.answer, 'no');

    // The history view lists what was answered, newest first.
    await keys(session, [['h']]);
    const lines = screen(session);
    assert.match(lines[1], /HISTORY/);
    assert.match(lines.slice(2, 6).join('\n'), /Tidy the notes\?[\s\S]*Publish the notes now\?[\s\S]*Adopt the theft fix\?/);
    session.stop();
  } finally {
    if (previousActor === undefined) delete process.env.ORG_ACTOR;
    else process.env.ORG_ACTOR = previousActor;
  }
});

test('Enter and a click go to a live session; a gone one says so; Herdr down says so', async () => {
  const t = tempOrg();
  t.org('start', 'ENG-1', '--meta', 'agent=lane-x', '--meta', 'lane=theft-fix'); // R-1, live
  t.org('start', 'DOC-1', '--meta', 'agent=lane-gone'); // R-2, gone
  const went = [];
  const session = createSession({ config: t.config, deps: { ...quiet, herdrGo: async (target) => { went.push(target); return { ok: true }; } } });
  await session.refresh({ reorder: true });
  assert.deepEqual(session.rows('list').filter((r) => r.kind === 'session').map((r) => [r.key, r.session, r.state]), [
    ['r:R-1', 'lane theft-fix r1', 'idle'], ['r:R-2', 'run r1', 'gone'],
  ]);
  session.ui = { ...session.ui, selectedKey: 'r:R-1' };
  await keys(session, [['', { return: true }]]);
  assert.deepEqual(went, [{ agent: 'lane-x', tab: 'w1:t1' }]);
  assert.match(session.ui.message, /^Went to lane theft-fix r1 in Herdr\.$/);

  session.ui = { ...session.ui, selectedKey: 'r:R-2' };
  await keys(session, [['f']]);
  assert.equal(went.length, 1, 'nothing is focused for a gone session');
  assert.match(session.ui.message, /run r1 is gone; there is no Herdr tab to go to/);

  // A left click on the live row's line.
  const lines = screen(session, 140, 40);
  const y = lines.findIndex((l) => l.includes('lane theft-fix r1'));
  await session.mouse({ button: 'left', x: 10, y, press: true });
  assert.equal(went.length, 2);
  assert.equal(session.ui.selectedKey, 'r:R-1');
  // A right click opens the menu at the row; its Summary item opens the popup.
  await session.mouse({ button: 'right', x: 10, y, press: true });
  assert.equal(session.ui.popup.kind, 'menu');
  const menu = screen(session, 140, 40);
  const item = menu.findIndex((l, i) => i > y && l.includes('Summary'));
  await session.mouse({ button: 'left', x: 14, y: item, press: true });
  assert.equal(session.ui.popup.kind, 'summary');
  assert.match(screen(session, 140, 40).join('\n'), /\[1 Message\][\s\S]*no message: transcript not found/);
  await keys(session, [['2']]);
  assert.match(screen(session, 140, 40).join('\n'), /Brief: run R-1 on ENG-1|# Brief|Brief/);
  session.stop();

  const down = createSession({ config: t.config, deps: { ...quiet, herdrAgents: async () => ({ ok: false, agents: [], error: 'no server' }) } });
  await down.refresh({ reorder: true });
  assert.match(screen(down)[0], /Herdr unavailable/);
  assert.deepEqual(down.rows('list').filter((r) => r.kind === 'session').map((r) => r.state), ['unknown', 'unknown']);
  down.ui = { ...down.ui, selectedKey: 'r:R-1' };
  await down.key('', { return: true });
  assert.match(down.ui.message, /Herdr unavailable \(no server\)/);
  down.stop();
});

test('go-to-session runs herdr with an argument array: the agent by name, else its tab', async () => {
  assert.deepEqual(goArgs({ agent: 'lane-x', tab: 'w1:t1' }), ['agent', 'focus', 'lane-x']);
  assert.deepEqual(goArgs({ agent: null, tab: 'w1:t1' }), ['tab', 'focus', 'w1:t1']);
  assert.equal(goArgs({ agent: null, tab: null }), null);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-herdr-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ "$1" = tab ] && [ "$2" = list ]; then echo '{"result":{"tabs":[{"tab_id":"w1:t1","label":"cli","number":1,"workspace_id":"w1"}]}}'; exit 0; fi
if [ "$3" = "refuse; rm -rf /" ]; then echo "no such agent" >&2; exit 3; fi
exit 0
`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    assert.deepEqual(await herdrGo({ agent: 'lane-x' }), { ok: true });
    assert.deepEqual(await herdrGo({ agent: null, tab: 'w1:t1' }), { ok: true });
    assert.deepEqual(await herdrGo({ agent: 'refuse; rm -rf /' }), { ok: false, error: 'no such agent' });
    assert.deepEqual(await herdrGo({}), { ok: false, error: 'no Herdr agent or tab to go to' });
    assert.deepEqual(await herdrTabs(), [{ tab: 'w1:t1', label: 'cli', number: 1, workspace: 'w1' }]);
    // Right clicks come to the console's own pane while it runs, and go back to Herdr after.
    assert.equal(herdrRightClick('w1:p9', 'pane'), true);
    assert.equal(herdrRightClick('w1:p9', 'herdr'), true);
    assert.equal(herdrRightClick(null, 'pane'), false, 'outside Herdr nothing is asked');
  } finally {
    process.env.PATH = previous;
  }
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
    'agent focus lane-x', 'tab focus w1:t1', 'agent focus refuse; rm -rf /', 'tab list',
    'pane input --right-click pane w1:p9', 'pane input --right-click herdr w1:p9',
  ]);
});

test('open suspends for an editor, a failed read keeps the last data, and the header shows the version', async () => {
  const t = tempOrg();
  const opened = [];
  let suspended = 0;
  let failRead = false;
  const deps = {
    ...quiet,
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
  assert.match(screen(session, 140, 40)[0], new RegExp(`console ${VERSION.replace(/\./g, '\\.')}`));
  assert.equal(VERSION, '0.0.2');

  await keys(session, [['o']]);
  assert.deepEqual(opened, [t.memo]);
  assert.equal(suspended, 1);

  await keys(session, [['s'], ['2']]);
  assert.match(screen(session).join('\n'), /\[2 Memo\][\s\S]*MEMO[\s\S]*Why\./i);
  await keys(session, [['o']]);
  assert.deepEqual(opened, [t.memo, t.memo]);
  await keys(session, [['', { escape: true }]]);

  failRead = true;
  await session.refresh();
  const header = screen(session, 160, 29)[0];
  assert.match(header, /no session ledger/);
  assert.match(header, /org data \d+s old \(events\.jsonl line 3 is not valid JSON\)/);
  assert.equal(session.board.waiting.length, 3, 'the last good data stays');
  session.stop();
});

test('NO_COLOR draws plain glyphs, and a scope narrows the list and prefills nothing else', async () => {
  const t = tempOrg();
  const session = createSession({ config: t.config, deps: quiet, env: { NO_COLOR: '1' } });
  await session.refresh({ reorder: true });
  for (const l of screen(session, 140, 40)) assert.match(l, /^[\x20-\x7e]*$/, l);
  await keys(session, [['w']]);
  assert.match(screen(session, 140, 40)[0], /scope: working/);
  assert.match(screen(session, 140, 40).join('\n'), /Nothing matches this scope/);
  await keys(session, [['w'], ['n']]);
  session.ui = { ...session.ui, selectedKey: null };
  session.stop();
});

test('overruling from the history records the opposite answer', async () => {
  const t = tempOrg();
  const configFile = path.join(t.dir, 'config.json');
  const orgConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  orgConfig.approvals = { default: 'ask', categories: { tooling: 'auto' } };
  fs.writeFileSync(configFile, JSON.stringify(orgConfig));
  t.org('ask', 'Skip the old tool?', '--parent', 'G-1', '--category', 'tooling', '--recommend', 'no', '--why', 'It still works.', '--blocks', 'DOC-1');
  const session = createSession({ config: t.config, deps: quiet });
  await session.refresh({ reorder: true });
  await keys(session, [['h']]);
  assert.equal(session.ui.historyKey, 'a:HUM-4');
  await keys(session, [['n']]);
  assert.match(screen(session).at(-1), /Overrule to yes “Skip the old tool\?”/);
  await keys(session, [...[...'Replace it'].map((ch) => [ch]), ['', { return: true }], ['', { return: true }]]);
  assert.equal(session.ui.messageStyle, 'ok', session.ui.message);
  const hum4 = JSON.parse(t.org('show', 'HUM-4', '--json'));
  assert.equal(hum4.meta.answer, 'yes');
  assert.equal(hum4.meta.answered_by, 'human');
  assert.equal(hum4.meta.overruled, true);
  const row = session.board.history.find((r) => r.key === 'a:HUM-4');
  assert.deepEqual(row.actions, [], 'an operator answer is not offered for overrule again');
  session.stop();
});

test('a text document opens from a private file that is removed afterwards', async () => {
  const t = tempOrg();
  t.org('note', 'ENG-1', 'Keep the cells as they are.', '--decision');
  const seen = [];
  const inspect = (file) => {
    const st = fs.lstatSync(file);
    seen.push({ file, mode: st.mode & 0o777, dirMode: fs.statSync(path.dirname(file)).mode & 0o777, text: fs.readFileSync(file, 'utf8') });
    return { ok: true };
  };
  let blocking = true;
  const session = createSession({ config: t.config, deps: {
    ...quiet,
    viewer: () => ({ cmd: 'x', args: [], blocking, label: 'x' }),
    openBlocking: (viewer, file) => inspect(file),
    openDetached: async (viewer, file) => inspect(file),
  } });
  await session.refresh({ reorder: true });
  const note = session.board.history.find((r) => r.kind === 'decision');
  assert.ok(note?.doc.text, 'the decision note has text to open');
  await keys(session, [['h']]);
  session.ui = { ...session.ui, historyKey: note.key };
  await keys(session, [['o']]);
  assert.equal(seen[0].mode, 0o600);
  assert.equal(seen[0].dirMode, 0o700);
  assert.equal(seen[0].text, note.doc.text);
  assert.equal(fs.existsSync(path.dirname(seen[0].file)), false, 'removed once the editor returns');

  blocking = false;
  await keys(session, [['o']]);
  assert.notEqual(path.dirname(seen[1].file), path.dirname(seen[0].file));
  assert.equal(fs.existsSync(seen[1].file), true, 'kept while a detached viewer may read it');
  session.stop();
  assert.equal(fs.existsSync(path.dirname(seen[1].file)), false, 'removed when the console stops');
});

test('answers are passed as an argument array', () => {
  assert.deepEqual(answerArgs({ question: 'HUM-1', answer: 'no', note: "it's; rm -rf /", overrule: true }),
    ['answer', 'HUM-1', 'no', "--note=it's; rm -rf /", '--overrule']);
  assert.deepEqual(answerArgs({ question: 'HUM-1', answer: 'no', note: '--later' }), ['answer', 'HUM-1', 'no', '--note=--later']);
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
  assert.equal(config.glyphs, 'nerd');
  fs.writeFileSync(file, JSON.stringify({ projects: [{ name: 'p', org: '~/x' }], glyphs: 'plain' }));
  assert.equal(loadConfig(file).glyphs, 'plain');
  fs.writeFileSync(file, JSON.stringify({ projects: [{ name: 'p', org: '~/x' }], glyphs: 'emoji' }));
  assert.throws(() => loadConfig(file), /"glyphs" is "nerd" or "plain"/);
  fs.writeFileSync(file, JSON.stringify({ projects: [{ name: 'p' }] }));
  assert.throws(() => loadConfig(file), /needs "org"/);
});
