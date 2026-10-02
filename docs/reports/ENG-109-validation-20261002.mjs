#!/usr/bin/env node
// Same file list as npm test, in bounded phases for the loaded R-129 machine.
// No skips, fixture-command timeout relaxation, product hooks or model calls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test.split(/\s+/);
if (script[0] !== 'node' || script[1] !== 'test/helpers/run.mjs') throw new Error('npm test runner changed; inspect before validation');
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const files = script.slice(2).flatMap(pattern => {
  if (!/^[\w./*-]+$/.test(pattern)) throw new Error(`unexpected npm test pattern: ${pattern}`);
  const dir = path.dirname(pattern), match = new RegExp(`^${path.basename(pattern).split('*').map(escape).join('.*')}$`);
  const rows = fs.readdirSync(path.join(root, dir)).filter(name => match.test(name)).sort().map(name => `${dir}/${name}`);
  if (!rows.length) throw new Error(`empty npm test pattern: ${pattern}`);
  return rows;
});
if (new Set(files).size !== files.length) throw new Error('duplicate npm test files');
const probe = 'discovery/test/acceptance.test.mjs';
if (!files.includes(probe)) throw new Error('copied-entry test missing');
const cycle = file => /^(settle|supervisor|release)\//.test(file);
const phases = [
  ['copied-entry', files.filter(file => file === probe)],
  ['core-and-modules', files.filter(file => file !== probe && !cycle(file))],
  ['settle-supervisor-release', files.filter(cycle)],
];
if (phases.flatMap(([, rows]) => rows).length !== files.length) throw new Error('incomplete npm test coverage');
console.log(`Complete npm test file list: ${files.length} files; 3 bounded phases`);
for (const [name, rows] of phases) {
  console.log(`Validation phase ${name}: ${rows.length} files`);
  const result = spawnSync(process.execPath, [script[1], '--suite-timeout=540000', '--file-timeout=480000', ...rows],
    { cwd: root, env: { ...process.env, ORG_ACTOR: 'R-129-validation' }, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
}
console.log('All npm test files passed in bounded phases.');
