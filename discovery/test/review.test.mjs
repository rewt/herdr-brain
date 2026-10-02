import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEntry, command, quote } from '../runtime.mjs';
import { findOrgDir, initOrg } from '../../lib/store.mjs';
import { writeFileAtomic } from '../../lib/files.mjs';
const product = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t) {
  const scratch = fs.mkdtempSync('/private/tmp/monitor-review-test-');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const repo = path.join(scratch, 'project'); fs.mkdirSync(repo);
  command('git', ['init', '-q', '-b', 'main'], repo);
  command('git', ['config', 'user.name', 'Test Operator'], repo);
  command('git', ['config', 'user.email', 'operator@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'An unrelated project\n');
  command('git', ['add', '.'], repo); command('git', ['commit', '-qm', 'Seed'], repo);
  return { scratch, repo, options: { cwd: repo, runtimeDir: path.join(scratch, 'queue'), worktreeRoot: path.join(scratch, 'lanes') } };
}
function install(f) {
  const native = path.join(f.scratch, 'native'), receipt = path.join(f.scratch, 'receipt.json'), bin = path.join(f.scratch, 'bin');
  fs.writeFileSync(native, `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.NATIVE_RECEIPT,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),org:process.env.ORG_DIR,actor:process.env.ORG_ACTOR,tty:process.stdin.isTTY}));`, { mode: 0o755 });
  command(process.execPath, [path.join(product, 'discovery/install.mjs'), '--bin', bin, '--codex', native, '--claude', native], f.repo);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NATIVE_RECEIPT: receipt, ORG_DIR: '', ORG_ACTOR: '', HERDR_ENV: '', HERDR_PANE_ID: '', HERDR_INTEGRATION_ID: '', MONITOR_ENTRY_BYPASS: '', MONITOR_REQUEST_DIR: '', MONITOR_RUNTIME_DIR: f.options.runtimeDir, MONITOR_WORKTREE_ROOT: f.options.worktreeRoot };
  return { bin, receipt, env };
}
function interactive(binary, args, cwd, env) {
  const argv = process.platform === 'darwin' ? ['-q', '/dev/null', binary, ...args] : ['-q', '-e', '-c', [binary, ...args].map(quote).join(' '), '/dev/null'];
  const result = spawnSync('script', argv, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout + result.stderr;
}
const record = (f, args) => command(process.execPath, [path.join(product, 'bin/org.mjs'), ...args], f.repo, { ORG_DIR: path.join(f.repo, '.org'), ORG_ACTOR: 'human' });

test('route adoption leaves planted predictable and destination symlinks untouched', (t) => {
  const f = fixture(t), entry = createEntry(f.options); t.after(entry.close);
  entry.dispatch({ op: 'start', text: 'Adopt routes' });
  record(f, ['answer', entry.context().routing.question, 'yes']);
  const outside = path.join(f.scratch, 'outside-rc'), file = path.join(entry.context().workspace, '.lane.json');
  fs.writeFileSync(outside, 'operator settings\n');
  const planted = `${file}.tmp-${process.pid}`;
  fs.symlinkSync(outside, planted);
  entry.dispatch({ op: 'apply-routes' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'operator settings\n');
  assert.ok(fs.lstatSync(planted).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(file)).routes.engineer.model, 'gpt-6.1-sol');
  fs.unlinkSync(file); fs.symlinkSync(outside, file);
  assert.throws(() => entry.dispatch({ op: 'apply-routes' }), /ELOOP|redirect/u);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'operator settings\n');
  const queue = entry.context().requests, moved = `${queue}-saved`;
  fs.renameSync(queue, moved); fs.symlinkSync(f.scratch, queue);
  assert.throws(() => entry.poll(), /redirect|ENOTDIR|ELOOP/u);
  fs.unlinkSync(queue); fs.renameSync(moved, queue);
});

test('plain CLI finds nested records and keeps automatic runtime files out of git status', (t) => {
  const f = fixture(t);
  const nested = path.join(f.repo, 'subproject'), below = path.join(nested, 'src');
  fs.mkdirSync(below, { recursive: true }); initOrg(path.join(nested, '.org'));
  assert.equal(findOrgDir({ cwd: below, env: {} }), path.join(nested, '.org'));
  command(process.execPath, [path.join(product, 'bin/org.mjs'), 'add', 'Nested task'], below, { ORG_DIR: '', ORG_ACTOR: 'test' });
  assert.ok(!fs.existsSync(path.join(f.repo, '.org')));
  // Existing nested records are explicit initialization; bootstrap at root
  // installs the shared excludes, covering nested runtime directories too.
  command(process.execPath, [path.join(product, 'bin/org.mjs'), 'status'], f.repo, { ORG_DIR: '', ORG_ACTOR: 'test' });
  assert.equal(command('git', ['status', '--porcelain'], f.repo), '');
  const entry = createEntry({ ...f.options, cwd: below }); t.after(entry.close);
  assert.equal(entry.context().org, path.join(nested, '.org'));
});

test('atomic writer pins its directory when an attacker replaces the directory path', (t) => {
  const f = fixture(t), assigned = path.join(f.repo, 'output'), outside = path.join(f.scratch, 'outside');
  fs.mkdirSync(assigned); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'config.json'), 'operator content');
  const original = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (typeof file === 'number') {
      fs.renameSync(assigned, `${assigned}-moved`); fs.symlinkSync(outside, assigned);
    }
    return original(file, ...args);
  };
  try { writeFileAtomic(path.join(assigned, 'config.json'), 'new routes'); }
  finally { fs.writeFileSync = original; }
  assert.equal(fs.readFileSync(path.join(outside, 'config.json'), 'utf8'), 'operator content');
  assert.equal(fs.readFileSync(path.join(`${assigned}-moved`, 'config.json'), 'utf8'), 'new routes');
  assert.throws(() => writeFileAtomic(path.join(assigned, 'another.json'), 'no'), /ELOOP|ENOTDIR|redirect/u);
});

