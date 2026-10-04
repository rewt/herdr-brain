// Preload for direct test runs: refuse the operator's fleet before fleetPath
// can return it, including in children whose HOME or environment was reset.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const home = fs.realpathSync(os.userInfo().homedir);
const protectedFleet = path.join(home, '.herdr-monitor');
const join = path.join;
path.join = function (...parts) {
  const result = join(...parts);
  if ((result === protectedFleet || result.startsWith(`${protectedFleet}${path.sep}`))
    && new Error().stack.includes('at fleetPath (')) {
    throw new Error(`test resolved fleetPath() under the operator's real home: ${result}`);
  }
  return result;
};
syncBuiltinESMExports();
