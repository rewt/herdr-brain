import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// Widen the real, post-spawn interval between the bridge's two atomic updates.
// Only the CLI labelled workspace is delayed; commands and load workers are untouched.
const rename = fs.renameSync;
let delayed = false;
fs.renameSync = function (from, to) {
  const result = rename.call(this, from, to);
  if (!delayed && process.argv[3] === 'workspace' && to === process.env.MONITOR_TEST_SLOT_COMPAT_PATH) {
    const holder = JSON.parse(fs.readFileSync(to, 'utf8'));
    if (holder.pgid !== null) {
      delayed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    }
  }
  return result;
};
syncBuiltinESMExports();
