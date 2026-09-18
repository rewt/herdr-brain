// Turn a session's screen into what came out of it.
//
// Best-effort on purpose: the screen is a rendered terminal, not an API. Every
// derived field can be null, and `screen` always holds the raw tail so nothing
// is lost when a guess is wrong.

const OPTION = /^\s*[❯>]?\s*(\d+)\.\s+(.*\S)\s*$/;
const MODE_LINE = /^\s*[⏵>]{1,2}\s|auto mode|shift\+tab|bypass permissions|plan mode/i;
const SPINNER = /^\s*[✻✽✳✢·*]\s+\S+.*(for|·)\s/;
const PROMPT = /^\s*[❯>]\s?(.*)$/;
// Status-bar text the terminal draws, which is never something a session said.
const CHROME = /\/clear to save|\? for shortcuts|until auto-compact|new task\?|esc to interrupt|ctrl\+[a-z] to/i;
const CODEX_PROMPT = /^\s*›\s+Ask Codex to do anything\s*$/i;
const CODEX_STATUS = /^\s*\S.*\s·\s+(?:~|\/).*/;
const CODEX_TIMER = /^\s*[─━_-]*\s*(?:Worked for|Working \().*/i;

// A separator, with or without a label in it: mostly dashes, and long.
// `──────── settle-r-121-1803 ─` is a rule; a sentence with an em dash is not.
function isRule(line) {
  const s = line.trim();
  if (s.length < 20) return false;
  const dashes = (s.match(/[─—_\-━═]/g) ?? []).length;
  return dashes >= 20 && dashes / s.replace(/\s/g, '').length >= 0.6;
}

// Placeholder text Claude Code shows in an empty prompt box.
const PLACEHOLDER = /^(try ")|^(> )?$|^\s*$/i;

const SGR = /\x1b\[([0-9;]*)m/g;
const strip = (l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// Claude Code draws its auto-suggest faint (SGR 2). Text the operator actually
// typed is drawn at normal intensity. Without that bit the two are identical,
// and calling a suggestion "your reply" is a lie the operator cannot check.
function isFaint(line) {
  let faint = false;
  let sawText = false;
  let last = 0;
  for (const m of line.matchAll(SGR)) {
    const before = line.slice(last, m.index).replace(/[\u00a0\s❯>]/g, '');
    if (before) { sawText = true; if (!faint) return false; }
    for (const code of (m[1] || '0').split(';')) {
      if (code === '2') faint = true;
      else if (code === '0' || code === '22' || code === '') faint = false;
    }
    last = m.index + m[0].length;
  }
  const tail = line.slice(last).replace(/[\u00a0\s❯>]/g, '');
  if (tail) { sawText = true; if (!faint) return false; }
  return sawText;
}

export function parseScreen(text, { agent = null } = {}) {
  const withCodes = (text ?? '').replace(/\r/g, '').split('\n');
  const raw = withCodes.map(strip).join('\n');
  const lines = raw.split('\n');
  const codex = agent === 'codex';

  // Trailing chrome: mode line, status hints. Walk back past blank/mode lines.
  let end = lines.length;
  while (end > 0 && (
    lines[end - 1].trim() === '' || MODE_LINE.test(lines[end - 1])
    || (codex && (CODEX_PROMPT.test(lines[end - 1]) || CODEX_STATUS.test(lines[end - 1]) || CODEX_TIMER.test(lines[end - 1])))
  )) end -= 1;

  const dialog = findDialog(lines, end);
  // Codex separates a final answer from its elapsed-time footer with rules.
  // Those are not an input box; only Claude's renderer uses this box shape.
  const box = codex ? null : findPromptBox(lines, dialog ? dialog.start : end);
  const said = findSaid(lines, box ? box.start : dialog ? dialog.start : end);

  // Everything in the box faint means Claude proposed it; nobody typed it.
  const suggested = Boolean(box?.text) && box.lineRange
    .map((i) => withCodes[i])
    .filter((l) => strip(l ?? '').replace(/[\u00a0\s❯>]/g, ''))
    .every(isFaint);

  return {
    screen: lines.slice(Math.max(0, end - 120), end).join('\n').trimEnd(),
    said: said || null,
    unsent: suggested ? null : (box?.text || null),
    suggestion: suggested ? box.text : null,
    dialog: dialog ? { question: dialog.question, options: dialog.options } : null,
  };
}

// A trailing block of "1. x / 2. y" choices is a dialog the session is stuck on.
function findDialog(lines, end) {
  const options = [];
  let i = end - 1;
  let last = null;
  // Scan upward through the trailing region for numbered options.
  for (let seen = 0; i >= 0 && seen < 24; i -= 1, seen += 1) {
    const m = OPTION.exec(lines[i]);
    if (m) {
      const n = Number(m[1]);
      if (last !== null && n !== last - 1) break;
      options.unshift({ key: m[1], label: m[2] });
      last = n;
      continue;
    }
    if (options.length) {
      if (lines[i].trim() === '') continue;
      break;
    }
  }
  if (options.length < 2 || options[0].key !== '1') return null;
  // The question is the nearest non-blank line above the options.
  let q = i;
  while (q >= 0 && lines[q].trim() === '') q -= 1;
  let question = null;
  // The title is usually the question mark line, separated from the options by
  // a blank line and a line of description — so blanks must not stop the scan.
  for (let k = q; k >= 0 && k > q - 10; k -= 1) {
    const t = lines[k].trim();
    if (isRule(t)) break;
    if (!t) continue;
    if (/[?？]\s*$/.test(t)) { question = t; break; }
    if (question === null) question = t;
  }
  const start = Math.max(0, (question ? q : i) - 4);
  return { start, question, options };
}

// The prompt box: the region between horizontal rules just above the chrome.
function findPromptBox(lines, end) {
  let lower = -1;
  for (let i = end - 1; i >= 0 && i > end - 12; i -= 1) {
    if (isRule(lines[i])) { lower = i; break; }
  }
  if (lower < 0) return null;
  let upper = -1;
  for (let i = lower - 1; i >= 0 && i > lower - 14; i -= 1) {
    if (isRule(lines[i])) { upper = i; break; }
  }
  if (upper < 0) return null;
  const body = lines.slice(upper + 1, lower);
  const text = body
    .map((l) => {
      const m = PROMPT.exec(l);
      return (m ? m[1] : l).trimEnd();
    })
    .join('\n')
    .trim();
  const lineRange = [];
  for (let i = upper + 1; i < lower; i += 1) lineRange.push(i);
  if (!text || PLACEHOLDER.test(text)) return { start: upper, text: '', lineRange };
  return { start: upper, text, lineRange };
}

// Claude Code marks a tool call `⏺ Name(args)` and its output `⎿ …`. Assistant
// prose also starts with `⏺`, so the bracket is what separates them.
const TOOL_CALL = /^\s*[⏺●]\s+[A-Z]\w*\(/;
const TOOL_OUT = /^\s*[⎿└|]/;
const BULLET = /^\s*[⏺●•]\s+/;

const isNoise = (l) => TOOL_CALL.test(l) || TOOL_OUT.test(l) || SPINNER.test(l) || MODE_LINE.test(l) || CHROME.test(l) || isRule(l);

// What the session last said: the final run of prose, with tool traffic removed.
function findSaid(lines, end) {
  const out = [];
  let blanks = 0;
  for (let i = end - 1; i >= 0 && out.length < 60; i -= 1) {
    const l = lines[i];
    if (isNoise(l)) {
      // Tool traffic above the prose we already have ends the message.
      if (out.length) break;
      continue;
    }
    if (l.trim() === '') {
      blanks += 1;
      if (out.length && blanks > 2) break;
      if (out.length) out.unshift('');
      continue;
    }
    blanks = 0;
    out.unshift(l.replace(BULLET, '').replace(/\s+$/, ''));
  }
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > 12 ? text : '';
}

// One plain line for a list: the first sentence of what it said.
export function headline(entry) {
  if (entry.dialog?.question) return entry.dialog.question;
  const said = entry.said ?? '';
  const firstReal = said
    .split('\n')
    .map((l) => l.replace(/^\s*[●○✓✗•#>*\-]+\s*/, '').trim())
    .find((l) => l.length > 20);
  if (!firstReal) return entry.title || 'finished with nothing on screen';
  const stop = firstReal.search(/[.!?](\s|$)/);
  return stop > 20 ? firstReal.slice(0, stop + 1) : firstReal;
}
