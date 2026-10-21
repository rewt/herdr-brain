// Optional offline acceptance input, never a product dependency or a download.
// Freeze an existing fixture tool installation into one hash-locked artifact.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function createRuntimeArtifact({ modules, manager, target }) {
  fs.mkdirSync(target, { recursive: true });
  const root = path.join(target, 'seed'), destination = path.join(root, 'node_modules');
  fs.mkdirSync(destination, { recursive: true });
  const seen = new Set(), versions = [];
  const locate = (name, at) => {
    for (let current = at; ; current = path.dirname(current)) {
      const candidate = path.join(current, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (current === path.dirname(current)) return null;
    }
  };
  const copy = directory => {
    directory = fs.realpathSync(directory);
    if (seen.has(directory)) return;
    seen.add(directory);
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const to = path.join(destination, pkg.name);
    if (!fs.existsSync(to)) fs.cpSync(directory, to, { recursive: true, dereference: true });
    versions.push({ name: pkg.name, version: pkg.version });
    for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])) {
      const dependency = locate(name, directory);
      if (dependency) copy(dependency);
      else if (Object.hasOwn(pkg.dependencies ?? {}, name)) throw Error(`offline fixture lacks ${name}`);
    }
  };
  for (const name of ['vitest', 'typescript']) copy(path.join(modules, name));
  fs.cpSync(manager, path.join(destination, 'pnpm'), { recursive: true, dereference: true });
  versions.push({ name: 'pnpm', version: JSON.parse(fs.readFileSync(path.join(manager, 'package.json'), 'utf8')).version });
  fs.mkdirSync(path.join(destination, '.bin'), { recursive: true });
  for (const [name, entry] of [['pnpm', '../pnpm/bin/pnpm.cjs'], ['vitest', '../vitest/vitest.mjs'], ['tsc', '../typescript/bin/tsc']])
    fs.symlinkSync(entry, path.join(destination, '.bin', name));
  const artifact = path.join(target, 'runtime.tar');
  execFileSync('tar', ['-cf', artifact, '-C', root, 'node_modules'], { stdio: 'pipe' });
  const sha256 = createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  fs.writeFileSync(path.join(target, 'runtime.json'), JSON.stringify({ artifact, sha256, versions }, null, 2) + '\n');
  return { artifact, sha256, versions: versions.filter(row => ['pnpm', 'typescript', 'vitest'].includes(row.name)) };
}
