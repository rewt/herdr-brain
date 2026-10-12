import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyProduct } from '../lib/product-files.mjs';
import { freshAccount } from '../docs/adoption/account.mjs';
import { fixtureFleet } from './helpers/offline-herdr.mjs';

const source = path.resolve(import.meta.dirname, '..');
function fixture(t, kinds = ['codex', 'claude']) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-zero-setup-'));
  t.after(() => { spawnSync('chmod', ['-R', 'u+w', root]); fs.rmSync(root, { recursive: true, force: true }); });
  fixtureFleet(t, root);
  const home = path.join(root, 'home'), product = path.join(root, 'product'), tools = path.join(root, 'tools');
  for (const dir of [home, tools]) fs.mkdirSync(dir);
  copyProduct(source, product);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MONITOR_|HERDR_|RELEASE_|ORG_|LANE_|CODEX_|CLAUDE_|GIT_|ZDOTDIR$)/u.test(key)));
  Object.assign(env, { HOME: home, ZDOTDIR: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    HERDR_MONITOR_HOME: path.join(home, 'monitor'), HERDR_MONITOR_FLEET: process.env.HERDR_MONITOR_FLEET,
    HERDR_MONITOR_CODEX: '-', HERDR_MONITOR_CLAUDE: '-', PATH: `${tools}:/usr/bin:/bin`,
    ORG_ACTOR: 'zero-setup-test', RELEASE_NO_NPM: '1', RELEASE_NO_HERDR: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    HERDR_SOCKET_PATH: path.join(root, 'absent.sock'), ENTRY_TEST_RECEIPT: path.join(root, 'native.json') });
  const write = (file, data, mode = 0o600) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { mode }); };
  for (const kind of kinds) {
    const file = path.join(tools, kind);
    write(file, `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('--sandbox --add-dir --settings --permission-profile');process.exit(0);}
if(args.includes('--version')){console.log('2.1.284');process.exit(0);}
if(args[0]==='sandbox'){
  const split=args.indexOf('--'),child=require('child_process').spawnSync(args[split+1],args.slice(split+2),{stdio:'inherit'});
  process.exit(child.status??1);
}
const fs=require('fs');
fs.writeFileSync(process.env.ENTRY_TEST_RECEIPT, JSON.stringify({kind:${JSON.stringify(kind)},args,cwd:process.cwd(),
  settings:args.includes('--settings')?JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1])):null}));
`, 0o755);
    env[`HERDR_MONITOR_${kind.toUpperCase()}`] = file;
  }
  const calls = path.join(root, 'herdr.jsonl'), panes = path.join(root, 'panes.json');
  write(path.join(tools, 'herdr'), `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2),file=${JSON.stringify(panes)};
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
let panes=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];
if(args[0]==='--version') console.log('herdr 0.8.2');
else if(args[0]==='pane'&&args[1]==='list') console.log(JSON.stringify({result:{panes}}));
else if(args[0]==='workspace'&&args[1]==='get') console.log(JSON.stringify({result:{workspace:{cwd:process.cwd()}}}));
else if(args[0]==='plugin'&&args[1]==='pane'&&args[2]==='open') {const pane={pane_id:'w-scratch:p'+panes.length,terminal_id:'term-'+panes.length};panes.push(pane);fs.writeFileSync(file,JSON.stringify(panes));console.log(JSON.stringify({result:{plugin_pane:{plugin_id:'rewt.herdr-monitor',entrypoint:args[args.indexOf('--entrypoint')+1],pane}}}));}
else {console.error('unexpected offline Herdr command');process.exit(1);}
`, 0o755);
  const run = (file, args, extra = {}, input) => spawnSync(file, args, { cwd: product, env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 15000 });
  const driver = (...args) => run(process.execPath, [path.join(product, 'herdr/entry-install.mjs'), '--snapshot', ...args]);
  const ok = result => { assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout); return result; };
  const bin = path.join(env.HERDR_MONITOR_HOME, 'entry/bin');
  return { root, home, product, tools, env, bin, run, driver, ok, write, calls };
}

