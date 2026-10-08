import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { permissionProject, permissionDecision, DENIAL_NUDGE } from '../lib/permission-policy.mjs';
import { auditPermission } from '../lib/permission-audit.mjs';
import { handlePermission, permissionHookArguments } from '../../supervisor/permission-hooks.mjs';
import { noticeLock } from '../../supervisor/notice-lock.mjs';
import { nativeSandboxLaunch } from '../../discovery/native-sandbox.mjs';
import { fallbackRequest, declineObserved } from '../lib/permission-fallback.mjs';
import { gitProject } from '../../lib/project.mjs';
import { parseScreen } from '../lib/capture.mjs';
const root = new URL('../../', import.meta.url).pathname;
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'sp-'));
  t.after(() => fs.rmSync(scratch, { force: true, recursive: true }));
  const repo = name => {
    const checkout = path.join(scratch, name); fs.mkdirSync(checkout);
    execFileSync('git', ['-C', checkout, 'init', '-q']);
    execFileSync('git', ['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '--allow-empty', '-qm', 'seed']);
    const areas = Object.fromEntries(['record','worktrees','temp'].map(key => [key,path.join(scratch, `${name}-${key}`)]));
    Object.values(areas).forEach(dir => fs.mkdirSync(dir));
    return { checkout, identity: gitProject(checkout).identity, ...areas, layers: [] };
  };
  const own = repo('own'), peer = repo('peer'), fleet = path.join(scratch, 'fleet'); fs.mkdirSync(fleet);
  fs.writeFileSync(path.join(fleet, 'fleet.json'), JSON.stringify({ version: 1, session_limit: 6, projects: { own, peer } }));
  const env = { ...process.env, HERDR_MONITOR_FLEET: fleet, BRAIN_STATE: path.join(scratch, 'brain'), CODEX_HOME: path.join(scratch,'codex'), CLAUDE_CONFIG_DIR: path.join(scratch,'claude') };
  for (const key of ['HERDR_MONITOR_FLEET','BRAIN_STATE','CODEX_HOME','CLAUDE_CONFIG_DIR']) {
    const before = process.env[key]; process.env[key] = env[key];
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
    fs.mkdirSync(env[key], { recursive: true });
  }
  fs.writeFileSync(path.join(env.BRAIN_STATE,'steward.json'), JSON.stringify({ alert_command: [process.execPath, '/unused-offline-alert'] }));
  const runTemp = path.join(own.temp, 'run'); fs.mkdirSync(runTemp);
  const binding = { kind: 'claude', workspace: own.checkout, canonical: own.checkout, identity: own.identity, org: own.record, runTemp, session: 'native-worker' };
  const file = (dir, name = 'report.md') => { const target = path.join(dir, name); fs.writeFileSync(target, 'report'); return target; };
  const event = target => ({ hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: { file_path: target }, cwd: own.checkout, session_id: 'native-id' });
  return { scratch, own, peer, env, binding, runTemp, file, event, project: permissionProject(own.checkout, env) };
}
const decide = (f, event) => permissionDecision(event, { kind: 'claude', project: f.project, runTemp: f.runTemp });

test('native reads of checkout, record, lanes and this launch temp are the only approved class', t => {
  const f = fixture(t);
  for (const dir of [f.own.checkout, f.own.record, f.own.worktrees, f.runTemp]) assert.equal(decide(f, f.event(f.file(dir))).behavior, 'allow');
  const lane = path.join(f.own.worktrees,'linked'); execFileSync('git',['-C', f.own.checkout, 'worktree','add','-qb','lane', lane]);
  const event = { ...f.event(f.file(lane)), cwd: lane };
  assert.equal(decide(f, event).behavior, 'allow');
  assert.equal(permissionProject(lane, f.env).identity, f.own.identity);
  assert.equal(decide(f, f.event(f.file(f.own.temp))).behavior, 'deny', 'other run temps are excluded');
  assert.equal(permissionDecision(event, { kind: 'codex', project: f.project }).behavior,'deny');
});

test('foreign paths, traversal, symlink escapes, stale bindings and unknown input fail closed', async t => {
  const f = fixture(t), foreign = f.file(f.peer.checkout), safe = f.file(f.own.checkout);
  const link = path.join(f.own.checkout,'alias'); fs.symlinkSync(foreign,link);
  for (const target of [foreign, link, path.join(f.own.checkout,'../peer/report.md'), '/does/not/exist']) assert.equal(decide(f,f.event(target)).behavior,'deny');
  assert.equal(decide(f,{ ...f.event(safe), cwd: f.peer.checkout }).behavior,'deny');
  assert.equal(decide(f,{ ...f.event(safe), tool_input: { file_path:safe, command:'cat safe' } }).behavior,'deny');
  for (const tool_name of ['Bash','Glob','Grep','mcp__fs__Read','Write','apply_patch']) assert.equal(decide(f,{ ...f.event(safe), tool_name }).behavior,'deny');
  for (const event of [null, {}, {tool_input:null}, { ...f.event(safe),hook_event_name:'PreToolUse' }]) assert.equal(decide(f,event).behavior,'deny');
  const result = await handlePermission(f.event(safe),{ ...f.binding,identity:f.peer.identity },{env:f.env,home:f.env.BRAIN_STATE});
  assert.equal(result.output.hookSpecificOutput.decision.behavior,'deny');
});

test('never-list requests decline with an operator nudge and alert, including credential aliases', t => {
  const f = fixture(t);
  for (const command of ['cat .env','wallet payto fusion_chipnet','bitcoin-cli sendrawtransaction abc','git push','npm publish','deploy production','sudo cat report','chmod 777 file','trust hooks.json']) {
    const d = decide(f,{ ...f.event('ignored'),tool_name:'Bash',tool_input:{command} });
    assert.equal(d.behavior,'deny',command); assert.equal(d.alert,true,command); assert.match(d.message,/Do not work around/); assert.match(d.message,/record ask/);
  }
  const key = f.file(f.own.checkout,'.env'), alias = path.join(f.own.checkout,'ordinary'); fs.symlinkSync(key,alias);
  assert.equal(decide(f,f.event(alias)).alert,true);
  assert.equal(decide(f,{ ...f.event('ignored'),tool_name:'Bash',tool_input:{command:'cat report.md'} }).behavior,'deny');
});

test('project Read paths with action words allow without an alert, while credential targets deny', async t => {
  const f = fixture(t), alerts = [];
  for (const name of ['release-report.md', 'push.md', 'deploy.md', 'publish.md', 'trust-brief.md', 'transfer.md', 'config.toml', 'hooks.json', 'wallet-guide.md', 'credentials.ts', 'secrets.md', 'seed-phrase.md', 'private-key-guide.md', 'keychain-guide.md', 'packages/app/src/wallet.tsx', 'tools/wallet.mjs']) {
    fs.mkdirSync(path.dirname(path.join(f.own.checkout, name)), { recursive: true });
    const event = f.event(f.file(f.own.checkout, name));
    const decision = decide(f, event);
    assert.equal(decision.behavior, 'allow', name);
    assert.equal(decision.alert, false, name);
    const result = await handlePermission(event, f.binding, { env: f.env, home: f.env.BRAIN_STATE, alert: async p => alerts.push(p) });
    assert.equal(result.output.hookSpecificOutput.decision.behavior, 'allow', name);
    await result.notify?.();
  }
  assert.deepEqual(alerts, []);
  for (const name of ['.env', '.env.local', 'id_ed25519', 'id_rsa.backup', 'private-key.pem', 'server.key', 'keychain.db', 'login.keychain-db', 'wallet.dat', '.ssh/config', '.aws/credentials', 'credentials.json', 'seed-phrase.txt', 'app.credentials.yaml', 'secret.yml', 'prod-secrets.toml', 'credential.p12', 'credentials.pfx', 'secret.jks', 'seed_phrase.keystore']) {
    fs.mkdirSync(path.dirname(path.join(f.own.checkout, name)), { recursive: true });
    const decision = decide(f, f.event(f.file(f.own.checkout, name)));
    assert.equal(decision.behavior, 'deny', name);
    assert.equal(decision.alert, true, name);
  }
  const alias = path.join(f.own.checkout, 'ordinary.json');
  fs.symlinkSync(path.join(f.own.checkout, 'credentials.json'), alias);
  assert.equal(decide(f, f.event(alias)).alert, true, 'resolved credential data aliases alert');
});

test('concurrent permission audits wait for the live holder and preserve both approvals', async t => {
  const f = fixture(t), event = f.event(f.file(f.own.checkout));
  const file = path.join(f.env.BRAIN_STATE, 'steward/permissions.json');
  const release = noticeLock(`${file}.lock`); t.after(release);
  const script = `import { auditPermission } from ${JSON.stringify(new URL('../lib/permission-audit.mjs', import.meta.url).href)};
process.stdout.write('ready\\n');
auditPermission(...JSON.parse(process.argv[1]));`;
  let ready = 0;
  const workers = [0, 1].map(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([f.env.BRAIN_STATE, { ...f.binding, project: 'own' }, event, decide(f, event)])], { env: f.env });
    t.after(() => child.kill());
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => {
      const wasReady = stdout.includes('ready\n'); stdout += chunk;
      if (!wasReady && stdout.includes('ready\n') && ++ready === 2) setTimeout(release, 100);
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => { try { assert.equal(code, 0, stderr); resolve(); } catch (error) { reject(error); } });
  }));
  await Promise.all(workers);
  const audit = JSON.parse(fs.readFileSync(file));
  assert.equal(audit.events.length, 2);
  assert.ok(audit.events.every(e => e.behavior === 'allow'));
  assert.equal(Object.values(audit.sessions)[0].approvals, 2);
});

