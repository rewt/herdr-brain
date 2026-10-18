import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { copyProduct } from '../lib/product-files.mjs';
import { stopFixtureInbox } from './helpers/inbox.mjs';

const source = path.resolve(import.meta.dirname, '..');
function fixture(t, { markers = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-pins-')));
  const home = path.join(root, '.local/share/herdr-monitor'), bin = path.join(root, 'bin');
  const teardown = [];
  const env = { ...process.env, HOME: root, HERDR_MONITOR_FLEET: path.join(root, 'fleet'), ORG_ACTOR: 'release-pin-fixture',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.01',
    SUPERVISOR_INPUT_POLL_SECONDS: '0.01', SUPERVISOR_INPUT_WAIT_SECONDS: '2' };
  for (const key of Object.keys(env)) if (/^(LANE_|ORG_DIR$|HERDR_(?:PANE|TAB|WORKSPACE)_ID|GIT_(?:DIR|COMMON_DIR|INDEX_FILE|WORK_TREE|CONFIG_COUNT)$)/.test(key)) delete env[key];
  t.after(async () => { for (const cleanup of teardown) await cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(bin, { recursive: true });
  const run = (file, args, cwd = root, extra = {}) => spawnSync(file, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  const ok = result => { assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout.trim(); };
  const node = (args, cwd, extra) => ok(run(process.execPath, args, cwd, extra));
  const git = (repo, ...args) => ok(run('git', ['-C', repo, ...args]));
  const tool = (...args) => node([path.join(source, 'herdr/releases.mjs'), ...args]);
  const releases = Object.fromEntries(['blue', 'green'].map((id, index) => {
    const directory = path.join(home, 'releases', id); copyProduct(source, directory);
    fs.writeFileSync(path.join(directory, '.release-commit'), String(index + 1).repeat(40) + '\n');
    if (markers) for (const relative of ['bin/org.mjs', 'lanes/lane.mjs']) fs.writeFileSync(path.join(directory, relative), `console.log(${JSON.stringify(id)});`);
    fs.writeFileSync(path.join(directory, 'herdr/probe.mjs'), `import {bundleRelease} from '../lib/releases.mjs'; console.log(JSON.stringify(bundleRelease()));`);
    fs.writeFileSync(path.join(directory, 'herdr/child.mjs'), `import fs from 'node:fs';import {bundleRelease} from '../lib/releases.mjs';fs.appendFileSync(process.env.PIN_TRACE,JSON.stringify(bundleRelease())+'\\n');console.error('lane: fixture validation refused');process.exitCode=1;`);
    tool('manifest', directory);
    return [id, directory];
  }));
  fs.symlinkSync(releases.green, path.join(home, 'current'));
  tool('install', home, bin);
  const project = name => {
    const repo = path.join(root, name); fs.mkdirSync(repo);
    git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
    git(repo, 'commit', '--allow-empty', '-qm', 'initial');
    return repo;
  };
  const pin = (repo, id) => {
    tool(id ? 'pin' : 'unpin', home, repo, ...(id ? [id] : []));
    git(repo, 'add', '.herdr-release.json'); git(repo, 'commit', '-qm', `accept ${id ?? 'current'}`);
  };
  return { root, home, bin, env, releases, run, ok, node, git, tool, project, pin, teardown };
}

test('two canonical identities select their own bundles; unpinned callers retain current', t => {
  const f = fixture(t), first = f.project('one'), second = f.project('two'), unpinned = f.project('three');
  f.pin(first, 'blue'); f.pin(second, 'green');
  for (const name of ['org', 'record', 'lane']) for (const [repo, expected] of [[first, 'blue'], [second, 'green'], [unpinned, 'green']]) {
    assert.equal(f.node([path.join(f.bin, name), 'help'], repo), expected);
  }
  f.pin(first, 'green'); assert.equal(f.node([path.join(f.bin, 'record'), 'help'], first), 'green');
  f.pin(first, 'blue'); assert.equal(f.node([path.join(f.bin, 'record'), 'help'], first), 'blue');
  assert.equal(f.node([path.join(f.bin, 'record'), 'help'], second), 'green');
});

test('lane commits, edited canonical config and inherited selectors cannot redirect the accepted pin', t => {
  const f = fixture(t), repo = f.project('project'), other = f.project('other'); f.pin(repo, 'blue'); f.pin(other, 'green');
  const lane = path.join(f.root, 'lane'); f.git(repo, 'worktree', 'add', '-b', 'lane/test', lane);
  fs.writeFileSync(path.join(lane, '.herdr-release.json'), JSON.stringify({ release: 'green' }));
  f.git(lane, 'add', '.'); f.git(lane, 'commit', '-qm', 'lane cannot select green');
  fs.writeFileSync(path.join(repo, '.herdr-release.json'), JSON.stringify({ release: 'missing' }));
  const hostile = { HOME: path.join(f.root, 'wrong-home'), HERDR_MONITOR_HOME: path.join(f.root, 'wrong'), HERDR_MONITOR_RELEASE: 'green',
    HERDR_MONITOR_RELEASE_DIR: f.releases.green, GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_COMMON_DIR: path.join(other, '.git') };
  for (const cwd of [repo, lane]) assert.equal(f.node([path.join(f.bin, 'record'), 'help'], cwd, hostile), 'blue');
  assert.notEqual(f.run(process.execPath, [path.join(source, 'herdr/releases.mjs'), 'pin', f.home, lane, 'green']).status, 0);
});

test('project-aware shell adapters select an explicit target project and ignore inherited installation selectors', t => {
  const f = fixture(t), repo = f.project('project'); f.pin(repo, 'blue');
  for (const [id, root] of Object.entries(f.releases)) {
    fs.writeFileSync(path.join(root, 'watch/watch.mjs'), `console.log(${JSON.stringify(id)});`);
    fs.writeFileSync(path.join(root, 'supervisor/supervisor.mjs'), `import {forwardRelease} from '../lib/releases.mjs';
const code=forwardRelease('supervisor/supervisor.mjs',process.argv[3]??process.cwd());
if(code!==null)process.exitCode=code;else console.log(process.argv.includes('--trace-args')?JSON.stringify({id:${JSON.stringify(id)},cwd:process.cwd(),args:process.argv.slice(2)}):${JSON.stringify(id)});`);
    fs.writeFileSync(path.join(root, 'herdr/retry.mjs'), `import {continueRelease,bundleRelease} from '../lib/releases.mjs';
const code=continueRelease('herdr/retry.mjs',JSON.parse(process.argv[2]));
if(code!==null)process.exitCode=code;else console.log(JSON.stringify({release:bundleRelease(),cwd:process.cwd(),args:process.argv.slice(3)}));`);
    f.tool('manifest', root);
  }
  const hostile = { HOME: path.join(f.root, 'wrong-home'), HERDR_MONITOR_HOME: path.join(f.root, 'wrong') };
  const entry = f.run('bash', [path.join(f.releases.green, 'herdr/release.sh'), 'exec', 'supervisor/supervisor.mjs', '--repo', repo], f.root, hostile);
  assert.equal(f.ok(entry), 'blue');
  const watcher = f.run('sh', [path.join(f.releases.green, 'supervisor/arm-watch.sh'), 'R-1', '--cwd', repo, '--dry-run'], f.root, hostile);
  assert.equal(f.ok(watcher), 'blue');
  const direct = JSON.parse(f.node([path.join(f.home, 'current/supervisor/supervisor.mjs'), '--repo', 'project', '--trace-args'], f.root));
  assert.equal(direct.id, 'blue'); assert.equal(direct.cwd, f.root);
  assert.deepEqual(direct.args, ['--repo', 'project', '--trace-args']);
  f.pin(repo, 'green');
  const saved = { root: f.releases.blue, id: 'blue', commit: '1'.repeat(40), protocol: 1 };
  const continued = JSON.parse(f.node([path.join(f.releases.green, 'herdr/retry.mjs'), JSON.stringify(saved), 'relative/input'], f.root));
  assert.equal(continued.release.root, f.releases.blue); assert.equal(continued.cwd, f.root);
  assert.deepEqual(continued.args, ['relative/input']);
});

test('an invalid accepted pin fails closed instead of silently falling back to current', t => {
  const f = fixture(t), repo = f.project('project'); f.pin(repo, 'blue');
  fs.unlinkSync(path.join(f.releases.blue, 'housekeeping/housekeeping.mjs'));
  const result = f.run(process.execPath, [path.join(f.bin, 'record'), 'help'], repo);
  assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
  assert.notEqual(f.run(process.execPath, [path.join(source, 'herdr/releases.mjs'), 'pin', f.home, repo, 'absent']).status, 0);
});

test('housekeeping admitted on blue keeps its child and evidence after the project adopts green', t => {
  const f = fixture(t, { markers: false }), repo = f.project('project'); f.pin(repo, 'blue');
  const org = path.join(f.root, 'record'); fs.mkdirSync(org); fs.writeFileSync(path.join(org, 'events.jsonl'), '');
  const fake = path.join(f.root, 'fake.cjs');
  fs.writeFileSync(fake, `#!${process.execPath}\nconst a=process.argv.slice(2);console.log(JSON.stringify(a[0]==='status'?{runs:[],items:[]}:{result:{workspaces:[],agents:[],tabs:[]}}));`, { mode: 0o755 });
  const trace = path.join(f.root, 'children.jsonl'), preload = path.join(f.root, 'move-pin.mjs');
  // The launcher has admitted blue before this child starts. Move the pin at
  // child startup, then trace its real tidy-tabs subprocess without mocking it.
  fs.writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1]?.endsWith('/housekeeping/housekeeping.mjs')){fs.writeFileSync(${JSON.stringify(path.join(repo, '.herdr-release.json'))},JSON.stringify({release:'green'}));cp.execFileSync('git',['-C',${JSON.stringify(repo)},'commit','-qam','adopt green']);}
const original=cp.spawnSync;cp.spawnSync=function(command,args,options){if(args?.[0]?.endsWith('/supervisor/tidy-tabs.mjs'))fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+'\\n');return original.call(this,command,args,options)};syncBuiltinESMExports();`);
  const output = f.node([path.join(source, 'herdr/releases.mjs'), 'exec', f.home, 'housekeeping/housekeeping.mjs',
    '--once', '--dry-run', '--cwd', repo, '--org', org, '--state-dir', path.join(f.root, 'housekeeping-state'), '--herdr', fake, '--org-cli', fake], repo,
  { NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(pathToFileURL(preload).href)}` });
  const rows = output.split('\n').map(JSON.parse); assert.ok(rows.length);
  assert.ok(rows.every(row => row.release.root === f.releases.blue));
  const child = JSON.parse(fs.readFileSync(trace, 'utf8').trim());
  assert.equal(child[0], path.join(f.releases.blue, 'supervisor/tidy-tabs.mjs'));
  assert.equal(JSON.parse(f.tool('exec', f.home, 'herdr/probe.mjs')).id, 'green');
  const next = f.ok(f.run(process.execPath, [path.join(source, 'herdr/releases.mjs'), 'exec', f.home, 'herdr/probe.mjs'], repo));
  assert.equal(JSON.parse(next).id, 'green');
});

