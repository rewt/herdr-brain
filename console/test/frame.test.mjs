// The 0.0.2 screen at 80, 100, 140 and 180 columns: what is shown, where, and on
// what background. Pure; no Ink.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, promptParts, reduce } from '../lib/controller.mjs';
import { hitAt, layoutFor, lineText, renderFrame, scrollWindow } from '../lib/frame.mjs';
import { boardRows, scopeItems, visibleBoard } from '../lib/model.mjs';
import { PALETTE } from '../lib/theme.mjs';
import { cellWidth } from '../lib/text.mjs';
import { board } from './fixtures/board.mjs';

const B = board();

function view(state = {}, extra = {}) {
  const st = { ...initialState(), selectedKey: 'r:R-4', ...state };
  const shown = visibleBoard(B, st.scope);
  const rows = boardRows(B, st.view);
  const find = (key) => rows.find((r) => r.key === key) ?? boardRows(B, 'list').concat(B.history).find((r) => r.key === key) ?? null;
  return {
    glyphs: 'nerd',
    version: '0.0.2',
    header: { project: 'herdr-org', clock: '20:50', sessions: '4/30', waiting: 1, alerts: 0 },
    board: shown,
    scopeItems: scopeItems(B),
    state: st,
    prompt: promptParts(st),
    selectedRow: find(st.view === 'history' ? st.historyKey : st.selectedKey),
    popupRow: st.popup?.key ? find(st.popup.key) : null,
    popupDoc: { status: 'ok', text: '# Brief\n\nBuild the screen.\n\n' + 'More text. '.repeat(600) },
    project: { org: '/tmp/org' },
    launch: {},
    ...extra,
  };
}

const text = (frame) => frame.lines.map(lineText);
const CODE = /\b(?:ENG|G|HUM|REV|R)-\d+\b/;

function assertCanvas(frame, cols, rows, label) {
  assert.equal(frame.lines.length, rows, `${label}: height`);
  frame.lines.forEach((l, i) => {
    assert.equal(cellWidth(lineText(l)), cols, `${label}: line ${i} width: ${lineText(l)}`);
    for (const s of l.spans) {
      assert.ok(s.bg && PALETTE[s.bg], `${label}: line ${i} has a cell without a background: ${JSON.stringify(s)}`);
      assert.ok(s.fg && PALETTE[s.fg], `${label}: unknown colour ${s.fg}`);
    }
  });
}

test('at 140 × 40 the screen has the segment header, Waiting, grouped sessions with six columns, the launch bar and footer', () => {
  const f = renderFrame(view(), 140, 40);
  assertCanvas(f, 140, 40, '140');
  const t = text(f);
  assert.match(t[0], /^ \S* ?herdr-org \ue0b0 \S* ?20:50 \ue0b0 \S* ?4\/30 sessions today \ue0b0 \S* ?1 waiting on you \ue0b0 +\ue0b2 console 0\.0\.2 \ue0b2 \? help $/);
  assert.match(t[1], /^ \ue0b6 \S* ?WAITING ON YOU \ue0b4 ─+ \ue0b6 1 \ue0b4 $/);
  assert.match(t[2], /^ {3}! Promote the Herdr Brain console into main\? +tooling · recommend yes · asked 19:19 $/);
  // What each answer does sits under the question, so it can be decided without opening anything.
  assert.match(t[3], /^ {7}y {3}yes  Merged\.  ← recommended +$/);
  assert.match(t[4], /^ {7}n {3}no {3}Stays in its lane\. +$/);
  assert.equal(f.lines[3].spans.find((s) => s.text.includes('recommended')).fg, 'done');
  assert.match(t[5], /^ {5}SESSION {20}WHO {20}WHERE {14}UP {6}STATE {5}DOING/);
  assert.match(t[6], /herdr-lanes \ue0b4 ~\/herdr-lanes ─+ \ue0b6 1 \ue0b4 $/);
  assert.match(t[7], /^ {5}board-messages {13}Codex · unknown {8}lane-board-messag… unknown ■ blocked no description/);
  assert.match(t[8], /herdr-org \ue0b4 ~\/herdr-org ─+ \ue0b6 3 \ue0b4 $/);
  assert.match(t[9], /^ > {3}lane brain-console-v1 r3 {3}Claude Opus 5 · high {3}lane-brain-consol… 44m {5}● working Verifying correction round three +$/);
  assert.match(t[10], /settle-r-4-1912 +Claude Fable 5\.1 +herdr-org +1h +✓ done +no description/);
  assert.match(t[11], /lane relay r1 +Codex Astra · xhigh +lane-relay +20m +× gone +Port the relay to the new rules\./);
  assert.ok(f.lines[9].spans.every((s) => s.bg === 'selected'), 'the selected row is one band');
  assert.equal(f.lines[9].spans.find((s) => s.text === 'Claude').fg, 'claude');
  assert.equal(f.lines[7].spans.find((s) => s.text.startsWith('■')).fg, 'blocked');
  // Pinned bottom: rule, Task, Where/Who/Goal and Review launch, footer.
  assert.match(t[36], /^─{140}$/);
  assert.match(t[37], /^ Task {3}n {2}Describe the outcome\. Enter adds a line\. +$/);
  assert.match(t[38], /^ {8}Where {2}choose repository {4}Who {2}choose route {4}Goal {2}choose goal +\ue0b6 Review launch \ue0b4 $/);
  assert.match(t[39], /^ LIST \ue0b0 {2}j\/k {2}select {3}Enter {2}peek {3}r {2}reply {3}g {2}go there {3}s {2}summary {3}n {2}new task {3}m {2}menu {3}h {2}history {3}\? {2}help {3}q {2}quit/);
  assert.doesNotMatch(t.join('\n'), /DECIDED|FINISHED|SESSION NOTES/, 'no Decided or Finished list and no reader on the main screen');
  assert.doesNotMatch(t.join('\n'), CODE);
  // No rail below 180 columns.
  assert.doesNotMatch(t.join('\n'), /SCOPE|All repositories/);
});

