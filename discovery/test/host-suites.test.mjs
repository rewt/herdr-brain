import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { hostSuitePlan, validateHostDeclarations, canonicalHostSuites } from '../../lanes/host-suites.mjs';
import { resolveValidation } from '../../lanes/validation.mjs';
import { sandboxCommand } from '../confinement.mjs';
import { createEntry, command } from '../runtime.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';

function fixture(t) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-')));
  fixtureFleet(t, scratch);
  const hostTemp = fs.mkdtempSync('/private/tmp/hst-');
  const entries = [];
  t.after(() => { for (const entry of entries) entry.close(); fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(hostTemp, { recursive: true, force: true }); });
  const repo = path.join(scratch, 'repo'), lane = path.join(scratch, 'lane'); fs.mkdirSync(repo);
  const git = (args, cwd = repo) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Host suites test']); git(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.lane/\n.org/\n');
  const declared = { fast: 'true', promotion: 'true', host_suites: { sockets: { command: 'node probe.cjs', localhost: true, unix_sockets: true, pty: true, temp: true } }, tier_suites: { fast: ['sockets'], promotion: ['sockets'] } };
  fs.writeFileSync(path.join(repo, '.lane.validation.json'), JSON.stringify(declared));
  fs.writeFileSync(path.join(repo, '.lane.json'), JSON.stringify({ main: 'main' }));
  fs.writeFileSync(path.join(repo, 'probe.cjs'), 'console.log("host probe");');
  git(['add', '.']); git(['commit', '-qm', 'Host declarations']); git(['worktree', 'add', '-qb', 'lane/test', lane]);
  const env = { ...process.env, MONITOR_REQUEST_DIR: '', LANE_CONFIG: path.join(repo, '.lane.json'),
    MONITOR_TEST_SLOT_PATH: path.join(scratch, 'fixture-slot'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(scratch, 'fixture-slot'),
    MONITOR_TEST_SLOT_TOKEN: '', BCH_CLOAK_TEST_SLOT_TOKEN: '', MONITOR_TEST_SLOT_WAIT_SECONDS: '0', MONITOR_HOST_TEMP: hostTemp };
  delete env.LANE_VALIDATE;
  return { scratch, repo, lane, git, declared, env, entries };
}

test('host authority requires committed canonical declarations and matching lane policy', t => {
  const f = fixture(t);
  assert.equal(hostSuitePlan(f.lane, ['sockets'])[0].external_network.length, 0);
  assert.deepEqual(resolveValidation({ root: f.repo, env: {} }).tiers.fast.hostSuites, ['sockets']);
  assert.throws(() => hostSuitePlan(f.lane, ['unknown']), /undeclared/);
  fs.writeFileSync(path.join(f.lane, '.lane.validation.json'), JSON.stringify({ ...f.declared, host_suites: { sockets: { command: 'true' } } }));
  f.git(['add', '.'], f.lane); f.git(['commit', '-qm', 'Worker override'], f.lane);
  assert.throws(() => hostSuitePlan(f.lane, ['sockets']), /lane-edited/);
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ ...f.declared, host_suites: { sockets: { command: 'true' } } }));
  assert.throws(() => canonicalHostSuites(f.repo), /committed canonical/);
  assert.throws(() => resolveValidation({ root: f.repo, config: { validation: { host_suites: {} } } }), /committed canonical/);
});

test('capability declarations and external endpoint allowlists reject broad grants', () => {
  for (const suite of [{ command: 'true', external_network: true }, { command: 'true', external_network: ['*:443'] },
    { command: 'true', external_network: ['example.com:0'] }, { command: 'true', pty: 'yes' }, { command: 'true', cwd: '/tmp' }])
    assert.throws(() => validateHostDeclarations({ host_suites: { probe: suite } }));
  assert.doesNotThrow(() => validateHostDeclarations({ host_suites: { probe: { command: 'true', external_network: ['example.com:443', '[::1]:1234'] } } }));
});

