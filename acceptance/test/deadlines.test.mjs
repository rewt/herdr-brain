import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLoadMonitor, waitUntil } from '../load.mjs';
import { loadAwareCommand } from '../commands.mjs';
import { classifyFailure } from '../limits.mjs';
import { cases, runCase } from '../cases.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { noticeCadence, noticeDeliveryBudgetMs } from '../notice-budget.mjs';

function monitor(t, value = 24, cpus = 18) {
  const load = createLoadMonitor({ read: () => [value, value, value], cpus });
  t.after(load.stop);
  return load;
}

for (const value of [24, 0]) test(`a genuinely hung sandbox-exec reaches its finite deadline at load ${value}`, (t) => {
  const load = monitor(t, value); let allowance;
  // A child ignoring SIGTERM must still be killed at the synchronous deadline.
  // On macOS it is launched through the real sandbox executable.
  const command = loadAwareCommand((file, args, options) => {
    assert.equal(file, '/usr/bin/sandbox-exec'); allowance = options.timeout;
    assert.equal(options.killSignal, 'SIGKILL');
    return process.platform === 'darwin'
      ? spawnSync(file, ['-p', '(version 1) (allow default)', process.execPath, '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], options)
      : spawnSync(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], options);
  }, load);
  const began = Date.now();
  assert.throws(() => command('/usr/bin/sandbox-exec', [], { timeout: 50, encoding: 'utf8' }),
    error => /ETIMEDOUT/.test(error.message) && classifyFailure(error).status === (value ? 'PENDING' : 'FAIL'));
  assert.equal(allowance, value ? 300 : 50);
  assert.ok(Date.now() - began < loadTimeout(2000), 'a real non-response remains bounded');
});

test('report polling observes completion beyond its planning allowance without an elapsed failure', async (t) => {
  const load = monitor(t); let at = 0;
  await waitUntil(() => at >= 600, 'delayed report', 150, { load, now: () => at, sleep: async ms => { at += ms; } });
  assert.equal(at, 600);
  at = 0;
  await waitUntil(() => at >= 3_600_000, 'late report', 150, { load, now: () => at, sleep: async ms => { at += ms; } });
  assert.equal(at, 3_600_000);
});

test('each command samples explicit control load and ordinary commands have no elapsed default', (t) => {
  let value = 24;
  const load = createLoadMonitor({ read: () => [value, value, value], cpus: 18 }); t.after(load.stop);
  const seen = [], command = loadAwareCommand((file, args, options) => { seen.push(options.timeout); return { status: 0 }; }, load);
  command('child', [], { timeout: 10 }); value = 0;
  command('child', [], { timeout: 10 }); command('child', [], { timeout: 0 }); command('child', []);
  assert.deepEqual(seen, [60, 10, 0, 0]);
});

// ENG-319: RC-21 case 07 used the runner's 25 s default while the inbox owner
// needed about 30 s for three notices. Read the deliverer's actual defaults and
// the limit case 07 passes, so neither can drift below the other.
test('case 07 waits for its promotion notices at least as long as the default delivery cadence', () => {
  const read = file => fs.readFileSync(path.resolve(import.meta.dirname, '../..', file), 'utf8');
  const deliverer = read('supervisor/prompt-supervisor.mjs');
  const fallback = name => {
    const values = new Set([...deliverer.matchAll(new RegExp(`${name}, ([\\d.]+),`, 'g'))].map(match => Number(match[1])));
    assert.equal(values.size, 1, `one ${name} default`);
    return [...values][0];
  };
  const cadence = { pollSeconds: fallback('SUPERVISOR_INPUT_POLL_SECONDS'), confirmSeconds: fallback('SUPERVISOR_INPUT_CONFIRM_SECONDS') };
  assert.deepEqual(noticeCadence, cadence);
  const runner = read('acceptance/run.mjs');
  const notices = 3; // queue-first, queue-second, queue-refusal
  const call = /'every promotion notice reached supervisor PTY'(?:,\s*([^;]*?))?\);/.exec(runner);
  assert.ok(call, 'case 07 notice wait');
  const limit = call[1] === undefined ? Number(/async function until\(fn, label, ms = ([\d_]+)\)/.exec(runner)[1].replaceAll('_', ''))
    : call[1] === 'noticeDeliveryBudgetMs(state.results.length)' ? noticeDeliveryBudgetMs(notices) : assert.fail(`unrecognized limit: ${call[1]}`);
  const needed = notices * (cadence.pollSeconds + cadence.confirmSeconds) * 1000;
  assert.ok(limit >= needed, `case 07 waits ${limit} ms for ${notices} notices; default delivery needs at least ${needed} ms`);
});