test('audit precedes native decisions, persists repeated-request and launch approval circuit breakers', async t => {
  const f = fixture(t), event = f.event(f.file(f.own.checkout));
  for (let i = 0; i < 4; i++) {
    const result = await handlePermission(event,f.binding,{env:f.env,home:f.env.BRAIN_STATE,alert:async () => {}});
    assert.equal(result.output.hookSpecificOutput.decision.behavior,i<3?'allow':'deny');
    const data = JSON.parse(fs.readFileSync(path.join(f.env.BRAIN_STATE,'steward/permissions.json')));
    assert.equal(data.events.length,i+1);
  }
  const home = path.join(f.scratch,'other-brain');
  for (let i = 0; i < 33; i++) {
    const e = { ...event,session_id:String(i) };
    const result = auditPermission(home,f.binding,e,decide(f,e));
    assert.equal(result.decision.behavior,i<32?'allow':'deny');
  }
  for (let i = 0; i < 600; i++) auditPermission(home,f.binding,event,{behavior:'deny',reason:'declined',category:'security'});
  const bounded = JSON.parse(fs.readFileSync(path.join(home,'steward/permissions.json')));
  assert.equal(bounded.events.length,512);
  assert.equal(Object.values(bounded.sessions)[0].approvals,32,'compaction cannot reset approvals');
});

