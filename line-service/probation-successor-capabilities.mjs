// Source-verified successor reader admission, never effect authority.
// Frozen ab671e8986 and the G2 repair implement successor-reader/v1: exact
// original authority/history, UNKNOWN fences, stopped runtime admission and
// completed rollback clears. Retain reviewed fingerprints when canonical moves.
// Unknown implementations need review and a new profile; never normalize or
// execute target code, or trust a target's own version/capability declaration.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readPlainFile} from '../lib/files.mjs';

const files = ["line-service/probation-successor.mjs", "line-service/probation-successor-history.mjs", "line-service/probation.mjs", "line-service/development-recovery.mjs", "line-service/runtime.mjs", "line-service/launchd.mjs"];
const profiles = new Map([
  ['d5f0d5c88ba565b7e5b6896c2c4a5893d0b0fc73c1068eb3c7e163c7ae19c31b', 'ab671e8986'],
  ['49d9a296a02c4551328f684801e537a031f1b554be4725f08a39447fa0c38c81', 'successor-g2'],
]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function requireSuccessorCapabilities(root) {
  let fingerprint;
  try {
    fingerprint = digest(JSON.stringify(files.map(file => [file, digest(readPlainFile(path.join(root, file)))])));
  } catch (cause) {
    throw Error(`successor-incompatible: unreadable successor-reader/v1 source at ${root}`, {cause});
  }
  const profile = profiles.get(fingerprint);
  if (!profile) throw Error(`successor-incompatible: unrecognized successor-reader/v1 source at ${root}`);
  return {root, profile, capability: 'successor-reader/v1', fingerprint};
}
