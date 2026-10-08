// Test processes must override history in-process as well as in child envs:
// worktrees (including merge-batch scratch trees) share the real Git directory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
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
// Only published history files matter. Locks, atomic-write temp files and
// concurrent pruning are ordinary activity in this shared directory.
export function gateHistories(directory) {
  let names;
  try { names = fs.readdirSync(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') console.error(`TEST_GATE_HISTORY_DIAGNOSTIC: ${error.message}`);
    return [];
  }
  const histories = [];
  for (const name of names.filter(name => /^[0-9a-f]{64}\.json$/.test(name))) {
    try {
      const history = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      if (history.schema === 'gate-watchdog/v1' && Array.isArray(history.runs)) histories.push(history);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`TEST_GATE_HISTORY_DIAGNOSTIC: ${error.message}`);
    }
  }
  return histories;
}
let initialized = false;
export function isolateGateHistory() {
  if (initialized) return;
  initialized = true;
  const common = projectCommon(fileURLToPath(new URL('../../', import.meta.url)));
  const real = common && path.join(common, 'gate-watchdog');
  // A nested test process keeps its parent's origin even when it installs its
  // own scratch root. Product children inherit the token if the root is lost.
  const origin = process.env.MONITOR_GATE_HISTORY_ORIGIN ??= randomUUID();
  // Never trust a caller's inherited override: each test process owns a fresh
  // root, then product children inherit it without importing this helper.
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'gh-'));
  process.env.MONITOR_GATE_HISTORY_ROOT = root;
  process.once('exit', () => {
    const histories = real ? gateHistories(real) : [];
    if (histories.some(history => history.runs.some(run => run.origin === origin))) {
      console.error(`TEST_GATE_HISTORY_LEAK: test origin ${origin} wrote ${real}`);
      process.exitCode = 1;
    } else if (histories.length) {
      console.error(`TEST_GATE_HISTORY_DIAGNOSTIC: shared history contains ${histories.length} command files from other origins`);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
}
