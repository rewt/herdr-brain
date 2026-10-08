// Shared command classification for workflow entry and native permissions.
export const claudeUtility = /^(help|auth|update|install|doctor|mcp|plugin|agents|attach|logs|stop|kill|rm|respawn|setup-token)$/u;
export const codexUtility = /^(help|login|logout|completion|sandbox|debug|doctor|features|mcp|plugin|update|app-server|exec-server|agents|archive|delete|queue|migrate-rollouts|unarchive|cloud)$/u;

const values = new Set(['--config', '-m', '--model', '--profile', '-C', '--cd', '--add-dir', '--effort', '--settings', '--permission-mode', '--setting-sources']);

export function nativeSubcommand(kind, args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Everything after the option terminator is an explicit prompt.
    if (arg === '--') return undefined;
    if (values.has(arg) || (kind === 'codex' && ['-c', '-p'].includes(arg))) { i++; continue; }
    // Claude resume optionally consumes a session ID; -c means continue.
    if (kind === 'claude' && ['--resume', '-r'].includes(arg)) {
      if (args[i + 1] && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}
