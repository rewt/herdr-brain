import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createEntry, command } from '../runtime.mjs';
import { entryPolicy } from '../policy.mjs';
import { runPTY, PTY_SKIP_REASON } from '../../test/helpers/pty.mjs';
import { loadDiscoveredRoutes, resolveLaunchRoute } from '../../lanes/routes.mjs';

const product = new URL('../../', import.meta.url).pathname;
function fixture(t, config = {}) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-settings-test-'));
  const entries = [];
  t.after(() => { for (const entry of entries) entry.close(); fs.rmSync(scratch, { recursive: true, force: true }); });
  const repo = path.join(scratch, 'project'); fs.mkdirSync(repo);
  command('git', ['init', '-q', '-b', 'trunk'], repo);
  command('git', ['config', 'user.name', 'Entry settings test'], repo);
  command('git', ['config', 'user.email', 'test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, '.lane.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'Use the project review desk before integration.\n');
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'Report test evidence in the project ledger.\n');
  command('git', ['add', '-f', '.lane.json', 'AGENTS.md', 'CLAUDE.md'], repo); command('git', ['commit', '-qm', 'Seed project settings'], repo);
  const options = { cwd: repo, runtimeDir: path.join(scratch, 'runtime'), worktreeRoot: path.join(scratch, 'lanes') };
  const open = (overrides = {}) => { const entry = createEntry({ ...options, ...overrides }); if (entry) entries.push(entry); return entry; };
  return { scratch, repo, options, open };
}
function install(f) {
  const bin = path.join(f.scratch, 'bin'), native = path.join(f.scratch, 'native'), receipt = path.join(f.scratch, 'native.json'), guard = path.join(f.scratch, 'guard.json');
  fs.writeFileSync(native, `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2);
if(args[0]==='sandbox'){
  fs.writeFileSync(process.env.NATIVE_GUARD_RECEIPT,JSON.stringify(args));
  const split=args.indexOf('--'),child=require('child_process').spawnSync(args[split+1],args.slice(split+2),{stdio:'inherit'});
  process.exit(child.status??1);
}
fs.writeFileSync(process.env.NATIVE_RECEIPT,JSON.stringify({args,cwd:process.cwd(),org:process.env.ORG_DIR,requests:process.env.MONITOR_REQUEST_DIR}));`, { mode: 0o755 });
  command(process.execPath, [path.join(product, 'discovery/install.mjs'), '--bin', bin, '--codex', native, '--claude', native], f.repo);
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, NATIVE_RECEIPT: receipt, NATIVE_GUARD_RECEIPT: guard,
    ORG_DIR: path.join(f.scratch, 'foreign-record'), MONITOR_ENTRY_BYPASS: '', MONITOR_REQUEST_DIR: '',
    HERDR_ENV: '', HERDR_PANE_ID: '', HERDR_INTEGRATION_ID: '',
    MONITOR_RUNTIME_DIR: f.options.runtimeDir, MONITOR_WORKTREE_ROOT: f.options.worktreeRoot };
  return { bin, receipt, guard, env };
}
function tree(directory) {
  return fs.readdirSync(directory).sort().flatMap((name) => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    return stat.isDirectory() ? [[name, 'directory'], ...tree(file).map(([sub, value]) => [`${name}/${sub}`, value])]
      : [[name, { mode: stat.mode, bytes: fs.readFileSync(file).toString('base64') }]];
  });
}
function policy(receipt, kind) {
  return kind === 'codex' ? JSON.parse(receipt.args.find((arg) => arg.startsWith('developer_instructions=')).slice('developer_instructions='.length))
    : receipt.args[receipt.args.indexOf('--append-system-prompt') + 1];
}

