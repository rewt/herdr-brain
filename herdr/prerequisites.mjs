#!/usr/bin/env node
// Check machine inputs before dependency installation or machine entry writes.
import { spawnSync } from 'node:child_process';
import { cliHelp } from '../lib/cli-help.mjs';
cliHelp(import.meta.url, "Usage: node herdr/prerequisites.mjs\nCheck Node, npm, Git, Python and Herdr prerequisites.");

const version = text => text.match(/\d+\.\d+(?:\.\d+)?/u)?.[0].split('.').map(Number);
function requireVersion(file, args, minimum, instruction) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 10000 });
  const found = version(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  const adequate = found && minimum.every((n, i) => found.slice(0, i).some((v, j) => v > minimum[j]) || (found[i] ?? 0) >= n);
  if (result.error || result.status !== 0 || !adequate) throw new Error(`install ${instruction}; ${file} ${minimum.join('.')}+ is required and must be on PATH`);
  console.log(`install: ${file} ${found.join('.')} checked`);
}
try {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('install Node.js 20+ (including npm) and put node on PATH');
  if (process.env.RELEASE_NO_NPM !== '1') requireVersion('npm', ['--version'], [1], 'npm with Node.js');
  requireVersion('git', ['--version'], [2, 38], 'Git');
  requireVersion('python3', ['--version'], [3], 'Python 3');
  if (process.env.RELEASE_NO_HERDR !== '1') requireVersion(process.env.HERDR_BIN_PATH || 'herdr', ['--version'], [0, 8, 0], 'Herdr from https://herdr.dev');
} catch (error) { console.error(`install: ${error.message}`); process.exitCode = 1; }
