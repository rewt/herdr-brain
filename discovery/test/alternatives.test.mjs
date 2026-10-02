import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { sandboxCommand, selectSandbox } from '../confinement.mjs';
import { createEntry, command } from '../runtime.mjs';
process.env.ORG_ACTOR = 'eng81-offline-alternatives';
const product = new URL('../../', import.meta.url).pathname;
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-alternatives-'));
  const entries = [];
  t.after(() => { for (const entry of entries) entry.close(); fs.rmSync(scratch, { recursive: true, force: true }); });
  const repo = path.join(scratch, 'repo'); fs.mkdirSync(repo);
  command('git', ['init', '-q', '-b', 'main'], repo);
  command('git', ['config', 'user.name', 'Alternatives test'], repo);
  command('git', ['config', 'user.email', 'test@example.invalid'], repo);
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, 'test/green.test.mjs'), "import test from 'node:test';test('green',()=>{});\n");
  fs.writeFileSync(path.join(repo, 'data.txt'), 'HELLO\n');
  command('git', ['add', '.'], repo); command('git', ['commit', '-qm', 'Seed'], repo);
  return { scratch, repo, entries };
}
test('provider selection refuses automatic Linux bubblewrap and retains explicit providers', { timeout: 5000 }, (t) => {
  const f = fixture(t), bin = path.join(f.scratch, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'bwrap'), '#!/bin/sh\n', { mode: 0o755 });
  assert.throws(() => selectSandbox('auto', { platform: 'linux', searchPath: bin }), /disabled by default/u);
  assert.throws(() => selectSandbox('auto', { platform: 'unknown' }), /no native validation sandbox/u);
  assert.equal(selectSandbox('/explicit/provider'), '/explicit/provider');
});
test('alternative profiles protect resolved Git and shared state, omit network and broad tmp grants', { timeout: 5000 }, (t) => {
  const f = fixture(t), shared = path.join(f.repo, '.org'); fs.mkdirSync(shared);
  const alias = path.join(f.scratch, 'alias'); fs.symlinkSync(shared, alias);
  const temp = path.join(f.repo, 'temp'); fs.mkdirSync(temp);
  const mac = sandboxCommand('/usr/bin/sandbox-exec', f.repo, { sharedPaths: [alias], writablePaths: [temp] });
  assert.match(mac.args[1], /deny network\*/u); assert.ok(mac.args[1].includes(shared));
  assert.ok(mac.args[1].includes(path.join(f.repo, '.git'))); assert.match(mac.args[1], /require-not/u);
  const linux = sandboxCommand('experimental-bubblewrap:/usr/bin/bwrap', f.repo, { sharedPaths: [shared], writablePaths: [temp] });
  assert.ok(linux.args.includes('--unshare-net')); assert.ok(linux.args.includes('--unshare-pid'));
  assert.deepEqual(linux.args.slice(linux.args.indexOf('--ro-bind'), linux.args.indexOf('--ro-bind') + 3), ['--ro-bind', '/', '/']);
  assert.ok(linux.args.includes(shared)); assert.ok(!linux.args.includes('--share-net'));
  const native = sandboxCommand('experimental-bubblewrap:/usr/bin/bwrap', f.repo, { sharedPaths: [shared], native: true });
  assert.throws(() => sandboxCommand('experimental-bubblewrap:/usr/bin/bwrap', f.repo, { sharedPaths: [alias], native: true }), /shared-state symlink/u);
  assert.ok(!native.args.includes('--unshare-net')); assert.ok(native.args.includes(shared));
});
test('Claude-only scratch installation does not require or install Codex', { timeout: 10000 }, (t) => {
  const f = fixture(t), bin = path.join(f.scratch, 'bin'), fake = path.join(f.scratch, 'claude');
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  command(process.execPath, [path.join(product, 'discovery/install.mjs'), '--bin', bin, '--claude', fake], f.repo);
  assert.ok(!fs.existsSync(path.join(bin, 'codex')));
  assert.match(fs.readFileSync(path.join(bin, 'monitor-claude'), 'utf8'), /--validator 'auto'/u);
  assert.match(command(path.join(bin, 'monitor-claude'), ['--', '--print', '--model', 'haiku', 'Task'], f.repo,
    { MONITOR_RUNTIME_DIR: path.join(f.scratch, 'runtime'), MONITOR_WORKTREE_ROOT: path.join(f.scratch, 'lanes') }), /--append-system-prompt/u);
  command(process.execPath, [path.join(product, 'discovery/install.mjs'), '--bin', bin, '--remove'], f.repo);
});

