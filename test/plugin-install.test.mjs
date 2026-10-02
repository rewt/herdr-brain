import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runPTY, PTY_SKIP_REASON } from './helpers/pty.mjs';

const source = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-plugin-test-'));
  t.after(() => { spawnSync('chmod', ['-R', 'u+w', root], { timeout: 5000 }); fs.rmSync(root, { recursive: true, force: true }); });
  const repo = path.join(root, 'source'), home = path.join(root, 'user'), nativeBin = path.join(root, 'native');
  for (const dir of [repo, home, nativeBin]) fs.mkdirSync(dir);
  for (const dir of ['bin', 'lib', 'lanes', 'discovery', 'herdr', 'housekeeping']) fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true });
  fs.copyFileSync(path.join(source, 'herdr-plugin.toml'), path.join(repo, 'herdr-plugin.toml'));
  const native = path.join(nativeBin, 'codex'), receipt = path.join(root, 'native.json');
  fs.writeFileSync(native, `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.ENTRY_TEST_RECEIPT,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n`, { mode: 0o755 });
  fs.symlinkSync(native, path.join(nativeBin, 'claude'));
  const env = { ...process.env, HOME: home, ZDOTDIR: home, ORG_ACTOR: `eng80-r89-${createHash('sha256').update(t.name).digest('hex').slice(0, 12)}`, ORG_DIR: '',
    PATH: `${nativeBin}:${process.env.PATH}`, HERDR_MONITOR_HOME: path.join(home, 'monitor'), HERDR_MONITOR_BIN: path.join(home, 'bin'), HERDR_MONITOR_ENTRY_BIN: path.join(home, 'monitor/entry/bin'),
    HERDR_MONITOR_REPO: repo, HERDR_MONITOR_CODEX: native, HERDR_MONITOR_CLAUDE: path.join(nativeBin, 'claude'), HERDR_MONITOR_PLIST: path.join(root, 'absent.plist'),
    RELEASE_NO_NPM: '1', RELEASE_NO_HERDR: '1', RELEASE_NO_LAUNCHD: '1', MONITOR_INSTALL_BUILD_ONLY: '', MONITOR_ENTRY_BYPASS: '', MONITOR_REQUEST_DIR: '',
    HERDR_INTEGRATION_ID: '', HERDR_PANE_ID: '', HERDR_PLUGIN_ROOT: '', HERDR_PLUGIN_CONTEXT_JSON: '', MONITOR_RUNTIME_DIR: path.join(root, 'queue'), MONITOR_WORKTREE_ROOT: path.join(root, 'lanes'), ENTRY_TEST_RECEIPT: receipt,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (file, args, cwd = repo, extra = {}) => spawnSync(file, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 });
  const ok = (file, args, cwd, extra) => { const r = run(file, args, cwd, extra); assert.equal(r.status, 0, r.error?.message ?? r.stdout + r.stderr); return r.stdout; };
  const git = (...args) => ok('git', args);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Plugin Test'); git('config', 'user.email', 'plugin@example.invalid');
  git('add', '.'); git('commit', '-qm', 'First'); git('tag', 'first');
  fs.writeFileSync(path.join(repo, 'version'), 'second'); git('add', '.'); git('commit', '-qm', 'Second'); git('tag', 'second');
  const release = (...args) => ok('bash', [path.join(source, 'herdr/release.sh'), ...args]);
  const driver = (...args) => run(process.execPath, [path.join(source, 'herdr/entry-install.mjs'), '--product', repo, ...args]);
  return { root, repo, home, native, env, run, ok, release, driver, receipt, bin: env.HERDR_MONITOR_ENTRY_BIN };
}

