import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupOrg } from './helpers.mjs';

const ESCAPE = /\x1b|\x9b|\x9d/;

test('human-readable CLI views and generated briefs strip terminal control sequences', () => {
  const t = setupOrg();
  const painted = '\x1b[31mPainted\x1b[0m title';
  const hidden = '\x1b]8;;https://example.invalid\x07hidden link\x1b]8;;\x07';

  t.ok(['add', painted, '--role', 'engineer']);
  t.ok(['note', 'ENG-1', `${hidden}; note with \x1b[2Jclear-screen`, '--decision']);
  t.ok(['start', 'ENG-1']);

  const outputs = [
    t.ok(['status']),
    t.ok(['snapshot']),
    t.ok(['show', 'ENG-1']),
    t.ok(['today']),
    t.ok(['brief', 'R-1']),
    fs.readFileSync(path.join(t.dir, 'runs/R-1/brief.md'), 'utf8'),
  ];
  for (const output of outputs) {
    assert.doesNotMatch(output, ESCAPE);
    assert.match(output, /Painted title/);
  }
  assert.match(outputs[2], /note with clear-screen/);
  assert.match(outputs[4], /hidden link/);

  // Machine-readable output remains a faithful projection of the durable record.
  assert.equal(t.json(['show', 'ENG-1', '--json']).title, painted);
});
