import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  const env = { ...process.env, HOME: home, ZDOTDIR: home, ORG_ACTOR: 'eng80-plugin-offline', ORG_DIR: '',
    PATH: `${nativeBin}:${process.env.PATH}`, HERDR_MONITOR_HOME: path.join(home, 'monitor'), HERDR_MONITOR_BIN: path.join(home, 'bin'), HERDR_MONITOR_ENTRY_BIN: path.join(home, 'monitor/entry/bin'),
    HERDR_MONITOR_REPO: repo, HERDR_MONITOR_CODEX: native, HERDR_MONITOR_CLAUDE: path.join(nativeBin, 'claude'), HERDR_MONITOR_PLIST: path.join(root, 'absent.plist'),
    RELEASE_NO_NPM: '1', RELEASE_NO_HERDR: '1', RELEASE_NO_LAUNCHD: '1', MONITOR_INSTALL_BUILD_ONLY: '', MONITOR_ENTRY_BYPASS: '', MONITOR_REQUEST_DIR: '',
    HERDR_INTEGRATION_ID: '', HERDR_PANE_ID: '', MONITOR_RUNTIME_DIR: path.join(root, 'queue'), MONITOR_WORKTREE_ROOT: path.join(root, 'lanes'), ENTRY_TEST_RECEIPT: receipt,
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

test('manifest build installs entry even when npm is skipped; restores preserve surrounding user edits', { timeout: 30000 }, (t) => {
  const f = fixture(t);
  f.ok('bash', [path.join(f.repo, 'herdr/install.sh')]);
  const rc = path.join(f.home, '.zshrc'); fs.appendFileSync(rc, '# Later user edit\n');
  const remove = f.driver('--remove'); assert.equal(remove.status, 0, remove.stderr);
  assert.equal(fs.readFileSync(rc, 'utf8'), '# Later user edit\n');
  assert.equal(fs.existsSync(path.join(f.home, '.zshenv')), false);
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
