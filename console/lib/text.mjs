// Terminal text helpers measured in cells, not string length. Pure; no dependencies.

// Zero-width: combining marks, variation selectors, joiners.
function isZeroWidth(cp) {
  return (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)
    || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x20d0 && cp <= 0x20ff) || cp === 0x2060;
}

// East Asian wide and emoji ranges that terminals draw two cells wide.
function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x20000 && cp <= 0x3fffd);
}

export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isZeroWidth(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

export function cellWidth(text) {
  let w = 0;
  for (const ch of String(text)) w += charWidth(ch);
  return w;
}

export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// Cut to at most width cells, ending in "…" when something was cut.
export function clip(text, width) {
  const t = String(text ?? '');
  if (width <= 0) return '';
  if (cellWidth(t) <= width) return t;
  let out = '';
  let w = 0;
  for (const ch of t) {
    const cw = charWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out.trimEnd() + '…';
}

export function pad(text, width) {
  const t = clip(text, width);
  return t + ' '.repeat(Math.max(0, width - cellWidth(t)));
}

export function padStart(text, width) {
  const t = clip(text, width);
  return ' '.repeat(Math.max(0, width - cellWidth(t))) + t;
}

// Word wrap to width cells. Continuation lines start with `hang` (a hanging indent);
// words longer than a line are broken.
export function wrap(text, width, hang = '') {
  const out = [];
  const hangWidth = cellWidth(hang);
  for (const para of String(text ?? '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
    }
    const lines = [];
    let line = '';
    const lead = () => (lines.length ? hang : '');
    for (let word of words) {
      if (line && cellWidth(`${line} ${word}`) <= width) {
        line = `${line} ${word}`;
        continue;
      }
      if (line) {
        lines.push(line);
        line = '';
      }
      let room = width - cellWidth(lead());
      while (cellWidth(word) > room) {
        const head = clipExact(word, Math.max(1, room));
        lines.push(lead() + head);
        word = word.slice(head.length);
        room = width - hangWidth;
      }
      if (word) line = lead() + word;
    }
    if (line) lines.push(line);
    out.push(...lines);
  }
  return out;
}

function clipExact(text, width) {
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch);
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out || [...text][0];
}

// Item codes (G-1, ENG-7, R-12, DECISION-THEFT-20260916) and commit-like hex runs
// (7+ hex digits containing both a digit and a letter) are record codes, not plain words.
const CODE_RE = /\b[A-Z][A-Z0-9_]*(?:-[A-Z0-9_]+)*-\d+\b/g;
const HEX_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi;

export function hasCodes(text) {
  return new RegExp(CODE_RE.source).test(text) || new RegExp(HEX_RE.source, 'i').test(text);
}

export function stripCodes(text) {
  return oneLine(String(text ?? '').replace(CODE_RE, '').replace(HEX_RE, ''))
    .replace(/\(\s*[,;:/·]*\s*\)|\[\s*[,;:/·]*\s*\]/g, '')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/([(])\s+/g, '$1')
    .replace(/(^|\s)[,;:/·](?=\s|$)/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:.·-]+/, '')
    .trim();
}

export function firstSentence(text) {
  const t = oneLine(text);
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return m ? m[1] : t;
}

// Markdown decoration off a single line: headings, emphasis, inline code, links.
export function plainLine(text) {
  return oneLine(String(text ?? '')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1'));
}

export function firstLine(text) {
  const line = String(text ?? '').split('\n').find((l) => plainLine(l) !== '' && !/^\s*(```|---|\|[-:| ]+\|?\s*$)/.test(l));
  return line == null ? '' : plainLine(line);
}
