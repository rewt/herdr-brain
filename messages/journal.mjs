import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canonical, digest, parseJSON, validateEvent, MAX_EVENT_BYTES } from './schema.mjs';
import { classify, PATHS } from './classify.mjs';

export function stateDirectory({ identity, commonDir, root = process.env.BRAIN_SHADOW_ROOT || path.join(os.homedir(), '.local/state/herdr-brain/logs') }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(identity ?? '') || !path.isAbsolute(commonDir ?? '') || path.normalize(commonDir) !== commonDir) throw Error('shadow partition needs identity and canonical commonDir');
  return path.join(path.resolve(root), identity, digest(commonDir));
}
export async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error(`shadow directory is not private: ${directory}`);
  return fs.realpath(directory);
}
const producerKey = event => canonical([event.producer.id, event.producer.epoch, event.producer.sequence]);
function content(event) {
  const { cursor, receivedAt, stream, shadow, ...input } = event;
  return canonical(input);
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

export class ShadowJournal {
  constructor({ identity, commonDir, root }) {
    this.identity = identity; this.commonDir = commonDir;
    this.directory = stateDirectory({ identity, commonDir, root });
  }
  async append(input) {
    // Take an immutable JSON snapshot before any asynchronous filesystem work.
    validateEvent(input);
    const event = JSON.parse(canonical(input));
    if (event.identity !== this.identity || event.project.commonDir !== this.commonDir) throw Error('shadow partition scope mismatch');
    if (event.cursor || event.receivedAt || event.stream || event.shadow) throw Error('shadow writer owns cursor, receivedAt, stream and classification');
    const directory = await privateDirectory(this.directory);
    if (await fs.realpath(this.commonDir) !== this.commonDir) throw Error('noncanonical project commonDir');
    // Fail immediately on contention. Shadow work never waits on delivery or
    // steals an unknown/stale lock. Inspect a crash-left lock before removal.
    const lockFile = path.join(directory, 'writer.lock');
    let lock;
    try { lock = await fs.open(lockFile, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw Error('shadow writer locked; mirror skipped'); throw error; }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
      const { entries, tornTail } = await readJournal(directory);
      if (tornTail) throw Error('torn shadow tail preserved; explicit repair/rotation required before append');
      const accepted = entries.filter(entry => entry.shadow.disposition === 'accepted');
      const prior = accepted.find(entry => entry.eventId === event.eventId || producerKey(entry) === producerKey(event));
      const disposition = !prior ? 'accepted' : prior.eventId === event.eventId && content(prior) === content(event) ? 'duplicate' : 'conflict';
      const entry = { ...event, stream: `${this.identity}/${digest(this.commonDir)}`,
        cursor: { epoch: 'shadow-1', sequence: entries.length + 1 }, receivedAt: new Date().toISOString(),
        shadow: { ...classify(event), disposition, ...(prior ? { originalCursor: prior.cursor, originalEventId: prior.eventId } : {}) } };
      const { shadow, ...storedEvent } = entry;
      validateEvent(storedEvent);
      const handle = await fs.open(path.join(directory, 'shadow.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o077)) throw Error('shadow journal is not a private regular file');
        await handle.writeFile(JSON.stringify(entry) + '\n'); await handle.sync();
      } finally { await handle.close(); }
      // Persist directory entries too, before reporting shadow acceptance.
      const dir = await fs.open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      if (disposition === 'conflict') throw Error(`conflicting shadow event id or producer key: ${event.eventId}`);
      return { disposition, cursor: prior?.cursor ?? entry.cursor, entry };
    } finally { await lock.close(); await fs.unlink(lockFile); }
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
