import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { fixture, document } from './helpers/session-live.mjs';
import { apply } from '../setup/setup.mjs';
import { plan as sessionPlan } from '../sessions/plan.mjs';
import { apply as sessionApply } from '../sessions/apply.mjs';
import { ACTIONS, checkAuthorization } from '../sessions/authorization.mjs';
import { readStandardSlots, recordStandardSlot } from '../sessions/receipts.mjs';
import { readControllerJournal, runtimePaths } from '../sessions/runtime.mjs';
import { readAdapterReceipts } from '../sessions/live.mjs';
import { readSessionFacts } from '../sessions/observe.mjs';
import { digest, validStartOperation } from '../sessions/lifecycle-evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mutations = f => f.read().calls.filter(a => ['create', 'run', 'start', 'close', 'focus', 'rename'].includes(a[1]));
const command = (f, verb, action) => f.read().calls.filter(a => a[0] === verb && a[1] === action);
function workspace(t) {
  const f = fixture(t, 'supervisor');
  const names = ['supervisor', 'chat', 'logs-viewer', 'logs-triage'];
  fs.mkdirSync(path.join(f.cwd, '.sessions'));
  for (const name of ['workspace', ...names]) {
    const m = JSON.parse(fs.readFileSync(path.join(root, `sessions/templates/${name}.md`), 'utf8').split('```json')[1].split('```')[0]);
    if (name === 'workspace') m.spec.sessions = names.map(name => `${name}.md`);
    fs.writeFileSync(path.join(f.cwd, `.sessions/${name}.md`), document(m));
  }
  f.git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(f.cwd, '.lane.json'), JSON.stringify({ routes: {
    executive: { kind: 'claude', model: 'fixture-executive', effort: 'max' }, monitor: { kind: 'codex', model: 'fixture-monitor', effort: 'low' } } }));
  f.git('add', '.'); f.git('commit', '-qm', 'Committed Workspace and project route');
  // doctor reads an installed selection, independently of native observations.
  const home = path.join(f.scratch, 'installed'), release = path.join(home, 'releases/fixture'), files = {};
  for (const name of ['bin/org.mjs', 'lanes/lane.mjs', 'lib/releases.mjs', 'supervisor/supervisor.mjs',
    'promote/promote.mjs', 'housekeeping/housekeeping.mjs', 'contrib/settle-watch.mjs', 'lib/cli-help.mjs']) {
    const target = path.join(release, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '// fixture\n'); files[name] = 'fixture';
  }
  fs.writeFileSync(path.join(release, '.release-commit'), 'a'.repeat(40));
  fs.writeFileSync(path.join(release, '.release-manifest.json'), JSON.stringify({ schema: 'herdr-release/v1', protocol: 1, commit: 'a'.repeat(40), files }));
  fs.symlinkSync(release, path.join(home, 'current'));
  const options = { ...f.options, files: [], workspace: 'home', home, nodeVersion: '20.19.4' };
  const authorize = f.auth;
  f.auth = changes => authorize({ workspace: 'home', ...changes });
  f.options = options;
  f.dry = extra => apply({ ...f.options, ...extra });
  f.execute = async (extra = {}) => {
    const authorization = extra.authorization ?? f.authorization ?? (f.authorization = f.auth().file);
    const planFile = path.join(f.scratch, 'dryrun.json');
    const dry = await f.dry(extra); fs.writeFileSync(planFile, JSON.stringify(dry));
    return apply({ ...f.options, execute: true, authorization, planFile, ...extra });
  };
  f.startSupervisor = async () => {
    f.authorization ??= f.auth().file;
    const selected = { ...options, files: [path.join(f.cwd, '.sessions/supervisor.md')] };
    const result = await sessionApply({ ...selected, authorization: f.authorization, savedPlan: await sessionPlan(selected) });
    assert.equal(result.apply.state, 'attempted', JSON.stringify(result));
    assert.equal(readControllerJournal(f.project.common).operations.at(-1).state, 'acknowledged');
    f.change(s => { s.calls = []; });
  };
  return f;
}
function canonicalBytes(f) {
  const files = [];
  const visit = relative => {
    const target = path.join(f.cwd, relative), stat = fs.lstatSync(target);
    if (stat.isDirectory()) for (const name of fs.readdirSync(target).sort()) visit(path.join(relative, name));
    else files.push([relative, stat.mode, fs.readFileSync(target).toString('base64')]);
  };
  visit('');
  return files;
}
function noController(f) {
  for (const key of ['journal', 'status', 'lease']) assert.equal(fs.existsSync(runtimePaths(f.project.common)[key]), false, key);
  assert.equal(mutations(f).length, 0);
}

