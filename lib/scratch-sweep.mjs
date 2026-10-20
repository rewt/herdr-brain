// Scratch disposal proofs for the guarded lane executor. No scheduling or
// lifecycle authority: the caller has already proved the lane may close.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { discoverArchive } from './archive.mjs';
import { readProcessFileReferences } from './lane-removal.mjs';

export const SCRATCH_OWNER_FILE = '.herdr-scratch.json';
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
const digest = value => createHash('sha256').update(value).digest('hex');
function resolved(file) {
  try { return fs.realpathSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(resolved(parent), path.basename(file));
  }
}
function markerAt(directory) {
  const file = path.join(directory, SCRATCH_OWNER_FILE);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw Error('invalid scratch ownership marker');
    const bytes = fs.readFileSync(fd), marker = JSON.parse(bytes);
    if (marker.schema !== 'herdr-scratch/v1' || typeof marker.common !== 'string' || !path.isAbsolute(marker.common) ||
        (marker.run !== undefined && !/^R-\d+$/.test(marker.run)) ||
        (marker.topic !== undefined && !/^[a-z0-9][a-z0-9-]{1,60}$/.test(marker.topic)) || (!marker.run && !marker.topic))
      throw Error('invalid scratch ownership marker');
    return { ...marker, common: resolved(marker.common), sha256: digest(bytes) };
  } finally { fs.closeSync(fd); }
}
function measure(directory) {
  const entries = []; let bytes = 0;
  const device = fs.lstatSync(directory).dev;
  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.dev !== device || stat.uid !== process.getuid() || (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()))
      throw Error('uncertain scratch entry ownership or type');
    if (path.basename(file) === '.local-live') throw Error('protected live scratch');
    entries.push([path.relative(directory, file), stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    else bytes += stat.size;
  }
  visit(directory);
  if (!Number.isSafeInteger(bytes)) throw Error('scratch size is uncertain');
  return { bytes, fingerprint: digest(JSON.stringify(entries)) };
}
// Delimit the whole topic; "topic" never claims "topical". The longest
// known topic wins even when that sibling was archived or has no worktree.
function topicOwner(name, topics) {
  return topics.filter(topic => typeof topic === 'string' && (name === topic || name.startsWith(topic + '-') || name.startsWith(topic + '.') || name.startsWith(topic + '_')))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}
