// Offline reproduction: three batches, each with six concurrent lesson suites.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const directory = import.meta.dirname;
const repo = path.resolve(directory, '../../..');
const command = ['test/helpers/run.mjs', 'acceptance/test/lessons.test.mjs'];
const summary = { command: `node ${command.join(' ')}`, parallelCopies: 6, rounds: [] };
for (let round = 1; round <= 3; round++) {
  const started = new Date().toISOString(), load = os.loadavg();
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise(resolve => {
    const copy = index + 1, log = `round-${round}-copy-${copy}.tap`;
    const fd = fs.openSync(path.join(directory, log), 'w');
    const child = spawn(process.execPath, command, { cwd: repo, stdio: ['ignore', fd, fd] });
    child.once('error', error => fs.writeSync(fd, `${error.stack}\n`));
    child.once('close', (code, signal) => {
      fs.closeSync(fd);
      const tap = fs.readFileSync(path.join(directory, log), 'utf8');
      const count = name => Number(tap.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN);
      resolve({ copy, log, code, signal, tests: count('tests'), pass: count('pass'),
        fail: count('fail'), skipped: count('skipped'), cancelled: count('cancelled') });
    });
  })));
  const green = results.every(r => r.code === 0 && r.signal === null && r.tests === 13 &&
    r.pass === 13 && r.fail === 0 && r.skipped === 0 && r.cancelled === 0);
  summary.rounds.push({ round, started, finished: new Date().toISOString(), load, green, results });
  fs.writeFileSync(path.join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Round ${round}: ${results.filter(r => r.code === 0).length}/6 suites exited zero; ${results.reduce((n, r) => n + r.pass, 0)} passed; green=${green}`);
  if (!green) { process.exitCode = 1; break; }
}