test('corrupt audit and disabled configuration deny rather than holding a dialog or granting access', async t => {
  const f = fixture(t), event = f.event(f.file(f.own.checkout));
  fs.writeFileSync(path.join(f.env.BRAIN_STATE,'steward.json'),'{"enabled":false}');
  assert.equal((await handlePermission(event,f.binding,{env:f.env,home:f.env.BRAIN_STATE})).output.hookSpecificOutput.decision.behavior,'deny');
  fs.writeFileSync(path.join(f.env.BRAIN_STATE,'steward/permissions.json'),'{');
  fs.writeFileSync(path.join(f.env.BRAIN_STATE,'steward.json'),'{}');
  assert.equal((await handlePermission(event,f.binding,{env:f.env,home:f.env.BRAIN_STATE})).output.hookSpecificOutput.decision.behavior,'deny');
});

test('command hooks audit absent, malformed and stale launch bindings and malformed requests', t => {
  const f = fixture(t), hook = path.join(root, 'supervisor/permission-hook.mjs');
  const safe = f.event(f.file(f.own.checkout));
  for (const [binding, input] of [[undefined, JSON.stringify(safe)], ['{', JSON.stringify(safe)], ['null', JSON.stringify(safe)], [JSON.stringify({ ...f.binding, identity: f.peer.identity }), JSON.stringify(safe)], [JSON.stringify(f.binding), '{']]) {
    const env = { ...f.env }; delete env.MONITOR_PERMISSION_BINDING;
    if (binding !== undefined) env.MONITOR_PERMISSION_BINDING = binding;
    const result = spawnSync(process.execPath, [hook], { env, input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout).hookSpecificOutput.decision;
    assert.equal(decision.behavior, 'deny'); assert.match(decision.message, /record ask/);
  }
  const audit = JSON.parse(fs.readFileSync(path.join(f.env.BRAIN_STATE, 'steward/permissions.json')));
  assert.equal(audit.events.length, 5);
  assert.ok(audit.events.every(e => e.behavior === 'deny'));
  assert.match(audit.events[0].reason, /Unverified launch binding/);
  assert.match(audit.events.at(-1).reason, /Malformed permission/);
});

test('unloadable hook dependencies and uncaught failures emit a deny and exit 2 with the nudge', t => {
  const f = fixture(t), directory = path.join(f.scratch, 'broken-hook'); fs.mkdirSync(directory);
  const hook = path.join(directory, 'permission-hook.mjs'), dependency = path.join(directory, 'permission-hooks.mjs');
  fs.copyFileSync(path.join(root, 'supervisor/permission-hook.mjs'), hook);
  for (const code of [null, 'export {', "import './missing-dependency.mjs';", 'export function handlePermission() { throw Error("fixture failure"); }']) {
    if (code !== null) fs.writeFileSync(dependency, code);
    const result = spawnSync(process.execPath, [hook], { env: f.env, input: '{}', encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: DENIAL_NUDGE } } });
    assert.ok(result.stderr.includes(DENIAL_NUDGE));
  }
  const oversized = spawnSync(process.execPath, [path.join(root, 'supervisor/permission-hook.mjs')], { env: f.env, input: 'x'.repeat(65537), encoding: 'utf8' });
  assert.equal(oversized.status, 2);
  assert.equal(JSON.parse(oversized.stdout).hookSpecificOutput.decision.behavior, 'deny');
  assert.ok(oversized.stderr.includes(DENIAL_NUDGE));
});

