import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from '../../test/helpers/bounded-test.mjs';
import { fileURLToPath } from 'node:url';
import { parseScreen } from '../lib/capture.mjs';
import { bucketOf } from '../lib/queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const codexFinal = fs.readFileSync(path.join(HERE, 'fixtures/codex-final.txt'), 'utf8');
const codexTyped = fs.readFileSync(path.join(HERE, 'fixtures/codex-typed-composer.txt'), 'utf8');

test('a real Codex final message is finished work, not stranded operator text', () => {
  const generic = parseScreen(codexFinal);
  assert.match(generic.unsent, /^• Implemented and reported the round/, 'the fixture exercises the old false prompt-box match');

  const parsed = parseScreen(codexFinal, { agent: 'codex' });
  assert.equal(parsed.unsent, null);
  assert.equal(parsed.suggestion, null);
  assert.match(parsed.said, /^Implemented and reported the round/);
  assert.doesNotMatch(parsed.said, /Ask Codex|gpt-5\.6-sol/);
  assert.equal(bucketOf({ ...parsed, state: 'done', status: 'new' }), 'finished');
});

test('text typed into the Codex composer is stranded, not a final message', () => {
  const parsed = parseScreen(codexTyped, { agent: 'codex' });
  assert.equal(parsed.unsent, 'send the report after the tests pass');
  assert.equal(parsed.suggestion, null);
  assert.equal(parsed.said, 'The implementation is complete and every test passes.');
  assert.equal(bucketOf({ ...parsed, state: 'done', status: 'new' }), 'stranded');
});

test('faint Codex composer text is placeholder chrome, not an unsent reply', () => {
  const screen = codexTyped.replace('send the report after the tests pass', '\u001b[2mtry a follow-up\u001b[0m');
  const parsed = parseScreen(screen, { agent: 'codex' });
  assert.equal(parsed.unsent, null);
  assert.equal(parsed.said, 'The implementation is complete and every test passes.');
});
