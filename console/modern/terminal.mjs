// A read-only Herdr observer. ANSI is decoded into cells, never written to our
// terminal. This deliberately has no input, focus, attach, control or resize API.
import { spawn } from 'node:child_process';
import { charWidth, sanitize } from '../lib/text.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_LINE = Math.ceil(MAX_BYTES / 3) * 4 + 1024;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const baseColors = ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5', '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff'];
const defaults = () => ({ fg: 'terminalFg', bg: 'terminalBg', bold: false, dim: false, italic: false, underline: false, inverse: false, strikethrough: false, hidden: false });
const integer = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;
const validPane = pane => typeof pane === 'string' && /^w[^\s:]+:p[^\s:]+$/.test(pane) && pane.length <= 128 && !/[\x00-\x1f\x7f]/.test(pane);
const hex = values => '#' + values.map(v => v.toString(16).padStart(2, '0')).join('');
function indexed(n) {
  if (!Number.isInteger(n) || n < 0 || n > 255) throw Error('Invalid terminal color');
  if (n < 16) return baseColors[n];
  if (n >= 232) return hex(Array(3).fill(8 + (n - 232) * 10));
  const k = n - 16, scale = [0, 95, 135, 175, 215, 255];
  return hex([scale[Math.floor(k / 36)], scale[Math.floor(k / 6) % 6], scale[k % 6]]);
}
function graphemeWidth(text) {
  if (/\p{Emoji_Presentation}|\p{Regional_Indicator}|\ufe0f|\u20e3/u.test(text)) return 2;
  return Math.max(0, ...[...text].map(charWidth));
}

// Crop display cells without splitting a grapheme or leaking half of a wide
// character into a neighboring console region. A clipped half becomes a space.
export function cropTerminalSpans(spans, left, width) {
  if (!Number.isSafeInteger(left) || left < 0 || !integer(width, 400)) throw Error('Invalid terminal crop');
  const result = []; let position = 0, emitted = 0, lastKey;
  const append = (text, style) => {
    const key = JSON.stringify(style);
    if (key === lastKey) result.at(-1).text += text;
    else { result.push({ ...style, text }); lastKey = key; }
  };
  for (const { text, ...style } of spans) {
    for (const { segment } of segmenter.segment(text)) {
      const size = graphemeWidth(segment), end = position + size;
      if (!size) { if (emitted && position <= left + width) append(segment, style); continue; }
      const from = Math.max(left, position), to = Math.min(left + width, end);
      if (to > from) { append(from === position && to === end ? segment : ' '.repeat(to - from), style); emitted += to - from; }
      position = end;
      if (position >= left + width) break;
    }
    if (position >= left + width) break;
  }
  if (emitted < width) { const { hidden, ...style } = defaults(); append(' '.repeat(width - emitted), style); }
  return result;
}

/** Stateful decoder for Herdr's full frame followed by differential ANSI cells.
 * Returned grids are independent immutable-by-convention snapshots, not PTYs.
 * Gaps in differential frames fail visibly; a full frame can resynchronize. */
