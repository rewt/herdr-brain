import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Deterministic native file/cwd inventory, including the mandatory caller anchor.
// Every Git and fake-Herdr command still executes against the disposable repo.
export function sweepCommands(f, { before = () => {}, cwdReference = false } = {}) {
  const calls = [];
  const command = (exe, args, options) => {
    calls.push({ exe, args, locked: fs.existsSync(path.join(f.common, 'lane-promote.lock')) });
    before(exe, args, options);
    if (exe === '/usr/sbin/lsof') {
      const fd = args.includes('-Fpfn0') ? 'fcwd\0' : '';
      return { status: 0, stderr: '', stdout: `p${process.pid}\0${fd}n${f.repo}\0\n${cwdReference ? `p99999\0${fd}n${f.lane}\0\n` : ''}` };
    }
    return spawnSync(exe, args, options);
  };
  return { calls, command };
}
