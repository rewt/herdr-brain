import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fullFiles, fileDurations, longestFirst, main } from './helpers/full-pass.mjs';
import { spawnScenarioChild, waitForExit } from './helpers/child.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'full-pass-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('separate slot step and full helper cover the tracked release inventory exactly once', () => {
  const expected = execFileSync('git', ['-C', root, 'ls-files', '*.test.mjs'], { encoding: 'utf8' }).trim().split('\n');
  const slot = fs.readdirSync(path.join(root, 'test-slot/test')).filter(name => name.endsWith('.test.mjs')).map(name => `test-slot/test/${name}`);
  const files = fullFiles(), combined = [...slot, ...files];
  assert.equal(new Set(combined).size, combined.length);
  assert.deepEqual(combined.sort(), expected.sort());
  assert.ok(files.includes('test/full-pass.test.mjs'));
  const declaration = JSON.parse(fs.readFileSync(path.join(root, '.lane.validation.json')));
  assert.equal(declaration.release, 'npm run test:slot && node test/helpers/full-pass.mjs');
  assert.equal(declaration.timeout_seconds, 0);
  assert.equal(declaration.landing_waiver, 'operator-20261025-until-stable-release');
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).scripts;
  assert.equal(scripts['test:slot'], 'node --test test-slot/test/*.test.mjs');
  assert.equal(scripts['test:release'], 'node test-slot/test-slot.mjs run test:release -- npm run test:release:steps');
});

test('newest completed top-level file evidence wins, including failed executions', t => {
  const directory = scratch(t);
  const row = (name, duration_s, at, extra = {}) => ({ name, duration_s, at, kind: 'file', event: 'finish', depth: 0, exit_code: 0, ...extra });
  fs.writeFileSync(path.join(directory, 'b.timings.jsonl'), [
    row('test/slow.test.mjs', 20, '2026-10-26T00:00:00Z'),
    row('test/slow.test.mjs', 50, '2026-10-27T00:00:00Z', { exit_code: 1 }),
    row('test/slow.test.mjs', 999, '2026-10-28T00:00:00Z', { event: 'start' }),
    row('test/slow.test.mjs', 999, '2026-10-28T00:00:00Z', { depth: 1 }),
    row('test/slow.test.mjs', -1, '2026-10-28T00:00:00Z'),
    row('test/slow.test.mjs', 999, 'invalid'),
    row('test/fast.test.mjs', 10, '2026-10-27T00:00:00Z'),
  ].map(JSON.stringify).join('\n') + '\n{"unfinished":');
  fs.writeFileSync(path.join(directory, 'a.timings.jsonl'), JSON.stringify(row('test/slow.test.mjs', 1, '2026-10-25T00:00:00Z')));
  const durations = fileDurations(directory);
  assert.equal(durations.get('test/slow.test.mjs'), 50);
  assert.deepEqual(longestFirst(['z', 'test/fast.test.mjs', 'a', 'test/slow.test.mjs'], durations), ['test/slow.test.mjs', 'test/fast.test.mjs', 'a', 'z']);
  assert.ok(durations.get('lanes/test/lane.test.mjs') > 0, 'retains measured table fallback');
});

test('missing journals use existing measurements and deterministic unknown and equal-duration order', t => {
  assert.ok(fileDurations(path.join(scratch(t), 'absent')).size > 0);
  const files = ['unknown-z', 'b', 'unknown-a', 'a', 'zero'];
  const durations = new Map([['a', 2], ['b', 2], ['zero', 0]]);
  assert.deepEqual(longestFirst(files, durations), ['a', 'b', 'zero', 'unknown-a', 'unknown-z']);
  assert.deepEqual(files, ['unknown-z', 'b', 'unknown-a', 'a', 'zero']);
});

