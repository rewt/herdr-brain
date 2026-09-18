// Console model tests: plain wording, code stripping, transcripts, markdown and
// terminal safety. Pure modules only, no Ink. Run by `npm test` at the root too.
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialState, promptParts, reduce } from '../lib/controller.mjs';
import { lineText, promptLine, renderFrame } from '../lib/frame.mjs';
import { renderMarkdown } from '../lib/markdown.mjs';
import {
  NO_PLAIN, boardRows, buildBoard, contextPairs, decisionHeadline, keepSelection, scopeItems, stableOrder, summaryParagraphs,
} from '../lib/model.mjs';
import {
  createSessionReader, firstMarkdownPath, lastAssistantText, parseAgentList, parseLedger, projectSlugs,
} from '../lib/sources.mjs';
import { cellWidth, clip, hasCodes, sanitize, stripCodes, wrap } from '../lib/text.mjs';
import { viewerFor } from '../lib/cli.mjs';

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
  { name: 'settle-r-12-1611', status: 'idle', tab: 't2', pane: 'p2', cwd: '/tmp/proj' },
  { name: 'exec-1700', status: 'working', tab: 't3', pane: 'p3', cwd: '/tmp/proj/sub' },
  { name: 'exec-1701', status: 'working', tab: 't4', pane: 'p4', cwd: '/tmp/other-project' },
  { name: 'plan-1702', status: 'working', tab: 't5', pane: 'p5', cwd: '/tmp/project' },
  { name: null, status: 'idle' },
] };

function sessions() {
  const reader = createSessionReader();
  return reader.notes({ ledgerDir: path.join(FIX, 'ledger'), date: '2026-09-16', configDirs: [path.join(FIX, 'claude-a'), path.join(FIX, 'claude-b')], cwd: '/tmp/proj' });
}

function model(t = today()) {
  return buildBoard({ today: t, herdr: HERDR, repoOf: (cwd) => (cwd ? { root: cwd, name: 'proj', path: cwd, git: false } : null) });
}

const allRows = (b) => [...boardRows(b, 'list'), ...b.history];

function frameView(b, state = {}, extra = {}) {
  const st = { ...initialState(), ...state };
  const find = (key) => allRows(b).find((r) => r.key === key) ?? null;
  return {
    glyphs: 'nerd', version: '0.0.2', header: { project: 'p' }, board: b, scopeItems: scopeItems(b), state: st,
    prompt: promptParts(st), selectedRow: find(st.selectedKey), popupRow: find(st.popup?.key), popupDoc: null, project: { org: '/tmp/org' },
    ...extra,
  };
}
const screenText = (f) => f.lines.map(lineText).join('\n');

// Org codes are upper case (ENG-7, R-12); Herdr agent names such as exec-1700 are not codes.
const CODE = /\b[A-Z][A-Z0-9]*-\d+\b|\b(?=[0-9a-fA-F]*\d)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{7,}\b/;

test('rows use plain language and mark records without it', () => {
  const b = model();
  assert.equal(b.waiting[0].headline, 'HUM-5 — Adopt the theft fix once its review passes?', 'a waiting row leads with its id as a handle');
  assert.equal(b.waiting[0].title, 'Adopt the theft fix once its review passes?');
  assert.equal(b.waiting[0].category, 'design');
  assert.equal(b.waiting[0].recommend, 'yes');
  assert.equal(b.waiting[2].title, `Merge at? ${NO_PLAIN}`);

  // History: newest first, across decisions, answers and finished work.
  assert.deepEqual(b.history.map((r) => [r.kind, r.headline, r.state, r.time]), [
    ['report', 'Storage-tool design review: needs work', 'blocked', '16:14'],
    ['decision', 'Leave the 13 exposed test cells alone until the fix lands', 'agent', '16:10'],
    ['decision', `Skip proof run: an hour of heavy memory. ${NO_PLAIN}`, 'agent', '16:09'],
    ['answer', 'Install storage tool v0.3 now?', 'yes · auto', '16:05'],
    ['report', 'Port the relay: needs a decision', 'needs a decision', '15:00'],
  ]);
  assert.deepEqual(b.history[1].doc, { path: '/tmp/archive/DECISION-CELLS-20260916.md' });
  assert.deepEqual(b.history[3].actions, ['overrule']);

  for (const row of allRows(b)) {
    assert.doesNotMatch((row.title ?? row.headline ?? row.session).replace(NO_PLAIN, ''), CODE, row.key);
    assert.doesNotMatch(`${row.tag ?? ''} ${row.state ?? ''} ${row.doing ?? ''}`, CODE, row.key);
  }
});

