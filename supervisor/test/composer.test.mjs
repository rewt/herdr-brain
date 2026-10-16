import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from '../../test/helpers/bounded-test.mjs';
import { composerEmpty } from '../composer.mjs';

const fixture = name => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const warning = fixture('codex-0.163-empty-warning.txt');
const empty = fixture('codex-0.163-empty.txt');
const draft = fixture('codex-0.163-draft.txt');
const footer = warning.trimEnd().split('\n').at(-1);

test('Codex 0.163 plain transcript stays busy because placeholder styling is absent', () => {
  for (const screen of [warning, empty, draft])
    assert.equal(composerEmpty(screen, 'codex'), false);
  // The same visible bytes can be a typed draft; footer text cannot prove empty.
  assert.equal(composerEmpty(warning.replace('Ask Codex to do anything', 'DRAFT-KEEP-ME'), 'codex'), false);
});

test('Codex verified ANSI box accepts the live-check footer with warning and status suffix', () => {
  // Use existing captured box styles, not invented Codex 0.163 ANSI evidence.
  const box = fixture('codex-placeholder.ansi').split('\n').slice(0, 3).join('\n');
  for (const status of [footer, empty.trimEnd().split('\n').at(-1), footer.split(' · Check inbox')[0]]) {
    const screen = `${box}\n${status}\n`;
    assert.equal(composerEmpty(screen, 'codex'), true);
    assert.equal(composerEmpty(screen.replace('\x1b[2m', '\x1b[22m'), 'codex'), false,
      'normally styled text identical to the placeholder is a draft');
    assert.equal(composerEmpty(screen.replace('\x1b[2m', '\x1b[22m')
      .replace('Ask Codex to do anything', draft.trimEnd().split('› ').at(-1)), 'codex'), false);
    assert.equal(composerEmpty(`${screen}unexpected footer row\n`, 'codex'), false);
  }
});