test('full helper makes one non-retrying owned runner call at cap12 with timeout off', t => {
  const directory = scratch(t), calls = [];
  const saved = process.exitCode;
  t.after(() => { process.exitCode = saved; });
  const env = { MONITOR_TEST_TIMINGS_PATH: path.join(directory, 'current.timings.jsonl'), MONITOR_TEST_CONCURRENCY: '99' };
  main({ env, execute: (...args) => { calls.push(args); return { status: 1 }; } });
  assert.equal(process.exitCode, 1, 'retains the actual failing result');
  assert.equal(calls.length, 1);
  const [label, argv, options] = calls[0];
  assert.equal(label, 'test:full');
  assert.equal(argv[0], process.execPath);
  assert.equal(argv[1], path.join(root, 'test/helpers/run.mjs'));
  assert.deepEqual([...argv.slice(2)].sort(), fullFiles().sort());
  assert.equal(options.env.MONITOR_TEST_CONCURRENCY, '12');
  assert.equal(options.env.MONITOR_TEST_FILE_TIMEOUT_MS, undefined);
  assert.equal(options.env.MONITOR_TEST_TIMINGS_PATH, env.MONITOR_TEST_TIMINGS_PATH);
  assert.equal(options.retryTimeout, false);
  assert.equal(options.cwd, root);
  assert.equal(env.MONITOR_TEST_CONCURRENCY, '99');
});

test('runner consumes the explicit cap, keeps legacy timeouts off and retains failure plus later results', async t => {
  const directory = scratch(t), log = path.join(directory, 'events.jsonl');
  const files = [0, 1, 2].map(i => path.join(directory, `${i}.test.mjs`));
  for (const [i, file] of files.entries()) fs.writeFileSync(file, `
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('fixture ${i}', async () => {
  assert.equal(process.env.MONITOR_TEST_CONCURRENCY, undefined);
  assert.equal(process.env.MONITOR_TEST_FILE_TIMEOUT_MS, undefined);
  const log = event => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({i:${i}, event})+'\\n');
  log('start');
  fs.writeFileSync(${JSON.stringify(directory)}+'/ready-${i}', '');
  // Hold the first admitted pair until both are running, even under load.
  if (${i} < 2) while (![0, 1].every(i => fs.existsSync(${JSON.stringify(directory)}+'/ready-'+i))) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  log('finish');
  ${i === 0 ? "assert.fail('deliberate fixture failure');" : ''}
});
`);
  const child = spawnScenarioChild(t, process.execPath, [path.join(root, 'test/helpers/run.mjs'), '--load-factor=1',
    '--file-timeout=1', '--suite-timeout=1', ...files], {
    env: { ...process.env, MONITOR_TEST_CONCURRENCY: '2', MONITOR_TEST_FILE_TIMEOUT_MS: '0',
      MONITOR_TEST_TIMINGS_PATH: path.join(directory, 'timings.jsonl') },
  });
  const result = await waitForExit(child);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const references = [...result.stderr.matchAll(/^FILE_TAP_COMPLETE: (.*)$/gm)].map(match => JSON.parse(match[1]));
  assert.deepEqual(references.map(entry => entry.file).sort(), [...files].sort(), result.stderr);
  let passes = 0, failures = 0;
  for (const [i, file] of files.entries()) {
    const reference = references.find(entry => entry.file === file);
    const failed = i === 0 ? 1 : 0;
    assert.equal(reference.exit_code, failed);
    const tap = fs.readFileSync(reference.artifact, 'utf8');
    assert.match(tap, new RegExp(`^${failed ? 'not ' : ''}ok 1 - fixture ${i}$`, 'm'));
    assert.match(tap, new RegExp(`1\\.\\.1\\n# tests 1\\n# suites 0\\n# pass ${1 - failed}\\n# fail ${failed}\\n# cancelled 0\\n`));
    assert.ok(result.stdout.includes(tap), 'each complete file summary must reach the build log');
    passes += Number(tap.match(/^# pass (\d+)$/m)[1]);
    failures += Number(tap.match(/^# fail (\d+)$/m)[1]);
  }
  assert.equal(passes, 2);
  assert.equal(failures, 1);
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.filter(row => row.event === 'start').map(row => row.i).sort(), [0, 1, 2]);
  let active = 0, peak = 0;
  for (const row of rows) { active += row.event === 'start' ? 1 : -1; peak = Math.max(peak, active); }
  assert.equal(active, 0);
  assert.equal(peak, 2);
});
