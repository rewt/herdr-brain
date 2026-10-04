import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { duration, minimalRows, minimalFrame, sessionStage } from '../modern/minimal.mjs';
import { createMinimalSession } from '../modern/minimal-session.mjs';
import { consoleProfile, normalizeConfig } from '../lib/config.mjs';
import { minimalLayout, checkElapsed } from '../modern/minimal-view.mjs';
import { createIdentityReader } from '../modern/model.mjs';
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
    assert.ok(frame.lines.every(l => cellWidth(l.spans.map(s => s.text).join('')) === width));
    assert.doesNotMatch(text(frame), /\x1b/);
    assert.match(text(frame), /q quit/);
    assert.match(text(frame), /Runs/);
    assert.match(text(frame), /Reports/);
    assert.match(text(frame), /Train/);
  }
  assert.equal(text(minimalFrame({ project, sessions, now }, 100, 12)), text(minimalFrame({ project, sessions, now }, 100, 12)));
});

test('minimal refresh retains last good sources and has no record or scheduling effects', async () => {
  let fail = false, stopped = false, calls = [];
  const config = { projects: [{ name: 'Project', cwd: '/project', org: '/org' }], refresh_seconds: 10 };
  const session = createMinimalSession({ config, env: {}, deps: { identity, now: () => now, details: () => ({}),
    herdrAgents: async () => fail ? { ok: false, error: 'offline' } : { ok: true, agents: stopped ? [] : [agent('worker')] },
    herdrList: async resource => { calls.push(resource); return resource === 'workspace' ? [{ workspace_id: 'main', cwd: '/project' }] : []; },
    orgStatus: async () => { calls.push('status'); return { runs: [run('worker')] }; },
    runs: () => ({ lanes: stopped ? [] : [{ run: 'R-1', item: 'ENG-1', title: 'Current work', stage: 'engineering', provider: 'codex', started: iso(70), running_seconds: 4200 }] }),
  } });
  await session.refresh(); assert.equal(session.model.sessions.length, 1);
  fail = true; await session.refresh(); assert.equal(session.model.sessions.length, 1);
  assert.match(text(session.frame(100, 15)), /agents unavailable/);
  fail = false; stopped = true; await session.refresh(); assert.equal(session.model.sessions.length, 0);
  assert.match(text(session.frame(100, 15)), /No open runs/);
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
  const config = path.join(dir, 'console.json'), clock = path.join(dir, 'clock.mjs'), herdr = path.join(dir, 'herdr'), record = path.join(dir, 'record.mjs'), log = path.join(dir, 'reads.jsonl');
  try {
    assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
    fs.writeFileSync(clock, `const NativeDate = Date; globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [${now}])); } static now() { return ${now}; } };`);
    const events = [
      { type: 'item.added', id: 'ENG-1', title: 'Compact console' },
      { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: fs.realpathSync(dir), meta: { agent: 'worker', harness: 'codex', model: 'gpt-6.1-sol' } },
    ].map((e, i) => ({ seq: i + 1, at: iso(70), by: 'test', ...e }));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(config, JSON.stringify({ profile: 'minimal', projects: [{ name: 'Snapshot', cwd: dir, org: dir }] }));
    fs.writeFileSync(herdr, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const resource = process.argv[2];
const result = resource === 'agent' ? { agents: [{ name: 'supervisor-herdr', agent: 'claude', agent_status: 'working', pane_id: 'p1', cwd: ${JSON.stringify(dir)} }, { name: 'worker', agent: 'codex', agent_status: 'working', pane_id: 'p2', cwd: ${JSON.stringify(dir)} }] } : { [resource + 's']: [] };
console.log(JSON.stringify({ result }));
`, { mode: 0o755 });
    const snapshotStatus = { items: [{ id: 'ENG-1', title: 'Compact console' }], runs: [
      { id: 'R-1', item: 'ENG-1', meta: { agent: 'worker', model: 'gpt-6.1-sol' } },
      { id: 'R-2', item: 'ENG-2', report: { at: '2020-01-02T12:30:00Z', outcome: 'done', headline: 'The headline comes from the record.' } },
    ] };
    fs.writeFileSync(record, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log(${JSON.stringify(JSON.stringify(snapshotStatus))});`);
    fs.mkdirSync(path.join(dir, 'supervisor'));
    fs.writeFileSync(path.join(dir, 'supervisor/inbox.log'), JSON.stringify({ type: 'notice', id: 'n', message: '[org-report] run=R-2 item=ENG-2 check=pass', at: '2020-01-02T12:30:00Z' }) + '\n');
    const env = { ...process.env, HERDR_BIN_PATH: herdr, HERDR_ORG_BIN: record, ORG_FLEET_DIR: path.join(dir, 'no-fleet'), TZ: 'UTC' };
    for (const [width, height] of [[40, 24], [100, 24]]) for (const flags of [[], ['--minimal'], ['--profile', 'minimal']]) {
      const result = spawnSync(process.execPath, ['--import', clock, 'console/app.mjs', ...flags, '--config', config, '--project', 'Snapshot', '--print', `${width}x${height}`, '--keys', 'ny\\ncPSHy\\n'], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const fixture = new URL(`./fixtures/minimal-${width}x${height}.txt`, import.meta.url);
      assert.equal(result.stdout, fs.readFileSync(fixture, 'utf8'));
      assert.match(result.stdout, /R-1\s+│ ENG-1 Compac/);
      assert.match(result.stdout, /done \/ pass/);
      assert.match(result.stdout, width === 40 ? /The headline comes from the recor/ : /The headline comes from the record/);
    }
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(calls.every(args => (['agent', 'workspace', 'pane', 'tab'].includes(args[0]) && args[1] === 'list') || (args[0] === 'status' && args[1] === '--json')));
    assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).profile, 'minimal');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a pane replacement cannot inherit another named agent run; immutable IDs can match a renamed occupant', () => {
  const old = run('old', { id: 'R-1', item: 'ENG-1', meta: { agent: 'old', pane: 'shared', model: 'wrong' } });
  const a = agent('new', { pane: 'shared', session: 'current' });
  const replacement = rows({ agents: [a], status: { runs: [old] } })[0];
  assert.equal(replacement.stage, 'chat'); assert.equal(replacement.run, null); assert.equal(replacement.model, '');
  const same = { ...old, meta: { ...old.meta, agent_session_id: 'current' } };
  assert.equal(rows({ agents: [a], status: { runs: [same] } })[0].run, 'R-1');
  assert.equal(rows({ agents: [a], status: { runs: [{ ...old, meta: { pane: 'shared' } }] } })[0].run, null);
});

