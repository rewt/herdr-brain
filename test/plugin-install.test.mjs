import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runPTY, PTY_SKIP_REASON } from './helpers/pty.mjs';
import { releaseEnvironment } from './helpers/release-environment.mjs';
import { assertSupervisorEntry } from '../acceptance/entry.mjs';

const source = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-plugin-test-'));
  t.after(() => { spawnSync('chmod', ['-R', 'u+w', root], { timeout: 5000 }); fs.rmSync(root, { recursive: true, force: true }); });
  const repo = path.join(root, 'source'), home = path.join(root, 'user'), nativeBin = path.join(root, 'native');
  for (const dir of [repo, home, nativeBin]) fs.mkdirSync(dir);
  for (const dir of ['bin', 'lib', 'lanes', 'discovery', 'herdr', 'housekeeping', 'dispatch', 'watch', 'settle', 'promote', 'supervisor']) fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true });
  fs.copyFileSync(path.join(source, 'herdr-plugin.toml'), path.join(repo, 'herdr-plugin.toml'));
  const native = path.join(nativeBin, 'codex'), receipt = path.join(root, 'native.json');
  fs.writeFileSync(native, `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.ENTRY_TEST_RECEIPT,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n`, { mode: 0o755 });
  fs.symlinkSync(native, path.join(nativeBin, 'claude'));
  const env = releaseEnvironment(process.env, { HOME: home, ZDOTDIR: home, ORG_ACTOR: `eng80-r97-${createHash('sha256').update(t.name).digest('hex').slice(0, 12)}`, ORG_DIR: '',
    PATH: `${nativeBin}:${process.env.PATH}`, HERDR_MONITOR_HOME: path.join(home, 'monitor'), HERDR_MONITOR_BIN: path.join(home, 'bin'), HERDR_MONITOR_ENTRY_BIN: path.join(home, 'monitor/entry/bin'),
    HERDR_MONITOR_REPO: repo, HERDR_MONITOR_CODEX: native, HERDR_MONITOR_CLAUDE: path.join(nativeBin, 'claude'), HERDR_MONITOR_PLIST: path.join(root, 'absent.plist'),
    RELEASE_NO_NPM: '1', RELEASE_NO_HERDR: '1', RELEASE_NO_LAUNCHD: '1', MONITOR_INSTALL_BUILD_ONLY: '', MONITOR_ENTRY_BYPASS: '', MONITOR_REQUEST_DIR: '',
    HERDR_INTEGRATION_ID: '', HERDR_PANE_ID: '', HERDR_PLUGIN_ROOT: '', HERDR_PLUGIN_CONTEXT_JSON: '', MONITOR_RUNTIME_DIR: path.join(root, 'queue'), MONITOR_WORKTREE_ROOT: path.join(root, 'lanes'), ENTRY_TEST_RECEIPT: receipt,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
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

async function waitUntil(check, label) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function installChild(t, f, preload, actor) {
  const child = spawn(process.execPath, ['--require', preload, path.join(source, 'herdr/entry-install.mjs'), '--product', f.repo, '--snapshot'], {
    cwd: f.repo, env: { ...f.env, ORG_ACTOR: `${f.env.ORG_ACTOR}-${actor}` }, timeout: 15000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', (part) => { output += part; }); child.stderr.on('data', (part) => { output += part; });
  const ended = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (status) => resolve({ status, output })); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { child, ended };
}

for (const target of ['shell', 'adapter', 'receipt', 'absent adapter', 'unchanged shell']) {
  for (const edit of ['bytes', 'mode']) {
    if (target === 'absent adapter' && edit === 'mode') continue;
    test(`planning rejects ${edit} edits to ${target} without publishing a journal`, { timeout: 30000 }, (t) => {
      const f = fixture(t), rc = path.join(f.home, '.zshrc');
      fs.writeFileSync(rc, Buffer.from([35, 32, 255, 10]), { mode: 0o600 });
      const installed = target !== 'shell';
      if (installed) assert.equal(f.driver('--snapshot').status, 0);
      // The unchanged-shell case exercises an idempotent install's empty diff.
      const file = target.includes('shell') ? rc : path.join(f.bin, target === 'receipt' ? '.monitor-entry.json' : target === 'absent adapter' ? 'monitor-claude' : 'codex');
      if (target === 'absent adapter') {
        assert.equal(f.driver('--remove').status, 0);
      }
      const before = new Map([rc, ...['codex', 'monitor-codex', 'claude', 'monitor-claude', '.monitor-entry.json', '.monitor-shell.json'].map((name) => path.join(f.bin, name))]
        .map((name) => [name, fs.existsSync(name) ? { content: fs.readFileSync(name), mode: fs.statSync(name).mode & 0o777 } : null]));
      const runtimeRoot = path.join(f.env.HERDR_MONITOR_HOME, 'entry/runtimes');
      const runtimes = fs.existsSync(runtimeRoot) ? fs.readdirSync(runtimeRoot) : [];
      const evidence = path.join(f.root, 'edit-observed'), preload = path.join(f.root, 'planning-edit.cjs');
      // A separate staged installer runs after destination ownership preflight.
      // Change the destination from the parent just before that child starts.
      fs.writeFileSync(preload, `const fs=require('fs'),cp=require('child_process'),spawn=cp.spawnSync;cp.spawnSync=function(command,args,...rest){if(args[0]===${JSON.stringify(path.join(f.repo, 'discovery/install.mjs'))}){${edit === 'mode' ? `fs.chmodSync(${JSON.stringify(file)},0o640);` : `fs.mkdirSync(require('path').dirname(${JSON.stringify(file)}),{recursive:true});fs.appendFileSync(${JSON.stringify(file)},Buffer.from([35,32,254,10]));`}fs.writeFileSync(${JSON.stringify(evidence)},'');}return spawn.call(this,command,args,...rest);};require('module').syncBuiltinESMExports();\n`);
      const result = f.run(process.execPath, ['--require', preload, path.join(source, 'herdr/entry-install.mjs'), '--product', f.repo, '--snapshot']);
      assert.equal(fs.existsSync(evidence), true, 'edit must occur during staged planning');
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /machine file changed during planning/u);
      for (const [name, original] of before) {
        if (name === file) {
          const content = edit === 'bytes' ? Buffer.concat([original?.content ?? Buffer.alloc(0), Buffer.from([35, 32, 254, 10])]) : original.content;
          assert.deepEqual(fs.readFileSync(name), content, 'operator bytes survive');
          if (edit === 'mode') assert.equal(fs.statSync(name).mode & 0o777, 0o640, 'operator mode survives');
        } else if (original) {
          assert.deepEqual(fs.readFileSync(name), original.content, name);
          assert.equal(fs.statSync(name).mode & 0o777, original.mode, name);
        } else assert.equal(fs.existsSync(name), false, name);
      }
      assert.equal(fs.existsSync(path.join(f.bin, '.monitor-recovery.json')), false);
      assert.deepEqual(fs.existsSync(runtimeRoot) ? fs.readdirSync(runtimeRoot) : [], runtimes, 'no runtime is published');
    });
  }
}

test('release tests preserve a separate installation inherited through the parent environment', { timeout: 90000 }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, '.zshrc'), '# Parent shell\n', { mode: 0o600 });
  assert.equal(f.driver('--snapshot').status, 0);
  const files = [...fs.readdirSync(f.bin).map((name) => path.join(f.bin, name)), ...['.zshenv', '.zshrc', '.bashrc', '.bash_profile'].map((name) => path.join(f.home, name))];
  const before = files.map((file) => ({ file, content: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 }));
  const childEnv = { ...f.env }; delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', path.join(source, 'test/release.test.mjs')], {
    cwd: source, env: childEnv, encoding: 'utf8', timeout: 60000,
  });
  for (const { file, content, mode } of before) {
    assert.equal(fs.existsSync(file), true, `${file} must survive the child release suite`);
    assert.deepEqual(fs.readFileSync(file), content, file);
    assert.equal(fs.statSync(file).mode & 0o777, mode, file);
  }
  assert.match(result.stdout, /# tests [1-9]\d*\n/u, 'the child must execute the release suite');
  assert.match(result.stdout, /# skipped 0\n/u, 'both release fixture paths must run');
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  assert.equal(f.driver('--remove').status, 0);
});

