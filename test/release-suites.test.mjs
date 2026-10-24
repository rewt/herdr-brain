import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tierFiles } from './helpers/tier.mjs';
import { releasePhases, MAX_SUITE_FILES } from './helpers/release-suites.mjs';
import { spawnScenarioChild, waitForExit } from './helpers/child.mjs';
import { testSlotEnvironment } from './helpers/test-slot-env.mjs';
import { RELEASE_TIMEOUT_ENV } from '../test-slot/limits.mjs';

const helper = fileURLToPath(new URL('./helpers/release-suites.mjs', import.meta.url));
const slot = fileURLToPath(new URL('../test-slot/test-slot.mjs', import.meta.url));

test('release suites cover tierFiles(release) exactly once and isolate heavy files', () => {
  const files = tierFiles('release');
  const groups = releasePhases(files);
  assert.ok(groups.length > 3);
  assert.deepEqual(groups.flatMap(([, rows]) => rows).sort(), [...files].sort());
  assert.equal(new Set(groups.map(([name]) => name)).size, groups.length);
  assert.ok(groups.every(([, rows]) => rows.length > 0 && rows.length <= MAX_SUITE_FILES));
  for (const file of files.filter(file => /^(lanes|acceptance)\//.test(file))) {
    assert.deepEqual(groups.find(([, rows]) => rows.includes(file))[1], [file]);
  }
  const promotion = tierFiles('promotion');
  assert.ok(groups.flatMap(([, rows]) => rows).every(file => !promotion.includes(file)));
});

test('growing directories add bounded suites without losing or repeating files', () => {
  const files = Array.from({ length: 101 }, (_, i) => `future/test/${i}.test.mjs`);
  const groups = releasePhases(files);
  assert.equal(groups.length, Math.ceil(files.length / MAX_SUITE_FILES));
  assert.deepEqual(groups.flatMap(([, rows]) => rows), files);
  assert.ok(groups.every(([, rows]) => rows.length <= MAX_SUITE_FILES));
  assert.throws(() => releasePhases([]), /nonempty/);
  assert.throws(() => releasePhases(['a', 'a']), /unique/);
});

test('release scripts retain one shared family without retrying the entire release inventory', () => {
  const scripts = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).scripts;
  assert.match(scripts['test:release:only'], /^node test-slot\/test-slot.mjs run test:release:only -- node test\/helpers\/release-suites.mjs$/);
  assert.ok(scripts['test:release:steps'].endsWith(' && npm run test:release:only'));
  assert.doesNotMatch(scripts['test:release:steps'], /test-slot\.mjs run test:release:only/);
  assert.equal(scripts['test:release'], 'node test-slot/test-slot.mjs run test:release -- npm run test:release:steps');
});

test('the fresh snapshot gate passes its declared timeout through every nested release wrapper', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-wall-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Exercise the exact build adapter without invoking release.sh or a test tier.
  const source = fs.readFileSync(new URL('../herdr/release.sh', import.meta.url), 'utf8');
  const adapter = source.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/)[1];
  for (const file of ['lanes/validation.mjs', 'test-slot/run.mjs']) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), target);
  }
  const scripts = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).scripts;
  const prefixes = ['test', 'test:release:steps', 'test:release:only'].flatMap(name =>
    [...scripts[name].matchAll(/node test-slot\/test-slot.mjs run ([\w:]+)(.*?) -- /g)]
      .map(match => [match[1], ...match[2].trim().split(/\s+/).filter(Boolean)]));
  assert.deepEqual(prefixes.map(([label]) => label).sort(),
    ['test:core', 'test:cycle', 'test:lanes', 'test:acceptance', 'test:release:only'].sort());
  // Include the adapter below test:release:only, and a deliberately tighter CLI override.
  prefixes.push(['test:release:fixture:1'], ['explicit', '--timeout-seconds', '17']);
  const commands = prefixes.map((args, i) => [slot, 'run', ...args, '--project-common', root,
    '--result-path', path.join(root, `${i}.json`), '--', process.execPath, '-e', '']);
  const driver = path.join(root, 'driver.mjs');
  fs.writeFileSync(driver, `import {spawnSync} from 'node:child_process';
for (const args of ${JSON.stringify(commands)}) {
  const result = spawnSync(process.execPath, args, {env:process.env, stdio:'inherit', timeout:15000});
  if (result.status !== 0) process.exit(result.status ?? 1);
}
`);
  const quote = arg => `'${arg.replaceAll("'", "'\\''")}'`;
  const top = scripts['test:release'].split(' -- ')[0].split(' ').slice(2);
  const command = [process.execPath, slot, ...top, '--project-common', root, '--result-path', path.join(root, 'top.json'),
    '--', process.execPath, driver].map(quote).join(' ');
  const lock = path.join(root, 'slot.lock');
  const declaration = JSON.parse(fs.readFileSync(new URL('../.lane.validation.json', import.meta.url)));
  const seconds = declaration.timeout_seconds;
  fs.writeFileSync(path.join(root, '.lane.validation.json'), JSON.stringify({ release: command, timeout_seconds: { release: seconds } }));
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock,
    MONITOR_GATE_HISTORY_ROOT: path.join(root, 'history') };
  // The build freezes the tagged declaration before evaluating the snapshot gate.
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.lane.validation.json'); git('commit', '-qm', 'Release validation fixture'); git('tag', 'snapshot');
  const tools = fileURLToPath(new URL('../herdr/releases.mjs', import.meta.url));
  const frozen = await waitForExit(spawnScenarioChild(t, process.execPath,
    [tools, 'freeze-validation', root, 'snapshot', path.join(root, '.release-validation.json')], { cwd: root, env }));
  assert.equal(frozen.code, 0, frozen.stdout + frozen.stderr);
  assert.equal(env[RELEASE_TIMEOUT_ENV], undefined);
  assert.equal(fs.existsSync(env.MONITOR_GATE_HISTORY_ROOT), false, 'fresh bundle has no gate history');
  const result = await waitForExit(spawnScenarioChild(t, process.execPath, ['--input-type=module', '-e', adapter], { cwd: root, env }));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const topReceipt = JSON.parse(fs.readFileSync(path.join(root, 'top.json')));
  assert.equal(topReceipt.limits.wall_seconds, seconds);
  assert.equal(topReceipt.limits.wall_source, 'watch');
  for (const [i, [label]] of prefixes.entries()) {
    const receipt = JSON.parse(fs.readFileSync(path.join(root, `${i}.json`)));
    assert.equal(receipt.limits.wall_seconds, 0, label);
    assert.equal(receipt.limits.wall_source, 'watch', label);
    assert.equal(receipt.exit_code, 0, label);
  }
});

