import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { duration, minimalRows, minimalFrame, sessionStage } from '../modern/minimal.mjs';
import { createMinimalSession } from '../modern/minimal-session.mjs';
import { consoleProfile, normalizeConfig } from '../lib/config.mjs';
import { createPainter } from '../modern/paint.mjs';
import { cellWidth } from '../lib/text.mjs';

const now = Date.parse('2026-10-04T17:00:00Z');
const iso = minutes => new Date(now - minutes * 60000).toISOString();
const identity = cwd => ({ key: cwd.startsWith('/project') ? '/project/.git' : '/other/.git', root: '/project', git: true, cwd });
const project = { name: 'Project', repoKey: '/project/.git' };
const agent = (name, extra = {}) => ({ name, pane: name, workspace: 'main', cwd: '/project/lane', tool: 'codex', status: 'working', ...extra });
const run = (name, extra = {}) => ({ meta: { agent: name, harness: 'codex', model: 'gpt-6.1-sol' }, workspace: '/project/lane', started: { at: iso(70) }, ...extra });
const rows = extra => minimalRows({ project, identity, now, ...extra });
const text = frame => frame.lines.map(l => l.spans.map(s => s.text).join('').trimEnd()).join('\n') + '\n';

test('minimal provider uses the live harness; metadata supplies the known model and actual launch', () => {
  const result = rows({ agents: [agent('worker'), agent('chat', { tool: 'claude', status: 'idle' })], status: { runs: [run('worker')] },
    details: a => a.name === 'worker' ? { lane: { created_at: iso(65), model: 'gpt-6.1-sol' } } : { transcript: { model: 'claude-opus-5-5', firstAt: iso(20) } } });
  assert.deepEqual(result.map(r => [r.name, r.provider, r.model, r.stage, r.started, r.elapsed]), [
    ['worker', 'Codex', 'gpt-6.1-sol', 'engineering', iso(65), '1h 5m'],
    ['chat', 'Claude', 'claude-opus-5-5', 'chat', iso(20), '20m'],
  ]);
  assert.equal(rows({ agents: [agent('unknown', { tool: 'other' })] })[0].provider, 'unknown');
});

test('minimal stages come from structured roles, correction origins and established session names', () => {
  assert.equal(sessionStage(agent('worker'), run('worker')), 'engineering');
  assert.equal(sessionStage(agent('worker'), null, { role: 'engineer-xhigh' }), 'engineering');
  assert.equal(sessionStage(agent('lane-a-123456-abcdef'), null, { role: 'review-codex' }), 'review');
  assert.equal(sessionStage(agent('settle-r-32')), 'review');
  assert.equal(sessionStage(agent('review-copy')), 'review');
  assert.equal(sessionStage(agent('supervisor-herdr')), 'supervisor');
  assert.equal(sessionStage(agent('worker'), run('worker'), null, { fromRun: 'R-1' }), 'fix');
  assert.equal(sessionStage(agent('worker'), { meta: { stage: 'correction' } }), 'fix');
  assert.equal(sessionStage(agent('operator', { title: 'Review and fix engineering supervisor work' })), 'chat');
});

test('durations retain minutes, handle days, and never invent unknown or future starts', () => {
  for (const [minutes, expected] of [[0, '0m'], [59, '59m'], [60, '1h 0m'], [1440, '1d 0h'], [2945, '2d 1h'], [-10, '0m']]) assert.equal(duration(iso(minutes), now), expected);
  assert.equal(duration(null, now), 'unknown');
  assert.equal(duration('invalid', now), 'unknown');
});

test('working first then newest, stable ties, canonical scope and live cwd win over workspace labels', () => {
  const agents = [agent('old', { started: iso(100) }), agent('idle', { status: 'idle', started: iso(1) }), agent('new', { started: iso(10) }),
    agent('outside', { cwd: '/other', workspace: 'main' }), agent('inside', { workspace: 'elsewhere', started: iso(10) }),
    agent('a-unknown', { status: 'idle' }), agent('b-unknown', { status: 'idle' })];
  assert.deepEqual(rows({ agents }).map(r => r.name), ['inside', 'new', 'old', 'idle', 'a-unknown', 'b-unknown']);
  assert.equal(rows({ agents, project: null }).length, 0);
  assert.deepEqual(rows({ agents: [agent('no-cwd', { cwd: null })], workspaces: [{ workspace_id: 'main', cwd: '/project' }] }).map(r => r.name), ['no-cwd']);
});

test('finished workers drop off when settled, idle chats stay, working and blocked reports remain visible', () => {
  const agents = ['idle', 'done', 'working', 'blocked'].map(status => agent(status, { status }));
  agents.push(agent('chat', { status: 'done' }), agent('closed-review', { status: 'done', role: 'review' }));
  const runs = agents.slice(0, 4).map(a => run(a.name, { report: { outcome: 'done' } }));
  assert.deepEqual(rows({ agents, status: { runs } }).map(r => r.name), ['working', 'blocked', 'chat']);
  assert.equal(rows({ agents: [agent('gone', { status: 'idle' })], status: { runs: [run('gone', { abandoned: {} })] } }).length, 0);
  assert.equal(rows({ agents: [], status: { runs: [run('gone')] } }).length, 0);
  assert.equal(rows({ agents: [agent('pending-shell', { tool: null, session: null, status: 'unknown' })] }).length, 0);
});