test('duplicate project labels select the requested stable ID and repository, including current-workspace discovery', async () => {
  const config = { projects: [{ id: 'p1', name: 'Same', cwd: '/project', org: '/org1' },
    { id: 'p2', name: 'Same', cwd: '/other', org: '/org2' }], refresh_seconds: 10 };
  const visited = [];
  const deps = { identity, now: () => now, details: () => ({}), runs: () => ({ lanes: [] }), journal: () => [], train: () => ({}),
    herdrAgents: async () => ({ ok: true, agents: [] }),
    herdrList: async key => key === 'workspace' ? [{ workspace_id: 'current', cwd: '/other' }] : [],
    orgStatus: async p => { visited.push(p.org); return { runs: [] }; } };
  for (const projectIndex of [1, -1]) {
    const session = createMinimalSession({ config, deps, projectIndex, env: { HERDR_WORKSPACE_ID: 'current' } });
    await session.refresh(); assert.equal(session.project.id, 'p2'); assert.equal(session.project.repoKey, '/other/.git'); session.stop();
  }
  assert.deepEqual(visited, ['/org2', '/org2']);
});

test('work purpose uses item titles; reviewer subject never inherits the reported worker lifecycle', () => {
  const status = { items: [{ id: 'ENG-1', title: 'Better console: operator details' }], runs: [run('worker', {
    id: 'R-1', item: 'ENG-1', report: {}, meta: { agent: 'worker', lane: 'console' } })] };
  const result = rows({ agents: [agent('review', { status: 'idle' })], status,
    details: () => ({ lane: { topic: 'console', role: 'review' } }) });
  assert.equal(result[0].title, 'Better console'); assert.equal(result[0].run, 'R-1'); assert.equal(result[0].stage, 'review');
});

test('feed source failure retains last good data and recovers independently', async () => {
  let fail = false;
  const deps = { identity, now: () => now, details: () => ({}), runs: () => ({ lanes: [] }),
    herdrAgents: async () => ({ ok: true, agents: [] }), herdrList: async () => [],
    orgStatus: async () => ({ runs: [{ id: 'R-1', item: 'ENG-1', report: { at: iso(2), outcome: 'done', headline: 'Ready' } }] }),
    journal: () => { if (fail) throw Error('torn'); return [{ type: 'notice', id: 'n', at: iso(2), message: '[org-report] run=R-1 item=ENG-1 check=pass' }]; },
    train: () => { if (fail) throw Error('bad'); return { waiting: [{ topic: 'next' }], results: [] }; } };
  const session = createMinimalSession({ config: { projects: [{ name: 'Project', cwd: '/project', org: '/org' }] }, deps, env: {} });
  await session.refresh(); fail = true; await session.refresh();
  assert.equal(session.model.reports[0].check, 'pass'); assert.equal(session.model.train.waiting[0].topic, 'next');
  assert.match(text(session.frame(100, 18)), /journal unavailable/); assert.match(text(session.frame(100, 18)), /train unavailable/);
  fail = false; await session.refresh(); assert.deepEqual(session.ui.errors, {}); session.stop();
});

