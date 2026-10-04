import { inkTest as test, ink } from './optional-ink.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createMinimalSession } from '../modern/minimal-session.mjs';
import { lineText } from '../lib/frame.mjs';
const { tableCellWidth } = ink ? await import('../modern/table.mjs') : {};
import { actionableFixture, at } from './fixtures/actionable.mjs';
import { now } from './fixtures/actionable.mjs';

const output = session => session.frame(100, 30).lines.map(lineText).map(s => s.trimEnd()).join('\n') + '\n';
const click = async (session, id) => {
  const f = session.frame(100, 40), y = f.hits.findIndex(h => h?.some(hit => hit.id === id));
  assert.ok(y >= 0, `Visible hit for ${id}`);
  return session.mouse({ button: 'left', x: f.hits[y][0].from + 1, y });
};

test('landed, blocked and finished run rows open details; Esc and mouse Back restore selection and panel scroll', async t => {
  const f = actionableFixture(t), controllers = [];
  const session = createMinimalSession({ config: f.config, deps: { ...f.deps, controlTerminal: options => { controllers.push(options); } }, env: { NO_COLOR: '1' } });
  t.after(() => session.stop()); await session.refresh();
  for (const run of ['R-2', 'R-3', 'R-4']) {
    session.frame(100, 18); await session.activate(`run:${run}`); assert.equal(session.ui.view, 'detail');
    assert.match(output(session), new RegExp(`Run · ${run}`)); assert.equal(controllers.length, 0);
    await session.key('', { pageDown: true }); session.frame(100, 18);
    await session.key('', { escape: true }); assert.equal(session.ui.view, 'table'); assert.equal(session.ui.focus, `run:${run}`);
    const before = output(session), offsets = [...session.ui.panelOffsets];
    await session.activate(`run:${run}`); session.frame(100, 18); await session.mouse({ button: 'left', x: 1, y: 0 });
    assert.equal(output(session), before); assert.deepEqual(session.ui.panelOffsets, offsets);
  }
});

test('Tab changes panels and remembers each row; report opens with its review and nested Back retains detail scroll', async t => {
  const f = actionableFixture(t), session = createMinimalSession({ config: f.config, deps: f.deps, env: { NO_COLOR: '1' } });
  t.after(() => session.stop()); await session.refresh(); session.frame(100, 30);
  await session.key('', { downArrow: true }); session.frame(100, 30); assert.equal(session.ui.focus, 'run:R-2');
  await session.key('', { tab: true }); session.frame(100, 30); assert.match(session.ui.focus, /^report:/);
  await session.key('', { downArrow: true }); session.frame(100, 30); const reportFocus = session.ui.focus;
  await session.key('', { tab: true }); session.frame(100, 30); assert.equal(session.ui.focus, 'train:current');
  await session.key('', { tab: true }); session.frame(100, 30); assert.equal(session.ui.focus, 'run:R-2');
  await session.key('', { tab: true }); session.frame(100, 30); assert.equal(session.ui.focus, reportFocus);
  await session.key('', { return: true }); assert.equal(session.ui.view, 'detail'); assert.equal(session.ui.detail.kind, 'report');
  assert.match(session.ui.document.sections.find(s => s.id === 'review').content, /Verdict: PASS/);
  await session.key('', { escape: true }); session.frame(100, 30); assert.equal(session.ui.focus, reportFocus);
  await session.activate('run:R-2'); session.frame(100, 30);
  await session.key('', { tab: true }); session.frame(100, 30); assert.equal(session.ui.detailFocus, 'overview');
  await session.key('', { tab: true }); session.frame(100, 30); assert.equal(session.ui.detailFocus, 'report');
  const before = output(session), scroll = session.ui.detailScroll;
  await session.key('', { return: true }); assert.equal(session.ui.detail.kind, 'report'); session.frame(100, 30);
  await session.key('', { escape: true }); assert.equal(session.ui.detail.kind, 'run'); assert.equal(session.ui.detailScroll, scroll); assert.equal(output(session), before);
});

