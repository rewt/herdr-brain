import fs from 'node:fs/promises';
import { constants, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { digest, parseJSON, validateEvent, MAX_EVENT_BYTES } from './schema.mjs';
import { PATHS } from './classify.mjs';

export function identityRootAt(commonDir) {
  for (let directory = commonDir; ; directory = path.dirname(directory)) {
    let marker;
    try { marker = lstatSync(path.join(directory, '.identity-root')); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    if (marker) {
      if (!marker.isFile() || marker.isSymbolicLink() || realpathSync(directory) !== directory) throw Error('shadow identity root needs a regular marker and canonical directory');
      return directory;
    }
    if (directory === path.dirname(directory)) return null;
  }
}

// Check existing storage components before recursive mkdir or report reads can
// follow them. Missing components will be created privately by the writer.
function privatePath(root, directory) {
  const relative = path.relative(root, directory);
  let current = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory()) {
      if (stat.isSymbolicLink()) throw Error(`shadow directory is a symlink: ${current}`);
      throw Object.assign(Error(`shadow path is not a directory: ${current}`), { code: 'ENOTDIR' });
    }
    if (stat.mode & 0o077) throw Error(`shadow directory is not private: ${current}`);
  }
}

function partitionLocation({ identity, commonDir, root, env = process.env }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(identity ?? '') || !path.isAbsolute(commonDir ?? '') || path.normalize(commonDir) !== commonDir) throw Error('shadow partition needs identity and canonical commonDir');
  root ??= env.BRAIN_SHADOW_ROOT || undefined;
  let storageRoot;
  if (root === undefined) {
    const identityRoot = identityRootAt(commonDir);
    if (identityRoot) { storageRoot = path.join(identityRoot, '.herdr-brain'); root = path.join(storageRoot, 'logs'); }
    else root = path.join(env.HOME || os.homedir(), '.local/state/herdr-brain/logs');
  }
  root = path.resolve(root);
  const directory = path.join(root, identity, digest(commonDir));
  privatePath(storageRoot ?? root, directory);
  return { directory, storageRoot: storageRoot ?? root };
}
export function stateDirectory(options) { return partitionLocation(options).directory; }
export async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error(`shadow directory is not private: ${directory}`);
  return fs.realpath(directory);
}
export async function readJournal(directory) {
  let bytes, handle;
  try {
    handle = await fs.open(path.join(directory, 'shadow.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077)) throw Error('shadow journal is not a private regular file');
    bytes = await handle.readFile();
  }
  catch (error) { if (error.code === 'ENOENT') return { entries: [], tornTail: null }; throw error; }
  finally { await handle?.close(); }
  const end = bytes.lastIndexOf(10) + 1;
  const tail = bytes.subarray(end);
  const entries = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)).split('\n').map((line, i, lines) => {
    if (i === lines.length - 1 && line === '') return null;
    try {
      const entry = parseJSON(line, MAX_EVENT_BYTES + 2048);
      const { shadow, ...event } = entry;
      validateEvent(event);
      if (!shadow || !PATHS.includes(shadow.path) || !['accepted', 'duplicate', 'conflict'].includes(shadow.disposition) || ![true, false, null].includes(shadow.wouldWake) || typeof shadow.reason !== 'string') throw Error('invalid shadow metadata');
      return entry;
    } catch (error) { throw Error(`corrupt shadow journal line ${i + 1}: ${error.message}`); }
  }).filter(Boolean);
  return { entries, tornTail: tail.length ? { bytes: tail.length, sha256: digest(tail) } : null };
}

// Shared private partition checks; historical shadow data is read-only.
export class JournalScope {
  constructor({ identity, commonDir, root, env }) {
    this.identity = identity; this.commonDir = commonDir;
    Object.assign(this, partitionLocation({ identity, commonDir, root, env }));
  }
  async prepareDirectory() {
    privatePath(this.storageRoot, this.directory);
    return privateDirectory(this.directory);
  }

}

export function report({ entries, tornTail }, { since } = {}) {
  if (since !== undefined && (!Number.isFinite(Date.parse(since)) || !since.endsWith('Z'))) throw Error('--since must be a UTC timestamp');
  const selected = entries.filter(entry => since === undefined || Date.parse(entry.receivedAt) >= Date.parse(since));
  const result = { schema: 'brain.shadow-report/v1', since: since ?? null, observations: selected.length, accepted: 0,
    byKind: Object.fromEntries(['request', 'reply', 'decision', 'fyi', 'hold', 'release', 'notice', 'question', 'ack', 'non-message'].map(kind => [kind, 0])),
    byPath: Object.fromEntries(PATHS.map(key => [key, 0])), wouldWake: { yes: 0, no: 0, unknown: 0 },
    duplicates: 0, conflicts: 0, duplicateIds: [], conflictingIds: [], unknownIds: [], tornTail };
  for (const entry of selected) {
    const { disposition, path: route, wouldWake } = entry.shadow;
    if (disposition !== 'accepted') {
      result[disposition === 'duplicate' ? 'duplicates' : 'conflicts']++;
      result[disposition === 'duplicate' ? 'duplicateIds' : 'conflictingIds'].push(entry.eventId);
      if (disposition === 'conflict' && entry.shadow.originalEventId) result.conflictingIds.push(entry.shadow.originalEventId);
      continue;
    }
    result.accepted++;
    result.byKind[entry.type === 'session.message.v1' ? entry.payload.kind : 'non-message']++;
    result.byPath[route]++;
    result.wouldWake[wouldWake === null ? 'unknown' : wouldWake ? 'yes' : 'no']++;
    if (route === 'unknown') result.unknownIds.push(entry.eventId);
  }
  for (const key of ['duplicateIds', 'conflictingIds', 'unknownIds']) result[key] = [...new Set(result[key])].sort();
  return result;
}
