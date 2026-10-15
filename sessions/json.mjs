// JSON.parse accepts repeated keys. Scan the grammar first, comparing decoded
// keys (including escaped spellings) separately for every object.
export function parseUniqueJson(text) {
  let at = 0;
  const fail = message => { throw Error(`${message} at JSON offset ${at}`); };
  const space = () => { while (/\s/u.test(text[at] ?? '') && at < text.length) at++; };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === '\\') { at++; continue; }
      if (ch === '"') return JSON.parse(text.slice(start, at));
    }
    fail('unterminated string');
  };
  const value = (depth = 0) => {
    if (depth > 64) fail('JSON nesting exceeds 64');
    space();
    if (text[at] === '"') { string(); return; }
    const object = text[at] === '{', list = text[at] === '[';
    if (object || list) {
      at++; space();
      const end = object ? '}' : ']', keys = new Set();
      if (text[at] === end) { at++; return; }
      for (;;) {
        if (object) {
          if (text[at] !== '"') fail('expected key');
          const key = string();
          if (keys.has(key)) fail(`duplicate JSON key ${JSON.stringify(key)}`);
          keys.add(key); space();
          if (text[at++] !== ':') fail('expected colon');
        }
        value(depth + 1); space();
        if (text[at] === end) { at++; return; }
        if (text[at++] !== ',') fail('expected comma');
        space();
      }
    }
    const token = text.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u)?.[0];
    if (!token) fail('expected value');
    at += token.length;
  };
  if (Buffer.byteLength(text) > 1024 * 1024) throw Error('JSON exceeds 1 MiB');
  value(); space();
  if (at !== text.length) fail('trailing JSON input');
  return JSON.parse(text);
}
