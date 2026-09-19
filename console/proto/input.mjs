// Incremental terminal input: SGR can arrive fragmented or beside ordinary keys.
// Input is read once; mouse packets can never turn into decision-number keys.
const sequences = {
  '\x1b[A': { upArrow: true },
  '\x1b[B': { downArrow: true },
  '\x1b[C': { rightArrow: true },
  '\x1b[D': { leftArrow: true },
  '\x1b[Z': { tab: true, shift: true },
  '\x1b[3~': { delete: true },
  '\x1b[5~': { pageUp: true },
  '\x1b[6~': { pageDown: true },
  '\x1b[H': { home: true },
  '\x1b[F': { end: true },
  '\x1b[1~': { home: true },
  '\x1b[4~': { end: true },
};
export const modes = {
  on: '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h',
  off: '\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[0m\x1b[?1049l',
};
export function decoder(emit) {
  let buffer = '';
  let paste = false;
  function feed(text, flush = false) {
    buffer += text;
    while (buffer) {
      if (paste) {
        const end = buffer.indexOf('\x1b[201~');
        if (end < 0) return;
        emit({
          input: buffer.slice(0, end).replace(/[\r\n\t]+/g, ' '),
          key: { paste: true },
        });
        buffer = buffer.slice(end + 6);
        paste = false;
        continue;
      }
      if (buffer.startsWith('\x1b[200~')) {
        paste = true;
        buffer = buffer.slice(6);
        continue;
      }
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buffer);
      if (mouse) {
        const code = Number(mouse[1]);
        emit({
          mouse: {
            button:
              code & 64
                ? code & 1
                  ? 'wheelDown'
                  : 'wheelUp'
                : code & 32
                  ? 'motion'
                  : ['left', 'middle', 'right', 'none'][code & 3],
            x: Number(mouse[2]) - 1,
            y: Number(mouse[3]) - 1,
            press: mouse[4] === 'M',
          },
        });
        buffer = buffer.slice(mouse[0].length);
        continue;
      }
      const sequence = Object.keys(sequences).find((seq) =>
        buffer.startsWith(seq),
      );
      if (sequence) {
        emit({ input: '', key: sequences[sequence] });
        buffer = buffer.slice(sequence.length);
        continue;
      }
      if (buffer[0] === '\x1b') {
        if (buffer.length === 1) {
          if (!flush) return;
          emit({ input: '', key: { escape: true } });
          buffer = '';
          continue;
        }
        if (buffer.startsWith('\x1b[')) {
          const csi = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(buffer);
          if (!csi) return;
          buffer = buffer.slice(csi[0].length);
          continue;
        }
        buffer = buffer.slice(2);
        continue; // Alt + key belongs to the host.
      }
      const ch = String.fromCodePoint(buffer.codePointAt(0));
      buffer = buffer.slice(ch.length);
      const key =
        ch === '\r' || ch === '\n'
          ? { return: true }
          : ch === '\t'
            ? { tab: true }
            : ch === '\x7f' || ch === '\b'
              ? { backspace: true }
              : ch < ' '
                ? { ctrl: true }
                : {};
      emit({
        input: key.ctrl
          ? String.fromCharCode(ch.charCodeAt(0) + 96)
          : Object.keys(key).length
            ? ''
            : ch,
        key,
      });
    }
  }
  return feed;
}
