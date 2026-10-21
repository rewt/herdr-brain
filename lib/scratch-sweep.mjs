// Scratch disposal proofs for the guarded lane executor. No scheduling or
// lifecycle authority: the caller has already proved the lane may close.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
  const root = fs.lstatSync(directory), device = root.dev;
  if (!root.isDirectory() || root.isSymbolicLink()) throw Error('scratch root is not a directory');
  function visit(file, stat = fs.lstatSync(file)) {
    if (stat.dev !== device || stat.uid !== process.getuid() || (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()))
      throw Error('uncertain scratch entry ownership or type');
    if (path.basename(file) === '.local-live') throw Error('protected live scratch');
    entries.push([path.relative(directory, file), stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    else bytes += stat.size;
  }
  visit(directory, root);
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
  // Review-round suffixes (r2) and foreign record run numbers are not run
  // claims. Only exact closing-lane run IDs refine the longest-topic fallback.
  const named = ids.filter(id => runs.some(run => run.id === id));
  if (named.length && (named.length !== 1 || !runs.some(run => run.id === named[0] && (run.report || run.abandoned))))
    return { owner: named.join(', '), matchedBy: 'run name', reason: 'named run ownership is active or conflicting' };
  return { owner: named[0] ?? owner, matchedBy: named.length ? 'run name and longest topic' : 'longest topic',
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
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (created) try { fs.unlinkSync(temporary); } catch { /* Renamed, or best-effort cleanup after a write failure. */ }
  }
}

// Test the declared directory itself, so a local exclusion for lane-sweeps/
// does not make an otherwise tracked archive eligible. Resolve the destination
// too: an external archive may have a lane-sweeps symlink into a checkout.
function manifestArchive(archives, { canonical, lane, command = spawnSync, env }) {
  if (!archives.length) return;
  const git = args => command('git', ['-C', canonical, ...args], { cwd: canonical, env,
    encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  const listed = git(['worktree', 'list', '--porcelain', '-z']);
  const worktrees = listed.stdout?.split('\0').filter(row => row.startsWith('worktree ')).map(row => resolved(row.slice(9)));
  if (listed.error || listed.status !== 0 || !listed.stdout?.endsWith('\0') || !worktrees?.length)
    throw Error('archive worktree inventory unavailable');
  const roots = [...new Set([resolved(canonical), resolved(lane), ...worktrees])];
  const eligible = directory => roots.every(root => {
    if (!inside(directory, root)) return true;
    if (directory === root) return false;
    const ignored = command('git', ['-C', root, 'check-ignore', '--quiet', '--', path.relative(root, directory) + path.sep],
      { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    if (ignored.error || ![0, 1].includes(ignored.status)) throw Error('archive ignore classification unavailable');
    return ignored.status === 0;
  });
  for (const archive of archives) {
    const destination = resolved(path.join(archive, 'lane-sweeps'));
    if (inside(archive, lane) || inside(destination, lane)) throw Error('archive is inside closing lane');
    if (eligible(archive) && eligible(destination)) return destination;
  }
}

const ordinaryKeepReasons = new Set(['unmerged lane keeps scratch with its archive tag',
  'scratch overlaps project, lane, Git metadata or archive', 'scratch contains report evidence outside the archive',
  'directory has open process handles']);
function manifestEntries(entries) {
  const detailed = [], byReason = new Map(), sample = [];
  let kept = 0, summarized = 0, sampleBytes = 0;
  for (const entry of entries) {
    if (entry.disposition === 'kept') kept++;
    const sibling = entry.proof?.owner.matchedBy.includes('longest topic') && !entry.proof.owner.owned &&
      entry.reason === entry.proof.owner.reason;
    // Observation/ownership failures, removal intents and actual removals always
    // retain their complete entries. Only known, ordinary keeps are compacted.
    if (entry.disposition === 'kept' && entry.proof && (sibling || ordinaryKeepReasons.has(entry.reason))) {
      const reason = sibling ? 'longer lane topic owns scratch' : entry.reason;
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1); summarized++;
      const bytes = Buffer.byteLength(JSON.stringify(entry.path));
      if (sample.length < 16 && sampleBytes + bytes <= 4096) { sample.push(entry.path); sampleBytes += bytes; }
    } else detailed.push({ ...entry, reason: entry.reason + (entry.matchedBy.includes('longest topic')
      ? '; unmarked topic match is not project-bound; same-topic scratch from another project may match' : '') });
  }
  return { entries: detailed, counts: { total: entries.length, kept, removed: entries.length - kept },
    kept_summary: { count: summarized, by_reason: Object.fromEntries([...byReason].sort()), sample_paths: sample } };
}

export function prepareScratchSweep({ common, canonical, lane, topic, tip, integrated, evidence, recovery, runs, topics,
  env = process.env, command, hold = () => null, guard = () => {}, log = () => {},
  warn = message => process.stderr.write(message + '\n'),
  roots = [os.tmpdir(), '/private/tmp', '/tmp'],
  readOpenFiles = directories => readProcessFileReferences({ command, env, directories }), readOwnership }) {
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
    let children;
    // Directory entries avoid one lstat per foreign entry. Still inspect every
    // directory's marker: a marker owns scratch regardless of its name.
    try { children = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); }
    catch (error) { observations.push(`scratch root ${root}: ${error.message}`); continue; }
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink()) continue;
      const directory = path.join(root, child.name);
      let owner;
      try {
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
  const candidates = entries.filter(entry => entry.reason === 'awaiting final ownership, HOLD and open file checks').map(entry => entry.path);
  if (candidates.length) {
    try { open = readOpenFiles(candidates); } catch (error) { openError = error.message; }
  }
  for (const entry of entries) if (entry.reason === 'awaiting final ownership, HOLD and open file checks') {
    const brake = hold();
    if (brake) entry.reason = brake;
    else if (archiveError || observations.length || openError) entry.reason = `observation failed; scratch kept: ${archiveError ?? openError ?? observations.join('; ')}`;
    else if (open.some(ref => inside(ref.path, entry.path))) entry.reason = 'directory has open process handles';
    else Object.defineProperty(entry, 'removable', { value: true, enumerable: false });
  }
  const fallback = evidence && inside(resolved(evidence.directory), common) ? path.join(path.dirname(evidence.directory), path.basename(evidence.directory) + (recovery ? '-recovery' : '') + '-sweep.json') :
    path.join(common, 'lane-archive', topic, randomUUID() + '-sweep.json');
  let manifest = fallback;
  const data = { schema: 'lane-scratch-sweep/v1', common, lane, topic, tip, integrated, created_at: new Date().toISOString(),
    archive, ...(recovery ? { recovery } : {}), phase: 'planned', warnings, observations, entries };
  const write = () => durableWrite(manifest, { ...data, ...manifestEntries(entries) });
  try {
    const destination = manifestArchive(archives, { canonical, lane, command, env });
    if (destination) manifest = path.join(destination, `${topic}-${randomUUID()}.json`);
    if (inside(resolved(path.dirname(manifest)), lane)) throw Error('archive is inside closing lane');
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    write();
  } catch (error) {
    if (manifest === fallback && !archives.length) throw error;
    warnings.push(`Declared archive manifest unavailable; scratch kept; using lane evidence: ${error.message}`);
    for (const entry of entries) if (entry.removable) entry.reason = 'declared archive manifest unavailable; scratch kept';
    archiveError = error.message; manifest = fallback;
    fs.mkdirSync(path.dirname(manifest), { recursive: true }); write();
  }
  for (const message of warnings) warn(`lane scratch warning: ${message}`);
  log({ action: 'scratch-manifest', cwd: lane, manifest, warnings });
  let manifestError;
  const diagnose = error => {
    manifestError = error.message;
    const message = `Sweep manifest ${manifest} update failed (${data.phase}): ${error.message}`;
    warnings.push(message);
    // These diagnostics run after lane removal too. A failed diagnostic sink
    // must not turn completed removal into a failed lifecycle operation.
    try { warn(`lane scratch warning: ${message}`); } catch { /* Best effort. */ }
    try { log({ action: 'scratch-manifest-error', cwd: lane, manifest, phase: data.phase, why: error.message,
      removed: entries.filter(entry => entry.disposition === 'removed').map(entry => entry.path) }); } catch { /* Best effort. */ }
  };
  const persist = () => {
    try { write(); return true; }
    catch (error) { diagnose(error); return false; }
  };
  return { get manifest() { return manifest; }, cancel(reason) {
    data.phase = 'not-executed'; data.reason = reason; data.completed_at = new Date().toISOString();
    for (const entry of entries) if (entry.removable) entry.reason = `lane removal not completed; scratch kept: ${reason}`;
    persist();
  }, discardAttempt() {
    // Called only after the unchanged source was verified and its duplicate
    // evidence bundle discarded. Keep at most one refused-attempt diagnostic
    // in a declared archive, and no orphan beside discarded fallback evidence.
    if (data.phase !== 'not-executed') return;
    try {
      if (manifest !== fallback) {
        const previous = manifest;
        manifest = path.join(path.dirname(manifest), `${topic}-${digest(common)}-not-executed.json`);
        try { write(); } catch (error) { manifest = previous; throw error; }
        fs.unlinkSync(previous);
      } else fs.unlinkSync(manifest);
      log({ action: 'scratch-attempt-discarded', cwd: lane, manifest, retained: manifest !== fallback });
    } catch (error) { diagnose(error); }
  }, execute() {
    for (const entry of entries.filter(entry => entry.removable && !archiveError)) {
      if (manifestError) { entry.reason = `scratch kept: manifest write failed: ${manifestError}`; continue; }
      try {
        guard();
        const brake = hold();
        if (brake) throw Error(brake);
        const current = readOwnership ? { common, topic, ...readOwnership() } : context;
        if (current.runs.some(run => !run.report && !run.abandoned)) throw Error('lane has an active run');
        const owner = ownership(entry.path, current), measured = measure(entry.path);
        if (JSON.stringify(owner) !== JSON.stringify(entry.proof.owner) || measured.fingerprint !== entry.proof.fingerprint)
          throw Error('scratch ownership or contents changed');
        const open = readOpenFiles([entry.path]);
        if (open.some(ref => inside(ref.path, entry.path))) throw Error('directory has open process handles');
        guard();
        const finalHold = hold(); if (finalHold) throw Error(finalHold);
        // Persist the exact removal intent before any unlink, then its outcome.
        entry.reason = 'owned scratch removal authorized'; data.phase = 'removing';
        if (!persist()) throw Error(`manifest write failed: ${manifestError}`);
        guard();
        const removalHold = hold(); if (removalHold) throw Error(removalHold);
        const latest = readOwnership ? { common, topic, ...readOwnership() } : context;
        if (latest.runs.some(run => !run.report && !run.abandoned) ||
            JSON.stringify(ownership(entry.path, latest)) !== JSON.stringify(entry.proof.owner) ||
            measure(entry.path).fingerprint !== entry.proof.fingerprint) throw Error('scratch ownership or contents changed before unlink');
        fs.rmSync(entry.path, { recursive: true });
        entry.disposition = 'removed'; entry.reason = 'owned scratch removed after final checks';
      } catch (error) { entry.reason = `scratch kept: ${error.message}`; }
      persist();
    }
    data.phase = 'complete'; data.completed_at = new Date().toISOString(); persist();
    return { manifest, removed: entries.filter(entry => entry.disposition === 'removed').length,
      ...(manifestError ? { manifestError } : {}) };
  } };
}