test('overlapping installs serialize before planning and retain the first runtime and complete entry', { timeout: 30000 }, async (t) => {
  const f = fixture(t), rc = path.join(f.home, '.zshrc'), original = Buffer.from([35, 32, 255, 10]);
  fs.writeFileSync(rc, original);
  const paused = path.join(f.root, 'first-planning'), release = path.join(f.root, 'release-first'), attempted = path.join(f.root, 'second-lock-attempt'), read = path.join(f.root, 'second-state-read');
  const first = path.join(f.root, 'first.cjs'), second = path.join(f.root, 'second.cjs');
  fs.writeFileSync(first, `const fs=require('fs'),read=fs.readFileSync;let paused=false;fs.readFileSync=function(file,...args){const result=read.call(this,file,...args);if(file===${JSON.stringify(rc)}&&!paused){paused=true;fs.writeFileSync(${JSON.stringify(paused)},'');const end=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>end)throw new Error('barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}return result;};\n`);
  const lock = path.join(path.dirname(f.bin), '.monitor-install.lock');
  fs.writeFileSync(second, `const fs=require('fs'),read=fs.readFileSync,rename=fs.renameSync;fs.readFileSync=function(file,...args){if(${JSON.stringify([rc, path.join(f.bin, '.monitor-shell.json'), path.join(f.bin, '.monitor-entry.json')])}.includes(file))fs.writeFileSync(${JSON.stringify(read)},'');return read.call(this,file,...args);};fs.renameSync=function(from,to){if(to===${JSON.stringify(lock)})fs.writeFileSync(${JSON.stringify(attempted)},'');return rename.apply(this,arguments);};\n`);
  const a = installChild(t, f, first, 'first');
  await waitUntil(() => fs.existsSync(paused), 'first planner barrier');
  const lockOwner = JSON.parse(fs.readFileSync(path.join(lock, fs.readdirSync(lock)[0])));
  assert.equal(lockOwner.pid, a.child.pid);
  const b = installChild(t, f, second, 'second');
  await waitUntil(() => fs.existsSync(attempted), 'second lock attempt');
  assert.equal(fs.existsSync(read), false, 'second install must not read shell/receipt state while first owns planning');
  fs.writeFileSync(release, '');
  for (const result of await Promise.all([a.ended, b.ended])) assert.equal(result.status, 0, result.output);
  const entry = JSON.parse(fs.readFileSync(path.join(f.bin, '.monitor-entry.json')));
  for (const [name, content] of Object.entries(entry.files)) assert.deepEqual(fs.readFileSync(path.join(f.bin, name)), Buffer.from(content));
  assert.equal(JSON.parse(fs.readFileSync(path.join(entry.product, '.monitor-runtime-owner.json'))).token, lockOwner.token);
  assert.equal(fs.existsSync(read), true);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(path.join(f.bin, '.monitor-recovery.json')), false);
  const shell = JSON.parse(fs.readFileSync(path.join(f.bin, '.monitor-shell.json'))), hook = shell.hooks.find((hook) => hook.file === rc);
  assert.deepEqual(fs.readFileSync(rc), Buffer.concat([original, Buffer.from(hook.block, 'base64')]));
  assert.equal(f.driver('--remove').status, 0); assert.deepEqual(fs.readFileSync(rc), original);
});