test('a replacement session cannot inherit a report or model tied to another session ID', () => {
  const result = rows({ agents: [agent('same', { session: 'new', status: 'idle' })], status: { runs: [{ ...run('same'), meta: { agent: 'same', agent_session_id: 'old', model: 'wrong' }, report: {} }] } });
  assert.equal(result[0].stage, 'chat'); assert.equal(result[0].model, '');
});

test('minimal frame is bounded, safe with Unicode, clear about overflow and quiet when unchanged', () => {
  const sessions = rows({ agents: Array.from({ length: 20 }, (_, i) => agent(`会話-${i}\x1b[2J`, { started: iso(i) })) });
  for (const width of [40, 80, 100, 140]) {
    const frame = minimalFrame({ project, sessions, now }, width, 12);
    assert.equal(frame.lines.length, 12);
    assert.ok(frame.lines.every(l => cellWidth(l.spans[0].text) === width));
    assert.doesNotMatch(text(frame), /\x1b/);
    assert.match(text(frame), /q quit/);
    if (width >= 80) assert.match(text(frame), /\+13 more/);
  }
  let writes = 0;
  const painter = createPainter({ write: () => writes++, color: () => undefined });
  const frame = minimalFrame({ project, sessions, now }, 100, 12);
  painter.paint(frame.lines); painter.paint(frame.lines);
  assert.equal(writes, 1);
});

test('minimal refresh retains last good sources, recovers, accepts only quit and has no action effects', async () => {
  let fail = false, stopped = false, calls = [];
  const config = { projects: [{ name: 'Project', cwd: '/project', org: '/org' }], refresh_seconds: 10 };
  const session = createMinimalSession({ config, env: {}, deps: { identity, now: () => now, details: () => ({}),
    herdrAgents: async () => fail ? { ok: false, error: 'offline' } : { ok: true, agents: stopped ? [] : [agent('worker')] },
    herdrList: async resource => { calls.push(resource); return resource === 'workspace' ? [{ workspace_id: 'main', cwd: '/project' }] : []; },
    orgStatus: async () => { calls.push('status'); return { runs: [run('worker')] }; },
  } });
  await session.refresh(); assert.equal(session.model.sessions.length, 1);
  fail = true; await session.refresh(); assert.equal(session.model.sessions.length, 1);
  assert.match(text(session.frame(100, 15)), /agents unavailable/);
  fail = false; stopped = true; await session.refresh(); assert.equal(session.model.sessions.length, 0);
  assert.match(text(session.frame(100, 15)), /No active sessions/);
  for (const input of ['c', 'd', 'n', 'P', 'H', 'y', '\n', '\x1b']) assert.equal(await session.key(input), false);
  assert.equal(await session.mouse({ button: 'left' }), false);
  assert.equal(await session.key('q'), true);
  assert.equal(await session.key('c', { ctrl: true }), true);
  assert.ok(calls.every(x => ['workspace', 'pane', 'tab', 'status'].includes(x)));
  session.stop();
});

test('profile preferences validate, are read without creation, and explicit full overrides minimal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-config-')), file = path.join(dir, 'console.json');
  try {
    assert.equal(consoleProfile(file), 'full'); assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, JSON.stringify({ profile: 'minimal' }));
    assert.equal(consoleProfile(file), 'minimal'); assert.equal(consoleProfile(file, 'full'), 'full');
    assert.equal(normalizeConfig({ profile: 'minimal' }, file, { allowUnmanaged: true }).profile, 'minimal');
    assert.throws(() => consoleProfile(file, 'invalid'), /profile/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--print snapshot works for the flag and configured profile; action keys issue only reads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-print-'));
  const config = path.join(dir, 'console.json'), herdr = path.join(dir, 'herdr'), record = path.join(dir, 'record.mjs'), log = path.join(dir, 'reads.jsonl');
  try {
    fs.writeFileSync(config, JSON.stringify({ profile: 'minimal', projects: [{ name: 'Snapshot', cwd: dir, org: dir }] }));
    fs.writeFileSync(herdr, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const resource = process.argv[2];
const result = resource === 'agent' ? { agents: [{ name: 'supervisor-herdr', agent: 'claude', agent_status: 'working', pane_id: 'p1', cwd: ${JSON.stringify(dir)} }] } : { [resource + 's']: [] };
console.log(JSON.stringify({ result }));
`, { mode: 0o755 });
    fs.writeFileSync(record, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log(JSON.stringify({ items: [], runs: [] }));`);
    const env = { ...process.env, HERDR_BIN_PATH: herdr, HERDR_ORG_BIN: record, ORG_FLEET_DIR: path.join(dir, 'no-fleet'), TZ: 'UTC' };
    for (const flags of [[], ['--minimal'], ['--profile', 'minimal']]) {
      const result = spawnSync(process.execPath, ['console/app.mjs', ...flags, '--config', config, '--project', 'Snapshot', '--print', '100x14', '--keys', 'ny\\ncPSHy\\n'], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, fs.readFileSync(new URL('./fixtures/minimal-100x14.txt', import.meta.url), 'utf8'));
    }
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(calls.every(args => (['agent', 'workspace', 'pane', 'tab'].includes(args[0]) && args[1] === 'list') || (args[0] === 'status' && args[1] === '--json')));
    assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).profile, 'minimal');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
