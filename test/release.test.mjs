import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { releaseEnvironment } from './helpers/release-environment.mjs';
import { copyProduct, productFiles } from '../lib/product-files.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../herdr/release.sh');
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bare-release-')));
  t.after(() => { execFileSync('chmod', ['-R', 'u+w', root]); fs.rmSync(root, { recursive: true, force: true }); });
  const repo = path.join(root, 'repo'), home = path.join(root, 'releases-home'), bin = path.join(root, 'bin');
  copyProduct(path.resolve(import.meta.dirname, '..'), repo); fs.mkdirSync(bin);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', timeout: 10000 });
  git('init', '-qb', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  const gateLog = path.join(root, 'gates');
  write('herdr/release.sh', fs.readFileSync(SCRIPT, 'utf8'));
  write('package.json', JSON.stringify({ scripts: { 'test:release': `node gate.cjs` } }));
  write('gate.cjs', `const fs=require('fs');fs.appendFileSync(${JSON.stringify(gateLog)},process.cwd()+'\\n');if(process.env.FIXTURE_GATE_FAIL)process.exit(7);`);
  write('contrib/settle-watch.mjs', '// compatibility');
  write('acceptance/run.mjs', `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(gateLog)},'live:'+process.cwd()+'\\n');if(process.env.FIXTURE_LIVE_FAIL)process.exit(8);`);
  for (const tag of ['t1', 't2']) {
    write('bin/org.mjs', `console.log('${tag}');`); write('lanes/lane.mjs', `console.log('lane ${tag}');`);
    git('add', '.'); git('commit', '-qm', tag); git('tag', tag);
  }
  const herdr = path.join(bin, 'herdr'), pluginState = path.join(root, 'plugin'), calls = path.join(root, 'herdr-calls');
  fs.writeFileSync(pluginState, 'linked');
  fs.writeFileSync(herdr, `#!${process.execPath}
const fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},a.join(' ')+'\\n');
if(a[1]==='list')console.log(JSON.stringify({result:{plugins:fs.readFileSync(${JSON.stringify(pluginState)},'utf8')==='linked'?[{plugin_root:'/old'}]:[]}}));
else if(a[1]==='unlink'){if(process.env.FIXTURE_UNLINK_FAIL)process.exit(9);fs.writeFileSync(${JSON.stringify(pluginState)},'unlinked');}
`, { mode: 0o755 });
  // Use a .cjs extension for the fake Node CLI under any parent package type.
  fs.renameSync(herdr, `${herdr}.cjs`);
  const plist = path.join(root, 'old.plist');
  const env = releaseEnvironment(process.env, { HOME: root, HERDR_MONITOR_REPO: repo, HERDR_MONITOR_HOME: home,
    HERDR_MONITOR_BIN: bin, HERDR_MONITOR_PLIST: plist, HERDR_BIN_PATH: `${herdr}.cjs` });
  const run = (a, extra = {}) => spawnSync('bash', [SCRIPT, ...a], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
  const ok = (a, extra) => { const r = run(a, extra); assert.equal(r.status, 0, r.stdout + r.stderr); return r; };
  const release = tag => path.join(home, 'releases', tag);
  return { root, repo, home, bin, plist, env, run, ok, release, gateLog, calls, git, write };
}
test('build gates the tagged partial snapshot once, then publishes a read-only immutable copy', t => {
  const f = scratch(t); f.write('bin/org.mjs', "console.log('uncommitted');");
  f.ok(['build', 't1']);
  assert.equal(fs.readFileSync(path.join(f.release('t1'), 'bin/org.mjs'), 'utf8'), "console.log('t1');");
  assert.equal(fs.readFileSync(f.gateLog, 'utf8'), `${f.release('t1')}.partial\n`);
  assert.equal(fs.statSync(path.join(f.release('t1'), 'bin/org.mjs')).mode & 0o222, 0);
  assert.match(fs.readFileSync(path.join(f.release('t1'), '.release-commit'), 'utf8'), /^[a-f0-9]{40}\n$/);
  assert.match(f.run(['build', 't1']).stderr, /already exists/);
  assert.match(f.run(['build', 'main']).stderr, /no tag/);
  assert.match(f.run(['build', '../escape']).stderr, /invalid release/);
});
test('a failed gate retains partial evidence and never makes an activatable release or reruns it', t => {
  const f = scratch(t), r = f.run(['build', 't1'], { FIXTURE_GATE_FAIL: '1' });
  assert.notEqual(r.status, 0); assert.equal(fs.existsSync(f.release('t1')), false);
  assert.equal(fs.existsSync(`${f.release('t1')}.partial`), true);
  assert.notEqual(f.run(['activate', 't1']).status, 0);
  assert.match(f.run(['build', 't1']).stderr, /inspect the unfinished build/);
  assert.equal(fs.readFileSync(f.gateLog, 'utf8').trim().split('\n').length, 1);
});
test('build uses the tagged release declaration instead of the npm fallback or working copy', t => {
  const f = scratch(t);
  f.write('.lane.validation.json', JSON.stringify({ release: 'node gate.cjs && node declared.cjs', timeout_seconds: { release: 10 } }));
  f.write('declared.cjs', `require('fs').appendFileSync(${JSON.stringify(f.gateLog)},'declared\\n');`);
  f.git('add', '.'); f.git('commit', '-qm', 'Declared release gate'); f.git('tag', 'declared');
  f.write('.lane.validation.json', JSON.stringify({ release: 'exit 9' }));
  f.ok(['build', 'declared'], { LANE_VALIDATE: 'exit 9' });
  assert.equal(fs.readFileSync(f.gateLog, 'utf8'), `${f.release('declared')}.partial\ndeclared\n`);
});
test('declared scalar and release-specific timeouts stop the gate once and retain the partial copy', t => {
  const f = scratch(t);
  f.write('slow.cjs', `require('fs').appendFileSync(${JSON.stringify(f.gateLog)},process.cwd()+'\\n');setInterval(()=>{},1000);`);
  for (const [tag, timeout] of [['scalar', 0.5], ['tier', { release: 0.5 }]]) {
    f.write('.lane.validation.json', JSON.stringify({ release: 'node slow.cjs', timeout_seconds: timeout }));
    f.git('add', '.'); f.git('commit', '-qm', tag); f.git('tag', tag);
    const r = f.run(['build', tag]);
    assert.equal(r.status, 124, r.stdout + r.stderr);
    assert.match(r.stderr, /GATE_TIMEOUT: wall limit 0.5s exceeded/);
    assert.equal(fs.existsSync(f.release(tag)), false);
    assert.equal(fs.existsSync(`${f.release(tag)}.partial`), true);
  }
  assert.equal(fs.readFileSync(f.gateLog, 'utf8'), `${f.release('scalar')}.partial\n${f.release('tier')}.partial\n`);
});
test('an invalid release declaration refuses before running a gate', t => {
  const f = scratch(t);
  f.write('.lane.validation.json', JSON.stringify({ release: 'node gate.cjs', timeout_seconds: { release: 0 } }));
  f.git('add', '.'); f.git('commit', '-qm', 'Invalid gate'); f.git('tag', 'invalid');
  assert.match(f.run(['build', 'invalid']).stderr, /positive.*number of seconds/);
  assert.equal(fs.existsSync(f.gateLog), false);
});
test('--live is explicit, follows the offline gate, and a live failure prevents completion', t => {
  const f = scratch(t); f.ok(['build', 't1', '--live']);
  assert.equal(fs.readFileSync(f.gateLog, 'utf8'), `${f.release('t1')}.partial\nlive:${f.release('t1')}.partial\n`);
  assert.notEqual(f.run(['build', 't2', '--live'], { FIXTURE_LIVE_FAIL: '1' }).status, 0);
  assert.equal(fs.existsSync(f.release('t2')), false);
});
test('activation switches three launchers, retires the old plugin once, and rollback preserves previous on repeat', t => {
  const f = scratch(t); f.ok(['build', 't1']); f.ok(['build', 't2']);
  f.ok(['activate', 't1']);
  for (const [name, file] of [['org', 'bin/org.mjs'], ['record', 'bin/org.mjs'], ['lane', 'lanes/lane.mjs']])
    assert.equal(fs.readlinkSync(path.join(f.bin, name)), path.join(f.home, 'current', file));
  f.ok(['activate', 't2']); f.ok(['activate', 't2']);
  assert.equal(fs.readlinkSync(path.join(f.home, 'previous')), f.release('t1'));
  f.ok(['rollback']); assert.equal(fs.readlinkSync(path.join(f.home, 'current')), f.release('t1'));
  assert.equal((fs.readFileSync(f.calls, 'utf8').match(/plugin unlink/g) ?? []).length, 1);
  assert.doesNotMatch(f.ok(['status']).stderr, /warning/);
  assert.equal(fs.existsSync(path.join(f.home, 'before')), false);
  for (const action of ['restore', 'dev']) assert.notEqual(f.run([action]).status, 0);
});
test('a regular launcher or retired Brain plist refuses activation before any links switch', t => {
  const f = scratch(t); f.ok(['build', 't1']);
  fs.writeFileSync(path.join(f.bin, 'lane'), 'mine');
  assert.match(f.run(['activate', 't1']).stderr, /not a link; refusing/);
  fs.unlinkSync(path.join(f.bin, 'lane')); fs.writeFileSync(f.plist, 'legacy plist');
  assert.match(f.run(['activate', 't1']).stderr, /still starts Brain watch.*launchctl bootout/);
  assert.equal(fs.existsSync(path.join(f.home, 'current')), false);
  assert.equal(fs.readFileSync(f.plist, 'utf8'), 'legacy plist');
});
test('failed plugin unlink warns and leaves the launchers usable', t => {
  const f = scratch(t); f.ok(['build', 't1']);
  const r = f.ok(['activate', 't1'], { FIXTURE_UNLINK_FAIL: '1' });
  assert.match(r.stderr, /warning: could not unlink/);
  assert.equal(fs.readlinkSync(path.join(f.home, 'current')), f.release('t1'));
});
test('distribution inventory retains bch-cloak launch dependencies', () => {
  const files = productFiles(path.resolve(import.meta.dirname, '..'));
  for (const file of ['contrib/settle-watch.mjs', 'lib/cli-help.mjs', 'supervisor/reconcile.mjs', 'supervisor/request.mjs']) assert.ok(files.includes(file));
  assert.ok(!files.some(file => file.startsWith('release/')));
});

test('installed release commands can inspect and switch launchers without Git metadata', t => {
  const f = scratch(t); f.ok(['build', 't1']); f.ok(['build', 't2']);
  const script = path.join(f.release('t1'), 'herdr/release.sh');
  const installed = args => {
    const r = spawnSync('bash', [script, ...args], { cwd: f.release('t1'), env: { ...f.env, HERDR_MONITOR_REPO: '' }, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0, r.stdout + r.stderr); return r;
  };
  assert.equal(fs.existsSync(path.join(f.release('t1'), '.git')), false);
  assert.match(installed(['status']).stdout, /current:.*none/);
  installed(['activate', 't1']); installed(['activate', 't2']);
  assert.equal(fs.readlinkSync(path.join(f.home, 'current')), f.release('t2'));
  installed(['rollback']);
  assert.equal(fs.readlinkSync(path.join(f.home, 'current')), f.release('t1'));
  assert.equal(fs.readlinkSync(path.join(f.home, 'previous')), f.release('t2'));
  for (const [name, file] of [['org', 'bin/org.mjs'], ['record', 'bin/org.mjs'], ['lane', 'lanes/lane.mjs']])
    assert.equal(fs.readlinkSync(path.join(f.bin, name)), path.join(f.home, 'current', file));
});
test('build refuses a tag missing the installed settle-watch dependency before spending a gate', t => {
  const f = scratch(t); f.git('rm', 'contrib/settle-watch.mjs'); f.git('commit', '-qm', 'Incomplete distribution'); f.git('tag', 'missing');
  assert.match(f.run(['build', 'missing']).stderr, /release is missing contrib\/settle-watch.mjs/);
  assert.equal(fs.existsSync(f.gateLog), false); assert.equal(fs.existsSync(f.release('missing')), false);
});
