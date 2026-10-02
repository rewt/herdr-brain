// The complete npm test list, split into finite suites to avoid aggregate timeout
// and isolate the copied-entry probes. Fixture/command bounds remain unchanged.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function phases(files) {
  if (!files.length || new Set(files).size !== files.length) throw new Error('supply a nonempty, unique test file list');
  const probe = file => file === 'discovery/test/acceptance.test.mjs';
  const cycle = file => /^(settle|supervisor|release)\//.test(file);
  return [
    ['copied-entry', files.filter(probe)],
    ['core-and-modules', files.filter(file => !probe(file) && !cycle(file))],
    ['settle-supervisor-release', files.filter(cycle)],
  ].filter(([, rows]) => rows.length);
}

export function main(argv = process.argv.slice(2)) {
  const options = argv.filter(arg => arg.startsWith('--'));
  if (options.some(arg => !/^--(file|suite)-timeout=\d+$/.test(arg))) throw new Error('unsupported suite option');
  const files = argv.filter(arg => !arg.startsWith('--'));
  const groups = phases(files);
  console.log(`Complete npm test list: ${files.length} files; ${groups.length} bounded phases`);
  for (const [name, rows] of groups) {
    console.log(`Validation phase ${name}: ${rows.length} files`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), ...options, ...rows], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
  }
  console.log('All npm test files passed in bounded phases.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