test('release carries entry, pins final versions, rolls back and restores exact shell state', { skip: PTY_SKIP_REASON, timeout: 60000 }, (t) => {
  const f = fixture(t), original = `# User setup without final newline\nexport PATH='${path.dirname(f.native)}':"$PATH"`;
  fs.writeFileSync(path.join(f.home, '.zshrc'), original, { mode: 0o600 });
  fs.writeFileSync(path.join(f.home, '.profile'), '# Login setup\n', { mode: 0o600 });
  const nativeBytes = fs.readFileSync(f.native);
  f.release('build', 'first'); f.release('build', 'second');
  assert.equal(fs.existsSync(f.bin), false, 'building an archive must not install partial-path adapters');
  assert.equal(fs.readFileSync(path.join(f.home, '.zshrc'), 'utf8'), original);
  f.release('activate', 'first');
  const marker = () => JSON.parse(fs.readFileSync(path.join(f.bin, '.monitor-entry.json')));
  assert.equal(marker().product, path.join(f.env.HERDR_MONITOR_HOME, 'releases/first'));
  assert.ok(!fs.readFileSync(path.join(f.bin, 'codex'), 'utf8').includes('.partial'));
  for (const [shell, flags] of [['zsh', '-ic'], ['zsh', '-ilc'], ['bash', '-ic'], ['bash', '-ilc']]) {
    assert.equal(f.ok(shell, [flags, 'command -v codex']).trim(), path.join(f.bin, 'codex'), `${shell} ${flags} must discover the install without a PATH override`);
  }
  const project = path.join(f.root, 'project'); fs.mkdirSync(project);
  f.ok('git', ['init', '-q', '-b', 'main'], project);
  f.ok('git', ['config', 'user.name', 'Plugin Test'], project); f.ok('git', ['config', 'user.email', 'plugin@example.invalid'], project);
  fs.writeFileSync(path.join(project, 'hello'), 'hello'); f.ok('git', ['add', '.'], project); f.ok('git', ['commit', '-qm', 'Seed'], project);
  const interactive = runPTY('zsh', ['-ic', 'codex --model literal'], { cwd: project, env: f.env, timeout: 20000 });
  assert.equal(interactive.status, 0, interactive.stdout + interactive.stderr);
  const worker = JSON.parse(fs.readFileSync(f.receipt));
  assert.notEqual(worker.cwd, project); assert.ok(fs.existsSync(path.join(project, '.org/events.jsonl')));
  assert.match(worker.args.join('\n'), /Herdr Monitor installed project-entry policy/u);
  assert.match(worker.args.join('\n'), /Never start project housekeeping/u);
  f.ok('bash', [path.join(marker().product, 'herdr/supervisor.sh'), '--model', 'literal'], project);
  const supervisor = JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(supervisor.cwd, project);
  assert.match(supervisor.args.join('\n'), /At session entry, start the default project schedule/u);
  assert.ok(supervisor.args.join('\n').includes(`${marker().product}/housekeeping/housekeeping.mjs`));
  f.release('activate', 'second'); f.release('activate', 'second');
  assert.equal(marker().native, f.native); assert.match(marker().product, /releases\/second$/u);
  f.release('rollback'); assert.match(marker().product, /releases\/first$/u);
  f.release('restore'); f.release('restore');
  assert.equal(fs.readFileSync(path.join(f.home, '.zshrc'), 'utf8'), original);
  assert.equal(fs.statSync(path.join(f.home, '.zshrc')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(f.home, '.profile'), 'utf8'), '# Login setup\n');
  for (const name of ['.zshenv', '.bashrc', '.bash_profile']) assert.equal(fs.existsSync(path.join(f.home, name)), false);
  assert.deepEqual(fs.readFileSync(f.native), nativeBytes);
  for (const name of ['codex', 'claude', 'monitor-codex', 'monitor-claude', '.monitor-entry.json', '.monitor-shell.json']) assert.equal(fs.existsSync(path.join(f.bin, name)), false);
  assert.equal(f.ok('zsh', ['-ic', 'command -v codex']).trim(), f.native);
});

test('build installs pinned console and MCP dependencies with offline preference and honors RELEASE_NO_NPM', { timeout: 30000 }, (t) => {
  const f = fixture(t), calls = path.join(f.root, 'npm-calls.jsonl');
  for (const module of ['console', 'mcp']) fs.cpSync(path.join(source, module), path.join(f.repo, module), { recursive: true, filter: (file) => !file.split(path.sep).includes('node_modules') });
  const npm = path.join(path.dirname(f.native), 'npm');
  fs.writeFileSync(npm, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o755 });
  const build = ['bash', [path.join(f.repo, 'herdr/install.sh')], f.repo];
  f.ok(...build, { RELEASE_NO_NPM: '', MONITOR_INSTALL_BUILD_ONLY: '1' });
  const expected = ['console', 'mcp'].map((module) => ['--prefix', path.join(f.repo, module), 'ci', '--no-audit', '--no-fund', '--prefer-offline']);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), expected);
  fs.unlinkSync(calls);
  f.ok(...build, { RELEASE_NO_NPM: '1', MONITOR_INSTALL_BUILD_ONLY: '1' });
  assert.equal(fs.existsSync(calls), false);
  assert.equal(fs.existsSync(f.bin), false);
  // Dependency failure must happen before any entry changes.
  fs.writeFileSync(npm, '#!/bin/sh\nexit 19\n', { mode: 0o755 });
  assert.notEqual(f.run(...build, { RELEASE_NO_NPM: '', MONITOR_INSTALL_BUILD_ONLY: '' }).status, 0);
  assert.equal(fs.existsSync(f.bin), false); assert.equal(fs.existsSync(path.join(f.home, '.zshenv')), false);
});

