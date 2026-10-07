// Resolve at launch: stable harness launchers can move between versioned releases.
import fs from 'node:fs';
import path from 'node:path';

export function resolveNative(kind, { entryBin, fallback, env = process.env } = {}) {
  const canonical = file => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
  const excluded = entryBin && canonical(entryBin);
  function executable(candidate) {
    const directory = path.dirname(candidate);
    // Skip all managed entry directories, including aliases and older installs.
    if (canonical(directory) === excluded || fs.existsSync(path.join(directory, '.monitor-entry.json'))) return false;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const target = fs.realpathSync(candidate);
      if (canonical(path.dirname(target)) === excluded || fs.existsSync(path.join(path.dirname(target), '.monitor-entry.json'))) return false;
      return fs.statSync(target).isFile();
    } catch { return false; }
  }
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.resolve(directory || '.', kind);
    if (executable(candidate)) return candidate; // Keep the stable launcher/symlink.
  }
  // Explicit installs outside PATH retain their launcher as a last resort.
  if (fallback && path.isAbsolute(fallback) && executable(fallback)) return fallback;
  throw new Error(`native ${kind} is unavailable; put its current launcher on PATH outside Monitor entry directories`);
}