export function createTerminalDecoder() {
  let width = 0, height = 0, seq = 0, cells = [], x = 0, y = 0, saved = null, style = defaults();
  const blank = () => ({ text: ' ', width: 1, style: { ...style } });
  function clearCell(col, row) {
    if (col < 0 || col >= width || row < 0 || row >= height) return;
    const index = row * width + col, old = cells[index];
    if (old?.width === 0 && col > 0) cells[index - 1] = blank();
    if (old?.width === 2 && col + 1 < width) cells[index + 1] = blank();
    cells[index] = blank();
  }
  const position = (col, row) => { x = Math.max(0, Math.min(width - 1, col)); y = Math.max(0, Math.min(height - 1, row)); };
  const erase = (from, to) => { for (let i = Math.max(0, from); i <= Math.min(cells.length - 1, to); i++) clearCell(i % width, Math.floor(i / width)); };
  function put(text) {
    for (const { segment } of segmenter.segment(text)) {
      if (/[\u202a-\u202e\u2066-\u2069]/u.test(segment)) continue;
      const size = graphemeWidth(segment);
      if (!size) {
        let col = Math.min(x - 1, width - 1);
        if (col >= 0 && cells[y * width + col]?.width === 0) col--;
        if (col >= 0) cells[y * width + col].text += segment;
        continue;
      }
      // Herdr addresses each rendered row explicitly. Do not let a glyph at the
      // edge wrap/scroll the observer and thereby move the host's actual pane.
      if (x >= width || x + size > width) continue;
      clearCell(x, y); if (size === 2) clearCell(x + 1, y);
      cells[y * width + x] = { text: style.hidden ? ' '.repeat(size) : segment, width: size, style: { ...style } };
      if (size === 2) cells[y * width + x + 1] = { text: '', width: 0, style: { ...style } };
      x += size;
    }
  }
  function sgr(raw) {
    const parts = raw === '' ? ['0'] : raw.split(';');
    for (let i = 0; i < parts.length; i++) {
      const colon = parts[i].split(':'), n = Number(colon[0] || 0);
      if (!Number.isInteger(n)) throw Error('Invalid terminal style');
      if (n === 0) style = defaults();
      else if (n === 1) style.bold = true;
      else if (n === 2) style.dim = true;
      else if (n === 3) style.italic = true;
      else if (n === 4) style.underline = colon.length === 1 || Number(colon[1]) !== 0;
      else if (n === 7) style.inverse = true;
      else if (n === 8) style.hidden = true;
      else if (n === 9) style.strikethrough = true;
      else if (n === 22) { style.bold = false; style.dim = false; }
      else if (n === 23) style.italic = false;
      else if (n === 24) style.underline = false;
      else if (n === 27) style.inverse = false;
      else if (n === 28) style.hidden = false;
      else if (n === 29) style.strikethrough = false;
      else if (n === 39) style.fg = 'terminalFg';
      else if (n === 49) style.bg = 'terminalBg';
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) style.fg = indexed(n < 90 ? n - 30 : n - 90 + 8);
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) style.bg = indexed(n < 100 ? n - 40 : n - 100 + 8);
      else if (n === 38 || n === 48 || n === 58) {
        let mode, values;
        if (colon.length > 1) {
          mode = Number(colon[1]); values = colon.slice(2);
          if (mode === 2 && values.length === 4 && (values[0] === '' || values[0] === '0')) values.shift();
        } else {
          mode = Number(parts[++i]); const count = mode === 2 ? 3 : mode === 5 ? 1 : 0;
          if (!count) throw Error('Unsupported terminal color encoding');
          values = parts.slice(i + 1, i + 1 + count); i += count;
        }
        const numbers = values.map(Number), count = mode === 2 ? 3 : mode === 5 ? 1 : 0;
        if (!count || numbers.length !== count || values.some(v => v === '') || numbers.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw Error('Invalid terminal color');
        const value = mode === 2 ? hex(numbers) : indexed(numbers[0]);
        if (n !== 58) style[n === 38 ? 'fg' : 'bg'] = value;
      }
      // Blink is intentionally static; underline color/style has a plain
      // underline fallback. No escape sequence or terminal mode is forwarded.
      else if (![5, 6, 21, 25, 59].includes(n)) throw Error(`Unsupported terminal style ${n}`);
    }
  }
  function csi(raw, final) {
    if ((final === 'h' || final === 'l') && /^[?\d;]*$/.test(raw)) return;
    if (final === 'q' && /^\d* $/.test(raw)) return; // cursor shape
    if (final === 'm') { sgr(raw); return; }
    if (!/^[\d;]*$/.test(raw)) throw Error('Unsupported terminal control');
    const p = raw.split(';').map(v => Number(v || 0));
    if (p.some(v => !Number.isSafeInteger(v) || v > 1000000)) throw Error('Invalid terminal position');
    const n = p[0] || 1;
    if (final === 'H' || final === 'f') position((p[1] || 1) - 1, n - 1);
    else if (final === 'G' || final === '`') position(n - 1, y);
    else if (final === 'd') position(x, n - 1);
    else if (final === 'A') position(x, y - n);
    else if (final === 'B' || final === 'e') position(x, y + n);
    else if (final === 'C' || final === 'a') position(x + n, y);
    else if (final === 'D') position(x - n, y);
    else if (final === 'E') position(0, y + n);
    else if (final === 'F') position(0, y - n);
    else if (final === 's') saved = { x, y, style: { ...style } };
    else if (final === 'u' && saved) { position(saved.x, saved.y); style = { ...saved.style }; }
    else if (final === 'u') return;
    else if (final === 'J') {
      if (p[0] === 0) erase(y * width + x, cells.length - 1);
      else if (p[0] === 1) erase(0, y * width + x);
      else if (p[0] === 2 || p[0] === 3) erase(0, cells.length - 1);
      else throw Error('Unsupported terminal erase');
    } else if (final === 'K') {
      if (p[0] === 0) erase(y * width + x, (y + 1) * width - 1);
      else if (p[0] === 1) erase(y * width, y * width + x);
      else if (p[0] === 2) erase(y * width, (y + 1) * width - 1);
      else throw Error('Unsupported terminal erase');
    } else if (final === 'X') erase(y * width + x, y * width + Math.min(width - 1, x + n - 1));
    else throw Error(`Unsupported terminal control ${final}`);
  }
  function decodeAnsi(text) {
    for (let i = 0; i < text.length;) {
      let ch = text[i++];
      if (ch === '\x1b') {
        ch = text[i++];
        if (ch === '[') ch = '\x9b';
        else if (ch === ']') ch = '\x9d';
        else if (['P', 'X', '^', '_'].includes(ch)) ch = '\x90';
        else if (ch === '7') { saved = { x, y, style: { ...style } }; continue; }
        else if (ch === '8') { if (saved) { position(saved.x, saved.y); style = { ...saved.style }; } continue; }
        else throw Error('Unsupported terminal escape');
      }
      if (ch === '\x9b') {
        const start = i;
        while (i < text.length && !/[@-~]/.test(text[i])) i++;
        if (i === text.length || i - start > 256) throw Error('Incomplete or oversized terminal control');
        csi(text.slice(start, i), text[i++]);
      } else if (['\x90', '\x98', '\x9d', '\x9e', '\x9f'].includes(ch)) {
        let ended = false;
        while (i < text.length) {
          const control = text[i++];
          if (control === '\x9c' || (ch === '\x9d' && control === '\x07')) { ended = true; break; }
          if (control === '\x1b' && text[i] === '\\') { i++; ended = true; break; }
        }
        if (!ended) throw Error('Incomplete terminal string');
      } else if (ch === '\r') x = 0;
      else if (ch === '\n' || ch === '\v' || ch === '\f') y = Math.min(height - 1, y + 1);
      else if (ch === '\b') x = Math.max(0, x - 1);
      else if (ch === '\t') x = Math.min(width - 1, (Math.floor(x / 8) + 1) * 8);
      else if (ch.charCodeAt(0) < 32 || (ch.charCodeAt(0) >= 127 && ch.charCodeAt(0) < 160)) continue;
      else {
        const start = i - 1;
        while (i < text.length && !/[\x00-\x1f\x7f-\x9f]/.test(text[i])) i++;
        put(text.slice(start, i));
      }
    }
  }
  return {
    decode(frame) {
      if (!frame || frame.type !== 'terminal.frame' || frame.encoding !== 'ansi' || typeof frame.full !== 'boolean'
        || !integer(frame.width, 400) || !integer(frame.height, 160) || !integer(frame.seq, Number.MAX_SAFE_INTEGER)
        || typeof frame.bytes !== 'string' || frame.bytes.length > MAX_LINE - 1024 || frame.bytes.length % 4
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.bytes)) throw Error('Unsupported Herdr terminal frame');
      if (frame.seq <= seq) throw Error('Out-of-order Herdr terminal frame');
      if (!frame.full && (!seq || frame.seq !== seq + 1 || width !== frame.width || height !== frame.height)) throw Error('Herdr terminal frame gap; reopen the session view');
      const bytes = Buffer.from(frame.bytes, 'base64');
      if (bytes.toString('base64') !== frame.bytes) throw Error('Unsupported Herdr terminal frame encoding');
      if (bytes.length > MAX_BYTES) throw Error('Herdr terminal frame is too large');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (frame.full) { width = frame.width; height = frame.height; x = 0; y = 0; saved = null; style = defaults(); cells = Array.from({ length: width * height }, blank); }
      decodeAnsi(text); seq = frame.seq;
      const lines = [];
      for (let row = 0; row < height; row++) {
        const spans = []; let lastKey;
        for (const cell of cells.slice(row * width, (row + 1) * width)) {
          if (!cell.width) continue;
          const { hidden, ...visibleStyle } = cell.style, key = JSON.stringify(visibleStyle);
          if (key === lastKey) spans.at(-1).text += cell.text;
          else { spans.push({ text: cell.text, ...visibleStyle }); lastKey = key; }
        }
        lines.push({ spans });
      }
      return { width, height, seq, lines };
    },
  };
}