for (const launcher of ['supervisor/open-session.mjs', 'contrib/settle-watch.mjs']) {
  test(`${launcher} sends a bypass that preserves its interactive native session`, (t) => {
    const f = fixture(t), installed = install(f), config = path.join(f.scratch, 'routes.json'), checklist = path.join(f.scratch, 'checklist.md');
    fs.writeFileSync(config, '{}'); fs.writeFileSync(checklist, '# Settle\n');
    const fakeHerdr = path.join(installed.bin, 'herdr');
    fs.writeFileSync(fakeHerdr, `#!${process.execPath}\nconsole.log(JSON.stringify({result:process.argv[2]==='workspace'?{workspaces:[{workspace_id:'owned',worktree:{is_linked_worktree:false,checkout_path:${JSON.stringify(f.repo)}}}]}:{tabs:[],panes:[],agents:[]}}));`, { mode: 0o755 });
    const persona = path.join(f.scratch, 'persona'), memory = path.join(f.scratch, 'memory');
    fs.writeFileSync(persona, `#!/bin/sh\necho CLAUDE_CONFIG_DIR=${f.scratch}/claude\n`, { mode: 0o755 });
    fs.writeFileSync(memory, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const output = command(process.execPath, [path.join(product, launcher), '--open', '--dry-run', '--cwd', f.repo, '--org', path.join(f.scratch, 'record'), '--lane-config', config, '--checklist', checklist, '--launcher', persona, '--cmem-domain', memory], f.repo, installed.env);
    const tab = output.split('\n').find((line) => line.includes('[dry-run] open tab:'));
    const pairs = [...tab.matchAll(/--env (\S+)/gu)].map((match) => match[1].split('='));
    const env = { ...installed.env, ...Object.fromEntries(pairs) };
    assert.equal(env.MONITOR_ENTRY_BYPASS, '1');
    for (const kind of ['codex', 'claude']) {
      interactive(path.join(installed.bin, kind), ['--model', 'supervisor-route'], f.repo, env);
      const receipt = JSON.parse(fs.readFileSync(installed.receipt));
      assert.equal(receipt.cwd, f.repo); assert.equal(receipt.org, env.ORG_DIR); assert.equal(receipt.actor, env.ORG_ACTOR);
      assert.deepEqual(receipt.args, ['--model', 'supervisor-route']);
      assert.ok(!fs.existsSync(path.join(f.repo, '.org')));
    }
  });
}

test('global-only Git identity and unused globally installed LFS survive broker commits', (t) => {
  const f = fixture(t), global = path.join(f.scratch, 'global.gitconfig');
  fs.writeFileSync(global, '[user]\n name = Global Operator\n email = global@example.invalid\n[filter "lfs"]\n process = must-never-execute\n clean = must-never-execute\n smudge = must-never-execute\n required = true\n');
  command('git', ['config', '--unset', 'user.name'], f.repo); command('git', ['config', '--unset', 'user.email'], f.repo);
  const code = `import fs from 'node:fs'; import {createEntry} from ${JSON.stringify(path.join(product, 'discovery/runtime.mjs'))}; const entry=createEntry(${JSON.stringify(f.options)}); try {entry.dispatch({op:'start',text:'Global identity task'});fs.writeFileSync(entry.context().workspace+'/change.txt','actual work');entry.dispatch({op:'commit',text:'Commit as global operator'});console.log(entry.context().workspace);}finally{entry.close();}`;
  const workspace = command(process.execPath, ['--input-type=module', '-e', code], f.repo, { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined });
  assert.equal(command('git', ['log', '-1', '--format=%an <%ae>|%cn <%ce>'], workspace), 'Global Operator <global@example.invalid>|Global Operator <global@example.invalid>');
  fs.writeFileSync(path.join(f.repo, '.gitattributes'), 'README.md filter=lfs\n');
  assert.throws(() => command(process.execPath, ['--input-type=module', '-e', code], f.repo, { GIT_CONFIG_GLOBAL: global }), /external Git filters/u);
});

test('only fresh interactive shims adopt a lane; utilities, batch, resume and existing lanes pass through', (t) => {
  const f = fixture(t), installed = install(f);
  for (const [kind, args] of [['codex', ['exec', 'task']], ['codex', ['resume']], ['claude', ['-p', 'task']], ['claude', ['--resume', 'session']]]) {
    interactive(path.join(installed.bin, kind), args, f.repo, installed.env);
    assert.deepEqual(JSON.parse(fs.readFileSync(installed.receipt)).args, args);
    assert.ok(!fs.existsSync(path.join(f.repo, '.org')));
  }
  command(path.join(installed.bin, 'codex'), ['--model', 'literal'], f.repo, installed.env);
  assert.equal(JSON.parse(fs.readFileSync(installed.receipt)).cwd, f.repo);
  interactive(path.join(installed.bin, 'codex'), ['--model', 'literal', '-p', 'operator-profile'], f.repo, installed.env);
  const fresh = JSON.parse(fs.readFileSync(installed.receipt));
  assert.equal(fresh.tty, true); assert.notEqual(fresh.cwd, f.repo);
  assert.equal(fresh.args[fresh.args.indexOf('-p') + 1], 'operator-profile');
  assert.ok(fresh.args.some((arg) => arg.startsWith('developer_instructions=')));
  const lanesBefore = command('git', ['worktree', 'list', '--porcelain'], f.repo);
  const runExisting = (kind, cwd) => {
    interactive(path.join(installed.bin, kind), ['--model', 'literal'], cwd, installed.env);
    const receipt = JSON.parse(fs.readFileSync(installed.receipt));
    assert.deepEqual(receipt.args, ['--model', 'literal']); assert.equal(receipt.cwd, cwd);
    assert.equal(command('git', ['worktree', 'list', '--porcelain'], f.repo), lanesBefore);
  };
  for (const kind of ['codex', 'claude']) runExisting(kind, fresh.cwd);
});

test('interactive no-identity launches warn and preserve the native session', (t) => {
  const f = fixture(t), installed = install(f);
  const notGit = path.join(f.scratch, 'not-git'), empty = path.join(f.scratch, 'empty');
  fs.mkdirSync(notGit); fs.mkdirSync(empty); command('git', ['init', '-q', '-b', 'main'], empty);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ main: 'integration' }));
  for (const cwd of [notGit, empty, f.repo]) for (const kind of ['codex', 'claude']) {
    const output = interactive(path.join(installed.bin, kind), [], cwd, installed.env);
    assert.match(output, /continuing with native/u, `${kind} at ${cwd}`);
    assert.equal(JSON.parse(fs.readFileSync(installed.receipt)).cwd, cwd);
    assert.ok(!fs.existsSync(path.join(cwd, '.org')));
  }
});

