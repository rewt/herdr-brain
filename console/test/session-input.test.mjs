import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionInput } from '../modern/session-input.mjs';

for (const [name, input] of [
  ['bare Esc', '\x1b'], ['double Esc in one chunk', '\x1b\x1b'],
  ['repeated Esc', '\x1b\x1b\x1b'], ['double Esc followed by typing', '\x1b\x1bhello'],
  ['typing before Esc', 'hello\x1b'], ['Meta before bare Esc', '\x1bb\x1b'],
  ['interrupt before bare Esc', '\x1c\x1b'], ['partial CSI', '\x1b['],
  ['partial CSI parameters', '\x1b[1;'], ['partial SS3', '\x1bO'],
  ['partial Alt arrow', '\x1b\x1b['], ['partial Alt SS3', '\x1b\x1bO'],
  ['CSI-u Esc', '\x1b[27u'], ['CSI-u unmodified Esc', '\x1b[27;1u'],
  ['CSI-u Esc press', '\x1b[27;1:1u'], ['CSI-u Esc repeat', '\x1b[27;1:2u'],
  ['CSI-u Esc release', '\x1b[27;1:3u'], ['CSI-u modified Esc', '\x1b[27;3u'],
  ['CSI-u Esc with text', '\x1b[27;1;27u'], ['modifyOtherKeys Esc', '\x1b[27;1;27~'],
  ['Alt CSI-u Esc', '\x1b\x1b[27u'], ['typing around encoded Esc', 'before\x1b[27uafter'],
  ['Ctrl+] key', '\x1d'], ['typing before Ctrl+]', 'before\x1dafter'],
  ['CSI-u Ctrl+]', '\x1b[93;5u'], ['CSI-u Ctrl+] repeat', '\x1b[93;5:2u'],
]) {
  test(`${name} returns without any agent bytes`, () => {
    for (const data of [input, Buffer.from(input)]) {
      assert.deepEqual(parseSessionInput(data), { back: true, bytes: Buffer.alloc(0) });
    }
  });
}

for (const [name, input] of [
  ['ordinary UTF-8 typing', 'hello 会話\r'], ['Meta Enter', '\x1b\r'],
  ['Meta word movement', '\x1bb\x1bf'], ['Meta backspace', '\x1b\x7f'],
  ['Meta ordinary key', '\x1bq'], ['Meta UTF-8 typing', '\x1b会話'],
  ['CSI arrows', '\x1b[A\x1b[B\x1b[C\x1b[D'],
  ['modified CSI arrow', '\x1b[1;3A'], ['CSI function key', '\x1b[15~'],
  ['SS3 arrow and function key', '\x1bOA\x1bOP'],
  ['CSI-u ordinary key', '\x1b[97;3u'],
  ['Alt arrow', '\x1b\x1b[A'], ['Alt SS3 function key', '\x1b\x1bOP'],
  ['Alt modified arrow among typing', 'a\x1b\x1b[1;3Ab'],
]) {
  test(`${name} retains every byte`, () => {
    for (const data of [input, Buffer.from(input)]) {
      assert.deepEqual(parseSessionInput(data), { back: false, bytes: Buffer.from(input) });
    }
  });
}

test('binary input is not decoded or re-encoded as UTF-8', () => {
  const bytes = Buffer.from([0x00, 0x80, 0xff, 0x1b, 0x7f, 0xc3, 0xa9]);
  assert.deepEqual(parseSessionInput(bytes), { back: false, bytes });
});

test('mouse reports remain local while surrounding session bytes retain order', () => {
  for (const mouse of ['\x1b[<0;3;3M', '\x1b[<0;3;3m', '\x1b[M !!']) {
    assert.deepEqual(parseSessionInput(`a${mouse}b`), { back: false, bytes: Buffer.from('ab') });
    assert.deepEqual(parseSessionInput(`${mouse}\x1b\x1b`), { back: true, bytes: Buffer.alloc(0) });
  }
});

test('only explicit interrupt keys translate to a bare Esc', () => {
  for (const input of ['\x1c', '\x1b[28u', '\x1b[28;1u', '\x1b[92;5u', '\x1b[92;5:1u', '\x1b[92;5:2u']) {
    assert.deepEqual(parseSessionInput(`a${input}b`), { back: false, bytes: Buffer.from('a\x1bb') });
  }
});
