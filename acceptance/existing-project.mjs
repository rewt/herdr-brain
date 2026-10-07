import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { callerInventory } from './cutover.mjs';

// Source and support files are discovered without consulting Git: supervisor
// helpers and the documents they read are often untracked in existing projects.
const supportFile = /\.(?:sh|bash|zsh|mjs|cjs|js|py|md|markdown|txt|json|ya?ml|toml|plist|html|css)$/i;
export function supervisorRuntime(relative) {
  if (!relative.startsWith('.lane/supervisor/')) return false;
  const parts = relative.slice('.lane/supervisor/'.length).split('/');
  return parts.some(name => /^(?:outbox|inbox|logs?|watch-logs|runtime|state|tmp|cache|__pycache__|node_modules|\.git)$/i.test(name)
    || /(?:^|[-_])logs?$/i.test(name) || /\.log(?:\.\d+)?$/i.test(name)
    || /(?:^|[-_.])queue(?:\.(?:txt|tsv|json|jsonl))?$/i.test(name)
    || /\.(?:jsonl|tsv|pid|lock|flock|sock|socket|pyc)$/i.test(name)
    || /^(?:OPEN-STATE\.md|TODAY\.md|GAPS\.md|file-woken\.txt|engineer-gates-off)$/i.test(name)
    || /^(?:checkpoint|monitoring)-\d/i.test(name));
}

export function existingProjectFiles(live) {
  const files = new Set(['.claude/skills/lane/SKILL.md', 'scripts/lane/launch-supervisor.mjs',
    'scripts/lane/routing.mjs', 'scripts/lane/routing.json', 'scripts/lane/routing.test.mjs', 'scripts/lane/lane.mjs']);
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(live, relative), { withFileTypes: true })) {
      const rel = `${relative}/${entry.name}`;
      if (supervisorRuntime(rel)) continue;
      if (entry.isSymbolicLink()) throw new Error(`supervisor copy refuses symlink ${rel}`);
      if (entry.isDirectory()) visit(rel);
      else if (entry.isFile() && supportFile.test(entry.name)) files.add(rel);
    }
  }
  visit('.lane/supervisor');
  // Preserve the retirement proof: referenced script backups remain executable
  // callers, while only unreferenced timestamped backups become historical.
  const inventory = callerInventory(live, { exclude: file => supervisorRuntime(path.relative(live, file)) });
  for (const file of inventory.active) files.add(path.relative(live, file));
  return { files: [...files].sort(), historical: inventory.historical.map(file => path.relative(live, file)) };
}

export function copyExistingProject({ live, copy, backup }) {
  const selected = existingProjectFiles(live);
  const copyFile = (rel, destinations) => {
    const src = path.join(live, rel), st = fs.lstatSync(src);
    if (!st.isFile()) throw new Error(`copy regular support files only: ${rel}`);
    const bytes = fs.readFileSync(src), mode = st.mode & 0o777;
    for (const destination of destinations) {
      const file = path.join(destination, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes); fs.chmodSync(file, mode);
    }
    return { file: rel, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mode };
  };
  return {
    files: selected.files.map(rel => copyFile(rel, [copy, backup])),
    historical: selected.historical.map(rel => ({ ...copyFile(rel, [path.join(backup, 'historical-callers')]),
      reason: 'timestamped script backup; no active source reference' })),
  };
}