test('manifest build installs entry even when npm is skipped; restores preserve surrounding user edits', { timeout: 30000 }, (t) => {
  const f = fixture(t);
  f.ok('bash', [path.join(f.repo, 'herdr/install.sh')]);
  const rc = path.join(f.home, '.zshrc'); fs.appendFileSync(rc, '# Later user edit\n');
  const remove = f.driver('--remove'); assert.equal(remove.status, 0, remove.stderr);
  assert.equal(fs.readFileSync(rc, 'utf8'), '# Later user edit\n');
  assert.equal(fs.existsSync(path.join(f.home, '.zshenv')), false);
});

test('plugin build discovers native CLIs and installs default machine paths without entry overrides', { timeout: 30000 }, (t) => {
  const f = fixture(t);
  const defaults = { HERDR_MONITOR_HOME: undefined, HERDR_MONITOR_ENTRY_BIN: undefined, HERDR_MONITOR_CODEX: undefined, HERDR_MONITOR_CLAUDE: undefined };
  f.ok('bash', [path.join(f.repo, 'herdr/install.sh')], f.repo, defaults);
  const bin = path.join(f.home, '.local/share/herdr-monitor/entry/bin');
  const receipt = JSON.parse(fs.readFileSync(path.join(bin, '.monitor-entry.json')));
  assert.equal(receipt.native, f.native); assert.equal(receipt.claudeNative, f.native);
  assert.match(receipt.product, /entry\/runtimes\/[a-f0-9]{64}$/u);
  assert.ok(fs.existsSync(path.join(receipt.product, 'discovery/adapters/codex.mjs')));
  const restored = f.run(process.execPath, [path.join(source, 'herdr/entry-install.mjs'), '--remove'], f.repo, defaults);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.existsSync(path.join(bin, 'codex')), false); assert.equal(fs.existsSync(path.join(f.home, '.zshrc')), false);
});

test('Herdr build checkout can move or disappear while installed entry and restore still work', { skip: PTY_SKIP_REASON, timeout: 30000 }, (t) => {
  const f = fixture(t), original = '# Original shell\n';
  fs.writeFileSync(path.join(f.home, '.zshrc'), original);
  f.ok('bash', [path.join(f.repo, 'herdr/install.sh')]);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.bin, '.monitor-entry.json')));
  assert.notEqual(receipt.product, f.repo);
  const moved = path.join(f.root, 'managed-plugin'); fs.renameSync(f.repo, moved);
  const project = path.join(f.root, 'unrelated-project'); fs.mkdirSync(project);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Plugin Test'], ['config', 'user.email', 'plugin@example.invalid']]) f.ok('git', args, project);
  fs.writeFileSync(path.join(project, 'seed'), 'project'); f.ok('git', ['add', '.'], project); f.ok('git', ['commit', '-qm', 'Project'], project);
  const started = runPTY('zsh', ['-ic', 'codex --model literal'], { cwd: project, env: f.env, timeout: 20000 });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const native = JSON.parse(fs.readFileSync(f.receipt));
  assert.match(native.args.join('\n'), /Herdr Monitor installed project-entry policy/u);
  assert.ok(native.args.join('\n').includes(`${receipt.product}/discovery/policy.mjs`));
  assert.notEqual(native.cwd, project);
  // No removal dependency on the plugin checkout or the old installer's flags.
  fs.rmSync(moved, { recursive: true });
  f.ok(process.execPath, [path.join(source, 'herdr/entry-install.mjs'), '--remove'], project);
  assert.equal(fs.readFileSync(path.join(f.home, '.zshrc'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(f.bin, 'codex')), false);
});

