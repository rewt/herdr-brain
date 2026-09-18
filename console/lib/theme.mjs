// The console's look: palette tokens and glyph sets. The frame names tokens; the app
// turns them into colours (none under NO_COLOR). Pure.
export const PALETTE = {
  bg: '#000000',
  panel: '#121212',
  pill: '#1a1a1a',
  selected: '#1c2b3a',
  fg: '#e4e4e4',
  bright: '#ffffff',
  muted: '#8a8a8a',
  faint: '#5f5f5f',
  rule: '#2a2a2a',
  doing: '#c6c6c6',
  segProject: '#0087af',
  segTime: '#303030',
  segCount: '#262626',
  segHelp: '#3a3a3a',
  segAlert: '#d75f00',
  ink: '#000000',
  waitPill: '#3a1d00',
  waitFg: '#ffaf5f',
  working: '#5fd7ff',
  idle: '#8a8a8a',
  blocked: '#ff5f5f',
  done: '#87d787',
  gone: '#5f5f5f',
  unknown: '#8a8a8a',
  claude: '#d7875f',
  codex: '#afafff',
};

// Nerd Font glyphs (private use area, one cell wide in a Nerd Font).
const NERD = {
  right: '',
  left: '',
  capLeft: '',
  capRight: '',
  repo: ' ',
  clock: ' ',
  sessions: ' ',
  waiting: ' ',
  question: ' ',
  branch: ' ',
  stop: ' ',
  alert: ' ',
  working: '● ',
  idle: '○ ',
  blocked: '■ ',
  done: '✓ ',
  gone: '× ',
  unknown: '? ',
  rule: '─',
  sep: '·',
};

// `plain`: every powerline and icon glyph as ASCII; state is a word anyway.
const PLAIN = {
  ...Object.fromEntries(Object.keys(NERD).map((k) => [k, ''])),
  right: '>',
  left: '<',
  capLeft: '|',
  capRight: '|',
  waiting: '! ',
  rule: '-',
  sep: '-',
};

export function glyphsFor(mode) {
  return mode === 'plain' ? PLAIN : NERD;
}

// The screen's own non-ASCII symbols, one cell each, as ASCII. Agent text keeps its
// letters; only these symbols change.
const FOLD = {
  '·': '-', '…': '~', '─': '-', '━': '-', '╭': '+', '╮': '+', '╰': '+', '╯': '+', '│': '|', '▏': '|',
  '↑': '^', '↓': 'v', '“': '"', '”': '"', '‘': "'", '’': "'", '→': '>', '←': '<', '●': '*', '○': 'o',
  '■': '#', '✓': '+', '×': 'x', '▸': '>', '▾': 'v', '≤': '<', '≥': '>', '—': '-', '–': '-', '✳': '*',
};
const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join('')}]|[-]`, 'g');

export function asciiFold(text) {
  return String(text).replace(FOLD_RE, (ch) => FOLD[ch] ?? ' ');
}
