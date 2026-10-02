// Immutable scratch probes identify the inherited kernel read boundary.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkedDirectory } from './paths.mjs';
export function lifetimeScope() {
  if (process.platform !== 'darwin') return null;
  const directory = fs.mkdtempSync(path.join(checkedDirectory('/tmp'), 'monitor-lifetime-'));
  try {
    fs.chmodSync(directory, 0o700); checkedDirectory(directory);
    const allowed = `probe-${randomUUID()}`, denied = `probe-${randomUUID()}`;
    for (const name of [allowed, denied]) fs.writeFileSync(path.join(directory, name), 'probe', { flag: 'wx', mode: 0o400 });
    return { allowed: path.join(directory, allowed), denied: path.join(directory, denied) };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
export function closeScope(scope) { if (scope) fs.rmSync(path.dirname(scope.allowed), { recursive: true, force: true }); }
export const boundedArgs = (scope, binary, args, command) => [
  ...(scope ? ['--scope', JSON.stringify(scope)] : []), binary, ...args, '--command', ...command,
];
