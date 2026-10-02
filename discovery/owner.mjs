// Bundled bytes have the same trust boundary as the installed product source.
// Verify them before copying into private scratch; never execute a project path.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPlainFile } from '../lib/files.mjs';
import { checkedDirectory } from './paths.mjs';

export const ownerTargets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
const native = fileURLToPath(new URL('./native/', import.meta.url));
const source = fileURLToPath(new URL('./process-supervisor.c', import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function verifyOwner(bytes, platform, arch) {
  if (!ownerTargets.includes(`${platform}-${arch}`)) throw new Error(`no bundled owner target for ${platform}-${arch}`);
  if (platform === 'darwin') {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(12) !== 2
      || bytes.readUInt32LE(4) !== (arch === 'arm64' ? 0x100000c : 0x1000007))
      throw new Error('validation owner Mach-O target mismatch');
  } else {
    if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== (arch === 'arm64' ? 183 : 62))
      throw new Error('validation owner ELF target mismatch');
    // The shipped Linux owner must not depend on an adopter's libc/loader.
    const start = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
    if (!Number.isSafeInteger(start) || size < 56 || !count || start + size * count > bytes.length)
      throw new Error('validation owner ELF program headers invalid');
    for (let i = 0; i < count; i++) if (bytes.readUInt32LE(start + size * i) === 3)
      throw new Error('validation owner ELF requires a dynamic loader');
  }
}

export function bundledOwner(platform = process.platform, arch = process.arch, directory = native) {
  const target = `${platform}-${arch}`;
  if (!ownerTargets.includes(target)) throw new Error(`no bundled owner target for ${target}`);
  const manifest = JSON.parse(readPlainFile(path.join(directory, 'manifest.json')));
  const entry = manifest.targets?.[target];
  if (manifest.version !== 1 || !entry || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? ''))
    throw new Error(`validation owner manifest missing ${target}`);
  if (entry.sourceSha256 !== sha256(readPlainFile(path.join(directory, '../process-supervisor.c'), null)))
    throw new Error('validation owner source checksum mismatch; rebuild bundled owners');
  const bytes = readPlainFile(path.join(directory, `owner-${target}`), null);
  if (sha256(bytes) !== entry.sha256) throw new Error('validation owner binary checksum mismatch');
  verifyOwner(bytes, platform, arch);
  return bytes;
}

export function prepareOwner() {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('validation descendant containment unavailable on this platform');
  // Ignore agent-controlled TMPDIR, CC and compiler flags. The provider cannot
  // write this directory, or redirect the verified bytes after they are copied.
  const directory = fs.mkdtempSync(path.join(checkedDirectory('/tmp'), 'monitor-owner-'));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    fs.chmodSync(directory, 0o700); checkedDirectory(directory);
    const executable = path.join(directory, 'owner');
    let bytes;
    try { bytes = bundledOwner(); }
    catch (error) {
      const reason = error.message;
      console.error(`validation prebuilt owner unavailable (${reason}); trying /usr/bin/cc`);
      const built = spawnSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-o', executable, source], {
        timeout: 15000, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', TMPDIR: directory },
      });
      if (built.error || built.status !== 0) throw new Error(`validation owner unavailable: no verified prebuilt owner (${reason}); source build failed: ${built.error?.message ?? built.stderr}`);
    }
    if (bytes) fs.writeFileSync(executable, bytes, {
      flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode: 0o500,
    });
    const fd = fs.openSync(executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const identity = fs.fstatSync(fd);
      if (!identity.isFile() || identity.uid !== process.getuid()) throw new Error('validation owner identity changed');
      if (bytes && sha256(fs.readFileSync(fd)) !== sha256(bytes)) throw new Error('validation owner copy checksum mismatch');
      // Retain the source-built owner's protocol mode. The private directory
      // and provider's read-only boundary prevent project access or replacement.
      fs.fchmodSync(fd, 0o755);
    } finally { fs.closeSync(fd); }
    return { executable, cleanup };
  } catch (error) { cleanup(); throw error; }
}
