// One offline scheduler after the separate slot tests; durations only set order.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../lib/cli-help.mjs';
import { tierFiles } from './tier.mjs';
import { runTestSlotSync } from '../../test-slot/run.mjs';
import { TIMINGS_ENV } from '../../test-slot/timings.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function fullFiles(directory = root) {
  return [...new Set(['core', 'cycle', 'lanes', 'acceptance', 'release'].flatMap(tier => tierFiles(tier, directory)))];
}

export function fileDurations(directory) {
  const rows = new Map(Object.entries(JSON.parse(fs.readFileSync(new URL('./test-durations.json', import.meta.url))).files)
    .map(([file, row]) => [file, { at: Date.parse(row.measured_at), seconds: row.duration_ms / 1000 }]));
  for (const name of fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.timings.jsonl')).sort() : []) {
    for (const line of fs.readFileSync(path.join(directory, name), 'utf8').split('\n')) {
      let row;
      try { row = JSON.parse(line); } catch { continue; } // An active journal can have an unfinished final line.
      if (row?.kind !== 'file' || row.event !== 'finish' || row.depth !== 0 || !Number.isFinite(row.duration_s) || row.duration_s < 0) continue;
      const at = Date.parse(row.at);
      if (Number.isFinite(at) && (!rows.has(row.name) || at > rows.get(row.name).at)) rows.set(row.name, { at, seconds: row.duration_s });
    }
  }
  return new Map([...rows].map(([file, row]) => [file, row.seconds]));
}

export function longestFirst(files, durations) {
  return [...files].sort((a, b) => ((durations.get(b) ?? -1) - (durations.get(a) ?? -1)) || (a < b ? -1 : a > b ? 1 : 0));
}

export function main({ env = process.env, execute = runTestSlotSync } = {}) {
  // The release's private clone still receives the source gate's journal path.
  const directory = env[TIMINGS_ENV] ? path.dirname(env[TIMINGS_ENV]) : path.join(execFileSync('git',
    ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim(), 'lane-validation');
  const files = longestFirst(fullFiles(), fileDurations(directory));
  console.log(`Full pass: ${files.length} files, longest first; cap 12 (load adjusted), file timeout ${env.MONITOR_TEST_FILE_TIMEOUT_MS ?? 0}ms`);
  const result = execute('test:full', [process.execPath, fileURLToPath(new URL('./run.mjs', import.meta.url)), ...files], {
    cwd: root, stdio: 'inherit', retryTimeout: false,
    env: { ...env, MONITOR_TEST_CONCURRENCY: '12', MONITOR_TEST_SUITE_NAME: 'full', MONITOR_TEST_TIER: 'release' },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (isMain(import.meta.url)) main();
