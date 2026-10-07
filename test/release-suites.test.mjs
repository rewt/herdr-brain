import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tierFiles } from './helpers/tier.mjs';
import { releasePhases, MAX_SUITE_FILES } from './helpers/release-suites.mjs';
import { spawnScenarioChild, waitForExit } from './helpers/child.mjs';

const helper = fileURLToPath(new URL('./helpers/release-suites.mjs', import.meta.url));
const slot = fileURLToPath(new URL('../test-slot/test-slot.mjs', import.meta.url));

test('release suites cover tierFiles(release) exactly once and isolate heavy files', () => {
  const files = tierFiles('release');
  const groups = releasePhases(files);
  assert.ok(groups.length > 3);
  assert.deepEqual(groups.flatMap(([, rows]) => rows).sort(), [...files].sort());
  assert.equal(new Set(groups.map(([name]) => name)).size, groups.length);
  assert.ok(groups.every(([, rows]) => rows.length > 0 && rows.length <= MAX_SUITE_FILES));
  for (const file of files.filter(file => /^(lanes|acceptance)\//.test(file) || file === 'discovery/test/acceptance.test.mjs')) {
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

test('release scripts hold the slot without retrying the entire release inventory', () => {
  const scripts = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).scripts;
  assert.match(scripts['test:release:only'], /^node test-slot\/test-slot.mjs run test:release:only -- node test\/helpers\/release-suites.mjs --file-timeout=480000 --suite-timeout=540000$/);
  assert.ok(scripts['test:release:steps'].endsWith(' && npm run test:release:only'));
  assert.doesNotMatch(scripts['test:release:steps'], /test-slot\.mjs run test:release:only/);
  assert.equal(scripts['test:release'], 'node test-slot/test-slot.mjs run test:release -- npm run test:release:steps');
});

async function scenario(t, failure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-suites-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'attempts.jsonl');
  const lock = path.join(root, 'slot.lock');
  const preload = path.join(root, 'load.mjs');
  fs.writeFileSync(preload, "import os from 'node:os';os.loadavg=()=>[1000,1000,1000];");
  const files = ['discovery/test/acceptance.test.mjs', 'lanes/test/lane.test.mjs', 'acceptance/test/later.test.mjs'];
  for (const [i, file] of files.entries()) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `
import fs from 'node:fs';
const log=${JSON.stringify(log)}, file=${JSON.stringify(file)};
const before=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse):[];
fs.appendFileSync(log,JSON.stringify({file,token:process.env.MONITOR_TEST_SLOT_TOKEN})+'\\n');
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
  assert.equal(new Set(attempts.map(row => row.token)).size, 1, 'all suites and retries retain the same slot');
  assert.ok(attempts[0].token);
  assert.equal(fs.existsSync(lock), false, result.stdout + result.stderr);
  return { ...result, attempts: attempts.map(row => row.file), files };
}

test('a suite deadline under load retries only that suite and continues once', async t => {
  const result = await scenario(t, "if(!before.some(row=>row.file===file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(result.attempts, [result.files[0], result.files[1], result.files[1], result.files[2]]);
  assert.match(result.stderr, /Test suite exceeded 1500ms/);
  assert.match(result.stderr, /TEST_SLOT_TIMEOUT_RETRY: test:release:lanes\/test\/lane.test.mjs:1/);
  assert.equal((result.stderr.match(/TEST_SLOT_TIMEOUT_RETRY:/g) ?? []).length, 1);
});

test('a repeated suite deadline stops without replaying completed or later suites', async t => {
  const result = await scenario(t, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);');
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