for (const kinds of [['codex'], ['claude'], ['codex', 'claude']]) test(`${kinds.join(' and ')} install, repeat and uninstall restore machine files`, t => {
  const f = fixture(t, kinds), originals = new Map();
  if (kinds.length === 1) delete f.env[kinds[0] === 'claude' ? 'HERDR_MONITOR_CODEX' : 'HERDR_MONITOR_CLAUDE'];
  const files = [path.join(f.home, '.zshrc'), ...kinds.map(kind => path.join(f.home, kind === 'codex' ? '.codex/hooks.json' : '.claude/settings.json'))];
  for (const file of files) {
    const data = file.endsWith('.zshrc') ? Buffer.from('# original shell\r\n') : Buffer.from('{ "theme": "original", "hooks": { "Stop": [] } }\n');
    f.write(file, data); originals.set(file, data);
  }
  f.ok(f.driver());
  for (const kind of ['codex', 'claude']) assert.equal(fs.existsSync(path.join(f.bin, `monitor-${kind}`)), kinds.includes(kind));
  const installed = [...files, ...fs.readdirSync(f.bin).map(name => path.join(f.bin, name))].map(file => ({file, data:fs.readFileSync(file), mtime:fs.statSync(file).mtimeMs}));
  f.ok(f.driver());
  for (const before of installed) { assert.deepEqual(fs.readFileSync(before.file), before.data); assert.equal(fs.statSync(before.file).mtimeMs, before.mtime, 'second install writes nothing'); }
  f.ok(f.driver('--remove'));
  for (const [file, data] of originals) { assert.deepEqual(fs.readFileSync(file), data); assert.equal(fs.statSync(file).mode & 0o777, 0o600); }
  for (const name of ['monitor', 'monitor-codex', 'monitor-claude', '.monitor-native-hooks.json']) assert.equal(fs.existsSync(path.join(f.bin, name)), false);
  for (const name of ['.zshenv', '.bashrc', '.bash_profile']) assert.equal(fs.existsSync(path.join(f.home, name)), false);
});

test('missing harness refuses before shell or harness configuration changes', t => {
  const f = fixture(t, []), result = f.driver();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /install.*Codex.*Claude/i);
  for (const name of ['.zshenv', '.bashrc', '.codex/hooks.json', '.claude/settings.json']) assert.equal(fs.existsSync(path.join(f.home, name)), false);
});

test('release activation keeps native hook commands stable through upgrade and rollback without writing profile trust', t => {
  const f = fixture(t, ['codex', 'claude']);
  fs.symlinkSync(process.execPath, path.join(f.tools, 'node'));
  const releaseHome = f.env.HERDR_MONITOR_HOME;
  const first = path.join(releaseHome, 'releases', 'first'), second = path.join(releaseHome, 'releases', 'second');
  copyProduct(f.product, first); copyProduct(f.product, second);
  fs.appendFileSync(path.join(second, 'herdr/native-entry.mjs'), '\n// New release runtime.\n');
  const trust = new Map();
  for (const name of ['config.toml', 'claude-mem-rewt.config.toml', 'claude-mem-bastian.config.toml']) {
    const file = path.join(f.env.CODEX_HOME, name), content = Buffer.from(`# Operator-owned ${name}\n`);
    f.write(file, content); trust.set(file, content);
  }
  const extra = { HERDR_MONITOR_REPO: f.product, HERDR_MONITOR_BIN: path.join(f.root, 'launchers'), RELEASE_NO_LAUNCHD: '1' };
  // Seed the release-specific command written by the previous installer.
  f.ok(f.run(process.execPath, [path.join(f.product, 'herdr/entry-install.mjs'), '--product', first]));
  assert.ok(fs.readFileSync(path.join(f.env.CODEX_HOME, 'hooks.json'), 'utf8').includes(first));
  const release = args => f.ok(f.run('/bin/bash', [path.join(f.product, 'herdr/release.sh'), ...args], extra));
  const activated = release(['activate', 'first']);
  assert.match(activated.stdout, /required Codex setup.*\/hooks.*every profile/);
  assert.match(activated.stdout, /Trust in one profile does not cover another/);
  const files = [path.join(f.env.CODEX_HOME, 'hooks.json'), path.join(f.env.CLAUDE_CONFIG_DIR, 'settings.json')];
  const before = files.map(file => fs.readFileSync(file));
  for (const file of files) {
    const command = JSON.parse(fs.readFileSync(file)).hooks.SessionStart[0].hooks[0].command;
    assert.ok(command.includes(path.join(releaseHome, 'current/herdr/native-entry.mjs')));
    assert.ok(!command.includes('/releases/'));
  }
  release(['activate', 'second']);
  assert.equal(fs.realpathSync(path.join(releaseHome, 'current')), second);
  for (let i = 0; i < files.length; i++) assert.deepEqual(fs.readFileSync(files[i]), before[i]);
  // The stable command executes the active runtime, even on initial activation.
  const command = JSON.parse(before[0]).hooks.SessionStart[0].hooks[0].command;
  f.ok(f.run('/bin/sh', ['-c', command], {}, JSON.stringify({hook_event_name:'SessionStart',source:'startup',cwd:f.home})));
  release(['rollback']); assert.equal(fs.realpathSync(path.join(releaseHome, 'current')), first);
  for (let i = 0; i < files.length; i++) assert.deepEqual(fs.readFileSync(files[i]), before[i]);
  for (const [file, content] of trust) assert.deepEqual(fs.readFileSync(file), content);
});

