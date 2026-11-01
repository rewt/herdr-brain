// Source-verified successor reader admission, never effect authority.
// Frozen ab671e8986 and the G2 repair implement successor-reader/v1: exact
// original authority/history, UNKNOWN fences, stopped runtime admission and
// completed rollback clears. Retain reviewed fingerprints when canonical moves.
// Before changing writer effect/fence/history semantics, bump the corresponding
// requirement below. Never grant that new capability to retained old profiles.
// Unknown implementations need review and a new profile; never normalize or
// execute target code, or trust a target's own version/capability declaration.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readPlainFile} from '../lib/files.mjs';

const files = ["line-service/probation-successor.mjs", "line-service/probation-successor-history.mjs", "line-service/probation.mjs", "line-service/development-recovery.mjs", "line-service/runtime.mjs", "line-service/launchd.mjs"];
export const successorRequirements = () => ['successor-effect/v1', 'successor-fence/v1', 'successor-history/v1'];
// Independent of writer requirements: a requirement bump cannot upgrade readers.
const readerV1 = ['successor-effect/v1', 'successor-fence/v1', 'successor-history/v1'];
const capabilities = new Map(['ab671e8986', 'successor-g2', 'successor-recovery-admission', 'successor-host-recovery']
  .map(name => [name, new Set(readerV1)]));
const profiles = new Map([
  ['d5f0d5c88ba565b7e5b6896c2c4a5893d0b0fc73c1068eb3c7e163c7ae19c31b', 'ab671e8986'],
  ['49d9a296a02c4551328f684801e537a031f1b554be4725f08a39447fa0c38c81', 'successor-g2'],
  ['aa3c553b23399a6b73ad2338ae1856836b0e29f17cbdd586dc17eaabaecce207', 'successor-recovery-admission'],
  // 8cab40f1: owner-closure admission and host status changes preserve v1 archives.
  ['53f1a5a5371fd261c63eba58766e4ddce520853108b8025120e2002ee129e613', 'successor-host-recovery'],
]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function successorFingerprint(root) {
  let fingerprint;
  try {
    fingerprint = digest(JSON.stringify(files.map(file => [file, digest(readPlainFile(path.join(root, file)))])));
  } catch (cause) {
    throw Error(`successor-incompatible: unreadable successor-reader/v1 source at ${root}`, {cause});
  }
  return fingerprint;
}
export function requireSuccessorCapabilities(root) {
  const fingerprint = successorFingerprint(root), profile = profiles.get(fingerprint);
  if (!profile) throw Error(`successor-incompatible: unrecognized successor-reader/v1 source at ${root}; fingerprint=${fingerprint}`);
  const supported = capabilities.get(profile), required = successorRequirements();
  const missing = required.filter(contract => !supported?.has(contract));
  if (missing.length) throw Error(`successor-incompatible: profile ${profile} lacks ${missing.join(', ')} at ${root}; fingerprint=${fingerprint}`);
  return {root, profile, capability: 'successor-reader/v1', fingerprint, capabilities: [...supported], required};
}
export function successorCapabilityDiagnostic(root) {
  try { requireSuccessorCapabilities(root); return null; }
  catch (error) { return `successor-canonical-drift: ${error.message}; review source and register capabilities before cutting a candidate`; }
}
