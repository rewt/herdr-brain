import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createModernSession } from '../modern/session.mjs';
import { orgSettingsSet } from '../lib/cli.mjs';
import { lineText } from '../lib/frame.mjs';
import { desksSnapshot } from '../../settle/desks-command.mjs';
import { selectRoute, resolveLaunchRoute } from '../../lanes/routes.mjs';
const bin = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-desks-')), cwd = path.join(root, 'repo'); fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd, timeout: 5000, stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'Fresh project\n'); git(['add', '.']); git(['commit', '-qm', 'Fresh project']);
  const env = { ...process.env, ORG_DIR: path.join(cwd, '.org'), ORG_ACTOR: 'desks-test' }; delete env.LANE_CONFIG;
  const org = args => execFileSync(process.execPath, [bin, ...args], { cwd, env, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const calls = [], s = createModernSession({ config: { projects: [{ name: 'Fresh project', cwd }] }, env: { HERDR_ENV: '1' }, deps: {
    herdrList: async () => [], herdrAgents: async () => ({ ok: true, agents: [] }), herdrRead: async () => ({ ok: true, text: '' }), brainQueue: async () => ({ rows: [], off: true }),
    orgSettingsSet: async (...args) => { calls.push(args); return orgSettingsSet(...args); },
  } });
  t.after(() => s.stop());
  return { root, cwd, git, env, org, calls, s, target: path.join(cwd, '.lane.json') };
}
const render = (s, cols = 100, rows = 40) => s.frame(cols, rows).lines.map(lineText).join('\n');
async function field(s, i, value) { await s.activate(`settings-field:${i}`); await s.key('u', { ctrl: true }); await s.key(value); }
async function save(s) { await s.key('', { return: true }); await s.key('', { return: true }); }

test('desks are inspectable without setup and every confirmed setting lands through record desks', async t => {
  const f = fixture(t), { s } = f;
  await s.refresh(); await s.key('S');
  for (const cols of [80, 100, 140]) assert.match(render(s, cols), /Round cap: 0 \(unlimited\)/);
  assert.equal(fs.existsSync(f.target), false); assert.equal(fs.existsSync(path.join(f.cwd, '.org')), false);
  await s.activate('desks-edit');
  for (const [i, value] of ['review-codex', 'engineer-xhigh', '3', '75', 'true', 'opaque-supervisor'].entries()) await field(s, i, value);
  await s.key('', { return: true });
  assert.match(render(s), /Review round cap: 0 → 3/); assert.equal(fs.existsSync(f.target), false); assert.equal(f.calls.length, 0);
  await s.key('', { return: true });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.target)).settle, { review_route: 'review-codex', fix_route: 'engineer-xhigh', review_round_cap: 3, timeout: 75, reuse: true, to: 'opaque-supervisor' });
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(f.target)), 'routes'), false, 'desk changes do not adopt the suggested preset');
  assert.equal(s.model.desks.suggested, true);
  const bytes = fs.readFileSync(f.target, 'utf8');
  await s.activate('desks-edit'); await save(s); assert.equal(f.calls.length, 1); assert.equal(fs.readFileSync(f.target, 'utf8'), bytes);
  await s.activate('desks-edit'); await field(s, 2, '4'); await s.key('', { return: true }); await s.activate('view:routes'); assert.ok(s.ui.settingsEdit, 'editor owns mouse navigation');
  await s.activate('settings-cancel'); assert.equal(fs.readFileSync(f.target, 'utf8'), bytes);
  await s.activate('desks-edit'); await field(s, 2, ''); await save(s);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(f.target)).settle, 'review_round_cap'), false); assert.match(render(s), /Round cap: 0 \(unlimited\)/);
});

