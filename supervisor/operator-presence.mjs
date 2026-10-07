// Read-only macOS presence. No daemon, cached state or operator away toggle.
import { spawnSync } from 'node:child_process';

export const AWAY_AFTER_SECONDS = 15 * 60;

export function parsePresence(idleText, consoleText, uid) {
  const idle = [...idleText.matchAll(/"HIDIdleTime"\s*=\s*(\d+)/gu)];
  const line = consoleText.split('\n').find(row => /"IOConsoleUsers"\s*=/.test(row));
  if (idle.length !== 1 || !line || !Number.isSafeInteger(uid)) return { away: true, reason: 'presence unknown' };
  // IOConsoleUsers omits the screen-lock key when unlocked. Require a fully
  // logged-in console session for this process's user before accepting absence.
  const list = line.match(/"IOConsoleUsers"\s*=\s*\((.*)\)\s*$/u)?.[1];
  if (!list || !/^[\s,]*$/u.test(list.replace(/\{[^{}]*\}/gu, ''))) return { away: true, reason: 'presence unknown' };
  const sessions = [...list.matchAll(/\{[^{}]*\}/gu)].map(match => match[0]);
  const onConsole = sessions.filter(row => /"kCGSSessionOnConsoleKey"\s*=\s*Yes(?:,|\})/u.test(row));
  if (onConsole.length !== 1) return { away: true, reason: 'presence unknown' };
  const session = onConsole[0];
  if (/"IOConsoleSessionScreenIsLocked"\s*=\s*Yes(?:,|\})/u.test(session)) return { away: true, reason: 'screen locked' };
  if (!/"kCGSessionLoginDoneKey"\s*=\s*Yes(?:,|\})/u.test(session) ||
      !new RegExp(`"kCGSSessionUserIDKey"\\s*=\\s*${uid}(?:,|\\})`, 'u').test(session))
    return { away: true, reason: 'presence unknown' };
  const lock = session.match(/"IOConsoleSessionScreenIsLocked"\s*=\s*([^,}]+)/u);
  if (lock && lock[1] !== 'No') return { away: true, reason: 'presence unknown' };
  const away = BigInt(idle[0][1]) >= BigInt(AWAY_AFTER_SECONDS) * 1_000_000_000n;
  return { away, reason: away ? 'Mac idle for at least 15 minutes' : 'operator present' };
}

export function operatorPresence({ platform = process.platform, uid = process.getuid?.(), run = spawnSync } = {}) {
  if (platform !== 'darwin') return { away: true, reason: 'presence unknown' };
  try {
    const read = args => {
      const result = run('/usr/sbin/ioreg', args, { encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string') throw new Error('presence read failed');
      return result.stdout;
    };
    return parsePresence(read(['-r', '-c', 'IOHIDSystem', '-d', '1', '-w', '0']), read(['-n', 'Root', '-d', '1', '-w', '0']), uid);
  } catch { return { away: true, reason: 'presence unknown' }; }
}
