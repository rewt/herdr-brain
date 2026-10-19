import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { doctor, plan } from '../setup/setup.mjs';
import { inspect } from '../sessions/sessions.mjs';
import { parseManifest } from '../sessions/manifest.mjs';
import { canonicalProject } from '../sessions/project.mjs';
import { recordStandardSlot } from '../sessions/receipts.mjs';
import { emptyJournal, runtimePaths } from '../sessions/runtime.mjs';
import { specDigest } from '../sessions/lifecycle-evidence.mjs';
import { createHerdrObserver } from '../sessions/observe.mjs';
import { copyProduct, productFiles } from '../lib/product-files.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const document = m => `## Manifest\n\`\`\`json\n${JSON.stringify(m)}\n\`\`\`\n`;
const template = name => parseManifest(fs.readFileSync(path.join(source, `sessions/templates/${name}.md`), 'utf8'));
function bundle(home, name) {
  const root = path.join(home, 'releases', name), files = {};
  for (const relative of ['bin/org.mjs', 'lanes/lane.mjs', 'lib/releases.mjs', 'supervisor/supervisor.mjs',
    'promote/promote.mjs', 'housekeeping/housekeeping.mjs', 'contrib/settle-watch.mjs', 'lib/cli-help.mjs']) {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '// fixture\n'); files[relative] = 'fixture';
  }
  const commit = 'a'.repeat(40); fs.writeFileSync(path.join(root, '.release-commit'), commit);
  fs.writeFileSync(path.join(root, '.release-manifest.json'), JSON.stringify({ schema: 'herdr-release/v1', protocol: 1, commit, files }));
  return root;
}
function fixture(t, names = ['chat', 'supervisor', 'logs-viewer', 'logs-triage']) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'))), cwd = path.join(scratch, 'repo');
  fs.mkdirSync(cwd); t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(cwd, '.sessions')); fs.writeFileSync(path.join(cwd, '.lane.json'), '{}');
  const workspace = template('workspace'); workspace.spec.sessions = names.map(name => `${name}.md`);
  fs.writeFileSync(path.join(cwd, '.sessions/workspace.md'), document(workspace));
  for (const name of names) fs.copyFileSync(path.join(source, `sessions/templates/${name}.md`), path.join(cwd, `.sessions/${name}.md`));
  git('add', '.'); git('commit', '-qm', 'Synthetic project');
  const org = path.join(scratch, 'record'); fs.mkdirSync(org); fs.writeFileSync(path.join(org, 'events.jsonl'), '');
  const home = path.join(scratch, 'installed'); const current = bundle(home, 'green'); fs.symlinkSync(current, path.join(home, 'current'));
  const project = canonicalProject(cwd), env = { ...process.env, ORG_DIR: org, LANE_CONFIG: undefined,
    HERDR_MONITOR_FLEET: path.join(scratch, 'no-fleet'), HERDR_SOCKET_PATH: path.join(scratch, 'fixture.sock'),
    BRAIN_SHADOW_ROOT: path.join(scratch, 'shadow'), XDG_STATE_HOME: path.join(scratch, 'state') };
  const observation = { server: env.HERDR_SOCKET_PATH, complete: true, workspaces: [], tabs: [], panes: [], agents: [], receipts: [], errors: [] };
  const observer = { observe: async () => structuredClone(observation), close() { throw Error('borrowed observer must not be closed'); } };
  const options = { cwd, env, home, observer, nodeVersion: '20.19.4' };
  return { scratch, cwd, git, org, home, project, env, observation, observer, options };
}
function snapshot(root) {
  const files = [];
  function visit(relative) {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) files.push([relative, 'link', fs.readlinkSync(file)]);
    else if (stat.isDirectory()) { files.push([relative, 'directory']); for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name)); }
    else files.push([relative, stat.mode, fs.readFileSync(file).toString('base64')]);
  }
  visit(''); return files;
}
function enroll(f, slot = 'chat') {
  const panes = slot === 'logs' ? [{ pane: 'viewer', paneSlot: 'viewer' }, { pane: 'triage', paneSlot: 'triage' }]
    : [{ pane: 'primary', paneSlot: 'primary' }];
  recordStandardSlot({ cwd: f.cwd, action: 'adopt', uid: 'fixture-slot', actor: 'fixture', why: 'offline owner evidence',
    slot: { server: f.observation.server, workspace: 'w', checkout: f.cwd, tab: 'tab', standardSlot: slot, panes } });
  f.observation.workspaces.push({ workspace_id: 'w', worktree: { repo_key: f.project.common, checkout_path: f.cwd } });
  f.observation.tabs.push({ tab_id: 'tab', workspace_id: 'w' });
  f.observation.panes.push(...panes.map(p => ({ pane_id: p.pane, tab_id: 'tab', workspace_id: 'w', terminal_id: `term-${p.pane}`, emptyConfirmed: true })));
}

