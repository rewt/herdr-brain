// Test processes must override history in-process as well as in child envs:
// worktrees (including merge-batch scratch trees) share the real Git directory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectCommon } from '../../test-slot/limits.mjs';

export function historySnapshot(directory) {
  if (!fs.existsSync(directory)) return null;
  const stat = fs.lstatSync(directory);
  return [stat.mode, stat.mtimeMs, stat.ctimeMs, fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    return [name, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
      stat.isDirectory() ? historySnapshot(file) : stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString('base64')];
  })];
}
let initialized = false;
export function isolateGateHistory() {
  if (initialized) return;
  initialized = true;
  const common = projectCommon(fileURLToPath(new URL('../../', import.meta.url)));
  const real = common && path.join(common, 'gate-watchdog');
  const before = real && JSON.stringify(historySnapshot(real));
  // Never trust a caller's inherited override: each test process owns a fresh
  // root, then product children inherit it without importing this helper.
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'gh-'));
  process.env.MONITOR_GATE_HISTORY_ROOT = root;
  process.once('exit', () => {
    if (real && JSON.stringify(historySnapshot(real)) !== before) {
      console.error(`TEST_GATE_HISTORY_LEAK: test modified ${real}`);
      process.exitCode = 1;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
}
