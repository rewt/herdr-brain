// Operation evidence is durable; status is only a disposable projection.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPlainFile, plainDirectory, writeFileAtomic } from '../lib/files.mjs';
import { parseUniqueJson } from './json.mjs';

export const runtimePaths = common => ({ directory: path.join(common, 'sessions'),
  journal: path.join(common, 'sessions/controller-journal.json'),
  status: path.join(common, 'sessions/controller-status.json'),
  lease: path.join(common, 'sessions/controller.lock') });
export function present(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export const emptyJournal = common => ({ schema: 'session-controller-journal/v1', common, operations: [], bindings: [] });
export function readControllerJournal(common) {
  const file = runtimePaths(common).journal;
  let journal;
  try { journal = parseUniqueJson(readPlainFile(file)); }
  catch (error) { if (error.code === 'ENOENT') return emptyJournal(common); throw error; }
  if (journal.schema !== 'session-controller-journal/v1' || journal.common !== common ||
      !Array.isArray(journal.operations) || !Array.isArray(journal.bindings) ||
      journal.operations.some(op => !op.id || !op.uid || !op.specDigest || !op.target || !['intent', 'acknowledged'].includes(op.state)) ||
      new Set(journal.operations.map(op => op.id)).size !== journal.operations.length ||
      journal.bindings.some(b => !b.uid || !b.specDigest || !b.binding || !Number.isSafeInteger(b.generation)) ||
      new Set(journal.bindings.map(b => b.uid)).size !== journal.bindings.length) throw Error('invalid controller journal; hold');
  return journal;
}
export function durableWrite(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', 0o600);
  for (const target of [file, path.dirname(file)]) {
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
// No timeout or automatic stale-owner recovery in stage 3. An abandoned lease
// requires inspection; neither another PID nor a cache can authorize a launch.
export function acquireControllerLease(common) {
  const paths = runtimePaths(common);
  plainDirectory(paths.directory);
  fs.mkdirSync(paths.lease);
  const token = randomUUID();
  durableWrite(path.join(paths.lease, 'owner.json'), { token, pid: process.pid, common }); // Failure leaves ownership held.
  return () => {
    const file = path.join(paths.lease, 'owner.json');
    const owner = parseUniqueJson(readPlainFile(file));
    if (owner.token !== token || owner.common !== common) throw Error('controller lease changed; hold');
    fs.unlinkSync(file); fs.rmdirSync(paths.lease);
  };
}
