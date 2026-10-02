import os from 'node:os';

// A one-minute average at/above CPU capacity means runnable work is competing
// for the machine. Retain all three averages alongside that capacity.
export function createLoadMonitor({ read = () => os.loadavg(), cpus = os.availableParallelism(),
  now = Date.now, record = () => {}, intervalMs = 1000 } = {}) {
  const threshold = Math.max(1, cpus), samples = [];
  function sample() {
    const value = { at: now(), averages: [...read()], cpus, threshold };
    samples.push(value); record(value);
    return value;
  }
  function begin() { const index = samples.length; sample(); return index; }
  function snapshot(index = 0) {
    sample();
    const values = samples.slice(index);
    const peak = values.reduce((a, b) => a.averages[0] >= b.averages[0] ? a : b);
    return { samples: values.length, startedAt: values[0].at, endedAt: values.at(-1).at,
      peak, heavy: Number.isFinite(peak.averages[0]) && peak.averages[0] >= threshold };
  }
  sample();
  const timer = setInterval(sample, intervalMs); timer.unref();
  return { begin, sample, snapshot, stop: () => clearInterval(timer) };
}

export class LoadTimeout extends Error {
  constructor(message, load) { super(message); this.name = 'LoadTimeout'; this.load = load; }
}

export function loadReason(load) {
  const { averages, cpus, threshold } = load.peak;
  return `measured heavy load: ${averages.map((value) => value.toFixed(2)).join('/')} (1/5/15m), ${cpus} CPUs, threshold ${threshold}`;
}

export const isTimeout = (message) => /\btimed out\b|\bETIMEDOUT\b|\btimeout:/i.test(message);

export async function waitUntil(fn, label, ms, { load, now = Date.now,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)) } = {}) {
  const window = load?.begin(), end = now() + ms;
  while (now() < end) {
    load?.sample();
    if (fn()) return;
    await sleep(150);
  }
  throw new LoadTimeout(`timeout: ${label}`, load?.snapshot(window));
}
