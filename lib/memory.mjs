// Machine measurements are advisory; this module neither writes the record nor
// chooses work. Callers wait before launching expensive lifecycle operations.
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const MiB = 1024 ** 2;
const bytes = value => Number.isFinite(value) && value >= 0;
const native = (command, args) => {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * MiB });
  if (r.error || r.status !== 0) throw new Error(`${command}: ${r.error?.message || r.stderr?.trim() || `probe exited ${r.status ?? r.signal}`}`);
  return r.stdout;
};

export function linuxMemory(text) {
  const fields = Object.fromEntries([...text.matchAll(/^(\w+):\s+(\d+)\s+kB\s*$/gm)].map(m => [m[1], Number(m[2]) * 1024]));
  const { MemTotal: total, MemAvailable: available, SwapTotal, SwapFree } = fields;
  if (![total, available, SwapTotal, SwapFree].every(bytes) || total === 0 || available > total || SwapFree > SwapTotal) throw new Error('invalid /proc/meminfo');
  return { total, available, swap_used: SwapTotal - SwapFree, source: '/proc/meminfo' };
}

export function macMemory(vm, swap, total) {
  const size = Number(vm.match(/page size of (\d+) bytes/)?.[1]);
  const pages = name => Number(vm.match(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.\\s*$`, 'm'))?.[1]);
  const available = (pages('free') + pages('inactive') + pages('speculative')) * size;
  const used = swap.match(/\bused\s*=\s*([\d.]+)([KMGT])\b/i);
  const swap_used = used ? Number(used[1]) * 1024 ** ('KMGT'.indexOf(used[2].toUpperCase()) + 1) : NaN;
  if (!bytes(available) || !bytes(total) || total === 0 || available > total || !bytes(swap_used) || !bytes(size) || size === 0) throw new Error('invalid macOS memory statistics');
  // Inactive and speculative pages are reclaimable. Raw free pages alone would
  // treat a healthy filesystem cache as pressure. Purgeable is not added twice.
  return { total, available, swap_used, source: 'vm_stat + vm.swapusage' };
}

export function readMemory({ platform = process.platform, read = file => fs.readFileSync(file, 'utf8'),
  run = native, total = () => os.totalmem(), free = () => os.freemem() } = {}) {
  try {
    if (platform === 'linux') return linuxMemory(read('/proc/meminfo'));
    if (platform === 'darwin') {
      const vm = run('vm_stat', []), capacity = total();
      const available = macMemory(vm, 'used = 0M', capacity);
      try { return macMemory(vm, run('sysctl', ['-n', 'vm.swapusage']), capacity); }
      catch (error) { return { ...available, swap_used: null, source: 'vm_stat (swap unavailable)', warning: error.message }; }
    }
    throw new Error(`memory probe unsupported on ${platform}`);
  } catch (error) {
    // Darwin's free pages exclude reclaimable cache. Without vm_stat, raw
    // freemem cannot distinguish cache from pressure; keep it advisory only.
    if (platform === 'darwin') return { total: total(), available: null, swap_used: null,
      source: 'macOS memory unavailable', warning: error.message };
    return { total: total(), available: free(), swap_used: null, source: 'os.freemem (fallback)', warning: error.message };
  }
}

export function memoryReason(memory) {
  const reasons = [];
  // Cold pages can remain swapped after a host recovers. Defer for substantial
  // swap only when reclaimable RAM is also scarce, rather than waiting for the
  // OS to reclaim every old swap page/file on an otherwise idle machine.
  if (bytes(memory.total) && memory.total > 0 && bytes(memory.swap_used) &&
      memory.swap_used >= memory.total * 0.05 && bytes(memory.available) && memory.available < memory.total * 0.25)
    reasons.push(`swap in use ${Math.ceil(memory.swap_used / MiB)} MiB with available memory below 25% of RAM`);
  const minimum = Math.max(256 * MiB, memory.total * 0.05);
  if (bytes(memory.available) && bytes(minimum) && memory.available < minimum)
    reasons.push(`available memory ${Math.floor(memory.available / MiB)} MiB below ${Math.ceil(minimum / MiB)} MiB`);
  return reasons.length ? `memory pressure: ${reasons.join('; ')}` : null;
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Foreground callers retain their request/stage while waiting, without a bound
// by default. Lock owners can bound a re-check; native probe failures
// remain visible advisories rather than pressure.
export function waitForMemory({ label = 'cycle', read = readMemory, sleep = pause, intervalMs = 5000,
  notify = line => process.stderr.write(`${line}\n`), check = () => {},
  maxWaitMs = Infinity, now = () => performance.now() } = {}) {
  if (!(maxWaitMs === Infinity || (Number.isFinite(maxWaitMs) && maxWaitMs >= 0))) throw new Error('invalid memory wait bound');
  const deadline = now() + maxWaitMs;
  let waiting = false, previous, warning;
  for (;;) {
    check();
    const memory = read(), reason = memoryReason(memory);
    if (memory.warning && memory.warning !== warning) { notify(`${label}: memory probe advisory: ${memory.warning}`); warning = memory.warning; }
    if (!reason) {
      check();
      if (waiting) notify(`${label}: memory pressure cleared; proceeding`);
      return memory;
    }
    if (reason !== previous) notify(`${label}: waiting; ${reason}`);
    waiting = true; previous = reason;
    check();
    const remaining = deadline - now();
    if (remaining <= 0) throw Object.assign(new Error(`${label}: ${reason}; wait capped at ${maxWaitMs}ms`), { code: 'MEMORY_PRESSURE_TIMEOUT' });
    sleep(Math.min(intervalMs, remaining));
  }
}
