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

export function nativeSessionContext(cwd) {
  const { project, fleet } = projectFleet(cwd);
  if (!project) return null;
  const git = gitProject(cwd);
  return { workspace: git.checkout, canonical: project.checkout, org: project.record,
    tempRoot: project.temp, projects: Object.values(fleet.projects).filter(p => p.identity !== project.identity) };
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

export function nativeSandboxLaunch({ kind, binary, args, context, env = process.env, warn = console.error }) {
  // A raw directory flag would bypass canonical project selection. Native
  // operator config remains the place to extend the session's write roots.
  const extra = directories(context, kind);
  const selectedArgs = [];
  const checkExtra = directory => {
    if (!directory || !extra.includes(checkedDirectory(path.resolve(context.canonical, directory)))) throw new Error('extra directories must use native --add-dir or writable_roots in canonical project config');
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--add-dir') {
      checkExtra(args[++i]);
      if (kind === 'claude') while (args[i + 1] && !args[i + 1].startsWith('-')) checkExtra(args[++i]);
    } else if (args[i].startsWith('--add-dir=')) checkExtra(args[i].slice(10));
    else if (kind === 'codex' && ['-s', '--sandbox'].includes(args[i]) && args[i + 1] === 'workspace-write') i++;
    else if (kind === 'codex' && ['--sandbox=workspace-write', '-sworkspace-write'].includes(args[i])) continue;
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
      if (args.some(arg => ['--dangerously-bypass-approvals-and-sandbox', '--remote', '--worktree', '-s', '--sandbox'].includes(arg) || /^(--remote=|--sandbox=|-s.)/u.test(arg))) throw new Error('native sandbox launch cannot override its sandbox, use a bypass, remote server or different worktree');
      const provider = spawnSync(binary, ['sandbox', '--help'], { cwd: context.workspace, env: environment, encoding: 'utf8', timeout: 5000 });
      if (provider.status === 0 && /--permission-profile\b/u.test(provider.stdout)) {
        const filesystem = { ':root': 'read', ':workspace_roots': { '.': 'write', '.git': 'read', ...(context.role === 'supervisor' ? {} : { '.lane': 'read' }), '.codex': 'read', '.claude': 'read' },
          ...Object.fromEntries(writable.map(directory => [directory, 'write'])) };
        return { binary, args: [...args, '-c', 'default_permissions="monitor-worker"',
          '-c', `permissions.monitor-worker.filesystem=${toml(filesystem)}`,
          '-c', 'permissions.monitor-worker.network.enabled=true'], env: environment, close };
      }
      return { binary, args: [...args, '-c', 'sandbox_mode="workspace-write"',
        '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(writable)}`,
        '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true'], env: environment, close };
    }
    let settings = {}, nativeArgs = [];
    for (let i = 0; i < args.length; i++) {
      let value;
      if (args[i] === '--settings') value = args[++i];
      else if (args[i].startsWith('--settings=')) value = args[i].slice(11);
      else { nativeArgs.push(args[i]); continue; }
      if (!value) throw new Error('missing native --settings value');
      settings = merge(settings, JSON.parse(value.trim().startsWith('{') ? value : fs.readFileSync(path.resolve(context.workspace, value), 'utf8')));
    }
    // Native defaults already restrict writes to cwd and temp. Explicit peer
    // denies also contain inherited user write paths without touching sockets.
    const denied = (context.projects ?? []).flatMap(p => [p.checkout, p.record, p.worktrees, p.temp])
      .filter(directory => !extra.some(grant => within(directory, grant) || within(grant, directory)));
    settings.sandbox = { ...settings.sandbox, enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      filesystem: { ...settings.sandbox?.filesystem, disabled: false, allowWrite: writable, denyWrite: [...new Set([...(settings.sandbox?.filesystem?.denyWrite ?? []), ...denied])] } };
    settings.env = { ...settings.env, ...temporaryEnvironment(temporary), CLAUDE_CODE_TMPDIR: temporary };
    settings.permissions = { ...settings.permissions, deny: [...new Set([...(settings.permissions?.deny ?? []), ...denied.map(directory => `Edit(/${directory}/**)`)])] };
    const file = path.join(temporary, 'claude-settings.json');
    writeFileAtomic(file, JSON.stringify(settings, null, 2) + '\n', 0o600);
    environment.CLAUDE_CODE_TMPDIR = temporary;
    return { binary, args: [...nativeArgs, ...extra.flatMap(directory => ['--add-dir', directory]), '--settings', file], env: environment, close };
  } catch (error) { close(); throw error; }
}
