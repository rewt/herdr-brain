import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { joinFleet } from '../../lib/fleet.mjs';
import { initOrg } from '../../lib/store.mjs';
import { ownerProcess } from '../../lib/process-owner.mjs';
import { createScopedBinding, claimScopedBinding, callerBinding, executeScoped, scopedArguments } from '../herdr-scoped.mjs';
import { chatHerdrMode, chatHerdrPresets } from '../chat-herdr.mjs';
import { nativeSandboxLaunch } from '../native-sandbox.mjs';
import { entryPolicy } from '../policy.mjs';
import { fakeControlSocket } from '../../test/helpers/fake-control-socket.mjs';
import { nativeScopedProbe } from '../herdr-scoped-probe.mjs';

function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/r365-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { role: 'chat', canonical: path.join(root, 'repo'), workspace: path.join(root, 'repo'), org: path.join(root, 'org'),
    tempRoot: path.join(root, 'temp'), worktrees: path.join(root, 'lanes'), projects: [] };
  for (const dir of new Set(Object.values(context).filter(v => typeof v === 'string' && v.startsWith('/')))) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(context.org, 'events.jsonl'), '');
  const configDir = path.join(root, 'config'); fs.mkdirSync(configDir);
  const git = args => { const r = spawnSync('git', ['-C', context.canonical, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Scoped tests']); git(['config', 'user.email', 'test@example.invalid']);
  const config = { chat: { herdr_mode: 'scoped', presets: { wallet: { command: '/absolute/wallet --fixed', cwd: context.canonical } } } };
  const commit = cfg => { fs.writeFileSync(path.join(context.canonical, '.lane.json'), JSON.stringify(cfg)); git(['add', '.lane.json']); git(['commit', '-qm', 'config']); };
  commit(config);
  const stateFile = path.join(root, 'state.json');
  const initial = { calls: [], panes: [
    { pane_id: 'chats:p1', workspace_id: 'chats', tab_id: 'chats:t1' },
    { pane_id: 'chats:p2', workspace_id: 'chats', tab_id: 'chats:t1' },
    { pane_id: 'chats:p3', workspace_id: 'chats', tab_id: 'chats:t2' },
    { pane_id: 'agents:p1', workspace_id: 'agents', tab_id: 'agents:t1' } ], counter: 3 };
  fs.writeFileSync(stateFile, JSON.stringify(initial));
  const herdr = path.join(root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
const fs=require('node:fs'),net=require('node:net'), file=${JSON.stringify(stateFile)};
const s=JSON.parse(fs.readFileSync(file)), a=process.argv.slice(2);s.calls.push(a);
let out={};
if(a[0]==='pane'&&a[1]==='get')out={pane:s.panes.find(p=>p.pane_id===a[2])};
else if(a[1]==='split'){const pane={pane_id:'chats:p'+ ++s.counter,workspace_id:'chats',tab_id:'chats:t1'};s.panes.push(pane);out={pane};}
else if(a[1]==='close')s.panes=s.panes.filter(p=>p.pane_id!==a[2]);
else if(a[1]==='process-info')out={process_info:{shell_pid:42,foreground_processes:[{pid:s.busy?43:42}]}};
else if(a[1]==='neighbor')out={neighbor:s.neighbor===null?{}:{neighbor_pane_id:Object.hasOwn(s,'neighbor')?s.neighbor:'chats:p2'}};
fs.writeFileSync(file,JSON.stringify(s));
const c=net.connect(process.env.HERDR_SOCKET_PATH);c.once('error',e=>{console.error(e.code);process.exitCode=1});
c.once('connect',()=>{
  c.destroy();
  if(a[1]==='read'&&s.streamFile){
    process.stdout.write('first\\n');process.stderr.write('streaming\\n');
    const timer=setInterval(()=>{if(fs.existsSync(s.streamFile)){clearInterval(timer);process.stdout.write('x'.repeat(9*1024*1024)+'last\\n');}},10);
  }else if(a[1]==='read'&&s.signalRead){
    const timer=setInterval(()=>{},1000);
    for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>{clearInterval(timer);console.log(signal);process.exitCode=23;});
    console.log('ready');
  }else setTimeout(()=>console.log(a[1]==='read'?'checkout % ':JSON.stringify({ok:true,result:out})),a[1]==='wait-output'?(s.waitMs||0):0);
});
`, { mode: 0o755 });
  const binary = path.join(root, 'claude');
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = --help ]; then echo --settings; elif [ "$1" = --version ]; then echo 2.1.295; fi\n', { mode: 0o755 });
  const socket = fakeControlSocket(t, root);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, HERDR_BIN_PATH: herdr, HERDR_SOCKET_PATH: socket };
  const entryBin = path.join(root, 'bin');
  const installed = spawnSync(process.execPath, [new URL('../install.mjs', import.meta.url).pathname, '--bin', entryBin, '--claude', binary], { env, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  const scopeRoot = path.join(entryBin, '.herdr-scoped');
  createScopedBinding({ root: scopeRoot, canonical: context.canonical, receipt: initial.panes[0] && { workspace: 'chats', tab: 'chats:t1', pane: 'chats:p1' }, shell: ownerProcess(process.pid), socket });
  const state = () => JSON.parse(fs.readFileSync(stateFile));
  const change = fn => { const s = state(); fn(s); fs.writeFileSync(stateFile, JSON.stringify(s)); };
  const run = (args, extra = {}) => spawnSync(path.join(entryBin, 'herdr-scoped'), args, { env: { ...env, ...extra }, encoding: 'utf8' });
  const claim = () => claimScopedBinding(scopeRoot, context.canonical);
  return { root, context, config, configDir, commit, git, binary, herdr, socket, env, entryBin, scopeRoot, state, change, run, claim };
}

function spawnRead(t, f, args) {
  const child = spawn(path.join(f.entryBin, 'herdr-scoped'), args, {
    env: { ...f.env, HERDR_SOCKET_PATH: '/forged', HERDR_BIN_PATH: '/forged', PATH: '/forged' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  return child;
}

test('installed scoped wrapper permits only in-tab layout, bounded stop and committed presets', t => {
  const f = fixture(t); f.claim();
  const good = [ ['pane', 'new'], ['pane', 'split', 'chats:p2', '--direction', 'down'], ['pane', 'rename', 'chats:p2', 'Wallet'],
    ['pane', 'resize', 'chats:p2', '--direction', 'left'], ['pane', 'focus', 'chats:p2', '--direction', 'right'],
    ['preset', 'start', 'wallet', '--pane', 'chats:p2'], ['preset', 'start', 'wallet', '--pane', 'new'], ['pane', 'close', 'chats:p4'], ['pane', 'stop', 'chats:p2'] ];
  for (const args of good) { const r = f.run(args); assert.equal(r.status, 0, JSON.stringify(args) + r.stderr); }
  const calls = f.state().calls;
  assert.deepEqual(calls.filter(a => a[1] === 'send-keys'), [['pane', 'send-keys', 'chats:p2', 'ctrl+c']]);
  assert.deepEqual(calls.filter(a => a[1] === 'run').map(a => a[3]), Array(2).fill(`cd -- '${f.context.canonical}' && /absolute/wallet --fixed`));
  const close = calls.findIndex(a => a[1] === 'close'); assert.equal(calls[close - 1][1], 'get');
  assert.equal(calls[close - 1][2], 'chats:p4');
});

test('another workspace and another chat tab refuse close, stop, split and preset start without input', t => {
  const f = fixture(t); f.claim();
  for (const target of ['agents:p1', 'chats:p3', 'chats:p1', 'chats:p99']) {
    for (const args of [['pane', 'close', target], ['pane', 'stop', target], ['pane', 'split', target, '--direction', 'right'], ['preset', 'start', 'wallet', '--pane', target]]) {
      const r = f.run(args); assert.equal(r.status, 1, JSON.stringify(args)); assert.match(r.stderr, /outside|protected/);
    }
  }
  assert.ok(f.state().calls.every(a => ['get'].includes(a[1])));
  f.change(s => { s.panes[0].tab_id = 'chats:t9'; });
  assert.match(f.run(['pane', 'close', 'chats:p2']).stderr, /chat pane moved/);
});

test('arbitrary input, commands, binding args and undeclared presets refuse even with forged environment', t => {
  const f = fixture(t); f.claim();
  const refused = [ ['pane', 'send-keys', 'chats:p2', 'ctrl+c'], ['pane', 'send-text', 'chats:p2', 'hello'], ['pane', 'run', 'chats:p2', 'true'],
    ['preset', 'start', 'undeclared', '--pane', 'chats:p2'], ['pane', 'close', 'chats:p2', '--binding', '/tmp/forged'],
    ['pane', 'split', 'chats:p2', '--direction', 'right', '--env', 'X=Y'], ['pane', 'split', 'chats:p2', '--direction', 'right', '--cwd', '/tmp'],
    ['pane', 'close', 'chats:p2;id'], ['pane', 'rename', 'chats:p2', 'x\nrun'] ];
  const extra = { HERDR_PANE_ID: 'agents:p1', HERDR_TAB_ID: 'agents:t1', HERDR_WORKSPACE_ID: 'agents', HERDR_BIN_PATH: '/forged',
    HERDR_SOCKET_PATH: '/forged', MONITOR_SCOPED_BINDING: '/forged', MONITOR_RUNTIME_DIR: f.root, PATH: '/forged' };
  for (const args of refused) { const r = f.run(args, extra); assert.equal(r.status, 1, JSON.stringify(args)); }
  assert.equal(f.state().calls.length, 0);
  assert.equal(f.run(['pane', 'rename', 'chats:p2', 'safe'], extra).status, 0, 'forged env cannot redirect legitimate calls');
  const injected = path.join(f.root, 'inject.cjs'); fs.writeFileSync(injected, 'process.exit(42)');
  assert.equal(f.run(['pane', 'list'], { NODE_OPTIONS: `--require=${injected}` }).status, 0);
});

test('binding rejects forged run-temp state, foreign ancestry, PID reuse and unreadable process identity', t => {
  const f = fixture(t);
  const file = fs.readdirSync(f.scopeRoot)[0], binding = JSON.parse(fs.readFileSync(path.join(f.scopeRoot, file)));
  const rows = new Map([[100, { pid: 100, ppid: 50, identity: '100:1', state: 'S' }], [50, { pid: 50, ppid: 0, identity: '50:1', state: 'S' }]]);
  const read = pid => ({ ok: true, value: rows.get(pid) ?? null });
  binding.shell = { pid: 50, identity: '50:1' }; binding.owner = { pid: 100, identity: '100:1' };
  fs.writeFileSync(path.join(f.scopeRoot, file), JSON.stringify(binding));
  assert.equal(callerBinding(f.scopeRoot, { pid: 100, read }).tab, 'chats:t1');
  rows.get(100).identity = '100:2'; assert.throws(() => callerBinding(f.scopeRoot, { pid: 100, read }), /no unique/);
  rows.get(100).identity = '100:1'; rows.get(100).ppid = 0; assert.throws(() => callerBinding(f.scopeRoot, { pid: 100, read }), /no unique/);
  assert.throws(() => callerBinding(f.scopeRoot, { pid: 100, read: () => ({ ok: false, error: 'unknown' }) }), /unavailable/);
  const forgedRoot = path.join(f.root, 'run-temp'); fs.mkdirSync(forgedRoot); fs.writeFileSync(path.join(forgedRoot, file), JSON.stringify({ ...binding, owner: ownerProcess(process.pid), shell: ownerProcess(process.pid) }));
  assert.equal(f.run(['pane', 'close', 'chats:p2'], { MONITOR_SCOPED_BINDING: forgedRoot }).status, 1);
  assert.equal(f.state().calls.length, 0);
});

test('scope is rechecked after stop wait and immediately before preset input; busy and changed panes refuse', () => {
  const binding = { pane: 'chats:p1', tab: 'chats:t1', workspace: 'chats', canonical: '/project' };
  const calls = []; let moved = false, time = 0;
  const call = argv => { calls.push(argv); return JSON.stringify({ result: { pane: { pane_id: argv[2], tab_id: moved && argv[2] === 'chats:p2' ? 'chats:t2' : binding.tab, workspace_id: 'chats' } } }); };
  assert.throws(() => executeScoped(scopedArguments(['pane', 'stop', 'chats:p2']), { binding, call, sleep: ms => { assert.equal(ms, 1000); moved = true; } }), /outside/);
  assert.equal(calls.filter(a => a[1] === 'send-keys').length, 1); assert.equal(calls.filter(a => a[1] === 'close').length, 0);
  moved = false; let readyReads = 0;
  const presetCall = argv => {
    if (argv[1] === 'read') return 'shell % ';
    if (argv[1] === 'process-info') { readyReads++; return JSON.stringify({ result: { process_info: { shell_pid: 10, foreground_processes: [{ pid: readyReads === 3 ? 11 : 10 }] } } }); }
    return call(argv);
  };
  assert.throws(() => executeScoped(scopedArguments(['preset', 'start', 'wallet', '--pane', 'chats:p2']), { binding, call: presetCall, now: () => time, sleep: ms => { time += ms; }, presets: () => ({ wallet: { command: 'fixed', cwd: '/project' } }) }), /became busy/);
  assert.equal(calls.filter(a => a[1] === 'run').length, 0);
});

test('scoped launch uses committed config, protects launcher and binding state and excludes only its wrapper', t => {
  const f = fixture(t);
  const launch = nativeSandboxLaunch({ ...f, kind: 'claude', args: [], warn: () => {} }); t.after(launch.close);
  const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings') + 1]));
  assert.deepEqual(settings.sandbox.excludedCommands, [`${f.entryBin}/herdr-scoped:*`]);
  assert.ok(!settings.sandbox.network.allowUnixSockets.includes(f.socket));
  for (const target of [f.entryBin, path.join(f.context.canonical, '.lane.json'), path.join(f.context.canonical, '.git')]) assert.ok(settings.sandbox.filesystem.denyWrite.includes(target));
  assert.match(entryPolicy({ ...f.context, entryBin: f.entryBin }, new URL('../../', import.meta.url).pathname), /Herdr mode: scoped.*herdr-scoped/s);
  assert.throws(() => nativeSandboxLaunch({ ...f, kind: 'codex', args: [] }), /scoped-mode chats require Claude/);
  for (const sandbox of [{ excludedCommands: ['herdr'] }, { network: { allowAllUnixSockets: true } }, { network: { allowUnixSockets: [f.socket] } }, { enabled: false }])
    assert.throws(() => nativeSandboxLaunch({ ...f, kind: 'claude', args: ['--settings', JSON.stringify({ sandbox })], warn: () => {} }), /conflicts/);
  const config = structuredClone(f.config); config.chat.presets.wallet.command = 'uncommitted arbitrary';
  fs.writeFileSync(path.join(f.context.canonical, '.lane.json'), JSON.stringify(config));
  assert.equal(chatHerdrMode(f.context), 'scoped'); assert.equal(chatHerdrPresets(f.context).wallet.command, '/absolute/wallet --fixed');
  config.chat.herdr_mode = 'full'; fs.writeFileSync(path.join(f.context.canonical, '.lane.json'), JSON.stringify(config));
  assert.throws(() => chatHerdrMode(f.context), /differs from committed HEAD/);
});

test('scoped grammar retains read-mode reads anywhere and denies targetless/default-focus mutation', t => {
  const f = fixture(t); f.claim();
  for (const args of [['pane', 'read', 'agents:p1'], ['pane', 'list'], ['tab', 'list', '--workspace', 'agents'], ['pane', 'wait-output', 'agents:p1', '--match', 'ready', '--timeout', '100']])
    assert.equal(f.run(args).status, 0);
  for (const args of [['pane', 'close'], ['pane', 'stop', '--current'], ['tab', 'close', 'chats:t1'], ['pane', 'focus', 'chats:p2'], ['pane', 'resize', 'chats:p2', '--amount', '1']]) assert.throws(() => scopedArguments(args));
});

test('scoped reads require the caller binding before invoking Herdr', t => {
  const f = fixture(t);
  const result = f.run(['pane', 'list']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /caller has no unique live launcher-owned chat binding/);
  assert.equal(f.state().calls.length, 0);
});

test('scoped wait-output without a timeout can outlive ten seconds', async t => {
  const f = fixture(t); f.claim();
  f.change(s => { s.waitMs = 11000; });
  const child = spawnRead(t, f, ['pane', 'wait-output', 'agents:p1', '--match', 'ready']);
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const started = Date.now();
  const [code, signal] = await once(child, 'close');
  assert.equal(code, 0, errors); assert.equal(signal, null);
  assert.ok(Date.now() - started >= 11000);
  assert.equal(JSON.parse(output).ok, true);
  assert.deepEqual(f.state().calls, [['pane', 'wait-output', 'agents:p1', '--match', 'ready']]);
});

test('scoped read streams stdout and stderr before completion with no eight MiB cap', async t => {
  const f = fixture(t); f.claim();
  const finish = path.join(f.root, 'finish-stream');
  f.change(s => { s.streamFile = finish; });
  const child = spawnRead(t, f, ['pane', 'read', 'agents:p1']);
  const closed = once(child, 'close');
  const firstOutput = once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
  const firstError = once(child.stderr, 'data', { signal: AbortSignal.timeout(5000) });
  let bytes = 0, tail = '';
  child.stdout.on('data', data => { bytes += data.length; tail = (tail + data).slice(-5); });
  const [[stdout], [stderr]] = await Promise.all([firstOutput, firstError]);
  assert.equal(stdout.toString(), 'first\n'); assert.equal(stderr.toString(), 'streaming\n');
  assert.equal(child.exitCode, null);
  fs.writeFileSync(finish, 'finish');
  assert.deepEqual(await closed, [0, null]);
  assert.equal(bytes, 6 + 9 * 1024 * 1024 + 5); assert.equal(tail, 'last\n');
  assert.deepEqual(f.state().calls, [['pane', 'read', 'agents:p1']]);
});

test('scoped read forwards signals and propagates the Herdr exit code', async t => {
  const f = fixture(t); f.claim();
  f.change(s => { s.signalRead = true; });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const child = spawnRead(t, f, ['pane', 'read', 'agents:p1']);
    const closed = once(child, 'close');
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    const [ready] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) }); assert.equal(ready.toString(), 'ready\n');
    child.kill(signal);
    const [code, killed] = await closed;
    assert.equal(code, 23, errors); assert.equal(killed, null);
    assert.equal(output, `ready\n${signal}\n`);
  }
});

test('scoped focus refuses absent or malformed neighbors before their membership lookup', t => {
  const f = fixture(t); f.claim();
  for (const neighbor of [null, '', 'invalid-pane', '--current', ['chats:p2']]) {
    f.change(s => { s.neighbor = neighbor; s.calls = []; });
    const result = f.run(['pane', 'focus', 'chats:p2', '--direction', 'right']);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /scoped Herdr refused: no focus neighbor/);
    assert.deepEqual(f.state().calls, [['pane', 'get', 'chats:p1'], ['pane', 'get', 'chats:p2'],
      ['pane', 'neighbor', '--pane', 'chats:p2', '--direction', 'right']]);
  }
});

test('native Claude honours scoped exclusion and protects the binding while raw sockets stay denied', {
  skip: !process.env.MONITOR_TEST_CLAUDE_SCOPED && 'set MONITOR_TEST_CLAUDE_SCOPED outside a nested sandbox (no model or host slot)',
}, t => {
  const f = fixture(t), binary = process.env.MONITOR_TEST_CLAUDE_SCOPED;
  const launch = nativeSandboxLaunch({ ...f, kind: 'claude', binary, args: ['--setting-sources', ''], warn: () => {} }); t.after(launch.close);
  const result = nativeScopedProbe({ binary, launch, context: f.context, entryBin: f.entryBin, socket: f.socket, root: f.root });
  assert.equal(result.status, 0, result.stdout + result.stderr); t.diagnostic(result.stdout.trim());
});


test('installed scoped chat adapter claims only launcher ancestry and releases its owner on exit', t => {
  const f=fixture(t);fixtureFleet(t,f.root);initOrg(f.context.org);
  joinFleet({cwd:f.context.workspace,record:f.context.org,temp:f.context.tempRoot,worktrees:f.context.worktrees});
  fs.writeFileSync(f.binary,`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('--help'))console.log('--settings');
else if(args.includes('--version'))console.log('2.1.295');
else console.log(JSON.stringify({args,settings:JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1]))}));
`,{mode:0o755});
  const run=()=>spawnSync(path.join(f.entryBin,'monitor-claude'),['--repo',f.context.workspace,'--role','chat','--','--print','offline'],{
    env:{...f.env,HERDR_MONITOR_FLEET:process.env.HERDR_MONITOR_FLEET,MONITOR_ENTRY_BYPASS:'1'},cwd:f.context.workspace,encoding:'utf8'});
  const result=run();assert.equal(result.status,0,result.stderr);
  const got=JSON.parse(result.stdout);
  assert.deepEqual(got.settings.sandbox.excludedCommands,[`${f.entryBin}/herdr-scoped:*`]);
  assert.match(got.args[got.args.indexOf('--append-system-prompt')+1],/Herdr mode: scoped/);
  const bindingFile=path.join(f.scopeRoot,fs.readdirSync(f.scopeRoot)[0]);
  assert.equal(JSON.parse(fs.readFileSync(bindingFile)).owner,undefined);
  const binding=JSON.parse(fs.readFileSync(bindingFile));binding.shell.identity+='-forged';fs.writeFileSync(bindingFile,JSON.stringify(binding));
  const forged=run();assert.equal(forged.status,1);assert.match(forged.stderr,/no unique launcher shell binding/);
});

test('invalid committed presets and corrupt refs fail closed while uncommitted presets never widen the wrapper', t => {
  const f=fixture(t);
  for(const preset of [{command:'fixed',cwd:'relative'}, {command:'fixed\nextra',cwd:f.context.canonical}, {command:'fixed',cwd:f.context.canonical,args:['user-input']}]) {
    const config=structuredClone(f.config);config.chat.presets.wallet=preset;f.commit(config);
    assert.throws(()=>chatHerdrPresets(f.context),/invalid chat preset/);
  }
  f.commit(f.config);f.claim();
  const config=structuredClone(f.config);config.chat.presets.other={command:'arbitrary',cwd:f.context.canonical};
  fs.writeFileSync(path.join(f.context.canonical,'.lane.json'),JSON.stringify(config));
  assert.match(f.run(['preset','start','other','--pane','chats:p2']).stderr,/undeclared preset/);
  fs.writeFileSync(path.join(f.context.canonical,'.git/refs/heads/main'),'corrupt\n');
  assert.throws(()=>chatHerdrMode(f.context),/cannot read committed/);
  assert.throws(()=>chatHerdrPresets(f.context),/cannot read committed/);
});


test('pure scoped grammar refuses arbitrary input and all caller-selected control paths', () => {
  for (const args of [['pane','run','chats:p2','arbitrary'], ['pane','send-keys','chats:p2','ctrl+c'], ['pane','send-text','chats:p2','arbitrary'],
    ['pane','close','chats:p2','--socket','/tmp/forged'], ['pane','close','--current'], ['preset','start','wallet','--pane','chats:p2','extra']]) assert.throws(()=>scopedArguments(args));
  assert.deepEqual(scopedArguments(['preset','start','wallet','--pane','new']),{kind:'preset',name:'wallet',target:'new'});
  assert.equal(scopedArguments(['pane','read','foreign:p1']).kind,'read');
});


test('forged Git environment cannot redirect committed preset lookup to an attacker repository', t => {
  const f=fixture(t);f.claim();
  const attack=path.join(f.root,'attack');fs.mkdirSync(attack);
  const git=args=>{const r=spawnSync('git',['-C',attack,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  git(['init','-q','-b','main']);git(['config','user.name','Attacker']);git(['config','user.email','test@example.invalid']);
  fs.writeFileSync(path.join(attack,'.lane.json'),JSON.stringify({chat:{herdr_mode:'full',presets:{evil:{command:'arbitrary command',cwd:attack},wallet:{command:'arbitrary replacement',cwd:attack}}}}));
  git(['add','.lane.json']);git(['commit','-qm','forged']);
  const env={GIT_DIR:path.join(attack,'.git'),GIT_WORK_TREE:attack,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.worktree',GIT_CONFIG_VALUE_0:attack,GIT_REPLACE_REF_BASE:'refs/attacker',GIT_OBJECT_DIRECTORY:path.join(attack,'.git/objects')};
  const unknown=f.run(['preset','start','evil','--pane','chats:p2'],env);assert.equal(unknown.status,1);assert.match(unknown.stderr,/undeclared preset/);
  const fixed=f.run(['preset','start','wallet','--pane','chats:p2'],env);assert.equal(fixed.status,0,fixed.stderr);
  const runs=f.state().calls.filter(a=>a[1]==='run');assert.equal(runs.length,1);assert.ok(runs[0][3].endsWith('&& /absolute/wallet --fixed'));
});