test('supervisor resolves the selected workspace to canonical Git instead of its plugin cwd', { timeout: 30000 }, (t) => {
  const f = fixture(t); f.ok('bash', [path.join(f.repo, 'herdr/install.sh')]);
  const project = path.join(f.root, 'project'), linked = path.join(f.root, 'linked'); fs.mkdirSync(project);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Plugin Test'], ['config', 'user.email', 'plugin@example.invalid']]) f.ok('git', args, project);
  fs.writeFileSync(path.join(project, 'seed'), 'project'); f.ok('git', ['add', '.'], project); f.ok('git', ['commit', '-qm', 'Project'], project);
  f.ok('git', ['worktree', 'add', '-qb', 'selected-lane', linked], project);
  const context = { HERDR_PLUGIN_ROOT: f.repo, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'owned-workspace', workspace_cwd: linked, focused_pane_cwd: linked }), HERDR_WORKSPACE_ID: 'owned-workspace' };
  f.ok('bash', [path.join(f.repo, 'herdr/supervisor.sh'), '--model', 'literal'], f.repo, context);
  const native = JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(native.cwd, project);
  assert.match(native.args.join('\n'), /At session entry, start the default project schedule/u);
  assert.equal(fs.existsSync(path.join(f.repo, '.org')), false);
  assert.notEqual(f.run('bash', [path.join(f.repo, 'herdr/supervisor.sh')], f.repo, { ...context, HERDR_PLUGIN_CONTEXT_JSON: '{}', HERDR_WORKSPACE_ID: '' }).status, 0);
  assert.notEqual(f.run('bash', [path.join(f.repo, 'herdr/supervisor.sh')], f.repo, { ...context, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'owned-workspace' }) }).status, 0);
  assert.notEqual(f.run('bash', [path.join(f.repo, 'herdr/supervisor.sh')], f.repo, { ...context, HERDR_WORKSPACE_ID: 'another-workspace' }).status, 0);
  assert.equal(fs.existsSync(path.join(f.repo, '.org')), false);
});

const olderReleases = '/Users/rewt/.local/share/herdr-monitor/releases';
test('real v0.1.3 and v0.1.4 scratch copies activate, rollback, roll forward and restore', { timeout: 60000,
  skip: !['v0.1.3', 'v0.1.4'].every((tag) => fs.existsSync(path.join(olderReleases, tag))) && 'actual installed v0.1.3 and v0.1.4 releases unavailable' }, (t) => {
  const f = fixture(t), original = '# Old release shell\n'; fs.writeFileSync(path.join(f.home, '.zshrc'), original);
  for (const tag of ['v0.1.3', 'v0.1.4']) {
    const destination = path.join(f.env.HERDR_MONITOR_HOME, 'releases', tag);
    fs.cpSync(path.join(olderReleases, tag), destination, { recursive: true, filter: (file) => !file.split(path.sep).includes('node_modules') });
    f.ok('chmod', ['-R', 'a-w', destination]);
  }
  assert.equal(fs.existsSync(path.join(f.env.HERDR_MONITOR_HOME, 'releases/v0.1.3/discovery/install.mjs')), false);
  const oldInstaller = path.join(f.env.HERDR_MONITOR_HOME, 'releases/v0.1.4/discovery/install.mjs');
  assert.ok(!fs.readFileSync(oldInstaller, 'utf8').includes("check: { type: 'boolean' }"));
  f.release('build', 'first');
  const marker = () => JSON.parse(fs.readFileSync(path.join(f.bin, '.monitor-entry.json')));
  f.release('activate', 'v0.1.3'); f.release('activate', 'first'); f.release('rollback');
  assert.equal(fs.existsSync(path.join(f.bin, 'codex')), false); assert.equal(fs.readFileSync(path.join(f.home, '.zshrc'), 'utf8'), original);
  f.release('rollback'); assert.match(marker().product, /releases\/first$/u);
  f.release('activate', 'v0.1.4'); assert.match(marker().product, /releases\/v0.1.4$/u);
  f.release('activate', 'first'); f.release('rollback'); assert.match(marker().product, /releases\/v0.1.4$/u);
  f.release('restore'); assert.equal(fs.existsSync(path.join(f.bin, 'codex')), false);
  assert.equal(fs.readFileSync(path.join(f.home, '.zshrc'), 'utf8'), original);
  f.release('activate', 'first'); f.release('restore');
  assert.equal(fs.readFileSync(path.join(f.home, '.zshrc'), 'utf8'), original);
});

