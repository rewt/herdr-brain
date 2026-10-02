// What the 0.0.2 screen reads besides org: Herdr's agents and tabs, and transcripts
// found by their session id. Fixtures only; nothing here runs Herdr.
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentNames, createSessionReader, parseAgentList, parseTabList, projectSlugs } from '../lib/sources.mjs';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const DIRS = [path.join(FIX, 'claude-a'), path.join(FIX, 'claude-b')];

test('Claude project folders and agent-name entries keep their observed on-disk shape', () => {
  assert.deepEqual(projectSlugs('/Users/example/development/example/herdr-brain'), [
    '-Users-example-development-example-herdr-brain',
  ]);

  const sessionId = 'synthetic-session-id';
  const transcript = [
    { type: 'custom-title', customTitle: 'settle-r-99-0000', sessionId },
    { type: 'agent-name', agentName: 'settle-r-99-0000', sessionId },
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'permission-mode', permissionMode: 'auto', sessionId },
    { parentUuid: null, isSidechain: false, attachment: { type: 'hook_success' }, type: 'attachment', sessionId },
  ].map(JSON.stringify).join('\n');
  assert.deepEqual([...agentNames(transcript)], ['settle-r-99-0000']);
});

test('Herdr agents keep their tool, title and session id; tabs keep their labels', () => {
  const agents = parseAgentList(JSON.stringify({ result: { agents: [
    { agent: 'claude', agent_status: 'working', cwd: '/tmp/lane', pane_id: 'w1:p2', tab_id: 'w1:t2', workspace_id: 'w1',
      terminal_title: '✳ Building the screen', terminal_title_stripped: 'Building the screen',
      agent_session: { agent: 'claude', kind: 'id', value: '5e55-0001' }, name: 'lane-x' },
    { agent: 'codex', agent_status: 'idle', pane_id: 'w2:p1', tab_id: 'w2:t1' },
  ] } }));
  assert.deepEqual(agents, [
    { name: 'lane-x', status: 'working', tab: 'w1:t2', pane: 'w1:p2', cwd: '/tmp/lane', workspace: 'w1', tool: 'claude', title: 'Building the screen', session: '5e55-0001' },
    { name: null, status: 'idle', tab: 'w2:t1', pane: 'w2:p1', cwd: null, workspace: null, tool: 'codex', title: null, session: null },
  ]);
  assert.deepEqual(parseTabList('{"result":{"tabs":[{"tab_id":"w1:t2","label":"cli","number":2,"workspace_id":"w1"}]}}'),
    [{ tab: 'w1:t2', label: 'cli', number: 2, workspace: 'w1' }]);
  assert.throws(() => parseTabList('{"result":{}}'), /unexpected/);
});

test('a transcript is found by session id, in its folder or any other, and gives model, start and last message', () => {
  const reader = createSessionReader();
  const here = reader.transcript({ configDirs: DIRS, cwd: '/tmp/lane', id: '5e55-0001' });
  assert.deepEqual(here, {
    file: path.join(FIX, 'claude-a/projects/-tmp-lane/5e55-0001.jsonl'),
    model: 'claude-fable-5-1',
    firstAt: '2026-09-16T19:30:00.000Z',
    note: { text: '## Done\n\nThe screen is **built**.', at: '2026-09-16T20:49:00.000Z' },
  });
  // The session started in another folder than the agent's cwd now.
  const there = reader.transcript({ configDirs: DIRS, cwd: '/tmp/lane', id: '5e55-0002' });
  assert.equal(there.file, path.join(FIX, 'claude-b/projects/-tmp-elsewhere/5e55-0002.jsonl'));
  assert.equal(there.model, 'claude-sonnet-5');
  assert.equal(reader.transcript({ configDirs: DIRS, cwd: '/tmp/lane', id: 'nope' }), null);
  assert.equal(reader.transcript({ configDirs: DIRS, cwd: '/tmp/lane', id: '../x' }), null, 'an id is a file name, never a path');
  // By agent name when Herdr gives no session id.
  const named = reader.transcript({ configDirs: DIRS, cwd: '/tmp/proj', name: 'settle-r-12-1611' });
  assert.equal(named.file, path.join(FIX, 'claude-b/projects/-tmp-proj/abc.jsonl'));
  assert.equal(named.firstAt, '2026-09-16T16:00:00.000Z');
  assert.equal(named.model, null);
});

