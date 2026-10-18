import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fold } from '../lib/state.mjs';
import { gitProject } from '../lib/project.mjs';
import { projectSummary, publishProjectSummary, writeProjectSummary, publishedSummaryStatus, readProjectReleaseIds } from '../lib/project-summary.mjs';
import { renderProjectSummary } from '../lib/render.mjs';
import { supervisorStatus, renderStatus } from '../supervisor/status.mjs';
import { readRetirementStatus } from '../lib/retire-runtime.mjs';
import { brainSource, brainSourceSync } from '../board/brain.mjs';
import { brainFixture } from './helpers/board-fixture.mjs';
import { BIN } from './helpers.mjs';

const NOW = '2026-10-17T18:00:00.000Z', EARLIER = '2026-10-17T16:00:00.000Z';
const SECRET = 'PLANTED-PRIVATE-CONTENT', FOREIGN = '/outside/another-project/private';
function events(workspace) {
  return [
    { type: 'item.added', id: 'ENG-1', role: 'engineer', title: 'Publish a useful summary', meta: { secret: SECRET, path: FOREIGN }, accept: [SECRET] },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace, brief_path: FOREIGN, report_path: FOREIGN,
      meta: { agent: 'owner-one', secret: SECRET, harness: 'opaque-provider', model: SECRET } },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'done', headline: 'The summary is available', summary: SECRET, extra: { password: SECRET } } },
    { type: 'note.added', id: 'ENG-1', decision: true, summary: 'Use the owning record', text: SECRET },
    { type: 'note.added', id: 'ENG-1', decision: true, text: SECRET },
    { type: 'item.added', id: 'HUM-1', role: 'human', title: 'Keep the existing cadence?', meta: { answer: SECRET } },
    { type: 'item.closed', id: 'HUM-1', as: 'done', note: SECRET },
    { type: 'item.added', id: 'ENG-2', role: 'engineer', title: 'Still running' },
    { type: 'run.started', id: 'R-2', item: 'ENG-2', workspace, meta: { agent: 'owner-two' } },
  ].map((e, i) => ({ ...e, seq: i + 1, at: EARLIER, by: 'fixture' }));
}
function inputs() {
  const state = fold(events('/project/lane'));
  return { project: { identity: '/project/.git', canonical: '/project' }, state, now: NOW,
    releases: { current: 'green-1', pinned: 'blue-1', secret: SECRET, path: FOREIGN },
    jobs: [{ id: 'landing', run: 'R-1', outcome: 'promoted', integrated_at: EARLIER, secret: SECRET, log: FOREIGN },
      { id: 'not-landed', run: 'R-2', outcome: 'failed', finished: EARLIER }],
    lanes: { counts: { ACTIVE: 2, WAITING: 2, UNKNOWN: 1, secret: SECRET }, secret: SECRET, rows: [
      { type: 'tab', class: 'ACTIVE', run: 'R-2', item: 'ENG-2', agent: 'owner-two', reason: SECRET, worktree: FOREIGN },
      { type: 'pane', class: 'ACTIVE', run: 'R-2', item: 'ENG-2', agent: 'owner-two' },
      { type: 'tab', class: 'WAITING', run: 'R-1', item: 'ENG-1', agent: 'owner-one', nextAction: 'reviewer REV-1: review ENG-1' },
      { type: 'diagnostic', class: 'UNKNOWN', reason: SECRET, nextAction: SECRET },
    ] }, exceptions: [SECRET] };
}
function fixture(t, name = 'project') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'summary-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, name), org = path.join(repo, '.org'), releaseHome = path.join(root, 'releases');
  fs.mkdirSync(repo); fs.mkdirSync(org); fs.mkdirSync(releaseHome);
  const git = args => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'seed'), 'seed'); git(['add', 'seed']); git(['commit', '-qm', 'seed']);
  const project = gitProject(repo), eventBytes = events(repo).map(e => JSON.stringify(e) + '\n').join('');
  fs.writeFileSync(path.join(org, 'events.jsonl'), eventBytes);
  fs.mkdirSync(path.join(project.identity, 'promote'));
  const queue = { identity: project.identity, pending: [], results: [
    { id: 'landing', run: 'R-1', org, outcome: 'promoted', integrated_at: EARLIER, finished: EARLIER, secret: SECRET },
    { id: 'foreign-record', run: 'R-2', org: FOREIGN, outcome: 'promoted', integrated_at: EARLIER },
    { id: 'yesterday', run: 'R-2', org, outcome: 'promoted', integrated_at: '2026-10-15T12:00:00Z' },
  ] };
  fs.writeFileSync(path.join(project.identity, 'promote/queue.json'), JSON.stringify(queue));
  fs.symlinkSync(path.join(releaseHome, 'releases/green-1'), path.join(releaseHome, 'current'));
  const env = { ...process.env, ORG_DIR: org, ORG_NOW: NOW, HERDR_MONITOR_HOME: releaseHome, ORG_ACTOR: 'summary-fixture',
    HERDR_MONITOR_FLEET: path.join(root, 'fleet'), MONITOR_TEST_SLOT_PATH: path.join(root, 'slot'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(root, 'slot'), XDG_STATE_HOME: path.join(root, 'state') };
  const calls = [];
  const command = (exe, args, options) => {
    calls.push([exe, args]);
    if (exe === 'git') return spawnSync(exe, args, options);
    assert.equal(exe, 'fixture-herdr');
    assert.ok(['workspace list', 'agent list'].includes(args.slice(0, 2).join(' ')), `unexpected Herdr access: ${args}`);
    return { status: 0, stdout: JSON.stringify({ result: args[0] === 'workspace' ? { workspaces: [] } : { agents: [] } }) };
  };
  const publish = extra => publishProjectSummary({ cwd: repo, org, command, herdr: 'fixture-herdr', env, now: NOW, ...extra });
  const cli = (args, cwd = repo) => spawnSync(process.execPath, [BIN, 'summary', ...args], { cwd, env, encoding: 'utf8' });
  return { root, repo, org, project, git, env, calls, command, publish, cli, eventBytes, releaseHome };
}

