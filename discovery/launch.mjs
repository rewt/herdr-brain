// Automatic PATH interception is reserved for a new interactive session.
// Explicit monitor-* entry remains available to tools that intentionally opt in.
import { spawnSync } from 'node:child_process';
import { gitProject } from '../lib/project.mjs';
import { claudeUtility, codexUtility, nativeSubcommand } from './native-command.mjs';

// Resume keeps the native session and its durable pane receipt. Utility and
// headless commands must still suppress entry even when they include resume.
export function interactiveResume({ kind, args, tty = process.stdin.isTTY && process.stdout.isTTY }) {
  if (!tty) return false;
  const subcommand = nativeSubcommand(kind, args) ?? '';
  if (kind === 'claude') return args.some(arg => /^(--resume|--continue|-r|-c)(=|$)/u.test(arg)) &&
    !claudeUtility.test(subcommand) && !args.some(arg => /^(--print|-p|--help|-h|--version|-V)(=|$)/u.test(arg));
  return kind === 'codex' && subcommand === 'resume' &&
    !args.some(arg => /^(--help|-h|--version|-V)(=|$)/u.test(arg));
}

export function freshInteractive({ kind, args, cwd = process.cwd(), env = process.env, tty = process.stdin.isTTY && process.stdout.isTTY }) {
  if (!tty || env.MONITOR_ENTRY_BYPASS === '1' || env.MONITOR_REQUEST_DIR || env.HERDR_INTEGRATION_ID) return false;
  const subcommand = nativeSubcommand(kind, args) ?? '';
  const utility = kind === 'codex' ? codexUtility : claudeUtility;
  if (utility.test(subcommand) || (kind === 'codex' && /^(exec|x|review|resume|fork)$/u.test(subcommand))) return false;
  if (args.some((arg) => /^(--help|-h|--version|-V|--resume|--continue|--fork-session|--worktree|-w|-C|--cd)(=|$)/u.test(arg))) return false;
  if (kind === 'claude' && args.some((arg) => /^(--print|-p|-r|-c)(=|$)/u.test(arg))) return false;
  try {
    const project = gitProject(cwd);
    if (project.checkout !== project.canonical) return false;
    const branch = spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
    if (branch.stdout?.trim().startsWith('lane/')) return false;
  } catch { /* The adapter warns and falls back when no project identity exists. */ }
  // A fresh native `herdr agent start` is also project entry. Monitor's own
  // dispatch/supervisor launchers set MONITOR_ENTRY_BYPASS in the pane and
  // launch environment; a display-only managed-start receipt grants no role.
  return true;
}