test('narrow and wide frames show active CI, check clocks, refusals and log paths with sparse state colour', () => {
  const reports = [{ at: iso(3), run: 'R-1', item: 'ENG-1', outcome: 'invalid', check: 'fail', headline: 'Fix the report fields', attention: true }];
  const train = { waiting: [{ topic: 'waiting' }], current: { lanes: ['one', 'two'], phase: 'prepared', started: iso(9), command: 'node check.mjs', checkStarted: null },
    results: [{ at: iso(2), topic: 'red', outcome: 'refused', reason: 'validation failed', log: '/project/.git/promote/batches/b/train.log' }] };
  for (const width of [40, 60, 80, 100, 140]) {
    const frame = minimalFrame({ project, reports, train, now }, width, 25);
    assert.match(text(frame), /one, two/); assert.match(text(frame), /Waiting · waiting/);
    assert.match(text(frame), /refused/); assert.match(text(frame), /validation fail/);
    assert.match(text(frame), /train.log/); assert.match(text(frame), /Check unknown/);
    assert.match(text(frame), /invalid \/ fail/);
    assert.equal(minimalLayout({ project, reports, train, now }, width, 25).groups[1][0].lines[0].find(s => s.text.includes('fail')).color, 'yellow');
    assert.ok(frame.lines.every(l => cellWidth(l.spans.map(s => s.text).join('')) === width));
  }
});

test('Runs is an aligned table with short titles, local starts, frozen landed time and dimmed history', () => {
  const runs = [
    { run: 'R-239', item: 'ENG-184', title: 'Copied-product probe regression: details', stage: 'engineering', provider: 'codex', model: 'gpt-6.1-sol', started: iso(20), running_seconds: 1200 },
    { run: 'R-240', item: 'ENG-186', title: '会話 console\x1b[2J (operator details)', stage: 'review', provider: 'claude', model: 'claude-opus-5-5', started: '2026-10-02T12:30:00Z', running_seconds: 3600 },
    { run: 'R-238', item: 'ENG-183', title: 'Done', stage: 'landed', provider: 'codex', model: 'gpt-6.1-sol', started: iso(100), running_seconds: 2400 },
  ];
  for (const width of [40, 60, 80, 100, 140]) {
    const frame = minimalFrame({ project, runs, now }, width, 25), output = text(frame);
    assert.match(output, /Runs · 2 open · 1 landed/); assert.doesNotMatch(output, /Now|details|\x1b/);
    assert.match(output, /Run/); assert.match(output, /Stage/); if (width >= 90) { assert.match(output, /Start/); assert.match(output, /Elapsed/); }
    assert.match(output, /10\/02/); assert.match(output, /40m/);
    assert.ok(frame.lines.every(l => cellWidth(l.spans.map(s => s.text).join('')) === width));
    assert.equal(minimalLayout({ project, runs, now }, width, 25).groups[0].at(-1).dim, true);
    if (width >= 60) {
      const lines = output.split('\n').filter(l => /^│ R-/.test(l));
      assert.equal(lines.length, 3);
      const stages = ['engineering', 'review', 'landed'];
      assert.equal(new Set(lines.map((l, i) => cellWidth(l.slice(0, l.indexOf(stages[i]))))).size, 1);
    }
  }
});

test('configured cwd without org or ID selects its catalog entry and discovers the record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-project-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    const org = path.join(root, '.org'); fs.mkdirSync(org); fs.writeFileSync(path.join(org, 'events.jsonl'), '');
    const visited = [];
    const session = createMinimalSession({ config: { projects: [{ name: 'Local', cwd: root }] }, env: {}, deps: {
      identity: createIdentityReader(), now: () => now, details: () => ({}), herdrAgents: async () => ({ ok: true, agents: [] }),
      herdrList: async () => [], orgStatus: async p => { visited.push(p.org); return { runs: [] }; },
      journal: () => [], train: () => ({}), runs: () => ({ lanes: [] }),
    } });
    await session.refresh();
    assert.equal(session.project.id, 'configured:Local'); assert.equal(session.project.org, fs.realpathSync(org));
    assert.deepEqual(visited, [fs.realpathSync(org)]); assert.match(text(session.frame(80, 24)), /Local/); session.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('finished check duration freezes while delivery waits; a running check advances', () => {
  const check = { checkStarted: iso(10), checkFinished: iso(8), checkComplete: true, checkDurationSeconds: 120 };
  assert.equal(checkElapsed(check, now), '2m'); assert.equal(checkElapsed(check, now + 3600000), '2m');
  assert.equal(checkElapsed({ ...check, checkDurationSeconds: null }, now + 3600000), '2m');
  assert.equal(checkElapsed({ ...check, checkComplete: false }, now + 60000), '11m');
  for (const time of [now, now + 3600000]) assert.match(text(minimalFrame({ now: time, train: { current: { lanes: ['lane'], command: 'node check', ...check } } }, 60, 24)), /2m · finished/);
});