test('fresh project doctor and repeated plan name holds without changing any project, record, Git or install bytes', async t => {
  const f = fixture(t), before = snapshot(f.scratch);
  const diagnosis = await doctor(f.options);
  assert.equal(diagnosis.outcome, 'held');
  for (const name of ['node', 'project', 'record', 'release', 'herdr', 'profiles', 'manifests'])
    assert.equal(diagnosis.checks.find(c => c.name === name).state, 'ok', name);
  assert.equal(diagnosis.checks.find(c => c.name === 'native-trust').reasons[0].code, 'native-trust-unverified');
  assert.equal(diagnosis.checks.find(c => c.name === 'native-trust').state, 'advisory');
  assert.ok(diagnosis.checks.find(c => c.name === 'capabilities').reasons.some(r => r.code === 'native-profile-unverified'));
  for (let n = 0; n < 2; n++) {
    const preview = await plan(f.options); assert.equal(preview.outcome, 'held'); assert.equal(preview.changes.length, 4);
    assert.ok(preview.changes.every(c => c.outcome === 'refuse' && c.reasons.some(r => r.code === 'workspace-not-enrolled')));
  }
  assert.deepEqual(snapshot(f.scratch), before);
});

test('doctor reports missing Node, Git identity, record, release and unreachable Herdr independently', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.org, 'events.jsonl')); fs.unlinkSync(path.join(f.home, 'current'));
  const observer = { observe: async () => ({ complete: false, errors: ['offline endpoint'] }) };
  const result = await doctor({ ...f.options, nodeVersion: '22.0.0', observer });
  for (const name of ['node', 'record', 'release', 'herdr']) assert.equal(result.checks.find(c => c.name === name).state, 'held', name);
  const foreign = await plan({ ...f.options, cwd: f.scratch, observer });
  assert.equal(foreign.outcome, 'refused'); assert.deepEqual(foreign.changes, []);
  const throwing = await doctor({ ...f.options, observer: { observe: async () => { throw Error('no transport'); } } });
  assert.match(throwing.checks.find(c => c.name === 'herdr').reasons[0].message, /no transport/);
});

test('doctor holds incomplete record tails, unknown manifest fields and invalid validation declarations', async t => {
  const f = fixture(t, ['chat']);
  fs.writeFileSync(path.join(f.org, 'events.jsonl'), '{');
  const m = template('workspace'); m.spec.exec = 'forbidden';
  fs.writeFileSync(path.join(f.cwd, '.sessions/workspace.md'), document(m));
  f.git('add', '.sessions'); f.git('commit', '-qm', 'Invalid declaration');
  fs.writeFileSync(path.join(f.cwd, '.lane.validation.json'), '{"unknown":"anything"}');
  const result = await plan(f.options);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.doctor.checks.find(c => c.name === 'manifests').state, 'held');
  assert.match(result.doctor.checks.find(c => c.name === 'record').reasons[0].message, /incomplete tail/);
  assert.match(result.doctor.checks.find(c => c.name === 'profiles').reasons[0].message, /unknown validation field/);
  assert.ok(result.changes.every(c => c.outcome === 'refuse'));
});

test('a proven empty adopted viewer has a concrete create preview and never launches', async t => {
  const f = fixture(t, ['logs-viewer']); enroll(f, 'logs'); const before = snapshot(f.scratch);
  const result = await plan(f.options);
  assert.equal(result.outcome, 'planned', JSON.stringify(result));
  assert.equal(result.changes[0].outcome, 'start'); assert.equal(result.changes[0].operation, 'start-standard-slot');
  assert.equal(result.changes[0].target.pane, 'viewer'); assert.deepEqual(result.changes[0].reasons, []);
  assert.deepEqual(snapshot(f.scratch), before);
});

