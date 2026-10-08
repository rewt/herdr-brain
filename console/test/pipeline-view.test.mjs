import { inkTest as test, ink } from './optional-ink.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMinimalSession } from '../modern/minimal-session.mjs';
import { lineText } from '../lib/frame.mjs';
import { pipelineFixture } from './fixtures/pipelines.mjs';
import { now, at } from './fixtures/actionable.mjs';
const { tableCellWidth } = ink ? await import('../modern/table.mjs') : {};
const output = (session, cols = 116, rows = 40) => session.frame(cols, rows).lines.map(lineText).map(l => l.trimEnd()).join('\n');

test('every batch link opens its evidence by Enter or click, with nested Back and no agent input', async t => {
  const f = pipelineFixture(t), session = createMinimalSession({ config: f.config, deps: { ...f.deps,
    controlTerminal() { assert.fail('Pipeline navigation must be read-only'); } }, env: { NO_COLOR: '1' } });
  t.after(() => session.stop()); await session.refresh(); session.frame(116, 40); await session.activate('train:current');
  assert.match(output(session), /\u2713 Queued.*\u2192.*\u2713 Rebase.*\u2192.*\u25cf CI.*\u2192.*\u25cb Fast-forward/);
  assert.equal(session.ui.detailFocus, 'batch:queued');
  for (const stage of ['queued', 'rebase', 'ci', 'fast-forward', 'close', 'notify']) {
    const before = output(session), frame = session.frame(116, 40);
    const y = frame.hits.findIndex(row => row?.some(h => h.id === `batch:${stage}`));
    assert.ok(y >= 0, `Visible ${stage}`);
    const hit = frame.hits[y].find(h => h.id === `batch:${stage}`);
    await session.mouse({ button: 'left', x: hit.from + 1, y });
    assert.equal(session.ui.detail.kind, 'batch-link'); assert.equal(session.ui.detail.stage, stage);
    output(session); await session.key('', { escape: true });
    assert.equal(session.ui.detail.kind, 'batch'); assert.equal(session.ui.detailFocus, `batch:${stage}`);
    assert.equal(session.ui.detailScroll, 0);
    assert.match(output(session), /Train batch/); assert.equal(output(session).split('\n').length, before.split('\n').length);
  }
  session.ui.detailFocus = 'batch:queued'; session.frame(116, 40);
  await session.key('', { rightArrow: true }); session.frame(116, 40);
  await session.key('', { rightArrow: true }); session.frame(116, 40);
  assert.equal(session.ui.detailFocus, 'batch:ci'); await session.key('', { return: true });
  assert.equal(session.ui.detail.stage, 'ci'); session.frame(116, 40);
  await session.activate('back'); session.frame(116, 40); await session.activate('back');
  assert.equal(session.ui.view, 'table'); assert.equal(session.ui.focus, 'train:current');
});

test('active run pipelines are available through p and a stage click, without taking over the live session', async t => {
  const chats = [];
  const f = pipelineFixture(t), session = createMinimalSession({ config: f.config, deps: { ...f.deps,
    herdrProjectChat: async project => { chats.push(project); return { ok: true }; },
    controlTerminal() { assert.fail('Opening the stage must not open an agent'); } }, env: { NO_COLOR: '1' } });
  t.after(() => session.stop()); await session.refresh();
  for (const cols of [20, 31, 32, 40, 59, 60, 100, 140]) {
    session.frame(cols, 40); assert.equal(session.ui.focus, 'run:R-1');
    await session.key('C'); assert.equal(chats.at(-1).repoKey, f.project.repoKey);
    assert.equal(session.ui.view, 'table');
    const chatCount = chats.length;
    await session.key('p'); assert.equal(session.ui.detail.run, 'R-1');
    assert.equal(session.ui.view, 'detail'); assert.equal(chats.length, chatCount);
    await session.activate('back');
  }
  assert.equal(chats.length, 8); session.frame(100, 40);
  assert.equal(session.ui.focus, 'run:R-1'); await session.key('p');
  assert.equal(session.ui.detail.run, 'R-1'); assert.match(output(session), /\u25cf Engineering/);
  session.frame(116, 40); await session.activate('run:R-1:engineering');
  assert.equal(session.ui.detail.kind, 'run-link'); assert.match(output(session), /Brief/);
  await session.activate('back'); session.frame(100, 40); await session.activate('back');
  assert.equal(session.ui.focus, 'run:R-1'); assert.equal(session.ui.selections[0], 'run:R-1'); const frame = session.frame(100, 40);
  const y = frame.hits.findIndex(row => row?.some(h => h.id === 'pipeline:R-1'));
  const hit = frame.hits[y].find(h => h.id === 'pipeline:R-1');
  await session.mouse({ button: 'left', x: hit.from + 1, y }); assert.equal(session.ui.detail.kind, 'run');
  assert.equal(session.ui.detail.run, 'R-1'); await session.activate('back'); assert.equal(session.ui.focus, 'run:R-1');
});

