// Console model tests: pure modules only, no Ink. Run by `npm test` at the root too.
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialState, promptText, reduce } from '../lib/controller.mjs';
import { columns, renderFrame, rowLine, scrollWindow } from '../lib/frame.mjs';
import { renderMarkdown } from '../lib/markdown.mjs';
import {
  NO_PLAIN, buildRows, decisionHeadline, flatRows, keepSelection, orderKeys, orderSections, stableOrder,
} from '../lib/model.mjs';
import {
  createSessionReader, firstMarkdownPath, lastAssistantText, parseAgentList, parseLedger, projectSlugs,
} from '../lib/sources.mjs';
import { cellWidth, stripCodes } from '../lib/text.mjs';

process.env.TZ = 'America/Chicago';
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const at = (hhmm) => new Date(`2026-09-16T${hhmm}:00-05:00`).toISOString();

function today() {
  return {
    project: { org: '/tmp/org', as_of: at('17:12'), day: { date: '2026-09-16' } },
    waiting: [
      { id: 'HUM-5', title: 'Adopt the theft fix once its review passes?', status: 'ready', category: 'design', recommend: 'yes',
        why: 'O1 is the only option where the network itself refuses the theft.', on_yes: 'Implementation starts.', on_no: 'The fix path stops.',
        memo: path.join(FIX, 'memo.md'), priority: 80, created: { at: at('16:20'), by: 'exec-1610' },
        blocks: [{ id: 'ENG-7', title: 'Implement the theft fix' }], unblocks_prioritized: 3 },
      { id: 'HUM-6', title: 'Fund one Chipnet test transaction (≤3,000 sats)?', status: 'ready', category: 'funds-and-chain', recommend: 'yes',
        why: 'Needed for the relay test.', on_yes: null, on_no: null, memo: null, priority: null,
        created: { at: at('16:21'), by: 'exec-1610' }, blocks: [], unblocks_prioritized: 0 },
      { id: 'HUM-7', title: 'Merge ENG-7 at a1b2c3d4?', status: 'ready', category: 'publish', recommend: 'yes', why: 'x',
        memo: null, priority: null, created: { at: at('16:22'), by: 'exec-1610' }, blocks: [], unblocks_prioritized: 0 },
    ],
    decided: [
      { kind: 'note', id: 'ENG-7', seq: 40, title: 'Implement the theft fix', summary: 'Leave the 13 exposed test cells alone until the fix lands',
        text: 'Per /tmp/archive/DECISION-CELLS-20260916.md keep R-12 cells', at: at('16:10'), by: 'exec-1610' },
      { kind: 'note', id: 'ENG-7', seq: 39, title: 'Implement the theft fix', summary: null,
        text: 'Skip R-9 proof run (deadbeef12): an hour of heavy memory. More detail here.', at: at('16:09'), by: 'exec-1610' },
      { kind: 'question', id: 'HUM-4', seq: 38, title: 'Install storage tool v0.3 now?', category: 'tooling', recommend: 'yes',
        answer: 'yes', answered_by: 'auto', overruled: false, note: null, at: at('16:05'), by: 'exec-1600', blocks: [] },
    ],
    running: [
      { run: 'R-14', item: 'REV-3', title: 'Independent review of the theft fix', role: 'reviewer', started: at('16:05'),
        agent: 'lane-review', lane: 'review', brief_path: '/tmp/org/runs/R-14/brief.md', report_path: '/tmp/r.md' },
      { run: 'R-15', item: 'ARCH-2', title: 'Five-repository release map', role: 'architect', started: at('16:06'),
        agent: 'lane-map', lane: 'map', brief_path: '/tmp/org/runs/R-15/brief.md', report_path: '/tmp/r2.md' },
    ],
    finished: [
      { kind: 'report', run: 'R-13', item: 'REV-2', title: 'Storage-tool design review', role: 'reviewer', outcome: 'blocked',
        headline: 'Storage-tool design review: needs work', summary: 'Two gaps.', report_file: '/tmp/org/reports/R-13.md', at: at('16:14') },
      { kind: 'report', run: 'R-11', item: 'ENG-6', title: 'Port the relay', role: 'engineer', outcome: 'needs_human',
        headline: null, summary: 'Stuck.', report_file: '/tmp/org/reports/R-11.md', at: at('15:00') },
    ],
    approvals: { policy: { default: 'ask', categories: {} }, counts: {} },
    attention: [{ id: 'ENG-7', kind: 'stale', text: 'R-9 open 30h' }],
  };
}

