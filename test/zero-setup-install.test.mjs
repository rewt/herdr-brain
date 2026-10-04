import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyProduct } from '../lib/product-files.mjs';
import { freshAccount } from '../docs/adoption/account.mjs';

const source = path.resolve(import.meta.dirname, '..');
function fixture(t, kinds = ['codex', 'claude']) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-zero-setup-'));
  t.after(() => { spawnSync('chmod', ['-R', 'u+w', root]); fs.rmSync(root, { recursive: true, force: true }); });
  const home = path.join(root, 'home'), product = path.join(root, 'product'), tools = path.join(root, 'tools');
  for (const dir of [home, tools]) fs.mkdirSync(dir);
  copyProduct(source, product);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MONITOR_|HERDR_|RELEASE_|ORG_|LANE_|CODEX_|CLAUDE_|GIT_|ZDOTDIR$)/u.test(key)));
  Object.assign(env, { HOME: home, ZDOTDIR: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    HERDR_MONITOR_HOME: path.join(home, 'monitor'), HERDR_MONITOR_FLEET: path.join(home, 'fleet'),
    HERDR_MONITOR_CODEX: '-', HERDR_MONITOR_CLAUDE: '-', PATH: `${tools}:/usr/bin:/bin`,
    ORG_ACTOR: 'zero-setup-test', RELEASE_NO_NPM: '1', RELEASE_NO_HERDR: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    HERDR_SOCKET_PATH: path.join(root, 'absent.sock'), ENTRY_TEST_RECEIPT: path.join(root, 'native.json') });
  const write = (file, data, mode = 0o600) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { mode }); };
  for (const kind of kinds) {
    const file = path.join(tools, kind);
    write(file, `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.ENTRY_TEST_RECEIPT, JSON.stringify({kind:${JSON.stringify(kind)},args:process.argv.slice(2),cwd:process.cwd()}));\n`, 0o755);
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

test('native hooks survive relocation, join an unconfigured project and open two panes once without focus', t => {
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
  const calls = fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse), opens = calls.filter(args => args.includes('open'));
  assert.equal(opens.length,2); for (const args of opens) assert.ok(args.includes('--no-focus'));
  f.ok(invoke({MONITOR_ENTRY_BYPASS:'1', MONITOR_SESSION_ROLE:'worker'}));
  assert.equal(fs.readFileSync(f.calls,'utf8').trim().split('\n').length,calls.length);
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
  assert.equal(fs.existsSync(f.env.HERDR_MONITOR_FLEET), false, 'disabled entry creates no fleet state');
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

test('Claude-only plugin supervisor selects installed Claude and keeps supervisor hook entry', t => {
  const f = fixture(t,['claude']); f.ok(f.driver());
  f.ok(f.run('git',['init','-qb','main'])); f.ok(f.run('git',['config','user.name','Install test'])); f.ok(f.run('git',['config','user.email','test@example.invalid']));
  f.ok(f.run('git',['add','.'])); f.ok(f.run('git',['commit','-qm','Initial']));
  f.ok(f.run(process.execPath,[path.join(source,'herdr/supervisor.mjs')]));
  const native=JSON.parse(fs.readFileSync(f.env.ENTRY_TEST_RECEIPT)); assert.equal(native.kind,'claude');
  assert.ok(native.args.includes('--append-system-prompt')); assert.match(native.args.join(' '),/supervisor\/session-start.mjs/);
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

test('the plugin build works without import.meta.dirname, checks before dependency writes and repeats without npm', t => {
  const f=fixture(t,['claude']);
  copyProduct(source,f.product,{includeApps:true});
  // Node 20.0-20.10 has import.meta.url but no dirname. Exercise that shape
  // through the actual build, including dependency receipts and repeat reuse.
  const dependencies = path.join(f.product, 'herdr/dependencies.mjs');
  f.write(dependencies, fs.readFileSync(dependencies, 'utf8').replace(/^(#![^\n]*\n)/u, '$1delete import.meta.dirname;\n'));
  const calls=path.join(f.root,'npm.jsonl');
  f.write(path.join(f.tools,'npm'),`#!${process.execPath}
const fs=require('fs'),path=require('path'),args=process.argv.slice(2);
if(args[0]==='--version')console.log('10.0.0');
else {fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');fs.mkdirSync(path.join(args[1],'node_modules'),{recursive:true});}
`,0o755);
  const install=extra=>f.run('/bin/bash',[path.join(f.product,'herdr/install.sh')],{RELEASE_NO_NPM:'',...extra});
  const missing=install({HERDR_MONITOR_CLAUDE:'-'}); assert.notEqual(missing.status,0); assert.match(missing.stderr,/install native Codex.*Claude/);
  assert.equal(fs.existsSync(calls),false,'failure must precede npm ci');
  f.ok(install()); const first=fs.readFileSync(calls); assert.equal(first.toString().trim().split('\n').length,2);
  f.ok(install()); assert.deepEqual(fs.readFileSync(calls),first,'second build must not run npm ci');
});