test('chains use horizontal bands on wide panes and vertical links on narrow panes, with reachable repeated fixes', async t => {
  const f = pipelineFixture(t, 'multi'), session = createMinimalSession({ config: f.config, deps: f.deps, env: { NO_COLOR: '1' } });
  t.after(() => session.stop()); await session.refresh(); session.frame(116, 40); await session.activate('run:R-2');
  const wide = output(session); assert.match(wide, /\u2192/); assert.match(wide, /Fix 1 \u00b7 R-3/); assert.match(wide, /Fix 2 \u00b7 R-4/);
  const narrow = output(session, 60, 40); assert.doesNotMatch(narrow.split('\n').slice(0, -1).join('\n'), /\u2192/); assert.match(narrow, /\u2502/);
  for (const cols of [20, 40, 60, 100, 116, 140]) for (const rows of [8, 18, 40]) {
    const frame = session.frame(cols, rows);
    assert.equal(frame.lines.length, rows); assert.ok(frame.lines.every(l => tableCellWidth(lineText(l)) === cols));
  }
  session.ui.detailFocus = 'run:R-2:dispatch'; session.ui.detailScroll = 0;
  for (let i = 0; i < 7; i++) { session.frame(40, 12); await session.key('', { rightArrow: true }); }
  assert.equal(session.ui.detailFocus, 'run:R-4:engineering'); assert.ok(session.ui.detailScroll > 0);
  session.frame(40, 12); await session.key('', { return: true }); assert.equal(session.ui.detail.run, 'R-4');
  session.frame(40, 12); await session.key('', { escape: true }); assert.equal(session.ui.detailFocus, 'run:R-4:engineering');
});

test('running CI tails only the temporary log explicitly owned by this batch, then freezes on interruption', async t => {
  const f = pipelineFixture(t), directory = path.join(f.project.repoKey, 'lane-validation'), key = 'a'.repeat(64);
  delete f.batch.attempts[0].gate.log; fs.writeFileSync(f.batchFile, JSON.stringify(f.batch));
  const lock = path.join(directory, `${key}.lock`); fs.mkdirSync(lock, { recursive: true });
  const log = path.join(directory, `.${key}.uuid.log`);
  fs.writeFileSync(log, 'current test is running\n');
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ argv: ['node', 'lane.mjs', 'promote-batch', f.batchFile] }));
  let clock = now;
  const session = createMinimalSession({ config: f.config, deps: { ...f.deps, now: () => clock }, env: { NO_COLOR: '1' } });
  t.after(() => session.stop()); await session.refresh(); session.frame(116, 40); await session.activate('train:current');
  session.frame(116, 40); await session.activate('batch:ci'); assert.match(output(session), /current test is running/);
  assert.match(output(session), /Elapsed: 2m 0s/); clock += 5000; assert.match(output(session), /Elapsed: 2m 5s/);
  fs.appendFileSync(log, 'next test is running\n'); await session.refresh(); assert.match(output(session), /next test is running/);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ argv: ['node', 'lane.mjs', 'promote-batch', '/foreign/train.json'] }));
  await session.refresh(); assert.doesNotMatch(output(session), /current test is running/);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ argv: ['node', 'lane.mjs', 'promote-batch', f.batchFile] }));
  fs.writeFileSync(path.join(directory, `.${key}.orphan.log`), 'unrelated old output\n'); await session.refresh();
  assert.doesNotMatch(output(session), /unrelated old output|current test is running/);
  f.queue.current = null; f.queue.interrupted = [{ id: f.batch.id, jobs: f.batch.jobs }];
  f.queue.results.push({ id: 'job-1', batch: f.batch.id, outcome: 'interrupted' });
  fs.writeFileSync(f.queueFile, JSON.stringify(f.queue)); await session.refresh(); clock += 5000;
  assert.match(output(session), /\u00d7 failed/); assert.match(output(session), /Elapsed: unknown/);
});