test('at 100 columns WHERE goes; at 80 WHERE and UP go and DOING takes a second line', () => {
  const mid = renderFrame(view(), 100, 30);
  assertCanvas(mid, 100, 30, '100');
  const m = text(mid);
  assert.match(m[5], /^ {5}SESSION {16}WHO {20}UP {6}STATE {5}DOING/);
  assert.match(m[9], /^ > {3}lane brain-console-v1… Claude Opus 5 · high {3}44m {5}● working Verifying correction round th… $/);
  assert.doesNotMatch(m.join('\n'), /WHERE|lane-brain-console-v1 /);
  assert.match(m[26], /^─{100}$/);
  assert.match(m[28], /Where +choose repository +Who +choose route +Goal +choose goal +\ue0b6 Review launch \ue0b4 $/);

  const narrow = renderFrame(view(), 80, 24);
  assertCanvas(narrow, 80, 24, '80');
  const n = text(narrow);
  assert.match(n[0], /herdr-org .*20:50 .*4\/30 .*1 waiting .*\? help $/);
  assert.match(n[2], /^ {2}! Promote the Herdr Brain console into main\? +yes $/);
  assert.match(n[3], /^ {5}y {3}yes +← recommended $/, 'at 80 columns a choice shows its label, not what it causes');
  assert.doesNotMatch(n.join('\n'), /SESSION +WHO|WHERE|44m/);
  const at = n.findIndex((l) => l.includes('lane brain-console-v1 r3'));
  assert.match(n[at], /^ > ?lane brain-console-v1 r3 +Claude Opus 5 · high +● working $/);
  assert.match(n[at + 1], /^ {3}Verifying correction round three +$/);
  assert.ok(narrow.lines[at + 1].spans.every((s) => s.bg === 'selected'), 'both lines of the selected row are banded');
  assert.match(n[21], /^─{80}$/);
  assert.match(n[22], /^ Task /);
  assert.match(n[23], /^ LIST \ue0b0 {2}j\/k {2}select {3}Enter {2}peek {3}r {2}reply {3}g {2}go {3}\? {2}help {3}q {2}quit/, 'help and quit always fit');
  assert.deepEqual(layoutFor(80), { kind: 'narrow', mark: 2, session: 45, who: 20, where: 0, up: 0, state: 9, doing: 76 });
});

