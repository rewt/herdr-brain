// Herdr screen adapters, outside the dependency-free record core. Unknown
// layouts are busy: a lifecycle status alone never proves an empty composer.
const CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const plain = (text) => text.replace(CSI, '');

// Match box-empty.py: dim and neutral RGB 90..170 are placeholder chrome.
// Parse compound SGRs too; Codex often combines colour and intensity codes.
function typedText(text) {
  let dim = false, grey = false, typed = '';
  for (const token of text.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    const match = /^\x1b\[([0-9;]*)m$/.exec(token);
    if (match) {
      const codes = (match[1] || '0').split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) { dim = false; grey = false; }
        else if (code === 2) dim = true;
        else if (code === 22) dim = false;
        else if (code === 39) grey = false;
        else if (code === 38 || code === 48) {
          const count = codes[i + 1] === 2 ? 3 : codes[i + 1] === 5 ? 1 : 0;
          if (!count || codes.length < i + count + 2) return null;
          if (code === 38) {
            const rgb = codes.slice(i + 2, i + 2 + count);
            grey = count === 3 && Math.max(...rgb) - Math.min(...rgb) < 16 && rgb[0] >= 90 && rgb[0] <= 170;
          }
          i += count + 1;
        } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) grey = false;
      }
    } else if (/^\x1b\[[0-9;?]*[A-Za-z]$/.test(token)) {
      // Known terminal controls have no visible text.
    } else if (token.startsWith('\x1b')) return null;
    else if (!dim && !grey) typed += token;
  }
  return typed.replace(/\u00a0/g, ' ').trim();
}

export function composerEmpty(raw, harness) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const lines = raw.replace(/\r/g, '').split('\n');
  const visible = lines.map(plain);
  if (harness === 'claude') {
    const rules = visible.flatMap((line, i) => /^\s*─{4}/.test(line) ? [i] : []);
    if (rules.length < 2) return false;
    const start = rules.at(-2) + 1, end = rules.at(-1);
    if (!visible.slice(start, end).some((line) => /^\s*❯/.test(line))) return false;
    const text = typedText(lines.slice(start, end).join('\n'));
    return text !== null && text.replace('❯', '').trim() === '';
  }
  if (harness === 'codex') {
    // Captured Codex: highlighted › row, optional wrapped input rows, then
    // blank padding and the model · cwd · task status bar. Require the footer
    // so an old transcript prompt cannot authorize input.
    const status = visible.findLastIndex((line) => /^\s*\S.*\s·\s.*(?:~\/|\/)/.test(line));
    if (status < 0 || visible.slice(status + 1).some((line) => line.trim())) return false;
    let start = status - 1;
    while (start >= 0 && !/^\s*›(?:\s|$)/.test(visible[start])) start--;
    if (start < 0) return false;
    const text = typedText(lines.slice(start, status).join('\n'));
    return text !== null && text.replace('›', '').trim() === '';
  }
  return false;
}