const provider = process.env.MONITOR_TEST_ALTERNATIVE;
test('real alternative sandbox denies outside, symlink, metadata, record, rename and network writes', {
  skip: !provider && 'set MONITOR_TEST_ALTERNATIVE to sandbox-exec or bwrap outside a nested sandbox', timeout: 15000,
}, (t) => {
  const f = fixture(t), shared = path.join(f.repo, '.org'); fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'events'), 'keep');
  const outside = path.join(f.scratch, 'outside'); fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(f.repo, 'escape'));
  const sandbox = sandboxCommand(provider, f.repo, { sharedPaths: [shared] });
  const script = `const fs=require('fs'),assert=require('assert'),net=require('net');
for(const p of ${JSON.stringify([outside, path.join(f.repo, 'escape'), path.join(f.repo, '.git/config'), path.join(shared, 'events')])})assert.throws(()=>fs.writeFileSync(p,'bad'));
assert.throws(()=>fs.renameSync(${JSON.stringify(shared)},${JSON.stringify(shared + '-moved')}));
fs.writeFileSync('allowed','ok');
const server=net.createServer();server.on('error',()=>process.exit(0));server.listen(0,'0.0.0.0',()=>process.exit(7));`;
  // Bubblewrap isolates networking rather than refusing bind/listen; probe an
  // outbound connection there instead of requiring a network syscall denial.
  const probe = path.basename(provider) === 'bwrap' ? script.slice(0, script.indexOf('const server='))
    + "const s=net.connect({host:'192.0.2.1',port:443});s.on('error',()=>process.exit(0));s.on('connect',()=>process.exit(7));setTimeout(()=>process.exit(0),500);" : script;
  const r = spawnSync(sandbox.binary, [...sandbox.args, process.execPath, '-e', probe], { cwd: f.repo, encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr); assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});
