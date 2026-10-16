import { spawn } from 'node:child_process';
import { errorDocument } from './rows.mjs';

export function sourceEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && (key === 'PATH' || key === 'HOME' || key.startsWith('ORG_'))));
}
// Resolve only after exit: the next invocation cannot overlap a timed-out child.
export function runCommand(command, args, { cwd, env = process.env, timeout = 10000, limit = 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    let child, code = null, bytes = 0, chunks = [], timer;
    try { child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolve({ code: 'source-exit' }); return; }
    const stop = reason => {
      if (code) return;
      code = reason; chunks = []; child.kill('SIGKILL');
      // Inherited pipes must not keep a completed/killed source past its deadline.
      child.stdout.destroy(); child.stderr.destroy();
    };
    timer = setTimeout(() => stop('source-timeout'), timeout);
    child.stdout.on('data', data => {
      bytes += data.length;
      if (bytes > limit) stop('source-oversize');
      if (!code) chunks.push(data);
    });
    // Stderr is drained and discarded; it never becomes an error message.
    child.stderr.resume();
    child.on('error', () => { code ??= 'source-exit'; });
    child.on('close', status => {
      clearTimeout(timer);
      resolve(code || status !== 0 ? { code: code ?? 'source-exit' } : { text: Buffer.concat(chunks).toString('utf8') });
    });
  });
}
export function scriptSource({ name, script, project, env = process.env, timeout = 10000, now = Date.now } = {}) {
  let pending, lastAt = -Infinity, previous;
  return {
    async read() {
      if (pending) return pending;
      if (previous && now() - lastAt < 5000) return previous;
      lastAt = now();
      pending = (async () => {
        const r = await runCommand(process.execPath, [script], { cwd: project, env: sourceEnvironment(env), timeout });
        if (r.code) return errorDocument(name, r.code);
        let doc;
        try { doc = JSON.parse(r.text); } catch { return errorDocument(name, 'source-json'); }
        return doc?.schema === 'board-rows/v1' && Array.isArray(doc.rows) ? doc : errorDocument(name, 'source-schema');
      })();
      try { previous = await pending; return previous; } finally { pending = null; }
    },
  };
}
