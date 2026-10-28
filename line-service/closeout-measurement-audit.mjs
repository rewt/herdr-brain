// Immutable content objects keep the per-turn journal bounded. Nothing is
// rotated away: every frame names its complete census and raw inventory.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {plainDirectory, readPlainFile} from '../lib/files.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const MAX_AUDIT_FRAME_BYTES = 256 * 1024;
const encode = value => JSON.stringify(value) + '\n';
const withoutAge = ({age_ms, ...row}) => row;

function objects(directory) {
  plainDirectory(path.join(directory, 'closeout-objects'));
  return value => {
    const bytes = encode(value), sha256 = hash(bytes), file = `closeout-objects/${sha256}.json`, target = path.join(directory, file);
    let fd;
    try { fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (readPlainFile(target) !== bytes) throw Error('measurement content object changed');
    }
    if (fd !== undefined) try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return {file, sha256, bytes: Buffer.byteLength(bytes)};
  };
}

export function compactMeasurement(directory, doc) {
  const put = objects(directory), chunks = [];
  // Chunks reuse full unchanged rows, including their original effect/hold
  // evidence. Age is derived from the immutable origin at the frame timestamp.
  for (let i = 0; i < doc.cohort.length; i += 128) chunks.push(put(doc.cohort.slice(i, i + 128).map(withoutAge)));
  const cohort = {...put(chunks), count: doc.cohort.length};
  const historical = doc.historical.map(({members, rows, excluded, ...row}) => ({...row,
    members: put(members), rows: {...put(rows.map(withoutAge)), count: rows.length}, excluded: {...put(excluded), count: excluded.length}}));
  const result = {...doc, schema: 'closeout-measurement/v2', cohort, historical, inventory: put(doc.inventory),
    legacy: {...doc.legacy, row_ids: put(doc.legacy.row_ids)},
    exclusions: put(doc.exclusions)};
  // A pathological number of slices/historical scopes still cannot grow a
  // frame without bound. The complete projection remains hash-addressed.
  const frame = Buffer.byteLength(JSON.stringify(result) + '\n') <= MAX_AUDIT_FRAME_BYTES ? result :
    {schema: 'closeout-measurement/v2', project: doc.project, org: doc.org, observed_at: doc.observed_at,
    source: doc.source, cutoff: doc.cutoff, interval_ms: doc.interval_ms, green: doc.green,
    window_declaration: doc.window_declaration, projection: put(result)};
  const fd = fs.openSync(path.join(directory, 'closeout-objects'), 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (Buffer.byteLength(JSON.stringify(frame) + '\n') > MAX_AUDIT_FRAME_BYTES) throw Error('measurement frame metadata exceeds byte bound');
  return frame;
}

export function readCloseoutMeasurement(file) {
  const directory = path.dirname(file);
  const get = ref => {
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || ref.file !== `closeout-objects/${ref.sha256}.json`) throw Error('invalid measurement content reference');
    const bytes = readPlainFile(path.join(directory, ref.file));
    if (hash(bytes) !== ref.sha256) throw Error('measurement content hash mismatch');
    return JSON.parse(bytes);
  };
  let doc = JSON.parse(readPlainFile(file));
  if (doc.schema !== 'closeout-measurement/v2') return doc;
  if (doc.projection) doc = get(doc.projection);
  const restore = row => {
    const origin = Date.parse(row.availability?.observed_at ?? row.at);
    return {...row, age_ms: Number.isFinite(origin) ? Math.max(0, Date.parse(doc.observed_at) - origin) : null};
  };
  return {...doc, cohort: get(doc.cohort).flatMap(ref => get(ref).map(restore)), inventory: get(doc.inventory),
    exclusions: get(doc.exclusions), legacy: {...doc.legacy, row_ids: get(doc.legacy.row_ids)}, historical: doc.historical.map(row => ({...row,
      members: get(row.members), rows: get(row.rows).map(restore), excluded: get(row.excluded)}))};
}
