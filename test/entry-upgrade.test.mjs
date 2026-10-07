import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyProduct } from '../lib/product-files.mjs';
import { resolveNative } from '../discovery/native-binary.mjs';

const source = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'entry-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), product = path.join(root, 'product'), tools = path.join(root, 'tools'), bin = path.join(home, 'monitor/entry/bin');
  for (const dir of [home, tools]) fs.mkdirSync(dir);
  copyProduct(source, product);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(ORG_|LANE_|HERDR_|MONITOR_|RELEASE_|CODEX_|CLAUDE_|BRAIN_|GIT_|ZDOTDIR$)/u.test(name)));
  Object.assign(env, { HOME: home, ZDOTDIR: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    HERDR_MONITOR_HOME: path.join(home, 'monitor'), HERDR_MONITOR_ENTRY_BIN: bin, HERDR_MONITOR_FLEET: path.join(root, 'fleet'),
    HERDR_SOCKET_PATH: path.join(root, 'absent.sock'), ORG_ACTOR: 'entry-upgrade-test', ORG_DIR: path.join(root, 'record'),
    BRAIN_STATE: path.join(root, 'brain'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: `${tools}:/usr/bin:/bin` });
  const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { mode: 0o755 }); };
  function version(version) {
    const directory = path.join(root, 'releases', version);
    for (const kind of ['codex', 'claude']) write(path.join(directory, kind), `#!/bin/sh\nprintf '%s\\n' '${kind} ${version}'\nprintf '<%s>\\n' "$@"\n`);
    return directory;
  }
  const run = (file, args, extra = {}) => spawnSync(file, args, { cwd: home, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  const ok = result => { assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr); return result; };
  return { root, home, product, tools, bin, env, write, version, run, ok };
}

for (const selection of ['versioned executable', 'stable symlink']) test(`installed entry survives removal of an old ${selection} target without reinstall`, t => {
  const f = fixture(t), first = f.version('0.160.0'), second = f.version('0.160.1');
  for (const kind of ['codex', 'claude']) fs.symlinkSync(path.join(first, kind), path.join(f.tools, kind));
  const selected = selection === 'stable symlink' ? f.tools : first;
  f.ok(f.run(process.execPath, [path.join(f.product, 'herdr/entry-install.mjs'), '--product', f.product, '--snapshot'], {
    HERDR_MONITOR_CODEX: path.join(selected, 'codex'), HERDR_MONITOR_CLAUDE: path.join(selected, 'claude'),
  }));
  const receipt = JSON.parse(fs.readFileSync(path.join(f.bin, '.monitor-entry.json')));
  assert.equal(receipt.native, path.join(selected, 'codex'));
  assert.equal(receipt.claudeNative, path.join(selected, 'claude'));
  const before = new Map(Object.keys(receipt.files).map(name => [name, fs.readFileSync(path.join(f.bin, name))]));
  const alias = path.join(f.root, 'entry-alias'); fs.symlinkSync(f.bin, alias);
  const extra = { PATH: `${alias}:${f.bin}:${f.tools}:/usr/bin:/bin` };
  for (const kind of ['codex', 'claude']) assert.match(f.ok(f.run(path.join(f.bin, kind), ['--version'], extra)).stdout, /0\.160\.0/u);
  for (const kind of ['codex', 'claude']) {
    fs.unlinkSync(path.join(f.tools, kind)); fs.symlinkSync(path.join(second, kind), path.join(f.tools, kind));
  }
  fs.rmSync(first, { recursive: true });
  for (const kind of ['codex', 'claude']) {
    assert.match(f.ok(f.run(path.join(f.bin, kind), ['--version'], extra)).stdout, /0\.160\.1/u);
    const result = f.ok(f.run(path.join(f.bin, `monitor-${kind}`), ['--', '--version', 'a b', '$(touch unwanted)'], extra));
    assert.match(result.stdout, /0\.160\.1/u); assert.match(result.stdout, /<a b>/u); assert.match(result.stdout, /<\$\(touch unwanted\)>/u);
    assert.match(f.ok(f.run(path.join(f.bin, `monitor-${kind}`), ['--help'], extra)).stdout, /Usage:.*OPTIONS/u);
  }
  assert.equal(resolveNative('codex', { entryBin: f.bin, fallback: receipt.native, env: { PATH: extra.PATH } }), path.join(f.tools, 'codex'));
  f.ok(f.run(process.execPath, [path.join(f.product, 'herdr/entry-install.mjs'), '--product', f.product, '--check'], extra));
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(f.bin, name)), bytes, 'upgrade needs no wrapper rewrite');
  // The default Claude validator also resolves Codex at launch, even outside a project.
  fs.unlinkSync(path.join(f.tools, 'codex')); fs.rmSync(second + '/codex');
  const missing = f.run(path.join(f.bin, 'monitor-claude'), ['--', '--version'], extra);
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /native codex is unavailable/u);
  f.ok(f.run(path.join(f.bin, 'monitor-claude'), ['--validator', 'auto', '--', '--version'], extra));
  for (const kind of ['codex', 'claude']) f.ok(f.run(path.join(f.bin, `monitor-${kind}`), ['--help'], extra));
});

test('native lookup skips other managed installs and wrapper aliases, retains off-PATH launchers and refuses missing executables', t => {
  const f = fixture(t), native = f.version('current'), foreign = path.join(f.root, 'foreign');
  fs.mkdirSync(f.bin, { recursive: true }); fs.mkdirSync(foreign);
  f.write(path.join(foreign, 'codex'), '#!/bin/sh\nexit 99\n');
  fs.writeFileSync(path.join(foreign, '.monitor-entry.json'), '{}');
  fs.symlinkSync(path.join(foreign, 'codex'), path.join(f.tools, 'codex'));
  assert.equal(resolveNative('codex', { entryBin: f.bin, fallback: path.join(native, 'codex'), env: { PATH: `${f.bin}:${foreign}:${f.tools}` } }), path.join(native, 'codex'));
  assert.throws(() => resolveNative('codex', { entryBin: f.bin, fallback: path.join(foreign, 'codex'), env: { PATH: f.tools } }), /unavailable/u);
});