test('Herdr managed starts bypass entry even without an explicit launcher marker', (t) => {
  const f = fixture(t), installed = install(f), herdr = path.join(installed.bin, 'herdr');
  const pending = path.join(f.scratch, 'pending-start');
  fs.writeFileSync(herdr, `#!${process.execPath}
const fs=require('fs'),{spawnSync}=require('child_process'),args=process.argv.slice(2),pending=${JSON.stringify(pending)};
if(args[0]==='agent'&&args[1]==='start'){
 fs.writeFileSync(pending,'registered before command injection');
 const kind=args[args.indexOf('--kind')+1],native=args.slice(args.indexOf('--')+1),binary=${JSON.stringify(installed.bin)}+'/'+kind;
 const result=spawnSync('/usr/bin/script',['-q','/dev/null',binary,...native],{env:{...process.env,HERDR_ENV:'1',HERDR_PANE_ID:'owned-pane'},stdio:['ignore','pipe','pipe'],encoding:'utf8'});
 fs.unlinkSync(pending);process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??1);
}else console.log(JSON.stringify({result:{agents:fs.existsSync(pending)?[{name:'managed',pane_id:'owned-pane',launch_pending:true}]:[]}}));`, { mode: 0o755 });
  for (const kind of ['codex', 'claude']) {
    command(herdr, ['agent', 'start', 'managed', '--kind', kind, '--pane', 'owned-pane', '--', '--model', 'managed-model'], f.repo, installed.env);
    const receipt = JSON.parse(fs.readFileSync(installed.receipt));
    assert.equal(receipt.cwd, f.repo); assert.deepEqual(receipt.args, ['--model', 'managed-model']);
    assert.ok(!fs.existsSync(path.join(f.repo, '.org')));
  }
  interactive(path.join(installed.bin, 'claude'), ['--model', 'fresh-model'], f.repo, { ...installed.env, HERDR_ENV: '1', HERDR_PANE_ID: 'owned-pane' });
  const fresh = JSON.parse(fs.readFileSync(installed.receipt));
  assert.notEqual(fresh.cwd, f.repo); assert.ok(fresh.args.includes('--append-system-prompt'));
});

