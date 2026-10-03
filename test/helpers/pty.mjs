// Dependency-free test transport for BSD script (Darwin) and util-linux script.
import { loadFactor, loadTimeout } from '../../lib/deadline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commandAllowance } from './command-allowance.mjs';

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
export function ptyCommand(binary, args, { platform = process.platform, executable = SCRIPT, exec = false } = {}) {
  if (!executable) throw new Error('PTY tests require an installed script executable');
  if (platform === 'darwin') return { file: executable, args: ['-q', '/dev/null', binary, ...args] };
  if (platform === 'linux') return { file: executable, args: ['-q', '-e', '-c', `${exec ? 'exec ' : ''}${[binary, ...args].map(quote).join(' ')}`, '/dev/null'] };
  throw new Error(`unsupported PTY test platform: ${platform}`);
}
export function runPTY(binary, args, options = {}) {
  const factor = loadFactor();
  const maximum = loadTimeout(15000, factor);
  const timeout = Math.min(options.timeout || maximum, maximum);
  const cleanupMs = loadTimeout(3000, factor);
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw Error('invalid PTY timeout');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-pty-owner-'));
  try {
    const owner = path.join(scratch, 'owner');
    const built = spawnSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-o', owner,
      fileURLToPath(new URL('./pty-owner.c', import.meta.url))], {
      encoding: 'utf8', timeout: loadTimeout(10000), killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin', TMPDIR: scratch },
    });
    if (built.error || built.status) throw Error(`PTY owner unavailable: ${built.error?.message ?? built.stderr}`);
    const transport = ptyCommand(owner, [String(timeout), String(cleanupMs), binary, ...args], { exec: true });
    const responseMs = loadTimeout(timeout + cleanupMs, 1);
    // script's timeout may kill its transport first. The native owner lives in
    // the independent PTY session and still completes bounded descendant cleanup.
    return spawnSync(transport.file, transport.args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
      timeout: responseMs, [commandAllowance]: responseMs, killSignal: 'SIGKILL',
    });
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--run') {
  const result = runPTY(process.argv[3], process.argv.slice(4));
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? result.error?.message ?? '');
  process.exitCode = result.status ?? 1;
}
