#!/usr/bin/env node
// Invoked only by Git config overrides assembled by the trusted entry parent.
// Git expands %f as a shell-quoted argument; command text stays encoded until
// inside this adapter, so filenames cannot alter the wrapper's argv.
import { spawnSync } from 'node:child_process';
import { lifetimeScope, closeScope, boundedArgs } from './lifetime.mjs';
import { sandboxCommand } from './confinement.mjs';
import { validationTemporary } from './paths.mjs';
const [binary, sharedJSON, encoded, filename] = process.argv.slice(2);
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
try {
  const original = Buffer.from(encoded, 'base64').toString('utf8');
  if (!original) {
    // An absent/disabled direction is identity, not an empty shell command.
    // This trusted byte copy executes no project code and grants no writes.
    process.stdin.pipe(process.stdout);
  } else {
    const cwd = process.cwd();
    const temporary = validationTemporary(cwd);
    // Filters run before the lane exists fully; no privileged mkdir through
    // checkout paths here. The filesystem boundary still permits checkout IO.
    const scope = lifetimeScope(cwd);
    let r;
    try {
      const sandbox = sandboxCommand(binary, cwd, { lifetime: scope, sharedPaths: JSON.parse(sharedJSON),
        writablePaths: temporary ? [temporary] : [] });
      const command = original.replaceAll('%f', quote(filename ?? ''));
      r = spawnSync(process.execPath, [new URL('./bounded.mjs', import.meta.url).pathname,
        ...boundedArgs(scope, sandbox.binary, sandbox.args, ['/bin/sh', '-c', command])], {
        stdio: 'inherit', env: { ...process.env, ORG_DIR: '', MONITOR_REQUEST_DIR: '', TMPDIR: temporary ?? cwd },
      });
    } finally { closeScope(scope); }
    if (r.error) throw r.error;
    process.exitCode = r.status ?? 1;
  }
} catch (e) { console.error(`monitor Git filter: ${e.message}`); process.exitCode = 1; }