test('real --print snapshots cover running, red, refused, interrupted and repeated-fix chains at two widths', t => {
  for (const [state, cols, rows, keys, select] of [
    ['running', 116, 30, '\\t\\t\\n', '0'], ['running', 60, 40, '\\t\\t\\n', '0'],
    ['failed', 116, 30, '\\t\\tjj\\n', '0'], ['refused', 116, 30, '\\t\\tjj\\n', '0'],
    ['interrupted', 116, 30, '\\t\\tjj\\n', '0'], ['multi', 116, 30, '\\n', '1'], ['multi', 60, 40, '\\n', '1'],
  ]) {
    const f = pipelineFixture(t, state), config = path.join(f.root, 'console.json'), record = path.join(f.root, 'record.mjs'), herdr = path.join(f.root, 'herdr'), clock = path.join(f.root, 'clock.mjs');
    if (['failed', 'refused', 'interrupted'].includes(state)) {
      fs.rmSync(path.join(f.project.repoKey, 'promote/batches/old-batch'), { recursive: true });
      f.queue.results = f.queue.results.filter(r => r.id === 'job-1'); f.queue.pending = [];
      fs.writeFileSync(f.queueFile, JSON.stringify(f.queue));
    }
    fs.writeFileSync(config, JSON.stringify({ profile: 'minimal', projects: f.config.projects }));
    fs.writeFileSync(record, `console.log(${JSON.stringify(JSON.stringify(f.status))});`);
    fs.writeFileSync(herdr, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ result: { agents: [], workspaces: [], panes: [], tabs: [] } }));\n', { mode: 0o755 });
    fs.writeFileSync(clock, `Date.now = () => ${now};`);
    const result = spawnSync(process.execPath, ['--import', clock, 'console/app.mjs', '--config', config, '--project', 'Workshop', '--print', `${cols}x${rows}`, '--select', select, '--keys', keys],
      { encoding: 'utf8', env: { ...process.env, HERDR_BIN_PATH: herdr, HERDR_ORG_BIN: record, ORG_FLEET_DIR: path.join(f.root, 'no-fleet'), TZ: 'UTC', NO_COLOR: '1' } });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Train batch|Run lifecycle/);
    if (state === 'failed' || state === 'interrupted') assert.match(result.stdout, /\u00d7 CI/);
    if (state === 'refused') assert.match(result.stdout, /\u00d7 Fast-forward/);
    if (state === 'multi') assert.match(result.stdout, /Fix 2 \u00b7 R-4/);
    const fixture = new URL(`./fixtures/pipeline-${state}-${cols}x${rows}.txt`, import.meta.url);
    if (process.env.UPDATE_CONSOLE_SNAPSHOTS === '1') fs.writeFileSync(fixture, result.stdout);
    assert.equal(result.stdout, fs.readFileSync(fixture, 'utf8'));
  }
});