test('Shift reverses only Tab; shifted arrows and j/k keep their row direction', async t => {
  const f = actionableFixture(t);
  f.queue.pending.push({ id: 'second', topic: 'another-lane', run: 'R-4', queued: at(1) });
  fs.writeFileSync(f.queueFile, JSON.stringify(f.queue));
  const session = createMinimalSession({ config: f.config, deps: f.deps, env: { NO_COLOR: '1' } });
  t.after(() => session.stop()); await session.refresh(); session.frame(100, 30); await session.activate('run:R-2');
  session.frame(100, 18);
  await session.key('', { tab: true }); session.frame(100, 18);
  session.ui.detailFocus = null; session.ui.detailScroll = 0;
  for (const [input, key, scroll] of [
    ['', { downArrow: true, shift: true }, 1], ['j', { shift: true }, 2],
    ['', { upArrow: true, shift: true }, 1], ['k', { shift: true }, 0],
  ]) {
    await session.key(input, key); assert.equal(session.ui.detailScroll, scroll); session.frame(100, 18);
  }
  await session.key('', { tab: true }); session.frame(100, 30); assert.equal(session.ui.detailFocus, 'overview');
  await session.key('', { tab: true }); session.frame(100, 30); assert.equal(session.ui.detailFocus, 'report');
  await session.key('', { tab: true, shift: true }); session.frame(100, 30); assert.equal(session.ui.detailFocus, 'overview');
  // Exercise link focus as well as the text scrolling above.
  await session.activate('back'); session.frame(100, 30); await session.activate('train:waiting'); session.frame(100, 30);
  const first = session.ui.detailFocus;
  await session.key('', { downArrow: true, shift: true }); const second = session.ui.detailFocus;
  assert.notEqual(second, first);
  await session.key('k', { shift: true }); assert.equal(session.ui.detailFocus, first);
  await session.key('j', { shift: true }); assert.equal(session.ui.detailFocus, second);
  await session.key('', { upArrow: true, shift: true }); assert.equal(session.ui.detailFocus, first);
});

test('live train views work with and without clocks and follow their batch to a refusal without opening an agent', async t => {
  for (const telemetry of [true, false]) {
    const f = actionableFixture(t, { telemetry });
    const session = createMinimalSession({ config: f.config, deps: { ...f.deps, controlTerminal() { assert.fail('Train is read-only'); } }, env: { NO_COLOR: '1' } });
    t.after(() => session.stop()); await session.refresh(); await click(session, 'train:current');
    assert.match(output(session), telemetry ? /Elapsed: 2m 0s/ : /Elapsed: not recorded/);
    fs.appendFileSync(f.checkLog, 'last suite passed\n'); f.batch.phase = 'complete';
    f.batch.attempts[0].gate = { started_at: at(2), finished_at: at(1), duration_s: 60, exit_code: 0, log: f.checkLog };
    f.batch.results = { 'job-1': { outcome: 'refused', reason: 'main moved', gate: f.batch.attempts[0].gate } };
    fs.writeFileSync(f.batchFile, JSON.stringify(f.batch)); f.queue.current = null; fs.writeFileSync(f.queueFile, JSON.stringify(f.queue));
    await session.refresh(); assert.match(output(session), /refused · main moved/); assert.match(output(session), /last suite passed/);
    await session.mouse({ button: 'back' }); assert.equal(session.ui.focus, 'train:current');
    await click(session, 'train:result:landed'); assert.match(output(session), /green batch fast-forward/);
    await session.key('', { escape: true }); assert.equal(session.ui.focus, 'train:result:landed');
  }
});

