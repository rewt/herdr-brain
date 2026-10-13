// Reproduce the new reparent regression against the reviewed C source. The
// test intercepts kill(), so even the old guard cannot signal a foreign PID.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-326-reparent-negative-'));
const testFile = `test/.fixture-lifetime-negative-${process.pid}.test.mjs`;
try {
  const source = spawnSync('git', ['show', '5c42ff5e1bdee70132b86aaa294ef733d6ac93d1:test/helpers/fixture-lifetime.c'], { encoding: 'utf8' });
  if (source.status !== 0) throw Error(source.stderr);
  const oldSource = path.join(root, 'fixture-lifetime.c');
  fs.writeFileSync(oldSource, source.stdout);
  const test = fs.readFileSync('test/fixture-lifetime.test.mjs', 'utf8');
  const include = '#include ${JSON.stringify(local(\'./helpers/fixture-lifetime.c\'))}';
  if (!test.includes(include)) throw Error('reparent test include changed');
  fs.writeFileSync(testFile, test.replace(include, `#include ${JSON.stringify(oldSource)}`));
  const result = spawnSync(process.execPath, ['test/helpers/run.mjs',
    '--test-name-pattern=^watch guard', testFile], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  process.stdout.write(output);
  if (result.error || result.status !== 1 || !/signal \d+ 9/.test(output))
    throw Error(`expected intercepted reaper signal failure, got ${result.status}: ${result.error ?? ''}`);
  process.stdout.write('Negative control confirmed: old guard attempted SIGKILL; the interceptor sent no signal.\n');
} finally {
  fs.rmSync(testFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
}