test('stripping codes keeps the sentence readable', () => {
  assert.equal(stripCodes('Skip per R-4 (deadbeef12): see ENG-7, and 35109079233; defaced.'), 'Skip per: see, and 35109079233; defaced.');
  assert.equal(decisionHeadline({ text: 'R-3 ENG-2' }).text, `decision recorded ${NO_PLAIN}`);
  assert.equal(stripCodes('Run the proof (ENG-1, optional) and the check (R-2; R-3).'), 'Run the proof (optional) and the check.');
});

test('only codes the organization issues are stripped; real names with numbers stay', () => {
  const t = today();
  t.project.item_prefixes = ['ENG', 'G', 'HUM'];
  t.waiting = [
    { ...t.waiting[0], id: 'HUM-8', title: 'Patch CVE-2024-3094 now?', why: 'SHA-256 and BIP-340 checks fail on the old build.' },
    { ...t.waiting[0], id: 'HUM-9', title: 'Ship ENG-7 with the SHA-256 fix?', why: 'Per DECISION-THEFT-20260916 and R-4.' },
    { ...t.waiting[0], id: 'HUM-10', title: 'Rename DES-3 now?' },
  ];
  const rows = buildBoard({ today: t }).waiting;
  assert.deepEqual(rows.map((r) => r.title), [
    'Patch CVE-2024-3094 now?',
    `Ship with the SHA-256 fix? ${NO_PLAIN}`,
    // DES is not a prefix this organization uses, so DES-3 is a name, not a code.
    'Rename DES-3 now?',
  ]);
  assert.match(summaryParagraphs(rows[0]).join('\n'), /SHA-256 and BIP-340 checks fail on the old build\./);
  assert.match(summaryParagraphs(rows[1]).join('\n'), /Recommend: yes\. Per and\. · no plain summary/);
  // The raw title and reason are in the Context tab.
  const context = Object.fromEntries(contextPairs(rows[1]));
  assert.equal(context.title, 'Ship ENG-7 with the SHA-256 fix?');
  assert.equal(context.why, 'Per DECISION-THEFT-20260916 and R-4.');
  // Without a prefix list (an older org), the prefixes org issues by default apply.
  assert.equal(stripCodes('Patch CVE-2024-3094 and ENG-2 per REV-1'), 'Patch CVE-2024-3094 and per');
  assert.equal(hasCodes('SHA-256, BIP-340, CVE-2024-3094'), false);
  assert.equal(hasCodes('see DECISION-CELLS-20260916.md'), true);
});

test('a possessive record code does not leave a broken question title', () => {
  const t = today();
  t.project.item_prefixes = ['ENG', 'G', 'HUM'];
  t.waiting = [{
    ...t.waiting[0],
    id: 'HUM-8',
    title: "Confirm that ENG-12's openspec exclusion covers generated files?",
  }];
  const row = buildBoard({ today: t }).waiting[0];
  assert.equal(row.title, `Question title depends on a record code ${NO_PLAIN}`);
  assert.equal(row.headline, `HUM-8 — Question title depends on a record code ${NO_PLAIN}`);
  assert.equal(Object.fromEntries(contextPairs(row)).title, "Confirm that ENG-12's openspec exclusion covers generated files?");
});

