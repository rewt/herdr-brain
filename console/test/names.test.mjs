// Names, time and glyph helpers of the 0.0.2 screen: pure, no Ink.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_NAMES, doingText, modelWords, tenWords, toolWord, upText, whoFor } from '../lib/names.mjs';
import { MOUSE_OFF, MOUSE_ON, parseMouse } from '../lib/mouse.mjs';
import { createRepoResolver, homePath } from '../lib/repos.mjs';
import { PALETTE, asciiFold, glyphsFor } from '../lib/theme.mjs';

test('the model-name table turns IDs into words, and an unmapped ID is shown as it is', () => {
  assert.deepEqual(modelWords('claude-opus-5'), { tool: 'Claude', model: 'Opus 5' });
  assert.deepEqual(modelWords('claude-fable-5-1'), { tool: 'Claude', model: 'Fable 5.1' });
  assert.deepEqual(modelWords('gpt-6-astra'), { tool: 'Codex', model: 'Astra' });
  assert.deepEqual(modelWords('gpt-6-sol'), { tool: 'Codex', model: 'Sol' });
  assert.deepEqual(modelWords('mystery-9'), { tool: null, model: 'mystery-9' });
  assert.equal(modelWords(null), null);
  for (const [id, words] of Object.entries(MODEL_NAMES)) assert.ok(words.tool && words.model, id);
  assert.equal(toolWord('claude-code'), 'Claude');
  assert.equal(toolWord('codex'), 'Codex');
  assert.equal(toolWord('aider'), 'Aider');
  assert.equal(toolWord(null), null);
});

test('WHO comes from the org run first, then Herdr and the transcript, else says unknown', () => {
  // Org run: harness, model and effort.
  assert.equal(whoFor({ harness: 'claude-code', model: 'claude-opus-5', effort: 'high' }).text, 'Claude Opus 5 · high');
  assert.equal(whoFor({ harness: 'codex', model: 'gpt-6-astra', effort: 'xhigh' }).text, 'Codex Astra · xhigh');
  // An alias recorded in org gives way to the exact model the transcript names.
  assert.equal(whoFor({ harness: 'claude-code', model: 'opus', effort: 'high', transcriptModel: 'claude-opus-5' }).text, 'Claude Opus 5 · high');
  assert.equal(whoFor({ harness: 'claude-code', model: 'opus', effort: 'high' }).text, 'Claude Opus · high');
  // An exact org model wins over the transcript.
  assert.equal(whoFor({ harness: 'claude-code', model: 'claude-fable-5-1', transcriptModel: 'claude-opus-5' }).text, 'Claude Fable 5.1');
  // No org run: the tool from Herdr, the model from the transcript.
  assert.equal(whoFor({ agentTool: 'claude', transcriptModel: 'claude-fable-5-1' }).text, 'Claude Fable 5.1');
  assert.equal(whoFor({ agentTool: 'codex', transcriptModel: 'gpt-6-sol' }).text, 'Codex Sol');
  // Unknown model.
  const unknown = whoFor({ agentTool: 'claude' });
  assert.equal(unknown.text, 'Claude · unknown');
  assert.deepEqual([unknown.tool, unknown.model], ['Claude', null]);
  assert.equal(whoFor({}).text, 'unknown tool · unknown');
  assert.equal(whoFor({ agentTool: 'claude', transcriptModel: 'claude-next-9' }).text, 'Claude claude-next-9');
});

test('UP counts minutes, hours, then days, and says unknown without a start', () => {
  const now = Date.parse('2026-09-16T20:50:00Z');
  assert.equal(upText('2026-09-16T20:41:00Z', now), '9m');
  assert.equal(upText('2026-09-16T20:50:20Z', now), '0m');
  assert.equal(upText('2026-09-16T18:40:00Z', now), '2h');
  assert.equal(upText('2026-09-14T20:00:00Z', now), '2d');
  assert.equal(upText(null, now), 'unknown');
  assert.equal(upText('not a time', now), 'unknown');
});