function ownership(directory, { common, topic, runs, topics }) {
  const marker = markerAt(directory), name = path.basename(directory);
  if (marker) {
    const owner = marker.run ?? marker.topic;
    if (marker.common !== common) return { owner, matchedBy: 'marker', reason: 'ownership marker belongs to another project' };
    if (marker.run) {
      const run = runs.find(run => run.id === marker.run);
      if (!run || (marker.topic && marker.topic !== topic) || (!run.report && !run.abandoned))
        return { owner, matchedBy: 'run marker', reason: 'run is unknown, active or has conflicting topic' };
      return { owner, matchedBy: 'run marker', owned: true, marker: marker.sha256 };
    }
    return { owner, matchedBy: 'topic marker', owned: marker.topic === topic, marker: marker.sha256,
      ...(marker.topic === topic ? {} : { reason: 'ownership marker belongs to another lane' }) };
  }
  const owner = topicOwner(name, topics);
  const ids = [...name.matchAll(/(?:^|[-_.])r-?(\d+)(?=$|[-_.])/gi)].map(match => `R-${match[1]}`);
  if (!owner) return ids.some(id => runs.some(run => run.id === id))
    ? { owner: ids.join(', '), matchedBy: 'run name', reason: 'unmarked run id has no project or lane ownership proof' } : null;
  if (ids.length && (ids.length !== 1 || !runs.some(run => run.id === ids[0] && (run.report || run.abandoned))))
    return { owner: ids.join(', '), matchedBy: 'run name', reason: 'named run ownership is unknown, active or conflicting' };
  return { owner: ids[0] ?? owner, matchedBy: ids.length ? 'run name and longest topic' : 'longest topic',
    owned: owner === topic, ...(owner === topic ? {} : { reason: `longer lane topic owns scratch: ${owner}` }) };
}
function reportPaths(runs, lane) {
  const paths = [];
  function visit(value, run) {
    if (typeof value === 'string') {
      const found = path.isAbsolute(value) && !/\n/.test(value) ? [value] :
        [...value.matchAll(/(?:^|[\s(\[`])((?:\/)[^\s)\]`"<>]+)/g)].map(match => match[1]);
      if (!found.length && /^(?:\.\.?\/)/.test(value)) found.push(path.resolve(lane, value));
      for (const file of found) paths.push({ run, path: resolved(file.replace(/(?::\d+|#L\d+)$/, '')) });
    } else if (Array.isArray(value)) value.forEach(entry => visit(entry, run));
    else if (value && typeof value === 'object') Object.values(value).forEach(entry => visit(entry, run));
  }
  for (const run of runs) visit(run.report?.artifacts, run.id);
  return paths;
}
function durableWrite(file, value) {
  const temporary = file + '.' + randomUUID();
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export function prepareScratchSweep({ common, canonical, lane, topic, tip, integrated, evidence, runs, topics,
  env = process.env, command, hold = () => null, guard = () => {}, log = () => {},
  warn = message => process.stderr.write(message + '\n'),
  roots = [os.tmpdir(), '/private/tmp', '/tmp'], readOpenFiles = () => readProcessFileReferences({ command, env }), readOwnership }) {
  const warnings = [], entries = [], observations = [];
  let archive, archiveError;
  try { archive = discoverArchive({ cwd: canonical, env, project: { canonical } }); }
  catch (error) { archive = { dirs: [], source: 'unavailable' }; archiveError = error.message; }
  let archives;
  try { archives = archive.dirs.map(resolved); }
  catch (error) { archives = []; archiveError = error.message; }
  if (archiveError) warnings.push(`Archive observation failed; scratch kept: ${archiveError}`);
  if (!archives.length) warnings.push('No archive declared; sweep manifest is beside the lane preservation evidence.');
  let claims = [];
  try {
    claims = reportPaths(runs, lane);
    for (const claim of claims) if (!inside(claim.path, lane) && !archives.some(root => inside(claim.path, root)))
      warnings.push(`Report ${claim.run} cites evidence outside the archive and lane: ${claim.path}`);
  } catch (error) { archiveError ??= error.message; warnings.push(`Report evidence observation failed; scratch kept: ${error.message}`); }
  const context = { common, topic, runs, topics: [...new Set([topic, ...topics])] };
  const rootPaths = new Set();
  for (const root of roots) try { rootPaths.add(fs.realpathSync(root)); }
  catch (error) { if (error.code !== 'ENOENT') observations.push(`scratch root ${root}: ${error.message}`); }
  for (const root of rootPaths) {
    let names;
    try { names = fs.readdirSync(root).sort(); }
    catch (error) { observations.push(`scratch root ${root}: ${error.message}`); continue; }
    for (const name of names) {
      const directory = path.join(root, name);
      let owner;
      try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        owner = ownership(directory, context);
        if (!owner) continue;
        const entry = { path: directory, owner: owner.owner, matchedBy: owner.matchedBy, size: null, disposition: 'kept', reason: owner.reason };
        entries.push(entry);
        try {
          const measured = measure(directory);
          entry.size = measured.bytes;
          Object.defineProperty(entry, 'proof', { value: { ...measured, owner }, enumerable: false });
        } catch (error) { entry.reason = `scratch observation failed: ${error.message}`; }
        if (!owner.owned || !entry.proof) continue;
        if (!integrated) entry.reason = 'unmerged lane keeps scratch with its archive tag';
        else if ([canonical, lane, common, ...archives].some(file => inside(file, directory) || inside(directory, file)))
          entry.reason = 'scratch overlaps project, lane, Git metadata or archive';
        else if (claims.some(claim => inside(claim.path, directory))) entry.reason = 'scratch contains report evidence outside the archive';
        else entry.reason = 'awaiting final ownership, HOLD and open file checks';
      } catch (error) {
        // A marker we cannot read cannot be treated as an absent marker.
        entries.push({ path: directory, owner: owner?.owner ?? null, matchedBy: 'uncertain', size: null,
          disposition: 'kept', reason: `ownership observation failed: ${error.message}` });
      }
    }
  }
  let open, openError;
  if (entries.some(entry => entry.reason === 'awaiting final ownership, HOLD and open file checks')) {
    try { open = readOpenFiles(); } catch (error) { openError = error.message; }
  }
  for (const entry of entries) if (entry.reason === 'awaiting final ownership, HOLD and open file checks') {
    const brake = hold();
    if (brake) entry.reason = brake;
    else if (archiveError || observations.length || openError) entry.reason = `observation failed; scratch kept: ${archiveError ?? openError ?? observations.join('; ')}`;
    else if (open.some(ref => inside(ref.path, entry.path))) entry.reason = 'directory has open process handles';
    else Object.defineProperty(entry, 'removable', { value: true, enumerable: false });
  }
  const fallback = evidence ? path.join(path.dirname(evidence.directory), path.basename(evidence.directory) + '-sweep.json') :
    path.join(common, 'lane-archive', topic, randomUUID() + '-sweep.json');
  let manifest = archives.length ? path.join(archives[0], 'lane-sweeps', `${topic}-${randomUUID()}.json`) : fallback;
  const data = { schema: 'lane-scratch-sweep/v1', common, lane, topic, tip, integrated, created_at: new Date().toISOString(),
    archive, phase: 'planned', warnings, observations, entries };
  try {
    if (inside(resolved(path.dirname(manifest)), lane)) throw Error('archive is inside closing lane');
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    durableWrite(manifest, data);
  } catch (error) {
    if (manifest === fallback) throw error;
    warnings.push(`Declared archive manifest unavailable; scratch kept; using lane evidence: ${error.message}`);
    for (const entry of entries) if (entry.removable) entry.reason = 'declared archive manifest unavailable; scratch kept';
    archiveError = error.message; manifest = fallback;
    fs.mkdirSync(path.dirname(manifest), { recursive: true }); durableWrite(manifest, data);
  }
  for (const message of warnings) warn(`lane scratch warning: ${message}`);
  log({ action: 'scratch-manifest', cwd: lane, manifest, warnings });
  return { manifest, execute() {
    for (const entry of entries.filter(entry => entry.removable && !archiveError)) {
      try {
        guard();
        const brake = hold();
        if (brake) throw Error(brake);
        const current = readOwnership ? { common, topic, ...readOwnership() } : context;
        if (current.runs.some(run => !run.report && !run.abandoned)) throw Error('lane has an active run');
        const owner = ownership(entry.path, current), measured = measure(entry.path);
        if (JSON.stringify(owner) !== JSON.stringify(entry.proof.owner) || measured.fingerprint !== entry.proof.fingerprint)
          throw Error('scratch ownership or contents changed');
        const open = readOpenFiles();
        if (open.some(ref => inside(ref.path, entry.path))) throw Error('directory has open process handles');
        guard();
        const finalHold = hold(); if (finalHold) throw Error(finalHold);
        // Persist the exact removal intent before any unlink, then its outcome.
        entry.reason = 'owned scratch removal authorized'; data.phase = 'removing'; durableWrite(manifest, data);
        guard();
        const removalHold = hold(); if (removalHold) throw Error(removalHold);
        const latest = readOwnership ? { common, topic, ...readOwnership() } : context;
        if (latest.runs.some(run => !run.report && !run.abandoned) ||
            JSON.stringify(ownership(entry.path, latest)) !== JSON.stringify(entry.proof.owner) ||
            measure(entry.path).fingerprint !== entry.proof.fingerprint) throw Error('scratch ownership or contents changed before unlink');
        fs.rmSync(entry.path, { recursive: true });
        entry.disposition = 'removed'; entry.reason = 'owned scratch removed after final checks';
      } catch (error) { entry.reason = `scratch kept: ${error.message}`; }
      durableWrite(manifest, data);
    }
    data.phase = 'complete'; data.completed_at = new Date().toISOString(); durableWrite(manifest, data);
    return { manifest, removed: entries.filter(entry => entry.disposition === 'removed').length };
  } };
}
