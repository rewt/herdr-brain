// Terminal mouse reporting (SGR mode): the escapes that turn it on and off, and the
// parser for what the terminal sends back. Pure.
export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';

// "\x1b[<b;x;yM" (press) or "...m" (release). Ink drops the leading escape before a
// key handler sees the input, so it is optional. x and y come back 0-based.
const SGR = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/;

export function parseMouse(input) {
  const m = SGR.exec(String(input ?? ''));
  if (!m) return null;
  const code = Number(m[1]);
  let button;
  if (code & 64) button = (code & 3) === 0 ? 'wheelUp' : (code & 3) === 1 ? 'wheelDown' : 'wheel';
  else if (code & 32) button = 'motion';
  else button = ['left', 'middle', 'right', 'none'][code & 3];
  return { button, x: Number(m[2]) - 1, y: Number(m[3]) - 1, press: m[4] === 'M' };
}
