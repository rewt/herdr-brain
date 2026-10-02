// Trusted session parents select these paths from their creation receipts.
// The child cannot supply or relax shared-state exclusions through requests.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { socketFilter } from './bubblewrap.mjs';

export function selectSandbox(binary = 'auto', { platform = process.platform, searchPath = process.env.PATH ?? '' } = {}) {
  if (binary !== 'auto') return binary;
  // Never fall back to an unsandboxed shell. Explicit Codex providers retain
  // their managed profile; auto uses the host kernel without a model harness.
  if (platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) return '/usr/bin/sandbox-exec';
  if (platform === 'linux') for (const directory of searchPath.split(path.delimiter)) {
    const file = path.join(directory, 'bwrap');
    try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file); } catch {}
  }
  throw new Error('no native validation sandbox available; install bubblewrap or select a Codex validator');
}

const resolved = (file) => {
  // Resolve existing ancestors too: /tmp and operator-selected symlink roots
  // must not create aliases that escape a read-only exclusion.
  try { return fs.realpathSync(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(resolved(parent), path.basename(file));
  }
};

const toml = (value) => typeof value === 'object'
  ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`
  : JSON.stringify(value);

export function sandboxCommand(binary, cwd, { sharedPaths, writablePaths = [], native = false, network = native }) {
  if (!binary) throw new Error('a native sandbox is required for main-checkout workers');
  if (!Array.isArray(sharedPaths) || !sharedPaths.length || [...sharedPaths, ...writablePaths].some((file) => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) {
    throw new Error('sandbox requires absolute shared-state paths from the session parent');
  }
  binary = selectSandbox(binary);
  cwd = resolved(cwd);
  const protectedInput = [path.join(cwd, '.git'), ...sharedPaths];
  const protectedPaths = [...new Set(protectedInput.flatMap((file) => [file, resolved(file)]))];
  const writable = writablePaths.map(resolved);
  if (path.basename(binary) === 'sandbox-exec') {
    const match = (file) => `(subpath ${JSON.stringify(file)})`;
    // A single predicate makes exclusions independent of rule ordering. Queue
    // and temporary exceptions can only be supplied by the trusted parent.
    const allowed = native ? '(subpath "/")' : match(cwd);
    const excluded = `(require-not (require-any ${protectedPaths.map(match).join(' ')}))`;
    const profile = `(version 1)\n(allow default)\n${network ? '' : '(deny network*)\n'}(deny file-write*)\n`
      + `(allow file-write* (literal "/dev/null") (require-all ${allowed} ${excluded})${writable.length ? ` ${writable.map(match).join(' ')}` : ''})\n`;
    return { binary, args: ['-p', profile] };
  }
  if (path.basename(binary) === 'bwrap') {
    for (const file of protectedInput) {
      const relative = path.relative(cwd, file);
      const inside = relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
      if ((native || inside) && fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
        throw new Error('bubblewrap cannot protect a writable shared-state symlink; select Codex or sandbox-exec');
    }
    const args = ['--die-with-parent', '--unshare-pid', ...(!network ? ['--unshare-net'] : []), '--new-session', native ? '--bind' : '--ro-bind', '/', '/'];
    if (!native) args.push('--bind', cwd, cwd);
    // Existing mounts protect entire descendants and prevent unlink/rename.
    // Missing protected paths cannot be bind-mounted: fail rather than weaken.
    for (const file of protectedPaths) {
      if (!fs.existsSync(file)) throw new Error(`sandbox protected path is missing: ${file}`);
      args.push('--ro-bind', file, file);
    }
    for (const file of writable) args.push('--bind', file, file);
    args.push('--proc', '/proc', '--dev', '/dev', '--chdir', cwd, '--');
    if (!network) {
      socketFilter(); // Refuse unsupported ABIs before creating a child.
      return { binary: process.execPath, args: [fileURLToPath(new URL('./bubblewrap.mjs', import.meta.url)), binary, ...args] };
    }
    return { binary, args };
  }
  // The native wrapper adds exclusions to the harness process, without replacing
  // its own tool sandbox, account/runtime writes, network or approval settings.
  // Validation instead grants writes only in the workspace and disables network.
  const filesystem = { ':root': native ? 'write' : 'read', ':workspace_roots': { '.': 'write', '.git': 'read' },
    ...Object.fromEntries(sharedPaths.map((file) => [file, 'read'])),
    ...Object.fromEntries(writablePaths.map((file) => [file, 'write'])) };
  const profile = native ? 'monitor-main-worker' : 'monitor-validation';
  return { binary, args: ['sandbox', '--permission-profile', profile, '--include-managed-config', '-C', cwd,
    '-c', `permissions.${profile}.filesystem=${toml(filesystem)}`,
    '-c', `permissions.${profile}.network.enabled=${network}`, '--'] };
}