test('alerting command hook exits without waiting for a channel that never returns, after its durable receipt', async t => {
  const f = fixture(t), marker = path.join(f.scratch, 'alert-started.json');
  const channel = path.join(f.scratch, 'hanging-alert.mjs');
  const auditFile = path.join(f.env.BRAIN_STATE, 'steward/permissions.json');
  fs.writeFileSync(channel, `import fs from 'node:fs';
const audit = JSON.parse(fs.readFileSync(${JSON.stringify(auditFile)}));
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, parent: process.ppid, payload: JSON.parse(process.argv[2]), audit }));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);`);
  let alertProcesses = [];
  // The fixture's earlier teardown removes scratch before this callback runs.
  // Retain the owned PIDs in memory so a hanging channel cannot survive it.
  t.after(() => { for (const pid of alertProcesses) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  fs.writeFileSync(path.join(f.env.BRAIN_STATE, 'steward.json'), JSON.stringify({ alert_command: [process.execPath, channel] }));
  // Shell metacharacters remain literal in the detached argv payload.
  const binding = { ...f.binding, session: 'worker $(false) `false` "quoted"' };
  const event = { ...f.event('ignored'), tool_name: 'Bash', tool_input: { command: 'git push' } };
  const invoke = () => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(root, 'supervisor/permission-hook.mjs')], {
      env: { ...f.env, MONITOR_PERMISSION_BINDING: JSON.stringify(binding) }, input: JSON.stringify(event), encoding: 'utf8', timeout: 11000,
    });
    assert.ok(Date.now() - started < 10000, 'hook stays inside its internal budget plus scheduling margin');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const decision = JSON.parse(result.stdout).hookSpecificOutput.decision;
    assert.equal(decision.behavior, 'deny'); assert.match(decision.message, /record ask/);
  };
  invoke();
  const until = Date.now() + 3000;
  while (!fs.existsSync(marker) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(marker), 'detached alert starts');
  const started = JSON.parse(fs.readFileSync(marker));
  alertProcesses = [started.pid, started.parent];
  assert.deepEqual(started.payload, { project: 'own', session: binding.session, kind: 'Publishing request' });
  assert.equal(started.audit.events.length, 1);
  assert.equal(started.audit.events[0].alert_intent, true);
  assert.equal(Object.values(Object.values(started.audit.sessions)[0].alerts)[0], 1);
  assert.ok(Object.values(started.audit.sessions)[0].lastAlert > 0);
  invoke();
  const audit = JSON.parse(fs.readFileSync(auditFile));
  assert.equal(audit.events.length, 2);
  assert.equal(audit.events[1].alert_intent, false, 'durable debounce prevents a second detached alert');
});