test('a green drain resumes a blue promotion and its children from the recorded immutable bundle', async t => {
  const f = fixture(t, { markers: false }), repo = f.project('project'); f.pin(repo, 'blue');
  const org = path.join(f.root, 'record'); fs.mkdirSync(org); fs.writeFileSync(path.join(org, 'events.jsonl'), '');
  const trace = path.join(f.root, 'promotion-child.jsonl'), fake = path.join(f.root, 'herdr.cjs');
  fs.writeFileSync(fake, `#!${process.execPath}\nconst a=process.argv.slice(2);let result={workspaces:[],agents:[]};if(a[0]==='agent'&&a[1]==='get')result={agent:{agent:'claude',agent_status:'idle',pane_id:'fake:supervisor'}};if(a[0]==='pane'&&a[1]==='read'){console.log('────────────────────\\n❯ \\n────────────────────');}else console.log(JSON.stringify({result}));`, { mode: 0o755 });
  const inbox = path.join(org, 'supervisor/inbox.log');
  f.teardown.push(async () => {
    const owner = path.join(`${inbox}.owner.lock`, 'owner.json');
    if (fs.existsSync(owner)) {
      const script = JSON.parse(fs.readFileSync(owner, 'utf8')).argv[1];
      assert.ok(Object.values(f.releases).some(root => script === path.join(root, 'supervisor/prompt-supervisor.mjs')));
      await stopFixtureInbox(inbox, { script });
    }
  });
  const admit = `import {queueFor,enqueue} from ${JSON.stringify(pathToFileURL(path.join(f.releases.blue, 'promote/promote.mjs')).href)};
enqueue(queueFor(${JSON.stringify(repo)}),['topic'],{to:'supervisor-fixture',attempts:1,retry:0,herdr:${JSON.stringify(fake)},org:${JSON.stringify(org)},laneCLI:${JSON.stringify(path.join(f.releases.blue, 'herdr/child.mjs'))}});`;
  f.node(['--input-type=module', '-e', admit], repo);
  f.pin(repo, 'green');
  f.node([path.join(f.releases.green, 'promote/promote.mjs'), '--drain', '--repo', repo], repo, { PIN_TRACE: trace });
  const queue = JSON.parse(fs.readFileSync(path.join(repo, '.git/promote/queue.json'), 'utf8'));
  assert.equal(queue.current, null); assert.equal(queue.results.length, 1);
  assert.equal(queue.results[0].release.root, f.releases.blue); assert.equal(queue.results[0].outcome, 'refused');
  assert.equal(JSON.parse(fs.readFileSync(trace, 'utf8').trim()).root, f.releases.blue);
  assert.ok(fs.existsSync(f.releases.blue), 'completed and recoverable evidence retains its bundle');
});

