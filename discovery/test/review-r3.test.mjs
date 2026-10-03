import { loadTimeout } from '../../lib/deadline.mjs';
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { socketFilter } from '../bubblewrap.mjs';
import { runBounded } from '../bounded.mjs';
import { sandboxCommand } from '../confinement.mjs';
import { lifetimeScope, closeScope } from '../lifetime.mjs';
import { spawnDetachedFixture } from '../../test/helpers/detached.mjs';
import { waitForExit } from '../../test/helpers/child.mjs';
const product = new URL('../../', import.meta.url).pathname;
const actorTest = (name, fn, options = {}) => test(name, { timeout: 20000, ...options }, (t) => {
  process.env.ORG_ACTOR = `r93-${name.replaceAll(/[^a-z0-9]/giu, '-').slice(0, 90)}`;
  return fn(t);
});
const fixture = (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-r93-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function evaluate(program, syscall, audit) {
  let value;
  for (let pc = 0; pc < program.length / 8; pc++) {
    const offset = pc * 8, opcode = program.readUInt16LE(offset), constant = program.readUInt32LE(offset + 4);
    if (opcode === 0x20) value = constant === 4 ? audit : syscall;
    else if (opcode === 0x06) return constant;
    else if (opcode === 0x15 || opcode === 0x35) pc += program[offset + ((opcode === 0x15 ? value === constant : value >= constant) ? 2 : 3)];
    else assert.fail('unsupported BPF opcode');
  }
  assert.fail('missing default verdict');
}
for (const [arch, audit, read, write, openat, socket, pair] of [
  ['x64', 0xc000003e, 0, 1, 257, 41, 53], ['arm64', 0xc00000b7, 63, 64, 56, 198, 199],
]) actorTest(`${arch} seccomp denies io_uring, unknown syscalls and socket creation by default`, () => {
  const program = socketFilter(arch);
  for (const syscall of [425, 426, 427, socket, pair, 9999, 321, 280]) {
    // 321/280 are BPF on x64/arm64; the other ABI's number need not be denied.
    if ((syscall === 321 && arch !== 'x64') || (syscall === 280 && arch !== 'arm64')) continue;
    assert.equal(evaluate(program, syscall, audit), 0x00050001, `syscall ${syscall}`);
  }
  for (const syscall of [read, write, openat, arch === 'arm64' ? 79 : 262]) assert.equal(evaluate(program, syscall, audit), 0x7fff0000);
  assert.equal(evaluate(program, 435, audit), 0x00050026, 'clone3 denied with the libc fallback errno');
  assert.equal(evaluate(program, read | 0x40000000, audit), 0x00050001);
  assert.equal(evaluate(program, read, 0), 0x80000000);
});

for (const [mode, name] of [
  ['completion', 'detached double-fork descendants are gone after completion; unrelated same-group processes survive'],
  ['deadline', 'detached double-fork descendants are gone after deadline; unrelated same-group processes survive'],
  ['wrapper-death', 'descendants are cleaned after the JavaScript wrapper is killed'],
]) actorTest(name, async (t) => {
  const { child } = spawnDetachedFixture(t, mode);
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
});
actorTest('macOS cleanup retains the immutable kernel marker and refuses a missing provider boundary', async (t) => {
  const root = fixture(t), scope = lifetimeScope(); t.after(() => closeScope(scope));
  fs.mkdirSync(path.join(root, '.git')); fs.mkdirSync(path.join(root, '.org'));
  const marker = path.join(root, 'untrusted-called');
  const fake = path.join(root, 'unprotected-provider');
  fs.writeFileSync(fake, `#!${process.execPath}\nconst a=process.argv.slice(2),i=a.indexOf('--');const r=require('child_process').spawnSync(a[i+1],a.slice(i+2),{stdio:['inherit','inherit','inherit',3]});process.exit(r.status??1);`, { mode: 0o755 });
  const guard = sandboxCommand(fake, root, { sharedPaths: [path.join(root, '.org')], lifetime: scope });
  const result = await runBounded(guard.binary, guard.args, { scope, command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`], timeoutMs: 5000 });
  assert.equal(result, 125); assert.ok(!fs.existsSync(marker));
  const profile = `(version 1)(allow default)(deny file-read* (literal ${JSON.stringify(scope.denied)}))`;
  const restricted = await runBounded('/usr/bin/sandbox-exec', ['-p', profile], { scope, command: ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', '/bin/true'], timeoutMs: 5000 });
  assert.notEqual(restricted, 0, 'a descendant cannot replace its inherited kernel marker');
}, { skip: process.platform !== 'darwin' && 'macOS kernel identity regression' });
actorTest('validation cannot signal an owner outside its inherited kernel boundary', async (t) => {
  const root = fixture(t), scope = lifetimeScope(); t.after(() => closeScope(scope));
  fs.mkdirSync(path.join(root, '.git')); fs.mkdirSync(path.join(root, '.org'));
  const command = [process.execPath, '-e', `try{process.kill(${process.pid},0);process.exit(1)}catch(e){process.exit(e.code==='EPERM'?0:2)}`];
  for (const binary of ['/usr/bin/sandbox-exec', ...(process.env.MONITOR_TEST_SANDBOX ? [process.env.MONITOR_TEST_SANDBOX] : [])]) {
    const guard = sandboxCommand(binary, root, { sharedPaths: [path.join(root, '.org')], lifetime: scope });
    assert.equal(await runBounded(guard.binary, guard.args, { scope, command, timeoutMs: 2000 }), 0, binary);
  }
}, { skip: process.platform !== 'darwin' && 'macOS owner signal boundary' });
actorTest('lifetime markers reject redirected scratch roots before provider construction', (t) => {
  const root = fixture(t), scope = lifetimeScope(); t.after(() => closeScope(scope));
  fs.mkdirSync(path.join(root, '.git')); fs.mkdirSync(path.join(root, '.org'));
  const alias = path.join(root, 'monitor-lifetime-alias'); fs.symlinkSync(path.dirname(scope.allowed), alias);
  assert.throws(() => sandboxCommand('/usr/bin/sandbox-exec', root, { sharedPaths: [path.join(root, '.org')], lifetime: {allowed:path.join(alias,path.basename(scope.allowed)),denied:path.join(alias,path.basename(scope.denied))} }), /redirected/u);
}, { skip: process.platform !== 'darwin' && 'macOS lifetime scope layout' });

function probe(t, args, preload = '') {
  const root = fixture(t), native = path.join(root, 'fake-claude'), marker = path.join(root, 'native-called');
  fs.writeFileSync(native, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'unsafe');process.exit(1);`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [...(preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : []),
    path.join(product, 'discovery/acceptance.mjs'), '--harness', 'claude', '--binary', native, ...args], { encoding: 'utf8', timeout: loadTimeout(15000), env: process.env });
  const evidence = result.stdout.match(/^Evidence: (.+)$/mu)?.[1];
  if (evidence) t.after(() => fs.rmSync(path.dirname(evidence), { recursive: true, force: true }));
  return { result, evidence, marker };
}
for (const flags of [[], ['--skip-live']]) actorTest(`pending Claude probe emits Linux evidence without a platform guard (${flags.length ? 'skip-live' : 'no-auth'})`, (t) => {
  const { result, evidence, marker } = probe(t, flags, "Object.defineProperty(process,'platform',{value:'linux'});");
  assert.equal(result.status, 1, result.stderr); assert.ok(evidence, result.stderr);
  const summary = JSON.parse(fs.readFileSync(path.join(evidence, 'summary.json'), 'utf8'));
  assert.equal(summary.setupComplete, true);
  assert.equal(summary.results.filter((row) => row.status === 'FAIL').length, 0);
  assert.equal(summary.results.filter((row) => row.status === 'PENDING').length, 2);
  assert.deepEqual(summary.usage, []); assert.ok(!fs.existsSync(marker)); assert.ok(!fs.existsSync(summary.install));
});
actorTest('acceptance setup failure removes its installed snapshot and keeps only evidence', (t) => {
  const { result, evidence, marker } = probe(t, ['--binary', '/nonexistent/r93-native', '--keep']);
  assert.equal(result.status, 1); assert.ok(evidence, result.stderr);
  const summary = JSON.parse(fs.readFileSync(path.join(evidence, 'summary.json'), 'utf8'));
  assert.equal(summary.setupComplete, false); assert.equal(summary.results.at(-1).name, 'Setup');
  assert.ok(!fs.existsSync(summary.install)); assert.deepEqual(fs.readdirSync(summary.scratch), ['evidence']); assert.ok(!fs.existsSync(marker));
});
actorTest('acceptance allocation failure removes the first temporary root', (t) => {
  const preload = `import fs from 'node:fs';const original=fs.mkdtempSync;let n=0;fs.mkdtempSync=(...args)=>{if(++n===2)throw Error('r93 allocation refused');const value=original(...args);console.log('ALLOCATED '+value);return value;};`;
  const { result, marker } = probe(t, [], preload);
  assert.equal(result.status, 1); assert.match(result.stderr, /r93 allocation refused/u);
  const installed = result.stdout.match(/^ALLOCATED (.+)$/mu)?.[1]; assert.ok(installed); assert.ok(!fs.existsSync(installed)); assert.ok(!fs.existsSync(marker));
});
actorTest('acceptance evidence directory failure still removes its installed snapshot', (t) => {
  const preload = `import fs from 'node:fs';const make=fs.mkdtempSync,mkdir=fs.mkdirSync;fs.mkdtempSync=(...args)=>{const value=make(...args);console.log('ALLOCATED '+value);return value;};fs.mkdirSync=(...args)=>{if(String(args[0]).endsWith('/evidence'))throw Error('r93 evidence refused');return mkdir(...args);};`;
  const { result, marker } = probe(t, ['--keep'], preload);
  assert.equal(result.status, 1); assert.match(result.stderr, /r93 evidence refused/u);
  const roots = [...result.stdout.matchAll(/^ALLOCATED (.+)$/gmu)].map((match) => match[1]);
  assert.equal(roots.length, 2); assert.ok(!fs.existsSync(roots[0]), 'snapshot removed even when summary cannot be written');
  t.after(() => fs.rmSync(roots[1], { recursive: true, force: true }));
  assert.deepEqual(fs.readdirSync(roots[1]), []); assert.ok(!fs.existsSync(marker));
});
actorTest('Linux kernel denies asynchronous AF_UNIX socket creation and host socket connection', async (t) => {
  const root = fixture(t), binary = path.join(root, 'seccomp-network');
  const built = spawnSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-o', binary, path.join(product, 'discovery/test/helpers/seccomp-network.c')], { encoding: 'utf8', timeout: loadTimeout(10000) });
  assert.equal(built.status, 0, built.stderr);
  const { createServer } = await import('node:net');
  const socket = path.join(root, 'host.sock'), messages = [];
  const server = createServer((client) => client.on('data', (bytes) => messages.push(bytes.toString())));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => server.close());
  const run = (args) => new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output='';
    child.stderr.on('data', (data) => output += data); const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    child.on('close',(status)=>{clearTimeout(timer);resolve({status,output});});
  });
  const control = await run(['control', socket]);
  if (control.status === 77) { t.skip('host io_uring is disabled/unavailable; asynchronous positive control cannot run'); return; }
  assert.equal(control.status, 0, control.output);
  const receivedDeadline = Date.now() + 1000;
  while (!messages.join('').includes('async') && Date.now() < receivedDeadline) await delay(10);
  assert.ok(messages.join('').includes('async'));
  const filter = path.join(root, 'filter'); fs.writeFileSync(filter, socketFilter()); messages.length = 0;
  const denied = await run(['deny', socket, filter]); assert.equal(denied.status, 0, denied.output); assert.deepEqual(messages, []);
}, { skip: process.platform !== 'linux' && 'requires a Linux kernel with io_uring enabled' });