test('host profile protects writes and scopes sockets, PTYs and signals; unsupported policy refuses', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.scratch, 'temp'));
  const suite = hostSuitePlan(f.lane, ['sockets'])[0];
  if (process.platform !== 'darwin') return t.skip('macOS Seatbelt profile');
  const profile = sandboxCommand('/usr/bin/sandbox-exec', f.lane, { sharedPaths: [path.join(f.repo, '.git'), path.join(f.repo, '.lane')], temporaryPaths: [path.join(f.scratch, 'temp')], hostSuite: suite }).args[1];
  assert.match(profile, /remote ip "localhost:\*"/); assert.doesNotMatch(profile, /remote ip "\*:\*"/);
  assert.match(profile, /network-bind \(local unix-socket \(subpath/); assert.match(profile, /allow pseudo-tty/);
  assert.match(profile, /require-all \(regex #"\^\/dev\/ttys"\) \(extension "com.apple.sandbox.pty"\)/);
  assert.doesNotMatch(profile, /\(literal "\/dev\/ptmx"\) \(regex/);
  assert.match(profile, /deny file-read\* file-ioctl \(literal "\/dev\/tty"\) \(literal "\/dev\/console"\)/);
  assert.match(profile, /deny signal mach-priv-task-port/); assert.match(profile, /target same-sandbox/);
  assert.throws(() => sandboxCommand('codex', f.lane, { sharedPaths: [f.repo], temporaryPaths: [path.join(f.scratch, 'temp')], hostSuite: suite }), /HOST_PROFILE_UNAVAILABLE/);
  assert.throws(() => sandboxCommand('/usr/bin/sandbox-exec', f.lane, { sharedPaths: [f.repo], temporaryPaths: [path.join(f.scratch, 'temp')], hostSuite: { ...suite, external_network: ['example.com:443'] } }), /cannot enforce/);
});

test('session request carries only a suite name and rejects execution inputs', t => {
  const f = fixture(t), entry = createEntry({ cwd: f.repo, sandboxBinary: '/usr/bin/sandbox-exec', runtimeDir: path.join(f.scratch, 'runtime'), worktreeRoot: path.join(f.scratch, 'worktrees') });
  f.entries.push(entry);
  entry.dispatch({ op: 'start', text: 'Exercise declared host suites offline' });
  for (const request of [{ op: 'check', suite: '../x' }, { op: 'check', suite: 'sockets', command: 'true' },
    { op: 'check', text: 'true' }, { op: 'commit', suite: 'sockets' }, { op: 'check', suite: 'sockets', text: 'true' }])
    assert.throws(() => entry.dispatch(request), /fields|name only|command text/);
  assert.throws(() => entry.dispatch({ op: 'check', suite: 'missing' }), /undeclared/);
});

const cli = new URL('../../lanes/lane.mjs', import.meta.url).pathname;
test('session lane check refuses non-suite options before writing a request and documents its restriction', t => {
  const f = fixture(t), requests = path.join(f.scratch, 'requests'); fs.mkdirSync(requests);
  for (const args of [['--tier', 'promotion'], ['--cmd', 'true'], ['--suite', 'sockets', '--tier', 'fast'],
    ['--suite'], ['--suite', '../escape'], ['--suite=sockets'], ['extra']]) {
    const result = spawnSync(process.execPath, [cli, 'check', ...args], { cwd: f.lane, env: { ...f.env, MONITOR_REQUEST_DIR: requests }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /inside a session, lane check accepts no options or --suite NAME only/);
    assert.deepEqual(fs.readdirSync(requests), []);
  }
  const help = spawnSync(process.execPath, [cli], { cwd: f.lane, env: f.env, encoding: 'utf8' });
  assert.match(help.stdout, /inside a session: no options or --suite NAME only/);
});

// Promotion/release run these automatically on capable macOS hosts. The probe
// also detects a nested worker sandbox: spawning sandbox-exec must be possible.
function hostProbe() {
  if (process.platform !== 'darwin') return 'macOS Seatbelt host profile required';
  const result = spawnSync(process.execPath, ['-e', `
    const fs=require('fs'),net=require('net'),cp=require('child_process');
    try {const fd=fs.openSync('/dev/ptmx','r+');fs.closeSync(fd);
      const native=cp.spawnSync('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)','/usr/bin/true'],{encoding:'utf8'});
      if(native.status!==0)throw Error(native.error?.message||native.stderr||'sandbox-exec exit '+native.status);
      const server=net.createServer();server.once('error',e=>{console.error(e.message);process.exitCode=1});
      server.listen(0,'127.0.0.1',()=>server.close());
    } catch(e) {console.error(e.message);process.exitCode=1}
  `], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 ? false : `host probe cannot run: ${result.error?.message || result.stderr.trim() || 'exit ' + result.status}`;
}
const hostSkip = hostProbe();

test('native PTY extension permits own slaves and denies pre-existing terminal writes and state ioctls', {
  skip: hostSkip, timeout: 20000,
}, t => {
  const f = fixture(t), temporary = path.join(f.scratch, 'temp'); fs.mkdirSync(temporary);
  const suite = hostSuitePlan(f.lane, ['sockets'])[0];
  const sandbox = sandboxCommand('/usr/bin/sandbox-exec', f.lane, { sharedPaths: [path.join(f.repo, '.git')], temporaryPaths: [temporary], hostSuite: suite });
  const child = `import os,pty,tty,fcntl,termios,array,errno,sys
m,s=pty.openpty();tty.setraw(s)
os.write(m,b'hello');assert os.read(s,5)==b'hello'
os.write(s,b'world');assert os.read(m,5)==b'world'
fcntl.ioctl(s,termios.FIONREAD,array.array('i',[0]),True)
# Reopening an own slave and using it in a descendant keeps the extension.
fd=os.open(os.ttyname(s),os.O_RDWR);os.close(fd)
pid=os.fork()
if pid==0:
 fd=os.open(os.ttyname(s),os.O_RDWR);tty.setraw(fd);os.close(fd);os._exit(0)
assert os.waitpid(pid,0)[1]==0
for target in [sys.argv[1],sys.argv[3]]:
 for flags in [os.O_RDONLY,os.O_WRONLY,os.O_RDWR]:
  try: os.open(target,flags);raise AssertionError('foreign terminal opened')
  except OSError as e: assert e.errno in [errno.EPERM,errno.EACCES],e
# A read-only inherited fixture fd tests state ioctls independently of the open
# denial. No foreign writable terminal descriptor reaches the suite.
foreign=int(sys.argv[2])
for operation in [lambda:termios.tcsetattr(foreign,termios.TCSANOW,termios.tcgetattr(foreign)),lambda:fcntl.ioctl(foreign,termios.TIOCSTI,b'x')]:
 try: operation();raise AssertionError('foreign terminal state ioctl allowed')
 except (OSError,termios.error) as e: assert e.args[0] in [errno.EPERM,errno.EACCES],e
os.close(m);os.close(s)
print('OWN_PTY_PASS FOREIGN_OPEN_AND_STATE_IOCTL_DENIED')
`;
  const recycle = `import os,pty,sys,errno
m,s=pty.openpty();print(os.ttyname(s),flush=True);os.close(m);os.close(s);print('CLOSED',flush=True)
foreign=input()
try: os.open(foreign,os.O_RDWR);raise AssertionError('stale extension opened foreign slave')
except OSError as e: assert e.errno in [errno.EPERM,errno.EACCES],e
print('RECYCLED_FOREIGN_OPEN_DENIED',flush=True)
`;
  const parent = `import os,pty,subprocess,sys
m,s=pty.openpty();foreign=os.ttyname(s);readonly=os.open(foreign,os.O_RDONLY)
alias=os.path.join(sys.argv[1],'foreign-tty');os.symlink(foreign,alias)
try:
 result=subprocess.run(['/usr/bin/sandbox-exec','-p',sys.argv[2],'/usr/bin/python3','-c',sys.argv[3],foreign,str(readonly),alias],pass_fds=[readonly],stdin=subprocess.DEVNULL,timeout=10)
 if result.returncode==0:
  child=subprocess.Popen(['/usr/bin/sandbox-exec','-p',sys.argv[2],'/usr/bin/python3','-c',sys.argv[4]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
  try:
   old=child.stdout.readline().strip();assert child.stdout.readline().strip()=='CLOSED'
   newmaster,newslave=pty.openpty()
   try:
    new=os.ttyname(newslave);output,_=child.communicate(new+'\\n',timeout=5)
    assert child.returncode==0 and 'RECYCLED_FOREIGN_OPEN_DENIED' in output
    print('PTY_REUSE old='+old+' foreign='+new+' '+output.strip())
   finally: os.close(newmaster);os.close(newslave)
  finally:
   if child.poll() is None: child.kill();child.wait()
finally:
 os.close(readonly);os.close(m);os.close(s);os.unlink(alias)
raise SystemExit(result.returncode)
`;
  const result = spawnSync('/usr/bin/python3', ['-c', parent, f.lane, sandbox.args[1], child, recycle], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OWN_PTY_PASS FOREIGN_OPEN_AND_STATE_IOCTL_DENIED/);
  assert.match(result.stdout, /RECYCLED_FOREIGN_OPEN_DENIED/);
  console.log(result.stdout.trim());
});

test('sandboxed worker asks the host parent; raw PTYs, TCP/Unix listeners, receipts and boundaries are exercised offline', {
  skip: hostSkip, timeout: 60000,
}, async t => {
  const f = fixture(t), outsider = path.join(f.scratch, 'outside'), sibling = path.join(f.scratch, 'outside.sock');
  const helper = `import os,pty,tty,fcntl,termios,array,time\ns=time.monotonic()\nfor i in range(100):\n m,n=pty.openpty();tty.setraw(n);os.write(m,b'hello');a=array.array('i',[0]);fcntl.ioctl(n,termios.FIONREAD,a,True);os.close(m);os.close(n)\nprint('PTY100_MS='+str((time.monotonic()-s)*1000))\n`;
  const baseline = spawnSync('/usr/bin/python3', ['-c', helper], { encoding: 'utf8' });
  assert.equal(baseline.status, 0, baseline.stderr);
  console.log('UNSANDBOXED_' + baseline.stdout.trim());
  const probe = `const fs=require('fs'),net=require('net'),path=require('path'),assert=require('assert'),cp=require('child_process');
const denied=e=>['EPERM','EACCES'].includes(e.code);
assert.equal(require('os').tmpdir(),process.env.TMPDIR);
assert.equal(fs.fstatSync(0).rdev,fs.statSync('/dev/null').rdev);
for(const target of [${JSON.stringify(outsider)},'/private/tmp/herdr-host-forbidden-'+process.pid,'.git',${JSON.stringify(path.join(f.repo, '.git/config'))},${JSON.stringify(path.join(f.repo, '.lane/injected'))},${JSON.stringify(path.join(f.repo, '.org/events.jsonl'))}])assert.throws(()=>fs.writeFileSync(target,'bad'),denied,target);
fs.writeFileSync('ordinary','ok');fs.unlinkSync('ordinary');fs.writeFileSync(path.join(process.env.TMPDIR,'ok'),'ok');

assert.throws(()=>process.kill(Number(process.env.OUTSIDER_PID),'SIGCONT'),denied);
const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)']);const listed=cp.spawnSync('/usr/bin/pgrep',['-P',String(process.pid)],{encoding:'utf8'});assert.equal(listed.status,0,listed.stderr);assert(listed.stdout.split('\\n').includes(String(child.pid)));child.kill('SIGTERM');
const py=cp.spawnSync('/usr/bin/python3',['-c',${JSON.stringify(helper)}],{encoding:'utf8'});assert.equal(py.status,0,py.stderr);console.log(py.stdout);
async function listener(address){const server=net.createServer();await new Promise((r,j)=>{server.once('error',j);typeof address==='string'?server.listen(address,r):server.listen(0,'127.0.0.1',r)});const client=typeof address==='string'?net.connect(address):net.connect(server.address().port,'127.0.0.1');await new Promise((r,j)=>{client.once('connect',r);client.once('error',j)});client.destroy();await new Promise(r=>server.close(r));}
(async()=>{await listener(null);await listener(path.join(process.env.TMPDIR,'fixture.sock'));await new Promise(r=>{const server=net.createServer();server.once('error',e=>{assert(denied(e));r()});server.listen(${JSON.stringify(sibling)},()=>{server.close();throw Error('escaped Unix bind')})});await new Promise(r=>{const client=net.connect({host:'192.0.2.1',port:443});client.once('error',e=>{assert(denied(e));r()});client.setTimeout(1000,()=>{client.destroy();throw Error('external network was not denied')})});console.log('HOST_BOUNDARIES_PASS')})().catch(e=>{console.error(e);process.exitCode=1});`;
  fs.writeFileSync(path.join(f.repo, 'probe.cjs'), probe); f.git(['add', '.']); f.git(['commit', '-qm', 'Host capability fixture']);
  f.git(['rebase', 'main'], f.lane);
  const entry = createEntry({ cwd: f.repo, sandboxBinary: '/usr/bin/sandbox-exec', runtimeDir: path.join(f.scratch, 'runtime'), worktreeRoot: path.join(f.scratch, 'worktrees') });
  f.entries.push(entry);
  entry.dispatch({ op: 'start', text: 'Exercise declared host suites offline' });
  process.env.OUTSIDER_PID = String(process.pid); t.after(() => delete process.env.OUTSIDER_PID);
  const recordBefore = fs.readFileSync(path.join(f.repo, '.org/events.jsonl'));
  // Parent is outside Seatbelt; the request writer runs in the ordinary worker
  // profile (no listeners, PTYs or outside writes), communicating through files.
  const requests = entry.context().requests;
  const worker = sandboxCommand('/usr/bin/sandbox-exec', entry.context().workspace, { sharedPaths: [path.join(f.repo, '.git')], temporaryPaths: [requests] });
  const child = spawnChild(t, worker.binary, [...worker.args, process.execPath, cli, 'check', '--suite', 'sockets'], {
    cwd: entry.context().workspace, env: { ...process.env, MONITOR_REQUEST_DIR: requests },
  });
  const done = waitForExit(child);
  let requestFile;
  const deadline = Date.now() + 5000;
  while (!requestFile && Date.now() < deadline) {
    const name = fs.readdirSync(requests).find(name => name.endsWith('.request.json'));
    if (name) requestFile = path.join(requests, name);
    else await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert(requestFile, 'sandboxed lane check reaches the session parent');
  assert.deepEqual(JSON.parse(fs.readFileSync(requestFile, 'utf8')), { op: 'check', suite: 'sockets' });
  const old = Object.fromEntries(['MONITOR_TEST_SLOT_PATH','MONITOR_TEST_SLOT_COMPAT_PATH','MONITOR_TEST_SLOT_TOKEN','BCH_CLOAK_TEST_SLOT_TOKEN','MONITOR_TEST_SLOT_WAIT_SECONDS'].map(key=>[key,process.env[key]]));
  Object.assign(process.env,Object.fromEntries(Object.keys(old).map(key=>[key,f.env[key]])));
  let output;
  try { output=entry.dispatch(JSON.parse(fs.readFileSync(requestFile,'utf8'))); fs.writeFileSync(requestFile.replace('.request.json','.reply.json'),JSON.stringify({result:output})); }
  finally { for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value; }
  const response = await done; assert.equal(response.code,0,response.stderr);
  assert.match(response.stdout,/HOST_BOUNDARIES_PASS/);
  assert.match(output,/HOST_BOUNDARIES_PASS/);assert.match(output,/PTY100_MS=/);
  const gate=JSON.parse(fs.readFileSync(path.join(entry.context().workspace,'.lane/gate.json'),'utf8'));
  assert.equal(gate.exit_code,0);assert.equal(gate.host_suites[0].name,'sockets');assert.equal(gate.host_suites[0].external_network.length,0);assert.match(gate.host_suites[0].tcp_listener_limit,/Wildcard binds can accept non-loopback inbound/);
  assert.match(gate.host_suites[0].pty_limit,/slaves allocated in the suite sandbox via com.apple.sandbox.pty/);
  assert.match(fs.readFileSync(gate.log,'utf8'),/opening other existing terminal slaves/);
  assert.equal(gate.head,command('git',['rev-parse','HEAD'],entry.context().workspace));
  assert.match(fs.readFileSync(gate.log,'utf8'),/HOST_BOUNDARIES_PASS/);
  assert.deepEqual(fs.readFileSync(path.join(f.repo,'.org/events.jsonl')),recordBefore);
  assert.equal(fs.existsSync(outsider),false);assert.equal(fs.existsSync(sibling),false);
  assert.equal(fs.existsSync(f.env.MONITOR_TEST_SLOT_PATH),false);
  assert.deepEqual(fs.readdirSync(entry.context().tempRoot).filter(name=>name.startsWith('r-')), []);
  // A tier declaration selects the same name, and reuses its bound receipt.
  Object.assign(process.env,Object.fromEntries(Object.keys(old).map(key=>[key,f.env[key]])));
  try { assert.match(entry.dispatch({op:'check'}),/REUSE/); }
  finally { for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value; }
  console.log(output.match(/PTY100_MS=[^\n]+/)[0]);
});


test('host watchdog binds a timeout receipt and removes private temp after killing the suite', {
  skip: hostSkip, timeout: 20000,
}, t => {
  const f = fixture(t);
  f.declared.timeout_seconds = { fast: 2 };
  f.declared.host_suites.sockets.command = "node -e \"console.log('HOST_STARTED');setInterval(()=>{},1000)\"";
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify(f.declared));
  f.git(['add', '.']); f.git(['commit', '-qm', 'Bounded host fixture']); f.git(['rebase', 'main'], f.lane);
  const result = spawnSync(process.execPath, [cli, 'check', '--suite', 'sockets'], { cwd: f.lane, env: f.env, encoding: 'utf8', timeout: 12000 });
  assert.equal(result.status, 124, result.stdout + result.stderr);
  const gate = JSON.parse(fs.readFileSync(path.join(f.lane, '.lane/gate.json'), 'utf8'));
  assert.equal(gate.outcome, 'timeout'); assert.equal(gate.gate_timeout.kind, 'wall');
  assert.match(fs.readFileSync(gate.log, 'utf8'), /HOST_STARTED/);
  assert.deepEqual(fs.readdirSync(f.env.MONITOR_HOST_TEMP), []);
  assert.equal(fs.existsSync(f.env.MONITOR_TEST_SLOT_PATH), false);
});


test('unenforceable external allowlist refuses before the slot, command and receipt', t => {
  const f = fixture(t);
  f.declared.host_suites.sockets.external_network = ['example.com:443'];
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify(f.declared));
  f.git(['add', '.']); f.git(['commit', '-qm', 'TCP policy fixture']); f.git(['rebase', 'main'], f.lane);
  const result = spawnSync(process.execPath, [cli, 'check', '--suite', 'sockets'], { cwd: f.lane, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HOST_PROFILE_UNAVAILABLE/);
  assert.equal(fs.existsSync(f.env.MONITOR_TEST_SLOT_PATH), false);
  assert.equal(fs.existsSync(path.join(f.lane, '.lane/gate.json')), false);
});
