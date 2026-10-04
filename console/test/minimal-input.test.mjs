import { inkTest as test } from './optional-ink.mjs';
import assert from 'node:assert/strict';
import { createMinimalSession } from '../modern/minimal-session.mjs';
import { lineText } from '../lib/frame.mjs';

function fixture({ preview = false } = {}) {
  let live = [
    { name: 'one', pane: 'w:p1', tab: 't', workspace: 'w', cwd: '/repo/lane', tool: 'codex', status: 'working', session: 's1' },
    { name: 'two', pane: 'w:p2', tab: 't', workspace: 'w', cwd: '/repo/lane2', tool: 'claude', status: 'working', session: 's2' },
  ];
  const controllers = [], calls = [], now = Date.parse('2026-10-04T17:00:00Z');
  const recordRuns = live.map((a, i) => ({ id: `R-${i + 1}`, item: `ENG-${i + 1}`, started: { at: new Date(now - 600000).toISOString() },
    meta: { agent: a.name, agent_session_id: a.session }, report: i === 1 ? { at: new Date(now).toISOString(), outcome: 'done' } : null }));
  const session = createMinimalSession({ config: { projects: [{ name: 'Repo', cwd: '/repo', org: '/org' }] }, env: { NO_COLOR: '1' }, deps: {
    identity: cwd => ({ key: cwd.startsWith('/repo') ? '/repo/.git' : '/other/.git', git: true, root: '/repo' }), now: () => now,
    details: () => ({}), journal: () => [], train: () => ({ waiting: [{ id: 'j2', run: 'R-2', topic: 'second' }], results: [] }),
    herdrAgents: async () => { calls.push('agents'); return { ok: true, agents: live }; }, herdrList: async () => [],
    orgStatus: async () => ({ runs: recordRuns }), allowSessionInput: !preview,
    runs: () => ({ lanes: recordRuns.map((r, i) => ({ run: r.id, item: r.item, lane: i ? 'second' : 'first', title: 'Console',
      agent: i ? 'two' : 'one', pane: i ? 'w:p2' : 'w:p1', stage: 'engineering', provider: 'codex', running_seconds: 600 })) }),
    controlTerminal(options) {
      const c = { ...options, inputs: [], sizes: [], stopped: false, input(bytes) { this.inputs.push(Buffer.from(bytes)); },
        resize(cols, rows) { this.sizes.push([cols, rows]); }, stop() { this.stopped = true; } };
      controllers.push(c); return c;
    },
  } });
  return { session, controllers, calls, setLive(value) { live = value; }, get live() { return live; } };
}
const screen = () => ({ width: 30, height: 2, cursor: { x: 2, y: 1, visible: true }, lines: [
  { spans: [{ text: 'AGENT SCREEN'.padEnd(30), fg: 'terminalFg', bg: 'terminalBg' }] },
  { spans: [{ text: '> '.padEnd(30), fg: 'terminalFg', bg: 'terminalBg' }] },
] });

test('Enter opens the selected row, Esc returns without pane input, and Back preserves selection', async () => {
  const { session, controllers } = fixture();
  try {
    await session.refresh(); session.frame(80, 24); await session.key('', { downArrow: true }); session.frame(80, 24);
    assert.equal(session.ui.focus, 'run:R-2'); await session.key('', { return: true });
    const c = controllers[0]; assert.equal(c.pane, 'w:p2'); assert.equal(session.ui.interactive, true);
    c.onFrame(screen()); const frame = session.frame(80, 24), output = frame.lines.map(lineText).join('\n');
    assert.match(output, /^‹ Back  Esc/); assert.match(output, /AGENT SCREEN/); assert.match(output, /Ctrl\+\\ interrupt \(Esc\)/);
    assert.deepEqual(c.sizes.at(-1) ?? [c.cols, c.rows], [80, 22]);
    await session.input(Buffer.from('\x1b')); assert.equal(session.ui.view, 'table'); assert.equal(c.inputs.length, 0); assert.equal(c.stopped, true);
    assert.equal(session.ui.focus, 'run:R-2'); session.frame(80, 24); await session.key('', { return: true });
    await session.key('', { escape: true }); assert.equal(controllers[1].inputs.length, 0); assert.equal(session.ui.focus, 'run:R-2');
    session.frame(80, 24); await session.key('', { return: true }); session.frame(80, 24);
    await session.mouse({ button: 'left', x: 2, y: 0 }); assert.equal(controllers[2].stopped, true); assert.equal(session.ui.focus, 'run:R-2');
  } finally { session.stop(); }
});

