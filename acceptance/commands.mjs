import path from 'node:path';
import { commandFailure } from './limits.mjs';

// Nonzero exits remain available to the case's product assertions, including
// deliberate refusal checks. Process errors carry their own operation samples.
export function loadAwareCommand(execute, load) {
  return (file, args, options) => {
    const window = load?.begin();
    const result = execute(file, args, options);
    const measured = load?.snapshot(window);
    if (result.error) {
      const diagnostic = [result.error.message, String(result.stdout ?? '') + String(result.stderr ?? '')]
        .filter(Boolean).join('\n');
      throw commandFailure(`${path.basename(file)} ${args[0]}: ${diagnostic}`,
        { error: result.error, load: measured });
    }
    return result;
  };
}
