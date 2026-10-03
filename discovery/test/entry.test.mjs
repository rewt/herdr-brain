import { loadTimeout } from '../../lib/deadline.mjs';
import test from '../../test/helpers/bounded-test.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createEntry, command } from '../runtime.mjs';
import { findOrgDir, initOrg, loadEvents } from '../../lib/store.mjs';
import { loadDiscoveredRoutes, resolveLaunchRoute } from '../../lanes/routes.mjs';
import { entryPolicy } from '../policy.mjs';
import { assertSupervisorEntry } from '../../acceptance/entry.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
const root = new URL('../../', import.meta.url).pathname;
const fixture = (t) => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-entry-test-'));
  fixtureFleet(t, scratch);
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const repo = path.join(scratch, 'unrelated'); fs.mkdirSync(repo);
  command('git', ['init', '-q', '-b', 'main'], repo);
  command('git', ['config', 'user.name', 'Discovery test'], repo);
  command('git', ['config', 'user.email', 'test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'Unrelated project\n');
  command('git', ['add', '.'], repo); command('git', ['commit', '-qm', 'Seed project'], repo);
  return { scratch, repo, options: { cwd: repo, runtimeDir: path.join(scratch, 'runtime'), worktreeRoot: path.join(scratch, 'worktrees') } };
};
const rec = (repo, args) => command(process.execPath, [path.join(root, 'bin/org.mjs'), ...args], repo, { ORG_DIR: path.join(repo, '.org'), ORG_ACTOR: 'human' });
test('installed supervisor entry in an untouched project satisfies the release cold-start and notice contract offline', { timeout: 15000 }, (t) => {
  const f = fixture(t), receipt = path.join(f.scratch, 'native-called');
  const native = path.join(f.scratch, 'fake-native');
  fs.writeFileSync(native, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(receipt)}, 'unexpected launch');\n`, { mode: 0o755 });
  for (const name of ['.org', '.lane.json', 'AGENTS.md']) assert.ok(!fs.existsSync(path.join(f.repo, name)));
  const entry = spawnSync(process.execPath, [path.join(root, 'discovery/adapters/codex.mjs'),
    '--repo', f.repo, '--binary', native, '--role', 'supervisor', '--policy-only',
    '--runtime-dir', f.options.runtimeDir, '--worktree-root', f.options.worktreeRoot],
  { cwd: f.repo, env: { ...process.env, ORG_ACTOR: 'supervisor-entry-contract-test' }, encoding: 'utf8', timeout: loadTimeout(10000) });
  assert.equal(entry.status, 0, entry.stderr || entry.error?.message);
  assertSupervisorEntry(entry.stdout);
  assert.ok(fs.existsSync(path.join(f.repo, '.org/events.jsonl')), 'entry bootstrapped its record');
  assert.ok(!fs.existsSync(receipt), 'policy-only entry never launches a native model');
  assert.throws(() => assertSupervisorEntry(entry.stdout.slice(0, entry.stdout.indexOf('Cold start (no model, no pane mutations):'))), /AssertionError/, 'protocol without generated context is insufficient');
  assert.throws(() => assertSupervisorEntry(entry.stdout.replace("handle --notice 'THE COMPLETE NOTICE' --role supervisor", 'inspect report manually')), /AssertionError/, 'cold start without the final-notice handler is insufficient');
});

test('unrelated project has one canonical record, a real pending question and two separate lanes', (t) => {
  const f = fixture(t);
  const a = createEntry(f.options), b = createEntry(f.options);
  t.after(a.close); t.after(b.close);
  assert.notEqual(a.context().workspace, b.context().workspace);
  assert.equal(findOrgDir({ cwd: a.context().workspace, env: {} }), path.join(f.repo, '.org'));
  const state = JSON.parse(rec(f.repo, ['status', '--json']));
  assert.equal(state.items.filter((i) => i.role === 'human').length, 1);
  assert.equal(state.items.find((i) => i.role === 'human').closed, null);
  const task = a.dispatch({ op: 'start', text: 'Actual work' });
  assert.equal(a.dispatch({ op: 'start', text: 'Same task retry' }).run, task.run);
  assert.match(task.branch, /^lane\//u);
  assert.throws(() => a.dispatch({ op: 'apply-routes' }), /operator answer/u);
  rec(f.repo, ['answer', a.context().routing.question, 'yes']);
  const result = a.dispatch({ op: 'apply-routes' });
  const config = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.equal(config.routes.engineer.model, 'gpt-6.1-sol');
  assert.equal(config.routes.review.model, 'opus');
  assert.ok(!fs.existsSync(path.join(f.repo, '.lane.json')), 'operator config belongs to the worker lane until promotion');
  assert.equal(command('git', ['status', '--porcelain'], f.repo), '');
  assert.match(entryPolicy(a.context(), root), /Never start project housekeeping/u);
  assert.throws(() => createEntry({ ...f.options, cwd: task.workspace, role: 'supervisor' }), /canonical/u);
});
test('capability refuses arbitrary operations, fields, changed identity and missing validation sandbox', (t) => {
  const f = fixture(t), entry = createEntry(f.options); t.after(entry.close);
  assert.throws(() => entry.dispatch({ op: 'shell', text: 'true' }), /unknown operation/u);
  assert.throws(() => entry.dispatch({ op: 'context', cwd: f.repo }), /unknown request fields/u);
  entry.dispatch({ op: 'start', text: 'A task' });
  assert.throws(() => entry.dispatch({ op: 'check' }), /native validation sandbox/u);
  const gitFile = path.join(entry.context().workspace, '.git');
  const before = fs.readFileSync(gitFile);
  fs.writeFileSync(gitFile, 'gitdir: /missing\n');
  assert.throws(() => entry.dispatch({ op: 'commit', text: 'Unsafe' }));
  fs.writeFileSync(gitFile, before);
  assert.throws(() => createEntry({ ...f.options, worktreeRoot: path.join(f.repo, '.lane/inside') }), /outside existing Git checkouts/u);
  command('git', ['config', 'filter.unsafe.smudge', 'must-not-execute'], f.repo);
  fs.writeFileSync(path.join(f.repo, '.gitattributes'), 'README.md filter=unsafe\n');
  assert.throws(() => createEntry(f.options), /external Git filters/u);
});
test('concurrent automatic record bootstrap never truncates events or duplicates records', async (t) => {
  const f = fixture(t);
  const processes = Array.from({ length: 6 }, (_, i) => {
    const child = spawnChild(t, process.execPath, [path.join(root, 'bin/org.mjs'), 'add', `Task ${i}`], {
      cwd: f.repo, env: { ...process.env, ORG_DIR: '', ORG_ACTOR: `test-${i}` }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    return waitForExit(child).then(({ code, stderr }) => assert.equal(code, 0, stderr));
  });
  await Promise.all(processes);
  assert.equal(loadEvents(path.join(f.repo, '.org')).events.filter((e) => e.type === 'item.added').length, 6);
  assert.equal(command('git', ['status', '--porcelain'], f.repo), '');
  const loaded = loadDiscoveredRoutes({ cwd: f.repo });
  assert.equal(loaded.suggested, true);
  assert.equal(resolveLaunchRoute(loaded.config).model, 'gpt-6.1-sol');
});
test('initialization preserves a populated record, and a supervisor has no worker Git capability', (t) => {
  const f = fixture(t); initOrg(path.join(f.repo, '.org'));
  rec(f.repo, ['add', 'Keep me']);
  const before = fs.readFileSync(path.join(f.repo, '.org/events.jsonl'), 'utf8');
  initOrg(path.join(f.repo, '.org'));
  assert.equal(fs.readFileSync(path.join(f.repo, '.org/events.jsonl'), 'utf8'), before);
  const configFile = path.join(f.repo, '.org/config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.approvals.categories.other = 'auto';
  fs.writeFileSync(configFile, JSON.stringify(config));
  const entry = createEntry({ ...f.options, role: 'supervisor' }); t.after(entry.close);
  assert.equal(JSON.parse(rec(f.repo, ['show', entry.context().routing.question, '--json'])).closed, null, '--wait overrides auto without editing operator configuration');
  assert.throws(() => entry.dispatch({ op: 'commit', text: 'no' }), /worker Git capabilities/u);
  assert.match(entryPolicy(entry.context(), root), /Only a supervisor/u);
});
test('machine installer retains native flags, reaches Claude too and restores only its own files', (t) => {
  const f = fixture(t), bin = path.join(f.scratch, 'bin');
  const fake = path.join(f.scratch, 'fake-native');
  const receipt = path.join(f.scratch, 'native-receipt.json');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.env.TEST_NATIVE_RECEIPT, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),org:process.env.ORG_DIR}));\n`, { mode: 0o755 });
  const installer = path.join(root, 'discovery/install.mjs');
  command(process.execPath, [installer, '--bin', bin, '--codex', fake, '--claude', fake], f.repo);
  const extra = { TEST_NATIVE_RECEIPT: receipt, MONITOR_RUNTIME_DIR: path.join(f.scratch, 'runtime'), MONITOR_WORKTREE_ROOT: path.join(f.scratch, 'lanes') };
  command(path.join(bin, 'monitor-codex'), ['--', 'exec', '--model', 'literal-model', '-c', 'model_reasoning_effort=low', 'Literal task'], f.repo, extra);
  let got = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(got.args[got.args.indexOf('--model') + 1], 'literal-model');
  assert.ok(got.args.includes('model_reasoning_effort=low'));
  assert.ok(got.args.some((a) => a.startsWith('developer_instructions=')));
  assert.notEqual(got.cwd, f.repo);
  command(path.join(bin, 'monitor-claude'), ['--', '--model', 'literal-claude', '--effort', 'high', 'Literal task'], f.repo, extra);
  got = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(got.args[got.args.indexOf('--model') + 1], 'literal-claude');
  assert.ok(got.args.includes('--append-system-prompt'));
  command(path.join(bin, 'codex'), ['--version'], f.repo, extra);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')).args, ['--version']);
  fs.writeFileSync(path.join(bin, 'untouched'), 'operator file');
  command(process.execPath, [installer, '--bin', bin, '--remove'], f.repo);
  assert.equal(fs.readFileSync(path.join(bin, 'untouched'), 'utf8'), 'operator file');
  fs.writeFileSync(path.join(bin, 'codex'), 'operator executable');
  assert.throws(() => command(process.execPath, [installer, '--bin', bin, '--codex', fake], f.repo), /unmanaged/u);
});
