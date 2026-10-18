// Immutable handoff bytes plus one append-only event; no lifecycle actions.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { UserError } from './store.mjs';

export const HANDOFF_SECTIONS = [
  'In-flight work', 'Background jobs and how to re-arm each',
  'Decisions not yet recorded', 'Peers and addresses', 'First steps',
];
export const handoffKey = (workspace, slot) => JSON.stringify([workspace, slot]);
export const handoffDigest = bytes => createHash('sha256').update(bytes).digest('hex');

// Derive slot continuity directly from record events, outside the core fold.
// Sequence is authoritative even when clocks move backward or input is reordered.
export function recordedHandoffs(events) {
  const handoffs = new Map();
  for (const event of events) if (event.type === 'handoff.recorded') {
    const key = handoffKey(event.workspace, event.slot), previous = handoffs.get(key);
    if (!previous || event.seq > previous.seq) handoffs.set(key, { ...event });
  }
  return handoffs;
}

export function handoffScope(workspace, slot) {
  for (const [name, value] of Object.entries({ workspace, slot })) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value))
      throw new UserError(`${name} must be a single identifier (letters, numbers, dot, underscore, colon or dash)`);
  }
}

export function missingHandoffSections(text) {
  // Headings inside fenced examples do not satisfy the check.
  let fence = null;
  const headings = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading) headings.add(heading.toLowerCase());
  }
  return HANDOFF_SECTIONS.filter(title => !headings.has(title.toLowerCase()));
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function directory(parent, name) {
  const target = path.join(parent, name);
  try { fs.mkdirSync(target); syncDirectory(parent); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!fs.lstatSync(target).isDirectory()) throw new UserError(`handoff directory is not a plain directory: ${target}`);
  return target;
}

// Called ONLY within the record transaction. A crash before the event may leave
// an unrecorded file; it is never selected by readers or overwritten on retry.
export function prepareHandoff(org, events, { workspace, slot, bytes, author, at }) {
  handoffScope(workspace, slot);
  if (typeof author !== 'string' || !author.trim()) throw new UserError('handoff author is required');
  let target = fs.realpathSync(org);
  for (const part of ['handoffs', workspace, slot]) target = directory(target, part);
  let stamp = at.getTime();
  // Timestamp filenames stay monotonic per slot even with a frozen/backward
  // clock. Event sequence, not filename ordering, determines the latest entry.
  const recorded = new Set();
  for (const event of events) if (event.type === 'handoff.recorded' && event.workspace === workspace && event.slot === slot) {
    recorded.add(event.path);
    const previous = Date.parse(path.basename(event.path ?? '', '.md'));
    if (Number.isFinite(previous)) stamp = Math.max(stamp, previous + 1);
  }
  let file, relative, fd;
  for (;;) {
    const name = `${new Date(stamp++).toISOString()}.md`;
    relative = path.join('handoffs', workspace, slot, name);
    if (recorded.has(relative)) continue;
    file = path.join(target, name);
    try { fd = fs.openSync(file, 'wx', 0o444); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(target);
  return { type: 'handoff.recorded', path: relative, sha256: handoffDigest(bytes), workspace, slot, author };
}

export function readHandoff(org, entry) {
  handoffScope(entry.workspace, entry.slot);
  const prefix = path.join('handoffs', entry.workspace, entry.slot) + path.sep;
  if (typeof entry.path !== 'string' || !entry.path.startsWith(prefix) || path.dirname(entry.path) + path.sep !== prefix ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\.md$/.test(path.basename(entry.path)) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? ''))
    throw new UserError('invalid recorded handoff path or sha256');
  const root = fs.realpathSync(org), file = path.join(root, entry.path);
  let fd, bytes;
  try {
    let parent = root;
    for (const part of ['handoffs', entry.workspace, entry.slot]) {
      parent = path.join(parent, part);
      if (!fs.lstatSync(parent).isDirectory()) throw new Error('handoff directory is not a plain directory');
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) throw new Error('handoff is not a regular file');
    bytes = fs.readFileSync(fd);
  } catch (error) {
    throw new UserError(`handoff ${error.code === 'ENOENT' ? 'missing' : 'unreadable'}: ${file}; ${error.message}`);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  if (handoffDigest(bytes) !== entry.sha256) throw new UserError(`handoff bytes changed (sha256 mismatch): ${file}`);
  return { ...entry, path: file, missing_sections: missingHandoffSections(bytes.toString('utf8')) };
}
