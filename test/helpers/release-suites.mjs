// Release-only suites have a fixed file-count bound as the inventory grows.
// The host slot spans the command; only an individual suite may retry.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../lib/cli-help.mjs';
import { tierFiles } from './tier.mjs';
import { runTestSlotSync } from '../../test-slot/run.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
export const MAX_SUITE_FILES = 4;

export function releasePhases(files) {
  if (!files.length || new Set(files).size !== files.length) throw Error('supply a nonempty, unique test file list');
  const directories = new Map();
  for (const file of files) {
    const directory = path.posix.dirname(file);
    // The longest lane test and copied-product probes get the full deadline.
    // Acceptance and future lane files are isolated for the same reason.
    const isolated = /^(lanes|acceptance)\//.test(file) || /^promote\/test\/completion(?:-recovery)?\.test\.mjs$/.test(file);
    const key = isolated ? file : directory;
    if (!directories.has(key)) directories.set(key, []);
    directories.get(key).push(file);
  }
  return [...directories].flatMap(([name, rows]) => {
    const groups = [];
    for (let i = 0; i < rows.length; i += MAX_SUITE_FILES) {
      groups.push([`${name}:${1 + i / MAX_SUITE_FILES}`, rows.slice(i, i + MAX_SUITE_FILES)]);
    }
    return groups;
  });
}

export function main(argv = process.argv.slice(2)) {
  const options = argv.filter(arg => arg.startsWith('--'));
  if (options.some(arg => arg !== '--fixed-deadlines' && !/^--(file|suite)-timeout=\d+$/.test(arg))) throw Error('unsupported release suite option');
  let files = argv.filter(arg => !arg.startsWith('--'));
  if (!files.length) {
    process.chdir(root);
    files = tierFiles('release');
  }
  const groups = releasePhases(files);
  console.log(`Release tier: ${files.length} files; ${groups.length} bounded suites`);
  for (const [name, rows] of groups) {
    console.log(`Release suite ${name}: ${rows.length} files`);
    const result = runTestSlotSync(`test:release:${name}`, [process.execPath, runner, ...options, ...rows], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
  }
  console.log('All release-tier suites passed.');
}

if (isMain(import.meta.url)) main();