const HERDR = { ok: true, agents: [
  { name: 'lane-review', status: 'working', tab: 't1', pane: 'p1' },
  { name: 'settle-r-12-1611', status: 'idle', tab: 't2', pane: 'p2' },
  { name: 'exec-1700', status: 'working', tab: 't3', pane: 'p3' },
  { name: null, status: 'idle' },
] };

function sessions() {
  const reader = createSessionReader();
  return reader.notes({ ledgerDir: path.join(FIX, 'ledger'), date: '2026-09-16', configDirs: [path.join(FIX, 'claude-a'), path.join(FIX, 'claude-b')], cwd: '/tmp/proj' });
}

function model() {
  return buildRows({ today: today(), herdr: HERDR, sessions: sessions() });
}

const CODE = /\b[A-Z][A-Z0-9]*-\d+\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/i;

test('rows use plain language and mark records without it', () => {
  const sections = model();
  const by = Object.fromEntries(sections.map((s) => [s.key, s.rows]));
  assert.deepEqual(sections.map((s) => s.title), ['WAITING ON YOU', 'DECIDED TODAY', 'RUNNING', 'FINISHED TODAY', 'SESSION NOTES']);

  assert.equal(by.waiting[0].headline, 'Adopt the theft fix once its review passes?');
  assert.equal(by.waiting[0].tag, 'design');
  assert.equal(by.waiting[0].state, 'recommend: yes');
  assert.equal(by.waiting[2].headline, `Merge at? ${NO_PLAIN}`);

  assert.equal(by.decided[0].headline, 'Leave the 13 exposed test cells alone until the fix lands');
  assert.equal(by.decided[0].state, 'agent');
  assert.deepEqual(by.decided[0].doc, { path: '/tmp/archive/DECISION-CELLS-20260916.md' });
  assert.equal(by.decided[1].headline, `Skip proof run: an hour of heavy memory. ${NO_PLAIN}`);
  assert.equal(by.decided[2].state, 'yes · auto');
  assert.deepEqual(by.decided[2].actions, ['overrule']);

  assert.deepEqual(by.running.map((r) => [r.headline, r.tag, r.state]), [
    ['Independent review of the theft fix', 'review', 'since 16:05 · working'],
    ['Five-repository release map', 'design', 'since 16:06 · agent gone'],
    ['Settling a finished task', 'executive', 'since 16:11 · idle'],
    ['Executive session', 'executive', 'since 17:00 · working'],
  ]);

  assert.equal(by.finished[0].headline, 'Storage-tool design review: needs work');
  assert.equal(by.finished[1].headline, 'Port the relay: needs a decision');

  assert.deepEqual(by.sessions.map((r) => [r.headline, r.time, r.state]), [
    ['transcript not found', '17:00', 'working'],
    ['Recorded 3 results, started 2 tasks, wrote 8 memos.', '16:11', 'idle'],
  ]);

  for (const row of flatRows(sections)) {
    assert.doesNotMatch(row.headline.replace(NO_PLAIN, ''), CODE, row.headline);
    assert.doesNotMatch(`${row.tag} ${row.state}`, CODE);
  }
});

test('Herdr being unavailable shows unknown, never a guess', () => {
  const rows = buildRows({ today: today(), herdr: { ok: false, agents: [] }, sessions: null });
  const running = rows.find((s) => s.key === 'running').rows;
  assert.deepEqual(running.map((r) => r.state), ['since 16:05 · unknown', 'since 16:06 · unknown']);
});