test('the rail appears only at 180 columns, and its choices are clickable', () => {
  const f = renderFrame(view(), 180, 40);
  assertCanvas(f, 180, 40, '180');
  const t = text(f);
  assert.match(t[1], /^ SCOPE {17} /);
  assert.match(t[2], /^ >All repositories {2}6 {2}/);
  assert.match(t[4], /^ {2}herdr-org {9}3 {2}/);
  assert.match(t[7], /^ ─{20} /);
  assert.match(t[8], /^ {2}! needs you {7}2 {2}/);
  // The main area keeps all six columns next to the rail.
  assert.match(t.join('\n'), /SESSION +WHO +WHERE +UP +STATE +DOING/);
  assert.deepEqual(hitAt(f.hits, 3, 4), { type: 'scope', index: 2 });
  assert.equal(hitAt(f.hits, 3, 7), null);
  assert.equal(renderFrame(view(), 179, 40).lines.map(lineText).join('\n').includes('All repositories'), false);
});

test('clicks map to the rows under them, including both lines of a narrow row', () => {
  const f = renderFrame(view(), 140, 40);
  assert.deepEqual(hitAt(f.hits, 20, 2), { type: 'row', key: 'q:HUM-5' });
  assert.deepEqual(hitAt(f.hits, 20, 3), { type: 'option', key: 'q:HUM-5', option: 'y' }, 'a click on a choice picks it');
  assert.deepEqual(hitAt(f.hits, 20, 9), { type: 'row', key: 'r:R-4' });
  assert.equal(hitAt(f.hits, 20, 1), null, 'a group header is not a row');
  assert.equal(hitAt(f.hits, 20, 0), null);
  assert.equal(hitAt(f.hits, 20, 39), null);
  const n = renderFrame(view(), 80, 24);
  const at = text(n).findIndex((l) => l.includes('lane brain-console-v1 r3'));
  assert.deepEqual(hitAt(n.hits, 5, at + 1), { type: 'row', key: 'r:R-4' });
});

test('plain glyphs and NO_COLOR give a readable screen with no character outside ASCII', () => {
  for (const [cols, rows] of [[80, 24], [100, 30], [140, 40], [180, 40]]) {
    for (const popup of [null, { kind: 'summary', key: 'r:R-4', tab: 0, scroll: 0 }, { kind: 'menu', key: 'r:R-4', index: 0, x: 4, y: 7 }, { kind: 'scope', index: 1 }]) {
      for (const extra of [{}, { state: { help: true } }]) {
        const v = view({ popup, ...(extra.state ?? {}) }, { glyphs: 'plain' });
        const f = renderFrame(v, cols, rows);
        assertCanvas(f, cols, rows, `plain ${cols}`);
        for (const l of text(f)) assert.match(l, /^[\x20-\x7e]*$/, `${cols} ${popup?.kind}: ${l}`);
      }
    }
  }
  const t = text(renderFrame(view({}, { glyphs: 'plain' }), 140, 40));
  assert.match(t[0], /^ herdr-org > 20:50 > 4\/30 sessions today > ! 1 waiting on you > +< console 0\.0\.2 < \? help $/);
  assert.match(t[1], /^ \| WAITING ON YOU \| -+ \| 1 \| $/);
  assert.match(t[3], /^ {7}y {3}yes  Merged\.  < recommended +$/);
  assert.match(t[9], / > {3}lane brain-console-v1 r3 {3}Claude Opus 5 - high {3}lane-brain-consol~ 44m {5}working {3}Verifying/);
});

