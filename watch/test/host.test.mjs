import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {ensureObserver} from '../host.mjs';

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'line-observer-host-'))),org=path.join(root,'.org'),repo=root;
  const fleet=process.env.HERDR_MONITOR_FLEET;process.env.HERDR_MONITOR_FLEET=path.join(root,'fleet');
  t.after(()=>{if(fleet===undefined)delete process.env.HERDR_MONITOR_FLEET;else process.env.HERDR_MONITOR_FLEET=fleet;fs.rmSync(root,{recursive:true,force:true});});
  const directory=path.join(org,'watch/observer'),source=path.resolve(import.meta.dirname,'../..');fs.mkdirSync(directory,{recursive:true});
  let launches=0,live=true,refused=false;const children=[];
  const options={repo,org,project:'fixture-common',directory,env:{HERDR_SOCKET_PATH:path.join(root,'socket')},
    alive:()=>live,birth:pid=>`birth:${pid}`,wait:async()=>{},timeoutMs:1,
    start:(exe,args,opts)=>{
      launches++;assert.equal(exe,process.execPath);assert.equal(args[0],path.join(source,'watch/observer.mjs'));
      assert.equal(opts.detached,true);assert.ok(!args.includes('--watch-mode'));
      const child=Object.assign(new EventEmitter(),{pid:100+launches,exitCode:refused?1:null,unref(){}});children.push(child);
      if(!refused)fs.writeFileSync(path.join(directory,'owner.json'),JSON.stringify({org,repo,project:'fixture-common',source,
        socket:options.env.HERDR_SOCKET_PATH,pid:child.pid,identity:`birth:${child.pid}`}));
      return child;
    }};
  return{options,directory,children,get launches(){return launches;},live:v=>{live=v;},refuse:v=>{refused=v;},run:extra=>ensureObserver({...options,...extra})};
}

test('shared watch host starts once, reuses the exact live birth and restarts after proven death',async t=>{
  const f=fixture(t),first=await f.run();assert.equal(first.state,'ready');assert.equal(f.launches,1);
  assert.equal((await f.run()).state,'ready');assert.equal(f.launches,1);
  const old=first.host.pid;
  const second=await f.run({alive:owner=>owner.pid!==old});assert.equal(second.state,'ready');assert.equal(f.launches,2);
  assert.equal(second.previous.host.pid,old);
});

test('shared watch host refuses once, preserves its hold and recovers only on explicit retry',async t=>{
  const f=fixture(t);f.refuse(true);const first=await f.run();assert.equal(first.code,'SHARED_OBSERVER_HELD');
  f.refuse(false);f.live(false);assert.deepEqual(await f.run(),first);assert.equal(f.launches,1);
  assert.equal((await f.run({retry:true,alive:owner=>owner.pid!==101})).state,'ready');assert.equal(f.launches,2);
});

test('shared watch host preserves UNKNOWN launch and foreign live source without replacement',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.directory,'line-host.json'),JSON.stringify({id:'original',state:'starting'}));
  assert.equal((await f.run()).code,'SHARED_OBSERVER_HELD');assert.equal(f.launches,0);
  fs.writeFileSync(path.join(f.directory,'owner.json'),JSON.stringify({pid:77,identity:'old',source:'/other'}));
  assert.equal((await f.run({retry:true})).code,'SHARED_OBSERVER_HELD');assert.equal(f.launches,0);
});

test('shared watch host rechecks STOP at startup and retains the original child on uncertainty',async t=>{
  const f=fixture(t);let guards=0;
  const held=await f.run({guard:()=>{if(++guards>2)throw Error('STOP/HOLD');}});
  assert.equal(held.code,'SHARED_OBSERVER_HELD');assert.match(held.reason,/STOP/);assert.equal(f.launches,1);
  assert.equal((await f.run()).id,held.id);assert.equal(f.launches,1);
});

test('shared watch host rechecks a foreign live owner and starts only after its proven death',async t=>{
  const f=fixture(t),file=path.join(f.directory,'owner.json');
  fs.writeFileSync(file,JSON.stringify({pid:77,identity:'foreign-birth',source:'/previous-build'}));
  const held=await f.run();assert.equal(held.state,'held');assert.equal(held.recheck,true);assert.equal(f.launches,0);
  assert.equal((await f.run()).id,held.id);assert.equal(f.launches,0);
  const ready=await f.run({alive:owner=>owner.pid!==77});assert.equal(ready.state,'ready');assert.equal(f.launches,1);
  assert.equal(ready.previous.id,held.id);
});

test('shared watch host accepts a late exact readiness receipt without retry or another launch',async t=>{
  const f=fixture(t),file=path.join(f.directory,'owner.json');let original;
  const held=await f.run({wait:async()=>{if(fs.existsSync(file)){original=fs.readFileSync(file);fs.unlinkSync(file);}}});
  assert.equal(held.state,'held');assert.equal(held.recheck,true);assert.equal(f.launches,1);assert.ok(original);
  assert.equal((await f.run()).state,'held');assert.equal(f.launches,1,'live uncertain child is retained');
  fs.writeFileSync(file,original);
  const ready=await f.run();assert.equal(ready.state,'ready');assert.equal(ready.id,held.id);assert.equal(f.launches,1);
  assert.equal(ready.host.pid,held.child.pid);assert.equal(ready.host.identity,held.child.identity);
});

test('shared watch host rechecks a guard refusal before launch when the install or STOP boundary clears',async t=>{
  const f=fixture(t),held=await f.run({guard:()=>{throw Error('installation starting or STOP');}});
  assert.equal(held.state,'held');assert.equal(held.recheck,true);assert.equal(f.launches,0);
  assert.equal((await f.run()).state,'ready');assert.equal(f.launches,1);
});
