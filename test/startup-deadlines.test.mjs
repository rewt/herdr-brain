import { loadTimeout } from '../lib/deadline.mjs';
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { resumeInbox } from '../supervisor/prompt-supervisor.mjs';
import { fileURLToPath } from 'node:url';
import { installRuntime } from '../housekeeping/test/helpers/cli-fixture.mjs';

process.env.ORG_ACTOR = 'startup-deadlines-test';
const local = file => fileURLToPath(new URL(file, import.meta.url));
for (const module of ['watch', 'promote', 'inbox', 'housekeeping']) {
  test(`${module} acknowledges a delayed startup at load 24, without launching real background work`, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loaded-startup-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    if (module === 'inbox') {
      const inbox = path.join(root, 'inbox.log');
      fs.writeFileSync(inbox, JSON.stringify({ type: 'notice', id: 'loaded', to: 'fake', message: 'queued' }) + '\n');
      const spawn = childProcess.spawn, timer = globalThis.setTimeout;
      const load = os.loadavg, capacity = os.availableParallelism;
      os.loadavg = () => [24, 24, 24]; os.availableParallelism = () => 4;
      globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms >= 5000 ? ms / 100 : ms, ...args);
      childProcess.spawn = () => {
        const child = new EventEmitter();
        child.pid = 123; child.connected = true;
        child.unref = () => {}; child.disconnect = () => { child.connected = false; };
        timer(() => child.emit('message', { ready: true, pid: 123 }), 150);
        return child;
      };
      syncBuiltinESMExports();
      try { assert.equal(await resumeInbox(inbox), 123); }
      finally {
        childProcess.spawn = spawn; globalThis.setTimeout = timer;
        os.loadavg = load; os.availableParallelism = capacity; syncBuiltinESMExports();
      }
      return;
    }
    const repo = path.join(root, 'project'); fs.mkdirSync(repo);
    const env = { ...process.env, ORG_ACTOR: `startup-${module}-fixture`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
    const git = spawnSync('git', ['init', '-qb', 'main', repo], { env, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    const preload = path.join(root, 'startup.cjs');
    fs.writeFileSync(preload, `const os=require('node:os');os.loadavg=()=>[24,24,24];os.availableParallelism=()=>4;
const cp=require('node:child_process'),EventEmitter=require('node:events'),spawn=cp.spawn,timer=setTimeout;
global.setTimeout=(fn,ms,...args)=>timer(fn,ms>=5000?ms/100:ms,...args);
cp.spawn=function(command,args,options){
if(!args.some(arg=>['--drain','--loop','--owner-worker'].includes(arg))&&!args[0]?.endsWith('/watch.mjs'))return spawn.call(this,command,args,options);
const child=new EventEmitter();child.pid=123;child.connected=true;child.unref=()=>{};child.disconnect=()=>{child.connected=false;};child.kill=()=>{throw Error('premature startup signal');};
timer(()=>child.emit('message',{ready:${JSON.stringify(module === 'watch' ? 'R-1' : true)},pid:123}),150);
return child;};require('node:module').syncBuiltinESMExports();`);
    let args;
    if (module === 'watch') args = [local('../watch/watch.mjs'), 'R-1', '--org', root, '--detach', '--cwd', repo, '--log', path.join(root, 'watch.log')];
    if (module === 'promote') args = [local('../promote/promote.mjs'), 'topic', '--repo', repo, '--org', root];
    if (module === 'housekeeping') args = [installRuntime(repo), '--start', '--cwd', repo, '--org', root,
      '--state-dir', path.join(root, 'state'), '--org-cli', '/usr/bin/true'];
    const result = spawnSync(process.execPath, ['--require', preload, ...args], { cwd: repo, env, encoding: 'utf8', timeout: loadTimeout(15000) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /123/);
    assert.equal(fs.existsSync(path.join(root, 'state/lock')), false, 'no real housekeeping loop was started');
  });
}
