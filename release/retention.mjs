// Generated candidate snapshots are disposable; record facts and evidence are not.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const stat = file => { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const tagName = tag => typeof tag === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(tag) && !tag.includes('..');
const sync = file => {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
function safePath(identity, file) {
  const relative = path.relative(identity, file);
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw Error('path is outside the release root');
  let cursor = identity;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    const s = stat(cursor);
    if (s?.isSymbolicLink()) throw Error(`refusing symlink: ${cursor}`);
    if (s && cursor !== file && !s.isDirectory()) throw Error(`not a directory: ${cursor}`);
  }
}

function gateLog(candidate) {
  if (typeof candidate.gate?.log !== 'string') return null;
  const relative = path.relative(candidate.snapshot, path.resolve(candidate.gate.log));
  return relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) ? relative : null;
}

function evidenceFiles(snapshot, recordedLog, recovering = false) {
  const files = [];
  const walk = (directory, dependency = false, evidence = false) => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), s = fs.lstatSync(file);
      // rm unlinks interior links; neither enumeration nor copying follows them.
      if (s.isSymbolicLink()) {
        if (!dependency && !['node_modules', '.release-npm-cache'].includes(name)) throw Error(`refusing snapshot symlink: ${file}`);
        continue;
      }
      const deps = dependency || ['node_modules', '.release-npm-cache', '.git'].includes(name);
      const proof = evidence || /evidence|receipts?/i.test(name);
      if (s.isDirectory()) walk(file, deps, proof);
      else if (!s.isFile()) throw Error(`refusing special file: ${file}`);
      else if (proof || /\.log$|\.jsonl$|^\.release-(build\.json|commit)$/.test(name) || !deps && /\.json$/.test(name)) files.push(path.relative(snapshot, file));
    }
  };
  walk(snapshot);
  if (recordedLog) {
    const file = path.join(snapshot, recordedLog);
    safePath(snapshot, file);
    const s = stat(file);
    if ((s && !s.isFile()) || (!s && !recovering)) throw Error('recorded gate log is not a regular file');
    if (s && !files.includes(recordedLog)) files.push(recordedLog);
  }
  return files;
}

const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const directoryIdentity = s => ({ dev: String(s.dev), ino: String(s.ino) });

function pendingIntent(receipt, candidate) {
  if (!stat(receipt)) return null;
  let pending = null;
  for (const line of fs.readFileSync(receipt, 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line); // A torn or malformed journal fails closed.
    if (row.id !== candidate.id) continue;
    if (row.action === 'remove-intent') {
      if (pending) throw Error('conflicting removal intents');
      pending = row;
    } else if (row.action === 'removed') {
      if (!pending || row.tag !== pending.tag || row.snapshot !== pending.snapshot || row.commit !== pending.commit) throw Error('conflicting removal completion');
      pending = null;
    }
  }
  return pending;
}

function validateIntent(project, candidate, intent, evidence, snapshotStat) {
  if (intent.tag !== candidate.tag || intent.snapshot !== candidate.snapshot || intent.commit !== candidate.commit || intent.evidence !== evidence) throw Error('removal intent differs from candidate');
  if (!intent.snapshot_identity || !Array.isArray(intent.evidence_manifest) || !Array.isArray(intent.evidence_files)) throw Error('removal intent lacks ownership or evidence proof');
  if (snapshotStat && (!snapshotStat.isDirectory() || String(snapshotStat.dev) !== intent.snapshot_identity.dev || String(snapshotStat.ino) !== intent.snapshot_identity.ino)) throw Error('snapshot directory ownership changed');
  const manifest = new Map();
  for (const item of intent.evidence_manifest) {
    if (typeof item.path !== 'string' || !item.path || item.path !== path.normalize(item.path) || path.isAbsolute(item.path) || item.path === '..' || item.path.startsWith('../') || !/^[0-9a-f]{64}$/.test(item.sha256) || typeof item.retained !== 'boolean' || manifest.has(item.path)) throw Error('invalid removal evidence manifest');
    manifest.set(item.path, item);
    if (item.retained) {
      const file = path.join(evidence, item.path);
      safePath(project.identity, file);
      if (!stat(file)?.isFile() || digest(file) !== item.sha256) throw Error(`retained evidence missing or changed: ${item.path}`);
    }
  }
  const retained = [...manifest.values()].filter(item => item.retained).map(item => item.path);
  if (JSON.stringify(retained) !== JSON.stringify(intent.evidence_files) || !manifest.get('.release-commit')?.retained || fs.readFileSync(path.join(evidence, '.release-commit'), 'utf8').trim() !== candidate.commit) throw Error('removal intent lacks retained ownership proof');
  const recordedLog = gateLog(candidate);
  if (recordedLog && !manifest.get(recordedLog)?.retained) throw Error('removal intent lacks recorded gate log');
  return manifest;
}

