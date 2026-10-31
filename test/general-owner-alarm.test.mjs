import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {observeGeneralOwners} from '../line-service/general-owner-alarm.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';

test('general owner alarm groups sustained contention, deduplicates and clears on admission',t=>{
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'general-alarm-')));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const releases=[0,1].map(n=>noticeLock(path.join(directory,`general-${n}.lock`)));
  t.after(()=>releases.forEach(release=>release()));
  const owners=[0,1].map(n=>fs.readFileSync(path.join(directory,`general-${n}.lock/owner.json`)));
  const at=new Date(Date.now()+1000).toISOString(),options={directory,identity:'fixture',org:directory,at};
  const log=()=>fs.existsSync(path.join(directory,'closeout.log'))?fs.readFileSync(path.join(directory,'closeout.log'),'utf8').trim().split('\n').map(JSON.parse):[];
  observeGeneralOwners({...options,blocked:true});observeGeneralOwners({...options,blocked:true});assert.equal(log().length,0);
  observeGeneralOwners({...options,blocked:true});
  const alarm=log()[0];assert.equal(alarm.action,'closeout-supervisor-alarm');assert.equal(alarm.boundary,'general-owner-held');assert.equal(alarm.count,2);
  assert.deepEqual(alarm.scopes.map(scope=>scope.owner),owners.map(bytes=>JSON.parse(bytes)));
  assert.ok(alarm.scopes.every(scope=>scope.age_ms>=1000&&/^[a-f0-9]{64}$/.test(scope.sha256)));
  observeGeneralOwners({...options,at:new Date(Date.parse(at)+1000).toISOString(),blocked:true});assert.equal(log().length,1,'age changes do not spam alarms');
  for(let n=0;n<2;n++)assert.deepEqual(fs.readFileSync(path.join(directory,`general-${n}.lock/owner.json`)),owners[n]);
  releases[0]();observeGeneralOwners({...options,blocked:false});assert.equal(log()[1].count,0);
  observeGeneralOwners({...options,blocked:false});assert.equal(log().length,2);
  // UNKNOWN metadata is retained and still becomes visible after three turns.
  fs.mkdirSync(path.join(directory,'general-0.lock'));fs.writeFileSync(path.join(directory,'general-0.lock/owner.json'),'{unknown');
  for(let n=0;n<3;n++)observeGeneralOwners({...options,blocked:true});
  assert.equal(log().length,3);assert.equal(log()[2].scopes[0].owner,null);assert.equal(log()[2].scopes[0].age_ms,null);
  assert.equal(fs.readFileSync(path.join(directory,'general-0.lock/owner.json'),'utf8'),'{unknown');
  t.diagnostic(JSON.stringify({alarms:log()}));
});

test('general owner alarm surfaces old owners immediately and retains an occupied diagnostic owner',t=>{
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'general-alarm-')));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const releases=[0,1].map(n=>noticeLock(path.join(directory,`general-${n}.lock`)));
  t.after(()=>releases.forEach(release=>release()));
  const options={directory,identity:'fixture',org:directory,at:new Date(Date.now()+1800001).toISOString(),blocked:true};
  const release=noticeLock(path.join(directory,'general-owner-alarm.lock')),bytes=fs.readFileSync(path.join(directory,'general-owner-alarm.lock/owner.json'));
  try{assert.equal(observeGeneralOwners(options),undefined);assert.deepEqual(fs.readFileSync(path.join(directory,'general-owner-alarm.lock/owner.json')),bytes);}
  finally{release();}
  const state=observeGeneralOwners(options);assert.equal(state.turns,1);assert.equal(state.alarmed,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'closeout.log'),'utf8')).count,2);
});