test('empty enrolled Workspace dry run writes nothing; one authorization starts its anchor and creates only chat', async t => {
  const f = workspace(t), before = canonicalBytes(f), events = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  const dry = await f.dry();
  assert.equal(dry.schema, 'project-setup-apply/v1'); assert.equal(dry.outcome, 'planned', JSON.stringify(dry));
  assert.deepEqual(dry.changes.map(c => c.outcome), ['start', 'create', 'skip', 'skip']);
  assert.equal(dry.digest, digest(dry.changes)); assert.ok(Number.isFinite(Date.parse(dry.observedAt)));
  assert.deepEqual(canonicalBytes(f), before); assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), events);
  noController(f);
  const result = await f.execute();
  assert.equal(result.outcome, 'applied', JSON.stringify(result));
  assert.deepEqual(result.steps.map(s => [s.operation, s.state]), [['start-standard-slot', 'acknowledged'], ['create-standard-slot', 'acknowledged']]);
  assert.equal(command(f, 'tab', 'create').length, 1); assert.equal(command(f, 'agent', 'start').length, 2);
  assert.ok(command(f, 'tab', 'create')[0].includes('--no-focus'));
  for (const args of command(f, 'agent', 'start')) {
    assert.equal(args[args.indexOf('--model') + 1], 'fixture-executive');
    assert.equal(args[args.indexOf('--effort') + 1], 'max');
    assert.equal(args.some(a => /hooks|--settings/u.test(a)), false);
  }
  const journal = readControllerJournal(f.project.common), receipt = checkAuthorization({ file: f.authorization, project: f.project, workspace: 'home', env: f.env });
  assert.ok(receipt.actions.includes('create-standard-slot'));
  assert.equal(fs.readdirSync(path.join(f.project.common, 'sessions/authorizations')).length, 1);
  assert.equal(readAdapterReceipts(f.project.common).length, 2);
  assert.equal(readStandardSlots(f.project.common).slots.find(s => s.standardSlot === 'chat').controllerOperation, journal.operations[1].id);
  assert.ok(validStartOperation(journal.operations[1]));
  assert.equal(validStartOperation({ ...journal.operations[1], unknown: true }), false);
  for (const op of journal.operations) {
    const context = JSON.parse(fs.readFileSync(path.join(f.project.common, 'sessions/contexts', `${op.id}.json`)));
    assert.equal(context.nativeSessionId, op.receipt.binding.nativeSessionId);
  }
  const journalBytes = fs.readFileSync(runtimePaths(f.project.common).journal);
  f.change(s => { s.calls = []; });
  const repeat = await f.execute();
  assert.equal(repeat.outcome, 'unchanged', JSON.stringify(repeat)); assert.deepEqual(repeat.steps, []);
  assert.equal(mutations(f).length, 0); assert.deepEqual(fs.readFileSync(runtimePaths(f.project.common).journal), journalBytes);
});