test('stripping codes keeps the sentence readable', () => {
  assert.equal(stripCodes('Skip per R-4 (deadbeef12): see ENG-7, and 35109079233; defaced.'), 'Skip per: see, and 35109079233; defaced.');
  assert.equal(decisionHeadline({ text: 'R-3 ENG-2' }).text, `decision recorded ${NO_PLAIN}`);
  assert.equal(stripCodes('Run the proof (ENG-1, optional) and the check (R-2; R-3).'), 'Run the proof (optional) and the check.');
});

test('waiting rows keep the ranking org today gives', () => {
  const t = today();
  t.waiting.reverse();
  const rows = buildRows({ today: t }).find((s) => s.key === 'waiting').rows;
  assert.deepEqual(rows.map((r) => r.question), ['HUM-7', 'HUM-6', 'HUM-5']);
});

test('refreshes keep rows in place and selection on the same row', () => {
  const first = model();
  const keys = orderKeys(first);
  // Next refresh: a new question ranks first, and two existing ones swap rank.
  const t = today();
  t.waiting = [{ ...t.waiting[1], id: 'HUM-9', title: 'New question?' }, t.waiting[2], t.waiting[1], t.waiting[0]];
  const next = orderSections(buildRows({ today: t, herdr: HERDR, sessions: sessions() }), keys);
  assert.deepEqual(next[0].rows.map((r) => r.question), ['HUM-9', 'HUM-5', 'HUM-6', 'HUM-7']);
  assert.deepEqual(stableOrder(['a', 'b'], [{ key: 'c' }, { key: 'b' }, { key: 'a' }]).map((r) => r.key), ['c', 'a', 'b']);

  const flatBefore = flatRows(first).map((r) => r.key);
  assert.equal(keepSelection('q:HUM-6', flatBefore, flatRows(next)), 'q:HUM-6');
  // The selected question was answered: selection moves to its nearest surviving neighbour.
  const answered = flatRows(next).filter((r) => r.key !== 'q:HUM-6');
  assert.equal(keepSelection('q:HUM-6', flatBefore, answered), 'q:HUM-7');
  assert.equal(keepSelection('q:HUM-6', flatBefore, []), null);
});

test('rows and frames fit 80, 100 and 140 columns', () => {
  const sections = model();
  const rows = flatRows(sections);
  for (const cols of [80, 100, 140]) {
    const c = columns(cols);
    assert.equal(c.marker + c.headline + 1 + c.tag + 1 + c.right, cols);
    for (const row of rows) assert.equal(cellWidth(rowLine(row, cols, '> ')), cols);
  }
  const wide = { ...rows[0], headline: '日本語のテキスト'.repeat(20) };
  assert.equal(cellWidth(rowLine(wide, 80)), 80);

  for (const [cols, height] of [[80, 24], [100, 30], [140, 40]]) {
    for (const tab of [0, 1, 2]) {
      for (const expanded of [false, true]) {
        const view = {
          header: { project: 'bch-cloak', clock: '17:12', sessions: '22/30 sessions today', alerts: 1 },
          sections, selected: rows[0], focus: 'list', tab, expanded, readerScroll: 0,
          document: { status: 'ok', text: '# Memo\n\n' + 'Long text. '.repeat(200) }, project: { org: '/tmp/org' },
          message: 'x'.repeat(300), projectCount: 2,
        };
        const { lines } = renderFrame(view, cols, height - 1);
        assert.equal(lines.length, height - 1, `${cols}x${height} tab ${tab}`);
        for (const l of lines) assert.ok(cellWidth(l.text) <= cols, `${cols}: ${l.text}`);
        const title = lines.find((l) => l.style === 'title');
        assert.match(title.text, /\[1 Summary\] 2 Document 3 Context$|1 Summary \[2 Document\] 3 Context$|2 Document \[3 Context\]$/);
      }
    }
  }
  const small = renderFrame({ sections, selected: rows[0], header: { project: 'p' } }, 70, 18).lines;
  assert.match(small.map((l) => l.text).join('\n'), /Resize to at least 80×20 \(now 70×18\)/);
  assert.ok(small.length <= 18);
});