test('a complete stale plan refuses before a journal and cannot roll back another successful install', { timeout: 30000 }, async (t) => {
  const f = fixture(t), { state, transact } = await import('../herdr/entry-transaction.mjs'), { snapshot } = await import('../herdr/entry-runtime.mjs'), { withInstallationLock } = await import('../herdr/entry-lock.mjs');
  const lock = path.join(path.dirname(f.bin), '.monitor-install.lock'), runtimes = path.join(f.env.HERDR_MONITOR_HOME, 'entry/runtimes');
  let obsolete;
  withInstallationLock(lock, (owner) => { obsolete = snapshot(f.repo, runtimes, owner.token); });
  assert.equal(f.driver('--snapshot').status, 0);
  const installed = new Map(fs.readdirSync(f.bin).map((name) => [name, fs.readFileSync(path.join(f.bin, name))]));
  const entry = JSON.parse(installed.get('.monitor-entry.json'));
  const beforeRuntime = fs.readFileSync(path.join(entry.product, '.monitor-runtime-owner.json'));
  // Include an unchanged early file so validating only at each write would
  // publish a journal before reaching the stale second file.
  const first = path.join(f.bin, 'codex'), later = path.join(f.bin, 'monitor-codex');
  withInstallationLock(lock, (owner) => assert.throws(() => transact(path.join(f.bin, '.monitor-recovery.json'), f.bin, runtimes,
    [{ file: first, before: state(first), after: { content: Buffer.from('# replacement\n'), mode: 0o755 } }, { file: later, before: null, after: state(later) }], obsolete, owner), /changed during planning/u));
  withInstallationLock(lock, (owner) => assert.throws(() => transact(path.join(f.bin, '.monitor-recovery.json'), f.bin, runtimes,
    [], obsolete, owner), /runtime appeared during planning/u));
  for (const [name, content] of installed) assert.deepEqual(fs.readFileSync(path.join(f.bin, name)), content);
  assert.deepEqual(fs.readFileSync(path.join(entry.product, '.monitor-runtime-owner.json')), beforeRuntime);
  assert.equal(fs.existsSync(path.join(f.bin, '.monitor-recovery.json')), false);
  assert.equal(f.driver('--remove').status, 0);
});

