// Only an explicitly declared proving step calls this foreground admission wait.
import { setTimeout as pollSleep } from 'node:timers/promises';
import { readMemory } from '../lib/memory.mjs';

export const MEMORY_CODE = 'TEST_SLOT_MEMORY';
const refusal = (code, message) => Object.assign(Error(`${code}: ${message}`), { code });

export async function waitForMemoryFloor({ floor, deadline, immediate = false, signal,
  read = readMemory, now = Date.now, sleep = (ms, signal) => pollSleep(ms, undefined, { signal }),
  confirm = () => {}, notify = line => process.stderr.write(`${line}\n`) } = {}) {
  if (!Number.isSafeInteger(floor) || floor < 0 || !Number.isFinite(deadline)) throw Error('invalid proving memory admission');
  const low = () => refusal(MEMORY_CODE, `available memory below floor ${floor} bytes; admission deadline ${new Date(deadline).toISOString()} exhausted`);
  let previous;
  for (;;) {
    signal?.throwIfAborted();
    if (!immediate && now() >= deadline) throw low();
    confirm();
    let memory;
    try { memory = read(); } catch { /* An unreadable sample is unknown, never measured zero. */ }
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(memory?.available) || memory.available < 0 ||
        (memory.total !== undefined && (!Number.isSafeInteger(memory.total) || memory.total <= 0 || memory.available > memory.total)) ||
        (memory.source !== undefined && !['/proc/meminfo', 'vm_stat + vm.swapusage', 'vm_stat (swap unavailable)'].includes(memory.source)))
      throw refusal('TEST_SLOT_HOLDER_UNKNOWN', `proving memory sample unavailable or invalid; floor ${floor} bytes`);
    confirm();
    if (memory.available >= floor && (immediate || now() < deadline)) return memory;
    const description = `available ${memory.available} bytes; floor ${floor} bytes; admission deadline ${new Date(deadline).toISOString()}`;
    if (description !== previous) notify(`TEST_SLOT_MEMORY_WAIT: ${description}`);
    previous = description;
    const remaining = deadline - now();
    if (immediate || remaining <= 0) throw low();
    await sleep(Math.min(1000, remaining), signal);
  }
}
