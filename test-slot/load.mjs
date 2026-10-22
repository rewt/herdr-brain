// Test files use host capacity; the serialized product CLI/IPC allowance in
// lib/deadline.mjs deliberately keeps its separate four-core divisor.
import os from 'node:os';

export function testLoadFactor(load = os.loadavg()[0], parallelism = os.availableParallelism()) {
  const capacity = Number.isFinite(parallelism) && parallelism > 0 ? parallelism : 1;
  return Number.isFinite(load) && load >= 0 ? Math.max(1, load / capacity) : 1;
}