/** Owns only the observer subprocess. Closing it never closes the target pane. */
export function observeTerminal({ pane, cols, rows, onFrame, onError, binary, env = process.env, spawnImpl = spawn, followNativeSize = false }) {
  if (followNativeSize) return observeNativeTerminal({ pane, onFrame, onError, binary, env, spawnImpl });
  const decoder = createTerminalDecoder();
  let child, stopped = false, closed = false, pending = '', stderr = '', firstTimer, killTimer;
  function stop() {
    if (stopped) return;
    stopped = true; clearTimeout(firstTimer);
    if (child && !closed) {
      child.kill('SIGTERM');
      if (!closed) { killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 1000); killTimer.unref?.(); }
    }
  }
  function fail(error) { if (stopped) return; stop(); onError?.(sanitize(error?.message ?? String(error))); }
  try {
    if (!validPane(pane)) throw Error('An exact Herdr pane ID is required');
    if (!integer(cols, 400) || !integer(rows, 160)) throw Error('Unsupported observer viewport size');
    child = spawnImpl(binary ?? env.HERDR_BIN_PATH ?? 'herdr', ['terminal', 'session', 'observe', pane, '--cols', String(cols), '--rows', String(rows)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
          if (record.type === 'terminal.closed') { fail(Error(`Herdr terminal closed${typeof record.reason === 'string' ? ': ' + record.reason : ''}`)); return; }
          const grid = decoder.decode(record); clearTimeout(firstTimer); onFrame?.(grid);
        } catch (error) { fail(error); return; }
        if (stopped) return;
      }
      if (pending.length > MAX_LINE) fail(Error('Herdr terminal record is too large'));
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', fail);
    child.once('close', (code, signal) => {
      closed = true; clearTimeout(killTimer); clearTimeout(firstTimer);
      if (!stopped) fail(Error(stderr.trim() || `Herdr terminal observer disconnected${code != null ? ` (exit ${code})` : signal ? ` (${signal})` : ''}`));
    });
    firstTimer = setTimeout(() => fail(Error('Herdr terminal observer did not provide a frame; retry or open the native terminal')), 8000); firstTimer.unref?.();
  } catch (error) { fail(error); }
  return { stop };
}

