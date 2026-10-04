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

function evidenceFiles(snapshot) {
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
  return files;
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
      if (!s) { report.kept.push({ ...entry, reason: 'snapshot already absent' }); continue; }
      if (!s.isDirectory()) throw Error('snapshot is not a directory');
      const marker = path.join(c.snapshot, '.release-commit');
      if (!stat(marker)?.isFile() || fs.readFileSync(marker, 'utf8').trim() !== c.commit) throw Error('snapshot ownership marker differs');
      const tag = spawnSync('git', ['-C', project.canonical, 'rev-parse', '--verify', `refs/tags/${c.tag}^{commit}`], { encoding: 'utf8' });
      if (tag.error || tag.status !== 0 || tag.stdout.trim() !== c.commit) throw Error('candidate tag is missing or moved; snapshot cannot be rebuilt');
      const selected = evidenceFiles(c.snapshot), files = retainedFiles(project, c, selected);
      const taggedFiles = selected.length - files.length;
      const evidence = path.join(directory, 'evidence', c.tag);
      safePath(project.identity, evidence);
      if (stat(evidence) && !stat(evidence).isDirectory()) throw Error('retained evidence path is not a directory');
      const receipt = path.join(directory, 'retention.jsonl');
      safePath(project.identity, receipt);
      if (stat(receipt) && !stat(receipt).isFile()) throw Error('retention receipt is not a regular file');
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
      safePath(project.identity, receipt);
      if (stat(receipt) && !stat(receipt).isFile()) throw Error('retention receipt is not a regular file');
      const append = value => {
        const fd = fs.openSync(receipt, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n'); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        sync(directory);
      };
      report.receipt = receipt;
      const removal = { ...entry, commit: c.commit, evidence, evidence_files: files, unchanged_evidence_in_tag: taggedFiles };
      append({ action: 'remove-intent', ...removal });
      // Recheck root and marker immediately before the only destructive step.
      safePath(project.identity, c.snapshot);
      if (fs.readFileSync(marker, 'utf8').trim() !== c.commit) throw Error('snapshot ownership changed');
      fs.rmSync(c.snapshot, { recursive: true });
      sync(root);
      append({ action: 'removed', ...removal });
      report.removed.push(removal);
    } catch (e) { report.refused.push({ ...entry, reason: e.message }); }
  }
  return report;
}
