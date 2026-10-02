import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeTerminal } from '../lib/sanitize.mjs';
import { setupOrg } from './helpers.mjs';

const ESCAPE = /\x1b|\x9b|\x9d/;

test('many unterminated string-control introducers sanitize independently', () => {
  const repeated = `${'\x1b]'.repeat(20_000)}still visible${'\x9d'.repeat(20_000)}`;
  assert.equal(sanitizeTerminal(repeated), 'still visible');
});

test('human-readable CLI views and generated briefs strip terminal control sequences', () => {
  const t = setupOrg();
  const painted = '\x1b[31mPainted\x1b[0m title with \x1b]unterminated OSC';
  const hidden = '\x1b]8;;https://example.invalid\x07hidden link\x1b]8;;\x07';
  const longLink = `\x1b]8;;https://example.invalid/${'x'.repeat(400)}\x07linked text\x1b]8;;\x07`;

  t.ok(['add', painted, '--role', 'engineer']);
  t.ok(['note', 'ENG-1', `${hidden}; ${longLink}; note with \x1b[2Jclear-screen`, '--decision']);
  const started = t.ok(['start', 'ENG-1']);

  const outputs = [
    started,
    t.ok(['status']),
    t.ok(['snapshot']),
    t.ok(['show', 'ENG-1']),
    t.ok(['today']),
    t.ok(['brief', 'R-1']),
    fs.readFileSync(path.join(t.dir, 'runs/R-1/brief.md'), 'utf8'),
  ];
  for (const output of outputs) {
    assert.doesNotMatch(output, ESCAPE);
    assert.match(output, /Painted title with unterminated OSC/);
  }
  assert.match(outputs[3], /note with clear-screen/);
  assert.match(outputs[5], /hidden link/);
  assert.match(outputs[5], /linked text/);
  assert.match(outputs[5], /## When you stop: write one report/);

  fs.writeFileSync(path.join(t.dir, 'runs/R-1/report.md'), `---
run: R-1
outcome: done
summary: ${hidden} completed safely
proposals:
  - role: engineer
    title: ${hidden} follow-up
---
`);
  const synced = t.ok(['sync']);
  assert.doesNotMatch(synced, ESCAPE);
  assert.match(synced, /hidden link completed safely/);
  assert.match(synced, /hidden link follow-up/);

  // Machine-readable output remains a faithful projection of the durable record.
  assert.equal(t.json(['show', 'ENG-1', '--json']).title, painted);
});
