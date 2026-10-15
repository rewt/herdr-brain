#!/usr/bin/env node
// Installed CLI and compatibility exports; all shared retirement IO lives in lib.
import { isMain } from '../lib/cli-help.mjs';
import { retirementMain } from '../lib/retire-runtime.mjs';
export { createRetirement, isShellOnly, readDeclaredReferences, readLiveReferences } from '../lib/retire-runtime.mjs';

if (isMain(import.meta.url)) {
  try { retirementMain(); } catch (e) { process.stderr.write(`retire: ${e.message}\n`); process.exitCode = 1; }
}
