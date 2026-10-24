import path from 'node:path';
import { startTiming } from '../../test-slot/timings.mjs';

// Only the admitted node:test file processes, never arbitrary fixture children.
const files = JSON.parse(process.env.MONITOR_TEST_TIMING_FILES ?? '[]');
const file = process.argv[1] && path.resolve(process.argv[1]);
if (process.env.NODE_TEST_CONTEXT === 'child-v8' && files.includes(file)) {
  const finish = startTiming('file', path.relative(process.cwd(), file), { suite: process.env.MONITOR_TEST_TIMING_SUITE,
    depth: Math.max(0, Number(process.env.MONITOR_TEST_TIMING_DEPTH ?? 1) - 1) });
  delete process.env.MONITOR_TEST_TIMING_FILES;
  process.once('exit', exit_code => finish({ exit_code }));
}