test('runtime rollback removes only its own staging directory and preserves a foreign final runtime', { timeout: 30000 }, (t) => {
  const f = fixture(t), runtimes = path.join(f.env.HERDR_MONITOR_HOME, 'entry/runtimes'), evidence = path.join(f.root, 'foreign-runtime'), preload = path.join(f.root, 'runtime-collision.cjs');
  fs.writeFileSync(preload, `const fs=require('fs'),mkdir=fs.mkdirSync;let done=false;fs.mkdirSync=function(file,...args){const result=mkdir.call(this,file,...args);if(typeof file==='string'&&file.startsWith(${JSON.stringify(runtimes + '/.runtime-')})&&file.endsWith('.tmp')&&!done){done=true;const plan=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.bin, '.monitor-recovery.json'))}));mkdir.call(this,plan.runtime.directory);fs.writeFileSync(plan.runtime.directory+'/.monitor-runtime-owner.json',JSON.stringify({token:'another-owner'}));fs.writeFileSync(plan.runtime.directory+'/foreign','retain these bytes');fs.writeFileSync(${JSON.stringify(evidence)},plan.runtime.directory);}return result;};\n`);
  const failed = f.run(process.execPath, ['--require', preload, path.join(source, 'herdr/entry-install.mjs'), '--product', f.repo, '--snapshot']);
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /runtime appeared during planning/u);
  const foreign = fs.readFileSync(evidence, 'utf8');
  assert.equal(fs.readFileSync(path.join(foreign, 'foreign'), 'utf8'), 'retain these bytes');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(foreign, '.monitor-runtime-owner.json'))), { token: 'another-owner' });
  assert.deepEqual(fs.readdirSync(runtimes), [path.basename(foreign)]);
  assert.deepEqual(fs.readdirSync(f.bin), []);
  assert.equal(fs.existsSync(path.join(f.home, '.zshenv')), false);
});

