import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { createReceiptTracker } from '../../test/helpers/receipts.mjs';
import { ownerAlive } from '../../lib/process-owner.mjs';
import { matchingRun } from '../../lib/retire.mjs';
import { harnessEnvironment, initializeHerdrOwnership, configuredCommands, promoteAndComplete, assertWorkerKept } from '../run.mjs';
import { createLiveSessionTemp } from '../temp.mjs';
import { testSlotEnvironment, scratchProductHomes } from '../environment.mjs';
import { waitUntil } from '../load.mjs';

const source = path.resolve(import.meta.dirname, '../..');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Only the native UI is simulated. Entry, record, lane, dispatch, watch and the
// scoped adapter are the release harness's actual code, without model calls.
async function offlineNative(root, repo) {
  const fs = await import('node:fs'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const args = process.argv.slice(2), [group, verb, target] = args;
  const file = path.join(root, 'native-state.json');
  const state = JSON.parse(fs.readFileSync(file));
  const option = name => args[args.indexOf(name) + 1];
  fs.appendFileSync(path.join(root, 'native-calls.jsonl'), JSON.stringify(args) + '\n');
  let result = {};
  const pane = id => id === 'supervisor:p1'
    ? { pane_id: id, workspace_id: 'supervisor', foreground_cwd: repo }
    : { ...state.pane, foreground_cwd: state.movedCwd ?? state.workspace?.cwd };
  const agent = id => id === 'offline-supervisor' || id === 'supervisor:p1'
    ? { name: 'offline-supervisor', pane_id: 'supervisor:p1', workspace_id: 'supervisor', cwd: repo, agent_status: 'idle' }
    : state.agent;
  if (group === 'workspace' && verb === 'list') result = { workspaces: state.workspace ? [state.workspace] : [] };
  else if (group === 'worktree' && verb === 'list') result = { source: { repo_key: path.join(repo, '.git'), repo_root: repo, source_checkout_path: repo }, worktrees: state.workspace
    ? [{ path: state.workspace.cwd, open_workspace_id: state.workspace.workspace_id, branch: 'lane/default-cycle', repo_root: repo }]
    : [] };
  else if (group === 'worktree' && verb === 'open') {
    const cwd = option('--path');
    state.workspace = { workspace_id: 'worker', cwd, label: option('--label'),
      worktree: { checkout_path: cwd, repo_root: repo, repo_key: path.join(repo, '.git'), is_linked_worktree: true } };
    state.tab = { tab_id: 'worker:t1', workspace_id: 'worker' };
    state.pane = { pane_id: 'worker:p1', workspace_id: 'worker', tab_id: 'worker:t1' };
    result = { already_open: false, workspace: state.workspace, tab: state.tab, root_pane: state.pane };
  } else if (group === 'pane' && verb === 'list') result = { panes: state.pane ? [state.pane] : [] };
  else if (group === 'tab' && verb === 'list') result = { tabs: state.tab ? [state.tab] : [] };
  else if (group === 'pane' && verb === 'get') result = { pane: pane(target) };
  else if (group === 'pane' && verb === 'process-info') result = { process_info: state.retirement
    ? { shell_pid: 1, foreground_processes: [{ pid: 2, name: 'codex' }], process_tree_complete: true,
      process_tree: [{ pid: 1, identity: 'shell', state: 'S', command: '[sh]' },
        { pid: 2, ppid: 1, identity: 'worker', state: 'S', command: '[codex]' }] }
    : { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'sh' }] } };
  else if (group === 'pane' && verb === 'run') {
    if (args[3].startsWith(' . ')) {
      // The scoped adapter already verified this exact private source/verify
      // pair. Execute it in a scratch shell to publish its readiness nonce.
      const prepared = spawnSync('/bin/sh', ['-c', args[3]], { cwd: state.workspace.cwd, encoding: 'utf8' });
      if (prepared.status !== 0) throw Error(prepared.stderr);
      state.output = prepared.stdout;
    } else state.agent = { name: 'stand-in', pane_id: target, workspace_id: 'worker', cwd: state.workspace.cwd,
      agent_status: 'idle', terminal_id: 'offline-terminal', agent_session: { value: 'offline-session' } };
  } else if (group === 'pane' && verb === 'read') {
    process.stdout.write(state.output ?? ''); return;
  } else if (group === 'agent' && verb === 'get') {
    const found = agent(target);
    if (!found) { console.error('agent_not_found'); process.exitCode = 1; return; }
    result = { agent: found };
  } else if (group === 'agent' && verb === 'list') result = { agents: state.agent ? [state.agent] : [] };
  else if (group === 'agent' && verb === 'rename') { state.agent.name = args[3]; result = { agent: state.agent }; }
  else if (group === 'agent' && verb === 'prompt') state.agent.agent_status = 'working';
  else if (group === 'agent' && verb === 'wait') await new Promise(resolve => setTimeout(resolve, 100));
  else if (group === 'tab' && verb === 'close') { delete state.tab; delete state.pane; delete state.agent; }
  else if (group === 'workspace' && verb === 'close') delete state.workspace;
  else if (!((group === 'pane' && verb === 'report-agent') || (group === 'tab' && verb === 'rename') ||
    (group === 'agent' && ['read', 'send-keys'].includes(verb)))) throw Error(`unexpected offline native call: ${args.join(' ')}`);
  if ((group === 'worktree' && verb === 'open') || (group === 'pane' && verb === 'run') ||
    (['tab', 'workspace'].includes(group) && verb === 'close') ||
    (group === 'agent' && ['rename', 'prompt'].includes(verb))) fs.writeFileSync(file, JSON.stringify(state));
  console.log(JSON.stringify({ result }));
}