test('the list scrolls only as far as the selection needs', () => {
  assert.equal(scrollWindow(0, 5, 10, 30), 0);
  assert.equal(scrollWindow(0, 12, 10, 30), 3);
  assert.equal(scrollWindow(3, 8, 10, 30), 3);
  assert.equal(scrollWindow(5, 4, 10, 30), 3);
  assert.equal(scrollWindow(25, 29, 10, 30), 20);
});

test('no codes appear outside the Context tab', () => {
  const sections = model();
  for (const row of flatRows(sections)) {
    for (const tab of [0, 2]) {
      const view = { header: { project: 'p' }, sections, selected: row, focus: 'list', tab, readerScroll: 0, project: { org: '/tmp/org' } };
      const { lines } = renderFrame(view, 140, 80);
      const readerStart = lines.findIndex((l) => l.style === 'title' || l.style === 'titleFocus');
      const outside = lines.slice(0, tab === 2 ? readerStart : lines.length).map((l) => l.text.replace(NO_PLAIN, '')).join('\n');
      assert.doesNotMatch(outside, CODE, `${row.key} tab ${tab}`);
    }
  }
  const context = renderFrame({ header: {}, sections, selected: flatRows(sections)[0], focus: 'list', tab: 2, project: { org: '/tmp/org' } }, 100, 40);
  assert.match(context.lines.map((l) => l.text).join('\n'), /item:\s+HUM-5[\s\S]*blocks:\s+ENG-7 Implement the theft fix/);
});

test('transcripts are found by agent name across config dirs and give the last assistant text', () => {
  const s = sessions();
  assert.equal(s.count, 2);
  assert.equal(s.sessions[0].transcript, path.join(FIX, 'claude-b/projects/-tmp-proj/abc.jsonl'));
  assert.equal(s.sessions[0].note, '**Recorded 3 results**, started 2 tasks, wrote 8 memos.\n\n## Details\n- R-12 settled (see `abc1234`)\n- ENG-7 started');
  assert.equal(s.sessions[0].note_at, '2026-09-16T16:11:00.000Z');
  assert.equal(s.sessions[1].transcript, null);
  assert.equal(lastAssistantText('{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}'), null);
  assert.deepEqual(projectSlugs('/Users/me/.worktrees/a_b'), ['-Users-me-.worktrees-a_b', '-Users-me--worktrees-a-b']);

  // Only files touched since the day began are searched.
  const reader = createSessionReader();
  assert.equal(reader.find({ configDirs: [path.join(FIX, 'claude-b')], cwd: '/tmp/proj', name: 'settle-r-12-1611', sinceMs: Date.now() + 60000 }), null);

  // Cached by modification time: an unchanged file is not read twice.
  let reads = 0;
  const fsApi = { ...nodeFs, readFileSync: (...a) => { if (String(a[0]).endsWith('.jsonl')) reads++; return nodeFs.readFileSync(...a); } };
  const cached = createSessionReader({ fsApi });
  const args = { ledgerDir: path.join(FIX, 'ledger'), date: '2026-09-16', configDirs: [path.join(FIX, 'claude-a'), path.join(FIX, 'claude-b')], cwd: '/tmp/proj' };
  cached.notes(args);
  const after = reads;
  cached.notes(args);
  assert.equal(reads, after);
});

test('the ledger, Herdr output and note paths parse', () => {
  assert.deepEqual(parseLedger('16:11:02 settle-r-12-1611 settle R-12\n17:00:00 exec-1700 continue\njunk\n'), [
    { time: '16:11:02', name: 'settle-r-12-1611', mode: 'settle', subject: 'R-12' },
    { time: '17:00:00', name: 'exec-1700', mode: 'continue', subject: null },
  ]);
  const missing = createSessionReader().notes({ ledgerDir: '/nonexistent', date: '2026-09-16', configDirs: [], cwd: '/tmp' });
  assert.deepEqual(missing, { sessions: [], count: 0, error: null });
  assert.deepEqual(parseAgentList('{"result":{"agents":[{"name":"exec-1","agent_status":"idle","tab_id":"t","pane_id":"p"}]}}'),
    [{ name: 'exec-1', status: 'idle', tab: 't', pane: 'p', cwd: null, workspace: null }]);
  assert.throws(() => parseAgentList('{"result":{}}'), /unexpected/);
  assert.equal(firstMarkdownPath('see /a/b.md and /c/d.md'), '/a/b.md');
  assert.equal(firstMarkdownPath('relative docs/x.md only'), null);
});