test('unverifiable native trust is advisory and permits ready diagnosis and a read-only Session create preview', async t => {
  const f = fixture(t, ['chat']); enroll(f); const before = snapshot(f.scratch);
  const diagnosis = await doctor(f.options), trust = diagnosis.checks.find(c => c.name === 'native-trust');
  assert.equal(diagnosis.outcome, 'ready', JSON.stringify(diagnosis));
  assert.equal(trust.state, 'advisory'); assert.equal(trust.observed.verified, false);
  assert.equal(trust.reasons[0].code, 'native-trust-unverified');
  const result = await plan(f.options), change = result.changes[0];
  assert.equal(result.outcome, 'planned', JSON.stringify(result));
  assert.equal(change.outcome, 'start'); assert.equal(change.operation, 'start-standard-slot');
  assert.deepEqual(change.reasons, []); assert.equal(change.advisories[0].code, 'native-trust-unverified');
  assert.deepEqual(snapshot(f.scratch), before);
});

test('native requirements are holds even in a proven empty owned slot', async t => {
  const f = fixture(t, ['chat']); enroll(f);
  const m = template('chat'); m.spec.permissions.profileRef = 'custom-native-profile'; m.spec.memory.claudeMem = { mode: 'required', domain: 'fixture' };
  m.spec.context.push({ source: 'latest-chat-handoff', required: true });
  fs.writeFileSync(path.join(f.cwd, '.sessions/chat.md'), document(m)); f.git('add', '.sessions'); f.git('commit', '-qm', 'Requirements');
  const result = await plan(f.options), c = result.changes[0];
  assert.equal(c.observed.decision, 'WouldStart'); assert.equal(c.outcome, 'refuse');
  assert.equal(c.advisories[0].code, 'native-trust-unverified');
  for (const code of ['native-profile-unverified', 'required-memory-unavailable', 'context-unavailable'])
    assert.ok(c.reasons.some(r => r.code === code), code);
});

test('foreign workspace identity and manual occupied panes stay refused without adoption or deletion', async t => {
  const f = fixture(t, ['logs-viewer']); enroll(f, 'logs');
  f.observation.workspaces[0].worktree.repo_key = '/foreign/.git';
  let before = snapshot(f.scratch), result = await plan(f.options);
  assert.equal(result.changes[0].outcome, 'refuse'); assert.match(result.changes[0].observed.reason, /mismatched.*identity/);
  assert.deepEqual(snapshot(f.scratch), before);
  f.observation.workspaces[0].worktree.repo_key = f.project.common;
  f.observation.panes[0].emptyConfirmed = false; f.observation.panes[0].agent = 'manual';
  before = snapshot(f.scratch); result = await plan(f.options);
  assert.equal(result.changes[0].outcome, 'refuse'); assert.match(result.changes[0].observed.reason, /not proven empty/);
  assert.deepEqual(snapshot(f.scratch), before);
});

test('matching live native incarnation stays keep with trust uncertainty visible; changed occupant is refused', async t => {
  const f = fixture(t, ['chat']); enroll(f);
  const entry = inspect({ cwd: f.cwd, env: f.env }).entries[0], target = { server: f.observation.server, workspace: 'w', tab: 'tab', pane: 'primary', checkout: f.cwd };
  const binding = { ...target, terminalId: 'term-primary', agentName: 'owned', nativeSessionId: 'native-owned' };
  const op = { id: 'fixture-op', uid: entry.manifest.metadata.uid, kind: 'start-standard-slot', generation: 1,
    specDigest: specDigest(entry), target, spec: entry.resolvedSpec, state: 'acknowledged' };
  op.receipt = { operationId: op.id, uid: op.uid, generation: 1, specDigest: op.specDigest, binding };
  const journal = emptyJournal(f.project.common); journal.operations.push(op);
  fs.writeFileSync(runtimePaths(f.project.common).journal, JSON.stringify(journal));
  f.observation.agents.push({ name: 'owned', pane_id: 'primary', tab_id: 'tab', workspace_id: 'w', cwd: f.cwd,
    terminal_id: binding.terminalId, agent_session: { value: binding.nativeSessionId }, agent_status: 'idle' });
  const before = snapshot(f.scratch); let result = await plan(f.options);
  assert.equal(result.changes[0].outcome, 'keep', JSON.stringify(result));
  assert.equal(result.outcome, 'unchanged');
  assert.ok(result.changes[0].advisories.some(r => r.code === 'native-trust-unverified'));
  f.observation.agents[0].agent_session.value = 'manual-replacement'; result = await plan(f.options);
  assert.equal(result.changes[0].outcome, 'refuse'); assert.match(result.changes[0].observed.reason, /changed.*occupant/);
  assert.deepEqual(snapshot(f.scratch), before);
});

