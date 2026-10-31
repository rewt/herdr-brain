import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyProduct, productFiles } from '../lib/product-files.mjs';
import { releaseEnvironment } from './helpers/release-environment.mjs';

test('copied runtime closes static imports for every shipped module', t => {
  const source = path.resolve(import.meta.dirname, '..');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-imports-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle'), files = productFiles(source);
  copyProduct(source, bundle);
  assert.equal(fs.existsSync(path.join(bundle, 'test')), false);
  const modules = files.filter(file => file.endsWith('.mjs'));
  const entries = ['bin/org.mjs', 'watch/watch.mjs', 'line-service/line-service.mjs',
    'supervisor/supervisor.mjs', 'settle/settle.mjs'];
  for (const entry of [...entries, 'lanes/lane.mjs']) assert.ok(modules.includes(entry), entry);
  // Use Node's parser, not a text regex: comments, fixture strings and multiline
  // imports must not change the graph. Never link/evaluate command bodies.
  // Computed imports of consumer-checkout code are not static bundle edges.
  const scan = () => spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL, fileURLToPath } from 'node:url';
    import { SourceTextModule } from 'node:vm';
    const { bundle, files } = JSON.parse(fs.readFileSync(0, 'utf8'));
    const inventory = new Set(files), missing = [];
    let checked = 0;
    for (const file of files.filter(file => file.endsWith('.mjs'))) {
      const url = pathToFileURL(path.join(bundle, file));
      const module = new SourceTextModule(fs.readFileSync(url, 'utf8'), { identifier: url.href });
      checked++;
      for (const specifier of module.dependencySpecifiers) {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
        const target = path.relative(bundle, fileURLToPath(new URL(specifier, url)));
        if (!inventory.has(target) || !fs.statSync(path.join(bundle, target), { throwIfNoEntry: false })?.isFile())
          missing.push({ file, specifier, target });
      }
    }
    console.log(JSON.stringify({ checked, missing }));
    process.exitCode = missing.length ? 1 : 0;
  `], { cwd: root, env: releaseEnvironment(process.env), input: JSON.stringify({ bundle, files }), encoding: 'utf8' });
  const verify = (result, status, missing) => {
    assert.equal(result.status, status, result.error?.message ?? result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { checked: modules.length, missing });
  };
  verify(scan(), 0, []);
  // Inject the original shipped-to-test defect outside the lane CLI graph.
  // Cover named, side-effect and multiline imports, plus both re-export forms.
  const declarations = ["import { absent } from '../test/not-shipped.mjs';",
    "import '../test/not-shipped.mjs';", "export * from '../test/not-shipped.mjs';",
    "export { absent } from '../test/not-shipped.mjs';",
    "import {\n absent\n} from\n '../test/not-shipped.mjs';"];
  for (const [index, file] of entries.entries()) {
    const target = path.join(bundle, file), original = fs.readFileSync(target, 'utf8');
    try {
      fs.appendFileSync(target, `\n${declarations[index]}\n`);
      verify(scan(), 1, [{ file, specifier: '../test/not-shipped.mjs', target: 'test/not-shipped.mjs' }]);
    } finally { fs.writeFileSync(target, original); }
  }
  verify(scan(), 0, []);
  t.diagnostic(`Checked ${modules.length} shipped modules; five excluded-import failures and restored-runtime recovery verified.`);
});

test('copied runtime loads lane CLI without source-only test helpers', t => {
  const source = path.resolve(import.meta.dirname, '..');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-lane-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle');
  copyProduct(source, bundle);
  assert.equal(fs.existsSync(path.join(bundle, 'test')), false);
  const result = spawnSync(process.execPath, [path.join(bundle, 'lanes/lane.mjs'), '--help'], {
    cwd: root, env: releaseEnvironment(process.env), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  assert.match(result.stdout, /Usage: lane/);
});

test('release build retains shared skill discovery and seals an archive without harness trees', t => {
  const source = path.resolve(import.meta.dirname, '..');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-skills-')));
  t.after(() => {
    execFileSync('chmod', ['-R', 'u+w', root]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repo = path.join(root, 'repo'), home = path.join(root, 'releases-home');
  const work = path.join(home, 'builds', 'skills'), checkout = path.join(work, 'checkout');
  const archive = path.join(home, 'releases', 'skills'), gateLog = path.join(root, 'gates');
  copyProduct(source, repo);
  // Keep the release orchestration real; only its nested release suite is a fixture.
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:release': 'node gate.cjs' } }));
  fs.writeFileSync(path.join(repo, 'gate.cjs'), `require('fs').appendFileSync(${JSON.stringify(gateLog)},process.cwd()+'\\n');`);
  fs.writeFileSync(path.join(repo, 'contrib/settle-watch.mjs'), '// compatibility');
  fs.cpSync(path.join(source, 'skills'), path.join(repo, 'skills'), { recursive: true });
  fs.copyFileSync(path.join(source, '.gitattributes'), path.join(repo, '.gitattributes'));
  const names = ['project-deliver', 'project-preflight', 'project-release', 'project-review', 'project-troubleshoot'];
  for (const harness of ['.agents', '.claude']) {
    fs.mkdirSync(path.join(repo, harness, 'skills'), { recursive: true });
    for (const name of names) {
      const link = path.join(harness, 'skills', name);
      assert.equal(fs.realpathSync(path.join(source, link)), path.join(source, 'skills', name));
      fs.symlinkSync(fs.readlinkSync(path.join(source, link)), path.join(repo, link));
    }
  }
  fs.writeFileSync(path.join(repo, '.claude/settings.json'), '{"sourceOnly":true}\n');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-qb', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.');
  // A machine's global ignore file may hide harness configuration in a new repo.
  git('add', '--force', '.agents', '.claude', 'skills', '.gitattributes');
  git('commit', '-qm', 'Shared harness skills');
  git('tag', 'skills');
  const commit = git('rev-parse', 'HEAD');
  assert.equal(git('ls-tree', '-r', commit, '.agents', '.claude').split('\n').filter(row => row.startsWith('120000 ')).length, 10);
  const env = releaseEnvironment(process.env, { HOME: root, HERDR_MONITOR_REPO: repo,
    HERDR_MONITOR_HOME: home, HERDR_MONITOR_BIN: path.join(root, 'bin'),
    HERDR_MONITOR_PLIST: '', HERDR_MONITOR_FLEET: path.join(root, 'fleet') });
  // The nested fixture owns its observations, as in release.test.mjs's scratch fixture.
  for (const key of ['MONITOR_TEST_TIMINGS_PATH', 'MONITOR_TEST_WATCH_OWNER', 'MONITOR_TEST_TIMING_DEPTH']) delete env[key];
  const build = spawnSync('bash', [path.join(source, 'herdr/release.sh'), 'build', 'skills'], { env, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  assert.equal(fs.readFileSync(gateLog, 'utf8'), `${checkout}\n`);
  assert.equal(fs.readFileSync(path.join(archive, '.release-commit'), 'utf8'), `${commit}\n`);
  assert.equal(fs.existsSync(`${archive}.partial`), false);
  const identity = JSON.parse(fs.readFileSync(path.join(work, 'identity.json'), 'utf8')).identity;
  assert.equal(identity.commit, commit);
  assert.ok(!Object.keys(identity.files).some(file => /^(?:\.agents|\.claude)\//.test(file)));
  assert.equal(fs.statSync(path.join(archive, '.release-manifest.json')).mode & 0o222, 0);
  const proof = JSON.parse(fs.readFileSync(path.join(archive, '.release-validation.json'), 'utf8')).validation;
  assert.equal(proof.cwd, checkout);
  assert.equal(proof.commit, commit);
  for (const harness of ['.agents', '.claude']) {
    assert.equal(fs.existsSync(path.join(archive, harness)), false);
    for (const name of names) {
      const canonical = path.join(checkout, 'skills', name, 'SKILL.md');
      assert.equal(fs.realpathSync(path.join(checkout, harness, 'skills', name, 'SKILL.md')), canonical);
      assert.equal(fs.readFileSync(path.join(archive, 'skills', name, 'SKILL.md'), 'utf8'), fs.readFileSync(canonical, 'utf8'));
    }
  }
});
