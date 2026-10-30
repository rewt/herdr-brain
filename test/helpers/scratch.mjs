// Attempt-local scratch ownership. The journal and recovery receipts are durable
// evidence, never scratch. No directory scan or PID/name based reaper is used.
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { lookupProcess } from '../../lib/processes.mjs';

export const SCRATCH_JOURNAL = 'HERDR_TEST_SCRATCH_JOURNAL';
export const evidenceDirectory = prefix => fs.realpathSync(nativeMkdtemp(prefix));
const nativeMkdtemp = fs.mkdtempSync;
let installed = false, owner;
const stamp = directory => {
  const stat = fs.lstatSync(directory, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs), directory: stat.isDirectory() && !stat.isSymbolicLink() };
};
const samePath = (record, current) => current.directory && ['dev', 'ino', 'birth'].every(key => record[key] === current[key]);

export function installScratchTracking() {
  if (installed || !process.env[SCRATCH_JOURNAL]) return;
  installed = true;
  fs.mkdtempSync = function (...args) {
    const directory = nativeMkdtemp.apply(this, args);
    if (!owner) {
      const result = lookupProcess(process.pid);
      if (!result.ok || !result.value) throw Error(`scratch owner lookup failed: ${result.error}`);
      owner = result.value;
    }
    const root = fs.realpathSync(directory);
    fs.appendFileSync(process.env[SCRATCH_JOURNAL], JSON.stringify({ schema: 'test-scratch/v1',
      id: randomUUID(), root, ...stamp(root), owner }) + '\n', { mode: 0o600 });
    return directory;
  };
  syncBuiltinESMExports();
}

export function recoverScratch(journal, { joined, suite, snapshot = lookupProcess } = {}) {
  const records = fs.readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const observed = snapshot();
  const results = [];
  for (const record of records) {
    let status = 'retained', reason;
    try {
      if (record.schema !== 'test-scratch/v1' || !path.isAbsolute(record.root) || !record.owner?.identity)
        throw Error('incomplete registration');
      const current = observed.ok && observed.value.get(record.owner.pid);
      if (!joined || !suite || record.owner.pgid !== suite.pid) reason = 'no joined owning group';
      else if (!observed.ok) reason = 'native lookup unavailable';
      else if (current && current.identity !== record.owner.identity) reason = 'PID reused';
      else if (current && !/^Z/.test(current.state)) reason = 'owner still live';
      else if ([...observed.value.values()].some(row => row.pgid === suite.pid && !/^Z/.test(row.state))) reason = 'group still live';
      else {
        // realpath also detects substituted ancestors. Never follow a changed
        // root or symlink into another fixture, even after native owner exit.
        if (fs.realpathSync(record.root) !== record.root || !samePath(record, stamp(record.root))) reason = 'path identity changed';
        else { fs.rmSync(record.root, { recursive: true }); status = 'removed'; }
      }
    } catch (error) {
      if (error.code === 'ENOENT') status = 'absent';
      else reason = error.message;
    }
    results.push({ ...record, status, ...(reason ? { reason } : {}) });
  }
  return { schema: 'test-scratch-recovery/v1', suite, joined: Boolean(joined), created: records.length,
    removed: results.filter(row => row.status === 'removed').length,
    absent: results.filter(row => row.status === 'absent').length,
    retained: results.filter(row => row.status === 'retained').length, results };
}
