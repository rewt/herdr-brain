// Dependency-free byte rules for embedded sessions. Parse the whole chunk
// before sending anything: a return key discards input and releases control.
export const BACK_KEY = '\x1d'; // Ctrl+]
const MOUSE = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}/g;
export function splitInput(data) {
  // A Buffer keeps its exact bytes through latin1; a decoded string is UTF-8.
  const encoding = Buffer.isBuffer(data) ? 'latin1' : 'utf8';
  const text = Buffer.isBuffer(data) ? data.toString('latin1') : String(data);
  const back = text.includes(BACK_KEY);
  const before = back ? text.slice(0, text.indexOf(BACK_KEY)) : text;
  return { back, bytes: Buffer.from(before.replace(MOUSE, ''), encoding) };
}

const SEQUENCE = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1bO[ -~])/;
const RETURN = /^\x1b\[27(?:;[\d:]+)*u$|^\x1b\[27;\d+;27~$|^\x1b\[93;5(?::[12])?u$/;
const INTERRUPT = /^\x1b\[(?:28(?:;1)?|92;5(?::[12])?)u$/;
const back = () => ({ back: true, bytes: Buffer.alloc(0) });

export function parseSessionInput(data) {
  const input = splitInput(data);
  if (input.back) return back();
  const text = input.bytes.toString('latin1');
  let forwarded = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\x1c') { forwarded += '\x1b'; continue; } // deliberate Ctrl+\ interrupt
    if (text[i] !== '\x1b') { forwarded += text[i]; continue; }
    // Alt+arrow/function keys have one extra ESC before a complete CSI/SS3.
    // Another ESC without that sequence is a bare Esc, including key repeat.
    const alt = text[i + 1] === '\x1b';
    const start = i + Number(alt);
    const sequence = SEQUENCE.exec(text.slice(start))?.[0];
    if (sequence) {
      if (RETURN.test(sequence)) return back();
      forwarded += INTERRUPT.test(sequence) ? '\x1b' : (alt ? '\x1b' : '') + sequence;
      i = start + sequence.length - 1;
    } else {
      const next = text[i + 1];
      // Only a real Meta pair may fall through. Partial CSI/SS3 is never Meta.
      if (!next || next === '\x1b' || next === '[' || next === 'O') return back();
      forwarded += text.slice(i, i + 2); i++;
    }
  }
  return { back: false, bytes: Buffer.from(forwarded, 'latin1') };
}
