import { loadTimeout } from '../../lib/deadline.mjs';
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { loadEvents } from '../../lib/store.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { candidateCommand, releaseInputs } from '../../herdr/release-candidate.mjs';
import { releaseArgv } from '../config.mjs';
import { releaseOnce } from '../release.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const declaration = JSON.parse(fs.readFileSync(path.join(ROOT, '.release.json'), 'utf8'));
process.env.ORG_ACTOR = 'release-candidate-tests';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-input-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate'), bch = path.join(root, 'existing project');
  fs.mkdirSync(path.join(candidate, 'herdr'), { recursive: true });
  fs.mkdirSync(path.join(candidate, 'acceptance'));
  fs.mkdirSync(bch);
  fs.writeFileSync(path.join(candidate, '.release-commit'), 'a'.repeat(40) + '\n');
  fs.copyFileSync(path.join(ROOT, 'herdr/release-candidate.mjs'), path.join(candidate, 'herdr/release-candidate.mjs'));
  fs.copyFileSync(path.join(ROOT, 'herdr/install.sh'), path.join(candidate, 'herdr/install.sh'));
  fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({ private: true, scripts: { 'test:release': "node -e \"require('fs').appendFileSync('offline-checks', 'checked\\n');process.exit(Number(process.env.OFFLINE_CHECK_EXIT || 0))\"" } }));
  const env = { ...process.env, ORG_ACTOR: 'candidate-fixture', RELEASE_BCH_CLOAK: bch, npm_config_userconfig: '/dev/null' };
  delete env.RELEASE_NPM_CACHE;
  const invoke = (argv, extra = {}) => spawnSync(argv[0], argv.slice(1), { cwd: candidate, env: { ...env, ...extra }, encoding: 'utf8', timeout: loadTimeout(12000) });
  return { root, candidate, bch, env, invoke };
}

test('the tracked preflight checks inputs and preparation supplies configured acceptance inputs', t => {
  const f = fixture(t);
  const values = { candidate: f.candidate, repo: f.candidate, commit: 'a'.repeat(40), tag: 'rc-test' };
  const preflight = f.invoke(releaseArgv(declaration.preflight, values));
  assert.equal(preflight.status, 0, preflight.stderr + preflight.stdout);
  assert.doesNotMatch(preflight.stdout, /cache/, 'the product has no npm dependencies to cache');
  // Exercise the exact declaration: the build step, then the offline checks.
  const prepare = f.invoke(releaseArgv(declaration.prepare, values));
  assert.equal(prepare.status, 0, prepare.stderr + prepare.stdout);
  assert.equal(fs.readFileSync(path.join(f.candidate, 'offline-checks'), 'utf8'), 'checked\n');
  assert.equal(fs.existsSync(path.join(f.candidate, '.release-npm-cache')), false);
  const build = JSON.parse(fs.readFileSync(path.join(f.candidate, '.release-build.json'), 'utf8'));
  assert.equal(build.commit, values.commit); assert.deepEqual(build.command, ['bash', path.join(f.candidate, 'herdr/install.sh')]);
  assert.equal(fs.existsSync(path.join(f.candidate, 'herdr/entry-install.mjs')), false, 'build-only preparation does not attempt entry installation');
  fs.writeFileSync(path.join(f.candidate, 'acceptance/run.mjs'), `import assert from 'node:assert/strict';import fs from 'node:fs';
const args=process.argv.slice(2);const value=key=>args[args.indexOf(key)+1];
assert.equal(value('--candidate'),${JSON.stringify(f.candidate)});
assert.ok(!args.includes('--npm-cache'));
assert.ok(!args.includes('--bch-cloak'));
assert.ok(args.includes('--skip-live'));assert.ok(fs.existsSync('.release-build.json'));console.log('declared gate checked');process.exit(7);`);
  const gate = f.invoke([...releaseArgv(declaration.gate, values), '--skip-live']);
  assert.equal(gate.status, 7, gate.stdout + gate.stderr); assert.match(gate.stdout, /declared gate checked/);
  const live = candidateCommand('gate', f.candidate, { env: f.env }).command;
  assert.ok(!live.includes('--skip-live'), 'production argv retains the live gate');
});

test('missing input setup and missing build evidence fail before invoking acceptance', t => {
  const f = fixture(t);
  assert.deepEqual(releaseInputs({ ...f.env, RELEASE_BCH_CLOAK: '' }), {});
  assert.deepEqual(releaseInputs({ ...f.env, RELEASE_BCH_CLOAK: path.join(f.root, 'absent') }), {});
  assert.deepEqual(releaseInputs({ ...f.env, RELEASE_NPM_CACHE: path.join(f.root, 'absent') }), {}, 'an npm cache is no longer an input');
  assert.throws(() => candidateCommand('gate', f.candidate, { env: f.env }), /release-build.json/);
  fs.writeFileSync(path.join(f.candidate, '.release-build.json'), JSON.stringify({ commit: 'b'.repeat(40) }));
  assert.throws(() => candidateCommand('gate', f.candidate, { env: f.env }), /does not name this candidate/);
});

test('unset compatibility input is optional through the declared build and gate', t => {
  const f = fixture(t);
  delete f.env.RELEASE_BCH_CLOAK;
  const values = { candidate: f.candidate, repo: f.candidate };
  const preflight = f.invoke(releaseArgv(declaration.preflight, values));
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.match(preflight.stdout, /release preflight/);
  const prepare = f.invoke(releaseArgv(declaration.prepare, values));
  assert.equal(prepare.status, 0, prepare.stderr);
  fs.writeFileSync(path.join(f.candidate, 'acceptance/run.mjs'), "import assert from 'node:assert/strict';assert.ok(!process.argv.includes('--bch-cloak'));assert.ok(!process.argv.includes('--npm-cache'));console.log('optional compatibility gate');");
  const gate = f.invoke(releaseArgv(declaration.gate, values));
  assert.equal(gate.status, 0, gate.stderr);
  assert.match(gate.stdout, /optional compatibility gate/);
});


test('release safety checks stop the gate on failure and precede acceptance on success', t => {
  const f = fixture(t);
  const marker = path.join(f.root, 'acceptance-ran');
  fs.writeFileSync(path.join(f.candidate, 'acceptance/run.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');`);
  const command = releaseArgv(declaration.prepare, { candidate: f.candidate });
  const refused = f.invoke(command, { OFFLINE_CHECK_EXIT: '9' });
  assert.equal(refused.status, 9, refused.stdout + refused.stderr);
  assert.equal(fs.existsSync(marker), false, 'red offline safety evidence prevents the live gate');
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
