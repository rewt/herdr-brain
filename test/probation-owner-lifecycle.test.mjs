import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fold} from '../lib/state.mjs';
import {transact,loadEvents} from '../lib/store.mjs';
import {itemLaunchHold,trialOwnerHold} from '../lib/item-launch-hold.mjs';
import {trialsAffectedByClose} from '../lib/trial-close-warning.mjs';
import {authorityOwner} from '../line-service/probation.mjs';
import {fixture} from './helpers/line-service-probation-fixture.mjs';

function ownerEvents() {
  return [
    {type:'item.added',id:'G-1',kind:'goal'},
    {type:'item.added',id:'ENG-1',kind:'work',role:'engineer',parent:'G-1'},
    {type:'run.started',id:'R-1',item:'ENG-1'},
    {type:'note.added',id:'R-1',decision:true,seq:4},
    {type:'line-service.probation-authorized',id:'trial',authority:4,project:'project',org:'record'},
  ];
}

test('trial ownership survives ordinary closure while launch and explicit boundaries stay guarded',()=>{
  const events=ownerEvents();
  for(const as of ['done','dropped']) {
    const closed=[...events,...['ENG-1','G-1'].map(id=>({type:'item.closed',id,as}))],state=fold(closed);
    assert.equal(trialOwnerHold(state,'ENG-1'),null);
    assert.equal(itemLaunchHold(state,'ENG-1').subject,'ENG-1');
    assert.doesNotThrow(()=>authorityOwner(events[3],closed));
    for(const id of ['ENG-1','G-1']) {
      for(const flag of ['hold','held','reserved','operator_reserved']) {
        const held=[...closed,{type:'item.updated',id,fields:{meta:{[flag]:true}}}];
        assert.equal(trialOwnerHold(fold(held),'ENG-1').subject,id);
        assert.throws(()=>authorityOwner(events[3],held),/authority HOLD/);
      }
      const human=[...closed,{type:'item.updated',id,fields:{role:'human'}}];
      assert.throws(()=>authorityOwner(events[3],human),/authority HOLD/);
    }
    assert.throws(()=>authorityOwner(events[3],[...closed,{type:'run.abandoned',id:'R-1'}]),/unavailable/);
    const missing=fold(closed);missing.items.delete('G-1');
    assert.match(trialOwnerHold(missing,'ENG-1').reason,/missing/);
    assert.match(trialOwnerHold(missing,'absent').reason,/missing/);
    const cycle=fold(closed);cycle.items.get('G-1').parent='ENG-1';
    assert.match(trialOwnerHold(cycle,'ENG-1').reason,/cycle/);
  }
});

test('close warnings follow item or run authority ancestry and only the matching active trial',()=>{
  for(const authority of ['R-1','ENG-1']) {
    const events=ownerEvents();events[3].id=authority;
    const state=fold(events);
    for(const id of ['ENG-1','G-1'])assert.deepEqual(trialsAffectedByClose(state,events,id),[{id:'trial',owner:'ENG-1'}]);
    assert.deepEqual(trialsAffectedByClose(state,events,'unrelated'),[]);
    for(const type of ['line-service.probation-withdrawn','line-service.probation-completed']) {
      const foreign={type,id:'trial',project:'foreign',org:'record'};
      assert.equal(trialsAffectedByClose(state,[...events,foreign],'G-1').length,1);
      assert.deepEqual(trialsAffectedByClose(state,[...events,{...foreign,project:'project'}],'G-1'),[]);
    }
  }
});

test('fixture ancestor and owner closure leave an installed trial line admitted; explicit hold refuses then recovers',async t=>{
  const f=await fixture(t);
  transact(f.org,()=>({add:[
    {type:'item.added',id:'G-2',kind:'goal',title:'Ancestor'},
    {type:'item.updated',id:'G-1',fields:{parent:'G-2'}},
    {type:'item.added',id:'ENG-1',kind:'work',role:'engineer',parent:'G-1',title:'Trial owner'},
  ]}));
  const preview=f.control({dryRun:true});
  const note=transact(f.org,()=>({add:[{type:'note.added',id:'ENG-1',decision:true,text:preview.required_decision}]}),{actor:f.agent.name}).added[0];
  f.control({expectedPlan:preview.plan_sha256,authority:note.seq});
  f.enter();
  fs.unlinkSync(f.stop); // Only the private fixture's synthetic stopped entry.
  const {createLineService}=await f.module(f.next,'line-service/line-service.mjs');
  const service=createLineService({repo:f.cwd,org:f.org,to:f.agent.name,runtimeHome:f.installationHome,env:f.env,haltAfter:100,
    command:()=>({status:0,stdout:'{"created":[]}'}),capacity:()=>({count:0,cap:2})});
  const pass=()=>{
    const result=service.pass();
    assert.equal(result.result,'pass-complete',JSON.stringify(result));
  };
  const before={archive:fs.readFileSync(path.join(f.directory,'probation/original-trial.json'),'utf8'),
    installation:fs.readFileSync(f.installationFile,'utf8'),plist:fs.readFileSync(f.file,'utf8')};
  const close=(id,...extra)=>spawnSync(process.execPath,[path.join(f.next,'bin/org.mjs'),'close',id,...extra],
    {cwd:f.cwd,env:{...f.env,HERDR_BRAIN_ROOT:f.next},encoding:'utf8'});
  for(const id of ['G-2','ENG-1','G-1']) {
    const result=close(id);
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/warning: active trial original-trial is owned by ENG-1/);
    assert.equal(f.admit().probation.id,'original-trial');
    pass();
  }
  assert.doesNotMatch(close('G-2').stdout,/warning:/,'an unchanged close does not warn again');
  const dropped=close('G-2','--dropped');assert.equal(dropped.status,0,dropped.stderr);
  assert.match(dropped.stdout,/warning: active trial/);assert.equal(f.admit().probation.id,'original-trial');
  for(const id of ['ENG-1','G-2']) {
    for(const flag of ['hold','held','reserved','operator_reserved']) {
      transact(f.org,()=>({add:[{type:'item.updated',id,fields:{meta:{[flag]:true}}}]}));
      assert.throws(f.admit,/authority HOLD/);
      assert.match(service.pass().held,/authority HOLD/);
      transact(f.org,()=>({add:[{type:'item.updated',id,fields:{meta:{[flag]:false}}}]}));
      assert.equal(f.admit().probation.id,'original-trial');
    }
  }
  pass();
  assert.equal(fs.readFileSync(path.join(f.directory,'probation/original-trial.json'),'utf8'),before.archive);
  assert.equal(fs.readFileSync(f.installationFile,'utf8'),before.installation);
  assert.equal(fs.readFileSync(f.file,'utf8'),before.plist);
  assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs,'original callbacks remain unchanged');
  assert.equal(loadEvents(f.org).events.filter(e=>e.type==='line-service.probation-authorized').length,1);
  f.withdraw();assert.throws(f.admit,/withdrawn/);
  assert.doesNotMatch(close('G-1','--dropped').stdout,/warning: active trial/);
});