test('partial Workspace preserves a live supervisor, pending callback and watcher while creating chat', async t => {
  const f = workspace(t); await f.startSupervisor();
  const supervisor = readControllerJournal(f.project.common).operations[0], binding = supervisor.receipt.binding;
  const inbox = path.join(f.org, 'supervisor/inbox.log'); fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.writeFileSync(inbox, JSON.stringify({ type: 'notice', id: 'callback-1', run: 'R-9', state: 'pending', to: binding.agentName }) + '\n');
  const watcher = path.join(f.org, 'watcher.json'); fs.writeFileSync(watcher, JSON.stringify({ run: 'R-9', pane: binding.pane, watcher: { pid: 123, state: 'waiting' } }));
  const events = f.events();
  events.push({ seq: events.at(-1).seq + 1, at: new Date().toISOString(), by: 'fixture-supervisor', type: 'run.started', id: 'R-9', item: 'ENG-1',
    workspace: f.cwd, report_path: path.join(f.org, 'R-9-report.md'), meta: { dispatch_journal: watcher } });
  f.writeEvents(events);
  const facts = readSessionFacts({ project: f.project, env: f.env });
  assert.equal(facts.watchNotices[0].state, 'pending'); assert.equal(facts.watches['R-9'].state, 'waiting');
  const saved = [inbox, watcher].map(file => fs.readFileSync(file)), adapter = readAdapterReceipts(f.project.common)[0];
  const result = await f.execute(); assert.equal(result.outcome, 'applied', JSON.stringify(result));
  assert.equal(command(f, 'tab', 'create').length, 1); assert.equal(command(f, 'agent', 'start').length, 1);
  assert.deepEqual(readControllerJournal(f.project.common).operations[0], supervisor);
  assert.deepEqual(readAdapterReceipts(f.project.common)[0], adapter);
  assert.deepEqual([inbox, watcher].map(file => fs.readFileSync(file)), saved);
  assert.equal(f.read().calls.some(a => a.slice(2).includes(binding.tab) || a.slice(2).includes(binding.pane)), false);
});

test('a reset request stops workspace apply before any lifecycle or create mutation', async t => {
  const f = workspace(t); await f.startSupervisor();
  f.updateEvidence(e => { e.resetRequests[f.uid] = { boundary: { kind: 'handoff', ref: 'pending-reset', declared: true } }; });
  const before = fs.readFileSync(runtimePaths(f.project.common).journal);
  const result = await f.execute();
  assert.equal(result.outcome, 'refused'); assert.match(result.steps[0].reason, /lifecycle-action-out-of-scope/);
  assert.equal(mutations(f).length, 0); assert.deepEqual(fs.readFileSync(runtimePaths(f.project.common).journal), before);
});

test('an unowned manual supervisor fences creation with no lease or journal', async t => {
  const f = workspace(t); f.auth();
  f.change(s => s.agents.push({ name: 'manual-supervisor', agent: 'claude', workspace_id: 'w', tab_id: 'tab', pane_id: 'pane', terminal_id: 'term',
    cwd: f.cwd, agent_status: 'idle', agent_session: { value: 'manual-session' } }));
  const result = await f.execute(); assert.match(JSON.stringify(result), /unowned live occupant/); noController(f);
});

test('unenrolled and foreign workspaces refuse without creating controller state', async t => {
  const f = workspace(t);
  const unenrolled = await f.execute({ workspace: 'not-enrolled', evidence: undefined, authorization: 'absent' });
  assert.match(JSON.stringify(unenrolled), /workspace-not-enrolled/); noController(f);
  f.change(s => { s.workspaces[0].worktree.repo_key = '/another/project/.git'; });
  const foreign = await f.execute({ authorization: 'absent' });
  assert.match(JSON.stringify(foreign), /mismatched enrolled workspace identity/); noController(f);
});