test('publication allowlist excludes injected private fields and bodies, while useful facts survive', () => {
  const input = inputs(), doc = projectSummary(input), bytes = JSON.stringify(doc) + renderProjectSummary(doc);
  assert.doesNotMatch(bytes, new RegExp(`${SECRET}|${FOREIGN}|opaque-provider|secret|report_path|brief_path`));
  assert.deepEqual(Object.keys(doc), ['schema', 'project', 'generated_at', 'stale_after_seconds', 'status', 'today', 'lanes', 'releases', 'exceptions']);
  assert.equal(doc.status.counts.done, 2); assert.equal(doc.status.counts.active, 1);
  assert.deepEqual(doc.today.landings, [{ item: 'ENG-1', run: 'R-1', at: EARLIER, summary: 'The summary is available' }]);
  assert.equal(doc.today.decisions.length, 3);
  assert.ok(doc.today.decisions.some(r => r.summary === 'Use the owning record'));
  assert.ok(doc.today.decisions.some(r => r.summary === 'Keep the existing cadence?'));
  assert.ok(doc.exceptions.some(e => e.name === 'decision-summary-missing'));
  assert.deepEqual(doc.releases, { current: 'green-1', pinned: 'blue-1' });
  assert.deepEqual(doc.lanes.counts, { TERMINAL: 0, ACTIVE: 2, WAITING: 2, 'IDLE-NONTERMINAL': 0, UNKNOWN: 1, PROTECTED: 0 });
  assert.equal(doc.lanes.oldest_unresolved.length, 3, 'tab/pane duplicates are coalesced in the oldest list');
  assert.ok(doc.lanes.oldest_unresolved.some(r => r.owner === 'reviewer REV-1: review ENG-1' && r.age_seconds === 7200));
  assert.ok(doc.lanes.oldest_unresolved.some(r => r.age_seconds === null && r.owner === null));
});

