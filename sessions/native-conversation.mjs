// A known native ID is not proof that the harness has persisted a conversation.
// Look up only that ID in its checkout's project directory; never open or list
// transcripts, inspect messages, or search other projects/configurations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const missingConversation = 'native session has no persisted conversation; resume impossible; use declared-boundary reconstruct';

export function nativeResumeVeto({ binding, spec }, env = process.env) {
  const launch = spec.resolvedRoute;
  // Codex has no equivalent cheap, direct session-ID filename lookup here.
  if (launch?.kind !== 'claude') return null;
  if (!path.isAbsolute(binding.checkout ?? '') || !/^[A-Za-z0-9_-]+$/u.test(binding.nativeSessionId ?? ''))
    return 'native conversation location unknown; hold';
  // Match the launch owner's route overrides, including a relative config dir
  // resolved from the native process's checkout rather than the controller cwd.
  const effective = { ...env, ...Object.fromEntries((launch.env ?? []).map(pair => {
    const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)];
  })) };
  const config = path.resolve(binding.checkout, effective.CLAUDE_CONFIG_DIR || path.join(effective.HOME || os.homedir(), '.claude'));
  const project = binding.checkout.replace(/[^A-Za-z0-9]/g, '-');
  const file = path.join(config, 'projects', project, `${binding.nativeSessionId}.jsonl`);
  try {
    return fs.lstatSync(file).isFile() ? null : 'native session transcript is not a regular file; hold';
  } catch (error) {
    return error.code === 'ENOENT' ? missingConversation : `native conversation metadata unavailable (${error.code ?? 'unknown'}); hold`;
  }
}
