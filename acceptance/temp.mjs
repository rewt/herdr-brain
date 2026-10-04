import fs from 'node:fs';
import assert from 'node:assert/strict';

// Register immediately after creation, before any setup can throw. The shared
// array stays live while a case allocates discovery/session/verification roots.
export function createOwnedTempRoot(prefix, scratchRoots, cleanupRoots) {
  assert.ok(Array.isArray(scratchRoots), 'owned temp creation requires the scratch registry');
  const directory = fs.mkdtempSync(prefix);
  scratchRoots.push(directory);
  cleanupRoots?.push(directory);
  const canonical = fs.realpathSync.native(directory);
  scratchRoots[scratchRoots.length - 1] = canonical;
  if (cleanupRoots) cleanupRoots[cleanupRoots.length - 1] = canonical;
  return canonical;
}

// Leave room for the default fleet's /t/<16-byte identity>/r-XXXXXX layout.
export const createLiveSessionTemp = (scratchRoots, cleanupRoots) =>
  createOwnedTempRoot('/tmp/as-', scratchRoots, cleanupRoots);