test('a decision summary is shown without codes, and marked when it had some', () => {
  assert.deepEqual(decisionHeadline({ summary: 'Dispatched ENG-12 after a1b2c3d4', text: 'x' }),
    { text: `Dispatched after ${NO_PLAIN}`, plain: true });
  const t = today();
  t.decided[0].summary = 'Dispatched ENG-12 after a1b2c3d4';
  const row = buildBoard({ today: t }).history.find((r) => r.kind === 'decision');
  assert.equal(row.headline, `Dispatched after ${NO_PLAIN}`);
  for (const p of summaryParagraphs(row)) assert.doesNotMatch(p.replace(NO_PLAIN, ''), CODE, p);
});

test('the Summary after a no says what happened to each dependent', () => {
  const t = today();
  t.decided = [{
    kind: 'question', id: 'HUM-4', seq: 38, title: 'Adopt the theft fix?', category: 'design', recommend: 'yes',
    answer: 'no', answered_by: 'human', overruled: false, note: null, at: at('16:05'), by: 'human',
    blocks: [
      { id: 'ENG-7', title: 'Implement the theft fix', status: 'active', open_runs: ['R-9'] },
      { id: 'ENG-8', title: 'Port the relay', status: 'done', open_runs: [] },
      { id: 'ENG-9', title: 'Drop the old path', status: 'dropped', open_runs: [] },
      { id: 'REV-3', title: 'Review the theft fix', status: 'blocked', open_runs: [] },
    ],
  }];
  const row = buildBoard({ today: t }).history.find((r) => r.kind === 'answer');
  const paragraphs = summaryParagraphs(row);
  assert.deepEqual(paragraphs.filter((p) => /^(Still|Already)/.test(p)), [
    'Still running, not stopped by the no: Implement the theft fix.',
    'Already closed, not reopened: Port the relay.',
    'Already dropped, not reopened: Drop the old path.',
    'Still blocked: Review the theft fix.',
  ]);
  assert.equal(paragraphs.filter((p) => /Still blocked/.test(p)).length, 1);
  assert.equal(Object.fromEntries(contextPairs(row)).blocks,
    'ENG-7 Implement the theft fix (active R-9), ENG-8 Port the relay (done), ENG-9 Drop the old path (dropped), REV-3 Review the theft fix (blocked)');
  // A yes releases them all, in one line.
  t.decided[0].answer = 'yes';
  const yes = summaryParagraphs(buildBoard({ today: t }).history.find((r) => r.kind === 'answer'));
  assert.ok(yes.includes('Released: Implement the theft fix; Port the relay; Drop the old path; Review the theft fix.'), yes.join('\n'));
});

test('the fallback viewer always opens a text editor, never the file itself', () => {
  assert.deepEqual(viewerFor({}), { cmd: 'open', args: ['-t'], blocking: false, label: 'the default text editor' });
  assert.deepEqual(viewerFor({ EDITOR: 'vim -R' }), { cmd: 'vim', args: ['-R'], blocking: true, label: 'vim' });
});

test('waiting rows keep the ranking org today gives', () => {
  const t = today();
  t.waiting.reverse();
  const rows = buildBoard({ today: t }).waiting;
  assert.deepEqual(rows.map((r) => r.question), ['HUM-7', 'HUM-6', 'HUM-5']);
});

test('rows keep their places, and selection its row or nearest neighbour', () => {
  assert.deepEqual(stableOrder(['a', 'b'], [{ key: 'c' }, { key: 'b' }, { key: 'a' }]).map((r) => r.key), ['c', 'a', 'b']);
  const before = ['q:HUM-5', 'q:HUM-6', 'q:HUM-7'];
  const rows = (keys) => keys.map((key) => ({ key }));
  assert.equal(keepSelection('q:HUM-6', before, rows(['q:HUM-9', 'q:HUM-5', 'q:HUM-6'])), 'q:HUM-6');
  // The selected question was answered: selection moves to its nearest surviving neighbour.
  assert.equal(keepSelection('q:HUM-6', before, rows(['q:HUM-5', 'q:HUM-7'])), 'q:HUM-7');
  assert.equal(keepSelection('q:HUM-6', before, []), null);
});

