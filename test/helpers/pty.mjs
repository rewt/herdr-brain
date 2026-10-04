// Dependency-free test transport for BSD script (Darwin) and util-linux script.
import { loadFactor, loadTimeout } from '../../lib/deadline.mjs';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
let cache;
function nativeOwner(source) {
  const digest = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (!cache) {
    cache = fs.mkdtempSync(path.join(process.env.HERDR_TEST_OFFLINE_ROOT ?? os.tmpdir(), 'pty-owner-'));
    process.once('exit', () => fs.rmSync(cache, { recursive: true, force: true }));
  }
  const owner = path.join(cache, digest);
  if (!fs.existsSync(owner)) {
    const built = spawnSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-o', owner, source], {
      encoding: 'utf8', timeout: loadTimeout(10000), killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin', TMPDIR: cache },
    });
    if (built.error || built.status) {
      fs.rmSync(owner, { force: true });
      throw Error(`PTY owner unavailable: ${built.error?.message ?? built.stderr}`);
    }
  }
  return owner;
}
export function runPTY(binary, args, options = {}) {
  const { ownerSource = fileURLToPath(new URL('./pty-owner.c', import.meta.url)), ...nativeOptions } = options;
  const factor = loadFactor();
  const maximum = loadTimeout(15000, factor);
  const timeout = Math.min(nativeOptions.timeout || maximum, maximum);
  const cleanupMs = loadTimeout(3000, factor);
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw Error('invalid PTY timeout');
  const owner = nativeOwner(ownerSource);
  const transport = ptyCommand(owner, [String(timeout), String(cleanupMs), binary, ...args], { exec: true });
  const responseMs = loadTimeout(timeout + cleanupMs, 1);
  // Only compilation is shared. Every invocation retains its own native session,
  // command deadline, cleanup window, descendant audit and signal authority.
  return spawnSync(transport.file, transport.args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...nativeOptions,
    timeout: responseMs, [commandAllowance]: responseMs, killSignal: 'SIGKILL',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--run') {
  const result = runPTY(process.argv[3], process.argv.slice(4));
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? result.error?.message ?? '');
  process.exitCode = result.status ?? 1;
}
