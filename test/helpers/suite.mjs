// The complete npm test list, grouped by module family. Time is observation only.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../lib/cli-help.mjs';

export function phases(files) {
  if (!files.length || new Set(files).size !== files.length) throw new Error('supply a nonempty, unique test file list');
  const cycle = file => /^(settle|supervisor)\//.test(file);
  return [
    ['core-and-modules', files.filter(file => !cycle(file))],
    ['settle-supervisor', files.filter(cycle)],
  ].filter(([, rows]) => rows.length);
}

export function main(argv = process.argv.slice(2)) {
  const options = argv.filter(arg => arg.startsWith('--'));
  if (options.some(arg => arg !== '--fixed-deadlines' && !/^--(file|suite)-timeout=\d+$/.test(arg))) throw new Error('unsupported suite option');
  const files = argv.filter(arg => !arg.startsWith('--'));
  const groups = phases(files);
  console.log(`Complete supplied test list: ${files.length} files; ${groups.length} phases`);
  for (const [name, rows] of groups) {
    console.log(`Validation phase ${name}: ${rows.length} files`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), ...options, ...rows], { stdio: 'inherit', env: { ...process.env, MONITOR_TEST_SUITE_NAME: name } });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
  }
  console.log('All supplied test files passed in phases.');
}

if (isMain(import.meta.url)) main();
