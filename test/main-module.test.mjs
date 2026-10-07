import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));

const argvPath = String.raw`process\s*\.\s*argv\s*\[\s*1\s*\]`;
const modulePath = String.raw`fileURLToPath\s*\(\s*import\s*\.\s*meta\s*\.\s*url\s*\)`;
const call = (name, argument) => `${name}\\s*\\(\\s*${argument}\\s*\\)`;
const realpath = argument => call(String.raw`fs\s*\.\s*realpathSync`, argument);
const comparison = (left, right) => new RegExp(`(?:${left}\\s*(?:===|!==)\\s*${right}|${right}\\s*(?:===|!==)\\s*${left})`, 'u');

function mainComparisons(text) {
  // Match the module expression or its named path constant, in either order.
  const aliases = [...text.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*${modulePath}`, 'gu'))]
    .map(match => match[1]);
  const module = `(?:${modulePath}|\\b(?:${['SELF', 'FILE', ...aliases].join('|')})\\b)`;
  const moduleOperand = `(?:${realpath(module)}|${module})`;
  return {
    unsafe: comparison(call(String.raw`path\s*\.\s*resolve`, argvPath), moduleOperand).test(text),
    duplicate: comparison(`(?:${realpath(argvPath)}|${argvPath})`, moduleOperand).test(text),
  };
}

test('main comparison guard catches both operand orders and inequality early returns', () => {
  const launch = 'process.argv[1]', module = 'fileURLToPath(import.meta.url)';
  for (const operator of ['===', '!==']) for (const reverse of [false, true]) {
    for (const moduleOperand of [module, 'SELF', 'FILE', 'moduleFile']) {
      const compare = operand => `const moduleFile = ${module}; if (${reverse
        ? `${moduleOperand} ${operator} ${operand}` : `${operand} ${operator} ${moduleOperand}`}) return;`;
      assert.equal(mainComparisons(compare(`path.resolve(${launch})`)).unsafe, true);
      assert.equal(mainComparisons(compare(launch)).duplicate, true);
      assert.equal(mainComparisons(compare(`fs.realpathSync(${launch})`)).duplicate, true);
    }
    const operands = [`fs.realpathSync(${launch})`, `fs.realpathSync(${module})`];
    if (reverse) operands.reverse();
    assert.equal(mainComparisons(operands.join(` ${operator} `)).duplicate, true);
  }
  const spaced = `if ( path . resolve ( ${launch.replaceAll('.', ' . ')} ) !==\n fileURLToPath ( import . meta . url ) ) return;`;
  assert.equal(mainComparisons(spaced).unsafe, true);
  for (const text of [`const input = path.resolve(${launch});`,
    `path.resolve(${launch}) === expectedInput`, `process.argv[2] !== ${module}`,
    'if (isMain(import.meta.url)) main();']) assert.deepEqual(mainComparisons(text), { unsafe: false, duplicate: false });
});

test('product scripts never compare a resolved argv launch path to a module path', () => {
  const files = spawnSync('git', ['ls-files', '-z'], { cwd: source, encoding: 'utf8' });
  assert.equal(files.status, 0, files.stderr);
  const product = files.stdout.split('\0').filter(file => /\.(?:mjs|cjs|js)$/u.test(file)
    && !file.startsWith('acceptance/test/fixtures/') && !file.startsWith('kit/'));
  const offenders = product.filter(file => mainComparisons(fs.readFileSync(path.join(source, file), 'utf8')).unsafe);
  assert.deepEqual(offenders, [], 'use isMain from lib/cli-help.mjs');
  // ARCH-19: the candidate driver must also work in build-only partial copies.
  const standalone = 'herdr/release-candidate.mjs';
  assert.deepEqual(product.filter(file => file !== 'lib/cli-help.mjs' && file !== standalone
    && mainComparisons(fs.readFileSync(path.join(source, file), 'utf8')).duplicate), [], 'share the realpath check instead of duplicating it');
});

const scripts = [
  ['discovery/bounded.mjs', ['--timeout-ms', '0', 'unused'], 125, /invalid validation deadline/u],
  ['discovery/bubblewrap.mjs', [], 1, /explicit --experimental-bubblewrap/u],
  ['discovery/lane-file-access.mjs', [], 0, /"permissionDecision":"deny"/u],
  ['herdr/release-candidate.mjs', [], 1, /usage: release-candidate/u],
  ['promote/metrics.mjs', ['--unsupported'], 1, /unknown option or missing value/u],
  ...['promote/promote.mjs', 'release/release.mjs', 'supervisor/supervisor.mjs',
    'supervisor/prompt-supervisor.mjs', 'supervisor/tidy-tabs.mjs', 'acceptance/run.mjs']
    .map(file => [file, ['--unsupported'], 1, /Unknown option/u]),
  ...['acceptance/settle.mjs', 'acceptance/supervisor.mjs']
    .map(file => [file, ['absent-candidate'], 1, /MODULE_NOT_FOUND/u]),
  ['housekeeping/housekeeping.mjs', ['--unsupported'], 1, /Unknown option/u],
  ['test-slot/test-slot.mjs', ['unsupported'], 2, /usage: test-slot/u],
  ['acceptance/focus.mjs', ['--monitor', '{'], 1, /SyntaxError/u],
];

for (const [script, args, status, output] of scripts) {
  for (const link of ['directory', 'file']) test(`${script} executes through a ${link} symlink`, t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'main-module-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.symlinkSync(source, path.join(root, 'current'), 'dir');
    let launcher = path.join(root, 'current', script);
    if (link === 'file') {
      fs.symlinkSync(launcher, path.join(root, 'launcher.mjs'));
      launcher = path.join(root, 'launcher.mjs');
    }
    const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, TMP: root, TEMP: root,
      ORG_DIR: path.join(root, 'org'), ORG_ACTOR: 'main-module-test',
      HERDR_MONITOR_HOME: path.join(root, 'monitor'), HERDR_MONITOR_FLEET: path.join(root, 'fleet'),
      CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      HERDR_SOCKET_PATH: path.join(root, 'absent.sock'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const result = spawnSync(process.execPath, [launcher, ...args], {
      cwd: root, env, input: '{', encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, status, result.error?.message ?? result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, output);
  });
}

test('isMain resolves both paths and returns false for missing, dangling or different launchers', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'main-module-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = new URL('../lib/cli-help.mjs', import.meta.url);
  const file = fileURLToPath(helper), linked = path.join(root, 'helper.mjs');
  fs.symlinkSync(file, linked);
  const different = path.join(root, 'different.mjs');
  fs.writeFileSync(different, '');
  const dangling = path.join(root, 'dangling.mjs');
  fs.symlinkSync(path.join(root, 'missing.mjs'), dangling);
  const code = `import assert from 'node:assert/strict';
    import { isMain } from ${JSON.stringify(helper.href)};
    for (const launch of [${JSON.stringify(file)}, ${JSON.stringify(linked)}]) {
      process.argv[1] = launch;
      assert.equal(isMain(${JSON.stringify(helper.href)}), true);
      assert.equal(isMain(${JSON.stringify(pathToFileURL(linked).href)}), true);
    }
    for (const launch of [undefined, ${JSON.stringify(different)}, ${JSON.stringify(dangling)}]) {
      process.argv[1] = launch;
      assert.equal(isMain(${JSON.stringify(helper.href)}), false);
    }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