test('non-writable shell files refuse installation without adapters or partial snippets', { timeout: 30000 }, (t) => {
  const f = fixture(t), bashrc = path.join(f.home, '.bashrc');
  fs.writeFileSync(bashrc, '# Readable shell\n', { mode: 0o400 });
  const result = f.driver('--snapshot'); assert.notEqual(result.status, 0, result.stdout);
  assert.equal(fs.readFileSync(bashrc, 'utf8'), '# Readable shell\n');
  assert.equal(fs.statSync(bashrc).mode & 0o777, 0o400);
  for (const name of ['.zshenv', '.zshrc', '.bash_profile']) assert.equal(fs.existsSync(path.join(f.home, name)), false);
  assert.equal(fs.existsSync(f.bin), false);
});

for (const crash of [false, true]) test(`recovery receipt precedes shell writes and ${crash ? 'recovers a terminated install' : 'rolls back a failure after the first snippet'}`, { timeout: 30000 }, (t) => {
  const f = fixture(t), bashrc = path.join(f.home, '.bashrc'), evidence = path.join(f.root, 'journal-proof.json');
  fs.writeFileSync(bashrc, '# Original bash\n');
  const preload = path.join(f.root, 'fault.cjs');
  fs.writeFileSync(preload, `const fs=require('fs'),rename=fs.renameSync,journal=${JSON.stringify(path.join(f.bin, '.monitor-recovery.json'))},evidence=${JSON.stringify(evidence)};
const managed=${JSON.stringify(['codex', 'claude', 'monitor-codex', 'monitor-claude', '.monitor-entry.json', '.monitor-shell.json'].map((name) => path.join(f.bin, name)))};
fs.renameSync=function(from,to){
  if(managed.includes(to)){
    const receipt=JSON.parse(fs.readFileSync(journal));
    require('assert').strictEqual(fs.statSync(journal).mode&0o777,0o600);
    if(!fs.existsSync(evidence))fs.writeFileSync(evidence,JSON.stringify({...receipt,firstWrite:to,fileExisted:fs.existsSync(to)}));
  }
  const result=rename.apply(this,arguments);
  if(to===${JSON.stringify(path.join(f.home, '.zshenv'))}){${crash ? 'process.exit(73)' : `fs.chmodSync(${JSON.stringify(bashrc)},0o400)`};}
  return result;
};\n`);
  const failed = f.run(process.execPath, ['--require', preload, path.join(source, 'herdr/entry-install.mjs'), '--product', f.repo, '--snapshot']);
  assert.notEqual(failed.status, 0);
  const proof = JSON.parse(fs.readFileSync(evidence)); assert.equal(proof.bin, f.bin);
  assert.equal(proof.firstWrite, path.join(f.bin, 'codex')); assert.equal(proof.fileExisted, false);
  assert.ok(proof.changes.some((change) => change.file === path.join(f.home, '.zshenv') && change.before === null));
  if (crash) {
    assert.equal(failed.status, 73); assert.ok(fs.existsSync(path.join(f.bin, '.monitor-recovery.json')));
    assert.notEqual(f.driver('--check').status, 0);
    assert.equal(f.driver('--recover').status, 0);
  }
  for (const name of ['codex', 'claude', 'monitor-codex', 'monitor-claude', '.monitor-entry.json', '.monitor-shell.json', '.monitor-recovery.json']) assert.equal(fs.existsSync(path.join(f.bin, name)), false, name);
  for (const name of ['.zshenv', '.zshrc', '.bash_profile']) assert.equal(fs.existsSync(path.join(f.home, name)), false, name);
  assert.equal(fs.readFileSync(bashrc, 'utf8'), '# Original bash\n');
  assert.equal(fs.existsSync(proof.runtime), false);
  fs.chmodSync(bashrc, 0o644); assert.equal(f.driver('--snapshot').status, 0); assert.equal(f.driver('--remove').status, 0);
});

