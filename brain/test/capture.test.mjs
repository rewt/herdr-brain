import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseScreen } from '../lib/capture.mjs';
import { bucketOf } from '../lib/queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const codexFinal = fs.readFileSync(path.join(HERE, 'fixtures/codex-final.txt'), 'utf8');

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