test('stale, invalid and redirected desk edits preserve bytes; parent settings use whole-object precedence', async t => {
  const f = fixture(t), { s } = f;
  const parent = path.join(f.root, '.lane.json'); fs.writeFileSync(parent, JSON.stringify({ settle: { timeout: 50, review_round_cap: 2, reuse: true, extension: 'keep' } }));
  fs.writeFileSync(f.target, JSON.stringify({ main: 'trunk', validate: 'custom check', routes: {} }));
  await s.refresh(); await s.key('S'); await s.activate('desks-edit'); await field(s, 2, '3'); await s.key('', { return: true });
  const newer = { settle: { timeout: 51, review_round_cap: 2, reuse: true, extension: 'keep' } }; fs.writeFileSync(parent, JSON.stringify(newer));
  const bytes = fs.readFileSync(f.target, 'utf8'); await s.key('', { return: true });
  assert.match(s.ui.message, /changed since/); assert.ok(s.ui.settingsEdit); assert.equal(fs.readFileSync(f.target, 'utf8'), bytes);
  await s.key('', { escape: true }); await s.refresh(); await s.activate('desks-edit'); await field(s, 2, '3'); await save(s);
  const own = JSON.parse(fs.readFileSync(f.target)); assert.equal(own.main, 'trunk'); assert.equal(own.validate, 'custom check'); assert.equal(own.settle.timeout, 51); assert.equal(own.settle.extension, 'keep');
  const good = fs.readFileSync(f.target, 'utf8');
  for (const args of [['--review-route=missing'], ['--fix-route=missing'], ['--timeout=2'], ['--timeout=7201'], ['--timeout=3.5'], ['--review-round-cap=-1'], ['--review-round-cap=9007199254740992'], ['--reuse=yes'], ['--to='], ['--unset=unknown']]) {
    assert.throws(() => f.org(['desks', 'set', ...args])); assert.equal(fs.readFileSync(f.target, 'utf8'), good);
  }
  fs.unlinkSync(f.target); fs.symlinkSync(parent, f.target);
  assert.throws(() => f.org(['desks', 'set', '--timeout=100']), /regular, unlinked file/);
  assert.equal(fs.readFileSync(parent, 'utf8'), JSON.stringify(newer));
});

test('route addition, primary pool, task selection and launch settings save via validating CLI', async t => {
  const f = fixture(t), { s } = f; f.org(['desks', 'set', '--timeout=50']); await s.refresh(); await s.key('u');
  await s.activate('settings:add');
  for (const [i, value] of ['new-route', 'opaque-tool', 'opaque-model', 'opaque-effort'].entries()) await field(s, i, value);
  await save(s); assert.equal(f.calls.at(-1)[1].command, 'add');
  assert.equal(JSON.parse(fs.readFileSync(f.target)).settle.timeout, 50); assert.equal(s.model.routes.config.routes['new-route'].model, 'opaque-model'); assert.ok(s.model.routes.config.routes.engineer);
  await s.activate('settings:pool'); await field(s, 0, 'claude'); await save(s);
  assert.equal(selectRoute(s.model.routes.config, 'review'), 'review');
  await s.activate('settings:policy:writing'); await field(s, 2, 'new-route'); await save(s);
  assert.equal(selectRoute(s.model.routes.config, 'writing'), 'new-route');
  await s.activate('settings:policy:review:codex'); await field(s, 2, 'review-max'); await save(s);
  assert.equal(selectRoute(s.model.routes.config, 'review', 'codex'), 'review-max'); assert.equal(selectRoute(s.model.routes.config, 'review', 'claude'), 'review');
  await s.activate('settings:defaults'); await field(s, 1, 'changed-default'); await field(s, 3, '["--opaque","value with spaces"]'); await save(s);
  assert.equal(s.model.routes.config.dispatch.model, 'changed-default');
  await s.activate('settings:arguments'); await field(s, 0, 'opaque-tool'); await field(s, 1, '["--option","value with spaces"]'); await save(s);
  assert.deepEqual(resolveLaunchRoute(s.model.routes.config, { route: 'new-route' }).args, ['--opaque', 'value with spaces', '--option', 'value with spaces']);
  assert.deepEqual(f.calls.map(call => call[1].command), ['add', 'policy', 'policy', 'policy', 'defaults', 'arguments']);
  await s.activate('settings:policy'); await field(s, 0, 'build:frontend'); await field(s, 2, 'engineer'); await save(s);
  await s.activate('settings:policy:build%3Afrontend'); assert.equal(s.ui.settingsEdit.values[0], 'build:frontend'); await field(s, 2, 'new-route'); await save(s);
  assert.equal(selectRoute(s.model.routes.config, 'build:frontend'), 'new-route');
  const bytes = fs.readFileSync(f.target, 'utf8');
  for (const [kind, value] of [['add', { name: 'engineer', route: { kind: 'opaque' } }], ['add', { name: '__proto__', route: { kind: 'opaque' } }], ['policy', { primary_implementation_pool: 'missing', by_task_class: { review: { codex: 'review' } } }], ['defaults', { kind: '' }], ['arguments', { opaque: [5] }]]) {
    assert.throws(() => f.org(['routes', kind, `--value=${JSON.stringify(value)}`])); assert.equal(fs.readFileSync(f.target, 'utf8'), bytes);
  }
});