test('real default-cycle dispatch admits owned fleet paths, refuses foreign roots and completes open work before retirement', async t => {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/ac-')), roots = [root], cleanup = [];
  const receipts = createReceiptTracker({ suitePid: Number(process.env.HERDR_TEST_SUITE_PID) || process.pid });
  let supervisor;
  const repo = path.join(root, 'default-cycle'), org = path.join(repo, '.org');
  t.after(async () => {
    if (supervisor) { supervisor.kill('SIGTERM'); await waitForExit(supervisor); }
    // A failed assertion can precede the supervisor's final dispatch receipt;
    // recover watcher ownership from the real durable dispatch journal too.
    const journals = path.join(org, 'dispatch');
    for (const name of fs.existsSync(journals) ? fs.readdirSync(journals) : []) {
      if (!name.endsWith('.json') || name.endsWith('.routes.json')) continue;
      const job = JSON.parse(fs.readFileSync(path.join(journals, name)));
      if (job.watcher?.pid) receipts.remember(job.watcher.pid, [process.execPath, path.join(source, 'watch/watch.mjs'), job.run,
        '--org', org, '--to', job.to, '--cwd', repo, '--log', job.watcher.log].join(' '));
    }
    receipts.cleanup();
    for (const directory of roots.reverse()) fs.rmSync(directory, { recursive: true, force: true });
  });
  const fleetRoot = createLiveSessionTemp(roots, cleanup);
  const env = harnessEnvironment(process.env, root);
  env.HERDR_MONITOR_FLEET = path.join(fleetRoot, 'f');
  const bin = path.join(root, 'bin');
  for (const directory of [repo, bin, env.HOME, path.join(root, 'evidence')]) fs.mkdirSync(directory, { recursive: true });
  const native = path.join(root, 'native-herdr.mjs');
  fs.writeFileSync(native, `#!${process.execPath}\n(${offlineNative.toString()})(${JSON.stringify(root)}, ${JSON.stringify(repo)});\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'native-state.json'), '{}');
  initializeHerdrOwnership(root, { binary: native, fleetRoot });
  // Give only the supervisor its preexisting pane receipt; worker targets must
  // be granted by actual worktree-open receipts through the scoped adapter.
  const ledger = path.join(root, 'ownership.json'), owned = JSON.parse(fs.readFileSync(ledger));
  owned.workspaces.push('supervisor'); owned.panes.push('supervisor:p1');
  fs.writeFileSync(ledger, JSON.stringify(owned));
  fs.copyFileSync(path.join(source, 'lib/deadline.mjs'), path.join(root, 'deadline.mjs'));
  for (const name of ['worker.mjs', 'herdr.mjs', 'receipts.mjs', 'producers.mjs', 'environment.mjs', 'poll.mjs'])
    fs.copyFileSync(path.join(source, 'acceptance', name), path.join(root, name));
  fs.symlinkSync(source, path.join(root, 'candidate'));
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'herdr.mjs'))} "$@"\n`, { mode: 0o755 });
  for (const name of ['codex', 'claude']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'test-slot-env.json'), JSON.stringify(testSlotEnvironment(process.env)));
  fs.writeFileSync(path.join(root, 'product-home-env.json'), JSON.stringify({ realHome: process.env.HOME, roots,
    homes: Object.fromEntries(Object.keys(scratchProductHomes(root)).map(key => [key, env[key]])) }));
  env.PATH = `${bin}:${process.env.PATH}`;
  const command = (binary, args) => spawnSync(binary, args, { cwd: repo, env, encoding: 'utf8' });
  const git = args => { const r = command('git', args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Acceptance']); git(['config', 'user.email', 'acceptance@example.invalid']);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node --test' } }));
  git(['add', '.']); git(['commit', '-qm', 'Ordinary project validation']);
  const ask = path.join(root, 'ask.md'); fs.writeFileSync(ask, 'Commit one scratch file and report.\n');
  fs.writeFileSync(path.join(root, 'default-supervisor-task.json'), JSON.stringify({ repo, home: env.HOME, binary: path.join(bin, 'codex'), ask }));
  supervisor = spawnScenarioChild(t, process.execPath, [path.join(root, 'worker.mjs'), root, 'supervisor', 'offline-supervisor'], {
    cwd: repo, env: { ...env, HERDR_PANE_ID: 'supervisor:p1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const until = predicate => waitUntil(predicate, 'offline default cycle receipt', 25_000);
  await until(() => fs.existsSync(path.join(root, 'script-panes/supervisor:p1')));
  supervisor.stdin.write('acceptance-default-cycle\n');
  const receipt = path.join(root, 'default-supervisor-job.json');
  await until(() => fs.existsSync(receipt));
  const saved = JSON.parse(fs.readFileSync(receipt));
  const deniedFile = path.join(root, 'denied.jsonl');
  assert.equal(saved.error, undefined, [saved.error, fs.existsSync(deniedFile) ? fs.readFileSync(deniedFile, 'utf8') : ''].join('\n'));
  const fleet = JSON.parse(fs.readFileSync(path.join(env.HERDR_MONITOR_FLEET, 'fleet.json')));
  const project = Object.values(fleet.projects)[0];
  assert.equal(project.checkout, repo);
  assert.ok(saved.info.workspace.startsWith(project.worktrees + path.sep));
  assert.ok(project.worktrees.startsWith(fleetRoot + path.sep));
  assert.ok(!saved.info.workspace.startsWith(root + path.sep), 'case 23 must use the separately owned general fleet');
  assert.ok(fs.existsSync(path.join(saved.info.workspace, '.git')));
  for (const name of ['.lane.json', 'AGENTS.md', '.housekeeping.json']) assert.ok(!fs.existsSync(path.join(repo, name)), name);
  const calls = () => fs.readFileSync(path.join(root, 'native-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const opened = calls().filter(args => args[0] === 'worktree' && args[1] === 'open');
  assert.equal(opened.length, 1);
  assert.equal(opened[0][opened[0].indexOf('--path') + 1], saved.info.workspace);
  assert.ok(opened[0].includes('--no-focus'));
  assert.ok(calls().some(args => args[0] === 'pane' && args[1] === 'run' && args[3].startsWith(' . ')), 'live fleet cwd admits the private environment handoff');
  assert.ok(calls().some(args => args[0] === 'pane' && args[1] === 'run' && args[3].includes('worker.mjs')), 'agent start passes its live fleet cwd check');
  assert.ok(calls().some(args => args[0] === 'agent' && args[1] === 'prompt'), 'real dispatch reaches brief delivery');
  const listed = command(process.execPath, [path.join(root, 'herdr.mjs'), 'agent', 'list']);
  assert.equal(listed.status, 0, listed.stderr);
  const observed = JSON.parse(listed.stdout).result.agents.find(agent => agent.name === saved.job.agent);
  assert.equal(matchingRun(observed, { runs: [saved.info] })?.id, saved.job.run,
    'the actual adapter listing matches the identity recorded by default dispatch');

  // Stop receipt-owned producers before changing the fake pane's cwd for the
  // foreign-root probes; their lifecycle reads are allowed native UI calls.
  assert.ok(receipts.remember(saved.job.watcher.pid, [process.execPath, path.join(source, 'watch/watch.mjs'), saved.job.run,
    '--org', org, '--to', 'offline-supervisor', '--cwd', repo, '--log', saved.job.watcher.log].join(' ')));
  supervisor.kill('SIGTERM');
  assert.equal((await waitForExit(supervisor)).code, 0);
  receipts.cleanup();
  await until(() => !ownerAlive(saved.job.watcher));

  const guard = args => command(process.execPath, [path.join(root, 'herdr.mjs'), ...args]);
  const foreign = fs.realpathSync(fs.mkdtempSync('/tmp/af-')); roots.push(foreign);
  const alias = path.join(fleetRoot, 'foreign-alias'); fs.symlinkSync(foreign, alias);
  for (const args of [
    ['worktree', 'open', '--cwd', repo, '--path', path.join(foreign, 'lane')],
    ['worktree', 'open', '--cwd', foreign, '--path', saved.info.workspace],
    ['worktree', 'open', '--cwd', repo, '--path', path.join(alias, 'lane')],
    ['workspace', 'close', 'foreign-workspace'],
  ]) {
    const denied = guard(args);
    assert.notEqual(denied.status, 0); assert.match(denied.stderr, /acceptance_product_boundary/);
    // The adapter may append creation options; unrelated lifecycle reads can
    // still finish during teardown, so assert the refused operation is absent.
    assert.ok(!calls().some(call => args.every((arg, index) => call[index] === arg)),
      `foreign creation/cwd/identity never reaches native UI: ${JSON.stringify(args)}`);
  }
  const stateFile = path.join(root, 'native-state.json'), state = JSON.parse(fs.readFileSync(stateFile));
  state.movedCwd = foreign; fs.writeFileSync(stateFile, JSON.stringify(state));
  const denied = guard(['agent', 'send-keys', saved.job.agent, 'Enter']);
  assert.notEqual(denied.status, 0); assert.match(denied.stderr, /pane cwd left scratch/);
  assert.ok(!calls().some(args => args[0] === 'agent' && args[1] === 'send-keys'));

  // Continue the same real dispatch through ingestion, direct integration and
  // supervisor completion. The record lives at the discovered default path.
  delete state.movedCwd; state.retirement = true;
  Object.assign(state.agent, { agent: 'codex', agent_status: 'idle' });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const node = (file, args, { extra, ...options }) => {
    const result = spawnSync(process.execPath, [file, ...args], { ...options, env: { ...env, ...extra }, encoding: 'utf8' });
    if (options.ok !== false) assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  const commands = configuredCommands(node, source, { repo, org });
  const job = { ...saved.job, info: saved.info };
  assertWorkerKept(job, { lane: commands.lane, reason: /report is not ingested/ });
  fs.writeFileSync(path.join(saved.info.workspace, 'work.txt'), 'scripted default work\n');
  git(['-C', saved.info.workspace, 'add', 'work.txt']); git(['-C', saved.info.workspace, 'commit', '-qm', 'Scripted default work']);
  fs.writeFileSync(saved.info.report_path, `---\nrun: ${job.run}\noutcome: done\nsummary: Scripted default work.\nheadline: The scripted work completed\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  commands.record(['check', saved.info.report_path]); commands.record(['ingest', saved.info.report_path, '--run', job.run]);
  assertWorkerKept(job, { lane: commands.lane, reason: /chain is still open/ });
  commands.lane(['check'], saved.info.workspace);
  promoteAndComplete(job, commands);
  assert.equal(JSON.parse(commands.record(['show', job.item, '--json'])).closed.as, 'done');
  assert.equal(git(['rev-parse', 'main']), git(['-C', saved.info.workspace, 'rev-parse', 'HEAD']));
  assert.match(commands.lane(['close', job.lane]), /removed worktree/);
  assert.equal(fs.existsSync(saved.info.workspace), false);
  assert.ok(calls().some(args => args[0] === 'tab' && args[1] === 'close' && args[2] === 'worker:t1'));
  assert.ok(calls().some(args => args[0] === 'workspace' && args[1] === 'close' && args[2] === 'worker'));
});
