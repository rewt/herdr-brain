// Native settings only: no outer sandbox or grant protocol.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { projectFleet, readFleet, excludedFleetRoot } from '../lib/fleet.mjs';
import { gitProject } from '../lib/project.mjs';
import { removePlainDirectory, writeFileAtomic } from '../lib/files.mjs';
import { checkedDirectory, within } from './paths.mjs';
import { runTemporary, temporaryEnvironment } from './temporary.mjs';
import { toml } from './confinement.mjs';
import { claudeSettingsSources, codexPermissionChoice } from './native-settings.mjs';
import { coordinatingRole, herdrControlSocket, socketProbeArguments } from './control-socket.mjs';
import { resolveNative } from './native-binary.mjs';
import { permissionHookArguments } from '../supervisor/permission-hooks.mjs';
import { claudeUtility, codexUtility, nativeSubcommand } from './native-command.mjs';

// Read-only preflight shared with default chat selection. Do this before a
// launcher creates a tab or temporary run, and never rewrite native settings.
export function codexCoordinatingPreflight({ binary, entryBin, args, context, env = process.env }) {
  const choice = codexPermissionChoice(context, args, env);
  const explicit = codexPermissionChoice(context, args, env, { cliOnly: true });
  const conflict = explicit ?? (choice?.setting === 'sandbox_mode' ? choice : null);
  if (conflict) throw new Error(`coordinating codex launch requires the generated permission profile; remove ${conflict.setting}=${JSON.stringify(conflict.value)} from ${conflict.source} (legacy sandbox selectors take precedence over native permission profiles)`);
  if (!binary) {
    let receipt = {};
    try { receipt = JSON.parse(fs.readFileSync(path.join(entryBin, '.monitor-entry.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    binary = resolveNative('codex', { entryBin, fallback: receipt.native, explicit: receipt.nativeExplicit, env });
  }
  const options = { cwd: context.workspace, env, encoding: 'utf8', timeout: 5000 };
  const help = spawnSync(binary, ['--help'], options);
  if (help.status !== 0 || !/--sandbox\b/u.test(help.stdout) || !/--add-dir\b/u.test(help.stdout))
    throw new Error('codex has no supported native sandbox options for a coordinating launch');
  const provider = spawnSync(binary, ['sandbox', '--help'], options);
  if (provider.status !== 0 || !/--permission-profile\b/u.test(provider.stdout))
    throw new Error('coordinating Codex launches require native permission-profile support for scoped Unix sockets');
  return { choice, help, provider };
}

export function nativeSessionContext(cwd) {
  const registry = readFleet();
  // Native passthrough must precede mapping validation and adoption notices.
  if (!registry || excludedFleetRoot(cwd, registry)) return null;
  let git;
  try { git = gitProject(cwd); } catch { return null; }
  if (excludedFleetRoot(git.canonical, registry)) return null;
  const { project, fleet } = projectFleet(cwd);
  if (!project) return null;
  return { workspace: git.checkout, canonical: project.checkout, identity: project.identity, org: project.record,
    tempRoot: project.temp, worktrees: project.worktrees, projects: Object.values(fleet.projects).filter(p => p.identity !== project.identity) };
}

// Utilities never create a temp or change native permissions. Assigned workers,
// print/exec and resume still get settings while bypassing workflow entry.
export function nativeSession(kind, args) {
  const utilities = kind === 'codex' ? codexUtility : claudeUtility;
  if (args.some(arg => /^(--help|-h|--version|-V)(=|$)/u.test(arg))) return false;
  if (kind === 'claude' && args.some(arg => ['--print', '-p'].includes(arg))) return true;
  return !utilities.test(nativeSubcommand(kind, args) ?? '');
}

function directories(context, kind) {
  const file = path.join(context.canonical, '.lane.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const args = config.always_args?.[kind] ?? [];
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error(`invalid always_args.${kind} in project config`);
  const selected = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--add-dir') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error('missing --add-dir path in project config');
      selected.push(args[++i]);
      if (kind === 'claude') while (args[i + 1] && !args[i + 1].startsWith('-')) selected.push(args[++i]);
    } else if (args[i].startsWith('--add-dir=')) selected.push(args[i].slice(10));
  }
  if (kind === 'codex') {
    const roots = config.sandbox_workspace_write?.writable_roots ?? [];
    if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string')) throw new Error('invalid sandbox_workspace_write.writable_roots in project config');
    selected.push(...roots);
  }
  return [...new Set(selected.map(directory => checkedDirectory(path.resolve(context.canonical, directory))))];
}

function merge(a, b) {
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  for (const [key, value] of Object.entries(b)) {
    if (Array.isArray(value) && Array.isArray(a[key])) a[key] = [...a[key], ...value];
    else if (object(value) && object(a[key])) merge(a[key], value);
    else a[key] = value;
  }
  return a;
}

function resolvedPath(pathname) {
  try { return fs.realpathSync(pathname); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return path.join(resolvedPath(path.dirname(pathname)), path.basename(pathname)); }
}

// The supervisor reads the entire lane tree. A worker owns only its checkout;
// sibling entries (including redirected spellings) are never write roots.
function otherLanePaths(context) {
  if (!context.worktrees) return [];
  const root = checkedDirectory(context.worktrees), workspace = checkedDirectory(context.workspace);
  if (!within(root, workspace)) return [root];
  const denied = [];
  let current = root;
  // Also cover nested worktree layouts, rather than skipping a whole ancestor
  // branch merely because it contains this checkout.
  while (current !== workspace) {
    let next;
    for (const name of fs.readdirSync(current)) {
      const directory = path.join(current, name);
      if (within(directory, workspace)) next = directory;
      else denied.push(directory, resolvedPath(directory));
    }
    current = next;
  }
  return denied;
}

// Claude Code 2.1.292's rTe() uses <CLAUDE_CODE_TMPDIR>/claude-<uid>
// up to 44 bytes, then /tmp/claude-<uid>. TMPDIR in settings cannot override
// the export in its sandboxed shell command. Keep macOS's /tmp alias canonical.
function claudeSocketDirectories(temporary, warn) {
  const suffix = `claude-${process.getuid?.() ?? 0}`;
  if (Buffer.byteLength(path.join(temporary, suffix)) <= 44) return [temporary];
  let fallback = path.join('/tmp', suffix);
  try {
    fallback = path.join(checkedDirectory('/tmp'), suffix);
    checkedDirectory(fallback);
    const entry = fs.lstatSync(fallback);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== (process.getuid?.() ?? 0) || (entry.mode & 0o022))
      throw new Error('directory is not safely owned by the current user');
    return [temporary, fallback];
  } catch (error) {
    warn(`monitor sandbox: WARNING: skipping shared Claude temp socket grant ${fallback}: ${error.message}`);
    return [temporary];
  }
}

export function nativeSandboxLaunch({ kind, binary, args, context, env = process.env, warn = console.error }) {
  const coordinating = coordinatingRole(context.role);
  if (coordinating && checkedDirectory(context.workspace) !== checkedDirectory(context.canonical))
    throw new Error('coordinating launches require the canonical checkout');
  // A raw directory flag would bypass canonical project selection. Native
  // operator config remains the place to extend the session's write roots.
  const extra = directories(context, kind);
  const roots = [context.workspace, context.canonical, context.org, context.tempRoot, context.worktrees, ...extra].filter(Boolean).map(pathname => checkedDirectory(pathname));
  for (const peer of context.projects ?? []) for (const directory of [peer.checkout, peer.record, peer.worktrees, peer.temp]) {
    // Fleet stores canonical paths. Resolve existing ancestors for stale or
    // not-yet-created areas too, so an alias cannot hide a nested peer.
    const peerRoot = resolvedPath(directory);
    if (roots.some(root => within(root, peerRoot) || within(peerRoot, root))) throw new Error(`overlapping fleet project paths: ${directory}; use separate checkout, record, worktrees and temp areas`);
  }
  const coordination = path.join(checkedDirectory(context.canonical), '.lane');
  const protectedPaths = coordinating ? [] : [...new Set([coordination, path.join(coordination, 'discovery')].flatMap(directory => [directory, resolvedPath(directory)]))];
  if (context.requests && protectedPaths.some(root => within(root, resolvedPath(context.requests)))) throw new Error('request queue must be outside canonical coordination state');
  if (extra.some(directory => protectedPaths.some(root => within(root, directory)))) throw new Error('extra directories cannot grant worker writes inside canonical coordination state');
  const preflight = kind === 'codex' && coordinating ? codexCoordinatingPreflight({ binary, args, context, env }) : null;
  const choice = preflight?.choice ?? (kind === 'codex' ? codexPermissionChoice(context, args, env) : null);
  const controlSocket = coordinating ? herdrControlSocket(env) : null;
  const requestedArgs = args;
  const selectedArgs = [];
  const checkExtra = directory => {
    if (!directory || !extra.includes(checkedDirectory(path.resolve(context.canonical, directory)))) throw new Error('extra directories must use native --add-dir or writable_roots in canonical project config');
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--add-dir') {
      checkExtra(args[++i]);
      if (kind === 'claude') while (args[i + 1] && !args[i + 1].startsWith('-')) checkExtra(args[++i]);
    } else if (args[i].startsWith('--add-dir=')) checkExtra(args[i].slice(10));
    else selectedArgs.push(args[i]);
  }
  args = selectedArgs;
  const temporary = runTemporary(context.tempRoot);
  const close = () => removePlainDirectory(temporary);
  try {
    const environment = { ...env, ...temporaryEnvironment(temporary, env) };
    if (controlSocket) environment.HERDR_SOCKET_PATH = controlSocket;
    const help = preflight?.help ?? spawnSync(binary, ['--help'], { cwd: context.workspace, env: environment, encoding: 'utf8', timeout: 5000 });
    const version = kind === 'claude' ? spawnSync(binary, ['--version'], { cwd: context.workspace, env: environment, encoding: 'utf8', timeout: 5000 }) : null;
    const claudeVersion = version?.stdout?.match(/\b(\d+)\.(\d+)\.(\d+)\b/u)?.slice(1).map(Number);
    // The settings schema below is verified on 2.1.284. Older/unknown builds
    // must warn instead of silently ignoring an unrecognized settings file.
    const claudeSupported = claudeVersion && (claudeVersion[0] > 2 || (claudeVersion[0] === 2 && (claudeVersion[1] > 1 || (claudeVersion[1] === 1 && claudeVersion[2] >= 284))));
    const supported = help.status === 0 && (kind === 'codex' ? /--sandbox\b/u.test(help.stdout) && /--add-dir\b/u.test(help.stdout) : /--settings\b/u.test(help.stdout) && version.status === 0 && claudeSupported);
    if (!supported) {
      if (coordinating) throw new Error(`${kind} has no supported native sandbox options for a coordinating launch`);
      warn(`monitor sandbox: WARNING: ${kind} has no supported native sandbox options; session is unconfined`);
      return { binary, args, env: environment, close };
    }
    const writable = [...new Set([context.org, context.requests, temporary, ...(coordinating ? [context.worktrees] : []), ...extra].filter(Boolean).map(checkedDirectory))];
    const permission = permissionHookArguments(kind, context, fileURLToPath(new URL('../', import.meta.url)), temporary, environment);
    Object.assign(environment, permission.env);
    // Claude folds this into the same settings object as the question and entry
    // hooks below; Codex keeps distinct event keys in its native config.
    args = [...args, ...permission.args];
    if (kind === 'codex') {
      if (args.some(arg => ['--remote', '--worktree'].includes(arg) || /^(--remote=|--worktree=)/u.test(arg))) throw new Error('native sandbox launch cannot use a remote server or different worktree');
      // Folder trust is independent of the tool sandbox. Linked worktrees use
      // the canonical repository for trust; include the exact working checkout
      // too for native versions that look there first. Never persist trust or
      // trust a shared fleet/home ancestor.
      // Codex 0.160.0 splits dotted -c keys literally, including quoted paths.
      // Put paths in an inline TOML table value instead (.herdr-monitor, etc.).
      const trustArgs = ['-c', `projects=${toml(Object.fromEntries(
        [...new Set([context.canonical, context.workspace].map(checkedDirectory))]
          .map(directory => [directory, { trust_level: 'trusted' }])))}`];
      args = [...args, ...trustArgs];
      if (choice && !coordinating) {
        warn(`monitor sandbox: WARNING: ${choice.setting}=${JSON.stringify(choice.value)} from ${choice.source} selects the operator's native policy instead of generated project confinement`);
        return { binary, args: [...requestedArgs, ...permission.args, ...trustArgs], env: environment, close };
      }
      const provider = preflight?.provider ?? spawnSync(binary, ['sandbox', '--help'], { cwd: context.workspace, env: environment, encoding: 'utf8', timeout: 5000 });
      if (provider.status === 0 && /--permission-profile\b/u.test(provider.stdout)) {
        if (choice) warn(`monitor sandbox: WARNING: coordinating role uses its generated permission profile instead of ${choice.setting}=${JSON.stringify(choice.value)} from ${choice.source}`);
        // Native configuration layers merge tables. A fresh name prevents a
        // persistent profile's roots, inheritance or sockets widening this one.
        const profile = coordinating ? `monitor-coordinator-${path.basename(temporary)}` : 'monitor-worker';
        const filesystem = { ':root': 'read', ':workspace_roots': { '.': 'write', '.git': 'read', ...(coordinating ? {} : { '.lane': 'read' }), '.codex': 'read', '.claude': 'read' },
          ...Object.fromEntries(writable.map(directory => [directory, 'write'])), ...Object.fromEntries(protectedPaths.map(directory => [directory, 'read'])) };
        const permissions = ['-c', `default_permissions=${JSON.stringify(profile)}`,
          ...(coordinating ? ['-c', `permissions.${profile}=${toml({ filesystem,
            network: { enabled: true, unix_sockets: { [controlSocket]: 'allow' } } })}`,
          '-c', 'features.network_proxy=true'] : ['-c', `permissions.${profile}.filesystem=${toml(filesystem)}`,
          '-c', `permissions.${profile}.network.enabled=false`])];
        if (controlSocket) {
          const probe = spawnSync(binary, ['sandbox', '--permission-profile', profile,
            ...(/--include-managed-config\b/u.test(provider.stdout) ? ['--include-managed-config'] : []),
            '-C', context.workspace, ...permissions, '--', process.execPath, ...socketProbeArguments(controlSocket)],
          { cwd: context.workspace, env: environment, encoding: 'utf8', timeout: 10000 });
          if (probe.error || probe.status !== 0)
            throw new Error(`Codex native permission profile cannot reach Herdr control socket ${controlSocket}: ${(probe.stderr || probe.error?.message || `probe exited ${probe.status}`).trim()}`);
        }
        return { binary, args: [...args, ...permissions], env: environment, close };
      }
      if (coordinating) throw new Error('coordinating Codex launches require native permission-profile support for scoped Unix sockets');
      if (protectedPaths.some(directory => within(context.workspace, directory) && fs.existsSync(directory))) throw new Error('this Codex build cannot protect canonical coordination receipts in a main-mode worker; use native permission-profile support');
      return { binary, args: [...args, '-c', 'sandbox_mode="workspace-write"',
        '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(writable)}`,
        '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true'], env: environment, close };
    }
    let settings = {}, nativeArgs = [];
    const sources = claudeSettingsSources(context, args, environment);
    for (let i = 0; i < args.length; i++) {
      let value;
      if (args[i] === '--settings') value = args[++i];
      else if (args[i].startsWith('--settings=')) value = args[i].slice(11);
      else { nativeArgs.push(args[i]); continue; }
      if (!value) throw new Error('missing native --settings value');
      const inline = value.trim().startsWith('{');
      const supplied = JSON.parse(inline ? value : fs.readFileSync(path.resolve(context.workspace, value), 'utf8'));
      sources.push({ source: inline ? 'CLI --settings JSON' : path.resolve(context.workspace, value), settings: supplied });
      settings = merge(settings, supplied);
    }
    const socketDirectories = [...claudeSocketDirectories(temporary, warn), ...(controlSocket ? [controlSocket] : [])];
    // --add-dir grants file edits as well as reads. Keep working directories
    // to cwd and private run temp; scoped Read rules prevent the outside-read
    // prompt without turning the shared lane root into an edit capability.
    const workingDirectories = [temporary];
    const readable = [...new Set([context.worktrees, ...writable].filter(Boolean).map(checkedDirectory))];
    const otherLanes = coordinating ? [] : [...new Set(otherLanePaths(context))];
    if (writable.some(directory => otherLanes.some(root => within(root, directory) || within(directory, root))))
      throw new Error('extra directories cannot grant writes to sibling lanes or the shared worktree root');
    const warnings = [];
    const approved = [checkedDirectory(context.workspace), ...writable];
    for (const { source, settings: loaded } of sources) {
      if (source === path.join(context.canonical, '.claude/settings.local.json') && loaded.sandbox?.network?.allowUnixSockets?.length)
        warn(`monitor sandbox: WARNING: bridge socket grant in ${source}; coordinating roles now receive a per-launch grant; remove the bridge with grant-herdr-socket.mjs --remove`);
      if (loaded.sandbox?.excludedCommands?.length) warnings.push(`sandbox.excludedCommands from ${source}`);
      for (const [key, grants] of [['permissions.additionalDirectories', loaded.permissions?.additionalDirectories], ['sandbox.filesystem.allowWrite', loaded.sandbox?.filesystem?.allowWrite]]) {
        if (grants?.some(directory => !approved.some(root => within(root, resolvedPath(path.resolve(context.workspace, directory.replace(/^~(?=\/)/u, environment.HOME || process.env.HOME))))))) warnings.push(`${key} from ${source}`);
      }
      if (loaded.sandbox?.filesystem?.disabled === true) warnings.push(`sandbox.filesystem.disabled from ${source}`);
      const network = loaded.sandbox?.network;
      if (network?.allowAllUnixSockets === true) warnings.push(`sandbox.network.allowAllUnixSockets from ${source}`);
      if (network?.allowLocalBinding === true) warnings.push(`sandbox.network.allowLocalBinding from ${source}`);
      if (network?.allowUnixSockets?.some(directory => !socketDirectories.some(root => within(root, resolvedPath(path.resolve(context.workspace, directory.replace(/^~(?=\/)/u, environment.HOME || process.env.HOME))))))) warnings.push(`sandbox.network.allowUnixSockets from ${source}`);
      for (const [key, value, weaker] of [['enabled', loaded.sandbox?.enabled, false], ['allowUnsandboxedCommands', loaded.sandbox?.allowUnsandboxedCommands, true], ['failIfUnavailable', loaded.sandbox?.failIfUnavailable, false]]) {
        if (value === weaker) warnings.push(`sandbox.${key} from ${source}`);
      }
    }
    if (warnings.length) warn(`monitor sandbox: WARNING: ${warnings.join('; ')} weakens generated project confinement; respecting the operator's native settings`);
    const configured = key => {
      const selected = [...sources.filter(s => !s.managed), ...sources.filter(s => s.managed)].reverse().find(s => s.settings.sandbox?.[key] !== undefined);
      return selected?.settings.sandbox[key];
    };
    // Native defaults already restrict writes to cwd and temp. Explicit peer
    // denies also contain inherited user write paths. Socket paths use native
    // subpath rules for both bind and connect, independently of TCP binding.
    const denied = (context.projects ?? []).flatMap(p => [p.checkout, p.record, p.worktrees, p.temp])
      .concat(protectedPaths, otherLanes);
    settings.sandbox = { ...settings.sandbox, enabled: configured('enabled') ?? true, failIfUnavailable: configured('failIfUnavailable') ?? true, allowUnsandboxedCommands: configured('allowUnsandboxedCommands') ?? false,
      // Leave inherited arrays in their native scopes: Claude merges them and
      // can exclude repository grants when the sandbox is admin-required.
      network: { ...settings.sandbox?.network, allowUnixSockets: [...new Set([...(settings.sandbox?.network?.allowUnixSockets ?? []), ...socketDirectories])] },
      filesystem: { ...settings.sandbox?.filesystem, allowRead: [...new Set([...(settings.sandbox?.filesystem?.allowRead ?? []), ...readable])], allowWrite: [...new Set([...(settings.sandbox?.filesystem?.allowWrite ?? []), ...writable])], denyWrite: [...new Set([...(settings.sandbox?.filesystem?.denyWrite ?? []), ...denied])] } };
    const temporaryEnv = temporaryEnvironment(temporary, env);
    const pythonKeys = ['PYTHONPYCACHEPREFIX', 'PYTHONDONTWRITEBYTECODE'];
    if (sources.some(source => pythonKeys.some(key => source.settings.env?.[key]))) {
      // Keep Python settings in their native scopes and precedence. Remove the
      // launch default too, so it cannot compete with a settings-only choice.
      for (const key of pythonKeys) {
        delete temporaryEnv[key];
        if (env[key] !== undefined) environment[key] = env[key];
        else delete environment[key];
      }
    }
    settings.env = { ...settings.env, ...temporaryEnv, CLAUDE_CODE_TMPDIR: temporary };
    // Native Write and NotebookEdit consult Edit(path), too. Absolute file-tool
    // rules require //; sandbox paths use ordinary absolute paths.
    settings.permissions = { ...settings.permissions,
      allow: [...new Set([...(settings.permissions?.allow ?? []), ...readable.map(directory => `Read(/${directory}/**)`), ...writable.map(directory => `Edit(/${directory}/**)`)])],
      deny: [...new Set([...(settings.permissions?.deny ?? []), ...denied.map(directory => `Edit(/${directory}/**)`)])] };
    if (context.worktrees && !coordinating) {
      const quote = value => `'${value.replace(/'/gu, `'"'"'`)}'`;
      const command = [process.execPath, fileURLToPath(new URL('./lane-file-access.mjs', import.meta.url)),
        checkedDirectory(context.workspace), checkedDirectory(context.worktrees)].map(quote).join(' ');
      settings.hooks = { ...settings.hooks, PreToolUse: [...(settings.hooks?.PreToolUse ?? []),
        {matcher:'Edit|Write|NotebookEdit',hooks:[{type:'command',command}]}] };
    }
    const file = path.join(temporary, 'claude-settings.json');
    writeFileAtomic(file, JSON.stringify(settings, null, 2) + '\n', 0o600);
    environment.CLAUDE_CODE_TMPDIR = temporary;
    // Put variadic --add-dir before a terminating option so it cannot consume
    // the user's positional prompt as another directory.
    return { binary, args: [...nativeArgs, ...workingDirectories.flatMap(directory => ['--add-dir', directory]), '--settings', file], env: environment, close };
  } catch (error) { close(); throw error; }
}