test('wrong workspace authorization or missing create permission refuses the whole batch before starting its anchor', async t => {
  const f = workspace(t);
  const startOnly = f.auth({ actions: ['start-standard-slot'] });
  let result = await f.execute({ authorization: startOnly.file });
  assert.match(JSON.stringify(result), /not authorized: create-standard-slot/); noController(f);
  // A second explicitly enrolled native workspace has independent scope.
  const checkout = path.join(f.scratch, 'other-checkout'); f.git('worktree', 'add', '-qb', 'lane/other', checkout);
  recordStandardSlot({ cwd: f.cwd, action: 'adopt', uid: 'other', actor: 'fixture', why: 'independent fixture enrollment', slot: {
    server: f.env.HERDR_SOCKET_PATH, workspace: 'other', checkout, tab: 'other-tab', standardSlot: 'supervisor', panes: [{ pane: 'other-pane', paneSlot: 'primary' }] } });
  const events = f.events(), seq = events.at(-1).seq + 1;
  events.push({ seq, at: new Date().toISOString(), by: 'fixture-supervisor', type: 'item.added', id: 'HUM-2', role: 'human', title: 'Authorize the other workspace?',
    meta: { category: 'security', session_authorization: JSON.stringify({ schema: 'session-authorization-scope/v1', common: f.project.common,
      server: f.env.HERDR_SOCKET_PATH, workspace: 'other', checkout, actions: ACTIONS }) } });
  f.writeEvents(events);
  execFileSync(process.execPath, [path.join(root, 'bin/org.mjs'), 'answer', 'HUM-2', 'yes'], { cwd: f.cwd, env: { ...f.env, ORG_ACTOR: 'human' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const auth = f.auth({ workspace: 'other', operatorDecision: { id: 'HUM-2', seq: seq + 1 } });
  result = await f.execute({ authorization: auth.file });
  assert.match(JSON.stringify(result), /authorization workspace or enrollment mismatch/); noController(f);
});

test('a lost create reply retains exactly one tab and every later apply holds', async t => {
  const f = workspace(t); await f.startSupervisor(); f.change(s => { s.lostCreate = true; });
  const first = await f.execute(); assert.equal(first.outcome, 'stopped', JSON.stringify(first));
  const op = readControllerJournal(f.project.common).operations[1]; assert.equal(op.kind, 'create-standard-slot'); assert.equal(op.state, 'intent');
  assert.equal(readStandardSlots(f.project.common).slots.some(s => s.standardSlot === 'chat'), false);
  const next = await f.execute(); assert.match(JSON.stringify(next), /create intent unresolved; inspect retained tab; never create twice/);
  assert.equal(command(f, 'tab', 'create').length, 1); assert.equal(command(f, 'agent', 'start').length, 0);
  assert.deepEqual(readControllerJournal(f.project.common).operations[1], op);
});

test('saved dry run freshness, row digest and selection drift are checked before any mutation', async t => {
  const f = workspace(t), authorization = f.auth().file, planFile = path.join(f.scratch, 'saved.json');
  const dry = await f.dry();
  for (const patch of [{ observedAt: new Date(Date.now() - 61000).toISOString() }, { observedAt: new Date(Date.now() + 60000).toISOString() }, { digest: 'forged' }, { workspace: 'other' }]) {
    fs.writeFileSync(planFile, JSON.stringify({ ...dry, ...patch }));
    const result = await apply({ ...f.options, execute: true, authorization, planFile });
    assert.match(JSON.stringify(result), /saved dry run is stale or has drifted/); noController(f);
  }
});

test('new actionable UIDs between steps stop as plan-drift and cannot extend the saved batch', async t => {
  const f = workspace(t), observe = f.options.observer.observe;
  let changed = false;
  f.options.observer = { observe: async () => {
    if (!changed && readControllerJournal(f.project.common).operations.some(op => op.state === 'acknowledged')) {
      changed = true;
      const file = path.join(f.cwd, '.sessions/chat.md'), m = JSON.parse(fs.readFileSync(file, 'utf8').split('```json')[1].split('```')[0]);
      m.metadata.uid = 'new-chat-uid'; fs.writeFileSync(file, document(m)); f.git('add', '.sessions'); f.git('commit', '-qm', 'Concurrent desired UID change');
    }
    return observe();
  } };
  // Keep the dry-run and executor on the same observer seam.
  f.dry = extra => apply({ ...f.options, ...extra });
  const result = await f.execute();
  assert.equal(result.outcome, 'stopped', JSON.stringify(result)); assert.match(result.steps.at(-1).reason, /plan-drift/);
  assert.equal(command(f, 'tab', 'create').length, 0); assert.equal(command(f, 'agent', 'start').length, 1);
});

test('physical create edge catches an unowned agent arriving after intent and preserves all existing panes', async t => {
  const f = workspace(t); await f.startSupervisor();
  const before = f.read().tabs;
  f.change(s => { s.changeOnCall = { command: 'workspace list', at: 1, patch: { agents: [...s.agents, {
    name: 'late-manual', agent: 'claude', workspace_id: 'w', tab_id: 'keep-tab', pane_id: 'keep-pane', terminal_id: 'keep-term',
    cwd: f.cwd, agent_session: { value: 'late-native' }, agent_status: 'idle' }] } }; });
  const result = await f.execute();
  assert.equal(result.outcome, 'stopped', JSON.stringify(result)); assert.match(result.steps.at(-1).reason, /unowned live occupant/);
  assert.equal(mutations(f).length, 0); assert.deepEqual(f.read().tabs, before);
  assert.equal(readControllerJournal(f.project.common).operations[1].state, 'intent');
});

test('a faulty create reply naming an existing empty tab never sends input or starts an agent there', async t => {
  const f = workspace(t); await f.startSupervisor(); f.change(s => { s.reuseCreate = true; });
  const panes = f.read().panes;
  const result = await f.execute();
  assert.equal(result.outcome, 'stopped', JSON.stringify(result)); assert.match(result.steps.at(-1).reason, /create returned existing tab, pane or terminal/);
  assert.equal(command(f, 'pane', 'run').length, 0); assert.equal(command(f, 'agent', 'start').length, 0);
  assert.deepEqual(f.read().panes, panes);
});

test('apply can create beside a controller-owned supervisor without an evidence file', async t => {
  const f = workspace(t); await f.startSupervisor();
  const result = await f.execute({ evidence: undefined });
  assert.equal(result.outcome, 'applied', JSON.stringify(result)); assert.equal(command(f, 'tab', 'create').length, 1);
});

test('CLI dry-run/execute use only the fake socket and return named failure exit status', async t => {
  const f = workspace(t), clients = new Set();
  const server = net.createServer(socket => {
    clients.add(socket); socket.on('close', () => clients.delete(socket)); let buffer = '';
    socket.on('data', data => { buffer += data; for (let split; (split = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); const request = JSON.parse(line);
      const state = f.read(), result = request.method === 'session.snapshot' ? { type: 'session_snapshot', snapshot: state } : { agent: state.agents.find(a => a.name === request.params.target) };
      socket.write(JSON.stringify({ id: request.id, result }) + '\n');
    } });
  });
  await new Promise(resolve => server.listen(f.env.HERDR_SOCKET_PATH, resolve));
  t.after(async () => { for (const socket of clients) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const home = path.join(f.scratch, 'fake-home'), local = path.join(home, '.local/share'); fs.mkdirSync(local, { recursive: true });
  fs.symlinkSync(f.options.home, path.join(local, 'herdr-monitor'));
  const preload = path.join(f.scratch, 'fake-home.mjs');
  fs.writeFileSync(preload, `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module';\nos.userInfo = () => ({homedir: ${JSON.stringify(home)}}); syncBuiltinESMExports();\n`);
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'setup/setup.mjs'), 'apply', '--project', f.cwd, '--evidence', f.evidence, ...args], {
      env: { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${preload}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  const dry = await run([]); assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.equal(JSON.parse(dry.stdout).schema, 'project-setup-apply/v1'); noController(f);
  const refused = await run(['--execute']); assert.equal(refused.status, 1); assert.match(refused.stdout, /fresh --plan/);
});