test('no codes appear outside the Context tab, except a waiting row\'s own id as its handle', () => {
  const b = model();
  for (const row of allRows(b)) {
    const view = row.kind === 'answer' || row.kind === 'decision' || row.kind === 'report' ? 'history' : 'list';
    const base = { view, selectedKey: row.key, historyKey: row.key };
    const handles = (text) => text.replace(/\b[A-Z]+-\d+ — /g, '');
    assert.doesNotMatch(handles(screenText(renderFrame(frameView(b, base), 140, 40))).replace(new RegExp(NO_PLAIN, 'g'), ''), CODE, row.key);
    const summary = renderFrame(frameView(b, { ...base, popup: { kind: 'summary', key: row.key, tab: 0, scroll: 0 } }), 140, 40);
    assert.doesNotMatch(handles(screenText(summary)).replace(new RegExp(NO_PLAIN, 'g'), ''), CODE, `${row.key} summary`);
  }
  const context = renderFrame(frameView(b, { selectedKey: 'q:HUM-5', popup: { kind: 'summary', key: 'q:HUM-5', tab: 2, scroll: 0 } }), 100, 40);
  assert.match(screenText(context), /item +HUM-5[\s\S]*blocks +ENG-7 Implement the theft fix/);
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
  const fsApi = { ...nodeFs, readSync: (...a) => { reads++; return nodeFs.readSync(...a); } };
  const cached = createSessionReader({ fsApi });
  const args = { ledgerDir: path.join(FIX, 'ledger'), date: '2026-09-16', configDirs: [path.join(FIX, 'claude-a'), path.join(FIX, 'claude-b')], cwd: '/tmp/proj' };
  cached.notes(args);
  const after = reads;
  cached.notes(args);
  assert.equal(reads, after);
});

test('a growing transcript is read only from where the last read stopped', () => {
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'console-transcript-'));
  const folder = path.join(root, 'cfg', 'projects', '-tmp-grow');
  nodeFs.mkdirSync(folder, { recursive: true });
  const ledgerDir = path.join(root, 'ledger');
  nodeFs.mkdirSync(ledgerDir);
  nodeFs.writeFileSync(path.join(ledgerDir, 'sessions-2026-09-16.log'), '10:00:00 exec-grow continue\n10:01:00 exec-never continue\n');
  const file = path.join(folder, 's.jsonl');
  const say = (text) => `${JSON.stringify({ type: 'assistant', timestamp: text, message: { content: [{ type: 'text', text }] } })}\n`;
  nodeFs.writeFileSync(file, `${say('first')}${'{"type":"user","message":{"content":"x"}}\n'.repeat(3000)}`);
  const bytes = [];
  let whole = 0;
  const fsApi = {
    ...nodeFs,
    readFileSync: (...a) => { if (String(a[0]).endsWith('.jsonl')) whole++; return nodeFs.readFileSync(...a); },
    readSync: (fd, buf, off, len, pos) => { bytes.push([pos, len]); return nodeFs.readSync(fd, buf, off, len, pos); },
  };
  const reader = createSessionReader({ fsApi });
  const args = { ledgerDir, date: '2026-09-16', configDirs: [path.join(root, 'cfg')], cwd: '/tmp/grow' };
  let s = reader.notes(args);
  assert.equal(s.sessions[0].transcript, null, 'no agent name yet');

  const size = nodeFs.statSync(file).size;
  bytes.length = 0;
  // The name arrives, then half a line: the half is left for the next read.
  const tail = say('second');
  nodeFs.appendFileSync(file, `{"type":"agent-name","agentName":"exec-grow"}\n${tail.slice(0, 20)}`);
  s = reader.notes(args);
  assert.equal(s.sessions[0].transcript, file);
  assert.equal(s.sessions[0].note, 'first');
  assert.equal(s.sessions[1].transcript, null);
  assert.ok(bytes.length && bytes.every(([pos]) => pos >= size), `only new bytes are read: ${JSON.stringify(bytes)}`);

  bytes.length = 0;
  nodeFs.appendFileSync(file, tail.slice(20));
  s = reader.notes(args);
  assert.equal(s.sessions[0].note, 'second');
  assert.ok(bytes.length && bytes.every(([pos]) => pos >= size + 46), JSON.stringify(bytes));

  // Nothing changed: nothing is read, and the missing name is not searched again.
  bytes.length = 0;
  reader.notes(args);
  assert.deepEqual(bytes, []);

  // A rewritten (shorter) file is read from the start.
  nodeFs.writeFileSync(file, `{"type":"agent-name","agentName":"exec-grow"}\n${say('third')}`);
  s = reader.notes(args);
  assert.equal(s.sessions[0].note, 'third');
  assert.equal(whole, 0, 'transcripts are never read whole into one string');
});

