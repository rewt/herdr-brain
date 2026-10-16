// One implementation. A future transport replaces this object, never a fallback.
import { offerQuiet } from '../supervisor/prompt-supervisor.mjs';

export function quietTransport(options = {}) {
  return { deliver: (pointer, binding, { beforePrompt }) => {
    const text = pointer.legacyText ?? `[brain-message] id=${JSON.stringify(pointer.eventId)} kind=${pointer.kind} summary=${JSON.stringify(pointer.summary)} envelope=${JSON.stringify(pointer.path)} sha256=${pointer.sha256}`;
    return offerQuiet({ text, binding, beforePrompt }, options);
  } };
}
