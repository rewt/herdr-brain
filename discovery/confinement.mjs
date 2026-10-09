// Trusted session parents select these paths from their creation receipts.
// The child cannot supply or relax shared-state exclusions through requests.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { socketFilter } from './bubblewrap.mjs';
import { checkedDirectory, within } from './paths.mjs';

export const EXPERIMENTAL_BUBBLEWRAP = 'experimental-bubblewrap:';
const experimentalRefusal = 'bubblewrap is experimental and disabled by default pending ENG-92; explicitly select --validator experimental-bubblewrap:/absolute/path/to/bwrap for experimental use';
export function selectSandbox(binary = 'auto', { platform = process.platform } = {}) {
  if (binary.startsWith(EXPERIMENTAL_BUBBLEWRAP)) {
    const executable = binary.slice(EXPERIMENTAL_BUBBLEWRAP.length);
    if (!path.isAbsolute(executable) || executable.includes('\0')) throw new Error('experimental bubblewrap requires an absolute executable path');
    // Keep the explicit selection intact through entry and Git filter transport.
    return binary;
  }
  if (binary !== 'auto') {
    let target = binary;
    try { target = fs.realpathSync(binary); } catch {}
    if ([binary, target].some((file) => path.basename(file) === 'bwrap')) throw new Error(experimentalRefusal);
    return binary;
  }
  // Never discover bubblewrap automatically, even when it is on PATH. Existing
  // Codex installs already select their native provider explicitly by default.
  if (platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) return '/usr/bin/sandbox-exec';
  throw new Error(`no native validation sandbox available; select --validator /absolute/native/codex; ${experimentalRefusal}`);
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

export const toml = (value) => typeof value === 'object'
  ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`
  : JSON.stringify(value);

export function sandboxCommand(binary, cwd, { sharedPaths, writablePaths = [], temporaryPaths = [], runtimePaths = [], lifetime = null, native = false, network = native, hostSuite = null }) {
  if (!binary) throw new Error('a native sandbox is required for main-checkout workers');
  if (!Array.isArray(sharedPaths) || !sharedPaths.length || [...sharedPaths, ...writablePaths, ...temporaryPaths, ...runtimePaths].some((file) => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) {
    throw new Error('sandbox requires absolute shared-state paths from the session parent');
  }
  binary = selectSandbox(binary);
  if (hostSuite && (process.platform !== 'darwin' || binary !== '/usr/bin/sandbox-exec' || native || network || temporaryPaths.length !== 1))
    throw Error('HOST_PROFILE_UNAVAILABLE: host suites require macOS sandbox-exec and one private run temp');
  if (hostSuite?.external_network?.length) throw Error('HOST_PROFILE_UNAVAILABLE: Seatbelt cannot enforce external host:port addresses; refusing the declared allowlist');
  const experimentalBubblewrap = binary.startsWith(EXPERIMENTAL_BUBBLEWRAP);
  if (experimentalBubblewrap) binary = binary.slice(EXPERIMENTAL_BUBBLEWRAP.length);
  cwd = checkedDirectory(cwd);
  if (lifetime) {
    const root = checkedDirectory(path.dirname(lifetime.allowed));
    if (native || path.dirname(lifetime.denied) !== root || !path.basename(root).startsWith('monitor-lifetime-')
      || !/^probe-[a-f0-9-]+$/u.test(path.basename(lifetime.allowed)) || !/^probe-[a-f0-9-]+$/u.test(path.basename(lifetime.denied)) || lifetime.allowed === lifetime.denied) throw new Error('invalid validation lifetime marker');
    for (const file of [lifetime.allowed, lifetime.denied]) {
      const entry = fs.lstatSync(file);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid() || (entry.mode & 0o222) || fs.realpathSync(file) !== file) throw new Error('redirected validation lifetime marker');
    }
  }
  const protectedInput = [path.join(cwd, '.git'), ...sharedPaths];
  const protectedPaths = [...new Set(protectedInput.flatMap((file) => [file, resolved(file)]))];
  if (runtimePaths.length && !network) throw new Error('validation cannot grant external runtime writes');
  const workspaceWrites = writablePaths.map(checkedDirectory);
  if (!native && workspaceWrites.some((file) => !within(cwd, file))) throw new Error('sandbox writable exception must stay within the assigned checkout');
  const writable = [...workspaceWrites, ...temporaryPaths.map(checkedDirectory), ...runtimePaths.map(checkedDirectory)];
  const gitPaths = [path.join(cwd, '.git'), resolved(path.join(cwd, '.git'))];
  for (const file of writable) {
    if (gitPaths.some((git) => within(git, file) || within(file, git)) || protectedPaths.some((protectedPath) => within(file, protectedPath)))
      throw new Error('sandbox writable exception overlaps protected state');
  }
  if (path.basename(binary) === 'sandbox-exec') {
    const match = (file) => `(subpath ${JSON.stringify(file)})`;
    // A single predicate makes exclusions independent of rule ordering. Queue
    // and temporary exceptions can only be supplied by the trusted parent.
    const allowed = native ? '(subpath "/")' : match(cwd);
    const excluded = `(require-not (require-any ${protectedPaths.map(match).join(' ')}))`;
    const exceptions = writable.map((file) => {
      // A trusted queue/temp grant can sit beneath a protected directory, but
      // must never override protected siblings or descendants. Keep the scope
      // predicate too, so a raced temp alias cannot grant outside-checkout IO.
      const exclusions = protectedPaths.filter((protectedPath) => !within(resolved(protectedPath), file));
      const scoped = !native && workspaceWrites.includes(file) ? ` ${match(cwd)}` : '';
      return `(require-all ${match(file)}${scoped} (require-not (require-any ${exclusions.map(match).join(' ')})))`;
    });
    const profile = `(version 1)\n(allow default)\n${network ? '' : '(deny network*)\n'}${lifetime ? '(deny signal)\n(allow signal (target self) (target children) (target same-sandbox))\n' : ''}(deny file-write*)\n`
      + `(allow file-write* (literal "/dev/null") (require-all ${allowed} ${excluded})${exceptions.length ? ` ${exceptions.join(' ')}` : ''})\n`;
    let host = '';
    if (hostSuite) {
      // Read-only process enumeration stays available; signals and task ports
      // stay within this invocation's inherited sandbox, including descendants.
      host += '(allow process-info*)\n(deny signal mach-priv-task-port)\n(allow signal (target self) (target children) (target same-sandbox))\n(allow mach-priv-task-port (target same-sandbox))\n';
      // Seatbelt includes wildcard local addresses in localhost. The operator
      // accepts inbound peers for these host tests; external egress stays denied.
      if (hostSuite.localhost) host += '(allow network-bind network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))\n';
      if (hostSuite.unix_sockets) {
        const temp = checkedDirectory(temporaryPaths[0]);
        host += `(allow system-socket (socket-domain AF_UNIX))\n(allow network-bind (local unix-socket ${match(temp)}))\n(allow network-outbound (remote unix-socket ${match(temp)}))\n`;
      }
      if (hostSuite.pty) host += '(allow pseudo-tty)\n(allow file-ioctl file-read* file-write* (literal "/dev/ptmx") (regex #"^/dev/ttys"))\n';
    }
    return { binary, args: ['-p', profile + host + (lifetime ? `(deny file-read* (literal ${JSON.stringify(lifetime.denied)}))\n` : '')] };
  }
  if (experimentalBubblewrap) {
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
      return { binary: process.execPath, args: [fileURLToPath(new URL('./bubblewrap.mjs', import.meta.url)), '--experimental-bubblewrap', binary, ...args] };
    }
    return { binary, args };
  }
  // The native wrapper adds exclusions to the harness process, without replacing
  // its own tool sandbox, account/runtime writes, network or approval settings.
  // Validation instead grants writes only in the workspace and disables network.
  const filesystem = { ':root': native ? 'write' : 'read', ':workspace_roots': { '.': 'write', '.git': 'read' },
    ...Object.fromEntries(sharedPaths.map((file) => [file, 'read'])),
    ...(lifetime ? { [lifetime.denied]: 'none' } : {}),
    ...Object.fromEntries(writable.map((file) => [file, 'write'])) };
  const profile = native ? 'monitor-main-worker' : 'monitor-validation';
  return { binary, args: ['sandbox', '--permission-profile', profile, '--include-managed-config', '-C', cwd,
    '-c', `permissions.${profile}.filesystem=${toml(filesystem)}`,
    '-c', `permissions.${profile}.network.enabled=${network}`, '--'] };
}