test('worktrees edit only their canonical project; record-only selections and plain folders cannot save', async t => {
  const f = fixture(t); const wt = path.join(f.root, 'worktree'); f.git(['worktree', 'add', '-b', 'lane', wt]);
  const r = spawnSync(process.execPath, [bin, 'desks', 'set', '--timeout=40'], { cwd: wt, env: { ...f.env, LANE_CONFIG: '/missing' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr); assert.equal(fs.existsSync(path.join(wt, '.lane.json')), false); assert.equal(desksSnapshot(wt).settings.timeout, 40);
  const plain = spawnSync(process.execPath, [bin, 'desks', 'set', '--timeout=40'], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 10000 }); assert.notEqual(plain.status, 0); assert.equal(fs.existsSync(path.join(f.root, '.lane.json')), false);
  const result = await orgSettingsSet({ org: path.join(f.cwd, '.org') }, { patch: { timeout: 60 }, unset: [] }, desksSnapshot(f.cwd).revision); assert.equal(result.ok, false); assert.equal(desksSnapshot(f.cwd).settings.timeout, 40);
});

test('--print cannot commit new desk or route controls even after review confirmation', t => {
  const f = fixture(t), config = path.join(f.root, 'console.json'), herdr = path.join(f.root, 'herdr');
  fs.writeFileSync(config, JSON.stringify({ projects: [{ name: 'Fresh', cwd: f.cwd }] }));
  fs.writeFileSync(herdr, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{agents:[],workspaces:[],tabs:[],panes:[]}}));`, { mode: 0o755 });
  for (const keys of ['S\\nreview-codex\\n\\n', 'ukkkkk\\nnew\\topaque\\n\\n']) {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../app.mjs', import.meta.url)), '--modern', '--config', config, '--print', '100x40', '--keys', keys], { cwd: f.cwd, env: { ...f.env, HERDR_BIN_PATH: herdr, HERDR_ENV: '1' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /--print does not change project settings/); assert.equal(fs.existsSync(f.target), false); assert.equal(fs.existsSync(path.join(f.cwd, '.org')), false);
  }
});

test('introducing a policy retains the implicit review route and long confirmations can be inspected before saving', async t => {
  const f = fixture(t), { s } = f;
  fs.writeFileSync(f.target, JSON.stringify({ routes: { engineer: { kind: 'opaque' }, review: { kind: 'opaque' } } }));
  await s.refresh(); await s.key('u'); await s.activate('settings:pool'); await field(s, 0, 'project-pool'); await save(s);
  assert.equal(selectRoute(s.model.routes.config, 'review'), 'review');
  const config = JSON.parse(fs.readFileSync(f.target));
  for (let i = 0; i < 20; i++) config.selection_policy.by_task_class[`task-${i}`] = 'engineer';
  fs.writeFileSync(f.target, JSON.stringify(config)); await s.refresh(); await s.activate('settings:pool'); await field(s, 0, 'another-pool'); await s.key('', { return: true });
  const bytes = fs.readFileSync(f.target, 'utf8'); render(s, 80, 20);
  assert.ok(s.ui.frame.maxScroll > 0);
  while (s.ui.scroll < s.ui.frame.maxScroll) { await s.key('', { pageDown: true }); render(s, 80, 20); }
  assert.match(render(s, 80, 20), /Save project settings/); assert.equal(fs.readFileSync(f.target, 'utf8'), bytes);
  await s.key('', { escape: true }); assert.equal(fs.readFileSync(f.target, 'utf8'), bytes);
});
