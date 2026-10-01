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

// Agent-written text must not drive the terminal: escape sequences (CSI, OSC, DCS and
// the like, 7- and 8-bit), other C0/C1 controls and bidi overrides are removed. Tabs
// become spaces; newlines are kept only when `keepNewlines`.
const ESCAPES = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -/]*[0-~]?/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

export function sanitize(text, { keepNewlines = false } = {}) {
  const t = String(text ?? '').replace(ESCAPES, '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  return (keepNewlines ? t : t.replace(/\n/g, ' ')).replace(CONTROLS, '');
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
  const t = sanitize(text);
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

// Keeps the last cells instead: "…" then the end of the text.
export function clipStart(text, width) {
  const t = sanitize(text);
  if (width <= 0) return '';
  if (cellWidth(t) <= width) return t;
  const chars = [...t];
  let out = '';
  let w = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i]);
    if (w + cw > width - 1) break;
    out = chars[i] + out;
    w += cw;
  }
  return '…' + out.trimStart();
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
  for (const para of sanitize(text, { keepNewlines: true }).split('\n')) {
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
      // A width at or below the hang still takes one cell per line, never none.
      let room = Math.max(1, width - cellWidth(lead()));
      while (cellWidth(word) > room) {
        const head = clipExact(word, Math.max(1, room));
        lines.push(lead() + head);
        word = word.slice(head.length);
        room = Math.max(1, width - hangWidth);
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

// Record codes are the identifiers the organization issues: item ids with a prefix in
// use (G-1, ENG-7), run ids (R-12), DECISION memo names (DECISION-THEFT-20260916) and
// commit-like hex runs (7+ hex digits with both a digit and a letter). Other names with
// a number (CVE-2024-3094, SHA-256, BIP-340) are real words and stay. `prefixes` comes
// from org today (project.item_prefixes); an older org that does not list them gets the
// prefixes org issues by default.
export const DEFAULT_PREFIXES = ['ARCH', 'DES', 'DOC', 'ENG', 'G', 'HUM', 'PLAN', 'RES', 'REV', 'TRI', 'W'];
const HEX = String.raw`\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b`;
const patterns = new Map();

function codePatterns(prefixes) {
  const list = [...new Set([...(prefixes ?? DEFAULT_PREFIXES), 'R'])].filter((p) => typeof p === 'string' && p).sort();
  const key = list.join(' ');
  if (!patterns.has(key)) {
    const ids = list.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    patterns.set(key, {
      code: new RegExp(String.raw`(?<![\w-])(?:(?:${ids})-\d+|DECISION(?:-[A-Z0-9_]+)*-\d+)(?![\w-])`, 'g'),
      hex: new RegExp(HEX, 'gi'),
    });
  }
  return patterns.get(key);
}

export function hasCodes(text, prefixes) {
  const { code, hex } = codePatterns(prefixes);
  const t = String(text ?? '');
  code.lastIndex = 0;
  hex.lastIndex = 0;
  const found = code.test(t) || hex.test(t);
  code.lastIndex = 0;
  hex.lastIndex = 0;
  return found;
}

export function stripCodes(text, prefixes) {
  const { code, hex } = codePatterns(prefixes);
  return oneLine(String(text ?? '').replace(code, '').replace(hex, ''))
    .replace(/([([])(?:\s*[,;:/·])+\s*/g, '$1')
    .replace(/(?:\s*[,;:/·])+\s*([)\]])/g, '$1')
    .replace(/\(\s*\)|\[\s*\]/g, '')
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
