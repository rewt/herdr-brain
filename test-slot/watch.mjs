// Foreground watch only: silence is a notice; only confirmed inactivity stops.
import { spawnSync } from 'node:child_process';
import { lookupProcess } from '../lib/processes.mjs';
import { descendants } from './watchdog.mjs';

import { frozenSeconds, SILENCE_SECONDS } from './limits.mjs';
export { frozenSeconds, FROZEN_SECONDS_ENV, FROZEN_SECONDS, SILENCE_SECONDS } from './limits.mjs';

// CPU time is queried only for birth-confirmed owned processes, then identities
// are checked again. An incomplete audit never supplies proof of inactivity.
export function activitySnapshot(pid, { ownsGroup = true, lookup = lookupProcess, execute = spawnSync } = {}) {
  const before = lookup(undefined, { identityOnly: true });
  if (!before.ok || !before.value.has(pid)) return null;
  const family = descendants(before.value, pid);
  if (ownsGroup) for (const row of before.value.values()) if (row.pgid === pid) family.set(row.pid, row);
  const result = execute('/bin/ps', ['-o', 'pid=,time=,stat=', '-p', [...family.keys()].join(',')], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.error || result.signal || result.status !== 0 || result.stderr?.trim()) return null;
  const cpu = new Map();
  for (const line of result.stdout.trim().split('\n')) {
    const match = /^\s*(\d+)\s+((?:\d+-)?\d+(?::\d{2}){1,2}(?:\.\d+)?)\s+([A-Za-z+<>-]+)\s*$/.exec(line);
    if (!match || cpu.has(Number(match[1]))) return null;
    cpu.set(Number(match[1]), { time: match[2], state: match[3] });
  }
  const after = lookup(undefined, { identityOnly: true });
  if (!after.ok || cpu.size !== family.size) return null;
  const rows = [];
  for (const row of family.values()) {
    const current = after.value.get(row.pid);
    if (current?.identity !== row.identity || !cpu.has(row.pid)) return null;
    // Darwin's kernel p_stat=SRUN includes sleeping tasks; ps reports the
    // actual thread scheduling state alongside its cumulative CPU time.
    rows.push({ pid: row.pid, identity: row.identity, ppid: current.ppid, pgid: current.pgid, state: cpu.get(row.pid).state, cpu: cpu.get(row.pid).time });
  }
  return rows.sort((a, b) => a.pid - b.pid);
}

// Injectable monotonic clock/audit keep frozen, busy and unknown cases testable
// without waiting real minutes. Runnable processes always count as activity.
export function watchRun({ pid, ownsGroup = true, idleSeconds = SILENCE_SECONDS, frozen = frozenSeconds(),
  silenceState = { notified: false },
  now = () => Number(process.hrtime.bigint()) / 1e9, sample = () => activitySnapshot(pid, { ownsGroup }),
  onSilence = () => {}, onFrozen = () => {}, intervalMs = Math.min(30000, Math.max(50, frozen * 250 || 30000), Math.max(50, idleSeconds * 250 || 30000)), startTimer = true }) {
  const start = now();
  let outputAt = start, activityAt = start, longest = 0, previous, stopped = false;
  const observations = [], audits = { samples: 0, unavailable: 0, changes: 0 };
  const output = () => { const at = now(); longest = Math.max(longest, at - outputAt); outputAt = at; };
  const tick = () => {
    const at = now(), silence = at - outputAt;
    longest = Math.max(longest, silence);
    if (!silenceState.notified && idleSeconds > 0 && silence >= idleSeconds) {
      silenceState.notified = true;
      const observation = { kind: 'silence', elapsed_s: at - start, silence_s: silence, threshold_seconds: idleSeconds };
      observations.push(observation); onSilence(observation);
    }
    if (frozen === 0 || stopped) return;
    let rows;
    try { rows = sample(); } catch { rows = null; }
    audits.samples++;
    const signature = rows?.length ? JSON.stringify(rows) : undefined;
    if (!signature) { audits.unavailable++; activityAt = at; previous = undefined; }
    else if (signature !== previous || rows.some(row => /R/.test(row.state))) { activityAt = at; audits.changes++; }
    previous = signature;
    if (signature && silence >= frozen && at - activityAt >= frozen) {
      stopped = true;
      const observation = { kind: 'frozen', limit_seconds: frozen, elapsed_s: at - start, silence_s: silence, inactivity_s: at - activityAt, processes: rows };
      observations.push(observation); onFrozen(observation);
    }
  };
  tick();
  const timer = startTimer ? setInterval(tick, intervalMs) : undefined;
  return { output, tick, stop: () => clearInterval(timer), snapshot() {
    return { duration_s: now() - start, longest_silence_s: Math.max(longest, now() - outputAt), observations, activity_audits: audits };
  } };
}
