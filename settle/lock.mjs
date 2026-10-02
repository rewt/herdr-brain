import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Unique contenders serialize stale-owner cleanup as well as acquisition.
// A live contender is never removed, even when both contenders choose to refuse.
export function acquire(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const own = path.join(directory, `${process.pid}-${randomUUID()}`);
  fs.writeFileSync(own, '', { flag: 'wx', mode: 0o600 });
  const release = () => { try { fs.unlinkSync(own); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
  try {
    for (const entry of fs.readdirSync(directory)) {
      if (entry === path.basename(own)) continue;
      const pid = Number(entry.split('-')[0]);
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('invalid settle lock owner; inspect lock directory');
      try { process.kill(pid, 0); throw new Error(`settle already running (pid ${pid})`); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      try { fs.unlinkSync(path.join(directory, entry)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return release;
  } catch (e) { release(); throw e; }
}
