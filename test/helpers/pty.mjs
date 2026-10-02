// Dependency-free test transport for BSD script (Darwin) and util-linux script.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function findScript() {
  const candidates = process.env.TEST_PTY_SCRIPT ? [process.env.TEST_PTY_SCRIPT]
    : (process.env.PATH ?? '').split(path.delimiter).map((directory) => path.join(directory, 'script'));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); } catch {}
  }
}
export const SCRIPT = findScript();
export const PTY_SKIP_REASON = !['darwin', 'linux'].includes(process.platform)
  ? 'PTY tests require Darwin BSD script or Linux util-linux script'
  : !SCRIPT ? 'PTY tests require an installed script executable' : false;
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
export function ptyCommand(binary, args, { platform = process.platform, executable = SCRIPT } = {}) {
  if (!executable) throw new Error('PTY tests require an installed script executable');
  if (platform === 'darwin') return { file: executable, args: ['-q', '/dev/null', binary, ...args] };
  if (platform === 'linux') return { file: executable, args: ['-q', '-e', '-c', [binary, ...args].map(quote).join(' '), '/dev/null'] };
  throw new Error(`unsupported PTY test platform: ${platform}`);
}
export function runPTY(binary, args, options = {}) {
  const transport = ptyCommand(binary, args);
  return spawnSync(transport.file, transport.args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, ...options,
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--run') {
  const result = runPTY(process.argv[3], process.argv.slice(4));
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? result.error?.message ?? '');
  process.exitCode = result.status ?? 1;
}