async function scenario(t, failure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-suites-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'attempts.jsonl');
  const lock = path.join(root, 'slot.lock');
  const preload = path.join(root, 'load.mjs');
  fs.writeFileSync(preload, "import os from 'node:os';os.loadavg=()=>[1000,1000,1000];");
  const files = ['discovery/test/lessons.test.mjs', 'lanes/test/lane.test.mjs', 'acceptance/test/later.test.mjs'];
  for (const [i, file] of files.entries()) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `
import fs from 'node:fs';
const log=${JSON.stringify(log)}, file=${JSON.stringify(file)};
const before=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse):[];
fs.appendFileSync(log,JSON.stringify({file,occupancy:fs.readdirSync(${JSON.stringify(lock + '.occupancy')}).filter(name=>!name.startsWith('.'))})+'\\n');
${i === 1 ? failure : ''}
`);
  }
  // Exercise the same non-retrying outer slot and retrying per-suite adapters
  // as test:release:only, with real bounded runners and scratch test files.
  const child = spawnScenarioChild(t, process.execPath, [slot, 'run', 'release-fixture', '--', process.execPath, helper,
    '--fixed-deadlines', '--file-timeout=5000', '--suite-timeout=1500', ...files], {
    cwd: root,
    env: { ...process.env, MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` },
  });
  const result = await waitForExit(child);
  const attempts = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(attempts.every(row => row.occupancy.length === 1));
  assert.equal(new Set(attempts.map(row => row.occupancy[0])).size, 1, 'all suites and retries retain the same occupancy');
  assert.equal(fs.existsSync(lock), false, result.stdout + result.stderr);
  return { ...result, attempts: attempts.map(row => row.file), files };
}

test('an internal test timeout under load retries only that suite and continues once', async t => {
  const result = await scenario(t, "if(!before.some(row=>row.file===file)){console.error('testTimeoutFailure');process.exit(124);}");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(result.attempts, [result.files[0], result.files[1], result.files[1], result.files[2]]);
  assert.match(result.stdout + result.stderr, /testTimeoutFailure/);
  assert.match(result.stderr, /TEST_SLOT_TIMEOUT_RETRY: test:release:lanes\/test\/lane.test.mjs:1/);
  assert.equal((result.stderr.match(/TEST_SLOT_TIMEOUT_RETRY:/g) ?? []).length, 1);
});

test('a repeated internal test timeout stops without replaying completed or later suites', async t => {
  const result = await scenario(t, "console.error('testTimeoutFailure');process.exit(124);");
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.deepEqual(result.attempts, [result.files[0], result.files[1], result.files[1]]);
  assert.equal((result.stderr.match(/TEST_SLOT_TIMEOUT_RETRY:/g) ?? []).length, 1);
});

test('an ordinary failure under load stops without retrying or starting later suites', async t => {
  const result = await scenario(t, "throw Error('injected ordinary failure');");
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.deepEqual(result.attempts, result.files.slice(0, 2));
  assert.doesNotMatch(result.stderr, /TEST_SLOT_TIMEOUT_RETRY:/);
});
