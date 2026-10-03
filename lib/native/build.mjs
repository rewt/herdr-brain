// Maintainer-only Darwin rebuild; test runners never invoke a compiler.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const directory = import.meta.dirname;
const source = path.join(directory, '../process-source.c');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = { version: 1, sourceSha256: sha256(fs.readFileSync(source)), targets: {} };
if (process.platform !== 'darwin') throw Error('Darwin process source rebuild requires the macOS SDK');
for (const arch of ['arm64', 'x64']) {
  const target = `darwin-${arch}`, output = path.join(directory, `process-source-${target}`);
  const flags = ['-arch', arch === 'x64' ? 'x86_64' : arch, '-mmacosx-version-min=11.0', '-O2', '-Wall', '-Wextra'];
  const result = spawnSync('/usr/bin/cc', [...flags, '-o', output, source], { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) throw Error(result.error?.message ?? result.stderr);
  manifest.targets[target] = { sha256: sha256(fs.readFileSync(output)), flags };
}
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
