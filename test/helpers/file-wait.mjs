import fs from 'node:fs';
import path from 'node:path';
import { loadTimeout } from '../../lib/deadline.mjs';
import { currentTest } from './bounded-test.mjs';

const parent = file => {
  let directory = path.dirname(file);
  while (!fs.existsSync(directory)) directory = path.dirname(directory);
  return directory;
};
// Notifications accelerate rechecks; they cannot guarantee delivery after a
// subscription or across ancestor changes. A bounded backoff also follows newly
// created parents and rereads evidence, so a lost event cannot strand the wait.
// A notification is never evidence.
export function waitForChange(files, predicate, { timeoutMs = 10_000, signal = currentTest().signal } = {}) {
  return new Promise((resolve, reject) => {
    const watchers = new Map();
    let timer, recheckTimer, backoffMs = 10, finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(recheckTimer);
      for (const watcher of watchers.values()) watcher.close();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new DOMException('file wait cancelled', 'AbortError'));
    const check = () => {
      if (finished) return;
      try {
        const directories = new Set(files.map(parent));
        for (const [directory, watcher] of watchers) if (!directories.has(directory)) { watcher.close(); watchers.delete(directory); }
        for (const directory of directories) if (!watchers.has(directory)) {
          const watcher = fs.watch(directory, check); watcher.once('error', finish); watchers.set(directory, watcher);
        }
        const value = predicate();
        if (value) finish(null, value);
        else {
          clearTimeout(recheckTimer);
          recheckTimer = setTimeout(check, backoffMs);
          backoffMs = Math.min(250, backoffMs * 2);
        }
      } catch (error) { finish(error); }
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      // A busy event loop may resume with both timers due. Read evidence once
      // more before declaring the measured-load deadline exhausted.
      check();
      finish(Error(`timed out waiting for ${files.join(', ')}`));
    }, loadTimeout(timeoutMs));
    check();
  });
}
export function waitForFile(file, predicate = () => true, options) {
  return waitForChange([file], () => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    return predicate(text) ? text || true : false;
  }, options);
}
