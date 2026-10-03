import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { lookupProcess } from "../lib/processes.mjs";
import { loadTimeout } from "../lib/deadline.mjs";

const START_PREFIX = "ps-utc-c:";
const reasonOf = (error) => (error instanceof Error ? (error.code ?? error.message) : String(error));

/** Preserve the legacy bch-cloak wire format, using kernel data instead of ps. */
export function legacyStart(identity, { platform = process.platform, readFile = fs.readFileSync, execute = spawnSync } = {}) {
  let seconds;
  if (platform === 'darwin') seconds = Number(identity.split(':')[0]);
  else if (platform === 'linux') {
    const boot = String(readFile('/proc/stat', 'utf8')).match(/^btime (\d+)$/m);
    const ticks = execute('/usr/bin/getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: loadTimeout(2000), killSignal: 'SIGKILL' });
    const hz = Number(ticks.stdout?.trim());
    if (!boot || ticks.error || ticks.status !== 0 || ticks.stderr?.trim() || !Number.isSafeInteger(hz) || hz < 1)
      throw Error('process source clock ticks unavailable');
    seconds = Number(boot[1]) + Math.floor(Number(identity) / hz);
  } else throw Error(`process source unavailable on ${platform}`);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw Error('invalid process source start seconds');
  const date = new Date(seconds * 1000), pad = n => String(n).padStart(2, '0');
  if (!Number.isFinite(date.getTime())) throw Error('invalid process source start date');
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()];
  return `${START_PREFIX}${weekday} ${month} ${String(date.getUTCDate()).padStart(2, ' ')} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${date.getUTCFullYear()}`;
}
export function processStartRecord(pid, { platform = process.platform, lookup = lookupProcess, readFile = fs.readFileSync, execute = spawnSync } = {}) {
  const result = lookup(pid, { identityOnly: true, platform, readFile, execute });
  if (!result.ok || !result.value) throw Error(result.error ?? `process source gave no start time for pid ${pid}`);
  let boot = '';
  if (platform === 'linux') {
    boot = String(readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(boot)) throw Error('process source boot identity unavailable');
    boot += ':';
  }
  return { start: legacyStart(result.value.identity, { platform, readFile, execute }), birth: `${platform}:${boot}${result.value.identity}` };
}
export const processStart = pid => processStartRecord(pid).start;

/** kill(target, 0): true on success or EPERM, false on ESRCH, otherwise the error. */
export function probe(target) {
  try { process.kill(target, 0); return true; } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return error;
  }
}

/** A pid and its recorded start identity: live, gone, or unknown. */
export function processState(pid, start, birth) {
  const exists = probe(pid);
  if (exists === false) return { state: "gone" };
  if (exists !== true) return { state: "unknown", why: `kill(${String(pid)}, 0) failed: ${reasonOf(exists)}` };
  if (typeof start !== "string" || start.length === 0) return { state: "unknown", why: `pid ${String(pid)} runs and the holder recorded no start time to compare` };
  // An older runner recorded its caller's local time. Never reinterpret that as UTC and evict a live runner.
  if (!start.startsWith(START_PREFIX)) return { state: "unknown", why: `pid ${String(pid)} runs and the holder recorded an environment-dependent start time` };
  let now;
  try { now = processStartRecord(pid); } catch (error) {
    if (probe(pid) === false) return { state: "gone" };
    return { state: "unknown", why: `process source could not read pid ${String(pid)}'s start time: ${reasonOf(error)}` };
  }
  if (birth !== undefined && birth !== null && (typeof birth !== 'string' || !/^(darwin:\d+:\d+|linux:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}:\d+)$/.test(birth)))
    return { state: 'unknown', why: 'holder has a malformed kernel birth identity' };
  const matches = birth === undefined || birth === null ? now.start === start : birth === now.birth;
  return matches ? { state: "live" } : { state: "gone" };
}

/**
 * Serialize stale removers before rechecking the record. A paused remover cannot delete another taker's fresh lock.
 * Only known-stale records reach this helper. Ordinary exclusive creation still arbitrates the next holder.
 * An occupied guard (including one abandoned by a crash) throws: callers refuse as unknown, never break it by age.
 */
export function removeStaleLock(lockPath, expectedText) {
  const guardPath = `${lockPath}.takeover`;
  const guard = fs.openSync(guardPath, "wx", 0o600);
  try {
    let current;
    try { current = fs.readFileSync(lockPath, "utf8"); } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (current === expectedText) fs.rmSync(lockPath, { force: true });
  } finally {
    fs.closeSync(guard);
    fs.rmSync(guardPath);
  }
}