test('real filters remain functional through allocation, commit, check and fast-forward promotion', {
  skip: !provider && 'set MONITOR_TEST_ALTERNATIVE to exercise real bounded Git filters', timeout: 45000,
}, (t) => {
  const f = fixture(t);
  // Stateful filter tries escaping but still transforms content. required=true
  // ensures a sandbox setup failure cannot silently bypass the transformation.
  const filter = path.join(f.scratch, 'filter.cjs');
  fs.writeFileSync(filter, `const fs=require('fs');for(const p of [${JSON.stringify(path.join(f.scratch, 'escape-filter'))},${JSON.stringify(path.join(f.repo, '.git/config'))},${JSON.stringify(path.join(f.repo, '.org/events.jsonl'))},'.git']){try{fs.writeFileSync(p,'bad');process.exit(9)}catch{}}let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>process.stdout.write(process.argv[2]==='clean'?text.toUpperCase():text.toLowerCase()));`);
  fs.writeFileSync(path.join(f.repo, '.gitattributes'), 'data.txt filter=bounded\n');
  command('git', ['add', '.'], f.repo); command('git', ['commit', '-qm', 'Add filter fixture'], f.repo);
  command('git', ['config', 'filter.bounded.clean', `${process.execPath} ${filter} clean %f`], f.repo);
  command('git', ['config', 'filter.bounded.smudge', `${process.execPath} ${filter} smudge %f`], f.repo);
  const entry = createEntry({ cwd: f.repo, sandboxBinary: provider,
    runtimeDir: path.join(f.scratch, 'runtime'), worktreeRoot: path.join(f.scratch, 'lanes') }); f.entries.push(entry);
  const task = entry.dispatch({ op: 'start', text: 'Filtered task' });
  fs.writeFileSync(path.join(task.workspace, 'data.txt'), 'CHANGED\n');
  fs.mkdirSync(path.dirname(task.report), { recursive: true });
  fs.writeFileSync(task.report, `---\nrun: ${task.run}\noutcome: done\nsummary: Filtered task\nheadline: Filtered task\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  entry.dispatch({ op: 'commit', text: 'Filtered task' });
  entry.dispatch({ op: 'check' }); entry.dispatch({ op: 'promote' }); entry.dispatch({ op: 'finish' });
  assert.equal(fs.readFileSync(path.join(f.repo, 'data.txt'), 'utf8'), 'changed\n');
  assert.equal(command('git', ['show', 'HEAD:data.txt'], f.repo), 'CHANGED');
  assert.ok(!fs.existsSync(path.join(f.scratch, 'escape-filter')));
});

test('real main-mode alternative guard protects linked shared records and leaves the native runtime writable', {
  skip: !provider && 'set MONITOR_TEST_ALTERNATIVE for the main-mode guard regression', timeout: 10000,
}, (t) => {
  const f = fixture(t), record = path.join(f.scratch, 'record'), alias = path.join(f.repo, '.org');
  fs.mkdirSync(record); fs.writeFileSync(path.join(record, 'events'), 'keep'); fs.symlinkSync(record, alias);
  const queue = path.join(record, 'queue'); fs.mkdirSync(queue);
  const runtime = path.join(f.scratch, 'native-runtime'); fs.mkdirSync(runtime);
  if (path.basename(provider) === 'bwrap') {
    assert.throws(() => sandboxCommand(provider, f.repo, { sharedPaths: [alias, record], writablePaths: [queue], native: true }), /shared-state symlink/u);
    return;
  }
  const sandbox = sandboxCommand(provider, f.repo, { sharedPaths: [alias, record], writablePaths: [queue], native: true });
  const script = `const fs=require('fs'),assert=require('assert');
for(const p of ${JSON.stringify([path.join(record, 'events'), path.join(alias, 'events'), path.join(f.repo, '.git/config')])})assert.throws(()=>fs.writeFileSync(p,'bad'));
assert.throws(()=>fs.unlinkSync(${JSON.stringify(alias)}));
fs.writeFileSync(${JSON.stringify(path.join(queue, 'request'))},'ok');fs.writeFileSync(${JSON.stringify(path.join(runtime, 'state'))},'ok');`;
  const r = spawnSync(sandbox.binary, [...sandbox.args, process.execPath, '-e', script], { cwd: f.repo, encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr);
});

test('bounded commands kill descendants before they can write after a deadline', { timeout: 5000 }, async (t) => {
  const f = fixture(t), marker = path.join(f.scratch, 'late-write');
  const { runBounded } = await import('../bounded.mjs');
  const grandchild = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'late'),700);`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  assert.equal(await runBounded(process.execPath, ['-e', parent], { timeoutMs: 300 }), 124);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.ok(!fs.existsSync(marker));
});

test('Linux network guard refuses unsupported ABIs and sends seccomp over an inherited descriptor', { timeout: 5000 }, async (t) => {
  const { socketFilter } = await import('../bubblewrap.mjs');
  assert.throws(() => socketFilter('ia32'), /socket guard unavailable/u);
  const evaluate = (program, syscall, audit) => {
    let accumulator;
    for (let pc = 0; pc < program.length / 8; pc++) {
      const offset = pc * 8, code = program.readUInt16LE(offset), value = program.readUInt32LE(offset + 4);
      if (code === 0x20) accumulator = value === 4 ? audit : syscall;
      else if (code === 0x06) return value;
      else if (code === 0x15 || code === 0x35) {
        const matches = code === 0x15 ? accumulator === value : accumulator >= value;
        pc += program[offset + (matches ? 2 : 3)];
      } else assert.fail('unknown BPF instruction');
    }
    assert.fail('program lacks a verdict');
  };
  for (const [arch, audit, socket, pair] of [['x64', 0xc000003e, 41, 53], ['arm64', 0xc00000b7, 198, 199]]) {
    const filter = socketFilter(arch);
    assert.equal(evaluate(filter, socket, audit), 0x00050001);
    assert.equal(evaluate(filter, pair, audit), 0x00050001);
    assert.equal(evaluate(filter, socket | 0x40000000, audit), 0x00050001);
    assert.equal(evaluate(filter, arch === 'x64' ? 0 : 63, audit), 0x7fff0000);
    assert.equal(evaluate(filter, socket, 0), 0x80000000);
  }
  const f = fixture(t), shared = path.join(f.repo, '.org'); fs.mkdirSync(shared);
  const command = sandboxCommand('experimental-bubblewrap:/usr/bin/bwrap', f.repo, { sharedPaths: [shared] });
  assert.equal(command.binary, process.execPath);
  assert.match(command.args[0], /bubblewrap.mjs$/u);
});