test('the ledger, Herdr output and note paths parse', () => {
  assert.deepEqual(parseLedger('16:11:02 settle-r-12-1611 settle R-12\n17:00:00 exec-1700 continue\njunk\n'), [
    { time: '16:11:02', name: 'settle-r-12-1611', mode: 'settle', subject: 'R-12' },
    { time: '17:00:00', name: 'exec-1700', mode: 'continue', subject: null },
  ]);
  const missing = createSessionReader().notes({ ledgerDir: '/nonexistent', date: '2026-09-16', configDirs: [], cwd: '/tmp' });
  assert.deepEqual(missing, { sessions: [], count: 0, error: null });
  assert.deepEqual(parseAgentList('{"result":{"agents":[{"name":"exec-1","agent_status":"idle","tab_id":"t","pane_id":"p"}]}}'),
    [{ name: 'exec-1', status: 'idle', tab: 't', pane: 'p', cwd: null, workspace: null, tool: null, title: null, session: null }]);
  assert.throws(() => parseAgentList('{"result":{}}'), /unexpected/);
  assert.equal(firstMarkdownPath('see /a/b.md and /c/d.md'), '/a/b.md');
  assert.equal(firstMarkdownPath('relative docs/x.md only'), null);
  assert.equal(firstMarkdownPath('see ~/notes/DECISION.md', '/home/me'), '/home/me/notes/DECISION.md');
  assert.equal(firstMarkdownPath('see ~/n.md'), path.join(os.homedir(), 'n.md'));
});

