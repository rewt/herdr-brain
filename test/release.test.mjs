// herdr/release.sh: releases are immutable copies of tags, switched by one link, and the
// launchers and Brain service can always go back to the dev checkout. Offline: a scratch
// repository, no Herdr, no npm, and launchctl replaced by `true`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'herdr', 'release.sh');
const MANIFEST = path.resolve(import.meta.dirname, '..', 'herdr-plugin.toml');

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const repo = path.join(root, 'repo');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  fs.mkdirSync(repo);
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  const version = v => {
    write('bin/org.mjs', `console.log('org ${v}');\n`);
    write('lanes/lane.mjs', `console.log('lane ${v}');\n`);
    write('brain/bin/brain.mjs', '');
    write('herdr-plugin.toml', fs.readFileSync(MANIFEST, 'utf8'));
    git('add', '-A'); git('commit', '-qm', v); git('tag', v);
  };
  version('t1'); version('t2');
  const bin = path.join(root, 'bin'), home = path.join(root, 'home'), plist = path.join(root, 'brain.plist');
  fs.mkdirSync(bin);
  fs.symlinkSync('/dev/checkout/bin/org.mjs', path.join(bin, 'org'));
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.rewt.herdr-brain</string>
<key>ProgramArguments</key><array><string>/node</string><string>/dev/checkout/brain/bin/brain.mjs</string><string>watch</string></array>
<key>WorkingDirectory</key><string>/dev/checkout/brain</string></dict></plist>\n`);
  // A fake launchctl: nothing is ever loaded (print fails), and the first bootstrap
  // fails the way launchd does when the old service is still unloading.
  const launchctl = path.join(root, 'launchctl'), calls = path.join(root, 'launchctl.calls');
  fs.writeFileSync(launchctl, `#!/bin/sh\necho "$*" >> ${calls}\n[ "$1" = print ] && exit 1\nif [ "$1" = bootstrap ] && [ ! -e ${root}/loaded-once ]; then touch ${root}/loaded-once; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi\nexit 0\n`, { mode: 0o755 });
  const env = { ...process.env, HERDR_MONITOR_REPO: repo, HERDR_MONITOR_HOME: home, HERDR_MONITOR_BIN: bin, HERDR_MONITOR_PLIST: plist,
    RELEASE_NO_HERDR: '1', RELEASE_NO_NPM: '1', RELEASE_LAUNCHCTL: launchctl };
  const run = (...a) => spawnSync('bash', [SCRIPT, ...a], { env, encoding: 'utf8' });
  const org = () => execFileSync(process.execPath, [path.join(bin, 'org')], { encoding: 'utf8' }).trim();
  const record = () => execFileSync(process.execPath, [path.join(bin, 'record')], { encoding: 'utf8' }).trim();
  const cleanup = () => { execFileSync('chmod', ['-R', 'u+w', root]); fs.rmSync(root, { recursive: true, force: true }); };
  const launchctlCalls = () => fs.readFileSync(calls, 'utf8').trim().split('\n');
  return { root, home, bin, plist, run, org, record, cleanup, launchctlCalls };
}

test('a release is a read-only copy of a tag, never rebuilt in place, and only from a tag', () => {
  const s = scratch();
  try {
    assert.equal(s.run('build', 't1').status, 0);
    const dir = path.join(s.home, 'releases', 't1');
    assert.equal(fs.readFileSync(path.join(dir, 'bin/org.mjs'), 'utf8'), "console.log('org t1');\n");
    assert.match(fs.readFileSync(path.join(dir, '.release-commit'), 'utf8'), /^[0-9a-f]{40}\n$/);
    assert.throws(() => fs.writeFileSync(path.join(dir, 'bin/org.mjs'), 'x'), /EACCES/);
    assert.match(s.run('build', 't1').stderr, /already exists/);
    assert.match(s.run('build', 'nope').stderr, /no tag nope/);
  } finally { s.cleanup(); }
});

test('activate moves the launchers and the Brain service onto current; rollback and restore undo it', () => {
  const s = scratch();
  try {
    s.run('build', 't1'); s.run('build', 't2');
    assert.equal(s.run('activate', 't1').status, 0);
    assert.equal(fs.readlinkSync(path.join(s.bin, 'record')), path.join(s.home, 'current/bin/org.mjs'));
    assert.equal(fs.readlinkSync(path.join(s.bin, 'org')), path.join(s.home, 'current/bin/org.mjs'));
    assert.equal(s.record(), 'org t1');
    assert.equal(s.org(), 'org t1');
    const plist = fs.readFileSync(s.plist, 'utf8');
    assert.match(plist, new RegExp(`${s.home}/current/brain/bin/brain.mjs`));
    assert.match(plist, /<string>\/node<\/string>/, 'the node path and arguments are kept');
    assert.deepEqual(s.launchctlCalls().map(c => c.split(' ')[0]), ['bootout', 'print', 'bootstrap', 'bootstrap'], 'a failed load is retried');
    s.run('activate', 't2');
    assert.equal(s.org(), 'org t2');
    assert.equal(s.run('rollback').status, 0);
    assert.equal(s.org(), 'org t1');
    assert.equal(s.run('restore').status, 0);
    assert.equal(fs.existsSync(path.join(s.bin, 'record')), false, 'a new launcher is removed on restore');
    assert.equal(fs.readlinkSync(path.join(s.bin, 'org')), '/dev/checkout/bin/org.mjs', 'back to the dev checkout');
    assert.match(fs.readFileSync(s.plist, 'utf8'), /\/dev\/checkout\/brain\/bin\/brain.mjs/);
  } finally { s.cleanup(); }
});