test('canonical preparation and validation remain authoritative in both check and promote', (t) => {
  const f = fixture(t), canonical = path.join(f.repo, '.lane.json');
  fs.writeFileSync(canonical, JSON.stringify({ prepare: [{ run: 'canonical-prepare' }], validate: 'canonical-failing-check' }));
  command('git', ['add', '.lane.json'], f.repo); command('git', ['commit', '-qm', 'Set canonical validation'], f.repo);
  const sandbox = path.join(f.scratch, 'sandbox'), log = path.join(f.scratch, 'validation.log');
  fs.writeFileSync(sandbox, `#!${process.execPath}\nconst fs=require('fs'),step=process.argv.at(-1);fs.appendFileSync(process.env.VALIDATION_LOG,step+'\\n');process.exit(step==='canonical-failing-check'?17:0);`, { mode: 0o755 });
  const entry = createEntry({ ...f.options, sandboxBinary: sandbox }); t.after(entry.close);
  const started = entry.dispatch({ op: 'start', text: 'Cannot bypass gate' });
  fs.writeFileSync(path.join(started.workspace, '.lane.json'), JSON.stringify({ prepare: [{ run: 'worker-prepare' }], validate: 'true' }));
  fs.mkdirSync(path.dirname(started.report), { recursive: true });
  fs.writeFileSync(started.report, `---\nrun: ${started.run}\noutcome: done\nsummary: Attempt worker override\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  entry.dispatch({ op: 'commit', text: 'Try worker gate override' });
  const before = command('git', ['rev-parse', 'main'], f.repo);
  const previous = process.env.VALIDATION_LOG; process.env.VALIDATION_LOG = log;
  try {
    for (const op of ['check', 'promote']) assert.throws(() => entry.dispatch({ op }), /canonical.*canonical-failing-check[\s\S]*exited 17/u);
  } finally { if (previous === undefined) delete process.env.VALIDATION_LOG; else process.env.VALIDATION_LOG = previous; }
  assert.equal(fs.readFileSync(log, 'utf8'), 'canonical-prepare\ncanonical-failing-check\ncanonical-prepare\ncanonical-failing-check\n');
  assert.equal(command('git', ['rev-parse', 'main'], f.repo), before);
});
