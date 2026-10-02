#!/usr/bin/env node
// Maintainer-only rebuild. Runtime provisioning never reads compiler overrides.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ownerTargets, bundledOwner, sha256, verifyOwner } from '../owner.mjs';

const { values } = parseArgs({ options: {
  target: { type: 'string', default: `${process.platform}-${process.arch}` },
  zig: { type: 'string' }, check: { type: 'boolean', default: false },
} });
const directory = import.meta.dirname, source = path.join(directory, '../process-supervisor.c');
if (values.check) {
  for (const target of ownerTargets) {
    const [platform, arch] = target.split('-'); bundledOwner(platform, arch);
    console.log(`verified ${target}`);
  }
} else {
  if (!ownerTargets.includes(values.target)) throw new Error(`unsupported owner target: ${values.target}`);
  const [platform, arch] = values.target.split('-');
  if (platform === 'darwin' && process.platform !== 'darwin') throw new Error('macOS rebuild requires the macOS SDK');
  if (platform === 'linux' && (!values.zig || !path.isAbsolute(values.zig)))
    throw new Error('portable Linux rebuild requires --zig ABSOLUTE_ZIG_EXECUTABLE');
  if (platform === 'darwin' && values.zig) throw new Error('macOS rebuild uses /usr/bin/cc and the host SDK');
  const temporary = fs.mkdtempSync(path.join(directory, '.build-'));
  try {
    const binary = platform === 'darwin' ? '/usr/bin/cc' : values.zig;
    const flags = platform === 'darwin'
      ? ['-arch', arch === 'arm64' ? 'arm64' : 'x86_64', '-mmacosx-version-min=11.0']
      : ['cc', '-target', arch === 'arm64' ? 'aarch64-linux-musl' : 'x86_64-linux-musl', '-static', '-s', '-Wl,--build-id=none'];
    const env = { PATH: '/usr/bin:/bin', TMPDIR: temporary,
      ZIG_GLOBAL_CACHE_DIR: path.join(temporary, 'cache'), ZIG_LOCAL_CACHE_DIR: path.join(temporary, 'local') };
    function run(args) {
      const result = spawnSync(binary, args, { timeout: 180000, encoding: 'utf8', env });
      if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
      return result.stdout.trim();
    }
    const compiler = run(platform === 'darwin' ? ['--version'] : ['version']);
    const filename = `owner-${values.target}`, output = path.join(temporary, filename);
    run([...flags, '-O2', '-Wall', '-Wextra', '-o', output, source]);
    const bytes = fs.readFileSync(output); verifyOwner(bytes, platform, arch);
    const manifestFile = path.join(directory, 'manifest.json');
    const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { version: 1, targets: {} };
    if (manifest.version !== 1) throw new Error('unsupported owner manifest version');
    manifest.targets[values.target] = { sha256: sha256(bytes), sourceSha256: sha256(fs.readFileSync(source)), compiler,
      flags: [...flags, '-O2', '-Wall', '-Wextra'] };
    fs.chmodSync(output, 0o755); fs.renameSync(output, path.join(directory, filename));
    const manifestTemporary = path.join(temporary, 'manifest.json');
    fs.writeFileSync(manifestTemporary, JSON.stringify(manifest, null, 2) + '\n');
    fs.renameSync(manifestTemporary, manifestFile);
    console.log(`rebuilt ${values.target}: ${manifest.targets[values.target].sha256}`);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
