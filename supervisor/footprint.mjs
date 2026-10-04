// Advisory, bounded local disk measurement. Never follows directory symlinks.
import fs from 'node:fs';
import path from 'node:path';

export function measureArea(directory, { maxEntries = 100000, maxMs = 1000 } = {}) {
  let bytes = 0, apparent = 0, entries = 0;
  const pending = [directory], seen = new Set(), started = Date.now();
  const warnings = new Set();
  while (pending.length) {
    if (entries >= maxEntries || Date.now() - started >= maxMs) { warnings.add('measurement limit reached; size is a lower bound'); break; }
    const file = pending.pop();
    try {
      const s = fs.lstatSync(file);
      entries++;
      const key = `${s.dev}:${s.ino}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bytes += s.blocks == null ? s.size : s.blocks * 512;
      apparent += s.size;
      if (s.isDirectory()) for (const name of fs.readdirSync(file)) pending.push(path.join(file, name));
      if (s.isSymbolicLink()) warnings.add('symlink targets excluded');
    } catch (e) {
      if (e.code !== 'ENOENT' || file !== directory) warnings.add(`${e.code || 'read error'}; size is a lower bound`);
    }
  }
  return { path: directory, bytes, apparent_bytes: apparent, entries, warning: [...warnings].join('; ') || null };
}

export function projectFootprint(project, org) {
  return [
    ['record', org], ['release', path.join(project.identity, 'release')],
    ['lane validation', path.join(project.identity, 'lane-validation')], ['promote batches', path.join(project.identity, 'promote')],
  ].map(([area, directory]) => ({ area, ...measureArea(directory) }));
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
