import { loadTimeout } from '../lib/deadline.mjs';
// herdr/release.sh: releases are immutable copies of tags, switched by one link, and the
// launchers can always go back to the dev checkout. Offline: a scratch repository, no
// Herdr, no npm and no launchd.
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { releaseEnvironment } from './helpers/release-environment.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'herdr', 'release.sh');
// Releases before the plugin's removal shipped this manifest; current releases ship none.
const LEGACY_MANIFEST = `id = "rewt.herdr-monitor"
name = "Herdr Monitor"

[[panes]]
id = "console"
command = ["sh", "-c", "exec \\"$HERDR_PLUGIN_ROOT/herdr/console.sh\\""]

[[actions]]
id = "open"
command = ["sh", "-c", "exec \\"\${HERDR_BIN_PATH:-herdr}\\" plugin pane open --plugin rewt.herdr-monitor --entrypoint console --no-focus"]
`;

function scratch({ plugin = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const repo = path.join(root, 'repo');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe', timeout: loadTimeout(5000) });
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  fs.mkdirSync(repo);
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  const version = v => {
    write('bin/org.mjs', `console.log('org ${v}');\n`);
    write('lanes/lane.mjs', `console.log('lane ${v}');\n`);
    if (plugin.includes(v)) write('herdr-plugin.toml', LEGACY_MANIFEST);
    else fs.rmSync(path.join(repo, 'herdr-plugin.toml'), { force: true });
    git('add', '-A'); git('commit', '-qm', v); git('tag', v);
  };
  version('t1'); version('t2');
  const bin = path.join(root, 'bin'), home = path.join(root, 'home'), plist = path.join(root, 'brain.plist');
  const userHome = path.join(root, 'user'); fs.mkdirSync(userHome);
  fs.mkdirSync(bin);
  fs.symlinkSync('/dev/checkout/bin/org.mjs', path.join(bin, 'org'));
  // The retired Brain LaunchAgent lives here, never at the operator's real plist.
  const env = releaseEnvironment(process.env, { HOME: userHome, ZDOTDIR: userHome, CODEX_HOME: path.join(userHome, '.codex'), CLAUDE_CONFIG_DIR: path.join(userHome, '.claude'),
    ORG_DIR: '', ORG_ACTOR: path.basename(root),
    HERDR_MONITOR_REPO: repo, HERDR_MONITOR_HOME: home, HERDR_MONITOR_BIN: bin, HERDR_MONITOR_PLIST: plist,
    RELEASE_NO_HERDR: '1', RELEASE_NO_NPM: '1' });
  const runWith = (extra, ...a) => spawnSync('bash', [SCRIPT, ...a], { env: { ...env, ...extra }, encoding: 'utf8', timeout: loadTimeout(20000) });
  const run = (...a) => runWith({}, ...a);
  const org = () => execFileSync(process.execPath, [path.join(bin, 'org')], { encoding: 'utf8', env, timeout: loadTimeout(5000) }).trim();
  const record = () => execFileSync(process.execPath, [path.join(bin, 'record')], { encoding: 'utf8', env, timeout: loadTimeout(5000) }).trim();
  const cleanup = () => { execFileSync('chmod', ['-R', 'u+w', root], { timeout: loadTimeout(5000) }); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, home, bin, plist, run, runWith, org, record, cleanup };
}

test('a release is a read-only copy of a tag, never rebuilt in place, and only from a tag', { timeout: 30000 }, () => {
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

test('activate moves the launchers onto current; rollback and restore undo it', { timeout: 30000 }, () => {
  const s = scratch();
  try {
    s.run('build', 't1'); s.run('build', 't2');
    assert.equal(s.run('activate', 't1').status, 0);
    assert.equal(fs.readlinkSync(path.join(s.bin, 'record')), path.join(s.home, 'current/bin/org.mjs'));
    assert.equal(fs.readlinkSync(path.join(s.bin, 'org')), path.join(s.home, 'current/bin/org.mjs'));
    assert.equal(s.record(), 'org t1');
    assert.equal(s.org(), 'org t1');
    s.run('activate', 't2');
    assert.equal(s.org(), 'org t2');
    assert.equal(s.run('rollback').status, 0);
    assert.equal(s.org(), 'org t1');
    assert.equal(s.run('restore').status, 0);
    assert.equal(fs.existsSync(path.join(s.bin, 'record')), false, 'a new launcher is removed on restore');
    assert.equal(fs.readlinkSync(path.join(s.bin, 'org')), '/dev/checkout/bin/org.mjs', 'back to the dev checkout');
  } finally { s.cleanup(); }
});

test('activation refuses while the retired Brain LaunchAgent exists and never rewrites or restores it', { timeout: 30000 }, () => {
  const s = scratch();
  try {
    s.run('build', 't1');
    const plist = '<plist><dict><key>ProgramArguments</key><array><string>/node</string><string>/x/current/brain/bin/brain.mjs</string><string>watch</string></array></dict></plist>\n';
    fs.writeFileSync(s.plist, plist);
    const refused = s.run('activate', 't1');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /still starts Brain watch.*launchctl bootout gui\/\d+\/com\.rewt\.herdr-brain; rm /);
    assert.equal(fs.existsSync(path.join(s.home, 'current')), false, 'nothing switched');
    assert.equal(fs.existsSync(path.join(s.home, 'before')), false, 'nothing remembered');
    assert.equal(s.runWith({ RELEASE_NO_LAUNCHD: '1' }, 'activate', 't1').status, 0, 'scratch installs may skip the check');
    assert.equal(fs.readFileSync(s.plist, 'utf8'), plist, 'activation never rewrites the plist');
    fs.rmSync(s.plist);
    fs.writeFileSync(path.join(s.home, 'before/plist'), plist); // Saved by an older release.sh.
    assert.equal(s.run('activate', 't1').status, 0);
    assert.equal(s.run('restore').status, 0);
    assert.equal(fs.existsSync(s.plist), false, 'restore never brings the Brain service back');
  } finally { s.cleanup(); }
});

test('an existing before directory learns that the new record launcher was absent', { timeout: 30000 }, () => {
  const s = scratch();
  try {
    const before = path.join(s.home, 'before');
    fs.mkdirSync(before, { recursive: true });
    fs.writeFileSync(path.join(before, 'org'), '/dev/checkout/bin/org.mjs\n');
    fs.writeFileSync(path.join(before, 'lane'), '/dev/checkout/lanes/lane.mjs\n');
    fs.symlinkSync('/dev/checkout/lanes/lane.mjs', path.join(s.bin, 'lane'));
    fs.writeFileSync(path.join(before, 'plist'), 'legacy Brain plist, now inert\n');
    s.run('build', 't1');
    assert.equal(s.run('activate', 't1').status, 0);
    assert.equal(fs.existsSync(path.join(before, 'record.missing')), true);
    assert.equal(s.run('restore').status, 0);
    assert.equal(fs.existsSync(path.join(s.bin, 'record')), false);
    assert.equal(fs.readlinkSync(path.join(s.bin, 'org')), '/dev/checkout/bin/org.mjs');
  } finally { s.cleanup(); }
});

test('restore preserves a replacement at a launcher that was originally missing', { timeout: 30000 }, () => {
  const s = scratch();
  try {
    s.run('build', 't1');
    assert.equal(s.run('activate', 't1').status, 0);

    const record = path.join(s.bin, 'record');
    fs.unlinkSync(record);
    fs.writeFileSync(record, '#!/bin/sh\necho user record\n');
    const fileRestore = s.run('restore');
    assert.equal(fileRestore.status, 0);
    assert.match(fileRestore.stderr, /record changed since activation; leaving it alone/);
    assert.equal(fs.readFileSync(record, 'utf8'), '#!/bin/sh\necho user record\n');

    fs.unlinkSync(record);
    fs.symlinkSync('/user/bin/record', record);
    const linkRestore = s.run('restore');
    assert.equal(linkRestore.status, 0);
    assert.match(linkRestore.stderr, /record changed since activation; leaving it alone/);
    assert.equal(fs.readlinkSync(record), '/user/bin/record');
  } finally { s.cleanup(); }
});

test('a launcher that is a real file is never replaced', { timeout: 30000 }, () => {
  const s = scratch();
  try {
    s.run('build', 't1');
    fs.writeFileSync(path.join(s.bin, 'lane'), '#!/bin/sh\n');
    assert.match(s.run('activate', 't1').stderr, /not a link; refusing/);
  } finally { s.cleanup(); }
});

test('the dev plugin is a second id pointed at an older worktree; current main has no manifest', { timeout: 30000 }, () => {
  const s = scratch();
  try {
    const refused = s.run('dev', path.resolve(import.meta.dirname, '..'));
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /has no herdr-plugin\.toml/);
    const wt = path.join(s.root, 'older-worktree'); fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'herdr-plugin.toml'), LEGACY_MANIFEST);
    assert.equal(s.run('dev', wt).status, 0);
    const m = fs.readFileSync(path.join(s.home, 'dev/herdr-plugin.toml'), 'utf8');
    assert.match(m, /^id = "rewt\.herdr-monitor-dev"$/m);
    assert.match(m, /^name = "Herdr Monitor \(dev\)"$/m);
    assert.match(m, new RegExp(`exec \\\\"${wt}/herdr/console.sh\\\\"`));
    assert.match(m, /--plugin rewt\.herdr-monitor-dev --entrypoint console/);
    assert.doesNotMatch(m, /HERDR_PLUGIN_ROOT/);
  } finally { s.cleanup(); }
});

test('activating the active release again (after a failed step) keeps its real previous release', { timeout: 30000 }, () => {
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

test('an older release with a plugin is linked to itself; a release without one unlinks it; restore unlinks it', { timeout: 30000 }, () => {
  const s = scratch({ plugin: ['t1'] });
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
    const run = (...a) => s.runWith({ RELEASE_NO_HERDR: '', RELEASE_NO_LAUNCHD: '1', HERDR_BIN_PATH: fake }, ...a);
    const root = () => fs.readFileSync(state, 'utf8').trim();
    const real = t => fs.realpathSync(path.join(s.home, 'releases', t));
    run('build', 't1'); run('build', 't2');
    assert.equal(run('activate', 't1').status, 0); assert.equal(root(), real('t1'));
    const current = run('activate', 't2'); assert.equal(current.status, 0, current.stderr); assert.equal(root(), '');
    assert.match(current.stdout, /unlinked Herdr plugin rewt\.herdr-monitor \(this release has none\)/);
    assert.equal(run('activate', 't2').status, 0); assert.equal(root(), '');
    run('rollback'); assert.equal(root(), real('t1'));
    run('restore'); assert.equal(root(), '');
  } finally { s.cleanup(); }
});
