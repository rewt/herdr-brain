import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from '../../test/helpers/retire-fixture.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { createRetirement } from '../../lib/retire-runtime.mjs';
import { matchingRun } from '../../lib/retire.mjs';
import { ownerIdentity, ownerAlive } from '../../lib/process-owner.mjs';
import { configuredCommands, harnessEnvironment, awaitWatcherExit } from '../run.mjs';
import { waitUntil } from '../load.mjs';

const source = path.resolve(import.meta.dirname, '../..');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function configuredFixture(t) {
  const f = fixture(t), root = f.scratch, bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const adapter = path.join(bin, 'herdr');
  fs.writeFileSync(adapter, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(source, 'acceptance/herdr.mjs'))} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ binary: f.env.HERDR_RETIRE_HERDR,
    workspaces: ['w'], tabs: ['w:t1'], panes: ['w:p1'] }));
  // The real scripted launch has a terminal receipt but no native session yet,
  // and runs in the reused first pane under a private Node copy named codex.
  Object.assign(f.state.tabs[0], { tab_id: 'w:t1' });
  Object.assign(f.state.panes[0], { pane_id: 'w:p1', tab_id: 'w:t1', terminal_id: 'term', foreground_cwd: f.lane });
  Object.assign(f.state.agents[0], { agent: 'codex', pane_id: 'w:p1', tab_id: 'w:t1' });
  delete f.state.agents[0].agent_session;
  f.state.info = { shell_pid: 1, foreground_processes: [{ pid: 2, name: 'codex' }], process_tree_complete: true,
    process_tree: [{ pid: 1, identity: 'shell', state: 'S', command: '[zsh]' },
      { pid: 2, ppid: 1, identity: 'worker', state: 'S', command: '[codex]' }] };
  f.save();
  const events = f.eventBytes.trim().split('\n').map(JSON.parse);
  events[1].meta.pane = 'w:p1'; delete events[1].meta.agent_session_id;
  const saveEvents = () => fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  saveEvents();
  const env = harnessEnvironment(process.env, root);
  env.PATH = `${bin}:${process.env.PATH}`; env.HERDR_RETIRE_HERDR = adapter;
  const node = (file, args, { extra, ...options }) => {
    const result = spawnSync(process.execPath, [file, ...args], { ...options, env: { ...env, ...extra }, encoding: 'utf8' });
    if (options.ok !== false) assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  const commands = configuredCommands(node, source, f);
  const observe = (org = f.org) => createRetirement({ cwd: f.repo, org, herdr: adapter, env }).observe(f.lane);
  return { ...f, adapter, env, node, events, saveEvents, observe, record: commands.record, runLane: commands.lane };
}

test('configured retirement matches the scoped adapter identity only in the dispatch record', t => {
  const f = configuredFixture(t);
  const observed = JSON.parse(f.node(path.join(source, 'acceptance/herdr.mjs'), ['agent', 'list'], {}).stdout).result.agents[0];
  const run = JSON.parse(f.record(['show', 'R-1', '--json']));
  assert.equal(matchingRun(observed, { runs: [run] })?.id, 'R-1');
  for (const field of ['name', 'pane_id', 'workspace_id', 'cwd', 'terminal_id'])
    assert.equal(matchingRun({ ...observed, [field]: 'replacement' }, { runs: [run] }), null, field);
  const wrongRecord = f.observe(null).record;
  assert.equal(wrongRecord.runs.length, 0, 'without ORG_DIR the external configured record is undiscoverable');
  assert.equal(matchingRun(observed, wrongRecord), null);
  const snapshot = f.observe();
  assert.equal(matchingRun(snapshot.agents[0], snapshot.record)?.id, 'R-1');
  const output = f.runLane(['close', 'topic']);
  assert.match(output, /removed worktree/);
  assert.equal(fs.existsSync(f.lane), false);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t1'], ['workspace', 'close', 'w']]);
});

test('configured lane commands preserve retirement refusal for a changed terminal', t => {
  const f = configuredFixture(t);
  f.state.agents[0].terminal_id = 'replacement'; f.save();
  const output = f.runLane(['close', 'topic'], f.repo, { ok: false });
  assert.match(output, /mismatched recorded launch identity/);
  assert.ok(fs.existsSync(f.lane)); assert.deepEqual(f.read().actions, []);
});

test('ingested scripted work keeps its watcher reference until the recorded process actually exits', async t => {
  const f = configuredFixture(t), release = path.join(f.scratch, 'release-watcher');
  const watcher = spawnChild(t, process.execPath, ['--input-type=module', '-e',
    `import fs from 'node:fs';setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},25);`]);
  const owner = { pid: watcher.pid, identity: ownerIdentity(watcher.pid) };
  Object.assign(f.events[1].meta, { watcher_pid: owner.pid, watcher_identity: owner.identity }); f.saveEvents();
  assert.equal(ownerAlive(owner), true);
  const output = f.runLane(['close', 'topic'], f.repo, { ok: false });
  assert.match(output, /watcher callback reference R-1/);
  assert.ok(fs.existsSync(f.lane)); assert.deepEqual(f.read().actions, []);
  let polls = 0;
  await awaitWatcherExit({ run: 'R-1', watcher: owner }, { until: (predicate, label, ms) => waitUntil(() => {
    if (++polls === 1) {
      assert.equal(predicate(), false, 'ingestion does not prove watcher exit');
      fs.writeFileSync(release, 'delivery confirmed');
      return false;
    }
    return predicate();
  }, label, ms) });
  assert.ok(polls > 1); assert.equal((await waitForExit(watcher)).code, 0);
  assert.equal(ownerAlive(owner), false);
  assert.match(f.runLane(['close', 'topic']), /removed worktree/);
  assert.equal(fs.existsSync(f.lane), false);
});
