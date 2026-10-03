// Native inputs for offline lifecycle tests. Tests may change an owned file to
// simulate pressure; product code never branches on fixture metadata.
import fs from 'node:fs';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const originalRead = fs.readFileSync;
const measurement = () => process.env.TEST_MEMORY_FILE
  ? JSON.parse(originalRead(process.env.TEST_MEMORY_FILE, 'utf8'))
  : { available: 8 * 1024 ** 3, swap_used: 0 };
const total = 16 * 1024 ** 3;
const swapTotal = 4 * 1024 ** 3;
os.totalmem = () => total;
os.freemem = () => measurement().available;
fs.readFileSync = function (file, ...args) {
  if (file === '/proc/meminfo') {
    const m = measurement();
    return `MemTotal: ${total / 1024} kB\nMemAvailable: ${m.available / 1024} kB\nSwapTotal: ${swapTotal / 1024} kB\nSwapFree: ${(swapTotal - m.swap_used) / 1024} kB\n`;
  }
  return originalRead.call(this, file, ...args);
};
const originalSpawn = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, ...rest) {
  if (command === 'vm_stat') {
    const pages = Math.floor(measurement().available / 16384);
    return { status: 0, stdout: `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: ${pages}.\nPages inactive: 0.\nPages speculative: 0.\n`, stderr: '' };
  }
  if (command === 'sysctl' && args?.join(' ') === '-n vm.swapusage')
    return { status: 0, stdout: `used = ${measurement().swap_used / 1024}K\n`, stderr: '' };
  return originalSpawn.call(this, command, args, ...rest);
};
syncBuiltinESMExports();
