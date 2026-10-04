import { loadTimeout } from '../../lib/deadline.mjs';
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { loadEvents } from '../../lib/store.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { candidateCommand, copyDependencyCache, releaseInputs, preflightInputs } from '../../herdr/release-candidate.mjs';
import { releaseArgv } from '../config.mjs';
import { releaseOnce } from '../release.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const declaration = JSON.parse(fs.readFileSync(path.join(ROOT, '.release.json'), 'utf8'));
process.env.ORG_ACTOR = 'release-candidate-tests';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-input-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate'), cache = path.join(root, 'cache'), bch = path.join(root, 'existing project');
  fs.mkdirSync(path.join(candidate, 'herdr'), { recursive: true });
  fs.mkdirSync(path.join(candidate, 'acceptance'));
  fs.mkdirSync(path.join(cache, '_cacache/index-v5'), { recursive: true });
  fs.mkdirSync(bch);
  fs.writeFileSync(path.join(candidate, '.release-commit'), 'a'.repeat(40) + '\n');
  fs.copyFileSync(path.join(ROOT, 'herdr/release-candidate.mjs'), path.join(candidate, 'herdr/release-candidate.mjs'));
  fs.copyFileSync(path.join(ROOT, 'herdr/install.sh'), path.join(candidate, 'herdr/install.sh'));
  for (const module of ['console', 'mcp']) {
    fs.mkdirSync(path.join(candidate, module));
    fs.writeFileSync(path.join(candidate, module, 'package.json'), JSON.stringify({ name: module, version: '1.0.0' }));
    fs.writeFileSync(path.join(candidate, module, 'package-lock.json'), JSON.stringify({ name: module, version: '1.0.0', lockfileVersion: 3, packages: { '': { name: module, version: '1.0.0' } } }));
  }
  fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({ private: true, scripts: { 'test:release': "node -e \"require('fs').appendFileSync('offline-checks', 'checked\\n');process.exit(Number(process.env.OFFLINE_CHECK_EXIT || 0))\"" } }));
  const env = { ...process.env, ORG_ACTOR: 'candidate-fixture', RELEASE_NPM_CACHE: cache, RELEASE_BCH_CLOAK: bch,
    RELEASE_NO_NPM: '1', npm_config_userconfig: '/dev/null' };
  const invoke = (argv, extra = {}) => spawnSync(argv[0], argv.slice(1), { cwd: candidate, env: { ...env, ...extra }, encoding: 'utf8', timeout: loadTimeout(12000) });
  return { root, candidate, cache, bch, env, invoke };
}

test('the tracked preflight checks inputs and preparation supplies configured acceptance inputs', t => {
  const f = fixture(t);
  const values = { candidate: f.candidate, repo: f.candidate, commit: 'a'.repeat(40), tag: 'rc-test' };
  const preflight = f.invoke(releaseArgv(declaration.preflight, values));
  assert.equal(preflight.status, 0, preflight.stderr + preflight.stdout);
  assert.equal(fs.existsSync(path.join(f.candidate, '.release-npm-cache')), false, 'preflight never stages a cache');
  // Exercise the exact declaration with actual npm ci on dependency-free fixtures.
  const prepare = f.invoke(releaseArgv(declaration.prepare, values));
  assert.equal(prepare.status, 0, prepare.stderr + prepare.stdout);
  assert.equal(fs.readFileSync(path.join(f.candidate, 'offline-checks'), 'utf8'), 'checked\n');
  assert.match(prepare.stdout, /console dependencies installed/); assert.match(prepare.stdout, /mcp dependencies installed/);
  const build = JSON.parse(fs.readFileSync(path.join(f.candidate, '.release-build.json'), 'utf8'));
  assert.equal(build.commit, values.commit); assert.equal(build.offline, true);
  assert.deepEqual(build.modules.map(row => row.module), ['console', 'mcp']);
  assert.equal(build.cache, path.join(f.candidate, '.release-npm-cache'));
  assert.deepEqual(fs.readdirSync(f.cache), ['_cacache'], 'npm never writes the shared input cache');
  assert.equal(fs.existsSync(path.join(f.candidate, 'herdr/entry-install.mjs')), false, 'build-only preparation does not attempt entry installation');
  fs.writeFileSync(path.join(f.candidate, 'acceptance/run.mjs'), `import assert from 'node:assert/strict';import fs from 'node:fs';
const args=process.argv.slice(2);const value=key=>args[args.indexOf(key)+1];
assert.equal(value('--candidate'),${JSON.stringify(f.candidate)});
assert.equal(value('--npm-cache'),${JSON.stringify(build.cache)});
assert.equal(value('--bch-cloak'),${JSON.stringify(f.bch)});
assert.ok(args.includes('--skip-live'));assert.ok(fs.existsSync('.release-build.json'));console.log('declared gate checked');process.exit(7);`);
  const gate = f.invoke([...releaseArgv(declaration.gate, values), '--skip-live']);
  assert.equal(gate.status, 7, gate.stdout + gate.stderr); assert.match(gate.stdout, /declared gate checked/);
  const live = candidateCommand('gate', f.candidate, { env: f.env }).command;
  assert.ok(!live.includes('--skip-live'), 'production argv retains the live gate');
});