test('allowed editorial strings redact paths and common credentials; raw note text is never a fallback', () => {
  const input = inputs();
  input.state.items.get('ENG-1').notes[0].summary = `Read ${FOREIGN} then https://example.invalid/private`;
  input.state.runs.get('R-1').report.headline = 'password=do-not-publish';
  const doc = projectSummary(input), bytes = JSON.stringify(doc) + renderProjectSummary(doc);
  assert.doesNotMatch(bytes, /outside|example\.invalid|do-not-publish|PLANTED/);
  assert.ok(doc.today.decisions.some(r => r.summary === 'Read [path] then [path]'));
  assert.equal(doc.today.landings[0].summary, '[redacted]');
});

test('identical inputs give byte-identical JSON and Markdown, including after publication', t => {
  const input = inputs();
  assert.equal(JSON.stringify(projectSummary(input)), JSON.stringify(projectSummary(structuredClone(input))));
  const f = fixture(t), first = f.publish();
  const json = fs.readFileSync(path.join(f.org, 'published/summary.json')), markdown = fs.readFileSync(path.join(f.org, 'published/summary.md'));
  const target = fs.readlinkSync(path.join(f.org, 'published'));
  assert.deepEqual(f.publish(), first);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'published/summary.json')), json);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'published/summary.md')), markdown);
  assert.equal(fs.readlinkSync(path.join(f.org, 'published')), target);
  assert.equal(first.today.landings.length, 1, 'foreign-record and previous-day promotions are excluded');
  assert.equal(first.releases.current, 'green-1'); assert.equal(first.releases.pinned, null);
  assert.ok(first.exceptions.some(e => e.name === 'release-pin-unavailable'));
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), f.eventBytes);
  assert.ok(f.calls.some(([exe]) => exe === 'fixture-herdr'));
});

test('two owning projects publish independently and cannot replace each other in a shared record', t => {
  const a = fixture(t, 'alpha'), b = fixture(t, 'beta');
  a.publish(); b.publish();
  const read = f => fs.readFileSync(path.join(f.org, 'published/summary.json'), 'utf8');
  const before = read(a), other = read(b);
  assert.notEqual(JSON.parse(before).project.id, JSON.parse(other).project.id);
  assert.equal(JSON.parse(before).project.name, 'alpha'); assert.equal(JSON.parse(other).project.name, 'beta');
  a.publish({ now: '2026-10-17T18:01:00Z' });
  assert.equal(read(b), other);
  assert.throws(() => b.publish({ org: a.org }), /different canonical project/);
  assert.equal(read(b), other);
  assert.equal(publishedSummaryStatus(a.org, { now: NOW, project: b.project }).status, 'invalid');
});

test('freshness reports exact age, stale and missing without inventing contents or observation times', t => {
  const f = fixture(t);
  assert.deepEqual(publishedSummaryStatus(f.org, { now: NOW }), { status: 'missing', generated_at: null, age_seconds: null, stale_after_seconds: null });
  assert.equal(f.cli(['--json']).status, 0); assert.equal(JSON.parse(f.cli(['--json']).stdout).status, 'missing');
  assert.equal(fs.existsSync(path.join(f.org, 'published')), false);
  f.publish();
  assert.deepEqual(publishedSummaryStatus(f.org, { now: '2026-10-17T18:30:01Z' }), {
    status: 'stale', generated_at: NOW, age_seconds: 1801, stale_after_seconds: 1800,
  });
  assert.equal(publishedSummaryStatus(f.org, { now: '2026-10-17T18:30:00Z' }).status, 'fresh');
  const doc = supervisorStatus({ cwd: f.repo, org: f.org, agents: [], now: '2026-10-17T18:30:01Z' });
  assert.equal(doc.published_summary.status, 'stale'); assert.match(renderStatus(doc), /stale; age 1801s/);
  assert.equal(publishedSummaryStatus(f.org, { now: '2026-10-17T17:59:00Z' }).status, 'invalid');
  fs.writeFileSync(path.join(f.org, 'published/summary.json'), '{bad');
  assert.equal(publishedSummaryStatus(f.org, { now: NOW }).status, 'invalid');
});

