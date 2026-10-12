import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inventory } from './cutover-fixture.mjs';
import { switches, capture, restore, callers, retireContrib } from '../cutover.mjs';
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

// These are the copied command windows used by cases 19 and 20. Virtual elapsed
// time avoids a minute-long fixture and never invokes Herdr or a model.
for (const definition of [cases.switches, cases.retirement]) {
  test(`${definition.name}: sandbox-exec completes beyond the old deadline at load 24`, async (t) => {
    const load = monitor(t), calls = [];
    const { root, copy, spec, edits } = inventory(t), originals = capture(copy);
    for (const [key, file] of switches) {
      fs.writeFileSync(path.join(copy, file), edits[key]);
      if (file.endsWith('.sh')) fs.chmodSync(path.join(copy, file), 0o755);
    }
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    const rename = path.join(root, 'rename.json');
    fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}
      const fs=require('fs'),args=process.argv.slice(2);
      if(args[0]==='agent'&&args[1]==='rename')fs.writeFileSync(${JSON.stringify(rename)},JSON.stringify(args));
      console.log(JSON.stringify({result:{agents:[]}}));`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'org'), '#!/bin/sh\necho \'{"runs":[]}\'\n', { mode: 0o755 });
    const logs = path.join(copy, '.lane/supervisor/watch-logs'); fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, 'R-1.log'), '[org-report] switched-canary\nlate-from-old-run\n');
    fs.writeFileSync(path.join(logs, 'R-2.log'), 'new-log\n'.repeat(100));
    const org = path.join(root, 'existing/.org'); fs.mkdirSync(org, { recursive: true });
    fs.writeFileSync(path.join(org, 'events.jsonl'), '');
    fs.mkdirSync(path.join(spec.candidate, 'contrib'), { recursive: true });
    const compat = path.join(spec.candidate, 'contrib/settle-watch.mjs');
    fs.writeFileSync(compat, 'compatibility blob');
    const command = loadAwareCommand((file, args, options) => {
      calls.push({ file, args, options });
      if (options.timeout <= 70_000) return { status: null, error: { code: 'ETIMEDOUT', message: 'spawnSync sandbox-exec ETIMEDOUT' } };
      // The contention clock is virtual; copied shell execution and filesystem
      // cutover assertions are real. Native calls go only to scratch stand-ins.
      return process.platform === 'darwin' ? spawnSync(file, args, options) : spawnSync(args[2], args.slice(3), options);
    }, load);
    const results = definition.prerequisites.map(key => ({ key, status: 'PASS' }));
    await runCase(results, definition, () => {
      // ENG-64 keeps the launcher on contrib/settle-watch.mjs; no switch rewrites it.
      assert.deepEqual(callers(copy, 'contrib/settle-watch.mjs').map(v => path.relative(copy, v.file)), ['scripts/lane/launch-supervisor.mjs']);
      const invoke = (file, args = []) => command('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/bin/zsh', '-f', path.join(copy, file), ...args], {
        cwd: copy, env: { ...process.env, ORG_DIR: org, PATH: `${bin}:${process.env.PATH}`, HERDR_PANE_ID: `${spec.workspace}:p1` },
        timeout: 60_000, encoding: 'utf8',
      });
      if (definition === cases.switches) {
        const named = invoke('.lane/supervisor/session-start.sh'); assert.equal(named.status, 0, named.stderr);
        assert.deepEqual(JSON.parse(fs.readFileSync(rename)), ['agent', 'rename', `${spec.workspace}:p1`, spec.target]);
        const tidy = invoke('.lane/supervisor/tidy-tabs.sh', ['--dry-run', '--log-lines', '2']);
        assert.equal(tidy.status, 0, tidy.stderr); assert.match(tidy.stdout, /switched-canary/); assert.match(tidy.stdout, /late-from-old-run/);
        assert.equal(tidy.stdout.split('new-log').length - 1, 2);
        restore(copy, originals); assert.deepEqual(capture(copy), originals);
      } else {
        const saved = fs.readFileSync(compat), mode = fs.statSync(compat).mode & 0o777;
        try {
          assert.throws(() => retireContrib(copy, compat), /retirement refused/);
          const tidy = invoke('.lane/supervisor/tidy-tabs.sh', ['--dry-run']); assert.equal(tidy.status, 0, tidy.stderr);
        } finally { restore(copy, originals); }
        assert.deepEqual(fs.readFileSync(compat), saved); assert.equal(fs.statSync(compat).mode & 0o777, mode);
        assert.ok(callers(copy, 'contrib/settle-watch.mjs').length);
      }
    });
    assert.equal(results.at(-1).status, 'PASS', results.at(-1).detail);
    assert.equal(calls[0].options.timeout, 360_000, '24 runnable tasks / capped capacity of 4');
  });
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

test('report polling scales once from its own operation load and stays bounded', async (t) => {
  const load = monitor(t); let at = 0;
  await waitUntil(() => at >= 600, 'delayed report', 150, { load, now: () => at, sleep: async ms => { at += ms; } });
  assert.equal(at, 600);
  at = 0;
  await assert.rejects(waitUntil(() => false, 'hung report', 150, { load, now: () => at, sleep: async ms => { at += ms; } }), /timeout: hung report/);
  assert.equal(at, 900);
});

test('each command samples current load, preserves zero, and supplies a bounded default', (t) => {
  let value = 24;
  const load = createLoadMonitor({ read: () => [value, value, value], cpus: 18 }); t.after(load.stop);
  const seen = [], command = loadAwareCommand((file, args, options) => { seen.push(options.timeout); return { status: 0 }; }, load);
  command('child', [], { timeout: 10 }); value = 0;
  command('child', [], { timeout: 10 }); command('child', [], { timeout: 0 }); command('child', []);
  assert.deepEqual(seen, [60, 10, 0, 60_000]);
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