for (const missing of ['npm', 'git', 'python3', 'herdr']) test(`missing ${missing} names the prerequisite and changes no machine files`, t => {
  const f = fixture(t, ['claude']);
  for (const [name, version] of Object.entries({npm:'10.0.0',git:'git version 2.50.0',python3:'Python 3.12.0',herdr:'herdr 0.8.2'})) {
    if (name !== missing) f.write(path.join(f.tools, name), `#!/bin/sh\necho '${version}'\n`, 0o755);
    else fs.rmSync(path.join(f.tools, name), {force:true});
  }
  const result = f.run(process.execPath, [path.join(f.product, 'herdr/prerequisites.mjs')], {PATH:f.tools, RELEASE_NO_NPM:'', RELEASE_NO_HERDR:''});
  assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(`install.*${missing}`, 'i'));
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('native hooks survive relocation and join an unconfigured project without opening panes', t => {
  const f = fixture(t, ['claude']); f.ok(f.driver());
  const settings = JSON.parse(fs.readFileSync(path.join(f.env.CLAUDE_CONFIG_DIR, 'settings.json')));
  const hook = settings.hooks.SessionStart[0].hooks[0].command;
  assert.ok(!hook.includes(f.product), 'hook pins the stable installed runtime');
  fs.renameSync(f.product, `${f.product}-moved`); f.product += '-moved';
  const project = path.join(f.root, 'unconfigured'); fs.mkdirSync(project);
  for (const args of [['init','-qb','main'], ['-c','user.name=Install test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','Initial']]) {
    f.ok(spawnSync('git', args, {cwd:project, env:f.env, encoding:'utf8'}));
  }
  const input = JSON.stringify({hook_event_name:'SessionStart',source:'startup',cwd:project});
  const invoke = extra => spawnSync('/bin/sh', ['-c', hook], {cwd:project, env:{...f.env, HERDR_WORKSPACE_ID:'w-scratch', ...extra}, input, encoding:'utf8', timeout:15000});
  f.ok(invoke()); f.ok(invoke());
  const fleet = JSON.parse(fs.readFileSync(path.join(f.env.HERDR_MONITOR_FLEET, 'fleet.json')));
  assert.equal(fleet.session_limit, 6); assert.equal(Object.values(fleet.projects)[0].checkout, project);
  assert.ok(fs.existsSync(path.join(project, '.org/events.jsonl')));
  for (const name of ['AGENTS.md','.lane.json','.codex/hooks.json','.claude/settings.json']) assert.equal(fs.existsSync(path.join(project,name)),false);
  const calls = () => fs.existsSync(f.calls) ? fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse) : [];
  assert.ok(!calls().some(args => args[0] === 'plugin'), 'entry never opens plugin panes');
  f.ok(invoke({MONITOR_ENTRY_BYPASS:'1', MONITOR_SESSION_ROLE:'worker'}));
  assert.ok(!calls().some(args => args[0] === 'plugin'));
});

for (const kind of ['codex', 'claude']) for (const source of ['startup', 'resume']) test(`${kind} native ${source} honors canonical project opt-out without state or panes`, t => {
  const f = fixture(t, [kind]); f.ok(f.driver());
  const config = path.join(kind === 'codex' ? f.env.CODEX_HOME : f.env.CLAUDE_CONFIG_DIR, kind === 'codex' ? 'hooks.json' : 'settings.json');
  const hook = JSON.parse(fs.readFileSync(config)).hooks.SessionStart[0].hooks[0].command;
  const project = path.join(f.root, 'disabled'); fs.mkdirSync(project);
  const git = args => f.ok(spawnSync('git', args, { cwd: project, env: f.env, encoding: 'utf8' }));
  git(['init', '-qb', 'main']);
  git(['-c', 'user.name=Install test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Initial']);
  f.write(path.join(project, '.lane.json'), JSON.stringify({ entry: { enabled: false } }));
  let checkout = project;
  if (source === 'resume') {
    checkout = path.join(f.root, 'linked');
    git(['worktree', 'add', '-qb', 'lane/disabled', checkout]);
    f.write(path.join(checkout, '.lane.json'), JSON.stringify({ entry: { enabled: true } }));
  }
  const cwd = path.join(checkout, 'nested'); fs.mkdirSync(cwd);
  const result = f.ok(spawnSync('/bin/sh', ['-c', hook], { cwd, env: { ...f.env, HERDR_WORKSPACE_ID: 'w-scratch' },
    input: JSON.stringify({ hook_event_name: 'SessionStart', source, cwd }), encoding: 'utf8' }));
  assert.equal(result.stdout, '', 'disabled entry supplies no join or adapter guidance');
  assert.equal(result.stderr, '');
  assert.equal(fs.existsSync(f.calls), false, 'disabled entry makes no Herdr calls');
  // The short-path fixture may precreate an empty fleet root.
  assert.deepEqual(fs.existsSync(f.env.HERDR_MONITOR_FLEET) ? fs.readdirSync(f.env.HERDR_MONITOR_FLEET) : [], [], 'disabled entry creates no fleet state');
  for (const directory of [project, checkout]) for (const name of ['.org', '.lane', '.herdr-monitor']) assert.equal(fs.existsSync(path.join(directory, name)), false, name);
  assert.equal(fs.existsSync(path.join(project, '.git/monitor-controls')), false);
});