test('held audit and dead-owner recovery locks deny within the hook budget', t => {
  const f = fixture(t), event = f.event(f.file(f.own.checkout));
  const lock = path.join(f.env.BRAIN_STATE, 'steward/permissions.json.lock');
  const load = path.join(f.scratch, 'high-load.mjs');
  fs.writeFileSync(load, `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module';
os.loadavg = () => [10000, 10000, 10000]; os.availableParallelism = () => 1; syncBuiltinESMExports();`);
  for (const recovery of [false, true]) {
    if (recovery) {
      fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
    }
    const release = noticeLock(recovery ? `${lock}.recovery` : lock);
    try {
      const started = Date.now();
      const result = spawnSync(process.execPath, [path.join(root, 'supervisor/permission-hook.mjs')], {
        env: { ...f.env, NODE_OPTIONS: `--import=${new URL(`file://${load}`).href}`, MONITOR_PERMISSION_BINDING: JSON.stringify(f.binding) }, input: JSON.stringify(event), encoding: 'utf8', timeout: 11000,
      });
      assert.ok(Date.now() - started < (recovery ? 7000 : 4000), 'lock waits stay unscaled even under extreme load');
      assert.equal(result.status, 0, result.stderr);
      const decision = JSON.parse(result.stdout).hookSpecificOutput.decision;
      assert.equal(decision.behavior, 'deny'); assert.match(decision.message, /record ask/);
      assert.ok(fs.existsSync(recovery ? `${lock}.recovery` : lock), 'hook never removes a live holder');
    } finally { release(); if (recovery) fs.rmSync(lock, { recursive: true }); }
  }
});

test('absolute watchdog denies even when decision dependencies block their event loop', t => {
  const f = fixture(t), directory = path.join(f.scratch, 'blocked-hook'); fs.mkdirSync(directory);
  const hook = path.join(directory, 'permission-hook.mjs');
  fs.copyFileSync(path.join(root, 'supervisor/permission-hook.mjs'), hook);
  fs.writeFileSync(path.join(directory, 'permission-hooks.mjs'), 'export function handlePermission() { for (;;) {} }');
  const started = Date.now();
  const result = spawnSync(process.execPath, [hook], { env: f.env, input: '{}', encoding: 'utf8', timeout: 11000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 7900 && elapsed < 10000, `absolute deadline elapsed: ${elapsed}`);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: DENIAL_NUDGE } } });
  assert.match(result.stderr, /deadline reached/);
});

