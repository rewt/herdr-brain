import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {gitProject} from '../lib/project.mjs';
import {currentCloseoutEntries,publishCloseoutEvents} from '../lib/closeout.mjs';
import {refreshCloseouts} from '../lib/closeout-consumer.mjs';
import {setup,events,effects,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';

function fixture(t){
  const f=setup(t,{direct:true,bound:true,merged:true}),binding=selectCurrentCleanup(f);f.report();
  return Object.assign(f,binding,{project:gitProject(f.repo)});
}

test('source churn joins one immediate fresh turn after releasing locks and closes the original target',t=>{
  const f=fixture(t);let handoffs=0,drains=0;
  const args={project:f.project,org:f.org,env:f.env,guard:()=>{},measure:()=>{},maxSteps:1,cli:(file,argv)=>{
    if(argv[0]==='refresh')return '{}';
    if(file==='line-service/closeout.mjs'){
      handoffs++;assert.ok(argv.includes('--no-handoff'));
      for(const lock of [path.join(f.directory,'closeout-turn.lock'),path.join(f.org,'lock'),path.join(f.common,'closeout/consumer.lock')])assert.equal(fs.existsSync(lock),false,lock);
      assert.ok(Number(argv[argv.indexOf('--deadline')+1])<=Date.now()+45000);
      return JSON.stringify(runCloseoutTurn({...args,handoff:false}));
    }
    if(drains++===0)return JSON.stringify({restart:{keys:JSON.parse(argv[argv.indexOf('--keys')+1]),old:{code:'old'},current:{code:'fresh'}}});
    return JSON.stringify(f.drain({keys:JSON.parse(argv[argv.indexOf('--keys')+1]),retrySafe:true}));
  }};
  const result=runCloseoutTurn(args);assert.equal(result.result,'closeout-code-handoff');assert.equal(handoffs,1);
  assert.equal(result.successor.steps,1);assert.equal(fs.existsSync(f.lane),false);
  assert.equal(effects(f).filter(e=>e.action==='agent-exit-requested').length,1);
  assert.equal(effects(f).filter(e=>e.action==='closed'&&e.tab_id).length,1);
});

test('a second source change remains bounded and native refusal never grants a code successor',t=>{
  const f=fixture(t);let handoffs=0;
  const args={project:f.project,org:f.org,env:f.env,guard:()=>{},measure:()=>{},cli:(file,argv)=>{
    if(argv[0]==='refresh')return '{}';
    if(file==='line-service/closeout.mjs'){handoffs++;return JSON.stringify(runCloseoutTurn({...args,handoff:false}));}
    return JSON.stringify({restart:{keys:JSON.parse(argv[argv.indexOf('--keys')+1]),old:{code:'old'},current:{code:'fresh'}}});
  }};
  const result=runCloseoutTurn(args);assert.equal(handoffs,1);assert.equal(result.successor.result,'closeout-code-handoff-pending');
  assert.deepEqual(f.read().actions,[]);
  assert.throws(()=>runCloseoutTurn({...args,guard:()=>{throw Object.assign(Error('actual native refusal'),{code:'NATIVE_REFUSAL'});}}),/native refusal/);
  assert.equal(handoffs,1);
});

function withoutBinding(f){
  const all=events(f),source=all.find(e=>e.type==='report.ingested');delete source.closeout_targets;
  fs.writeFileSync(f.eventFile,all.map(e=>JSON.stringify(e)+'\n').join(''));
  return events(f).find(e=>e.seq===source.seq);
}

test('missing source binding becomes one typed exception and existing original-evidence refresh can progress it',t=>{
  const f=fixture(t),source=withoutBinding(f),publish=()=>publishCloseoutEvents({cwd:f.repo,org:f.org,env:f.env,added:[source],start:false});
  publish();publish();const rows=events(f).filter(e=>e.type==='closeout.binding-kept');assert.equal(rows.length,1);
  assert.equal(rows[0].condition.kind,'missing-identity');assert.deepEqual(rows[0].source,{seq:source.seq,type:source.type});
  for(const resource of ['session','folder','branch']){
    const kept=rows[0].resources[resource];assert.equal(kept.status,'kept');assert.equal(kept.scope.resource,resource);
    assert.equal(kept.owner,'R-1');assert.ok(kept.first_seen);assert.match(kept.continuation.next_observation,/existing finite/);
  }
  assert.deepEqual(f.read().actions,[]);
  const refreshed=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});assert.equal(refreshed.created.length,1);
  const target=currentCloseoutEntries(f.common,f.org,events(f)).find(e=>e.source.type==='cleanup.bound');
  assert.equal(f.drain({keys:[target.key],retrySafe:true}).evaluated[0].completed,true);
  assert.equal(fs.existsSync(f.lane),false);
});

test('missing binding cannot replace an original UNKNOWN allocation or read its native target',t=>{
  const f=fixture(t),source=withoutBinding(f);
  f.append([{type:'closeout.effect',identity:f.common,key:'original-unbound',run:'R-1',source:{seq:source.seq,type:source.type},effect:'original',
    producer:'native-closeout/v2',outcome:{action:'agent-exit-requested',pane:'w:p'}}]);
  const before=events(f),calls=f.herdrCalls();
  const result=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});assert.deepEqual(result.created,[]);
  assert.match(result.kept[0].reason,/original unbound cleanup attempt/);assert.deepEqual(f.herdrCalls(),calls);
  assert.deepEqual(events(f).slice(0,before.length),before);assert.equal(fs.existsSync(f.lane),true);
});
