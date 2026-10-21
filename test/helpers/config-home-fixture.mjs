import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initOrg, transact, loadEvents } from '../../lib/store.mjs';
import { copyProduct } from '../../lib/product-files.mjs';
import { ROUTE_PRESET } from '../../lanes/preset.mjs';
import { adopt } from '../../lib/adopt-command.mjs';
import { homeProject } from '../../lib/config-home.mjs';

const product = fileURLToPath(new URL('../../', import.meta.url));
export function configFixture(t, { custom = false, routing = false } = {}) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'config-home-'))), home = path.join(scratch, 'home');
  const ownerRoot = custom ? path.join(home, 'development/alex') : path.join(home, 'development'), cwd = path.join(ownerRoot, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  if (custom) fs.writeFileSync(path.join(ownerRoot, '.identity-root'), 'fixture\n');
  const keys = ['HOME', 'HERDR_MONITOR_FLEET', 'ORG_DIR', 'ORG_ACTOR', 'HERDR_AGENT_NAME', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'LANE_CONFIG'];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { HOME: home, HERDR_MONITOR_FLEET: path.join(scratch, 'fleet'), ORG_DIR: path.join(cwd, '.org'), ORG_ACTOR: 'fixture-supervisor',
    HERDR_AGENT_NAME: 'fixture-supervisor', HERDR_PANE_ID: 'pane', HERDR_WORKSPACE_ID: 'workspace' });
  delete process.env.LANE_CONFIG;
  const env = { ...process.env };
  t.after(() => { for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; fs.rmSync(scratch, { recursive: true, force: true }); });
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-qb', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(cwd, '.git/info/exclude'), '.org/\n.lane/\nkeep-existing-entry\n');
  fs.writeFileSync(path.join(ownerRoot, '.lane.json'), JSON.stringify({ ...ROUTE_PRESET, worktree_root: 'parent-lanes' }));
  fs.writeFileSync(path.join(cwd, '.lane.json'), '{\n  "archive": {"dirs": ["archive"]}, "main": "main", "dispatch": {"max_sessions": 4, "max_unlanded": 8}\n}\n');
  fs.writeFileSync(path.join(cwd, '.lane.validation.json'), '{"fast":"node --version","promotion":"node --version","environment":"fixture"}\n');
  fs.writeFileSync(path.join(cwd, '.promote.json'), '{"max_batch":3}\n');
  fs.writeFileSync(path.join(cwd, '.housekeeping.json'), '{"enabled":false}\n');
  fs.writeFileSync(path.join(cwd, '.herdr-release.json'), '{"release":null}\n');
  if (routing) fs.writeFileSync(path.join(cwd, 'routing.json'), JSON.stringify(ROUTE_PRESET));
  git('add', '.'); git('commit', '-qm', 'fixture policy'); initOrg(env.ORG_DIR);
  const installationHome = path.join(home, '.local/share/herdr-monitor'), bundle = path.join(installationHome, 'releases/compatible');
  copyProduct(product, bundle);
  fs.writeFileSync(path.join(bundle, '.release-commit'), '1'.repeat(40) + '\n');
  const summary = path.join(bundle, '.release-acceptance.json');
  fs.writeFileSync(summary, JSON.stringify({ ready: true, candidateCommit: '1'.repeat(40), elapsedSeconds: 1, counts: { PASS: 1, FAIL: 0, PENDING: 0, SKIP: 0 } }));
  execFileSync(process.execPath, [path.join(product, 'herdr/releases.mjs'), 'manifest', bundle, summary], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.symlinkSync(bundle, path.join(installationHome, 'current'));
  const observation = { complete: true, server: path.join(scratch, 'native.sock'), errors: [], receipts: [],
    workspaces: [{ workspace_id: 'workspace', worktree: { repo_key: path.join(cwd, '.git'), repo_root: cwd, checkout_path: cwd, is_linked_worktree: false } }],
    tabs: [{ tab_id: 'tab', workspace_id: 'workspace' }, { tab_id: 'unselected', workspace_id: 'workspace' }],
    panes: [{ pane_id: 'pane', workspace_id: 'workspace', tab_id: 'tab', terminal_id: 'terminal', foreground_cwd: cwd }],
    agents: [{ name: 'fixture-supervisor', workspace_id: 'workspace', tab_id: 'tab', pane_id: 'pane', terminal_id: 'terminal', cwd, agent: 'codex', agent_status: 'idle', agent_session: { value: 'native-session' } }] };
  const observer = { observe: async () => structuredClone(observation), close() {} };
  const options = { cwd, project: '.', env, observer, installationHome, ...(routing ? { routing: 'routing.json' } : {}) };
  let n = 0;
  function question(scope, field = 'adoption_authorization', actor = 'human') {
    const id = `HUM-${++n}`;
    transact(env.ORG_DIR, () => ({ add: [{ type: 'item.added', id, title: 'Authorize this exact fixture scope?', role: 'human', meta: { category: 'security', [field]: JSON.stringify(scope) } }] }), { actor: 'fixture-supervisor' });
    const recordCLI = fs.existsSync(path.join(cwd, '.brain')) ? path.join(bundle, 'bin/org.mjs') : path.join(product, 'bin/org.mjs');
    execFileSync(process.execPath, [recordCLI, 'answer', id, 'yes'], { cwd, env: { ...env, ORG_ACTOR: actor }, stdio: ['ignore', 'pipe', 'pipe'] });
    const event = loadEvents(env.ORG_DIR).events.find(e => e.id === id && e.kind === 'answer');
    return { id, seq: event.seq };
  }
  const f = { scratch, home, ownerRoot, cwd, env, git, installationHome, bundle, observation, observer, options, question,
    events: () => loadEvents(env.ORG_DIR).events, binding: () => homeProject(cwd, env) };
  f.capture = () => adopt({ ...options, inspectOnly: true, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  f.adopt = async extra => {
    if (!f.scope) { f.scope = await f.capture(); f.decision = question(f.scope.scope); }
    return adopt({ ...options, scopeFile: f.scope.scopeFile, decision: f.decision, ...extra });
  };
  return f;
}
