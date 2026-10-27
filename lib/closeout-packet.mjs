// An owner-only preparation packet. No claim acquisition, recovery, process
// lookup, record mutation, native call or successor launch belongs here.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPlainFile, plainDirectory } from './files.mjs';
import { closeoutCodeIdentity, readCloseoutOwnerStatus } from './closeout-code.mjs';
import { readCloseoutEntries } from './closeout.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const declaration = path.relative(root, fileURLToPath(new URL('../supervisor/closeout-capabilities.json', import.meta.url)));
const required = ['named_sessions', 'zero_elapsed_budget', 'owner_status_read_only',
  'handoff_packet_read_only', 'shared_retirement_owner'];

export function readCloseoutCapabilities(codeRoot = root) {
  const identity = closeoutCodeIdentity(codeRoot, { verifyFiles: true });
  let bytes;
  try { bytes = readPlainFile(path.join(identity.root, declaration), null); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const capabilities = bytes ? JSON.parse(bytes) : null;
  if (JSON.stringify(identity) !== JSON.stringify(closeoutCodeIdentity(codeRoot, { verifyFiles: true })))
    throw Error('candidate code changed during capability observation');
  const supported = capabilities?.schema === 'closeout-capabilities/v1' && required.every(k => capabilities[k] === true);
  return { identity, capabilities, supported, declaration_sha256: bytes ? sha(bytes) : null,
    reason: supported ? 'verified code declares the shared named two-phase protocol; no native acceptance asserted'
      : 'code does not declare the shared named two-phase protocol; do not send it newer drain options' };
}

function originalKeys(original) {
  const claim = original?.claims?.consumer, owner = claim?.owner;
  if (original?.schema !== 'closeout-owner-status/v1' || claim?.state !== 'stored' ||
      !Number.isSafeInteger(owner?.pid) || owner.pid < 1 || typeof owner.identity !== 'string' || !owner.identity.trim() ||
      typeof owner.token !== 'string' || !owner.token.trim() ||
      !Array.isArray(owner.argv) || !owner.argv.every(a => typeof a === 'string'))
    throw Error('retained original consumer identity/kernel birth/token/command is required');
  const argv = owner.argv, index = argv.indexOf('--keys');
  if (!argv.includes('drain') || index < 0 || argv.lastIndexOf('--keys') !== index)
    throw Error('original drain must have one exact named key set');
  const keys = JSON.parse(argv[index + 1]);
  if (!Array.isArray(keys) || !keys.length || keys.some(k => !/^[a-f0-9]{64}$/.test(k)) || new Set(keys).size !== keys.length)
    throw Error('original drain keys are invalid or ambiguous');
  return keys;
}

function queueBytes(common) {
  const directory = path.join(common, 'closeout/entries');
  plainDirectory(directory, { create: false });
  return fs.readdirSync(directory).filter(n => n.endsWith('.json')).sort().map(name => {
    const bytes = readPlainFile(path.join(directory, name), null);
    return { name, bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') };
  });
}

export function prepareCloseoutPacket({ cwd, org, originalFile, candidateRoot, env = process.env } = {}) {
  if (!originalFile || !candidateRoot) throw Error('packet requires retained --original status and explicit --candidate code root');
  const originalBytes = readPlainFile(originalFile, null), original = JSON.parse(originalBytes), keys = originalKeys(original);
  const current = readCloseoutOwnerStatus({ cwd, org, env });
  if (['project', 'identity', 'org'].some(k => original[k] !== current[k]))
    throw Error('original owner snapshot belongs to a different project/record');
  const queue = queueBytes(current.identity), entries = readCloseoutEntries(current.identity, { keys });
  if (entries.length !== keys.length || entries.some(e => e.project !== current.project || e.org !== current.org))
    throw Error('every original named key must have a retained project/record envelope; no partial handoff');
  const candidate = readCloseoutCapabilities(candidateRoot);
  const after = readCloseoutOwnerStatus({ cwd, org, env });
  if (JSON.stringify(current.claims) !== JSON.stringify(after.claims) ||
      JSON.stringify(queue) !== JSON.stringify(queueBytes(current.identity)) ||
      !originalBytes.equals(readPlainFile(originalFile, null)))
    throw Error('owner, queue or original snapshot changed during packet observation; keep');
  const args = ['drain', '--repo', current.project, '--org', current.org, '--keys', JSON.stringify(keys),
    '--retry-safe', '--no-restart', '--deadline', '0'];
  return { schema: 'closeout-owner-packet/v1', observed_at: after.observed_at,
    project: current.project, identity: current.identity, org: current.org, keys,
    original: { snapshot_sha256: sha(originalBytes), base64: originalBytes.toString('base64'), claims: original.claims },
    current_claims: after.claims, queue, candidate,
    source_safety: 'queue bytes are preserved, not migrated or authorized; the executor must freshly verify original source/handoff, native identities, callbacks, STOP/HOLD and archives; v1 needs the existing named migration',
    original_outcome: 'UNKNOWN', original_release: 'UNKNOWN', effects: 0, effects_authorized: false,
    blockers: ['original command terminal/outcome and exact consumer/queue/retirement claim release remain unproved; later owners or absent claims are not proof',
      ...(!candidate.supported ? [candidate.reason] : [])],
    phases: candidate.supported ? [
      { phase: 'sessions', argv: [path.join(candidate.identity.root, 'supervisor/closeout.mjs'), ...args, '--sessions-only'],
        expected: 'sessions_retired may be true; completed remains false; physical requests remain queued' },
      { phase: 'physical', argv: [path.join(candidate.identity.root, 'supervisor/closeout.mjs'), ...args],
        expected: 'fresh guarded evaluation; completed only after actual physical cleanup' },
    ] : [],
    authority: 'preparation only; actual project owner must prove the original outcome/release, adopt verified code through existing release rules, and freshly guard each phase; never force a successor or replay an unknown native intent' };
}
