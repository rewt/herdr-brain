#!/usr/bin/env node
// Invoked only by Git config overrides assembled by the trusted entry parent.
// Git expands %f as a shell-quoted argument; command text stays encoded until
// inside this adapter, so filenames cannot alter the wrapper's argv.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxCommand } from './confinement.mjs';
const [binary, sharedJSON, encoded, filename] = process.argv.slice(2);
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
try {
  const cwd = fs.realpathSync(process.cwd());
  const temporary = path.join(cwd, '.lane/validation-tmp');
  // Filters run before the lane exists fully; no privileged mkdir through
  // checkout paths here. The filesystem boundary still permits checkout IO.
  const sandbox = sandboxCommand(binary, cwd, { sharedPaths: JSON.parse(sharedJSON),
    writablePaths: fs.existsSync(temporary) ? [temporary] : [] });
  const original = Buffer.from(encoded, 'base64').toString('utf8');
  const command = original.replaceAll('%f', quote(filename ?? ''));
  const r = spawnSync(process.execPath, [new URL('./bounded.mjs', import.meta.url).pathname,
    sandbox.binary, ...sandbox.args, '/bin/sh', '-c', command], {
    stdio: 'inherit', env: { ...process.env, ORG_DIR: '', MONITOR_REQUEST_DIR: '', TMPDIR: temporary },
  });
  if (r.error) throw r.error;
  process.exitCode = r.status ?? 1;
} catch (e) { console.error(`monitor Git filter: ${e.message}`); process.exitCode = 1; }
