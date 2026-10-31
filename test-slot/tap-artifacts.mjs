import path from 'node:path';
import { createHash } from 'node:crypto';

// A fixed sibling family, derived from the journal name rather than a receipt
// pointer. Nested runners sharing a journal share its retention lifetime.
export function tapArtifactPrefix(journal) {
  const file = path.resolve(journal);
  const key = createHash('sha256').update(path.basename(file)).digest('hex');
  return path.join(path.dirname(file), `test-file-tap-${key}-`);
}
