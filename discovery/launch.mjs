// Automatic PATH interception is reserved for a new interactive session.
// Explicit monitor-* entry remains available to tools that intentionally opt in.
import { spawnSync } from 'node:child_process';
import { gitProject } from '../lib/project.mjs';

export function freshInteractive({ kind, args, cwd = process.cwd(), env = process.env, tty = process.stdin.isTTY && process.stdout.isTTY }) {
  if (!tty || env.MONITOR_ENTRY_BYPASS === '1' || env.MONITOR_REQUEST_DIR || env.HERDR_INTEGRATION_ID) return false;
  const utility = kind === 'codex'
    ? /^(exec|x|review|resume|fork|help|login|logout|completion|sandbox|debug|doctor|features|mcp|plugin|update|app-server|exec-server|agents|archive|delete|queue|migrate-rollouts|unarchive|cloud)$/u
    : /^(help|auth|update|install|doctor|mcp|plugin)$/u;
  if (args.some((arg) => utility.test(arg) || /^(--help|-h|--version|-V|--resume|--continue|--fork-session|--worktree|-w|-C|--cd)(=|$)/u.test(arg))) return false;
  if (kind === 'claude' && args.some((arg) => /^(--print|-p|-r|-c)(=|$)/u.test(arg))) return false;
  try {
    const project = gitProject(cwd);
    if (project.checkout !== project.canonical) return false;
    const branch = spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
    if (branch.stdout?.trim().startsWith('lane/')) return false;
  } catch { /* The adapter warns and falls back when no project identity exists. */ }
  // Herdr registers managed starts before injecting their command into the
  // pane shell. Consult that live receipt, rather than guessing from HERDR_ENV
  // (which fresh interactive shell launches inherit too).
  if (env.HERDR_PANE_ID) {
    const result = spawnSync('herdr', ['agent', 'list'], { env, encoding: 'utf8', timeout: 3000 });
    try {
      if (result.status !== 0) return false;
      const agents = JSON.parse(result.stdout).result?.agents;
      if (!Array.isArray(agents) || agents.some((agent) => agent.pane_id === env.HERDR_PANE_ID)) return false;
    } catch { return false; }
  }
  return true;
}
