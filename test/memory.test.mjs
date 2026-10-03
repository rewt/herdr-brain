import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { linuxMemory, macMemory, readMemory, memoryReason, waitForMemory, processUsage } from '../lib/memory.mjs';

const GiB = 1024 ** 3;
const healthy = { total: 16 * GiB, available: 8 * GiB, swap_used: 0 };
const vm = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 100.
Pages inactive: 200000.
Pages speculative: 300.
Pages purgeable: 999999.
Swapouts: 99999.
`;

test('Linux measures available bytes and current swap, never cumulative paging counters', () => {
  const memory = linuxMemory('MemTotal: 16777216 kB\nMemFree: 1 kB\nMemAvailable: 8388608 kB\nSwapTotal: 1048576 kB\nSwapFree: 1047552 kB\n');
  assert.equal(memory.available, 8 * GiB); assert.equal(memory.swap_used, 1024 ** 2);
  assert.match(memoryReason(memory), /swap in use 1 MiB/);
  for (const text of ['', 'MemTotal: -1 kB\n', 'MemTotal: 1 kB\nMemAvailable: 2 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n']) assert.throws(() => linuxMemory(text));
});

test('macOS honors page size, reclaimable cache and swap units without double counting purgeable pages', () => {
  const memory = macMemory(vm, 'total = 1G used = 0.5G free = 0.5G (encrypted)', healthy.total);
  assert.equal(memory.available, 200400 * 16384); assert.equal(memory.swap_used, GiB / 2);
  assert.equal(memoryReason(macMemory(vm, 'used = 0M', healthy.total)), null);
  assert.equal(macMemory(vm.replace('16384', '4096'), 'used = 2K', healthy.total).swap_used, 2048);
  for (const swap of ['', 'used = NaNM', 'used = -1M']) assert.throws(() => macMemory(vm, swap, healthy.total));
});

test('memory probes use macOS and Linux native inputs and surface failures without inventing swap', () => {
  const calls = [];
  const memory = readMemory({ platform: 'darwin', total: () => healthy.total, run: (cmd, args) => {
    calls.push([cmd, args]); return cmd === 'vm_stat' ? vm : 'used = 12M';
  } });
  assert.equal(memory.swap_used, 12 * 1024 ** 2);
  assert.deepEqual(calls, [['vm_stat', []], ['sysctl', ['-n', 'vm.swapusage']]]);
  const partial = readMemory({ platform: 'darwin', total: () => healthy.total, run: cmd => {
    if (cmd === 'vm_stat') return vm; throw Error('sysctl denied');
  } });
  assert.equal(partial.available, 200400 * 16384); assert.equal(partial.swap_used, null);
  assert.match(partial.warning, /sysctl denied/);
  const fallback = readMemory({ platform: 'linux', read: () => { throw Error('proc missing'); }, total: () => healthy.total, free: () => healthy.available });
  assert.equal(fallback.swap_used, null); assert.match(fallback.warning, /proc missing/);
  assert.equal(memoryReason(fallback), null);
});

test('swap or low available memory waits with visible reasons and proceeds when pressure clears', () => {
  const messages = [], sleeps = [], values = [{ ...healthy, swap_used: 1 }, { ...healthy, available: 128 * 1024 ** 2 }, healthy];
  assert.equal(waitForMemory({ read: () => values.shift(), notify: line => messages.push(line), sleep: ms => sleeps.push(ms) }), healthy);
  assert.deepEqual(sleeps, [5000, 5000]);
  assert.match(messages[0], /waiting; memory pressure: swap/);
  assert.match(messages[1], /available memory 128 MiB below 820 MiB/);
  assert.match(messages[2], /cleared; proceeding/);
  assert.equal(memoryReason({ total: GiB, available: 256 * 1024 ** 2, swap_used: 0 }), null);
  assert.match(memoryReason({ total: GiB, available: 255 * 1024 ** 2, swap_used: 0 }), /below 256 MiB/);
});

test('probe advisories are visible and caller cancellation is checked on each sample', () => {
  const messages = [];
  waitForMemory({ read: () => ({ ...healthy, warning: 'swap unavailable' }), notify: line => messages.push(line) });
  assert.match(messages[0], /advisory: swap unavailable/);
  let checks = 0;
  assert.throws(() => waitForMemory({ read: () => ({ ...healthy, swap_used: 1 }), sleep: () => {}, notify: () => {}, check: () => {
    if (++checks === 2) throw Error('STOP');
  } }), /STOP/);
});

test('process diagnostics rank memory and CPU separately and retain PID, parent and fixture command', () => {
  const usage = processUsage({ run: () => ' 11 1 100 99.0 node test/pty-leaf.mjs\n 12 11 2048 0.5 node worker.mjs\ninvalid\n', limit: 1 });
  assert.equal(usage.by_memory[0].pid, 12); assert.equal(usage.by_memory[0].rss_bytes, 2048 * 1024);
  assert.equal(usage.by_cpu[0].pid, 11); assert.equal(usage.by_cpu[0].ppid, 1);
  assert.match(usage.by_cpu[0].command, /pty-leaf/);
  assert.match(processUsage({ run: () => { throw Error('ps unavailable'); } }).warning, /ps unavailable/);
  assert.match(processUsage({ run: () => 'invalid output' }).warning, /no process rows/);
});
