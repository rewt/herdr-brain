// Attempt-local scratch ownership. The journal and recovery receipts are durable
// evidence, never scratch. No directory scan or PID/name based reaper is used.
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
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

// A recursive unlink is not transactional: EACCES can arrive after siblings
// have gone. Checkpoint the complete tree outside scratch before the first
// unlink, and retain that verified copy on any removal failure. Reflinks avoid
// duplicating file blocks where the filesystem supports them.
function fingerprint(root) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  const visit = (file, name) => {
    const stat = fs.lstatSync(file);
    const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
    if (!type) throw Error(`unsupported scratch entry: ${file}`);
    hash.update(JSON.stringify([name, type, stat.mode & 0o7777, type === 'file' ? stat.size : null]));
    if (type === 'link') hash.update(JSON.stringify(fs.readlinkSync(file)));
    else if (type === 'directory') for (const child of fs.readdirSync(file).sort()) visit(path.join(file, child), path.join(name, child));
    else {
      const fd = fs.openSync(file, 'r');
      try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size)); }
      finally { fs.closeSync(fd); }
    }
  };
  visit(root, '.');
  return hash.digest('hex');
}

function checkpoint(row, journal) {
  const evidence = fs.realpathSync(path.dirname(journal));
  if (evidence === row.root || evidence.startsWith(row.root + path.sep)) throw Error('scratch contains its recovery evidence');
  const directory = evidenceDirectory(path.join(evidence, 'preserved-'));
  const copy = path.join(directory, 'tree');
  row.preservation = { directory, root: copy, verified: false };
  const before = fingerprint(row.root);
  fs.cpSync(row.root, copy, { recursive: true, dereference: false, verbatimSymlinks: true,
    preserveTimestamps: true, mode: fs.constants.COPYFILE_FICLONE, force: false, errorOnExist: true });
  if (fingerprint(copy) !== before || fingerprint(row.root) !== before || !samePath(row, stamp(row.root)))
    throw Error('scratch changed during preservation');
  row.preservation = { ...row.preservation, verified: true, sha256: before };
  fs.writeFileSync(path.join(directory, 'preservation.json'), JSON.stringify({
    schema: 'test-scratch-preservation/v1', journal, source: row, at: new Date().toISOString(),
  }) + '\n', { flag: 'wx', mode: 0o600 });
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
      if (fs.realpathSync(record.root) !== record.root || !samePath(record, stamp(record.root))) reason = 'path identity changed';
      else if (!joined || !Number.isSafeInteger(suite?.pid) || suite.pid <= 1 || record.owner.pgid !== suite.pid) reason = 'no joined owning group';
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
  const overlapsRetained = file => protectedRoots.some(root => root === file || root.startsWith(file + path.sep) || file.startsWith(root + path.sep));
  // Preserve every eligible registration before deleting any nested tree.
  // Otherwise an ancestor's later checkpoint could already be missing evidence.
  for (const row of results.filter(row => row.status === 'eligible')) {
    try {
      if (overlapsRetained(row.root)) throw Error('contains retained scratch');
      checkpoint(row, journal);
    } catch (error) {
      row.status = 'retained'; row.retention = 'unknown'; row.reason = error.message === 'contains retained scratch'
        ? error.message : `preservation refused; source untouched: ${error.message}`;
      protectedRoots.push(row.root);
    }
  }
  for (const row of results.filter(row => row.status === 'eligible').sort((a, b) => b.root.length - a.root.length)) {
    try {
      if (overlapsRetained(row.root)) {
        row.reason = 'contains retained scratch';
      } else if (fs.realpathSync(row.root) !== row.root || !samePath(row, stamp(row.root))) {
        row.reason = 'path identity changed';
      } else { fs.rmSync(row.root, { recursive: true }); row.status = 'removed'; }
    } catch (error) {
      // ENOENT during recursion is not proof that the whole root is absent.
      row.reason = `removal failed; whole evidence preserved at ${row.preservation.root}: ${error.message}`;
    }
    if (row.status === 'removed') {
      try { fs.rmSync(row.preservation.directory, { recursive: true }); delete row.preservation; }
      catch (error) { row.preservation.cleanup_error = error.message; }
      continue;
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