test('one rename publishes the complete pair; a failed switch preserves both prior files and releases its lock', t => {
  const f = fixture(t), old = f.publish();
  const next = { ...old, generated_at: '2026-10-17T18:01:00.000Z' };
  const read = name => fs.readFileSync(path.join(f.org, 'published', name), 'utf8');
  const previous = [read('summary.json'), read('summary.md')], rename = fs.renameSync;
  let switches = 0;
  fs.renameSync = (from, to) => {
    switches++;
    assert.equal(to, path.join(f.org, 'published')); assert.equal(path.dirname(from), f.org);
    assert.deepEqual([read('summary.json'), read('summary.md')], previous);
    assert.equal(JSON.parse(fs.readFileSync(path.join(from, 'summary.json'), 'utf8')).generated_at, next.generated_at);
    assert.match(fs.readFileSync(path.join(from, 'summary.md'), 'utf8'), /18:01:00/);
    throw Error('injected switch failure');
  };
  try { assert.throws(() => writeProjectSummary(f.org, next), /injected switch failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(switches, 1); assert.deepEqual([read('summary.json'), read('summary.md')], previous);
  assert.equal(fs.existsSync(path.join(f.org, '.summary-publish.lock')), false);
  writeProjectSummary(f.org, next);
  assert.equal(JSON.parse(read('summary.json')).generated_at, next.generated_at);
  assert.match(read('summary.md'), /18:01:00/);
  writeProjectSummary(f.org, { ...next, generated_at: '2026-10-17T18:02:00.000Z' });
  assert.equal(fs.readdirSync(path.join(f.org, '.published-summaries')).length, 2);
});

test('canonical publish CLI reports unavailable sources by name and refuses linked worktree publication', t => {
  const f = fixture(t), herdr = path.join(f.root, 'herdr');
  fs.writeFileSync(herdr, '#!/bin/sh\necho "private-source-error" >&2\nexit 1\n', { mode: 0o755 });
  const r = f.cli(['publish', '--json', '--herdr', herdr]);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.ok(doc.exceptions.some(e => e.name === 'lanes-unavailable')); assert.ok(doc.lanes.counts.UNKNOWN > 0);
  assert.doesNotMatch(r.stdout, /private-source-error|outside|PLANTED|report_path/);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'published/summary.json'), 'utf8'), r.stdout);
  const lane = path.join(f.root, 'lane'); f.git(['worktree', 'add', '-b', 'lane/test', lane]);
  const before = fs.readFileSync(path.join(f.org, 'published/summary.json'));
  const refused = f.cli(['publish', '--herdr', herdr], lane);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /canonical project checkout/);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'published/summary.json')), before);
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), f.eventBytes);
});

test('release reader follows only release-status link metadata and never treats a candidate as active', t => {
  const f = fixture(t);
  assert.deepEqual(readProjectReleaseIds(f.project, { env: f.env }), { current: 'green-1', pinned: null });
  fs.unlinkSync(path.join(f.releaseHome, 'current')); fs.symlinkSync(FOREIGN, path.join(f.releaseHome, 'current'));
  assert.equal(readProjectReleaseIds(f.project, { env: f.env }).current, null);
  fs.unlinkSync(path.join(f.releaseHome, 'current'));
  assert.equal(readProjectReleaseIds(f.project, { env: f.env }).current, null);
});

test('conflicting publishers preserve the previous generation and a later retry succeeds', t => {
  const f = fixture(t); f.publish();
  const before = fs.readFileSync(path.join(f.org, 'published/summary.json'));
  const lock = path.join(f.org, '.summary-publish.lock'); fs.mkdirSync(lock);
  assert.throws(() => f.publish(), /EEXIST/);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'published/summary.json')), before);
  fs.rmdirSync(lock); f.publish();
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'published/summary.json')), before);
});

