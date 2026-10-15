// Only the fixed watchdog scenarios load this preload. Keep genuine product
// groups, but bound every Node generation before exec, including orphans after
// a killed suite. The fixed entrypoint compiled this existing six-second guard.
import { ChildProcess } from 'node:child_process';
import path from 'node:path';

const root = process.env.HERDR_NATIVE_GROUP_FIXTURE_ROOT;
if (!root || !path.isAbsolute(root)) throw Error('missing native group fixture root');
const nativeSpawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (options) {
  if (options.file === process.execPath) {
    const args = [...options.args];
    // These fixed inline scripts ignore argv. A root marker lets report-only
    // teardown discover a reparented leaf even after both wrappers disappear.
    if (args.includes('-e')) args.push(root);
    options.file = path.join(root, 'fixture-deadline');
    options.args = [options.file, ...args];
  }
  return nativeSpawn.call(this, options);
};
