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

function probeGroup(pid) {
  if (process.platform === 'win32') return { ok: false, error: 'group probe unavailable' };
  try { process.kill(-pid, 0); return { ok: true, absent: false }; }
  catch (error) {
    return error.code === 'ESRCH' ? { ok: true, absent: true } : { ok: false, error: error.message };
  }
}

export function recoverScratch(journal, { joined, suite, lookup = lookupProcess, groupProbe = probeGroup } = {}) {
  const records = fs.readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  // A missing group is an absence proof, never authority to signal a historical
  // PGID. Targeted birth lookups also protect owners that left the original
  // group. Neither proof needs a system-wide process inventory (or ps).
  const owners = new Map();
  let group;
  const observe = (read, key) => {
    try { return read(key); }
    catch (error) { return { ok: false, error: error.message }; }
  };
  const results = [];
  for (const record of records) {
    let status = 'retained', reason, retention = 'unknown';
    try {
      if (record.schema !== 'test-scratch/v1' || !path.isAbsolute(record.root) || !record.owner?.identity)
        throw Error('incomplete registration');
      if (!joined || !Number.isSafeInteger(suite?.pid) || suite.pid <= 1 || record.owner.pgid !== suite.pid) reason = 'no joined owning group';
      else {
        if (!owners.has(record.owner.pid)) owners.set(record.owner.pid, observe(lookup, record.owner.pid));
        const observed = owners.get(record.owner.pid), current = observed?.value;
        if (!observed?.ok) reason = 'native owner lookup unavailable';
        else if (current !== null && (!current || current.pid !== record.owner.pid || !current.identity || !current.state)) reason = 'incomplete owner lookup';
        else if (current && current.identity !== record.owner.identity) reason = 'PID reused';
        else if (current && !/^Z/.test(current.state)) { reason = 'owner still live'; retention = 'live'; }
        else {
          group ??= observe(groupProbe, suite.pid);
          if (!group?.ok) reason = 'group lookup unavailable';
          else if (group.absent !== true) reason = 'group still present or reused';
          // realpath also detects substituted ancestors. Never follow a changed
          // root or symlink into another fixture, even after native owner exit.
          else if (fs.realpathSync(record.root) !== record.root || !samePath(record, stamp(record.root))) reason = 'path identity changed';
          else status = 'eligible';
        }
      }
    } catch (error) {
      if (error.code === 'ENOENT') status = 'absent';
      else reason = error.message;
    }
    results.push({ ...record, status, ...(reason ? { reason } : {}), ...(status === 'retained' ? { retention } : {}) });
  }
  // Classify every registration before removing ancestors. An escaped live
  // owner or an unknown nested root must survive another owner's recursive rm.
  const protectedRoots = results.filter(row => row.status === 'retained' && path.isAbsolute(row.root ?? '')).map(row => row.root);
  for (const row of results.filter(row => row.status === 'eligible').sort((a, b) => b.root.length - a.root.length)) {
    try {
      if (protectedRoots.some(root => root === row.root || root.startsWith(row.root + path.sep))) {
        row.reason = 'contains retained scratch';
      } else if (fs.realpathSync(row.root) !== row.root || !samePath(row, stamp(row.root))) {
        row.reason = 'path identity changed';
      } else { fs.rmSync(row.root, { recursive: true }); row.status = 'removed'; continue; }
    } catch (error) {
      if (error.code === 'ENOENT') { row.status = 'absent'; continue; }
      row.reason = error.message;
    }
    row.status = 'retained'; row.retention = 'unknown'; protectedRoots.push(row.root);
  }
  return { schema: 'test-scratch-recovery/v1', suite, joined: Boolean(joined), created: records.length,
    removed: results.filter(row => row.status === 'removed').length,
    absent: results.filter(row => row.status === 'absent').length,
    retained: results.filter(row => row.status === 'retained').length,
    retained_live: results.filter(row => row.status === 'retained' && row.retention === 'live').length,
    retained_unknown: results.filter(row => row.status === 'retained' && row.retention === 'unknown').length, results };
}
