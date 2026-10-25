import path from 'node:path';
import { responseAllowance } from './load.mjs';
import { commandFailure } from './limits.mjs';

// Nonzero exits remain available to the case's product assertions, including
// deliberate refusal checks. Process errors carry their own operation samples.
export function loadAwareCommand(execute, load, { scratchRoots = [] } = {}) {
  return (file, args, options) => {
    const window = load?.begin();
    // Ordinary acceptance commands have no elapsed stop. Explicit nonzero
    // values are retained only for deliberately injected timeout controls.
    const result = execute(file, args, { ...options, timeout: responseAllowance(options?.timeout ?? 0, load),
      killSignal: options?.killSignal ?? 'SIGKILL' });
    const measured = load?.snapshot(window);
    if (result.error) {
      const diagnostic = [result.error.message, String(result.stdout ?? '') + String(result.stderr ?? '')]
        .filter(Boolean).join('\n');
      throw commandFailure(`${path.basename(file)} ${args[0]}: ${diagnostic}`,
        { scratchRoots, error: result.error, load: measured });
    }
    return result;
  };
}
