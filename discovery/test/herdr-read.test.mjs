import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readArguments } from '../herdr-read.mjs';
import { chatHerdrMode, installedHerdrRead } from '../chat-herdr.mjs';
import { nativeSandboxLaunch } from '../native-sandbox.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { joinFleet } from '../../lib/fleet.mjs';
import { initOrg } from '../../lib/store.mjs';
import { fakeControlSocket } from '../../test/helpers/fake-control-socket.mjs';
import { entryPolicy } from '../policy.mjs';
import { nativeReadProbe } from '../herdr-read-probe.mjs';

const installer = new URL('../install.mjs', import.meta.url).pathname;
function git(f, args) {
  const result = spawnSync('git', ['-C', f.context.canonical, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function commitConfig(f, config) {
  fs.writeFileSync(path.join(f.context.canonical, '.lane.json'), JSON.stringify(config));
  git(f, ['add', '.lane.json']); git(f, ['commit', '-qm', 'Chat mode']);
}
function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/r297-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { role: 'chat', canonical: path.join(root, 'repo'), workspace: path.join(root, 'repo'),
    org: path.join(root, 'record'), tempRoot: path.join(root, 'temp'), worktrees: path.join(root, 'lanes'), projects: [] };
  for (const directory of new Set(Object.values(context).filter(v => typeof v === 'string' && v.startsWith('/')))) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(context.org,'events.jsonl'),'');
  const config = path.join(root, 'config'); fs.mkdirSync(config);
  const socket = fakeControlSocket(t, root);
  const binary = path.join(root, 'claude');
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = --help ]; then echo --settings; elif [ "$1" = --version ]; then echo 2.1.295; fi\n', { mode: 0o755 });
  const herdr = path.join(root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
const net=require('node:net');
const args=process.argv.slice(2);
const c=net.connect(process.env.HERDR_SOCKET_PATH);
c.once('connect',()=>{console.log(JSON.stringify(args));c.destroy()});
c.once('error',e=>{console.error(e.code);process.exitCode=1});
`, { mode: 0o755 });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, HERDR_BIN_PATH: herdr, HERDR_SOCKET_PATH: socket };
  const entryBin = path.join(root, 'bin');
  const result = spawnSync(process.execPath, [installer, '--bin', entryBin, '--claude', binary], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const f = {root, context, config, socket, binary, herdr, env, entryBin};
  git(f, ['init', '-q', '-b', 'main']);
  git(f, ['config', 'user.name', 'Read chat tests']); git(f, ['config', 'user.email', 'test@example.invalid']);
  commitConfig(f, {chat:{herdr_mode:'read'}});
  return f;
}

const accepted = [
  ['pane','read','w31W:p1'], ['pane','read','w31W:p1','--lines','20'],
  ['pane','list'], ['pane','list','--workspace','w31W'], ['tab','list','--workspace','w31W'],
  ['pane','wait-output','w31W:p1','--match','ready','--timeout','1000'],
  ['pane','wait-output','w31W:p1','--regex','^ready.*$','--source','recent','--lines','10'],
];
const refused = [
  ['pane','send-keys','w31W:p1','hello'], ['pane','send-text','w31W:p1','hello'],
  ['pane','run','w31W:p1','true'], ['pane','close','w31W:p1'], ['pane','focus','w31W:p1'],
  ['agent','prompt','w31W:p1','hello'], ['tab','close','w31W:t1'],
  ['pane','read','--help'], ['pane','read','w31W:p1;touch /tmp/evil'], ['pane','read','$(id)'],
  ['pane','read','w31W:p1','--lines','0'], ['pane','read','w31W:p1','--lines','-1'],
  ['pane','read','w31W:p1','--lines','1e3'], ['pane','read','w31W:p1','--lines','10','--lines','20'],
  ['pane','read','w31W:p1','--socket','/tmp/foreign'], ['pane','read','w31W:p1','--source','visible'],
  ['pane','list','--workspace','w1\nherdr pane close w1:p1'], ['tab','list','--workspace','--help'],
  ['pane','wait-output','w31W:p1'], ['pane','wait-output','w31W:p1','--match','x','--regex','x'],
  ['pane','wait-output','w31W:p1','--match','$(touch /tmp/evil)'],
  ['pane','wait-output','w31W:p1','--match','x; herdr pane close w1:p1'],
  ['pane','wait-output','w31W:p1','--match','x\ny'], ['pane','wait-output','w31W:p1','--regex','`id`'],
  ['pane','wait-output','w31W:p1','--match','x','--timeout'],
];
test('read wrapper accepts a strict read-only grammar and refuses mutations and injection', t => {
  const f = fixture(t), wrapper = path.join(f.entryBin, 'herdr-read');
  for (const args of accepted) {
    const result = spawnSync(wrapper, args, { env: {...f.env, HERDR_BIN_PATH:'/not/the/pinned/binary', PATH:'/not/a/search/path'}, encoding:'utf8' });
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),readArguments(args));
  }
  for (const args of refused) {
    assert.throws(()=>readArguments(args));
    const result=spawnSync(wrapper,args,{env:f.env,encoding:'utf8'});
    assert.equal(result.status,1,JSON.stringify(args)); assert.equal(result.stdout,'');
  }
  const evil=path.join(f.root,'injected.cjs'); fs.writeFileSync(evil,"console.log('injected');process.exit(42)");
  const result=spawnSync(wrapper,['pane','list'],{env:{...f.env,NODE_OPTIONS:`--require=${evil}`},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),['pane','list']);
});

test('canonical read-mode settings exclude only the installed wrapper and never grant the control socket', t => {
  const f=fixture(t);
  assert.equal(chatHerdrMode(f.context),'read');
  const launch=nativeSandboxLaunch({kind:'claude',binary:f.binary,args:[],...f,warn:()=>{}});t.after(launch.close);
  const settings=JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings')+1]));
  assert.deepEqual(settings.sandbox.excludedCommands,[`${f.entryBin}/herdr-read:*`]);
  assert.ok(!settings.sandbox.network.allowUnixSockets.includes(f.socket));
  assert.equal(settings.sandbox.allowUnsandboxedCommands,false);
  for(const target of [...installedHerdrRead(f.entryBin).protectedPaths, path.join(f.context.canonical,'.lane.json'), path.join(f.context.canonical,'.git')]) {
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(target));
    const directory=fs.statSync(target).isDirectory();
    assert.ok(settings.permissions.deny.includes(`Edit(/${target}${directory ? '/**' : ''})`));
    assert.ok(!settings.permissions.deny.includes(`Edit(/${target}${directory ? '' : '/**'})`));
  }
  assert.match(entryPolicy({...f.context,entryBin:f.entryBin},new URL('../../',import.meta.url).pathname),/Herdr mode: read/);
  for (const role of ['worker','review','supervisor']) {
    const other=nativeSandboxLaunch({...f,kind:'claude',binary:f.binary,args:[],context:{...f.context,role},warn:()=>{}});t.after(other.close);
    const selected=JSON.parse(fs.readFileSync(other.args[other.args.indexOf('--settings')+1]));
    assert.equal(selected.sandbox.network.allowUnixSockets.includes(f.socket),role==='supervisor');
    assert.equal(selected.sandbox.excludedCommands,undefined);
  }
  assert.throws(()=>nativeSandboxLaunch({kind:'codex',binary:f.binary,args:[],...f}),/read-mode chats require Claude/);
  for(const sandbox of [{excludedCommands:['node']},{network:{allowUnixSockets:[f.socket]}},{network:{allowAllUnixSockets:true}},{enabled:false},{allowUnsandboxedCommands:true},{filesystem:{disabled:true}}]) {
    fs.writeFileSync(path.join(f.config,'settings.json'),JSON.stringify({sandbox}));
    assert.throws(()=>nativeSandboxLaunch({kind:'claude',binary:f.binary,args:[],...f,warn:()=>{}}),/read-mode chat conflicts/);
  }
  fs.unlinkSync(path.join(f.config,'settings.json'));
  assert.throws(()=>nativeSandboxLaunch({kind:'claude',binary:f.binary,args:['--settings',JSON.stringify({sandbox:{excludedCommands:['herdr']}})],...f,warn:()=>{}}),/read-mode chat conflicts/);
  commitConfig(f,{chat:{herdr_mode:'full'}}); assert.equal(chatHerdrMode(f.context),'full');
  const full=nativeSandboxLaunch({kind:'claude',binary:f.binary,args:[],...f,warn:()=>{}});t.after(full.close);
  const fullSettings=JSON.parse(fs.readFileSync(full.args[full.args.indexOf('--settings')+1]));
  assert.ok(fullSettings.sandbox.network.allowUnixSockets.includes(f.socket));
  assert.equal(fullSettings.sandbox.excludedCommands,undefined);
});

test('only an operator committed mode change affects the next launch', t => {
  const f=fixture(t), file=path.join(f.context.canonical,'.lane.json');
  const launch=nativeSandboxLaunch({...f,kind:'claude',args:[],warn:()=>{}});t.after(launch.close);
  const settingsFile=launch.args[launch.args.indexOf('--settings')+1], before=fs.readFileSync(settingsFile,'utf8');
  for(const action of [()=>fs.writeFileSync(file,JSON.stringify({chat:{herdr_mode:'full'}})),()=>fs.unlinkSync(file)]) {
    action();
    assert.throws(()=>chatHerdrMode(f.context),/differs from committed HEAD/);
    assert.throws(()=>nativeSandboxLaunch({...f,kind:'claude',args:[]}),/operator commit.*outside the chat/);
    fs.writeFileSync(file,JSON.stringify({chat:{herdr_mode:'read'}}));
  }
  commitConfig(f,{chat:{herdr_mode:'full'}});
  assert.equal(fs.readFileSync(settingsFile,'utf8'),before,'existing launch policy stays read');
  const next=nativeSandboxLaunch({...f,kind:'claude',args:[],warn:()=>{}});t.after(next.close);
  const settings=JSON.parse(fs.readFileSync(next.args[next.args.indexOf('--settings')+1]));
  assert.ok(settings.sandbox.network.allowUnixSockets.includes(f.socket));
  assert.equal(settings.sandbox.excludedCommands,undefined);
  fs.unlinkSync(file);git(f,['add','.lane.json']);git(f,['commit','-qm','Remove config']);
  assert.equal(chatHerdrMode(f.context),'full','absent committed config defaults to full');
  fs.writeFileSync(file,JSON.stringify({chat:{herdr_mode:'read'}}));
  assert.equal(chatHerdrMode(f.context),'full','working-tree-only settings do not choose the mode');
  git(f,['update-ref','-d','HEAD']);
  assert.throws(()=>chatHerdrMode(f.context),/HEAD/,'unavailable HEAD fails closed');
});

test('malformed committed and working-tree chat config reports invalid settings', t => {
  const f=fixture(t), file=path.join(f.context.canonical,'.lane.json');
  for(const config of [null,[],42,'read',false,{chat:[]}]) {
    fs.writeFileSync(file,JSON.stringify(config));
    assert.throws(()=>chatHerdrMode(f.context),/invalid chat settings.*expected an object/);
    git(f,['add','.lane.json']);git(f,['commit','-qm','Malformed config']);
    assert.throws(()=>chatHerdrMode(f.context),/invalid chat settings.*expected an object/);
    commitConfig(f,{chat:{herdr_mode:'read'}});
  }
  for(const mode of ['bad',null]) {
    commitConfig(f,{chat:{herdr_mode:mode}});
    assert.throws(()=>chatHerdrMode(f.context),/expected full or read/);
  }
});

test('read chat protects resolved config and separate Git metadata paths', t => {
  const f=fixture(t), file=path.join(f.context.canonical,'.lane.json'), target=path.join(f.root,'config-target.json');
  fs.renameSync(file,target);fs.symlinkSync(target,file);
  const gitDir=path.join(f.root,'git-metadata');
  fs.renameSync(path.join(f.context.canonical,'.git'),gitDir);
  fs.writeFileSync(path.join(f.context.canonical,'.git'),`gitdir: ${gitDir}\n`);
  const launch=nativeSandboxLaunch({...f,kind:'claude',args:[],warn:()=>{}});t.after(launch.close);
  const settings=JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings')+1]));
  for(const pathname of [file,target,path.join(f.context.canonical,'.git'),gitDir]) {
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(pathname),pathname);
    assert.ok(settings.permissions.deny.includes(`Edit(/${pathname}${fs.statSync(pathname).isDirectory() ? '/**' : ''})`),pathname);
  }
});

test('native Claude honours CLI-scope read exclusions while sandboxed direct sockets and mutations stay denied', {
  skip: !process.env.MONITOR_TEST_CLAUDE_READ && 'set MONITOR_TEST_CLAUDE_READ to the installed native binary outside a nested sandbox',
}, t => {
  const f=fixture(t), binary=process.env.MONITOR_TEST_CLAUDE_READ;
  const launch=nativeSandboxLaunch({...f,kind:'claude',binary,args:['--setting-sources',''],warn:()=>{}});t.after(launch.close);
  const result=nativeReadProbe({binary,launch,context:f.context,entryBin:f.entryBin,socket:f.socket,root:f.root});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/read wrappers reached fake socket; direct socket EPERM; mutations confined/);
  t.diagnostic(result.stdout.trim());
});


test('installed chat adapter supplies the read launch policy and wrapper exclusion end to end', t => {
  const f=fixture(t);fixtureFleet(t,f.root);initOrg(f.context.org);
  joinFleet({cwd:f.context.workspace,record:f.context.org,temp:f.context.tempRoot,worktrees:f.context.worktrees});
  fs.writeFileSync(f.binary,`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('--help'))console.log('--settings');
else if(args.includes('--version'))console.log('2.1.295');
else console.log(JSON.stringify({args,settings:JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1]))}));
`,{mode:0o755});
  const result=spawnSync(path.join(f.entryBin,'monitor-claude'),['--repo',f.context.workspace,'--role','chat','--','--print','offline task'],{
    env:{...f.env,HERDR_MONITOR_FLEET:process.env.HERDR_MONITOR_FLEET,MONITOR_ENTRY_BYPASS:'1'},cwd:f.context.workspace,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const got=JSON.parse(result.stdout);
  assert.deepEqual(got.settings.sandbox.excludedCommands,[`${f.entryBin}/herdr-read:*`]);
  assert.ok(!got.settings.sandbox.network.allowUnixSockets.includes(f.socket));
  assert.match(got.args[got.args.indexOf('--append-system-prompt')+1],/Herdr mode: read/);
  assert.ok(got.args[got.args.indexOf('--append-system-prompt')+1].includes(`${f.entryBin}/herdr-read`));
});
