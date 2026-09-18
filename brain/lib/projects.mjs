// Project names for captured results come from the same configuration the
// console uses. A result always gets a name: folders outside configured
// projects are deliberately grouped under "other".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configPath(env = process.env) {
  return env.HERDR_ORG_CONSOLE_CONFIG || path.join(os.homedir(), '.config', 'herdr-org', 'console.json');
}

export function loadProjects(file = configPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (Array.isArray(raw?.projects) ? raw.projects : [])
      .filter((p) => p?.name && p?.cwd)
      .map((p) => ({ name: String(p.name), cwd: path.resolve(String(p.cwd).replace(/^~(?=$|\/)/, os.homedir())) }));
  } catch {
    return [];
  }
}

function within(folder, root) {
  const rel = path.relative(root, folder);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function worktreeCheckout(folder) {
  const parts = path.resolve(folder).split(path.sep).filter(Boolean);
  const hidden = parts.lastIndexOf('.worktrees');
  if (hidden >= 0 && parts[hidden + 1]) return parts[hidden + 1];
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    if (parts[i] === '.herdr' && parts[i + 1] === 'worktrees' && parts[i + 2]) return parts[i + 2];
  }
  return null;
}

export function projectForFolder(folder, projects) {
  if (typeof folder !== 'string' || !folder) return 'other';
  const resolved = path.resolve(folder);
  const direct = projects
    .filter((p) => p?.name && p?.cwd && within(resolved, path.resolve(p.cwd)))
    .sort((a, b) => path.resolve(b.cwd).length - path.resolve(a.cwd).length)[0];
  if (direct) return direct.name;

  const checkout = worktreeCheckout(resolved);
  const linked = checkout && projects.find((p) => p?.name && p?.cwd && path.basename(path.resolve(p.cwd)) === checkout);
  return linked?.name ?? 'other';
}

export function withProject(entry, projects) {
  const configured = projects ?? loadProjects();
  const project = configured.length ? projectForFolder(entry?.where, configured) : (entry?.project ?? 'other');
  return { ...entry, project };
}