test('detail source errors retain the last good document', async t => {
  const f = actionableFixture(t), session = createMinimalSession({ config: f.config, deps: f.deps, env: { NO_COLOR: '1' } });
  t.after(() => session.stop()); await session.refresh(); session.frame(100, 30); await session.activate('run:R-2');
  const before = output(session); await session.refresh(); assert.equal(output(session), before);
  fs.writeFileSync(`${f.org}/settle/R-2.json`, '{'); await session.refresh();
  assert.match(output(session), /source unavailable/); assert.match(output(session), /console opens durable evidence/);
  await session.key('', { escape: true }); assert.equal(session.ui.focus, 'run:R-2');
});

test('read-only details fit narrow and wide panes; arrows, wheel and section navigation keep links reachable', async t => {
  const f = actionableFixture(t), session = createMinimalSession({ config: f.config, deps: f.deps, env: { NO_COLOR: '1' } });
  t.after(() => session.stop()); await session.refresh(); session.frame(100, 30); await session.activate('run:R-2');
  for (const width of [20, 40, 60, 100, 140]) for (const height of [8, 18, 30]) {
    const frame = session.frame(width, height); assert.equal(frame.lines.length, height);
    assert.ok(frame.lines.every(line => tableCellWidth(lineText(line)) === width));
  }
  session.frame(100, 30); session.ui.detailFocus = null;
  await session.key('', { downArrow: true }); assert.equal(session.ui.detailScroll, 1);
  session.frame(100, 30); await session.mouse({ button: 'wheelDown' }); assert.equal(session.ui.detailScroll, 4);
  session.frame(100, 30); await session.key('', { tab: true }); session.frame(100, 30);
  await session.key('', { tab: true }); assert.equal(session.ui.detailFocus, 'report');
  await session.activate('back'); session.frame(100, 30); await session.activate('train:waiting'); session.frame(100, 30);
  assert.equal(session.ui.detailFocus, 'waiting'); await session.key('', { return: true }); assert.equal(session.ui.detail.kind, 'queued');
  session.frame(100, 30); await session.key('', { escape: true }); assert.equal(session.ui.detail.kind, 'waiting');
});

test('a report-only dashboard starts in Reports, and Context is keyboard reachable with safe session Back', async t => {
  const f = actionableFixture(t), supervisor = { name: 'supervisor-herdr', pane: 'w:p2', tab: 'w:t2', workspace: 'w', cwd: f.root, tool: 'claude', session: 'chat', status: 'idle' };
  const controllers = [], session = createMinimalSession({ config: f.config, deps: { ...f.deps, runs: () => ({ lanes: [] }),
    herdrAgents: async () => ({ ok: true, agents: [supervisor] }), controlTerminal(options) { const c = { ...options, input() { assert.fail('Esc reached the agent'); }, stop() {} }; controllers.push(c); return c; },
  }, env: { NO_COLOR: '1' } });
  t.after(() => session.stop()); await session.refresh(); session.frame(100, 30);
  assert.equal(session.ui.panel, 1); assert.match(session.ui.focus, /^report:/);
  await session.key('', { return: true }); assert.equal(session.ui.detail.kind, 'report'); await session.activate('back'); session.frame(100, 30);
  await session.key('', { tab: true }); session.frame(100, 30); await session.key('', { tab: true }); session.frame(100, 30);
  assert.equal(session.ui.focus, 'context'); await session.key('', { return: true }); session.frame(100, 30);
  assert.equal(session.ui.detailFocus, supervisor.pane); await session.key('', { return: true }); assert.equal(controllers[0].pane, supervisor.pane);
  await session.input(Buffer.from('\x1b')); assert.equal(session.ui.detail.kind, 'context'); session.frame(100, 30);
  await session.key('', { escape: true }); assert.equal(session.ui.focus, 'context');
});

