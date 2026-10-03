import { execFileSync } from "node:child_process";
import fs from "node:fs";

const START_PREFIX = "ps-utc-c:";
const reasonOf = (error) => (error instanceof Error ? (error.code ?? error.message) : String(error));

/** A pid's start identity, with ps's time zone and locale fixed for every caller. */
export function processStart(pid) {
  const env = { ...process.env, TZ: "UTC", LC_ALL: "C" };
  delete env.LC_TIME;
  const start = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (start.length === 0) throw new Error(`ps gave no start time for pid ${String(pid)}`);
  return START_PREFIX + start;
}

/** kill(target, 0): true on success or EPERM, false on ESRCH, otherwise the error. */
export function probe(target) {
  try { process.kill(target, 0); return true; } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return error;
  }
}

/** A pid and its recorded start identity: live, gone, or unknown. */
export function processState(pid, start) {
  const exists = probe(pid);
  if (exists === false) return { state: "gone" };
  if (exists !== true) return { state: "unknown", why: `kill(${String(pid)}, 0) failed: ${reasonOf(exists)}` };
  if (typeof start !== "string" || start.length === 0) return { state: "unknown", why: `pid ${String(pid)} runs and the holder recorded no start time to compare` };
  // An older runner recorded its caller's local time. Never reinterpret that as UTC and evict a live runner.
  if (!start.startsWith(START_PREFIX)) return { state: "unknown", why: `pid ${String(pid)} runs and the holder recorded an environment-dependent start time` };
  let now;
  try { now = processStart(pid); } catch (error) {
    if (probe(pid) === false) return { state: "gone" };
    return { state: "unknown", why: `ps could not read pid ${String(pid)}'s start time: ${reasonOf(error)}` };
  }
  return now === start ? { state: "live" } : { state: "gone" };
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