test('interrupt key sends Esc, ordinary typing and arrows retain bytes, mouse is never sent', async () => {
  const { session, controllers } = fixture();
  try {
    await session.refresh(); session.frame(40, 24); await session.key('', { return: true });
    const c = controllers[0];
    await session.input(Buffer.from('\x1c')); assert.deepEqual(c.inputs, [Buffer.from('\x1b')]); assert.equal(session.ui.view, 'output');
    await session.key('\\', { ctrl: true }); assert.deepEqual(c.inputs.at(-1), Buffer.from('\x1b'));
    await session.input(Buffer.from('hello 会話\r\x1b[A\x1b[<0;3;3M')); assert.deepEqual(c.inputs.at(-1), Buffer.from('hello 会話\r\x1b[A'));
    assert.equal(await session.key('q'), false); assert.equal(session.ui.view, 'output');
    await session.input('\x1d'); assert.equal(session.ui.view, 'table'); assert.equal(c.stopped, true);
  } finally { session.stop(); }
});

test('click targets survive compact rows; reports and train open details without controlling an agent', async () => {
  for (const width of [40, 100]) {
    const { session, controllers } = fixture();
    try {
      await session.refresh(); let frame = session.frame(width, 40);
      for (const id of ['run:R-2', 'report:report:R-2', 'train:waiting']) {
        const y = frame.hits.findIndex(h => h?.some(hit => hit.id === id));
        assert.ok(y >= 0, id); const hit = frame.hits[y].find(h => h.id === id);
        const before = controllers.length;
        await session.mouse({ button: 'left', x: hit.from + 1, y });
        assert.equal(session.ui.view, id === 'run:R-2' ? 'output' : 'detail');
        assert.equal(controllers.length, before + Number(id === 'run:R-2'));
        await session.activate('back'); assert.equal(session.ui.focus, id);
        frame = session.frame(width, 40);
      }
    } finally { session.stop(); }
  }
});

test('reused panes, foreign repositories, source failure and stale callbacks cannot take over input', async () => {
  const f = fixture(), { session, controllers } = f;
  try {
    await session.refresh(); session.frame(80, 24);
    const original = f.live;
    f.setLive([{ ...original[0], session: 'replacement' }]);
    await session.key('', { return: true }); assert.equal(controllers.length, 0); assert.equal(session.ui.view, 'table');
    f.setLive([{ ...original[0], cwd: '/other' }]); await session.key('', { return: true }); assert.equal(controllers.length, 0);
    f.setLive(original); await session.key('', { return: true }); const c = controllers[0];
    f.setLive([{ ...original[0], session: 'replacement' }]); await session.refresh(); assert.equal(c.stopped, true); assert.equal(session.ui.interactive, false);
    c.onFrame(screen()); assert.equal(session.ui.terminalFrame, null); await session.input('hidden input'); assert.equal(c.inputs.length, 0);
    await session.key('', { escape: true }); f.setLive(original); await session.refresh(); session.frame(80, 24);
    await session.key('', { return: true }); const next = controllers[1]; session.stop(); next.onFrame(screen()); assert.equal(session.ui.terminalFrame, null);
  } finally { session.stop(); }
});

test('snapshot activation never opens a control stream', async () => {
  const { session, controllers } = fixture({ preview: true });
  try { await session.refresh(); session.frame(80, 24); await session.key('', { return: true }); assert.equal(controllers.length, 0); assert.equal(session.ui.view, 'table'); }
  finally { session.stop(); }
});

test('Esc encoded by extended keyboard protocols returns without interrupting the pane', async () => {
  const { session, controllers } = fixture();
  try {
    await session.refresh();
    for (const escape of ['\x1b', '\x1b[27u', '\x1b[27;1u', '\x1b[27;1:1u', '\x1b[27;1;27~']) {
      session.frame(80, 24); await session.key('', { return: true });
      const c = controllers.at(-1); await session.input(Buffer.from(escape));
      assert.equal(session.ui.view, 'table'); assert.equal(c.inputs.length, 0); assert.equal(c.stopped, true);
    }
    session.frame(80, 24); await session.key('', { return: true });
    await session.input('\x1b[92;5u'); assert.deepEqual(controllers.at(-1).inputs, [Buffer.from('\x1b')]); assert.equal(session.ui.view, 'output');
  } finally { session.stop(); }
});

test('Meta keys retain every byte and the session opens at its full viewport width immediately', async () => {
  const { session, controllers } = fixture();
  try {
    await session.refresh(); session.frame(180, 40); await session.key('', { return: true });
    const c = controllers[0]; assert.deepEqual([c.cols, c.rows], [180, 38]); assert.deepEqual(c.sizes, []);
    for (const input of ['\x1b\r', '\x1bb', '\x1bf', '\x1b\x7f', '\x1bq', '\x1b会話', '\x1b[']) {
      await session.input(Buffer.from(input)); assert.deepEqual(c.inputs.at(-1), Buffer.from(input)); assert.equal(session.ui.view, 'output');
    }
    await session.input(Buffer.from('\x1b')); assert.equal(session.ui.view, 'table');
    assert.ok(c.inputs.every(input => !input.equals(Buffer.from('\x1b'))));
  } finally { session.stop(); }
});
