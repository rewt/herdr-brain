import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { candidateCommand, copyDependencyCache, releaseInputs } from '../../herdr/release-candidate.mjs';
import { releaseArgv } from '../config.mjs';

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
  const env = { ...process.env, ORG_ACTOR: 'candidate-fixture', RELEASE_NPM_CACHE: cache, RELEASE_BCH_CLOAK: bch,
    RELEASE_NO_NPM: '1', npm_config_userconfig: '/dev/null' };
  const invoke = (argv, extra = {}) => spawnSync(argv[0], argv.slice(1), { cwd: candidate, env: { ...env, ...extra }, encoding: 'utf8', timeout: 12000 });
  return { root, candidate, cache, bch, env, invoke };
}

test('the tracked preparation installs offline and its gate supplies both required acceptance inputs', t => {
  const f = fixture(t);
  const values = { candidate: f.candidate, repo: f.root, commit: 'a'.repeat(40), tag: 'rc-test' };
  // Exercise the exact declaration with actual npm ci on dependency-free fixtures.
  const prepare = f.invoke(releaseArgv(declaration.prepare, values));
  assert.equal(prepare.status, 0, prepare.stderr + prepare.stdout);
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
  assert.throws(() => releaseInputs({ ...f.env, RELEASE_BCH_CLOAK: '' }), /RELEASE_BCH_CLOAK/);
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
  fs.rmSync(cache, { recursive: true }); fs.unlinkSync(path.join(f.cache, relative));
  assert.throws(() => copyDependencyCache(f.candidate, f.cache), /offline cache lacks console dependency/);
});