test('published promotion classes match the lanes view for pending jobs and expired incomplete reconciliation', async t => {
  const f = fixture(t);
  const queue = { identity: f.project.identity, pending: [
    { id: 'pending', run: 'R-2', org: f.org, topic: 'topic', queued: EARLIER },
  ], results: [
    { id: 'old-reconcile', run: 'R-1', org: f.org, outcome: 'promoted',
      finished: '2020-01-01T00:00:00Z', reconciliation: { state: 'pending' } },
  ] };
  fs.writeFileSync(path.join(f.project.identity, 'promote/queue.json'), JSON.stringify(queue));
  const published = f.publish();
  assert.ok(f.calls.every(([exe, args]) => exe !== 'git' || (!args.includes('ls-files') && !args.includes('--untracked-files=all'))));
  const lanes = await readRetirementStatus({ cwd: f.repo, org: f.org, herdr: 'fixture-herdr', command: f.command, env: f.env });
  assert.deepEqual(lanes.rows.filter(r => r.type === 'promotion').map(r => [r.id, r.class, r.status]), [['pending', 'ACTIVE', 'queued']]);
  assert.deepEqual(published.lanes.counts, lanes.counts);
  assert.deepEqual(published.lanes.oldest_unresolved.map(r => [r.items, r.class]), [[['ENG-2'], 'ACTIVE']]);
  assert.equal(published.lanes.counts.UNKNOWN, 0);
  assert.ok(!published.exceptions.some(e => e.name === 'lanes-unknown'));
});