test('explicit installed adapters leave opted-out projects and native arguments untouched', (t) => {
  const f = fixture(t, { entry: { enabled: false, mode: 'unused' }, main: 'not-the-current-branch', routes: 'unused' });
  const installed = install(f);
  // Existing local state is also untouched: opt-out must not sweep entry receipts.
  fs.mkdirSync(path.join(f.repo, '.lane/discovery/entries'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, '.lane/discovery/entries/entry-000000000000.json'), 'retain me');
  const before = tree(f.repo);
  assert.equal(createEntry(f.options), null);
  for (const kind of ['codex', 'claude']) {
    const args = kind === 'codex' ? ['exec', '-C', f.repo, '--model', 'native-model', 'Task'] : ['--print', '--worktree', 'native-lane', 'Task'];
    command(path.join(installed.bin, `monitor-${kind}`), ['--role', 'supervisor', '--', ...args], f.repo, installed.env);
    const got = JSON.parse(fs.readFileSync(installed.receipt));
    assert.deepEqual(got.args, args); assert.equal(got.cwd, f.repo);
    assert.equal(got.org, installed.env.ORG_DIR); assert.equal(got.requests, '');
    assert.deepEqual(tree(f.repo), before);
    assert.ok(!fs.existsSync(f.options.runtimeDir)); assert.ok(!fs.existsSync(f.options.worktreeRoot));
  }
});
test('automatic interactive adapters pass opted-out sessions straight through', { skip: PTY_SKIP_REASON }, (t) => {
  const f = fixture(t, { entry: { enabled: false } }), installed = install(f), before = tree(f.repo);
  for (const kind of ['codex', 'claude']) {
    const args = ['--model', 'literal-model', 'Task'];
    const result = runPTY(path.join(installed.bin, kind), args, { cwd: f.repo, env: { ...process.env, ...installed.env } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const got = JSON.parse(fs.readFileSync(installed.receipt));
    assert.deepEqual(got.args, args); assert.equal(got.cwd, f.repo);
    assert.deepEqual(tree(f.repo), before);
    assert.ok(!fs.existsSync(f.options.runtimeDir)); assert.ok(!fs.existsSync(f.options.worktreeRoot));
  }
});
test('both transports deliver project settings, integration branch and instruction precedence', (t) => {
  const f = fixture(t, { main: 'trunk', entry: { mode: 'worker', policy: 'Run the accessibility audit for interface changes.' } });
  const installed = install(f);
  for (const kind of ['codex', 'claude']) {
    command(path.join(installed.bin, `monitor-${kind}`), ['--', '--model', 'literal', 'Task'], f.repo, installed.env);
    const got = JSON.parse(fs.readFileSync(installed.receipt)), delivered = policy(got, kind);
    assert.notEqual(got.cwd, f.repo); assert.match(delivered, /You are a worker/u);
    assert.match(delivered, /integration branch: trunk/u);
    assert.match(delivered, /Run the accessibility audit for interface changes\./u);
    assert.match(delivered, /AGENTS\.md and CLAUDE\.md take precedence over this generic policy and entry\.policy/u);
    assert.match(delivered, /Use the project review desk before integration\./u);
    assert.match(delivered, /Report test evidence in the project ledger\./u);
    assert.ok(!fs.existsSync(got.cwd), 'untouched worker lane is cleaned after native exit');
  }
});
test('main-checkout mode reaches both native harnesses without becoming a supervisor', (t) => {
  const f = fixture(t, { main: 'trunk', entry: { mode: 'main', policy: 'Integrate using the project review desk.' } });
  const installed = install(f);
  for (const kind of ['codex', 'claude']) {
    command(path.join(installed.bin, `monitor-${kind}`), ['--', '--model', 'literal', 'Task'], f.repo, installed.env);
    const got = JSON.parse(fs.readFileSync(installed.receipt)), delivered = policy(got, kind);
    assert.equal(got.cwd, f.repo); assert.match(delivered, /You are a worker/u);
    assert.match(delivered, /Entry mode: main; integration branch: trunk/u);
    assert.match(delivered, /no lane to rebase or promote/u);
    assert.match(delivered, /Never start project housekeeping/u);
    assert.ok(!fs.existsSync(f.options.worktreeRoot));
    assert.ok(!fs.existsSync(got.requests));
    const guard = JSON.parse(fs.readFileSync(installed.guard));
    assert.ok(guard.includes('monitor-main-worker'));
    const filesystem = guard.find((arg) => arg.startsWith('permissions.monitor-main-worker.filesystem='));
    assert.ok(filesystem.includes(`${JSON.stringify(path.join(f.repo, '.org'))}="read"`));
    assert.ok(filesystem.includes(`${JSON.stringify(path.join(f.repo, '.lane/discovery'))}="read"`));
    assert.ok(filesystem.includes(`${JSON.stringify(got.requests)}="write"`));
    assert.ok(guard.includes('--include-managed-config'));
    assert.equal(got.args[got.args.indexOf('--model') + 1], 'literal');
  }
  assert.equal(command('git', ['branch', '--list', 'lane/*'], f.repo), '');
  assert.equal(command('git', ['status', '--porcelain'], f.repo), '');
});
test('automatic interactive entry honors the project main-checkout mode', { skip: PTY_SKIP_REASON }, (t) => {
  const f = fixture(t, { main: 'trunk', entry: { mode: 'main', policy: 'Follow the tracked project workflow.' } }), installed = install(f);
  for (const kind of ['codex', 'claude']) {
    const result = runPTY(path.join(installed.bin, kind), ['--model', 'literal', 'Task'], { cwd: f.repo, env: { ...process.env, ...installed.env } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const got = JSON.parse(fs.readFileSync(installed.receipt));
    assert.equal(got.cwd, f.repo);
    assert.match(policy(got, kind), /Entry mode: main; integration branch: trunk/u);
    assert.match(policy(got, kind), /Follow the tracked project workflow\./u);
    assert.ok(!fs.existsSync(f.options.worktreeRoot));
  }
});
test('worker mode validates and promotes to the declared integration branch', (t) => {
  const f = fixture(t, { main: 'trunk', validate: 'node --test', entry: { mode: 'worker' } });
  const sandbox = path.join(f.scratch, 'sandbox'); fs.writeFileSync(sandbox, `#!${process.execPath}\nprocess.exit(0);`, { mode: 0o755 });
  const entry = f.open({ sandboxBinary: sandbox }), current = entry.dispatch({ op: 'start', text: 'Integrate on trunk' });
  fs.mkdirSync(path.dirname(current.report), { recursive: true });
  fs.writeFileSync(current.report, `---\nrun: ${current.run}\noutcome: done\nsummary: Integrated on trunk.\nheadline: The task is integrated\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  entry.dispatch({ op: 'commit', text: 'Integrate the project task on trunk' });
  entry.dispatch({ op: 'check' }); entry.dispatch({ op: 'promote' }); entry.dispatch({ op: 'finish' });
  assert.equal(command('git', ['log', '-1', '--format=%s', 'trunk'], f.repo), 'Integrate the project task on trunk');
  assert.equal(command('git', ['branch', '--show-current'], f.repo), 'trunk');
  assert.equal(command('git', ['branch', '--list', 'main'], f.repo), '');
});
test('main-mode worker records and commits locally, refuses promotion and verifies its assigned branch', (t) => {
  const f = fixture(t, { main: 'trunk', entry: { mode: 'main' } });
  const entry = f.open();
  const started = entry.dispatch({ op: 'start', text: 'Work in the project checkout' });
  assert.equal(started.workspace, f.repo); assert.equal(started.branch, 'trunk');
  fs.writeFileSync(path.join(f.repo, 'actual-work.txt'), 'Actual task result\n');
  entry.dispatch({ op: 'commit', text: 'Complete main-mode task' });
  assert.equal(command('git', ['log', '-1', '--format=%s'], f.repo), 'Complete main-mode task');
  for (const op of ['promote', 'rebase', 'continue', 'abort']) assert.throws(() => entry.dispatch({ op }), /no lane to rebase or promote/u);
  command('git', ['checkout', '-qb', 'other'], f.repo);
  assert.throws(() => entry.dispatch({ op: 'commit', text: 'Wrong branch' }), /assigned integration branch changed/u);
  command('git', ['checkout', '-q', 'trunk'], f.repo);
  entry.close(); assert.ok(fs.existsSync(f.repo));
});
test('main-mode done reports require clean committed work and successful sandboxed validation', (t) => {
  const f = fixture(t, { main: 'trunk', validate: 'node --test', entry: { mode: 'main' } });
  const sandbox = path.join(f.scratch, 'sandbox'), failure = path.join(f.scratch, 'fail-validation'), receipt = path.join(f.scratch, 'validation.json');
  fs.writeFileSync(sandbox, `#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(process.argv.slice(2)));process.exit(fs.existsSync(${JSON.stringify(failure)})?17:0);`, { mode: 0o755 });
  const entry = f.open({ sandboxBinary: sandbox });
  const current = entry.dispatch({ op: 'start', text: 'Complete validated main-mode work' });
  fs.mkdirSync(path.dirname(current.report), { recursive: true });
  fs.writeFileSync(current.report, `---\nrun: ${current.run}\noutcome: done\nsummary: Completed local work.\nheadline: Local work is complete\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  assert.throws(() => entry.dispatch({ op: 'finish' }), /not clean/u);
  entry.dispatch({ op: 'commit', text: 'Commit validated main-mode report' });
  fs.writeFileSync(failure, 'fail');
  assert.throws(() => entry.dispatch({ op: 'finish' }), /sandboxed validation exited 17/u);
  const rec = (args) => command(process.execPath, [path.join(product, 'bin/org.mjs'), ...args], f.repo, { ORG_DIR: current.org });
  assert.equal(JSON.parse(rec(['show', current.run, '--json'])).report, null);
  fs.unlinkSync(failure);
  fs.writeFileSync(sandbox, `#!${process.execPath}\nrequire('fs').appendFileSync('AGENTS.md','Validation changed tracked instructions\\n');`, { mode: 0o755 });
  assert.throws(() => entry.dispatch({ op: 'finish' }), /changed during validation/u);
  assert.equal(JSON.parse(rec(['show', current.run, '--json'])).report, null);
  command('git', ['checkout', '--', 'AGENTS.md'], f.repo);
  fs.writeFileSync(sandbox, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify(process.argv.slice(2)));`, { mode: 0o755 });
  entry.dispatch({ op: 'finish' });
  assert.equal(JSON.parse(rec(['show', current.run, '--json'])).report.outcome, 'done');
  const args = JSON.parse(fs.readFileSync(receipt));
  assert.ok(args.includes('monitor-validation')); assert.equal(args.at(-1), 'node --test');
  const filesystem = args.find((arg) => arg.startsWith('permissions.monitor-validation.filesystem='));
  assert.ok(filesystem.includes(`${JSON.stringify(path.join(f.repo, '.org'))}="read"`));
  assert.ok(filesystem.includes(`${JSON.stringify(path.join(f.repo, '.lane/discovery'))}="read"`));
});
test('entry-only configuration preserves the portable route suggestion and pending operator question', (t) => {
  const f = fixture(t, { main: 'trunk', entry: { mode: 'main' } });
  const routes = loadDiscoveredRoutes({ cwd: f.repo, env: {} });
  assert.equal(routes.suggested, true); assert.equal(resolveLaunchRoute(routes.config).model, 'gpt-6.1-sol');
  const a = f.open(), b = f.open();
  assert.equal(a.context().suggestedRoutes, true);
  assert.equal(a.context().routing.question, b.context().routing.question);
});
test('entry settings use canonical Git identity and do not inherit parent or worker config', (t) => {
  const f = fixture(t, { entry: { mode: 'worker', policy: 'Canonical project policy.' } });
  fs.writeFileSync(path.join(f.scratch, '.lane.json'), JSON.stringify({ entry: { enabled: false }, main: 'trunk' }));
  const entry = f.open();
  const linked = entry.context().workspace;
  fs.writeFileSync(path.join(linked, '.lane.json'), JSON.stringify({ entry: { enabled: false } }));
  const second = f.open({ cwd: linked });
  assert.equal(second.context().entry.enabled, true);
  assert.equal(second.context().entry.source, path.join(f.repo, '.lane.json'));
  assert.match(entryPolicy(second.context(), product), /Canonical project policy\./u);
});
test('invalid enabled settings and mismatched integration branches fail before runtime creation', (t) => {
  const f = fixture(t);
  for (const config of [null, { entry: false }, { entry: { enabled: 'false' } }, { entry: { mode: 'supervisor' } }, { entry: { policy: [] } }, { entry: { typo: true } }, { main: 'elsewhere' }]) {
    fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify(config));
    assert.throws(() => createEntry(f.options), /entry config|integration branch/u);
    assert.ok(!fs.existsSync(path.join(f.repo, '.org'))); assert.ok(!fs.existsSync(path.join(f.repo, '.lane')));
    assert.ok(!fs.existsSync(f.options.runtimeDir)); assert.ok(!fs.existsSync(f.options.worktreeRoot));
  }
});