test('different bundles keep the same host slot and read each other\'s occupancy identity', t => {
  const f = fixture(t), lock = path.join(f.root, 'shared-slot');
  const url = (id, relative) => JSON.stringify(pathToFileURL(path.join(f.releases[id], relative)).href);
  const code = `import assert from 'node:assert/strict';
import * as blue from ${url('blue', 'test-slot/test-slot.mjs')};import * as green from ${url('green', 'test-slot/test-slot.mjs')};
import {sharedOccupancy} from ${url('blue', 'test-slot/occupancy.mjs')};import {readTestSlotOccupancy} from ${url('green', 'test-slot/occupancy.mjs')};
assert.equal(blue.slotPathOf({}),green.slotPathOf({}));
const held=sharedOccupancy(${JSON.stringify(lock)},'blue',{reason:'fixture shared work'});
try { const rows=readTestSlotOccupancy(${JSON.stringify(lock)});assert.equal(rows.length,1);assert.equal(rows[0].record.schema,'occupancy/v1');assert.equal(rows[0].state,'live');assert.equal(rows[0].record.pid,process.pid); } finally {held.release();}`;
  f.node(['--input-type=module', '-e', code]);
});

test('mixed-version interrupted batches are attempted once per drain', t => {
  const f = fixture(t, { markers: false }), repo = f.project('project');
  const org = path.join(f.root, 'record'); fs.mkdirSync(org); fs.writeFileSync(path.join(org, 'events.jsonl'), '');
  const trace = path.join(f.root, 'attempts.jsonl'), handoffs = path.join(f.root, 'handoffs.json');
  const fake = path.join(f.root, 'herdr.cjs');
  fs.writeFileSync(fake, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='pane'&&a[1]==='read')console.log('────────────────────\\n❯ \\n────────────────────');else console.log(JSON.stringify({result:a[0]==='agent'&&a[1]==='get'?{agent:{agent:'claude',agent_status:'idle',pane_id:'fake:supervisor'}}:{workspaces:[],agents:[]}}));`, { mode: 0o755 });
  const inbox = path.join(org, 'supervisor/inbox.log');
  f.teardown.push(async () => {
    const file = path.join(`${inbox}.owner.lock`, 'owner.json');
    if (fs.existsSync(file)) await stopFixtureInbox(inbox, { script: JSON.parse(fs.readFileSync(file, 'utf8')).argv[1] });
  });
  const seed = `import {randomUUID} from 'node:crypto';import {queueFor} from ${JSON.stringify(pathToFileURL(path.join(f.releases.green, 'promote/promote.mjs')).href)};
queueFor(${JSON.stringify(repo)}).transaction(data=>{data.interrupted=${JSON.stringify(Object.entries(f.releases))}.map(([id,root],index)=>({id:randomUUID(),phase:'batching',jobs:[{id:randomUUID(),topic:'topic-'+id,release:{root,id,commit:String(index+1).repeat(40),protocol:1},to:'supervisor-fixture',attempts:1,retry:0,herdr:${JSON.stringify(fake)},org:${JSON.stringify(org)},laneCLI:root+'/herdr/child.mjs'}]}));});`;
  f.node(['--input-type=module', '-e', seed], repo);
  const guard = path.join(f.root, 'bounded-handoffs.mjs');
  // A regression must fail after four transfers instead of generating an
  // unbounded process chain on the shared host.
  fs.writeFileSync(guard, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawnSync;cp.spawnSync=function(command,args,options){if(args?.includes('--attempted-batches')){const file=${JSON.stringify(handoffs)};const count=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):0;if(count>=4)throw Error('fixture transfer bound exceeded');fs.writeFileSync(file,JSON.stringify(count+1));}return original.call(this,command,args,options)};syncBuiltinESMExports();`);
  f.node([path.join(f.releases.green, 'promote/promote.mjs'), '--drain', '--repo', repo], repo,
    { PIN_TRACE: trace, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(pathToFileURL(guard).href)}` });
  const queue = JSON.parse(fs.readFileSync(path.join(repo, '.git/promote/queue.json'), 'utf8'));
  assert.equal(queue.current, null); assert.equal(queue.interrupted.length, 2); assert.equal(queue.results.length, 2);
  assert.ok(queue.results.every(row => row.outcome === 'interrupted'));
  assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line).id), ['blue', 'green']);
  assert.equal(JSON.parse(fs.readFileSync(handoffs, 'utf8')), 2);
});

test('a pinned project runs its own canonical and lane source while installed launchers run the pin', t => {
  const f = fixture(t), repo = f.project('source-project');
  copyProduct(source, repo); f.pin(repo, 'blue');
  f.git(repo, 'add', '.'); f.git(repo, 'commit', '-qm', 'track source runtime');
  const lane = path.join(f.root, 'source-lane'); f.git(repo, 'worktree', 'add', '-b', 'lane/development', lane);
  for (const [index, checkout] of [repo, lane].entries()) {
    const record = path.join(f.root, `source-record-${index}`);
    const output = f.node([path.join(checkout, 'bin/org.mjs'), 'init', record], checkout);
    assert.match(output, /initialized /); assert.ok(fs.existsSync(path.join(record, 'events.jsonl')));
    assert.equal(f.node([path.join(f.bin, 'record'), 'help'], checkout), 'blue');
  }
  const foreign = f.project('foreign-project'); f.pin(foreign, 'blue');
  const account = path.join(f.root, 'fixture-account.mjs');
  fs.writeFileSync(account, `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';const original=os.userInfo;os.userInfo=(...args)=>({...original(...args),homedir:${JSON.stringify(f.root)}});syncBuiltinESMExports();`);
  const output = f.node([path.join(repo, 'bin/org.mjs'), 'init', path.join(f.root, 'foreign-record')], foreign,
    { NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(pathToFileURL(account).href)}` });
  assert.equal(output, 'blue', 'another project still selects its pin when calling this source bundle');
  assert.equal(fs.existsSync(path.join(f.root, 'foreign-record')), false);
});

test('launch checks avoid payload reads while pinning verifies the full runtime hashes', t => {
  const f = fixture(t), repo = f.project('project'); f.pin(repo, 'blue');
  const payload = path.join(f.releases.blue, 'lib/state.mjs');
  fs.appendFileSync(payload, '\n// fixture payload changed after acceptance\n');
  const probe = path.join(f.root, 'no-payload-read.mjs');
  fs.writeFileSync(probe, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const read=fs.readFileSync;fs.readFileSync=function(file,...args){if(String(file)===${JSON.stringify(payload)})throw Error('launch read non-entry payload');return read.call(this,file,...args)};syncBuiltinESMExports();`);
  assert.equal(f.node([path.join(f.bin, 'record'), 'help'], repo,
    { NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(pathToFileURL(probe).href)}` }), 'blue');
  const rejected = f.run(process.execPath, [path.join(source, 'herdr/releases.mjs'), 'pin', f.home, repo, 'blue']);
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /incomplete release blue: lib\/state\.mjs/);
});

test('scratch source admission bounds Git probes and observes each new canonical pin', t => {
  const f = fixture(t), runtime = f.project('runtime'), target = f.project('target');
  const separate = f.project('separate'), separateGit = path.join(f.root, 'separate.git');
  f.git(separate, 'init', '--separate-git-dir', separateGit);
  const unborn = path.join(f.root, 'unborn'); fs.mkdirSync(unborn); f.git(unborn, 'init', '-qb', 'main');
  copyProduct(source, runtime); f.git(runtime, 'add', '.'); f.git(runtime, 'commit', '-qm', 'source bundle');
  const scratch = path.join(runtime, '.git/promote/batches/fixture/scratch-0');
  f.git(runtime, 'worktree', 'add', '--detach', scratch);
  const probe = path.join(f.root, 'source-admission.mjs');
  fs.writeFileSync(probe, `import assert from 'node:assert/strict';import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const execute=cp.execFileSync;let calls=0;cp.execFileSync=function(command,...args){if(command==='git')calls++;return execute.call(this,command,...args)};syncBuiltinESMExports();
const {forwardRelease,bundleRelease,projectPin}=await import(${JSON.stringify(pathToFileURL(path.join(scratch, 'lib/releases.mjs')).href)});
assert.equal(forwardRelease('bin/org.mjs',${JSON.stringify(target)}),null);
assert.ok(calls<=4,'unpinned source admission exceeded four Git probes: '+calls);
assert.deepEqual(bundleRelease(),{root:${JSON.stringify(scratch)},id:null,commit:null,protocol:1});
fs.writeFileSync(${JSON.stringify(path.join(target, '.herdr-release.json'))},JSON.stringify({release:'blue'}));
execute('git',['-C',${JSON.stringify(target)},'add','.herdr-release.json']);execute('git',['-C',${JSON.stringify(target)},'commit','-qm','adopt blue']);
assert.equal(projectPin(${JSON.stringify(target)}).release,'blue');
fs.writeFileSync(${JSON.stringify(path.join(target, '.herdr-release.json'))},JSON.stringify({release:null}));
execute('git',['-C',${JSON.stringify(target)},'commit','-qam','rollback to current']);
assert.equal(projectPin(${JSON.stringify(target)}).release,null);
assert.equal(projectPin(${JSON.stringify(separate)}).project.identity,${JSON.stringify(separateGit)});
assert.equal(projectPin(${JSON.stringify(unborn)}).release,null);
assert.equal(projectPin(${JSON.stringify(f.root)}),null);
console.log('bounded scratch admission and fresh canonical selection');`);
  assert.equal(f.node([probe], target), 'bounded scratch admission and fresh canonical selection');
});
