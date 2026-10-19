import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from '../../test/helpers/retire-fixture.mjs';
import { spawnChild, spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { createRetirement } from '../../lib/retire-runtime.mjs';
import { matchingRun } from '../../lib/retire.mjs';
import { ownerIdentity, ownerAlive } from '../../lib/process-owner.mjs';
import { lookupProcess } from '../../lib/processes.mjs';
import { readLaneCwdReferences } from '../../lib/lane-removal.mjs';
import { configuredCommands, harnessEnvironment, awaitWatcherExit, abandonWatcher, promoteAndComplete, assertWorkerKept } from '../run.mjs';
import { scriptedProcesses, retireScriptedWorker } from '../retirement.mjs';
import { scratchProductHomes } from '../environment.mjs';
import { waitUntil } from '../load.mjs';

const source = path.resolve(import.meta.dirname, '../..');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function configuredFixture(t, { merged = true } = {}) {
  const f = fixture(t, { merged }), root = f.scratch, bin = path.join(root, 'bin');
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
  // Start with open work, just as dispatch does. Neither ingestion nor direct
  // lane promotion supplies the supervisor's later item.closed event.
  const events = f.eventBytes.trim().split('\n').map(JSON.parse)
    .filter(event => !['item.closed', 'report.ingested'].includes(event.type));
  events[1].meta.pane = 'w:p1'; delete events[1].meta.agent_session_id;
  const saveEvents = () => fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  saveEvents();
  const env = harnessEnvironment(process.env, root);
  env.PATH = `${bin}:${process.env.PATH}`; env.HERDR_RETIRE_HERDR = adapter;
  env.LANE_CONFIG = path.join(root, 'lane.json');
  fs.writeFileSync(env.LANE_CONFIG, JSON.stringify({ main: 'main', validate: 'true' }));
  const node = (file, args, { extra, ...options }) => {
    const result = spawnSync(process.execPath, [file, ...args], { ...options, env: { ...env, ...extra }, encoding: 'utf8' });
    if (options.ok !== false) assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  const commands = configuredCommands(node, source, f);
  const observe = (org = f.org) => createRetirement({ cwd: f.repo, org, herdr: adapter, env }).observe(f.lane);
  const job = { item: 'ENG-1', run: 'R-1', lane: 'topic', pane: 'w:p1', info: JSON.parse(commands.record(['show', 'R-1', '--json'])) };
  const ingest = (outcome = 'done') => {
    const report = path.join(root, 'report.md');
    fs.writeFileSync(report, `---\nrun: R-1\noutcome: ${outcome}\nsummary: Scripted acceptance round.\nheadline: The scripted round completed\nblockers: ${outcome === 'done' ? '[]' : '["Acceptance needs a decision"]'}\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
    commands.record(['check', report]); commands.record(['ingest', report, '--run', 'R-1']);
  };
  return { ...f, adapter, env, node, events, saveEvents, observe, job, ingest, retire: commands.retire, record: commands.record, runLane: commands.lane };
}

async function scriptedFixture(t) {
  const f = configuredFixture(t, { merged: false }), root = f.scratch;
  for (const file of ['worker.mjs', 'producers.mjs', 'environment.mjs'])
    fs.copyFileSync(path.join(source, 'acceptance', file), path.join(root, file));
  fs.copyFileSync(path.join(source, 'lib/deadline.mjs'), path.join(root, 'deadline.mjs'));
  // Only native lifecycle reporting is simulated. The actual worker, shell,
  // process reader, guarded retirement and cwd-removal guard run unchanged.
  fs.writeFileSync(path.join(root, 'herdr.mjs'), "console.log('{\"result\":{}}');\n");
  fs.writeFileSync(path.join(root, 'product-home-env.json'), JSON.stringify({ realHome: process.env.HOME,
    roots: [root], homes: scratchProductHomes(root) }));
  const executable = path.join(root, 'codex');
  fs.copyFileSync(process.execPath, executable, fs.constants.COPYFILE_FICLONE);
  const command = [executable, path.join(root, 'worker.mjs'), root, 'worker', 'worker'].map(quote).join(' ');
  const shell = spawnScenarioChild(t, '/bin/sh', ['-c', `${command}; sleep 0.3; while IFS= read -r line; do :; done`],
    { cwd: f.lane, env: { ...f.env, HERDR_PANE_ID: f.job.pane }, stdio: ['pipe', 'pipe', 'pipe'] });
  await waitUntil(() => fs.existsSync(path.join(root, 'script-panes', f.job.pane)), 'real scripted worker ready', 5000);
  const observed = lookupProcess(undefined, { identityOnly: true }); assert.equal(observed.ok, true, observed.error);
  const shellRow = observed.value.get(shell.pid);
  const worker = [...observed.value.values()].find(row => row.ppid === shell.pid && row.command === '[codex]');
  assert.ok(worker, 'actual copied Node worker is a child of the live shell');
  f.state.info = { shell_pid: shell.pid, foreground_processes: [{ pid: worker.pid, name: 'codex' }],
    process_tree_complete: true, process_tree: [shellRow, worker] };
  f.save();
  const h = (...args) => JSON.parse(f.node(path.join(source, 'acceptance/herdr.mjs'), args, {}).stdout).result;
  return { ...f, h, shell, worker };
}

test('configured retirement matches dispatch identity and completes open work after real ingestion and integration', t => {
  const f = configuredFixture(t, { merged: false });
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
  assertWorkerKept(f.job, { lane: f.runLane, reason: /report is not ingested/ });
  f.ingest();
  assert.equal(JSON.parse(f.record(['show', 'ENG-1', '--json'])).closed, null);
  assertWorkerKept(f.job, { lane: f.runLane, reason: /chain is still open/ });
  promoteAndComplete(f.job, { lane: f.runLane, record: f.record });
  assert.equal(f.git(['rev-parse', 'main']), f.head);
  assert.equal(JSON.parse(f.record(['show', 'ENG-1', '--json'])).closed.as, 'done');
  const output = f.runLane(['close', 'topic']);
  assert.match(output, /removed worktree/);
  assert.equal(fs.existsSync(f.lane), false);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t1'], ['workspace', 'close', 'w']]);
});

test('configured lane commands preserve retirement refusal for a changed terminal', t => {
  const f = configuredFixture(t);
  f.ingest(); promoteAndComplete(f.job, { lane: f.runLane, record: f.record });
  f.state.agents[0].terminal_id = 'replacement'; f.save();
  const output = f.runLane(['close', 'topic'], f.repo, { ok: false });
  assert.match(output, /mismatched recorded launch identity/);
  assert.ok(fs.existsSync(f.lane)); assert.deepEqual(f.read().actions, []);
});

test('a refused integration leaves reported work open', t => {
  const f = configuredFixture(t, { merged: false }); f.ingest();
  fs.writeFileSync(path.join(f.lane, 'dirty'), 'uncommitted work');
  assert.throws(() => promoteAndComplete(f.job, { lane: f.runLane, record: f.record }), /not clean/);
  assert.notEqual(f.git(['rev-parse', 'main']), f.head);
  assert.equal(JSON.parse(f.record(['show', 'ENG-1', '--json'])).closed, null);
  assert.deepEqual(f.read().actions, []);
});

test('ingested scripted work keeps its watcher reference until the recorded process actually exits', async t => {
  const f = configuredFixture(t), release = path.join(f.scratch, 'release-watcher');
  const watcher = spawnChild(t, process.execPath, ['--input-type=module', '-e',
    `import fs from 'node:fs';setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},25);`]);
  const owner = { pid: watcher.pid, identity: ownerIdentity(watcher.pid) };
  Object.assign(f.events[1].meta, { watcher_pid: owner.pid, watcher_identity: owner.identity }); f.saveEvents();
  f.ingest(); promoteAndComplete(f.job, { lane: f.runLane, record: f.record });
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

for (const mode of ['missing', 'invalid', 'blocked']) test(`${mode} work stays open and actual lane close keeps its unreported worker after abandonment`, async t => {
  const f = configuredFixture(t), log = path.join(f.scratch, 'watch.log');
  if (mode === 'invalid') fs.writeFileSync(path.join(f.scratch, 'report.md'), '---\nrun: R-1\noutcome: banana\n---\n');
  f.state.agents[0].agent_status = mode === 'blocked' ? 'blocked' : 'idle'; f.save();
  const watcher = spawnChild(t, process.execPath, ['--input-type=module', '-e',
    `import fs from 'node:fs';setInterval(()=>{if(fs.readFileSync(${JSON.stringify(f.eventFile)},'utf8').includes('run.abandoned')){fs.writeFileSync(${JSON.stringify(log)},'R-1 was abandoned; stopping');process.exit(0)}},25);`]);
  const owner = { pid: watcher.pid, identity: ownerIdentity(watcher.pid), log };
  Object.assign(f.events[1].meta, { watcher_pid: owner.pid, watcher_identity: owner.identity }); f.saveEvents();
  await abandonWatcher({ ...f.job, watcher: owner }, {
    record: f.record,
    h: (...args) => { f.state.agents[0].agent_status = args[args.indexOf('--state') + 1]; f.save(); },
    read: file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '',
    until: (predicate, label, ms = 5000) => waitUntil(predicate, label, ms),
  });
  assert.equal((await waitForExit(watcher)).code, 0);
  assert.equal(ownerAlive(owner), false);
  const run = JSON.parse(f.record(['show', 'R-1', '--json']));
  assert.ok(run.abandoned); assert.equal(run.report, null);
  assert.equal(JSON.parse(f.record(['show', 'ENG-1', '--json'])).closed, null);
  assertWorkerKept(f.job, { lane: f.runLane, reason: /R-1 report is not ingested/ });
  assert.deepEqual(f.read().actions, []);
});

for (const outcome of ['blocked', 'needs_human']) test(`actual lane close keeps an unresolved ${outcome} report for scratch cleanup`, t => {
  const f = configuredFixture(t); f.ingest(outcome);
  assertWorkerKept(f.job, { lane: f.runLane, reason: /R-1 awaits correction or disposition/ });
  assert.equal(JSON.parse(f.record(['show', 'ENG-1', '--json'])).closed, null);
  assert.deepEqual(f.read().actions, []);
});

test('scripted retirement closes the recorded tab and waits for its real shell and worker before lane removal', async t => {
  const f = await scriptedFixture(t);
  f.ingest(); promoteAndComplete(f.job, { lane: f.runLane, record: f.record });
  const before = readLaneCwdReferences(f.lane, { env: f.env });
  for (const pid of [f.shell.pid, f.worker.pid]) assert.ok(before.some(ref => ref.job === String(pid)));
  assert.match(f.runLane(['close', 'topic'], f.repo, { ok: false }), /process cwd reference/);
  assert.deepEqual(f.read().actions, [], 'lane preflight does not dispose of its live occupants');
  let waited = false;
  const receipt = await retireScriptedWorker(f.job, { h: f.h,
    retire: job => {
      const result = f.retire(job); // Actual scoped product apply and native close receipt.
      f.shell.stdin.end(); // Native PTY hangup is asynchronous after that receipt.
      return result;
    },
    until: (predicate, label, ms) => {
      assert.equal(predicate(), false, 'tab closure has not yet drained its PTY processes'); waited = true;
      return waitUntil(predicate, label, ms);
    },
  });
  assert.equal(waited, true);
  assert.deepEqual(receipt.processes.map(row => row.pid).sort((a, b) => a - b), [f.shell.pid, f.worker.pid].sort((a, b) => a - b));
  assert.equal((await waitForExit(f.shell)).code, 0);
  for (const process of receipt.processes) assert.equal(ownerAlive(process), false);
  assert.deepEqual(readLaneCwdReferences(f.lane, { env: f.env }), []);
  assert.match(f.runLane(['close', 'topic']), /removed worktree/);
  assert.equal(fs.existsSync(f.lane), false);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t1'], ['workspace', 'close', 'w']]);
});

test('scripted retirement preserves open work and the real stand-in obeys the native exit command', async t => {
  const f = await scriptedFixture(t);
  await assert.rejects(retireScriptedWorker(f.job, { h: f.h, retire: f.retire,
    until: () => assert.fail('a refused retirement cannot await process disposal') }), /did not close its worker/);
  assert.deepEqual(f.read().actions, []); assert.equal(ownerAlive(f.worker), true);
  const processes = scriptedProcesses(f.job, { h: f.h });
  assert.ok(processes.some(row => row.pid === f.shell.pid)); assert.ok(processes.some(row => row.pid === f.worker.pid));
  f.shell.stdin.write('/exit\n');
  await waitUntil(() => !ownerAlive(f.worker), 'native exit command ends stand-in', 5000);
  assert.equal(ownerAlive(processes.find(row => row.pid === f.shell.pid)), true, 'exiting the worker alone leaves its shell');
  assert.ok(fs.readFileSync(path.join(f.scratch, 'worker-input.jsonl'), 'utf8').includes('"line":"/exit"'));
  f.shell.stdin.end(); assert.equal((await waitForExit(f.shell)).code, 0);
});