test('s shows the summary over a dimmed screen; tabs, scrolling and the Context codes stay inside it', () => {
  const st = { popup: { kind: 'summary', key: 'r:R-4', tab: 0, scroll: 0 } };
  let f = renderFrame(view(st), 140, 40);
  assertCanvas(f, 140, 40, 'summary');
  let t = text(f);
  const top = t.findIndex((l) => l.includes('╭'));
  assert.ok(top > 0);
  assert.match(t[top + 1], /│ ● lane brain-console-v1 r3 · Claude Opus 5 · high · lane-brain-console-v1 · up 44m · working +│/);
  assert.match(t[top + 2], /│ \[1 Message\] {3}2 Brief {4}3 Context {3}/);
  assert.match(t[top + 4], /│ Last message · 20:49 +│/);
  assert.match(t[top + 6], /│ Working on it\. +│/);
  assert.equal(f.lines[0].spans[0].fg, 'faint', 'the screen behind is dimmed');
  assert.deepEqual(hitAt(f.hits, t[top + 2].indexOf('3 Context') + 1, top + 2), { type: 'tab', tab: 2 });
  assert.deepEqual(hitAt(f.hits, 70, top + 5), { type: 'popup' });
  assert.equal(hitAt(f.hits, 2, top + 5).type, 'row', 'beside the popup a click lands on the screen behind (which closes the popup)');
  assert.equal(f.lines.at(-1).spans.map((s) => s.text).join('').includes('SUMMARY'), true);
  assert.match(t.at(-1), /1-3 +tabs .*Enter +peek .*Esc +close/);

  f = renderFrame(view({ popup: { kind: 'summary', key: 'r:R-4', tab: 1, scroll: 5 } }), 140, 40);
  t = text(f);
  assert.ok(f.popupMax > 0);
  assert.match(t.join('\n'), /─ \d+-\d+\/\d+ ─╯/);
  assert.doesNotMatch(t.join('\n'), /# Brief/);

  f = renderFrame(view({ popup: { kind: 'summary', key: 'r:R-4', tab: 2, scroll: 0 } }), 140, 40);
  t = text(f).join('\n');
  assert.match(t, /run +R-4 on ENG-1: Build the console/);
  assert.match(t, /transcript +\/c\/s-console\.jsonl/);

  // A question: Summary, Memo, Context.
  f = renderFrame(view({ selectedKey: 'q:HUM-5', popup: { kind: 'summary', key: 'q:HUM-5', tab: 0, scroll: 0 } }), 100, 30);
  t = text(f);
  assert.match(t.join('\n'), /\[1 Summary\] {3}2 Memo {4}3 Context/);
  assert.match(t.join('\n'), /Recommend: yes\. It works\./);
  assert.match(t.at(-1), /y\/n +answer/);
  const summaryOnly = t.join('\n').replace(/3 Context/, '');
  assert.doesNotMatch(summaryOnly, CODE);

  // A session with no transcript says why.
  f = renderFrame(view({ popup: { kind: 'summary', key: 'r:R-6', tab: 0, scroll: 0 } }), 100, 30);
  assert.match(text(f).join('\n'), /no message: the session is gone/);
});

test('the menu opens at its row; the scope and help popups list their choices', () => {
  let f = renderFrame(view({ popup: { kind: 'menu', key: 'r:R-4', index: 3, x: 30, y: 9 } }), 140, 40);
  let t = text(f);
  assert.match(t[10].slice(30), /^╭─+╮/);
  assert.match(t[11].slice(30), /^│ {3}Peek at its screen +Enter │/);
  assert.match(t[12].slice(30), /^│ {3}Reply in your words +r │/);
  assert.match(t[13].slice(30), /^│ {3}Go to session +g │/);
  assert.match(t[14].slice(30), /^│ > Summary +s │/);
  assert.equal(f.lines[0].spans[0].fg, renderFrame(view(), 140, 40).lines[0].spans[0].fg, 'the menu does not dim the screen');
  assert.deepEqual(hitAt(f.hits, 35, 11), { type: 'menu', index: 0 });
  assert.deepEqual(hitAt(f.hits, 35, 10), { type: 'popup' });
  assert.deepEqual(hitAt(f.hits, 5, 11), { type: 'row', key: 'r:R-6' }, 'the row beside the menu still maps');
  // Near the bottom it opens above the row.
  f = renderFrame(view({ popup: { kind: 'menu', key: 'r:R-4', index: 0, x: 130, y: 34 } }), 140, 40);
  t = text(f);
  assert.match(t[33], /╰─+╯ $/);

  f = renderFrame(view({ popup: { kind: 'scope', index: 2 } }), 100, 30);
  t = text(f).join('\n');
  assert.match(t, /╭─ Scope ─+╮/);
  assert.match(t, /│ {3}\* All repositories +6 │/);
  assert.match(t, /│ > {3}herdr-org +3 │/);
  assert.match(t, /│ {5}! needs you +2 │/);
  assert.match(t, /│ {5}h history +3 │/);

  f = renderFrame(view({ help: true }), 100, 30);
  t = text(f).join('\n');
  assert.match(t, /Herdr Brain console 0\.0\.2/);
  assert.match(t, /Enter, left click +peek at the session here/);
  assert.match(t, /Ctrl\+Alt\+B, or Ctrl\+B then `/);
  assert.match(t, /m, right click +row menu/);
});

test('history replaces the session list; Esc or h returns', () => {
  const st = { view: 'history', historyKey: 'n:ENG-7:40' };
  const f = renderFrame(view(st), 100, 30);
  const t = text(f);
  assert.match(t[1], /HISTORY \ue0b4 today, newest first ─+ \ue0b6 3 \ue0b4 $/);
  assert.match(t[2], /^ {3}19:06 {2}Console round two is fixed +engineering · finished $/);
  assert.match(t[3], /^ > 16:10 {2}Keep the cells +decision · agent $/);
  assert.match(t[4], /^ {3}16:05 {2}Install storage tool v0\.3 now\? +tooling · yes · auto $/);
  assert.doesNotMatch(t.join('\n'), /WAITING ON YOU|board-messages/);
  assert.match(t.at(-1), /HISTORY .*Enter +summary .*h +back/);
});

test('the list scrolls to the selection, shows more above and below, and the wheel moves it freely', () => {
  assert.equal(scrollWindow(0, 5, 10, 30), 0);
  assert.equal(scrollWindow(0, 12, 10, 30), 3);
  assert.equal(scrollWindow(0, 12, 10, 30, 13), 4);
  assert.equal(scrollWindow(5, 4, 10, 30), 3);
  const f = renderFrame(view({ selectedKey: 'h:pane:w2:p1' }), 80, 20);
  const t = text(f);
  assert.equal(f.listOffset > 0, true);
  assert.match(t[1], /^↑/);
  assert.match(t.join('\n'), /Coach\.me connector/);
  const free = renderFrame(view({ selectedKey: 'h:pane:w2:p1', follow: false, listOffset: 0 }), 80, 20);
  assert.equal(free.listOffset, 0);
  assert.match(text(free)[16], /^↓/);
  const far = renderFrame(view({ follow: false, listOffset: 99 }), 80, 20);
  assert.ok(far.listOffset < 99, 'the wheel cannot scroll past the end');
  assert.match(text(far)[16], /Coach\.me connector/, 'the last line is in view');
});

test('messages and prompts take the footer; a long title never hides the reason or keys', () => {
  let st = { ...initialState(), selectedKey: 'q:HUM-5' };
  st = reduce(st, 'n', {}, { rows: boardRows(B, 'list') }).state;
  for (const ch of 'not now') st = reduce(st, ch, {}, { rows: boardRows(B, 'list') }).state;
  let t = text(renderFrame(view(st), 80, 24));
  assert.match(t.at(-1), /^ ANSWER \ue0b0 Decline “Promote.*”\. Reason: not now▏ {2}Enter next · Esc cancel/);
  t = text(renderFrame(view({ message: 'task launching comes in the next round' }), 80, 24));
  assert.match(t.at(-1), /LIST \ue0b0 task launching comes in the next round/);
});

test('an empty or scoped board says why nothing is shown, and a small terminal only asks for more room', () => {
  const empty = { waiting: [], groups: [], history: [] };
  let t = text(renderFrame(view({}, { board: empty, header: { project: 'p', herdr: 'Herdr unavailable' } }), 100, 30)).join('\n');
  assert.match(t, /No sessions shown: Herdr unavailable\. Start or reach Herdr, then press r\./);
  t = text(renderFrame(view({ scope: { repo: '/r/none', view: 'all' } }), 100, 30)).join('\n');
  assert.match(t, /Nothing matches this scope/);

  const small = renderFrame(view(), 70, 18);
  assertCanvas(small, 70, 18, 'small');
  assert.match(text(small)[0], /Resize to at least 80×20 \(now 70×18\)/);
  assert.match(text(small)[1], /q quits/);
  assert.deepEqual(text(small).slice(2).filter((l) => l.trim()), []);
  // The app draws one row short of the terminal; an 80×20 terminal is big enough.
  const exact = renderFrame(view(), 80, 19, { termRows: 20 });
  assert.doesNotMatch(text(exact).join('\n'), /Resize/);
  assertCanvas(exact, 80, 19, 'exact');
});
