import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {reconcileCloseoutBacklog} from '../lib/closeout-backlog.mjs';

test('a corrected legacy classification appends its binding exception without replacing the original wait or attempt',t=>{
  const f=setup(t,{direct:true,bound:true});selectCurrentCleanup(f);const [source]=f.report(),entry=source.closeout_targets[0];
  const original=events(f);original.find(e=>e.seq===source.seq).closeout_targets[0].schema='closeout-entry/v1';
  fs.writeFileSync(f.eventFile,original.map(e=>JSON.stringify(e)+'\n').join(''));
  const [evaluation]=f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,source:{seq:source.seq,type:source.type},
    run:entry.run,item:entry.item,revision:source.seq,completed:false,reason:'retirement deadline reached; request remains pending'}]);
  f.append([{type:'closeout.waiting',identity:f.common,key:entry.key,source:{seq:source.seq,type:source.type},wait_id:'original-wait',
    waiting:{owner:'line-service',defect:'No existing completion writer',producers:[]}},
  {type:'closeout.wait-classified',identity:f.common,key:entry.key,source:{seq:source.seq,type:source.type},wait_id:'original-wait',
    evaluation_seq:evaluation.seq,disposition:'continuation'}]);
  const before=events(f),calls=f.herdrCalls(),args={project:gitProject(f.repo),org:f.org,events:before,guard:()=>{}};
  const rows=reconcileCloseoutBacklog(args);assert.equal(rows.length,1);assert.equal(rows[0].disposition,'held');
  assert.deepEqual(rows[0].binding,{schema:'closeout-entry/v1',actionable:false});
  assert.deepEqual(events(f).slice(0,before.length),before);assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.read().actions,[]);
  assert.deepEqual(reconcileCloseoutBacklog({...args,events:events(f)}),[]);
});

test('a returning binding appends after A to B to A and frees bounded turns for later waits and allocations',t=>{
  const f=setup(t,{direct:true,bound:true});selectCurrentCleanup(f);const [source]=f.report(),entry=source.closeout_targets[0];
  const ref={seq:source.seq,type:source.type};
  const [evaluation]=f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,source:ref,
    run:entry.run,item:entry.item,revision:source.seq,completed:false,reason:'original native refusal; keep'}]);
  const wait=wait_id=>({type:'closeout.waiting',identity:f.common,key:entry.key,source:ref,wait_id,
    waiting:{owner:'line-service',defect:'No existing completion writer',producers:[]}});
  f.append([wait('first-wait')]);
  const args={project:gitProject(f.repo),org:f.org,maxRows:1,guard:()=>{}};
  const turn=()=>reconcileCloseoutBacklog({...args,events:events(f)});
  const [a]=turn();assert.equal(a.wait_id,'first-wait');assert.equal(a.evaluation_seq,evaluation.seq);
  // Retained history records an intervening inadmissible binding under the
  // same evaluation. The currently admitted target is A again.
  const {seq,at,by,...classification}=a;
  const b={schema:'closeout-entry/v1',actionable:false};
  f.append([{...classification,binding:b},wait('later-wait'),
    {type:'item.added',id:'ENG-2',role:'engineer',title:'Active allocation'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:f.lane+'-open',meta:{dispatch_project:f.common}}]);
  const before=events(f),bytes=fs.readFileSync(f.eventFile),calls=f.herdrCalls(),gitCalls=f.gitCalls(),actions=f.read().actions;
  const [restored]=turn();assert.ok(restored,'latest B must not be hidden by historical A');
  assert.equal(restored.wait_id,'first-wait');assert.equal(restored.evaluation_seq,a.evaluation_seq);
  assert.deepEqual(restored.binding,a.binding);
  const [later]=turn();assert.equal(later.wait_id,'later-wait');
  const [allocation]=turn();assert.equal(allocation.type,'closeout.allocation-kept');assert.equal(allocation.run,'R-2');
  assert.deepEqual(turn(),[],'unchanged latest bindings consume no further slots');
  const all=events(f),history=all.filter(e=>e.type==='closeout.wait-classified'&&e.wait_id==='first-wait');
  assert.deepEqual(history.map(e=>e.binding),[a.binding,b,a.binding]);
  assert.deepEqual(all.slice(0,before.length),before);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,bytes.length),bytes);
  assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.gitCalls(),gitCalls);assert.deepEqual(f.read().actions,actions);
  assert.equal(all.slice(before.length).some(e=>['closeout.effect','run.started','run.abandoned','run.session_bound'].includes(e.type)),false);
});
