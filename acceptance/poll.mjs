import { loadTimeout } from './deadline.mjs';
export async function pollNative(fn, label, ms, { now = Date.now, allowance = loadTimeout,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)), intervalMs = 100 } = {}) {
  const deadline = now() + allowance(ms);
  for (;;) {
    if (now() >= deadline) throw new Error(label);
    const value = await fn(deadline);
    if (now() >= deadline) throw new Error(label);
    if (value) return value;
    await sleep(Math.min(intervalMs, deadline - now()));
  }
}