function retainedFiles(project, candidate, files) {
  const tree = spawnSync('git', ['-C', project.canonical, 'ls-tree', '-r', '-z', '--full-tree', candidate.commit], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (tree.error || tree.status !== 0) throw Error('cannot verify tagged evidence');
  const blobs = new Map(tree.stdout.split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t');
    return [row.slice(tab + 1), row.slice(0, tab).split(' ')[2]];
  }));
  return files.filter(relative => {
    const blob = blobs.get(relative);
    if (!blob) return true;
    const bytes = fs.readFileSync(path.join(candidate.snapshot, relative));
    const hash = createHash(blob.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    // Byte-identical historical evidence already survives in the tag. Only
    // newly generated or changed evidence needs another local copy.
    return hash !== blob;
  });
}

export function pruneSnapshots({ project, candidates, dryRun = false, activeTag, env = process.env }) {
  const directory = path.join(project.identity, 'release'), root = path.join(directory, 'candidates');
  const report = { dry_run: dryRun, root, kept: [], removed: [], would_remove: [], refused: [], receipt: null };
  const rows = candidates.filter(c => c.identity === project.identity);
  activeTag ??= env.RELEASE_ACTIVE_TAG;
  if (activeTag && (!tagName(activeTag) || !rows.some(c => c.tag === activeTag))) throw Error('active tag must name a recorded candidate');
  // The standard activation pointer lives outside Git. Match its commit, not a
  // directory basename (an unrelated project's release can use the same tag).
  const current = path.join(env.HERDR_MONITOR_HOME || path.join(env.HOME || os.homedir(), '.local/share/herdr-monitor'), 'current');
  let activeCommit = null;
  try { activeCommit = fs.readFileSync(path.join(current, '.release-commit'), 'utf8').trim(); }
  catch (e) { if (e.code !== 'ENOENT' || stat(current)) throw Error(`cannot identify active release: ${e.message}`); }
  if (activeCommit !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(activeCommit)) throw Error('active release has an invalid commit marker');
  const latestPassed = rows.filter(c => c.gate?.result === 'passed').sort((a, b) => (a.gate.seq ?? a.created?.seq ?? 0) - (b.gate.seq ?? b.created?.seq ?? 0)).at(-1)?.id;
  for (const c of rows) {
    const entry = { id: c.id, tag: c.tag, snapshot: c.snapshot };
    const keep = c.tag === activeTag || activeCommit && c.commit === activeCommit ? 'active release'
      : c.id === latestPassed ? 'most recent passed candidate'
      : !c.started || !c.gate ? 'pending or interrupted gate'
      : c.gate.result === 'interrupted' ? 'interrupted result'
      : c.status === 'awaiting-operator' ? 'awaiting operator decision'
      : !['gate-failed', 'approved', 'declined'].includes(c.status) ? 'unresolved candidate' : null;
    if (keep) { report.kept.push({ ...entry, reason: keep }); continue; }
    try {
      if (!tagName(c.tag) || c.snapshot !== path.join(root, c.tag)) throw Error('snapshot is outside its generated candidate path');
      safePath(project.identity, c.snapshot);
      const s = stat(c.snapshot);
      if (s && !s.isDirectory()) throw Error('snapshot is not a directory');
      const evidence = path.join(directory, 'evidence', c.tag);
      safePath(project.identity, evidence);
      if (stat(evidence) && !stat(evidence).isDirectory()) throw Error('retained evidence path is not a directory');
      const receipt = path.join(directory, 'retention.jsonl');
      safePath(project.identity, receipt);
      if (stat(receipt) && !stat(receipt).isFile()) throw Error('retention receipt is not a regular file');
      const intent = pendingIntent(receipt, c);
      if (!s && !intent) { report.kept.push({ ...entry, reason: 'snapshot already absent' }); continue; }
      const tag = spawnSync('git', ['-C', project.canonical, 'rev-parse', '--verify', `refs/tags/${c.tag}^{commit}`], { encoding: 'utf8' });
      if (tag.error || tag.status !== 0 || tag.stdout.trim() !== c.commit) throw Error('candidate tag is missing or moved; snapshot cannot be rebuilt');
      const append = value => {
        safePath(project.identity, receipt);
        if (stat(receipt) && !stat(receipt).isFile()) throw Error('retention receipt is not a regular file');
        const fd = fs.openSync(receipt, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n'); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        sync(directory);
      };
      if (intent) {
        const manifest = validateIntent(project, c, intent, evidence, s);
        if (s) {
          for (const relative of evidenceFiles(c.snapshot, gateLog(c), true)) {
            if (!manifest.has(relative) || digest(path.join(c.snapshot, relative)) !== manifest.get(relative).sha256) throw Error(`snapshot evidence changed after intent: ${relative}`);
          }
        }
        const { at, action, ...removal } = intent;
        if (dryRun) { report.would_remove.push({ ...removal, recovery: s ? 'partial deletion' : 'missing completion receipt' }); continue; }
        // The marker may already have been unlinked. Only the original directory
        // inode plus the synced evidence proof authorizes continuing that removal.
        safePath(project.identity, c.snapshot);
        const now = stat(c.snapshot);
        validateIntent(project, c, intent, evidence, now);
        if (Boolean(now) !== Boolean(s)) throw Error('snapshot directory changed during recovery');
        if (now) fs.rmSync(c.snapshot, { recursive: true });
        sync(root);
        append({ action: 'removed', ...removal });
        report.receipt = receipt;
        report.removed.push({ ...removal, recovered: true });
        continue;
      }
      const marker = path.join(c.snapshot, '.release-commit');
      if (!stat(marker)?.isFile() || fs.readFileSync(marker, 'utf8').trim() !== c.commit) throw Error('snapshot ownership marker differs');
      const selected = evidenceFiles(c.snapshot, gateLog(c));
      const files = retainedFiles(project, c, selected);
      const recordedLog = gateLog(c);
      for (const relative of ['.release-commit', recordedLog].filter(Boolean)) {
        if (!files.includes(relative)) files.push(relative);
      }
      const taggedFiles = selected.length - files.length;
      // Preview performs the same destination checks without creating anything.
      for (const relative of files) {
        const target = path.join(evidence, relative);
        safePath(project.identity, target);
        if (stat(target) && (!stat(target).isFile() || !fs.readFileSync(target).equals(fs.readFileSync(path.join(c.snapshot, relative))))) throw Error(`retained evidence differs: ${relative}`);
      }
      if (dryRun) { report.would_remove.push({ ...entry, evidence_files: files, unchanged_evidence_in_tag: taggedFiles }); continue; }
      fs.mkdirSync(evidence, { recursive: true });
      for (const relative of files) {
        const target = path.join(evidence, relative);
        safePath(project.identity, target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const source = fs.readFileSync(path.join(c.snapshot, relative));
        if (stat(target)) {
          if (!stat(target).isFile() || !fs.readFileSync(target).equals(source)) throw Error(`retained evidence differs: ${relative}`);
        } else fs.writeFileSync(target, source, { flag: 'wx' });
        sync(target);
        let parent = path.dirname(target);
        while (parent !== directory) { sync(parent); parent = path.dirname(parent); }
      }
      sync(directory);
      report.receipt = receipt;
      const evidenceManifest = selected.map(relative => ({ path: relative, sha256: digest(path.join(c.snapshot, relative)), retained: files.includes(relative) }));
      const removal = { ...entry, commit: c.commit, evidence, evidence_files: evidenceManifest.filter(item => item.retained).map(item => item.path), unchanged_evidence_in_tag: taggedFiles,
        snapshot_identity: directoryIdentity(s), evidence_manifest: evidenceManifest };
      append({ action: 'remove-intent', ...removal });
      // Recheck root and marker immediately before the only destructive step.
      safePath(project.identity, c.snapshot);
      if (JSON.stringify(directoryIdentity(fs.lstatSync(c.snapshot))) !== JSON.stringify(removal.snapshot_identity) || !stat(marker)?.isFile() || fs.readFileSync(marker, 'utf8').trim() !== c.commit) throw Error('snapshot ownership changed');
      validateIntent(project, c, removal, evidence, fs.lstatSync(c.snapshot));
      fs.rmSync(c.snapshot, { recursive: true });
      sync(root);
      append({ action: 'removed', ...removal });
      report.removed.push(removal);
    } catch (e) { report.refused.push({ ...entry, reason: e.message }); }
  }
  return report;
}