test('published lane counts match detailed status for clean, dirty, occupied, open-chain and open-run lanes', async t => {
  const f = fixture(t), clean = path.join(f.root, 'clean'), dirty = path.join(f.root, 'dirty');
  f.git(['worktree', 'add', '-b', 'lane/clean', clean]);
  f.git(['worktree', 'add', '-b', 'lane/dirty', dirty]); fs.writeFileSync(path.join(dirty, 'seed'), 'work in progress');
  const occupied = path.join(f.root, 'occupied'), chain = path.join(f.root, 'chain'), running = path.join(f.root, 'running');
  for (const [name, cwd] of [['occupied', occupied], ['chain', chain], ['running', running]]) f.git(['worktree', 'add', '-b', `lane/${name}`, cwd]);
  const meta = { agent: 'busy-worker', worker_workspace: 'w', pane: 'w:p', terminal_id: 'term', agent_session_id: 'session', lane: 'occupied' };
  const additional = [
    { type: 'item.added', id: 'ENG-3', role: 'engineer' },
    { type: 'run.started', id: 'R-3', item: 'ENG-3', workspace: occupied, meta },
    { type: 'report.ingested', run: 'R-3', report: { outcome: 'done' } },
    { type: 'item.closed', id: 'ENG-3', as: 'done' },
    { type: 'item.added', id: 'ENG-4', role: 'engineer' },
    { type: 'run.started', id: 'R-4', item: 'ENG-4', workspace: chain, meta: { lane: 'chain' } },
    { type: 'report.ingested', run: 'R-4', report: { outcome: 'done' } },
    { type: 'item.added', id: 'ENG-5', role: 'engineer' },
    { type: 'run.started', id: 'R-5', item: 'ENG-5', workspace: running, meta: { lane: 'running' } },
  ].map((event, i) => ({ ...event, seq: 10 + i, at: EARLIER, by: 'fixture' }));
  fs.appendFileSync(path.join(f.org, 'events.jsonl'), additional.map(event => JSON.stringify(event) + '\n').join(''));
  const command = (exe, args, options) => {
    if (exe === '/usr/sbin/lsof') return { status: 0, stderr: '', stdout: `p${process.pid}\0n${f.repo}\0\n` };
    if (exe !== 'fixture-herdr') return f.command(exe, args, options);
    const data = {
      'workspace list': { workspaces: [{ workspace_id: 'w', worktree: { checkout_path: occupied, repo_root: f.repo, repo_key: f.project.identity, is_linked_worktree: true } }] },
      'tab list': { tabs: [{ workspace_id: 'w', tab_id: 'w:t' }] },
      'pane list': { panes: [{ workspace_id: 'w', tab_id: 'w:t', pane_id: 'w:p' }] },
      'pane process-info': { process_info: { shell_pid: 1, foreground_processes: [{ pid: 2, name: 'native' }], process_tree_complete: true,
        process_tree: [{ pid: 1, identity: 'shell', command: '[zsh]', state: 'S' }, { pid: 2, ppid: 1, identity: 'worker', command: '[native]', state: 'S' }] } },
      'agent list': { agents: [{ name: meta.agent, agent: 'native', agent_status: 'working', workspace_id: 'w', tab_id: 'w:t', pane_id: 'w:p',
        cwd: occupied, terminal_id: 'term', agent_session_id: 'session' }] },
    }[args.slice(0, 2).join(' ')];
    assert.ok(data, `unexpected Herdr call: ${args}`);
    return { status: 0, stdout: JSON.stringify({ result: data }) };
  };
  const published = f.publish({ command });
  assert.ok(f.calls.every(([exe, args]) => exe !== 'git' || (!args.includes('ls-files') && !args.includes('--untracked-files=all'))));
  const lanes = await readRetirementStatus({ cwd: f.repo, org: f.org, herdr: 'fixture-herdr', command, env: f.env });
  const trees = lanes.rows.filter(row => row.type === 'worktree' && row.branch?.startsWith('lane/'));
  assert.equal(trees.length, 5); assert.ok(trees.every(row => row.class === null));
  assert.equal(trees.find(row => row.worktree === clean).clean, true);
  assert.match(trees.find(row => row.worktree === dirty).nextAction, /lane worktree is not clean/);
  assert.match(trees.find(row => row.worktree === occupied).nextAction, /occupied lane/);
  assert.match(trees.find(row => row.worktree === chain).nextAction, /chain is still open/);
  assert.match(trees.find(row => row.worktree === running).nextAction, /open recorded run uses lane/);
  assert.deepEqual(published.lanes.counts, lanes.counts); assert.equal(published.lanes.counts.UNKNOWN, 0);
  assert.equal(lanes.counts.ACTIVE, 2, 'only the occupied tab and pane are ACTIVE; worktrees do not duplicate them');
  assert.deepEqual(published.lanes.oldest_unresolved.map(row => row.runs), [['R-3']]);
  assert.ok(!published.exceptions.some(e => ['lanes-unknown', 'unresolved-owner-unknown', 'unresolved-age-unknown'].includes(e.name)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.org, 'published/summary.json'))).lanes.counts, lanes.counts);
});

test('synchronous summary source shares train, attempt and matching gate facts with the cached lanes source', async t => {
  const f = brainFixture(t), state = fold(events(f.root));
  let reads = 0;
  const show = (_project, _job, key) => { reads++; return (key?.startsWith('R-') ? state.runs : state.items).get(key) ?? null; };
  const options = { now: f.now, logClocks: false, show, records: new Map() };
  const sync = brainSourceSync(f.project, options), async = await brainSource(f.project, options);
  assert.deepEqual(sync, async);
  assert.equal(sync.rows.find(r => r.id === 'job-active').phase, 'stage');
  assert.equal(sync.rows.find(r => r.id === 'job-active').phaseAt, f.receipt.command_started_at);
  assert.equal(sync.rows.find(r => r.id === 'job-queued').phase, 'queued');
  const before = reads;
  assert.deepEqual(await brainSource(f.project, options), async);
  assert.equal(reads, before, 'the async source retains its record cache');
  f.receipt.head = 'e'.repeat(40); f.save();
  const unmatched = brainSourceSync(f.project, options);
  assert.equal(unmatched.rows.find(r => r.id === 'job-active').phaseAt, f.train.attempts[0].gate.started_at);
});