test('document paths follow the row kind', () => {
  const by = Object.fromEntries(model().map((s) => [s.key, s.rows]));
  assert.deepEqual(by.waiting[0].doc, { path: path.join(FIX, 'memo.md') });
  assert.deepEqual(by.waiting[1].doc, { missing: 'no memo recorded' });
  assert.deepEqual(by.decided[1].doc, { text: 'Skip R-9 proof run (deadbeef12): an hour of heavy memory. More detail here.' });
  assert.deepEqual(by.running[0].doc, { path: '/tmp/org/runs/R-14/brief.md' });
  assert.deepEqual(by.finished[0].doc, { path: '/tmp/org/reports/R-13.md' });
  assert.equal(by.sessions[1].doc.text.startsWith('**Recorded 3 results**'), true);
  assert.deepEqual(by.sessions[0].doc, { missing: 'no transcript names exec-1700' });
  const frame = renderFrame({ header: {}, sections: model(), selected: by.waiting[1], focus: 'list', tab: 1,
    document: { status: 'missing', message: 'file not found: /x/y.md' } }, 100, 29);
  assert.match(frame.lines.map((l) => l.text).join('\n'), /file not found: \/x\/y\.md/);
});

test('markdown renders headings, lists, tables and code within the width', () => {
  const lines = renderMarkdown('---\nrun: R-1\n---\n# Title\n\nSome *emphasis* and `code`.\n\n- one\n- two that is long enough to wrap around\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nraw  text\n```', 30);
  assert.deepEqual(lines.map((l) => [l.style, l.text]), [
    ['meta', 'run: R-1'], ['text', ''], ['heading', 'TITLE'], ['text', 'Some emphasis and code.'], ['text', ''],
    ['text', '• one'], ['text', '• two that is long enough to'], ['text', '  wrap around'], ['text', ''],
    ['heading', 'a   │ b'], ['rule', '────┼────'], ['table', '1   │ 2'], ['text', ''], ['code', '  raw  text'],
  ]);
  const narrow = renderMarkdown('| column one | column two |\n|---|---|\n| a long value here | another long value |', 20);
  assert.deepEqual(narrow.map((l) => l.text), ['column one: a long', '  value here', 'column two: another', '  long value']);
  for (const l of renderMarkdown('x'.repeat(100) + '\n\n```\n' + 'y'.repeat(100) + '\n```', 20)) assert.ok(cellWidth(l.text) <= 20);
});

const ROWS = flatRows(model());
const ctx = { rows: ROWS, listPage: 5, readerPage: 5, readerMax: 12, projectCount: 1 };
const k = (s, input, key = {}) => reduce(s, input, key, ctx);
const start = () => ({ ...initialState(), selectedKey: ROWS[0].key });

test('approving needs Enter to confirm, and Esc cancels', () => {
  let r = k(start(), 'y');
  assert.deepEqual(r.effects, []);
  assert.match(promptText(r.state), /^Approve: Adopt the theft fix once its review passes\? Enter to confirm, Esc to cancel$/);
  const pending = r.state;
  r = k(pending, 'q');
  assert.deepEqual(r.effects, [], 'q does not quit while confirming');
  r = k(pending, '', { escape: true });
  assert.equal(r.state.mode, null);
  assert.deepEqual(r.effects, []);
  r = k(pending, '', { return: true });
  assert.deepEqual(r.effects, [{ type: 'answer', question: 'HUM-5', answer: 'yes', note: null, overrule: false, headline: 'Adopt the theft fix once its review passes?' }]);
});