test('live train output stays quiet when unchanged and updates its tail in place', async t => {
  const f = actionableFixture(t), session = createMinimalSession({ config: f.config, deps: f.deps, env: { NO_COLOR: '1' } });
  t.after(() => session.stop()); await session.refresh(); session.frame(100, 30); await session.activate('train:current');
  const writes = [], stdout = new Writable({ write(chunk, encoding, done) { writes.push(String(chunk)); done(); } });
  stdout.isTTY = true; stdout.columns = 100; stdout.rows = 31;
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => {};
  const instance = ink.render(session.tree(100, 30), { stdout, stdin, stderr: stdout, patchConsole: false, incrementalRendering: true, maxFps: 100, exitOnCtrlC: false });
  try {
    await delay(40); const before = writes.length;
    await session.refresh(); instance.rerender(session.tree(100, 30)); await delay(40); assert.equal(writes.length, before, JSON.stringify(writes.slice(before)));
    fs.appendFileSync(f.checkLog, 'new suite passed\n'); await session.refresh(); instance.rerender(session.tree(100, 30)); await delay(40);
    assert.match(writes.slice(before).join(''), /new suite passed/); assert.doesNotMatch(writes.slice(before).join(''), /Train · batch-1|Batch status/);
  } finally { instance.unmount(); instance.cleanup(); stdin.destroy(); stdout.destroy(); }
});

test('the current check clock advances between polls and a finished clock stays fixed', async t => {
  const f = actionableFixture(t); let clock = now;
  const session = createMinimalSession({ config: f.config, deps: { ...f.deps, now: () => clock }, env: { NO_COLOR: '1' } });
  t.after(() => session.stop()); await session.refresh(); session.frame(100, 30); await session.activate('train:current');
  assert.match(output(session), /Elapsed: 2m 0s/); clock += 5000; assert.match(output(session), /Elapsed: 2m 5s/);
  f.batch.attempts[0].gate = { ...f.batch.attempts[0].gate, duration_s: 60, finished_at: at(1), exit_code: 0 };
  fs.writeFileSync(f.batchFile, JSON.stringify(f.batch)); await session.refresh(); assert.match(output(session), /Elapsed: 1m 0s · finished/);
  clock += 5000; assert.match(output(session), /Elapsed: 1m 0s · finished/);
});

test('the real --print path opens run, report and train details and matches readable snapshots', t => {
  const f = actionableFixture(t), config = path.join(f.root, 'console.json'), record = path.join(f.root, 'record.mjs'), herdr = path.join(f.root, 'herdr'), clock = path.join(f.root, 'clock.mjs');
  fs.writeFileSync(config, JSON.stringify({ profile: 'minimal', projects: f.config.projects }));
  fs.writeFileSync(record, `console.log(${JSON.stringify(JSON.stringify(f.status))});`);
  fs.writeFileSync(herdr, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ result: { agents: [], workspaces: [], panes: [], tabs: [] } }));\n', { mode: 0o755 });
  fs.writeFileSync(clock, `Date.now = () => ${Date.parse(at(0))};`);
  const env = { ...process.env, HERDR_BIN_PATH: herdr, HERDR_ORG_BIN: record, ORG_FLEET_DIR: path.join(f.root, 'no-fleet'), TZ: 'UTC', NO_COLOR: '1' };
  for (const [name, keys] of [['run', '\\n'], ['report', '\\t\\n'], ['train', '\\t\\t\\n']]) {
    const r = spawnSync(process.execPath, ['--import', clock, 'console/app.mjs', '--config', config, '--project', 'Workshop', '--print', '100x30', '--select', name === 'run' ? '1' : '0', '--keys', keys], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const fixture = new URL(`./fixtures/${name}-detail-100x30.txt`, import.meta.url);
    if (process.env.UPDATE_CONSOLE_SNAPSHOTS === '1') fs.writeFileSync(fixture, r.stdout);
    assert.equal(r.stdout, fs.readFileSync(fixture, 'utf8')); assert.match(r.stdout, /‹ Back  Esc/);
    assert.match(r.stdout, name === 'run' ? /Run · R-2/ : name === 'report' ? /Report · R-/ : /Train · batch-1/);
  }
});