test('DOING is at most ten words, cut at a word boundary, from the first usable source', () => {
  assert.equal(tenWords('one two three four five six seven eight nine ten'), 'one two three four five six seven eight nine ten');
  assert.equal(tenWords('one two three four five six seven eight nine ten eleven'), 'one two three four five six seven eight nine ten…');
  assert.equal(tenWords('  spaced   out  '), 'spaced out');
  // Terminal title first.
  assert.equal(doingText({ title: 'Verifying correction round three' }), 'Verifying correction round three');
  // A title that is only the agent's name, or only codes, is no description.
  assert.equal(doingText({ title: 'settle-r-4-1912', agentName: 'settle-r-4-1912', brief: 'Settle the run.', itemTitle: 'X' }), 'Settle the run.');
  assert.equal(doingText({ title: 'R-16 on ENG-7', brief: null, itemTitle: 'Implement the theft fix' }), 'Implement the theft fix');
  // Codes are stripped from what is shown.
  assert.equal(doingText({ title: 'REV-8 pstore retention design review' }), 'pstore retention design review');
  // The brief's first sentence, skipping headings.
  assert.equal(doingText({ brief: '# Brief: run R-5 on ENG-1\n\n## Work item\n- **ENG-1** Build the console. Then more.' }), 'Build the console.');
  assert.equal(doingText({ itemTitle: 'Five-repository release map' }), 'Five-repository release map');
  assert.equal(doingText({}), 'no description');
});

test('mouse reports parse as SGR events, and anything else is not a mouse event', () => {
  assert.equal(MOUSE_ON, '\x1b[?1000h\x1b[?1006h');
  assert.equal(MOUSE_OFF, '\x1b[?1000l\x1b[?1006l');
  assert.deepEqual(parseMouse('\x1b[<0;10;5M'), { button: 'left', x: 9, y: 4, press: true });
  // Ink strips the escape before the handler sees it.
  assert.deepEqual(parseMouse('[<2;1;1M'), { button: 'right', x: 0, y: 0, press: true });
  assert.deepEqual(parseMouse('[<0;3;3m'), { button: 'left', x: 2, y: 2, press: false });
  assert.deepEqual(parseMouse('[<64;3;7M'), { button: 'wheelUp', x: 2, y: 6, press: true });
  assert.deepEqual(parseMouse('[<65;3;7M'), { button: 'wheelDown', x: 2, y: 6, press: true });
  assert.deepEqual(parseMouse('[<1;3;7M'), { button: 'middle', x: 2, y: 6, press: true });
  assert.equal(parseMouse('[<32;3;7M').button, 'motion');
  // Modifier bits (shift 4, meta 8, ctrl 16) do not change the button.
  assert.equal(parseMouse('[<16;3;7M').button, 'left');
  for (const other of ['j', '[A', '', '[<0;3M', '\x1b[<a;1;1M']) assert.equal(parseMouse(other), null);
});

test('a worktree belongs to its main repository, and a folder outside git stands alone', () => {
  const calls = [];
  const git = (cwd) => {
    calls.push(cwd);
    return {
      '/r/herdr-org': '/r/herdr-org/.git',
      '/r/herdr-org/lib': '/r/herdr-org/.git',
      '/w/herdr-org/lane-x': '/r/herdr-org/.git',
      '/bare/thing': '/bare/thing.git',
    }[cwd] ?? null;
  };
  const exists = (p) => p !== '/gone';
  const repoOf = createRepoResolver({ git, exists, home: '/r' });
  assert.deepEqual(repoOf('/w/herdr-org/lane-x'), { root: '/r/herdr-org', name: 'herdr-org', path: '~/herdr-org', git: true });
  assert.deepEqual(repoOf('/r/herdr-org/lib'), repoOf('/r/herdr-org'));
  assert.deepEqual(repoOf('/bare/thing'), { root: '/bare/thing.git', name: 'thing', path: '/bare/thing.git', git: true });
  assert.deepEqual(repoOf('/tmp/notes'), { root: '/tmp/notes', name: 'notes', path: '/tmp/notes', git: false });
  assert.equal(repoOf('/gone'), null);
  assert.equal(repoOf(null), null);
  repoOf('/w/herdr-org/lane-x');
  assert.equal(calls.filter((c) => c === '/w/herdr-org/lane-x').length, 1, 'answers are cached');
  assert.equal(homePath('/r/a/b', '/r'), '~/a/b');
  assert.equal(homePath('/rx/a', '/r'), '/rx/a');
});

test('plain glyphs are ASCII, and folding makes the screen\'s own symbols ASCII', () => {
  const nerd = glyphsFor('nerd');
  const plain = glyphsFor('plain');
  assert.equal(nerd.right, '');
  assert.deepEqual(Object.keys(plain).sort(), Object.keys(nerd).sort());
  const flat = JSON.stringify(plain);
  assert.match(flat, /^[\x20-\x7e]*$/);
  assert.equal(asciiFold('a · b … ─╭╮╰╯│ ▏ ↑↓ “q” ’ → ●'), 'a - b ~ -++++| | ^v "q" \' > *');
  assert.equal(asciiFold('déjà vu'), 'déjà vu', 'agent text keeps its letters');
  for (const [name, hex] of Object.entries(PALETTE)) assert.match(hex, /^#[0-9a-f]{6}$/, name);
  assert.equal(PALETTE.bg, '#000000');
});
