// Native settings only: no outer sandbox, socket policy or grant protocol.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectFleet } from '../lib/fleet.mjs';
import { gitProject } from '../lib/project.mjs';
import { removePlainDirectory, writeFileAtomic } from '../lib/files.mjs';
import { checkedDirectory, within } from './paths.mjs';
import { runTemporary, temporaryEnvironment } from './temporary.mjs';
import { toml } from './confinement.mjs';
import { claudeSettingsSources, codexPermissionChoice } from './native-settings.mjs';

export function nativeSessionContext(cwd) {
  const { project, fleet, excluded } = projectFleet(cwd);
  if (excluded || !project) return null;
  const git = gitProject(cwd);
  return { workspace: git.checkout, canonical: project.checkout, org: project.record,
    tempRoot: project.temp, worktrees: project.worktrees, projects: Object.values(fleet.projects).filter(p => p.identity !== project.identity) };
}

// Utilities never create a temp or change native permissions. Assigned workers,
// print/exec and resume still get settings while bypassing workflow entry.
export function nativeSession(kind, args) {
  const utilities = kind === 'codex'
    ? /^(help|login|logout|completion|sandbox|debug|doctor|features|mcp|plugin|update|app-server|exec-server|agents|archive|delete|queue|migrate-rollouts|unarchive|cloud)$/u
    : /^(help|auth|update|install|doctor|mcp|plugin|agents|attach|logs|stop|kill|rm|respawn|setup-token)$/u;
  if (args.some(arg => /^(--help|-h|--version|-V)(=|$)/u.test(arg))) return false;
  if (kind === 'claude' && args.some(arg => ['--print', '-p'].includes(arg))) return true;
  const values = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '--add-dir', '--effort', '--settings', '--permission-mode', '--setting-sources']);
  for (let i = 0; i < args.length; i++) {
    if (values.has(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) return !utilities.test(args[i]);
  }
  return true;
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

export function nativeSandboxLaunch({ kind, binary, args, context, env = process.env, warn = console.error }) {
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
  const protectedPaths = context.role === 'supervisor' ? [] : [...new Set([coordination, path.join(coordination, 'discovery')].flatMap(directory => [directory, resolvedPath(directory)]))];
  if (context.requests && protectedPaths.some(root => within(root, resolvedPath(context.requests)))) throw new Error('request queue must be outside canonical coordination state');
  if (extra.some(directory => protectedPaths.some(root => within(root, directory)))) throw new Error('extra directories cannot grant worker writes inside canonical coordination state');
  const choice = kind === 'codex' ? codexPermissionChoice(context, args, env) : null;
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
    const environment = { ...env, ...temporaryEnvironment(temporary) };
    const help = spawnSync(binary, ['--help'], { cwd: context.workspace, env: environment, encoding: 'utf8', timeout: 5000 });
    const version = kind === 'claude' ? spawnSync(binary, ['--version'], { cwd: context.workspace, env: environment, encoding: 'utf8', timeout: 5000 }) : null;
    const claudeVersion = version?.stdout?.match(/\b(\d+)\.(\d+)\.(\d+)\b/u)?.slice(1).map(Number);
    // The settings schema below is verified on 2.1.284. Older/unknown builds
    // must warn instead of silently ignoring an unrecognized settings file.
    const claudeSupported = claudeVersion && (claudeVersion[0] > 2 || (claudeVersion[0] === 2 && (claudeVersion[1] > 1 || (claudeVersion[1] === 1 && claudeVersion[2] >= 284))));
    const supported = help.status === 0 && (kind === 'codex' ? /--sandbox\b/u.test(help.stdout) && /--add-dir\b/u.test(help.stdout) : /--settings\b/u.test(help.stdout) && version.status === 0 && claudeSupported);
    if (!supported) {
      warn(`monitor sandbox: WARNING: ${kind} has no supported native sandbox options; session is unconfined`);
      return { binary, args, env: environment, close };
    }
    const writable = [...new Set([context.org, context.requests, temporary, ...extra].filter(Boolean).map(checkedDirectory))];
    if (kind === 'codex') {
      if (args.some(arg => ['--remote', '--worktree'].includes(arg) || /^(--remote=|--worktree=)/u.test(arg))) throw new Error('native sandbox launch cannot use a remote server or different worktree');
      if (choice) {
        warn(`monitor sandbox: WARNING: ${choice.setting}=${JSON.stringify(choice.value)} from ${choice.source} selects the operator's native policy instead of generated project confinement`);
        return { binary, args: requestedArgs, env: environment, close };
      }
      const provider = spawnSync(binary, ['sandbox', '--help'], { cwd: context.workspace, env: environment, encoding: 'utf8', timeout: 5000 });
      if (provider.status === 0 && /--permission-profile\b/u.test(provider.stdout)) {
        const filesystem = { ':root': 'read', ':workspace_roots': { '.': 'write', '.git': 'read', ...(context.role === 'supervisor' ? {} : { '.lane': 'read' }), '.codex': 'read', '.claude': 'read' },
          ...Object.fromEntries(writable.map(directory => [directory, 'write'])), ...Object.fromEntries(protectedPaths.map(directory => [directory, 'read'])) };
        return { binary, args: [...args, '-c', 'default_permissions="monitor-worker"',
          '-c', `permissions.monitor-worker.filesystem=${toml(filesystem)}`,
          '-c', 'permissions.monitor-worker.network.enabled=true'], env: environment, close };
      }
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
    const warnings = [];
    const approved = [checkedDirectory(context.workspace), ...writable];
    for (const { source, settings: loaded } of sources) {
      if (loaded.sandbox?.excludedCommands?.length) warnings.push(`sandbox.excludedCommands from ${source}`);
      for (const [key, grants] of [['permissions.additionalDirectories', loaded.permissions?.additionalDirectories], ['sandbox.filesystem.allowWrite', loaded.sandbox?.filesystem?.allowWrite]]) {
        if (grants?.some(directory => !approved.some(root => within(root, resolvedPath(path.resolve(context.workspace, directory.replace(/^~(?=\/)/u, environment.HOME || process.env.HOME))))))) warnings.push(`${key} from ${source}`);
      }
      if (loaded.sandbox?.filesystem?.disabled === true) warnings.push(`sandbox.filesystem.disabled from ${source}`);
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
    // denies also contain inherited user write paths without touching sockets.
    const denied = (context.projects ?? []).flatMap(p => [p.checkout, p.record, p.worktrees, p.temp])
      .concat(protectedPaths);
    settings.sandbox = { ...settings.sandbox, enabled: configured('enabled') ?? true, failIfUnavailable: configured('failIfUnavailable') ?? true, allowUnsandboxedCommands: configured('allowUnsandboxedCommands') ?? false,
      filesystem: { ...settings.sandbox?.filesystem, allowWrite: [...new Set([...(settings.sandbox?.filesystem?.allowWrite ?? []), ...writable])], denyWrite: [...new Set([...(settings.sandbox?.filesystem?.denyWrite ?? []), ...denied])] } };
    settings.env = { ...settings.env, ...temporaryEnvironment(temporary), CLAUDE_CODE_TMPDIR: temporary };
    settings.permissions = { ...settings.permissions, deny: [...new Set([...(settings.permissions?.deny ?? []), ...denied.map(directory => `Edit(/${directory}/**)`)])] };
    const file = path.join(temporary, 'claude-settings.json');
    writeFileAtomic(file, JSON.stringify(settings, null, 2) + '\n', 0o600);
    environment.CLAUDE_CODE_TMPDIR = temporary;
    return { binary, args: [...nativeArgs, ...extra.flatMap(directory => ['--add-dir', directory]), '--settings', file], env: environment, close };
  } catch (error) { close(); throw error; }
}