test('declining needs a one-line reason, then confirmation', () => {
  let s = k(start(), 'n').state;
  assert.equal(s.mode.kind, 'reason');
  let r = k(s, '', { return: true });
  assert.equal(r.state.mode.kind, 'reason');
  assert.match(r.state.message, /reason is required/);
  for (const ch of 'Too risky\nqyn') s = k(s, ch).state;
  s = k(s, '', { backspace: true }).state;
  assert.equal(s.mode.text, 'Too risky qy');
  s = k(s, '', { return: true }).state;
  assert.equal(s.mode.kind, 'confirm');
  assert.match(promptText(s), /^Decline: Adopt the theft fix.*\(reason: Too risky qy\) Enter to confirm/);
  r = k(s, '', { return: true });
  assert.deepEqual(r.effects, [{ type: 'answer', question: 'HUM-5', answer: 'no', note: 'Too risky qy', overrule: false, headline: 'Adopt the theft fix once its review passes?' }]);

  const auto = ROWS.find((row) => row.key === 'a:HUM-4');
  s = reduce({ ...initialState(), selectedKey: auto.key }, 'n', {}, ctx).state;
  assert.equal(s.mode.action, 'overrule');
  assert.match(k({ ...initialState(), selectedKey: auto.key }, 'y').state.message, /Nothing to approve/);
  const note = ROWS.find((row) => row.kind === 'decision');
  assert.match(k({ ...initialState(), selectedKey: note.key }, 'n').state.message, /Nothing to decline/);
});

test('Escape never quits and q quits only from the list', () => {
  let s = start();
  assert.deepEqual(k(s, '', { escape: true }).effects, []);
  assert.deepEqual(k(s, 'q').effects, [{ type: 'quit' }]);
  s = k(s, '', { tab: true }).state;
  assert.equal(s.focus, 'reader');
  assert.deepEqual(k(s, 'q').effects, []);
  s = k(s, '', { escape: true }).state;
  assert.equal(s.focus, 'list');
  s = k(s, '', { return: true }).state;
  assert.equal(s.expanded, true);
  assert.deepEqual(k(s, 'q').effects, []);
  s = k(s, '', { escape: true }).state;
  assert.equal(s.expanded, false);
  s = k(s, '?').state;
  assert.equal(s.help, true);
  assert.deepEqual(k(s, 'q').effects, []);
  assert.equal(k(s, 'q').state.help, false);
  assert.equal(k(s, '', { escape: true }).state.help, false);
});

test('moving, paging, tabs and reader scrolling', () => {
  let s = start();
  s = k(s, 'j').state;
  assert.equal(s.selectedKey, ROWS[1].key);
  s = k(s, '', { end: true }).state;
  assert.equal(s.selectedKey, ROWS.at(-1).key);
  s = k(s, '', { pageUp: true }).state;
  assert.equal(s.selectedKey, ROWS.at(-6).key);
  s = k(s, '', { home: true }).state;
  assert.equal(s.selectedKey, ROWS[0].key);
  s = k(s, 'k').state;
  assert.equal(s.selectedKey, ROWS[0].key);
  s = k(s, '2').state;
  assert.equal(s.tab, 1);
  s = k(s, '', { tab: true }).state;
  s = k(s, '', { pageDown: true }).state;
  assert.equal(s.readerScroll, 5);
  s = k(s, '', { end: true }).state;
  assert.equal(s.readerScroll, 12);
  s = k(s, 'j').state;
  assert.equal(s.readerScroll, 12);
  assert.equal(s.selectedKey, ROWS[0].key, 'scrolling the reader does not move the selection');
  assert.deepEqual(k(s, 'o').effects, [{ type: 'open', row: ROWS[0].key, path: path.join(FIX, 'memo.md'), text: null }]);
  assert.deepEqual(k({ ...s, selectedKey: 'r:R-14' }, 'f').effects, [{ type: 'focus', agent: 'lane-review' }]);
  assert.match(k({ ...s, selectedKey: 'q:HUM-6' }, 'o').state.message, /No document to open: no memo recorded/);
  assert.match(k(s, 'p').state.message, /Only one project/);
  assert.deepEqual(reduce(s, 'p', {}, { ...ctx, projectCount: 2 }).effects, [{ type: 'project' }]);
  assert.deepEqual(k(s, 'r').effects, [{ type: 'reload' }]);
});
