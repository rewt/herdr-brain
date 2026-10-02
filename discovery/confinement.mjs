// Trusted session parents select these paths from their creation receipts.
// The child cannot supply or relax shared-state exclusions through requests.
import path from 'node:path';

const toml = (value) => typeof value === 'object'
  ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`
  : JSON.stringify(value);

export function sandboxCommand(binary, cwd, { sharedPaths, writablePaths = [], native = false }) {
  if (!binary) throw new Error('a native sandbox is required for main-checkout workers');
  if (!Array.isArray(sharedPaths) || !sharedPaths.length || [...sharedPaths, ...writablePaths].some((file) => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) {
    throw new Error('sandbox requires absolute shared-state paths from the session parent');
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
    '-c', `permissions.${profile}.network.enabled=${native}`, '--'] };
}
