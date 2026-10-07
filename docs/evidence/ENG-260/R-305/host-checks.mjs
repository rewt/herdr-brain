// Offline, sequential main/head comparisons and script-specific regression files.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const evidence = path.dirname(fileURLToPath(import.meta.url));
const head = path.resolve(evidence, '../../../..');
const main = '/private/tmp/eng260-r305-main';
const runner = ['test/helpers/run.mjs', '--file-timeout=480000', '--suite-timeout=540000'];
const cases = [
  ['validation', '^actual native transport validates', 'acceptance/test/validation.test.mjs'],
  ['discovery', '^installed live discovery records concurrent', 'acceptance/test/live-session.test.mjs'],
];
const jobs = [];
for (const [label, pattern, file] of cases) for (const [revision, cwd] of [['main', main], ['head', head]])
  jobs.push({ name: `${label}-${revision}`, cwd, args: [...runner, `--test-name-pattern=${pattern}`, file] });
const helpers = ['test/main-module.test.mjs', 'release/test/candidate.test.mjs', 'test/helper-main.test.mjs', 'test/tier-plan.test.mjs',
  'test/cli-help.test.mjs', 'test/suite.test.mjs', 'test/release-suites.test.mjs', 'test/pty.test.mjs', 'test/pty-cache.test.mjs'];
const related = fs.readFileSync(path.join(evidence, 'related-files.txt'), 'utf8').trim().split('\n');
related.push('housekeeping/test/housekeeping.test.mjs', 'lanes/test/validation.test.mjs', 'lanes/test/workspace-native.test.mjs', 'test/load-deadlines.test.mjs');
const acceptance = fs.readdirSync(path.join(head, 'acceptance/test')).filter(file => file.endsWith('.test.mjs')).sort().map(file => `acceptance/test/${file}`);
const slot = fs.readdirSync(path.join(head, 'test-slot/test')).filter(file => file.endsWith('.test.mjs')).sort().map(file => `test-slot/test/${file}`);
jobs.push({ name: 'helpers-head', cwd: head, args: [...runner, ...helpers] },
  { name: 'related-head', cwd: head, args: [...runner, ...related] },
  { name: 'acceptance-head', cwd: head, args: [...runner, ...acceptance] },
  { name: 'slot-head', cwd: head, args: [path.join(evidence, 'direct-tests.mjs'), ...slot] });
// The requested native comparisons require the shared host slot. Script
// regressions use offline fixture slots, as in R-302, while that queue waits.
const scriptsOnly = process.argv.includes('--scripts-only');
if (scriptsOnly) jobs.splice(0, 4); else jobs.splice(4);
const outcomesFile = scriptsOnly ? 'script-outcomes.json' : 'outcomes.json';
const outcomes = [];
for (const job of jobs) {
  console.log(`START ${job.name}`);
  const log = fs.openSync(path.join(evidence, `${job.name}.tap`), 'w');
  const result = spawnSync(process.execPath, job.args, { cwd: job.cwd, env: process.env, stdio: ['ignore', log, log], timeout: 600000 });
  fs.closeSync(log);
  const output = fs.readFileSync(path.join(evidence, `${job.name}.tap`), 'utf8');
  const counts = Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|skipped|cancelled) (\d+)$/gm)].map(match => [match[1], Number(match[2])]));
  outcomes.push({ name: job.name, cwd: job.cwd, args: job.args, status: result.status, signal: result.signal, error: result.error?.message, counts });
  fs.writeFileSync(path.join(evidence, outcomesFile), JSON.stringify(outcomes, null, 2) + '\n');
  console.log(`END ${job.name} exit=${result.status} ${JSON.stringify(counts)}`);
}
process.exitCode = outcomes.some(job => job.status !== 0) ? 1 : 0;
