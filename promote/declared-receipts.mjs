// Immutable executed sources, verified under the existing shared receipt lock.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { plainDirectory, readPlainFile, writeFileAtomic } from '../lib/files.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { hash, bytesHash, RECEIPT_SCHEMA } from './declaration.mjs';
import { remaining } from './declared-support.mjs';
import { refuseDeclaredGatesV2 } from './declared-inert.mjs';

const read = file => JSON.parse(readPlainFile(file));
export function receiptDirectory(common) {
  refuseDeclaredGatesV2();
  return plainDirectory(path.join(common, 'declared-gates'));
}
export function validCommandEvidence(row) {
  try {
    if (!row.executed || row.interrupted || row.exit_code !== 0 || row.signal !== null || row.gate_timeout || row.cleanup_error ||
        !Number.isFinite(Date.parse(row.started_at)) || !Number.isFinite(Date.parse(row.finished_at)) || Date.parse(row.finished_at) < Date.parse(row.started_at) ||
        bytesHash(readPlainFile(row.log, null)) !== row.log_hash || bytesHash(readPlainFile(row.stderr_log, null)) !== row.stderr_hash ||
        bytesHash(readPlainFile(row.execution_receipt, null)) !== row.execution_hash) return false;
    const execution = read(row.execution_receipt);
    return execution.command_started === true && execution.exit_code === 0 && execution.signal == null && !execution.gate_timeout && !execution.cleanup_error &&
      Number.isSafeInteger(execution.attempts) && execution.attempts >= 1 && Number.isFinite(Date.parse(execution.started_at)) && Number.isFinite(Date.parse(execution.finished_at));
  } catch { return false; }
}
function sourceAt(directory, file, expected) {
  if (path.dirname(file) !== directory || !/^[0-9a-f]{64}\.[0-9a-f-]{36}\.json$/.test(path.basename(file))) return null;
  const buffer = readPlainFile(file, null), bytes = new TextDecoder('utf-8', { fatal: true }).decode(buffer), source = JSON.parse(bytes), witness = read(`${file}.witness.json`);
  if (source.schema !== RECEIPT_SCHEMA || source.key !== expected.key || source.key !== source.before?.key || source.key !== source.after?.key ||
      hash(source.before) !== hash(source.after) || hash(source.before.digests) !== source.key || hash(source.before.digests) !== hash(expected.digests) ||
      source.outcome !== 'executed' || source.reused !== false || !validCommandEvidence(source.execution) ||
      witness.receipt_hash !== bytesHash(buffer) || witness.key !== source.key || witness.log_hash !== source.execution.log_hash || witness.execution_hash !== source.execution.execution_hash) return null;
  return { file, source };
}
export function withReceiptLock(common, key, deadline, callback) {
  refuseDeclaredGatesV2();
  const directory = receiptDirectory(common), release = acquireLock(path.join(directory, `${key}.lock`), { waitMs: Math.min(5000, remaining(deadline)) });
  try { return callback(directory); } finally { release(); }
}
export function findSource(directory, observation) {
  const pointer = path.join(directory, `${observation.key}.pointer.json`);
  try {
    const value = read(pointer);
    const verified = sourceAt(directory, value.file, observation);
    if (!verified || value.receipt_hash !== bytesHash(readPlainFile(value.file, null))) return { miss: 'source integrity unavailable' };
    return { hit: verified };
  } catch { return { miss: 'no completed executed source' }; }
}
export function publishSource(directory, { before, after, execution, spec, gate }) {
  refuseDeclaredGatesV2();
  if (before?.key !== after?.key || hash(before) !== hash(after) || !validCommandEvidence(execution)) return null;
  const source = { schema: RECEIPT_SCHEMA, key: before.key, outcome: 'executed', reused: false,
    project: spec.common, identity: spec.identity, gate, definition: spec.commands.find(row => row.id === gate)?.definition,
    base: spec.base, candidate: spec.candidate, before, after, execution };
  const file = path.join(directory, `${before.key}.${randomUUID()}.json`), bytes = JSON.stringify(source, null, 2) + '\n';
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(`${file}.witness.json`, JSON.stringify({ schema: RECEIPT_SCHEMA, key: before.key, receipt_hash: bytesHash(Buffer.from(bytes)),
    log_hash: execution.log_hash, execution_hash: execution.execution_hash }) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileAtomic(path.join(directory, `${before.key}.pointer.json`), JSON.stringify({ file, receipt_hash: bytesHash(Buffer.from(bytes)) }) + '\n', 0o600);
  return file;
}
export function verifySource(common, file, observation, deadline) {
  return withReceiptLock(common, observation.key, deadline, directory => {
    try { return sourceAt(directory, file, observation); } catch { return null; }
  });
}
