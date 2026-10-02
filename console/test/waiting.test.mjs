// Waiting on you as a work queue: what a stopped session left behind carries its
// choices and verbs, answering goes through the brain CLI, later and parked items
// fold into one line, and the peek follows a session once its row is answered.
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { brainArgs, choicesOf, loopWords, workUpArgs, workUpBrief } from '../lib/brain.mjs';
import { initialState, promptText, reduce, reduceMouse } from '../lib/controller.mjs';
import { hitAt, lineText, renderFrame } from '../lib/frame.mjs';
import { boardRows, buildBoard, scopeItems, visibleBoard } from '../lib/model.mjs';
import { createSession } from '../lib/session.mjs';

const AT = '2026-09-18T01:13:54.000Z';
const testSession = (options) => createSession({ env: {}, ...options });

// A settle session that finished and asked a yes/no question in prose; Claude drafted an answer.
const decision = {
  id: '2026091801135-settle-r-131-1945', at: AT, session: 'settle-r-131-1945', tab_label: 'settle R-131', tab: 'w1:t86', pane: 'w1:p86',
  project: 'bch',
  state: 'done', status: 'digested', unsent: null, suggestion: 'yes to the zero-conf reading', headline: 'The review passed.',
  screen: 'The review passed.\n❯ yes to the zero-conf reading',
  digest: {
    kind: 'decision', what_happened: 'It accepted the measurement.', question: 'Do you confirm the zero-conf reading?',
    options: [{ key: '1', label: 'Yes, confirm the zero-conf reading', causes: 'work proceeds on that basis' }, { key: '2', label: 'No / need more detail first', causes: 'you read the question first' }],
    recommend: '2', why: 'It is Claude’s draft, not yours.', next_step: null,
  },
};
// A session stuck at a dialog: its choices are the dialog's own keys.
const stuck = {
  id: '2026091801140-settle-r-119-1717', at: AT, session: 'settle-r-119-1717', tab_label: 'settle R-119', tab: 'w1:t70', pane: 'w1:p70',
  project: 'bch',
  state: 'blocked', status: 'digested', unsent: null, suggestion: null, headline: 'Teach auto mode about your environment?',
  dialog: { question: 'Teach auto mode about your environment?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'Not now' }, { key: '3', label: "Don't show again" }] },
  digest: { kind: 'obstacle', source: 'parser', question: 'Teach auto mode about your environment?', options: [{ key: '2', label: 'Not now', causes: 'Clears the dialog.' }], recommend: '2' },
};
// A report: finished, nothing asked.
const report = {
  id: '2026091801135-settle-r-133-1946', at: AT, session: 'settle-r-133-1946', tab_label: 'settle R-133', state: 'done', status: 'digested',
  project: 'bch',
  headline: 'The review that just finished passed, and the work it covered is accepted.',
  digest: { kind: 'report', question: null, options: [], recommend: null, next_step: 'Nothing to do right now.' },
};
const saved = { ...report, id: 'saved-1', session: 'settle-r-90-1200', tab_label: 'settle R-90', status: 'later', headline: 'An older report' };

const agents = [
  { name: 'settle-r-131-1945', status: 'done', tab: 'w1:t86', pane: 'w1:p86', cwd: '/r/bch', workspace: 'w1', tool: 'claude' },
  { name: 'settle-r-119-1717', status: 'blocked', tab: 'w1:t70', pane: 'w1:p70', cwd: '/r/bch', workspace: 'w1', tool: 'claude' },
];

const today = {
  project: { org: '/tmp/org', item_prefixes: ['ARCH', 'HUM'], open_stage: 1, day: { date: '2026-09-17' } },
  waiting: [
    { id: 'ARCH-67', title: 'Should the packet stop carrying four fields?', category: 'design', recommend: 'yes', on_yes: 'Two items use the smaller packet.', on_no: 'The packet keeps its shape.', stage: 1, created: { at: AT } },
    { id: 'HUM-8', title: 'Licensing and visibility for the five repositories', stage: 4, created: { at: AT } },
    { id: 'HUM-27', title: 'Delete the archive keys?', stage: 'parked', created: { at: AT } },
    { id: 'HUM-30', title: 'A question with no stage', created: { at: AT } },
  ],
  running: [], decided: [], finished: [], attention: [],
};

const makeBoard = (rows = [decision, stuck, report, saved]) => buildBoard({
  today, brain: { rows }, herdr: { ok: true, agents }, repoOf: () => ({ root: '/r/bch', name: 'bch', path: '~/bch', git: true }),
});

test('a dialog is answered by its own keys; a finished question by sending the chosen words', () => {
  assert.equal(choicesOf(stuck).via, 'key');
  assert.deepEqual(choicesOf(stuck).options.map((o) => o.key), ['1', '2', '3'], 'the dialog\'s own choices, all of them');
  assert.equal(choicesOf(stuck).recommend, '2');
  assert.equal(choicesOf(decision).via, 'send');
  assert.equal(choicesOf(decision).recommend, '2');
  const b = makeBoard();
  const row = (id) => b.waiting.find((r) => r.data?.id === id);
  assert.deepEqual(brainArgs('pick', row(stuck.id), { key: '2' }), ['key', stuck.id, '2']);
  assert.deepEqual(brainArgs('pick', row(decision.id), { key: '1' }), ['send', decision.id, 'Yes, confirm the zero-conf reading']);
  assert.equal(brainArgs('pick', row(decision.id), { key: '7' }), null, 'no such choice, nothing to run');
  assert.deepEqual(brainArgs('send', row(decision.id), { text: '  go ahead  ' }), ['send', decision.id, 'go ahead']);
  assert.deepEqual(brainArgs('later', row(report.id)), ['later', report.id]);
  assert.deepEqual(brainArgs('drop', row(report.id)), ['dismiss', report.id], 'a finished report is cleared, not refused');
  assert.deepEqual(brainArgs('drop', row(decision.id)), ['never', decision.id]);
});

test('the list holds what needs you now; saved and parked items fold into one line each', () => {
  const b = makeBoard();
  const shown = visibleBoard(b, {}, []);
  assert.deepEqual(shown.waiting.map((r) => r.kind === 'fold' ? `fold:${r.fold}:${r.count}` : r.question), [
    decision.id, stuck.id, report.id, 'ARCH-67', 'HUM-30', 'fold:later:1', 'fold:stages:2',
  ]);
  assert.equal(b.waitingCount, 5, 'folded rows are not counted as waiting');
  assert.equal(scopeItems(b).find((i) => i.view === 'needs').count, 6, 'five waiting, plus the one blocked session');
  const fold = shown.waiting.find((r) => r.key === 'fold:stages');
  assert.match(fold.headline, /^2 older questions are parked or wait for a later stage \(stage 1 is open now\)$/);
  const open = visibleBoard(b, {}, ['stages']);
  assert.deepEqual(open.waiting.filter((r) => r.foldedIn === 'stages').map((r) => r.question), ['HUM-8', 'HUM-27']);
  assert.equal(open.waiting.find((r) => r.key === 'fold:stages').open, true);
  // Without a stage configured, nothing is folded away.
  const flat = buildBoard({ today: { ...today, project: { ...today.project, open_stage: null } }, brain: { rows: [] } });
  assert.equal(flat.waiting.filter((r) => r.kind === 'question').length, 4);
});

test('each row carries only the verbs that apply to it', () => {
  const b = makeBoard();
  const row = (id) => b.waiting.find((r) => r.data?.id === id);
  assert.deepEqual(row(decision.id).actions, ['pick', 'draft', 'peek', 'reply', 'go', 'later', 'drop']);
  assert.deepEqual(row(stuck.id).actions, ['pick', 'peek', 'reply', 'go', 'later', 'drop']);
  assert.deepEqual(row(report.id).actions, ['later', 'drop'], 'its session is gone from Herdr: no peek, reply or go');
  assert.deepEqual(b.waiting.find((r) => r.data?.id === saved.id).actions, ['drop'], 'already saved for later');
  assert.deepEqual(b.waiting.find((r) => r.question === 'ARCH-67').actions, ['approve', 'decline', 'dispatch']);
});

// Keys, against the board as the console would show it.
function keysOn(board, unfolded = []) {
  const rows = boardRows(visibleBoard(board, {}, unfolded), 'list');
  const ctx = { rows, historyRows: [], scopeItems: [], listPage: 5, popupPage: 5, popupMax: 40, projectCount: 1, lineOf: () => 3, hitAt: () => null };
  return (state, ...keys) => {
    let s = state;
    const effects = [];
    for (const k of keys) {
      const [input, key] = typeof k === 'string' ? [k, {}] : ['', k];
      const r = reduce(s, input, key, ctx);
      s = r.state;
      effects.push(...r.effects);
    }
    return { state: s, effects };
  };
}

test('a number picks a choice after a confirmation that says exactly what will happen', () => {
  const press = keysOn(makeBoard());
  const onStuck = { ...initialState(), selectedKey: `q:${stuck.id}` };
  let r = press(onStuck, '2');
  assert.equal(promptText(r.state), 'Press 2 in settle R-119 (“Not now”)? Enter to confirm, Esc to cancel');
  assert.deepEqual(press(r.state, { return: true }).effects, [{ type: 'act', verb: 'pick', key: `q:${stuck.id}`, option: '2' }]);
  assert.deepEqual(press(r.state, { escape: true }).effects, [], 'Esc cancels and nothing is sent');
  assert.match(press(onStuck, '7').state.message, /^Pick 1, 2, 3\.$/);

  const onDecision = { ...initialState(), selectedKey: `q:${decision.id}` };
  r = press(onDecision, '1');
  assert.equal(promptText(r.state), 'Send to settle R-131: “Yes, confirm the zero-conf reading”  Enter send · e edit · Esc cancel');
  // e turns it into a reply to edit first.
  r = press(r.state, 'e', { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true });
  assert.equal(r.state.mode.kind, 'reply');
  assert.equal(r.state.mode.text, 'Yes, ');
  r = press(r.state, 'o', 'n', 'l', 'y', ' ', 'f', 'o', 'r', ' ', 'L', '1');
  assert.deepEqual(press(r.state, { return: true }).effects, [{ type: 'act', verb: 'send', key: `q:${decision.id}`, text: 'Yes, only for L1' }]);
});

test('y sends Claude\'s draft when there is one, else takes the recommendation; n takes the no', () => {
  const press = keysOn(makeBoard());
  const onDecision = { ...initialState(), selectedKey: `q:${decision.id}` };
  let r = press(onDecision, 'y');
  assert.equal(promptText(r.state), 'Send Claude’s draft to settle R-131: “yes to the zero-conf reading”  Enter send · e edit · Esc cancel');
  assert.deepEqual(press(r.state, { return: true }).effects, [{ type: 'act', verb: 'send', key: `q:${decision.id}`, text: 'yes to the zero-conf reading' }]);
  r = press(onDecision, 'n');
  assert.equal(r.state.mode.option, '2', 'the one choice that starts with No');
  r = press({ ...initialState(), selectedKey: `q:${stuck.id}` }, 'y');
  assert.equal(r.state.mode.option, '2', 'the recommended key of the dialog');
  assert.match(press({ ...initialState(), selectedKey: `q:${report.id}` }, 'y').state.message, /Nothing to accept here/);
  // On an org question y still approves.
  assert.match(promptText(press({ ...initialState(), selectedKey: 'q:ARCH-67' }, 'y').state), /^Approve: /);
});

test('r replies in the operator\'s words; l saves for later at once; x asks before dropping', () => {
  const press = keysOn(makeBoard());
  const onDecision = { ...initialState(), selectedKey: `q:${decision.id}` };
  let r = press(onDecision, 'r', 'h', 'i');
  assert.equal(promptText(r.state), 'Reply to settle R-131: hi▏  Enter send · Esc cancel');
  assert.deepEqual(press(r.state, { return: true }).effects, [{ type: 'act', verb: 'send', key: `q:${decision.id}`, text: 'hi' }]);
  assert.match(press(onDecision, 'r', { return: true }).state.message, /Type the reply first/);
  assert.match(press({ ...initialState(), selectedKey: `q:${report.id}` }, 'r').state.message, /no longer in Herdr/);

  assert.deepEqual(press(onDecision, 'l').effects, [{ type: 'act', verb: 'later', key: `q:${decision.id}` }]);
  r = press({ ...initialState(), selectedKey: `q:${report.id}` }, 'x');
  assert.equal(promptText(r.state), `Clear “${report.headline}” from the list? Enter to confirm, Esc to cancel`);
  r = press(onDecision, 'x');
  assert.match(promptText(r.state), /for good\? It will not come back\./);
  assert.deepEqual(press(r.state, { return: true }).effects, [{ type: 'act', verb: 'drop', key: `q:${decision.id}` }]);

  // d on an org question sends it off to be worked out, after asking.
  r = press({ ...initialState(), selectedKey: 'q:HUM-30' }, 'd');
  assert.match(promptText(r.state), /^Start a session to work out “HUM-30 — A question with no stage”\? It comes back here with the choices\./);
  assert.deepEqual(press(r.state, { return: true }).effects, [{ type: 'act', verb: 'dispatch', key: 'q:HUM-30' }]);
});

test('Enter on a fold opens it; Enter on a live result peeks; the peek keeps the verbs', () => {
  const b = makeBoard();
  let press = keysOn(b);
  let r = press({ ...initialState(), selectedKey: 'fold:stages' }, { return: true });
  assert.deepEqual(r.state.unfolded, ['stages']);
  press = keysOn(b, ['stages']);
  assert.equal(press(r.state, 'j').state.selectedKey, 'q:HUM-8', 'the opened fold\'s rows are under it');
  assert.deepEqual(press(r.state, { return: true }).state.unfolded, [], 'Enter again closes it');

  r = press({ ...initialState(), selectedKey: `q:${stuck.id}` }, { return: true });
  assert.deepEqual(r.state.popup, { kind: 'peek', key: `q:${stuck.id}`, scroll: 0, follow: true });
  const two = press(r.state, '2');
  assert.equal(two.state.mode.option, '2', 'a number answers the prompt from inside the peek');
  assert.deepEqual(press(two.state, { return: true }).state.popup?.kind, 'peek', 'the peek stays open to watch it take the answer');
  const up = press(r.state, 'k');
  assert.equal(up.state.popup.follow, false, 'scrolling up stops following');
  assert.equal(press(up.state, 'G').state.popup.follow, true);
  assert.equal(press(r.state, { return: true }).effects[0].type, 'go', 'Enter in the peek goes there');
  // A report whose session is gone opens its summary instead.
  assert.equal(press({ ...initialState(), selectedKey: `q:${report.id}` }, { return: true }).state.popup.kind, 'summary');
});

test('the screen shows each choice under its row, Claude\'s draft, and a click on a choice picks it', () => {
  const b = makeBoard();
  const st = { ...initialState(), selectedKey: `q:${decision.id}` };
  const v = {
    glyphs: 'nerd', version: '0.0.2', header: { project: 'bch', clock: '20:30', waiting: b.waitingCount }, board: visibleBoard(b, {}, []),
    scopeItems: scopeItems(b), state: st, prompt: null, selectedRow: b.waiting[0], popupRow: null, project: {}, launch: {},
  };
  const f = renderFrame(v, 140, 40);
  const t = f.lines.map(lineText);
  const at = t.findIndex((l) => l.includes('Do you confirm the zero-conf reading?'));
  assert.match(t[at], /^ > \? Do you confirm the zero-conf reading\? +needs your decision · settle R-131 · \d\d:\d\d $/);
  assert.match(t[at + 1], /^ {7}It accepted the measurement\. +$/, 'what is at stake comes first');
  assert.match(t[at + 2], /^ {7}1 {3}Yes, confirm the zero-conf reading {2}work proceeds on that basis +$/);
  assert.match(t[at + 3], /^ {7}2 {3}No \/ need more detail first {9}you read the question first  ← recommended +$/);
  assert.match(t[at + 4], /^ {7}why 2: It is Claude’s draft, not yours\. +$/, 'the selected row says why');
  assert.match(t[at + 5], /^ {7}Claude drafted, not sent: “yes to the zero-conf reading” {3}y sends it · r writes your own +$/);
  assert.match(t.join('\n'), /■ Teach auto mode about your environment\? +stuck at a prompt · settle R-119/);
  assert.match(t.join('\n'), /✓ The review that just finished passed.* finished · settle R-133/);
  assert.match(t.join('\n'), /next: Nothing to do right now\./);
  assert.match(t.join('\n'), /▸ 1 saved for later +Enter shows them/);
  assert.match(t.join('\n'), /▸ 2 older questions are parked or wait for a later stage \(stage 1 is open now\) +Enter shows them/);
  assert.match(t[1], /WAITING ON YOU .* 5 /);
  assert.match(t.at(-1), /Enter +peek .*1-2 +pick .*y +send draft .*r +reply .*l +later .*x +drop .*g +go there/);
  assert.deepEqual(hitAt(f.hits, 20, at + 3), { type: 'option', key: `q:${decision.id}`, option: '2' });
  const ctx = { rows: boardRows(v.board, 'list'), historyRows: [], scopeItems: [], hitAt: (x, y) => hitAt(f.hits, x, y) };
  const click = reduceMouse(st, { button: 'left', x: 20, y: at + 3, press: true }, ctx);
  assert.equal(click.state.mode.verb, 'pick');
  assert.equal(click.state.mode.option, '2');
});

test('answering goes through the brain CLI, refreshes, and the peek moves to the session', async () => {
  let rows = [decision, stuck];
  const calls = [];
  const brainAct = async (args) => {
    calls.push(args);
    if (args[2] === 'blocked please') return { ok: false, blocked: true, error: 'stuck' };
    rows = rows.filter((r) => r.id !== args[1]);
    return { ok: true, output: 'done' };
  };
  const config = { projects: [{ name: 'bch', org: '/tmp/none', cwd: '/r/bch', ledger_dir: null, claude_config_dirs: [] }], refresh_seconds: 60, brain_bin: '/x/brain.mjs' };
  const reads = [];
  const session = testSession({
    config,
    deps: {
      orgToday: async () => today, herdrAgents: async () => ({ ok: true, agents }), herdrTabs: async () => [], repoOf: () => null,
      brainQueue: async () => ({ rows }), brainAct, herdrRead: async (t) => { reads.push(t); return { ok: true, text: 'screen' }; },
    },
  });
  await session.refresh({ reorder: true });
  session.ui = { ...session.ui, selectedKey: `q:${stuck.id}` };
  await session.key('', { return: true });
  assert.equal(session.ui.popup.kind, 'peek');
  await session.key('2', {});
  await session.key('', { return: true });
  assert.deepEqual(calls, [['key', stuck.id, '2']]);
  assert.match(session.ui.message, /^Pressed 2 \(“Not now”\) in settle R-119\.$/);
  assert.equal(session.rows('list').some((r) => r.key === `q:${stuck.id}`), false, 'the answered row left the list');
  assert.equal(session.ui.popup.kind, 'peek', 'the peek is still open');
  assert.equal(session.ui.popup.key, 'h:settle-r-119-1717', 'and now shows the session itself');
  assert.equal(session.peek.target.agent, 'settle-r-119-1717');
  await session.key('', { escape: true });

  session.ui = { ...session.ui, selectedKey: `q:${decision.id}` };
  await session.key('r', {});
  for (const ch of 'blocked please') await session.key(ch, {});
  await session.key('', { return: true });
  assert.match(session.ui.message, /stuck at a prompt and refused the message/);
  assert.equal(session.rows('list').some((r) => r.key === `q:${decision.id}`), true, 'a refused reply leaves the row in place');
  session.stop();
});

test('d sends a question to a new session with a plain brief, on the project\'s checkout, and notes it in org', async () => {
  const b = makeBoard();
  const row = b.waiting.find((r) => r.question === 'ARCH-67');
  const brief = workUpBrief(row);
  assert.match(brief, /^The operator wants this question worked out so they can decide it:\n\n {2}Should the packet stop carrying four fields\?/);
  assert.match(brief, /What was written about a yes: Two items use the smaller packet\.\nWhat was written about a no: The packet keeps its shape\./);
  assert.match(brief, /Do not decide it\./);
  assert.match(brief, /the operator answers here, in this session\.$/);
  const { name, args } = workUpArgs(row, { cwd: '/r/bch', org: '/r/.org' }, new Date(2026, 8, 17, 20, 55));
  assert.equal(name, 'ask-should-the-packet-stop-2055');
  assert.ok(name.length <= 32 && /^[a-z][a-z0-9_-]*$/.test(name), 'a name Herdr accepts');
  assert.deepEqual(args.slice(0, 11), ['start', '--json', '--cwd', '/r/bch', '--name', name, '--label', 'work out: Should the packet stop', '--add-dir', '/r', '--']);
  assert.equal(args.at(-1), brief);

  const started = [];
  const notes = [];
  const config = { projects: [{ name: 'bch', org: '/r/.org', cwd: '/r/bch', ledger_dir: null, claude_config_dirs: [] }], refresh_seconds: 60, brain_bin: '/x/brain.mjs' };
  const session = testSession({
    config,
    deps: {
      orgToday: async () => today, herdrAgents: async () => ({ ok: true, agents }), herdrTabs: async () => [], repoOf: () => null,
      brainQueue: async () => ({ rows: [] }),
      dispatch: async (project, r) => { started.push([project.cwd, r.question]); return { ok: true, name: 'ask-should-the-packet-stop-2055' }; },
      orgNote: async (project, id, text) => { notes.push([id, text]); return { ok: true }; },
    },
  });
  await session.refresh({ reorder: true });
  session.ui = { ...session.ui, selectedKey: 'q:ARCH-67' };
  await session.key('d', {});
  assert.deepEqual(started, [], 'nothing starts before the confirmation');
  await session.key('', { return: true });
  assert.deepEqual(started, [['/r/bch', 'ARCH-67']]);
  assert.deepEqual(notes, [['ARCH-67', 'The operator sent this to be worked out by session ask-should-the-packet-stop-2055.']]);
  assert.match(session.ui.message, /^Started ask-should-the-packet-stop-2055 to work it out\./);
  session.stop();
});

test('summoned as a Herdr popup, going to a session closes the console so the session is what shows', async () => {
  const config = { projects: [{ name: 'bch', org: '/r/.org', cwd: '/r/bch', ledger_dir: null, claude_config_dirs: [] }], refresh_seconds: 60, brain_bin: '/x/brain.mjs' };
  const deps = {
    orgToday: async () => today, herdrAgents: async () => ({ ok: true, agents }), herdrTabs: async () => [], repoOf: () => null,
    brainQueue: async () => ({ rows: [decision] }), herdrGo: async () => ({ ok: true }),
  };
  const popup = testSession({ config, deps, env: { HERDR_ACTIVE_PANE_ID: 'w1:p3' } });
  assert.equal(popup.popupMode, true);
  await popup.refresh({ reorder: true });
  popup.ui = { ...popup.ui, selectedKey: `q:${decision.id}` };
  assert.equal(await popup.key('g', {}), true, 'the console quits, which closes the popup');
  popup.stop();
  const pane = testSession({ config, deps, env: { HERDR_PANE_ID: 'w1:p9' } });
  assert.equal(pane.popupMode, false);
  await pane.refresh({ reorder: true });
  pane.ui = { ...pane.ui, selectedKey: `q:${decision.id}` };
  assert.equal(await pane.key('g', {}), false, 'in its own pane it stays open');
  assert.match(pane.ui.message, /Back here: Ctrl\+Alt\+B/);
  pane.stop();
});

test('rows read like the operator reads work: the id, a quoted gist, what is at stake, then actions', () => {
  const read = { ...decision, digest: { ...decision.digest, item: 'ENG-89', gist: 'note #7 must not make the same keys twice', explain: 'The protocol version is not in the recipe, so note #7 gives the same keys under both.' } };
  const lane = { ...report, id: 'lane-1', session: 'lane-anchor-005004', tab_label: 'agent:anchor', digest: { ...report.digest, gist: 'old replays now name version 1', explain: 'They cannot be re-pointed by the switch.' } };
  const withRun = { ...today, agent_runs: [{ run: 'R-134', item: 'ENG-85', agent: 'lane-anchor-005004' }] };
  const explanations = new Map([['HUM-8', {
    ok: true, gist: 'decide the licence before the repos open', explain: 'Five repositories open at release and none has a licence yet.',
    options: [{ key: '1', label: 'Adopt the recommended licences', causes: 'The release review can start.' }, { key: '2', label: 'Keep all five private for now', causes: 'Nothing opens.' }],
    recommend: '1', why: 'It is what the study recommended.',
  }]]);
  const b = buildBoard({ today: withRun, brain: { rows: [read, lane] }, herdr: { ok: true, agents }, explanations });
  const row = (key) => b.waiting.find((r) => r.key === key);
  assert.equal(row(`q:${read.id}`).headline, 'ENG-89 — “note #7 must not make the same keys twice”', 'the id the reading named');
  assert.equal(row('q:lane-1').headline, 'ENG-85 — “old replays now name version 1”', 'else the item of the run the session belongs to');
  const q = b.waiting.find((r) => r.question === 'HUM-8');
  assert.equal(q.headline, 'HUM-8 — “decide the licence before the repos open”');
  assert.equal(q.via, 'answer');
  assert.equal(q.recommendKey, '1');
  assert.equal(b.waiting.find((r) => r.question === 'ARCH-67').headline, 'ARCH-67 — Should the packet stop carrying four fields?', 'not read yet: its title');

  // A worked-out answer on an org question is recorded with org answer, after a confirmation.
  const press = keysOn(b, ['stages']);
  let r = press({ ...initialState(), selectedKey: 'q:HUM-8' }, '1');
  assert.equal(promptText(r.state), 'Record the answer “Adopt the recommended licences”? The next pass acts on it. Enter to confirm, Esc to cancel');
  assert.deepEqual(press(r.state, { return: true }).effects, [{ type: 'act', verb: 'pick', key: 'q:HUM-8', option: '1' }]);

  const v = {
    glyphs: 'nerd', version: '0.0.2', header: { project: 'bch', clock: '21:20', waiting: b.waitingCount }, board: visibleBoard(b, {}, []),
    scopeItems: scopeItems(b), state: { ...initialState(), selectedKey: `q:${read.id}` }, prompt: null, selectedRow: null, popupRow: null, project: {}, launch: {},
  };
  const t = renderFrame(v, 140, 40).lines.map(lineText);
  const at = t.findIndex((l) => l.includes('ENG-89 — “note #7'));
  assert.match(t[at + 1], /^ {7}The protocol version is not in the recipe, so note #7 gives the same keys under both\. +$/);
});

test('i records an instruction for the whole project where its sessions read direction first', async () => {
  const withGoal = { ...today, project: { ...today.project, top_goal: { id: 'G-1', title: 'Ship it' } } };
  const notes = [];
  let doc = withGoal;
  const config = { projects: [{ name: 'bch-cloak', org: '/r/.org', cwd: '/r/bch', ledger_dir: null, claude_config_dirs: [] }], refresh_seconds: 60, brain_bin: '/x/brain.mjs', explain: false };
  const session = testSession({
    config,
    deps: {
      orgToday: async () => doc, herdrAgents: async () => ({ ok: true, agents }), herdrTabs: async () => [], repoOf: () => null,
      brainQueue: async () => ({ rows: [] }), now: () => new Date(2026, 8, 17, 21, 14),
      orgNote: async (project, id, text, opts) => {
        notes.push([id, text, opts]);
        doc = { ...withGoal, decided: [{ kind: 'note', id, seq: 9, text, at: new Date(2026, 8, 17, 21, 14).toISOString(), by: 'human' }] };
        return { ok: true };
      },
    },
  });
  await session.refresh({ reorder: true });
  await session.key('i', {});
  assert.equal(promptText(session.ui).startsWith('Instruction to bch-cloak: ▏'), true);
  for (const ch of 'ok, please close the hole and pause work after it completes') await session.key(ch, {});
  await session.key('', { return: true });
  assert.deepEqual(notes, [['G-1', 'OPERATOR DIRECTION 2026-09-17 21:14: ok, please close the hole and pause work after it completes', { decision: true }]]);
  assert.match(session.ui.message, /^Recorded on the project's top goal \(G-1\)/);
  const screen = session.frame(140, 40).lines.map(lineText).join('\n');
  assert.match(screen, /Your instruction to the project, 21:14: “ok, please close the hole and pause work after it completes”/);
  session.stop();
});

test('the header says whether the loop is alive, and L turns it off or on after asking', async () => {
  assert.deepEqual(loopWords({ service: true, running: true, age: 3, every: 5 }), { text: 'loop ok', ok: true });
  assert.deepEqual(loopWords({ service: true, running: true, age: 600, every: 5 }), { text: 'loop stalled 10m', ok: false });
  assert.deepEqual(loopWords({ service: true, running: false }), { text: 'loop down', ok: false });
  assert.deepEqual(loopWords({ service: false, running: false }), { text: 'loop off', ok: false });
  assert.equal(loopWords(null), null, 'no brain configured: nothing to say');

  let loop = { service: true, running: true, age: 2, every: 5 };
  const calls = [];
  const config = { projects: [{ name: 'bch', org: '/r/.org', cwd: '/r/bch', ledger_dir: null, claude_config_dirs: [] }], refresh_seconds: 60, brain_bin: '/x/brain.mjs', explain: false };
  const session = testSession({
    config,
    deps: {
      orgToday: async () => today, herdrAgents: async () => ({ ok: true, agents }), herdrTabs: async () => [], repoOf: () => null,
      brainQueue: async () => ({ rows: [] }), loopStatus: async () => loop,
      setLoop: async (on) => { calls.push(on); loop = { service: on, running: on, age: on ? 1 : null, every: 5 }; return { ok: true, status: loop }; },
    },
  });
  await session.refresh({ reorder: true });
  assert.match(session.frame(140, 40).lines.map(lineText)[0], /loop ok/);
  await session.key('L', {});
  assert.match(promptText(session.ui), /^Turn the loop off\? Nothing new reaches Waiting on you until you turn it back on\./);
  assert.deepEqual(calls, [], 'nothing changes before Enter');
  await session.key('', { return: true });
  assert.deepEqual(calls, [false]);
  assert.match(session.frame(140, 40).lines.map(lineText)[0], /loop off/);
  await session.key('L', {});
  assert.match(promptText(session.ui), /^Turn the loop on\?/);
  await session.key('', { return: true });
  assert.deepEqual(calls, [false, true]);
  session.stop();
});