test('uninstall preserves unrelated harness edits and refuses a changed managed hook', t => {
  const f = fixture(t, ['claude']); f.ok(f.driver());
  const file = path.join(f.env.CLAUDE_CONFIG_DIR,'settings.json'), settings=JSON.parse(fs.readFileSync(file));
  settings.theme='later'; f.write(file,JSON.stringify(settings));
  f.ok(f.driver('--remove')); assert.deepEqual(JSON.parse(fs.readFileSync(file)),{theme:'later'});
  f.ok(f.driver()); const changed=JSON.parse(fs.readFileSync(file)); changed.hooks.SessionStart[0].hooks[0].command+=' --changed'; f.write(file,JSON.stringify(changed));
  const before=fs.readFileSync(file), failed=f.driver('--remove'); assert.notEqual(failed.status,0); assert.match(failed.stderr,/managed native hook changed/);
  assert.deepEqual(fs.readFileSync(file),before); assert.ok(fs.existsSync(path.join(f.bin,'monitor-claude')));
});

test('account rehearsal requires a real fresh macOS login and refuses scratch HOME or existing state', () => {
  const input={platform:'darwin',user:{uid:502,username:'adopter',homedir:'/Users/adopter'},env:{HOME:'/Users/adopter'},exists:()=>false};
  assert.deepEqual(freshAccount(input),{home:'/Users/adopter',username:'adopter',uid:502,platform:'darwin'});
  assert.throws(()=>freshAccount({...input,env:{HOME:'/tmp/fake-home'}}),/log in/);
  assert.throws(()=>freshAccount({...input,platform:'linux'}),/macOS/);
  assert.throws(()=>freshAccount({...input,user:{...input.user,uid:0}}),/log in/);
  assert.throws(()=>freshAccount({...input,exists:()=>true}),/already has Monitor state/);
});

test('native configuration writes roll back with the rest of an interrupted installation', t => {
  const f=fixture(t,['claude']), config=path.join(f.env.CLAUDE_CONFIG_DIR,'settings.json');
  f.write(config,'{ "theme": "original" }\n'); const before=fs.readFileSync(config);
  const preload=path.join(f.root,'fail-after-native.cjs');
  f.write(preload,`const fs=require('fs'),rename=fs.renameSync;fs.renameSync=function(from,to){if(to===${JSON.stringify(path.join(f.bin,'monitor-claude'))})throw Error('injected adapter failure');return rename.apply(this,arguments);};\n`);
  const result=f.run(process.execPath,['--require',preload,path.join(f.product,'herdr/entry-install.mjs'),'--snapshot']);
  assert.notEqual(result.status,0); assert.match(result.stderr,/injected adapter failure/);
  assert.deepEqual(fs.readFileSync(config),before);
  assert.equal(fs.existsSync(path.join(f.bin,'.monitor-recovery.json')),false);
  assert.equal(fs.existsSync(path.join(f.bin,'monitor-claude')),false);
});

test('the install build checks harnesses before any write and repeats', t => {
  const f=fixture(t,['claude']);
  const install=extra=>f.run('/bin/bash',[path.join(f.product,'herdr/install.sh')],extra);
  const missing=install({HERDR_MONITOR_CLAUDE:'-'}); assert.notEqual(missing.status,0); assert.match(missing.stderr,/install native Codex.*Claude/);
  assert.equal(fs.existsSync(f.bin),false,'failure must precede entry writes');
  f.ok(install()); assert.ok(fs.existsSync(path.join(f.bin,'monitor-claude')));
  f.ok(install()); assert.ok(fs.existsSync(path.join(f.bin,'monitor-claude')));
});
