export async function pollNative(fn, label, ms, {
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)), intervalMs = 100 } = {}) {
  for (;;) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
}