test('a missing session id is not searched for again until the folders change', () => {
  let listed = 0;
  const fsApi = { ...nodeFs, readdirSync: (...a) => { listed++; return nodeFs.readdirSync(...a); } };
  let clock = 0;
  const reader = createSessionReader({ fsApi, now: () => clock });
  reader.transcript({ configDirs: DIRS, cwd: '/tmp/lane', id: 'nope' });
  const first = listed;
  assert.ok(first > 0);
  reader.transcript({ configDirs: DIRS, cwd: '/tmp/lane', id: 'nope' });
  assert.equal(listed, first, 'a miss is remembered');
  clock = 61000;
  reader.transcript({ configDirs: DIRS, cwd: '/tmp/lane', id: 'nope' });
  assert.ok(listed > first, 'and searched again after a minute');
});

test('a transcript looked up by agent name reads only transcripts written since the lower bound', () => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'console-transcripts-'));
  const folder = path.join(dir, 'projects', '-tmp-named');
  nodeFs.mkdirSync(folder, { recursive: true });
  const line = (e) => `${JSON.stringify(e)}\n`;
  const old = path.join(folder, 'old.jsonl');
  const fresh = path.join(folder, 'fresh.jsonl');
  nodeFs.writeFileSync(old, line({ type: 'agent-name', agentName: 'someone-else' }));
  nodeFs.writeFileSync(fresh, line({ type: 'agent-name', agentName: 'lane-named' }) + line({ type: 'user', timestamp: '2026-09-16T20:00:00.000Z' }));
  const since = Date.parse('2026-09-16T05:00:00Z');
  nodeFs.utimesSync(old, new Date(since - 86400000), new Date(since - 86400000));
  nodeFs.utimesSync(fresh, new Date(since + 3600000), new Date(since + 3600000));
  const opened = [];
  const fsApi = { ...nodeFs, openSync: (file, ...a) => { opened.push(path.basename(file)); return nodeFs.openSync(file, ...a); } };
  const reader = createSessionReader({ fsApi });
  assert.equal(reader.transcript({ configDirs: [dir], cwd: '/tmp/named', name: 'lane-named', sinceMs: since }).file, fresh);
  assert.equal(reader.transcript({ configDirs: [dir], cwd: '/tmp/named', name: 'nobody', sinceMs: since }), null);
  assert.ok(!opened.includes('old.jsonl'), `opened: ${opened.join(', ')}`);
  // Without a bound, both are read: the bound is what keeps old transcripts closed.
  opened.length = 0;
  createSessionReader({ fsApi }).transcript({ configDirs: [dir], cwd: '/tmp/named', name: 'nobody' });
  assert.ok(opened.includes('old.jsonl'));
});

test('a live lane session record is found by name or transcript id; completed records are ignored', () => {
  const repo = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'console-lane-registry-'));
  const directory = path.join(repo, '.lane', 'sessions.json.d');
  nodeFs.mkdirSync(directory, { recursive: true });
  nodeFs.writeFileSync(path.join(directory, 'broken.json'), '{');
  const record = {
    session_id: 'f7e834b7-2ae7-4a7c-a444-36cb88c97942',
    agent_session_id: 'claude-session-9',
    name: 'lane-console-729a9a-7f2c',
    topic: 'console',
    role: 'review',
  };
  nodeFs.writeFileSync(path.join(directory, `${record.session_id}.json`), JSON.stringify(record));
  const reader = createSessionReader();
  assert.deepEqual(reader.laneSession({ repoRoot: repo, name: record.name }), record);
  assert.deepEqual(reader.laneSession({ repoRoot: repo, sessionId: record.agent_session_id }), record);
  assert.equal(reader.laneSession({ repoRoot: repo, name: 'not-there' }), null);

  nodeFs.writeFileSync(path.join(directory, `${record.session_id}.done.json`), '{}');
  assert.equal(reader.laneSession({ repoRoot: repo, name: record.name }), null);
  assert.equal(reader.laneSession({ repoRoot: repo, sessionId: record.agent_session_id }), null);

  const doneRecord = { session_id: 'done-in-record', name: 'lane-done-a1b2c3-d4e5f6', topic: 'done', done: true };
  nodeFs.writeFileSync(path.join(directory, `${doneRecord.session_id}.json`), JSON.stringify(doneRecord));
  assert.equal(reader.laneSession({ repoRoot: repo, name: doneRecord.name }), null);
});