// Observe the complete native viewport, then let the caller crop the decoded
// grid locally. A compact observer requested directly from Herdr clips the TOP
// of the source screen and can silently hide the agent's latest work/prompt.
function observeNativeTerminal({ pane, onFrame, onError, binary, env, spawnImpl }) {
  let stopped = false, observer = null, probeStop = null, pollTimer, sizeKey = null, generation = 0;
  function stop() {
    if (stopped) return;
    stopped = true; generation++; clearTimeout(pollTimer); observer?.stop(); probeStop?.();
  }
  function fail(error) { if (stopped) return; stop(); onError?.(sanitize(error?.message ?? String(error))); }
  function geometry() {
    return new Promise((resolve, reject) => {
      let child, closed = false, settled = false, out = '', err = '', timeout, killTimer;
      const cancel = () => {
        clearTimeout(timeout);
        if (child && !closed) {
          child.kill('SIGTERM');
          if (!closed) { killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 1000); killTimer.unref?.(); }
        }
        if (!settled) { settled = true; reject(Error('Native geometry query stopped')); }
      };
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timeout); probeStop = null; error ? reject(error) : resolve(value); };
      try {
        child = spawnImpl(binary ?? env.HERDR_BIN_PATH ?? 'herdr', ['pane', 'layout', '--pane', pane], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        probeStop = cancel;
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { if (settled) return; out += chunk; if (out.length > 1024 * 1024) { finish(Error('Native geometry reply is too large')); cancel(); } });
        child.stderr.on('data', chunk => { err = (err + chunk).slice(-4096); });
        child.once('error', error => { finish(error); cancel(); });
        child.once('close', code => {
          closed = true; clearTimeout(killTimer);
          if (settled) return;
          if (code !== 0) { finish(Error(err.trim() || 'Cannot read native pane geometry')); return; }
          try {
            const rect = JSON.parse(out)?.result?.layout?.panes?.find(p => p.pane_id === pane)?.rect;
            if (!rect || !integer(rect.width, 400) || !integer(rect.height, 160)) throw Error('Native terminal dimensions are unavailable or exceed the viewing limit');
            finish(null, { cols: rect.width, rows: rect.height });
          } catch (error) { finish(error); }
        });
        timeout = setTimeout(() => { finish(Error('Native geometry query timed out')); cancel(); }, 4000); timeout.unref?.();
      } catch (error) { finish(error); cancel(); }
    });
  }
  async function check() {
    try {
      if (!validPane(pane)) throw Error('An exact Herdr pane ID is required');
      const size = await geometry(); if (stopped) return;
      const key = `${size.cols}x${size.rows}`;
      if (key !== sizeKey) {
        const current = ++generation; observer?.stop(); sizeKey = key;
        observer = observeTerminal({ pane, ...size, binary, env, spawnImpl,
          onFrame: frame => { if (!stopped && current === generation) onFrame?.(frame); },
          onError: error => { if (!stopped && current === generation) fail(error); },
        });
      }
      if (!stopped) { pollTimer = setTimeout(check, 3000); pollTimer.unref?.(); }
    } catch (error) { if (!stopped) fail(error); }
  }
  void check(); return { stop };
}