test('document paths follow the row kind', () => {
  const b = model();
  assert.deepEqual(b.waiting[0].doc, { path: path.join(FIX, 'memo.md') });
  assert.deepEqual(b.waiting[1].doc, { missing: 'no memo recorded' });
  const byKey = Object.fromEntries(allRows(b).map((r) => [r.key, r]));
  assert.deepEqual(byKey['n:ENG-7:39'].doc, { text: 'Skip R-9 proof run (deadbeef12): an hour of heavy memory. More detail here.' });
  assert.deepEqual(byKey['r:R-14'].doc, { path: '/tmp/org/runs/R-14/brief.md' });
  assert.deepEqual(byKey['f:R-13'].doc, { path: '/tmp/org/reports/R-13.md' });
  assert.deepEqual(byKey['h:exec-1700'].doc, { missing: 'no brief recorded' });
  const frame = renderFrame(frameView(b, { selectedKey: 'q:HUM-6', popup: { kind: 'summary', key: 'q:HUM-6', tab: 1, scroll: 0 } },
    { popupDoc: { status: 'missing', message: 'file not found: /x/y.md' } }), 100, 29);
  assert.match(screenText(frame), /file not found: \/x\/y\.md/);
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

const ROWS = model().waiting;
const ctx = { rows: ROWS, listPage: 5 };

test('a long title never hides the reason, its cursor or the keys', () => {
  const headline = `Adopt this ${'very '.repeat(8)}long fix?`;
  assert.equal(headline.length, 60);
  const row = { ...ROWS[0], headline };
  const local = { ...ctx, rows: [row] };
  const kk = (st, input, key = {}) => reduce(st, input, key, local);
  let s = kk({ ...initialState(), selectedKey: row.key }, 'n').state;
  const board = { waiting: [row], groups: [], history: [] };
  // The footer after its mode segment (" ANSWER " and the arrow) and one space.
  const frame = (st) => lineText(renderFrame(frameView(board, st), 80, 19, { termRows: 20 }).lines.at(-1)).slice(10).trimEnd();
  for (const ch of 'Too risky now') s = kk(s, ch).state;
  let line = frame(s);
  assert.ok(cellWidth(line) <= 70, line);
  assert.match(line, /^Decline “Adopt this.*…”\. Reason: Too risky now▏ {2}Enter next · Esc cancel$/);
  // A reason longer than the room keeps its end, where the typing is.
  for (const ch of ' because the relay test has not run yet') s = kk(s, ch).state;
  line = frame(s);
  assert.ok(cellWidth(line) <= 70, line);
  assert.match(line, /^Decline “Adopt thi?s?…”\. Reason: ….*not run yet▏ {2}Enter next · Esc cancel$/);
  s = kk(s, '', { return: true }).state;
  line = frame(s);
  assert.ok(cellWidth(line) <= 70, line);
  assert.match(line, /^Decline: Adopt thi?s?…? \(reason: Too ris.*…\) Enter to confirm, Esc to cancel$/);

  s = kk({ ...initialState(), selectedKey: row.key }, 'y').state;
  line = frame(s);
  assert.match(line, /^Approve: Adopt this very .*… Enter to confirm, Esc to cancel$/);
  assert.ok(cellWidth(line) <= 70, line);
  // Short prompts are shown whole.
  assert.equal(promptLine({ head: 'Approve: ', title: 'Go?', mid: '', reason: '', tail: ' Enter to confirm, Esc to cancel' }, 80),
    'Approve: Go? Enter to confirm, Esc to cancel');
});

test('agent text cannot drive the terminal', () => {
  const nasty = 'Adopt\x1b[31m red\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07 \x1b]0;title\x1b\\ ok\x9b2J\x07\x00\u202eevil\tend\r\nnext';
  assert.equal(sanitize(nasty), 'Adopt red link  okevil end next');
  assert.equal(sanitize(nasty, { keepNewlines: true }), 'Adopt red link  okevil end\nnext');
  assert.equal(sanitize('lone \x1b'), 'lone ');
  assert.equal(clip(nasty, 80), 'Adopt red link  okevil end next');
  assert.deepEqual(wrap('a\x1b[2Kb\nc', 10), ['ab', 'c']);
  const row = { ...ROWS[0], headline: nasty };
  const doc = { status: 'ok', text: `# Title\x1b[8m\n\n\`\`\`\ncode \x1b]52;c;aGk=\x07here\n\`\`\`\n` };
  const session = { ...model().groups[0].rows[0], session: nasty, doing: nasty, where: nasty };
  const board = { waiting: [row], groups: [{ key: 'g', name: nasty, path: nasty, rows: [session] }], history: [] };
  for (const popup of [null, ...[0, 1, 2].map((tab) => ({ kind: 'summary', key: row.key, tab, scroll: 0 })), { kind: 'summary', key: session.key, tab: 0, scroll: 0 }]) {
    const view = frameView(board, { selectedKey: row.key, popup, message: 'm\x1b[1A' }, { header: { project: 'p\x1b[2J' }, popupDoc: doc });
    const { lines } = renderFrame(view, 100, 29);
    for (const l of lines) assert.doesNotMatch(lineText(l), /[\x00-\x1f\x7f-\x9f]/, `${popup?.tab}: ${JSON.stringify(lineText(l))}`);
  }
});