test('rollback preserves a namespaced tag with a same-basename distractor', { timeout: 30000 }, (t) => {
  const f = fixture(t); f.ok('git', ['tag', 'series/first', 'first']);
  f.release('build', 'first'); f.release('build', 'series/first'); f.release('build', 'second');
  f.release('activate', 'series/first'); f.release('activate', 'second'); f.release('rollback');
  const wanted = path.join(f.env.HERDR_MONITOR_HOME, 'releases/series/first');
  assert.equal(fs.readlinkSync(path.join(f.env.HERDR_MONITOR_HOME, 'current')), wanted);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.bin, '.monitor-entry.json'))).product, wanted);
  f.release('rollback'); assert.match(fs.readlinkSync(path.join(f.env.HERDR_MONITOR_HOME, 'current')), /releases\/second$/u);
  f.release('restore');
});

test('terminated install recovers a staged shell replacement as well as the first installed snippet', { timeout: 30000 }, (t) => {
  const f = fixture(t), rc = path.join(f.home, '.zshrc'), preload = path.join(f.root, 'staged-fault.cjs');
  fs.writeFileSync(preload, `const fs=require('fs'),rename=fs.renameSync;fs.renameSync=function(from,to){if(to===${JSON.stringify(rc)})process.exit(74);return rename.apply(this,arguments);};\n`);
  const failed = f.run(process.execPath, ['--require', preload, path.join(source, 'herdr/entry-install.mjs'), '--product', f.repo, '--snapshot']);
  assert.equal(failed.status, 74);
  const journal = JSON.parse(fs.readFileSync(path.join(f.bin, '.monitor-recovery.json')));
  const staged = journal.changes.find((change) => change.file === rc).temporary;
  assert.ok(fs.existsSync(staged)); assert.ok(fs.existsSync(path.join(f.home, '.zshenv')));
  assert.equal(f.driver('--recover').status, 0);
  assert.deepEqual(fs.readdirSync(f.home), ['monitor']);
  assert.deepEqual(fs.readdirSync(f.bin), []);
  assert.equal(fs.existsSync(journal.runtime), false);
});

test('edited adapters/snippets and planted symlinks refuse before activation or removal mutates state', { timeout: 30000 }, (t) => {
  const f = fixture(t); f.release('build', 'first'); f.release('build', 'second'); f.release('activate', 'first');
  const current = fs.readlinkSync(path.join(f.env.HERDR_MONITOR_HOME, 'current'));
  const wrapper = path.join(f.bin, 'codex'), original = fs.readFileSync(wrapper, 'utf8');
  fs.appendFileSync(wrapper, '# Edited\n');
  const failed = f.run('bash', [path.join(source, 'herdr/release.sh'), 'activate', 'second']);
  assert.notEqual(failed.status, 0); assert.equal(fs.readlinkSync(path.join(f.env.HERDR_MONITOR_HOME, 'current')), current);
  assert.notEqual(f.driver('--remove').status, 0); assert.ok(fs.existsSync(path.join(f.home, '.zshenv')));
  fs.writeFileSync(wrapper, original);
  const rc = path.join(f.home, '.zshrc'), hook = fs.readFileSync(rc, 'utf8');
  fs.writeFileSync(rc, hook.replace('export PATH=', 'export CHANGED='));
  assert.notEqual(f.driver('--remove').status, 0); assert.equal(fs.readFileSync(wrapper, 'utf8'), original);
  fs.writeFileSync(rc, hook);
  assert.equal(f.driver('--remove').status, 0);
  fs.symlinkSync(path.join(f.root, 'outside'), wrapper);
  assert.notEqual(f.driver().status, 0); assert.ok(fs.lstatSync(wrapper).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(f.home, '.zshenv')), false);
});

test('rolling back to a release without discovery removes entry and can roll forward again', { timeout: 30000 }, (t) => {
  const f = fixture(t);
  f.ok('git', ['rm', '-qr', 'discovery', 'herdr/install.sh']); f.ok('git', ['commit', '-qm', 'Legacy fixture']); f.ok('git', ['tag', 'legacy']);
  f.release('build', 'legacy'); f.release('build', 'first');
  f.release('activate', 'legacy'); f.release('activate', 'first'); f.release('rollback');
  assert.equal(fs.existsSync(path.join(f.bin, 'codex')), false); assert.equal(fs.existsSync(path.join(f.home, '.zshenv')), false);
  f.release('rollback'); assert.ok(fs.existsSync(path.join(f.bin, 'codex')));
  f.release('restore');
});