test('missing input setup and missing build evidence fail before invoking acceptance', t => {
  const f = fixture(t);
  assert.equal(releaseInputs({ ...f.env, RELEASE_BCH_CLOAK: '' }).bch, null);
  assert.throws(() => releaseInputs({ ...f.env, RELEASE_BCH_CLOAK: path.join(f.root, 'absent') }), /RELEASE_BCH_CLOAK/);
  assert.throws(() => releaseInputs({ ...f.env, RELEASE_NPM_CACHE: f.bch }), /RELEASE_NPM_CACHE/);
  assert.throws(() => candidateCommand('gate', f.candidate, { env: f.env }), /release-build.json/);
  fs.writeFileSync(path.join(f.candidate, '.release-build.json'), JSON.stringify({ commit: 'b'.repeat(40) }));
  assert.throws(() => candidateCommand('gate', f.candidate, { env: f.env }), /does not name this candidate/);
});

test('private cache copies only pinned dependency tarballs and refuses missing content', t => {
  const f = fixture(t);
  const bytes = Buffer.from('pinned tarball');
  const digest = crypto.createHash('sha512').update(bytes).digest();
  const hex = digest.toString('hex');
  const relative = path.join('_cacache/content-v2/sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  fs.mkdirSync(path.dirname(path.join(f.cache, relative)), { recursive: true });
  fs.writeFileSync(path.join(f.cache, relative), bytes);
  fs.writeFileSync(path.join(f.cache, '_cacache/unrelated'), 'do not copy');
  fs.writeFileSync(path.join(f.candidate, 'console/package-lock.json'), JSON.stringify({ packages: {
    'node_modules/pinned': { integrity: 'sha512-' + digest.toString('base64'), resolved: 'https://example.invalid/pinned.tgz' },
  } }));
  const cache = copyDependencyCache(f.candidate, f.cache);
  assert.deepEqual(fs.readFileSync(path.join(cache, relative)), bytes);
  assert.equal(fs.existsSync(path.join(cache, '_cacache/unrelated')), false);
  assert.equal(preflightInputs(f.candidate, f.env).dependencies, 1);
  fs.rmSync(cache, { recursive: true }); fs.unlinkSync(path.join(f.cache, relative));
  assert.throws(() => preflightInputs(f.candidate, f.env), /offline cache lacks console dependency/);
  assert.equal(fs.existsSync(cache), false, 'missing tarballs are diagnosed without staging a private cache');
  assert.throws(() => copyDependencyCache(f.candidate, f.cache), /offline cache lacks console dependency/);
});

test('unset compatibility input is optional through the declared build and gate', t => {
  const f = fixture(t);
  delete f.env.RELEASE_BCH_CLOAK;
  const values = { candidate: f.candidate, repo: f.candidate };
  const preflight = f.invoke(releaseArgv(declaration.preflight, values));
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.match(preflight.stdout, /compatibility will be skipped/);
  const prepare = f.invoke(releaseArgv(declaration.prepare, values));
  assert.equal(prepare.status, 0, prepare.stderr);
  fs.writeFileSync(path.join(f.candidate, 'acceptance/run.mjs'), "import assert from 'node:assert/strict';assert.ok(!process.argv.includes('--bch-cloak'));assert.ok(process.argv.includes('--npm-cache'));console.log('optional compatibility gate');");
  const gate = f.invoke(releaseArgv(declaration.gate, values));
  assert.equal(gate.status, 0, gate.stderr);
  assert.match(gate.stdout, /optional compatibility gate/);
});

test('real project preflight leaves invalid inputs uncut and retries the same commit', t => {
  const f = fixture(t);
  f.env.ORG_DIR = '';
  f.env.GIT_CONFIG_GLOBAL = '/dev/null'; f.env.GIT_CONFIG_NOSYSTEM = '1';
  const git = args => { const r = f.invoke(['git', ...args]); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  fs.unlinkSync(path.join(f.candidate, '.release-commit'));
  fs.writeFileSync(path.join(f.candidate, '.release.json'), JSON.stringify(declaration));
  fs.writeFileSync(path.join(f.candidate, 'acceptance/run.mjs'), "import assert from 'node:assert/strict';assert.ok(!process.argv.includes('--bch-cloak'));console.log('offline fixture acceptance');");
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Release inputs test']); git(['config', 'user.email', 'inputs@example.invalid']);
  git(['add', '.']); git(['commit', '-qm', 'Declare project input preflight']);
  const commit = git(['rev-parse', 'HEAD']);
  const attempt = () => releaseOnce({ cwd: f.candidate, env: f.env, role: 'supervisor', tag: 'rc-inputs', measurement: { load: 0, cpus: 1 } });
  for (const [variable, message] of [['RELEASE_NPM_CACHE', /RELEASE_NPM_CACHE/], ['RELEASE_BCH_CLOAK', /RELEASE_BCH_CLOAK/]]) {
    const saved = f.env[variable]; f.env[variable] = path.join(f.root, 'absent');
    const result = attempt();
    assert.equal(result.result, 'setup-required'); assert.match(result.reason, message);
    assert.equal(result.candidate, null); assert.equal(result.commit, commit);
    assert.match(fs.readFileSync(result.log, 'utf8'), message);
    assert.equal(git(['tag']), '');
    f.env[variable] = saved;
  }
  const events = () => loadEvents(path.join(f.candidate, '.org')).events;
  assert.equal(events().filter(e => e.type === 'release.cut').length, 0);
  assert.equal(events().filter(e => e.type.startsWith('release.gate.')).length, 0);
  delete f.env.RELEASE_BCH_CLOAK;
  const result = attempt();
  assert.equal(result.result, 'awaiting-operator', result.candidate.gate?.detail);
  assert.equal(result.candidate.commit, commit); assert.equal(git(['rev-parse', 'rc-inputs']), commit);
  assert.equal(events().filter(e => e.type === 'release.cut').length, 1);
  f.env.RELEASE_NPM_CACHE = path.join(f.root, 'absent');
  assert.equal(attempt().candidate.id, result.candidate.id, 'an already gated candidate is reused before machine checks');
  assert.equal(events().filter(e => e.type === 'release.gate.started').length, 1);
  assert.equal(events().filter(e => e.type === 'release.gate.finished').length, 1);
});

test('release safety checks stop the gate on failure and precede acceptance on success', t => {
  const f = fixture(t);
  const marker = path.join(f.root, 'acceptance-ran');
  fs.writeFileSync(path.join(f.candidate, 'acceptance/run.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');`);
  const command = releaseArgv(declaration.prepare, { candidate: f.candidate });
  const refused = f.invoke(command, { OFFLINE_CHECK_EXIT: '9' });
  assert.equal(refused.status, 9, refused.stdout + refused.stderr);
  assert.equal(fs.existsSync(marker), false, 'red offline safety evidence prevents the live gate');
  fs.rmSync(path.join(f.candidate, '.release-npm-cache'), { recursive: true });
  const green = f.invoke(command);
  assert.equal(green.status, 0, green.stdout + green.stderr);
  const gate = f.invoke(releaseArgv(declaration.gate, { candidate: f.candidate }));
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
  assert.equal(fs.readFileSync(path.join(f.candidate, 'offline-checks'), 'utf8'), 'checked\nchecked\n');
});

// Release preparation must keep the offline suite between build and live gate.
test('failed offline release coverage prevents build evidence and acceptance', t => {
  const f = fixture(t);
  const values = { candidate: f.candidate, repo: f.candidate };
  fs.writeFileSync(path.join(f.candidate, 'acceptance/run.mjs'), "import fs from 'node:fs';fs.writeFileSync('acceptance-ran','unsafe');");
  const prepare = f.invoke(releaseArgv(declaration.prepare, values), { OFFLINE_CHECK_EXIT: '9' });
  assert.equal(prepare.status, 9, prepare.stderr + prepare.stdout);
  assert.equal(fs.readFileSync(path.join(f.candidate, 'offline-checks'), 'utf8'), 'checked\n');
  assert.equal(fs.existsSync(path.join(f.candidate, '.release-build.json')), false);
  const gate = f.invoke(releaseArgv(declaration.gate, values));
  assert.equal(gate.status, 1, gate.stderr + gate.stdout);
  assert.equal(fs.existsSync(path.join(f.candidate, 'acceptance-ran')), false);
});