test('rollback leaves an unstarted file alone even when another writer supplied its planned after-bytes', { timeout: 30000 }, (t) => {
  const f = fixture(t), foreign = path.join(f.bin, 'monitor-claude'), evidence = path.join(f.root, 'foreign.bin'), preload = path.join(f.root, 'external-writer.cjs');
  fs.writeFileSync(preload, `const fs=require('fs'),rename=fs.renameSync;let done=false;fs.renameSync=function(from,to){const result=rename.apply(this,arguments);if(to===${JSON.stringify(path.join(f.bin, 'codex'))}&&!done){done=true;const plan=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.bin, '.monitor-recovery.json'))}));const bytes=Buffer.from(plan.changes.find(c=>c.file===${JSON.stringify(foreign)}).after.content,'base64');fs.writeFileSync(${JSON.stringify(foreign)},bytes,{mode:0o755});fs.writeFileSync(${JSON.stringify(evidence)},bytes);}return result;};\n`);
  const failed = f.run(process.execPath, ['--require', preload, path.join(source, 'herdr/entry-install.mjs'), '--product', f.repo, '--snapshot']);
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /changed during installation/u);
  assert.deepEqual(fs.readFileSync(foreign), fs.readFileSync(evidence));
  assert.deepEqual(fs.readdirSync(f.bin), ['monitor-claude']);
  assert.equal(fs.existsSync(path.join(f.home, '.zshenv')), false);
});

test('shell install, upgrade and restore preserve every original byte including malformed UTF-8', { timeout: 30000 }, (t) => {
  const f = fixture(t), originals = new Map();
  for (const [index, name] of ['.zshenv', '.zshrc', '.bashrc', '.bash_profile'].entries()) {
    const file = path.join(f.home, name), content = Buffer.concat([Buffer.from('# operator bytes\r\n# '), Buffer.from([255, 128, 192, 175, 226, 130, 237, 160, 128, index])]);
    originals.set(file, { content, mode: index % 2 ? 0o600 : 0o640 });
    fs.writeFileSync(file, content, { mode: originals.get(file).mode });
  }
  assert.equal(f.driver('--snapshot').status, 0);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.bin, '.monitor-shell.json'))); assert.equal(receipt.version, 2);
  for (const hook of receipt.hooks) {
    const original = originals.get(hook.file);
    assert.deepEqual(Buffer.from(hook.before, 'base64'), original.content);
    assert.deepEqual(fs.readFileSync(hook.file), Buffer.concat([original.content, Buffer.from(hook.block, 'base64')]));
  }
  f.release('build', 'first'); f.release('activate', 'first'); f.release('restore');
  for (const [file, original] of originals) {
    assert.deepEqual(fs.readFileSync(file), original.content, file);
    assert.equal(fs.statSync(file).mode & 0o777, original.mode, file);
  }
});

for (const crash of [false, true]) test(`non-UTF-8 shell bytes survive ${crash ? 'terminated-install recovery' : 'failed-write rollback'}`, { timeout: 30000 }, (t) => {
  const f = fixture(t), before = new Map();
  for (const name of ['.zshenv', '.zshrc', '.bashrc', '.bash_profile']) {
    const file = path.join(f.home, name), content = Buffer.from([35, 32, 255, 192, 128, 10]);
    before.set(file, content); fs.writeFileSync(file, content);
  }
  const preload = path.join(f.root, 'binary-fault.cjs');
  fs.writeFileSync(preload, `const fs=require('fs'),rename=fs.renameSync;fs.renameSync=function(from,to){const result=rename.apply(this,arguments);if(to===${JSON.stringify(path.join(f.home, '.zshenv'))}){${crash ? 'process.exit(73)' : `fs.chmodSync(${JSON.stringify(path.join(f.home, '.bashrc'))},0o400)`};}return result;};\n`);
  const failed = f.run(process.execPath, ['--require', preload, path.join(source, 'herdr/entry-install.mjs'), '--product', f.repo, '--snapshot']);
  assert.notEqual(failed.status, 0);
  if (crash) {
    assert.equal(failed.status, 73);
    const journal = JSON.parse(fs.readFileSync(path.join(f.bin, '.monitor-recovery.json'))); assert.equal(journal.version, 2);
    assert.deepEqual(Buffer.from(journal.changes.find((change) => change.file === path.join(f.home, '.zshenv')).before.content, 'base64'), before.get(path.join(f.home, '.zshenv')));
    assert.equal(f.driver('--recover').status, 0);
  }
  for (const [file, content] of before) assert.deepEqual(fs.readFileSync(file), content, file);
  assert.deepEqual(fs.readdirSync(f.bin), []);
  assert.equal(fs.existsSync(path.join(path.dirname(f.bin), '.monitor-install.lock')), false);
});

