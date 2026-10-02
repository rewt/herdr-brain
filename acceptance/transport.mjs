import fs from 'node:fs';
import path from 'node:path';

// Keep the transport's relative imports intact in its private scratch copy.
// The native regression uses this same copy, without authentication or a model.
export function copyNativeTransport(root) {
  const source = path.resolve(import.meta.dirname, '..'), directory = path.join(root, 'transport');
  for (const relative of ['acceptance/native-transport.mjs', 'acceptance/security.mjs', 'acceptance/validation.mjs',
    'discovery/paths.mjs', 'lib/files.mjs']) {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, relative), target);
  }
  return path.join(directory, 'acceptance/native-transport.mjs');
}