test('an existing before directory learns that the new record launcher was absent', () => {
  const s = scratch();
  try {
    const before = path.join(s.home, 'before');
    fs.mkdirSync(before, { recursive: true });
    fs.writeFileSync(path.join(before, 'org'), '/dev/checkout/bin/org.mjs\n');
    fs.writeFileSync(path.join(before, 'lane'), '/dev/checkout/lanes/lane.mjs\n');
    fs.symlinkSync('/dev/checkout/lanes/lane.mjs', path.join(s.bin, 'lane'));
    fs.copyFileSync(s.plist, path.join(before, 'plist'));
    s.run('build', 't1');
    assert.equal(s.run('activate', 't1').status, 0);
    assert.equal(fs.existsSync(path.join(before, 'record.missing')), true);
    assert.equal(s.run('restore').status, 0);
    assert.equal(fs.existsSync(path.join(s.bin, 'record')), false);
    assert.equal(fs.readlinkSync(path.join(s.bin, 'org')), '/dev/checkout/bin/org.mjs');
  } finally { s.cleanup(); }
});

test('a launcher that is a real file is never replaced', () => {
  const s = scratch();
  try {
    s.run('build', 't1');
    fs.writeFileSync(path.join(s.bin, 'lane'), '#!/bin/sh\n');
    assert.match(s.run('activate', 't1').stderr, /not a link; refusing/);
  } finally { s.cleanup(); }
});

test('the dev plugin is a second id pointed at a worktree', () => {
  const s = scratch();
  try {
    const wt = path.resolve(import.meta.dirname, '..');
    assert.equal(s.run('dev', wt).status, 0);
    const m = fs.readFileSync(path.join(s.home, 'dev/herdr-plugin.toml'), 'utf8');
    assert.match(m, /^id = "rewt\.herdr-monitor-dev"$/m);
    assert.match(m, /^name = "Herdr Monitor \(dev\)"$/m);
    assert.match(m, new RegExp(`exec \\\\"${wt}/herdr/console.sh\\\\"`));
    assert.match(m, /--plugin rewt\.herdr-monitor-dev --entrypoint console/);
    assert.doesNotMatch(m, /HERDR_PLUGIN_ROOT/);
  } finally { s.cleanup(); }
});

test('activating the active release again (after a failed step) keeps its real previous release', () => {
  const s = scratch();
  try {
    s.run('build', 't1'); s.run('build', 't2');
    s.run('activate', 't1'); s.run('activate', 't2');
    assert.equal(s.run('activate', 't2').status, 0);
    assert.equal(fs.readlinkSync(path.join(s.home, 'previous')), path.join(s.home, 'releases/t1'));
    s.run('rollback');
    assert.equal(s.org(), 'org t1');
  } finally { s.cleanup(); }
});

test('the plugin is linked to the active release itself and re-linked on every switch; restore unlinks it', () => {
  const s = scratch();
  try {
    // A fake herdr that resolves the linked path, as the real one does.
    const fake = path.join(s.root, 'herdr'), state = path.join(s.root, 'plugin-root');
    fs.writeFileSync(fake, `#!/bin/sh
case "$2" in
  list) r=$(cat ${state} 2>/dev/null); if [ -n "$r" ]; then echo "{\\"result\\":{\\"plugins\\":[{\\"plugin_id\\":\\"rewt.herdr-monitor\\",\\"plugin_root\\":\\"$r\\"}]}}"; else echo '{"result":{"plugins":[]}}'; fi ;;
  link) (cd "$3" && pwd -P) > ${state} ;;
  unlink) : > ${state} ;;
esac
`, { mode: 0o755 });
    const run = (...a) => spawnSync('bash', [SCRIPT, ...a], { env: { ...process.env, HERDR_MONITOR_REPO: path.join(s.root, 'repo'), HERDR_MONITOR_HOME: s.home,
      HERDR_MONITOR_BIN: s.bin, HERDR_MONITOR_PLIST: s.plist, RELEASE_NO_NPM: '1', RELEASE_NO_LAUNCHD: '1', HERDR_BIN_PATH: fake }, encoding: 'utf8' });
    const root = () => fs.readFileSync(state, 'utf8').trim();
    const real = t => fs.realpathSync(path.join(s.home, 'releases', t));
    run('build', 't1'); run('build', 't2');
    assert.equal(run('activate', 't1').status, 0); assert.equal(root(), real('t1'));
    run('activate', 't2'); assert.equal(root(), real('t2'));
    run('rollback'); assert.equal(root(), real('t1'));
    run('restore'); assert.equal(root(), '');
  } finally { s.cleanup(); }
});
