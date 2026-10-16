// A nudge is only a wake hint, never a delivery receipt or a message payload.
import { offerQuiet } from '../supervisor/prompt-supervisor.mjs';
import { NUDGE } from './hook-pull.mjs';

export async function nudgeHookSession({ session, binding }, options = {}) {
  if (session?.humanTyped !== false || !['worker', 'engineer', 'reviewer', 'logs-triage'].includes(session.role) ||
      binding?.cwd !== session.cwd || binding?.name?.startsWith('chat-') || binding?.name?.startsWith('operator'))
    return { state: 'pending', reason: 'human-typed or unknown pane: pull-only inbox status' };
  return offerQuiet({ text: NUDGE, binding, beforePrompt: () => {} }, options);
}
