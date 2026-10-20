import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const TEST_SLOT_PATH = process.platform === 'darwin' ? '/private/tmp/bch-cloak-test-slot.lock' : '/tmp/bch-cloak-test-slot.lock';
export const PATH_ENV = 'MONITOR_TEST_SLOT_PATH';
export const COMPAT_PATH_ENV = 'MONITOR_TEST_SLOT_COMPAT_PATH';
export const LOCK_PATH_INVALID_CODE = 'TEST_SLOT_LOCK_PATH_INVALID';
export const proverPaths = () => [
  `/private/tmp/apnt-gnark-r2-proof-${process.getuid()}.lock`,
  '/private/tmp/bch-cloak-sp1-prover-exclusive-v1', path.join(os.homedir(), 'proof-scratch/.prover.lock'),
];
const invalid = () => Object.assign(Error(`${LOCK_PATH_INVALID_CODE}: lock must be a regular, non-prover path; non-default compat must be in private temporary scratch`), { code: LOCK_PATH_INVALID_CODE });

let nativeTemporaryRoot;
function userTemporaryRoot() {
  if (process.platform !== 'darwin') return null;
  if (nativeTemporaryRoot !== undefined) return nativeTemporaryRoot;
  nativeTemporaryRoot = null;
  try {
    // Exact validation can omit TMPDIR. Ask the OS for this uid's temporary
    // root instead of inferring authority from the supplied lock pathname.
    const directory = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1000, maxBuffer: 4096,
    }).trim();
    if (!path.isAbsolute(directory)) return null;
    const root = fs.realpathSync(directory), stat = fs.statSync(root);
    if (stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077)) nativeTemporaryRoot = root;
  } catch { /* An unavailable OS source grants no additional scratch root. */ }
  return nativeTemporaryRoot;
}

function privateScratch(parent, root, uid) {
  if (!root || !parent.startsWith(root + path.sep)) return false;
  // Every ancestor below tmp must also exclude replacement by another uid.
  for (let dir = parent; dir !== root; dir = path.dirname(dir)) {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022)) return false;
  }
  return true;
}

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
      const parent = fs.realpathSync(path.dirname(file)), root = fs.realpathSync(tmpdir);
      if (!privateScratch(parent, root, uid) && !privateScratch(parent, userTemporaryRoot(), uid)) throw invalid();
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