for (const crash of [false, true]) {
  for (const point of ['staged', 'applied', 'operator chmod']) {
    test(`mode-only reinstallation at ${point} survives ${crash ? 'terminated-install recovery' : 'failed-write rollback'}`, { timeout: 30000 }, (t) => {
      const f = fixture(t), rc = path.join(f.home, '.zshrc'), journal = path.join(f.bin, '.monitor-recovery.json');
      fs.writeFileSync(rc, '# Operator shell\n', { mode: 0o644 });
      assert.equal(f.driver('--snapshot').status, 0);
      fs.chmodSync(rc, 0o600);
      const files = [...fs.readdirSync(f.bin).map((name) => path.join(f.bin, name)), ...['.zshenv', '.zshrc', '.bashrc', '.bash_profile'].map((name) => path.join(f.home, name))];
      const before = files.map((file) => ({ file, content: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 }));
      const runtimes = path.join(f.env.HERDR_MONITOR_HOME, 'entry/runtimes'), installedRuntimes = fs.readdirSync(runtimes);
      const evidence = path.join(f.root, 'mode-fault.json'), preload = path.join(f.root, 'mode-fault.cjs');
      // Fail immediately before or after the actual replacement. A third state
      // is an operator chmod while the original bytes still occupy the path.
      fs.writeFileSync(preload, `const fs=require('fs'),rename=fs.renameSync;let done=false;fs.renameSync=function(from,to){
  if(to!==${JSON.stringify(rc)}||done)return rename.apply(this,arguments);
  done=true;
  const plan=JSON.parse(fs.readFileSync(${JSON.stringify(journal)})),change=plan.changes.find(change=>change.file===to);
  ${point === 'applied' ? 'rename.apply(this,arguments);' : point === 'operator chmod' ? 'fs.chmodSync(to,0o640);' : ''}
  fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({change,mode:fs.statSync(to).mode&0o777}));
  ${crash ? 'process.exit(73);' : "throw Object.assign(new Error('injected shell replacement failure'),{code:'EIO'});"}
};\n`);
      const failed = f.run(process.execPath, ['--require', preload, path.join(source, 'herdr/entry-install.mjs'), '--product', f.repo, '--snapshot']);
      const proof = JSON.parse(fs.readFileSync(evidence));
      assert.equal(proof.change.started, true, 'write intent precedes the fault');
      assert.equal(proof.change.before.mode, 0o600);
      assert.equal(proof.change.after.mode, 0o644);
      assert.equal(proof.change.before.content, proof.change.after.content, 'replacement changes only the mode');
      assert.equal(proof.mode, point === 'applied' ? 0o644 : point === 'operator chmod' ? 0o640 : 0o600);
      if (crash) {
        assert.equal(failed.status, 73);
        assert.equal(fs.existsSync(journal), true);
        assert.equal(fs.existsSync(proof.change.temporary), point !== 'applied');
        assert.equal(f.driver('--recover').status, 0);
      } else {
        assert.equal(failed.status, 1);
        assert.match(failed.stderr, /injected shell replacement failure/u);
      }
      for (const { file, content, mode } of before) {
        assert.deepEqual(fs.readFileSync(file), content, file);
        assert.equal(fs.statSync(file).mode & 0o777, file === rc && point === 'operator chmod' ? 0o640 : mode, file);
      }
      assert.equal(fs.existsSync(journal), false);
      assert.equal(fs.existsSync(proof.change.temporary), false);
      assert.equal(fs.existsSync(path.join(path.dirname(f.bin), '.monitor-install.lock')), false);
      assert.deepEqual(fs.readdirSync(runtimes), installedRuntimes);
      assert.equal(f.driver('--recover').status, 0, 'completed recovery is idempotent');
    });
  }
}

