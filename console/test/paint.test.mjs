import test from 'node:test';
import assert from 'node:assert/strict';
import { createPainter, spanSgr } from '../modern/paint.mjs';

const color = token => ({ fg: '#112233', bg: '#fafcfe', amber: '#775015' })[token];
const line = (...texts) => ({ spans: texts.map(text => ({ text, fg: 'fg', bg: 'bg' })) });

test('the painter writes only changed rows, in place, and never erases', () => {
  const writes = [], p = createPainter({ write: w => writes.push(w), color });
  p.paint([line('top'), line('middle'), line('bottom')]);
  assert.equal(writes.length, 1); assert.match(writes[0], /\x1b\[1;1H.*top/); assert.match(writes[0], /\x1b\[3;1H.*bottom/);
  p.paint([line('top'), line('middle'), line('bottom')]); assert.equal(writes.length, 1, 'an unchanged frame writes nothing');
  p.paint([line('top'), line('ticked'), line('bottom')]);
  assert.equal(writes.length, 2); assert.doesNotMatch(writes[1], /\x1b\[[13];1H/); assert.match(writes[1], /\x1b\[2;1H.*ticked/);
  for (const w of writes) { assert.doesNotMatch(w, /\x1b\[[0-2]?[JK]/, 'no erase sequences'); assert.ok(w.startsWith('\x1b[?2026h')); }
  p.invalidate(); p.paint([line('top'), line('ticked'), line('bottom')]); assert.match(writes[2], /\x1b\[1;1H.*\x1b\[3;1H/s);
});

test('spans become truecolor SGR and cannot smuggle control characters', () => {
  assert.equal(spanSgr({ fg: 'fg', bg: 'bg', bold: true, inverse: true }, color), '\x1b[0;38;2;17;34;51;48;2;250;252;254;1;7m');
  assert.equal(spanSgr({ fg: 'missing' }, color), '\x1b[0m');
  const writes = [], p = createPainter({ write: w => writes.push(w), color });
  p.paint([{ spans: [{ text: 'a\x1b[2Jb\x07', fg: 'fg', bg: 'bg' }] }]);
  assert.doesNotMatch(writes[0], /\x1b\[2J|\x07/);
});
