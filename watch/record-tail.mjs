// A notification filter, never authority: relevant or unreadable input wakes
// the watcher's existing full record/ownership checks before any effect.
import fs from 'node:fs';

export function createRunEventTail(file, { run, item, io = fs }) {
  let previous;
  try { previous = io.statSync(file); } catch { /* The next check wakes. */ }
  let offset = previous?.size ?? 0;
  let pending = Buffer.alloc(0);
  const concernsRun = line => {
    if (!line.toString('utf8').trim()) return false;
    const event = JSON.parse(line.toString('utf8'));
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw Error('invalid record event');
    switch (event.type) {
      case 'run.claimed':
      case 'report.ingested': return event.run === run;
      case 'run.abandoned': return event.id === run;
      case 'item.closed': return event.id === item;
      default: return false;
    }
  };
  return () => {
    try {
      const current = io.statSync(file);
      // Replacement/truncation cannot be interpreted as an appended tail.
      if (!previous || current.dev !== previous.dev || current.ino !== previous.ino || current.size < offset) return true;
      if (current.size === offset) return current.mtimeMs !== previous.mtimeMs;
      const fd = io.openSync(file, 'r');
      try {
        const opened = io.fstatSync(fd);
        if (opened.dev !== current.dev || opened.ino !== current.ino || opened.size < current.size) return true;
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, current.size - offset));
        while (offset < current.size) {
          const bytes = io.readSync(fd, buffer, 0, Math.min(buffer.length, current.size - offset), offset);
          if (!bytes) return true;
          offset += bytes;
          const chunk = buffer.subarray(0, bytes);
          const lines = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          let start = 0, end;
          while ((end = lines.indexOf(10, start)) !== -1) {
            if (concernsRun(lines.subarray(start, end))) return true;
            start = end + 1;
          }
          // Copy because the read buffer is reused for the next chunk.
          pending = Buffer.from(lines.subarray(start));
        }
      } finally { io.closeSync(fd); }
      previous = current;
      // The record accepts a complete final event without a newline. Retain
      // its bytes until the writer adds the separator; torn JSON wakes safely.
      return pending.length ? concernsRun(pending) : false;
    } catch { return true; }
  };
}