test('legacy shell receipts preserve new non-UTF-8 edits outside the managed snippet', { timeout: 30000 }, (t) => {
  const f = fixture(t); assert.equal(f.driver('--snapshot').status, 0);
  const marker = path.join(f.bin, '.monitor-shell.json'), receipt = JSON.parse(fs.readFileSync(marker));
  for (const hook of receipt.hooks) { hook.before = Buffer.from(hook.before, 'base64').toString('utf8'); hook.block = Buffer.from(hook.block, 'base64').toString('utf8'); }
  delete receipt.version; fs.writeFileSync(marker, JSON.stringify(receipt) + '\n');
  const rc = path.join(f.home, '.zshrc'), added = Buffer.from([35, 32, 255, 226, 130, 10]); fs.appendFileSync(rc, added);
  assert.equal(f.driver('--snapshot').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(marker)).version, 2);
  assert.equal(f.driver('--remove').status, 0); assert.deepEqual(fs.readFileSync(rc), added);
});

test('relocated installed runtime executes lane review through its bundled template dependency', { timeout: 30000 }, (t) => {
  const f = fixture(t); f.ok('bash', [path.join(f.repo, 'herdr/install.sh')]);
  const runtime = JSON.parse(fs.readFileSync(path.join(f.bin, '.monitor-entry.json'))).product;
  const template = path.join(runtime, 'lanes/docs/REVIEW_TEMPLATE.md');
  assert.deepEqual(fs.readFileSync(template), fs.readFileSync(path.join(source, 'lanes/docs/REVIEW_TEMPLATE.md')));
  fs.renameSync(f.repo, path.join(f.root, 'relocated-plugin'));
  const project = path.join(f.root, 'project'); fs.mkdirSync(project);
  assert.match(f.ok(process.execPath, [path.join(runtime, 'settle/settle.mjs')], project), /^settle R-n/u);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Plugin Test'], ['config', 'user.email', 'plugin@example.invalid']]) f.ok('git', args, project);
  fs.writeFileSync(path.join(project, '.gitignore'), '.lane/\n');
  const config = path.join(project, '.lane.json'); fs.writeFileSync(config, JSON.stringify({ main: 'main', validate: 'true', routes: {} }));
  f.ok('git', ['add', '.'], project); f.ok('git', ['commit', '-qm', 'Project'], project);
  const env = { LANE_CONFIG: config, LANE_WORKTREE_ROOT: path.join(f.root, 'review-lanes') };
  const cli = path.join(runtime, 'lanes/lane.mjs'); f.ok(process.execPath, [cli, 'open', 'asset-check'], project, env);
  // Witness the real command's template read, then stop at an offline dispatch
  // refusal. The fake Herdr executable prevents any live pane operation.
  fs.writeFileSync(path.join(path.dirname(f.native), 'herdr'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const evidence = path.join(f.root, 'template-read'), preload = path.join(f.root, 'template-probe.cjs');
  const brief = path.join(f.root, 'review-brief.md'); fs.writeFileSync(brief, 'Review the scratch project. Do not run commands.\n');
  fs.writeFileSync(preload, `const fs=require('fs'),read=fs.readFileSync;fs.readFileSync=function(file,...args){const value=read.call(this,file,...args);if(file===${JSON.stringify(template)})fs.writeFileSync(${JSON.stringify(evidence)},value);return value;};require('module').syncBuiltinESMExports();\n`);
  const reviewed = f.run(process.execPath, ['--require', preload, cli, 'review', 'asset-check', '--round', '1', '--brief', brief, '--timeout', '10'], project, env);
  assert.notEqual(reviewed.status, 0); assert.ok(!reviewed.stderr.includes('ENOENT'), reviewed.stderr);
  assert.ok(fs.existsSync(evidence), reviewed.stdout + reviewed.stderr);
  assert.deepEqual(fs.readFileSync(evidence), fs.readFileSync(template));
  f.ok(process.execPath, [path.join(source, 'herdr/entry-install.mjs'), '--remove'], project);
});

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
  assertSupervisorEntry(JSON.parse(supervisor.args.find((arg) => arg.startsWith('developer_instructions=')).slice('developer_instructions='.length)));
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
  assertSupervisorEntry(JSON.parse(native.args.find((arg) => arg.startsWith('developer_instructions=')).slice('developer_instructions='.length)));
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
  assert.equal(fs.existsSync(proof.runtime.directory), false);
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
  assert.equal(fs.existsSync(journal.runtime.directory), false);
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