test('project pins remain independent of global current and another project pin', async t => {
  const a = fixture(t, ['logs-viewer']), b = fixture(t, ['logs-viewer']);
  bundle(a.home, 'blue-a'); bundle(b.home, 'blue-b');
  for (const [f, pin] of [[a, 'blue-a'], [b, 'blue-b']]) {
    fs.writeFileSync(path.join(f.cwd, '.herdr-release.json'), JSON.stringify({ release: pin })); f.git('add', '.herdr-release.json'); f.git('commit', '-qm', 'Accept own pin');
  }
  fs.writeFileSync(path.join(a.cwd, '.herdr-release.json'), '{"release":"green"}');
  for (const [f, expected] of [[a, 'blue-a'], [b, 'blue-b']]) {
    const before = snapshot(f.scratch), result = await doctor(f.options), release = result.checks.find(c => c.name === 'release');
    assert.equal(release.state, 'ok'); assert.equal(release.observed.pin, expected); assert.equal(release.observed.selected.id, expected);
    assert.equal(release.observed.selected.selection, 'project'); assert.deepEqual(snapshot(f.scratch), before);
  }
  fs.writeFileSync(path.join(b.cwd, '.herdr-release.json'), '{"release":"blue-b","unknown":true}'); b.git('add', '.herdr-release.json'); b.git('commit', '-qm', 'Invalid pin');
  assert.equal((await doctor(b.options)).checks.find(c => c.name === 'release').state, 'held');
});

test('linked lanes use the canonical Workspace, identity, record and profiles', async t => {
  const f = fixture(t, ['logs-viewer']), lane = path.join(f.scratch, 'lane'); f.git('worktree', 'add', '-qb', 'lane/setup', lane);
  fs.writeFileSync(path.join(lane, '.sessions/workspace.md'), 'invalid worker override');
  fs.writeFileSync(path.join(f.cwd, '.lane.json'), JSON.stringify({ validation: { fast: 'owner-fast-command' } }));
  const result = await doctor({ ...f.options, cwd: lane });
  assert.deepEqual(result.project, f.project); assert.equal(result.checks.find(c => c.name === 'manifests').state, 'ok');
  assert.equal(result.checks.find(c => c.name === 'record').observed.path, f.org);
  assert.equal(result.checks.find(c => c.name === 'profiles').observed.validation.tiers.fast.command, 'owner-fast-command');
});

test('the Herdr observation seam uses only snapshot and agent metadata RPCs', async t => {
  const f = fixture(t, ['logs-viewer']), calls = [], agent = { name: 'display-only', pane_id: 'p' };
  const client = { snapshot: async () => { calls.push('session.snapshot'); return { ...f.observation, agents: [agent] }; },
    request: async (method, params) => { calls.push([method, params]); return { agent }; }, close: () => calls.push('close') };
  const observer = createHerdrObserver({ client, socketPath: f.observation.server });
  await doctor({ ...f.options, observer }); observer.close();
  assert.deepEqual(calls, ['session.snapshot', ['agent.get', { target: agent.name }], 'close']);
});

test('setup help ships in copied products and rejects unknown verbs, fields and positional files before observation', t => {
  const f = fixture(t, ['logs-viewer']), installed = path.join(f.scratch, 'product'); copyProduct(source, installed);
  for (const file of ['setup/setup.mjs', 'setup/README.md', 'sessions/templates/workspace.md']) assert.ok(productFiles(source).includes(file), file);
  const cli = path.join(installed, 'setup/setup.mjs');
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  const help = run(['--help']); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /doctor\|plan\|apply/);
  for (const args of [['init'], ['apply', '--model', 'opus'], ['apply', '--effort', 'high'], ['doctor', '--unknown'], ['plan', 'file.md'], ['doctor', '--authorization', 'receipt.json']]) {
    const result = run(args); assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /expected doctor, plan or apply|Unknown option|apply options only/);
  }
});
