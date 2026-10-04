// The operator's hands on one Herdr terminal, inside the console. Herdr's
// `terminal session control` streams the same frames as the read-only observer
// and takes JSON commands on stdin: input, resize, scroll and release. While it
// controls a pane, Herdr sizes that pane's terminal to this viewport; releasing
// it gives the pane its native size back. Stopping never closes the pane.
import { spawn } from 'node:child_process';
import { sanitize } from '../lib/text.mjs';
import { createTerminalDecoder, track, validPane, MAX_LINE } from './terminal.mjs';
export { BACK_KEY, splitInput } from './session-input.mjs';

const fits = (cols, rows) => Number.isSafeInteger(cols) && Number.isSafeInteger(rows) && cols > 0 && rows > 0 && cols <= 400 && rows <= 160;

export function controlTerminal({ pane, cols, rows, onFrame, onError, onClose, binary, env = process.env, spawnImpl = spawn, takeover = false }) {
  const decoder = createTerminalDecoder();
  let child, stopped = false, closed = false, pending = '', stderr = '', firstTimer, killTimer;
  const send = command => { if (!stopped && child?.stdin?.writable) child.stdin.write(JSON.stringify(command) + '\n'); };
  // Release first so Herdr restores the pane's size; the process then exits.
  function release() {
    if (stopped) return;
    send({ type: 'terminal.release' });
    stopped = true; clearTimeout(firstTimer);
    try { child?.stdin?.end(); } catch {}
    if (child && !closed) { killTimer = setTimeout(() => { if (!closed) child.kill('SIGTERM'); }, 1500); killTimer.unref?.(); }
  }
  function fail(error) { if (stopped) return; release(); onError?.(sanitize(error?.message ?? String(error))); }
  try {
    if (!validPane(pane)) throw Error('An exact Herdr pane ID is required');
    if (!fits(cols, rows)) throw Error('Unsupported terminal size');
    const args = ['terminal', 'session', 'control', pane, '--cols', String(cols), '--rows', String(rows), ...(takeover ? ['--takeover'] : [])];
    child = track(spawnImpl(binary ?? env.HERDR_BIN_PATH ?? 'herdr', args, { env, stdio: ['pipe', 'pipe', 'pipe'] }));
    child.stdin.on?.('error', () => {});
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (stopped) return;
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (line.length > MAX_LINE) { fail(Error('Herdr terminal record is too large')); return; }
        try {
          const record = JSON.parse(line);
          if (record.type === 'terminal.closed') { stopped = true; onClose?.(typeof record.reason === 'string' ? record.reason : 'closed'); return; }
          const grid = decoder.decode(record); clearTimeout(firstTimer); onFrame?.(grid);
        } catch (error) { fail(error); return; }
        if (stopped) return;
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', fail);
    child.once('close', (code, signal) => {
      closed = true; clearTimeout(killTimer); clearTimeout(firstTimer);
      if (!stopped) fail(Error(stderr.trim() || `Herdr terminal control disconnected${code != null ? ` (exit ${code})` : signal ? ` (${signal})` : ''}`));
    });
    firstTimer = setTimeout(() => fail(Error('Herdr did not hand over the terminal; retry, or open it natively with o')), 8000); firstTimer.unref?.();
  } catch (error) { fail(error); }
  return {
    // Raw bytes exactly as the operator's terminal produced them.
    input(bytes) { if (bytes?.length) send({ type: 'terminal.input', bytes: Buffer.from(bytes).toString('base64') }); },
    resize(c, r) { if (fits(c, r)) send({ type: 'terminal.resize', cols: c, rows: r }); },
    scroll(direction, lines = 3) { send({ type: 'terminal.scroll', direction: direction === 'up' ? 'up' : 'down', lines }); },
    release, stop: release,
  };
}
