// Paints the modern console's frame straight onto the terminal, one row at a
// time, only where a row changed, and never erases. Ink's renderer erased and
// rewrote its whole output on every render; a live session streams frames, and
// Herdr could show the half-erased screen, so the bottom of the console blinked.
// Ink still reads the keyboard and mouse; it no longer draws this mode.

const rgb = hex => /^#[0-9a-f]{6}$/i.test(hex ?? '') ? hex.slice(1).match(/../g).map(x => parseInt(x, 16)).join(';') : null;

// One span's SGR from a colour resolver (token → '#rrggbb' or undefined).
export function spanSgr(span, color) {
  const codes = ['0'];
  const fg = rgb(color(span.fg)), bg = rgb(color(span.bg));
  if (fg) codes.push(`38;2;${fg}`);
  if (bg) codes.push(`48;2;${bg}`);
  if (span.bold) codes.push('1');
  if (span.dim) codes.push('2');
  if (span.italic) codes.push('3');
  if (span.underline) codes.push('4');
  if (span.inverse) codes.push('7');
  if (span.strikethrough) codes.push('9');
  return `\x1b[${codes.join(';')}m`;
}

// Text that reaches the terminal carries no control characters of its own.
const printable = text => String(text ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
export const rowAnsi = (spans, color) => spans.map(s => spanSgr(s, color) + printable(s.text)).join('') + '\x1b[0m';

export function createPainter({ write, color }) {
  let painted = [];
  return {
    // A full repaint follows: after taking the terminal, a resize or a theme change.
    invalidate() { painted = []; },
    paint(lines) {
      let out = '';
      lines.forEach((line, y) => {
        const ansi = rowAnsi(line.spans, color);
        if (painted[y] !== ansi) { out += `\x1b[${y + 1};1H${ansi}`; painted[y] = ansi; }
      });
      painted.length = lines.length;
      // Synchronized output where the terminal honours it; harmless where not.
      // The cursor stays hidden: a session's cursor is drawn as a cell.
      if (out) write(`\x1b[?2026h\x1b[?25l${out}\x1b[?2026l`);
      return out.length;
    },
  };
}
