import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_SLOT_PATH = process.platform === 'darwin' ? '/private/tmp/bch-cloak-test-slot.lock' : '/tmp/bch-cloak-test-slot.lock';
export const PATH_ENV = 'MONITOR_TEST_SLOT_PATH';
export const COMPAT_PATH_ENV = 'MONITOR_TEST_SLOT_COMPAT_PATH';
export const LOCK_PATH_INVALID_CODE = 'TEST_SLOT_LOCK_PATH_INVALID';
export const proverPaths = () => [
  `/private/tmp/apnt-gnark-r2-proof-${process.getuid()}.lock`,
  '/private/tmp/bch-cloak-sp1-prover-exclusive-v1', path.join(os.homedir(), 'proof-scratch/.prover.lock'),
];
const invalid = () => Object.assign(Error(`${LOCK_PATH_INVALID_CODE}: lock must be a regular, non-prover path; non-default compat must be in private temporary scratch`), { code: LOCK_PATH_INVALID_CODE });

export function validateSlotPath(file, { compat = false, provers = proverPaths(), tmpdir = os.tmpdir(), uid = process.getuid() } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || file.endsWith('/')) throw invalid();
  if (/^apnt-gnark-r2-proof-[0-9]+\.lock$/.test(path.basename(file)) ||
      ['bch-cloak-sp1-prover-exclusive-v1', '.prover.lock'].includes(path.basename(file))) throw invalid();
  try {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw invalid();
    for (const prover of provers) {
      if (path.resolve(file) === path.resolve(prover)) throw invalid();
      let reserved;
      try { reserved = fs.statSync(prover); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat && reserved && stat.dev === reserved.dev && stat.ino === reserved.ino) throw invalid();
    }
    if (compat && file !== TEST_SLOT_PATH) {
      const parent = fs.realpathSync(path.dirname(file)), root = fs.realpathSync(tmpdir), stat = fs.statSync(parent);
      if (!parent.startsWith(root + path.sep) || stat.uid !== uid || (stat.mode & 0o022) !== 0) throw invalid();
      // Every ancestor below tmp must also exclude replacement by another uid.
      for (let dir = parent; dir !== root; dir = path.dirname(dir)) {
        const ancestor = fs.statSync(dir);
        if (ancestor.uid !== uid || (ancestor.mode & 0o022) !== 0) throw invalid();
      }
    }
  } catch { throw invalid(); }
  return file;
}

export function slotPathOf(env = process.env, options = {}) {
  const file = env[PATH_ENV] ?? TEST_SLOT_PATH;
  return options.readOnly ? file : validateSlotPath(file, options);
}

// Readers observe configured locations without granting them writer authority.
export function occupancyPaths(env = process.env, paths = [env[PATH_ENV] ?? TEST_SLOT_PATH, env[COMPAT_PATH_ENV] ?? TEST_SLOT_PATH]) {
  const seen = new Set();
  return paths.filter(file => {
    let identity;
    try { identity = fs.realpathSync(`${file}.occupancy`); } catch { identity = path.resolve(`${file}.occupancy`); }
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  });
}
