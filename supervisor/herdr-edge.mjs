// The physical Herdr seam for supervisor delivery. No logical authority here.
import { spawnSync } from 'node:child_process';
import { loadTimeout } from '../lib/deadline.mjs';

export function invokeHerdr(herdr, args) {
  const result = spawnSync(herdr, args, { encoding: 'utf8', timeout: loadTimeout(10000), maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const error = new Error((result.stderr || result.stdout || result.error?.message || `Herdr exited ${result.status}`).trim());
    try { error.code = JSON.parse(result.stderr || result.stdout).error?.code; } catch {}
    throw error;
  }
  return result.stdout;
}