for (const alerting of [true, false]) test(`deadline after durable audit ${alerting ? 'keeps the detached alert' : 'never records an ungranted approval'}`, async t => {
  const f = fixture(t), auditFile = path.join(f.env.BRAIN_STATE, 'steward/permissions.json');
  const marker = path.join(f.scratch, 'alert.json'), channel = path.join(f.scratch, 'alert.mjs');
  fs.writeFileSync(channel, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, fs.readFileSync(${JSON.stringify(auditFile)}));`);
  fs.writeFileSync(path.join(f.env.BRAIN_STATE, 'steward.json'), JSON.stringify({ alert_command: [process.execPath, channel] }));
  const blocker = path.join(f.scratch, 'after-audit.mjs');
  fs.writeFileSync(blocker, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const rmdir = fs.rmdirSync;
fs.rmdirSync = function(file, ...args) {
  if (process.argv.includes('--decision') && file === ${JSON.stringify(`${auditFile}.lock`)})
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12000);
  return rmdir.call(this, file, ...args);
}; syncBuiltinESMExports();`);
  const event = alerting ? { ...f.event('ignored'), tool_name: 'Bash', tool_input: { command: 'git push' } } : f.event(f.file(f.own.checkout));
  const result = spawnSync(process.execPath, [path.join(root, 'supervisor/permission-hook.mjs')], {
    env: { ...f.env, NODE_OPTIONS: `--import=${new URL(`file://${blocker}`).href}`, MONITOR_PERMISSION_BINDING: JSON.stringify(f.binding) },
    input: JSON.stringify(event), encoding: 'utf8', timeout: 11000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior, 'deny');
  const audit = JSON.parse(fs.readFileSync(auditFile));
  assert.ok(audit.events.every(event => event.behavior !== 'allow'), 'a watchdog denial cannot leave an approval receipt');
  assert.equal(audit.events[0].behavior, alerting ? 'deny' : 'pending');
  assert.equal(Object.values(audit.sessions)[0].approvals, 0);
  assert.equal(Object.values(audit.sessions)[0].reservations, alerting ? 0 : 1);
  if (alerting) {
    const until = Date.now() + 3000;
    while (!fs.existsSync(marker) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(fs.existsSync(marker), 'alert survives the killed decision worker');
    const receipt = JSON.parse(fs.readFileSync(marker));
    assert.equal(receipt.events[0].alert_intent, true);
    assert.equal(Object.values(Object.values(receipt.sessions)[0].alerts)[0], 1);
  } else assert.equal(fs.existsSync(marker), false);
});

test('permission Git subprocesses time out and deny rather than consuming the hook deadline', t => {
  const f = fixture(t), bin = path.join(f.scratch, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`, { mode: 0o755 });
  const event = f.event(f.file(f.own.checkout)), started = Date.now();
  const result = spawnSync(process.execPath, [path.join(root, 'supervisor/permission-hook.mjs')], {
    env: { ...f.env, PATH: `${bin}:${process.env.PATH}`, MONITOR_PERMISSION_BINDING: JSON.stringify(f.binding) }, input: JSON.stringify(event), encoding: 'utf8', timeout: 11000,
  });
  assert.ok(Date.now() - started < 4000, 'Git has its own short timeout and SIGKILL');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior, 'deny');
});

test('launch hooks stay per-session, retain other hooks and never bypass Codex hook trust', async t => {
  const f = fixture(t), binary = path.join(f.scratch,'native');
  fs.writeFileSync(binary,'#!/bin/sh\nif [ "$1" = --version ]; then echo 2.1.284; else echo "--sandbox --settings --add-dir --permission-profile"; fi\n',{mode:0o755});
  const context = { ...f.binding,tempRoot:f.own.temp,worktrees:f.own.worktrees,projects:[f.peer] };
  const old = {hooks:{PermissionRequest:[{hooks:[{type:'command',command:'existing'}]}],PreToolUse:[{matcher:'AskUserQuestion',hooks:[{type:'command',command:'question-hook'}]}]}};
  const launch = nativeSandboxLaunch({kind:'claude',binary,args:['--settings',JSON.stringify(old)],context,env:f.env}); t.after(launch.close);
  assert.equal(launch.ready, undefined, 'no listener readiness dependency');
  const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings')+1]));
  assert.deepEqual(settings.hooks.PermissionRequest[0],old.hooks.PermissionRequest[0]);
  const hook = settings.hooks.PermissionRequest.at(-1).hooks[0];
  assert.equal(hook.type,'command');
  const input = JSON.stringify(f.event(f.file(f.own.checkout)));
  const invoke = () => spawnSync('/bin/sh', ['-c', hook.command], { env: launch.env, input, encoding: 'utf8' });
  const allowed = invoke();
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.env.BRAIN_STATE, 'steward/permissions.json'))).events[0].behavior, 'allow', 'emitted allow is confirmed in the audit');
  launch.close();
  const closed = invoke();
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(JSON.parse(closed.stdout).hookSpecificOutput.decision.behavior, 'deny', 'command still answers after launch cleanup');
  assert.deepEqual(settings.hooks.PreToolUse[0],old.hooks.PreToolUse[0]);
  const codex = permissionHookArguments('codex',context,root,f.runTemp,f.env);
  assert.match(codex.args[1],/hooks.PermissionRequest=/); assert.doesNotMatch(codex.args.join(' '),/bypass-hook-trust/);
  const next = permissionHookArguments('codex',context,root,path.join(f.own.temp,'other-run'),f.env);
  assert.equal(next.group.hooks[0].command,codex.group.hooks[0].command,'launch binding does not change hook trust fingerprint');
  const result = spawnSync('/bin/sh',['-c',codex.group.hooks[0].command],{env:{...f.env,...codex.env},input:JSON.stringify(f.event(f.file(f.own.checkout))),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior,'deny');
  for (const dir of [f.env.CODEX_HOME,f.env.CLAUDE_CONFIG_DIR]) assert.deepEqual(fs.readdirSync(dir),[],'no persistent settings/trust writes');
});

function observed() {
  const row = JSON.parse(fs.readFileSync(new URL('./fixtures/aggregator-gm-blocked.json',import.meta.url)));
  const parsed = parseScreen(row.screen,{agent:'claude'});
  return { ...row,...parsed,agent:'claude',terminal_id:'term',agent_session:'native' };
}
test('terminal fallback declines only the exact recorded read prompt after fresh occupant and screen checks', async () => {
  const row = observed(), agent = { agent:'claude',agent_status:'blocked',pane_id:row.pane,terminal_id:row.terminal_id,agent_session:row.agent_session,cwd:row.where };
  const calls = [], command = async (bin,args) => { calls.push(args); return { stdout: args[1]==='get'?JSON.stringify({result:{agent}}):args[1]==='read'?row.screen:'{}' }; };
  assert.equal(fallbackRequest(row).behavior,'deny');
  assert.equal((await declineObserved(row,agent,{command})).ok,true);
  assert.deepEqual(calls.at(-1),['agent','send-keys',row.session,'3']);
  assert.equal(calls.filter(a=>a[1]==='get').length,3);
  for (const mutation of ['occupant','screen']) {
    const effects = [];
    const changed = async (bin,args) => { effects.push(args); return {stdout:args[1]==='get'?JSON.stringify({result:{agent:mutation==='occupant'?{...agent,terminal_id:'other'}:agent}}):row.screen.replace('Read(', 'Write(')}; };
    assert.equal((await declineObserved(row,agent,{command:changed})).ok,false);
    assert.ok(effects.every(a=>a[1]!=='send-keys'));
  }
  assert.equal(fallbackRequest({...row,terminal_id:null}),null);
  assert.equal(fallbackRequest({...row,dialog:{...row.dialog,options:row.dialog.options.slice(0,3)}}),null);
});
