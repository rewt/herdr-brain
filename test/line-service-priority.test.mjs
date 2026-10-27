import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import {fold} from '../lib/state.mjs';
import {queuePolicy,queueClass,queueSelected,orderQueue} from '../line-service/priority-order.mjs';
import {priorityOnlyReason,priorityMigrationPlan,priorityMigrationMutation} from '../line-service/priority-migration.mjs';
import {haltObservation} from '../line-service/halt-repair.mjs';

const authority='operator-adopted-20261027/priority-order.md; BACKLOG-RECONCILE-20261027/COMPARISON.md';
function fixture(){
  const events=[];
  const add=e=>events.push({...e,seq:events.length+1,at:'2026-10-27T00:00:00Z',by:'fixture'});
  add({type:'item.added',id:'G-1',kind:'goal',title:'Outcomes',meta:{queue_order:JSON.stringify(['finish-open-owned-work','stable-Brain-release','rehearsal-publication','Chipnet-withdrawal'])}});
  const item=(id,meta={},extra={})=>add({type:'item.added',id,kind:'work',role:'engineer',parent:'G-1',title:id,meta,...extra});
  const held=(id,meta={},extra={})=>{item(id,meta,extra);add({type:'item.updated',id,fields:{meta:{hold:true,hold_reason:priorityOnlyReason}}});};
  return {events,add,item,held,state:()=>fold(events)};
}

test('priority migration requires explicit on-path selection and preserves every independent hold or attempt',()=>{
  const f=fixture(),selected={queue_selected:true,queue_class:'stable-Brain-release'};
  f.held('ENG-1',selected);f.held('ENG-2');f.held('ENG-3',{...selected,reserved:true});
  f.held('ENG-4',selected);f.add({type:'note.added',id:'ENG-4',text:'HOLD: native scope needs owner judgment.'});
  f.held('ENG-5',{...selected,hold:true,hold_reason:'Independent safety hold'});
  f.held('ENG-6',selected);f.add({type:'run.started',id:'R-1',item:'ENG-6',meta:{}});
  f.held('ENG-7',selected);f.held('ENG-8',{...selected,held:true});
  f.held('ENG-9',{queue_selected:true,queue_class:'off-path'});
  f.item('ENG-10',{hold:true,hold_reason:'Unknown hold',...selected});
  const plan=priorityMigrationPlan({state:f.state(),events:f.events,attempted:['ENG-7'],authority});
  assert.deepEqual(plan.changes.map(c=>c.id),['G-1','ENG-1']);
  assert.equal(plan.retained.length,9);
  assert.equal(plan.changes[1].after.hold,false);assert.equal(plan.changes[1].after.queue_class,'stable-Brain-release');
});

test('priority migration and exact restore are idempotent and refuse changed subjects or standing order',()=>{
  const f=fixture();f.held('ENG-1',{queue_selected:true,queue_class:'stable-Brain-release'});
  const plan=priorityMigrationPlan({state:f.state(),events:f.events,authority}),archive={file:'/record/evidence/plan.json',sha256:'immutable-plan'};
  const mutate=restore=>priorityMigrationMutation({state:f.state(),events:f.events,plan,archive,restore});
  const before=f.state().items.get('ENG-1');mutate(false).add.forEach(f.add);
  assert.equal(f.state().items.get('ENG-1').meta.hold,false);
  assert.equal(mutate(false).add.length,0);mutate(true).add.forEach(f.add);
  assert.deepEqual(f.state().items.get('ENG-1'),before);
  assert.equal(Object.hasOwn(f.state().items.get('G-1').meta,'queue_default'),false,'restore removes previously absent keys exactly');
  assert.equal(mutate(true).add.length,0);
  const changed=fixture();changed.held('ENG-1',{queue_selected:true,queue_class:'stable-Brain-release'});
  const p=priorityMigrationPlan({state:changed.state(),events:changed.events,authority});
  changed.add({type:'item.updated',id:'ENG-1',fields:{meta:{hold_reason:'A new independent hold'}}});
  assert.throws(()=>priorityMigrationMutation({state:changed.state(),events:changed.events,plan:p,archive}),/subject changed/);
  const fresh=fixture(),p2=priorityMigrationPlan({state:fresh.state(),events:fresh.events,authority});
  fresh.add({type:'item.updated',id:'G-1',fields:{meta:{queue_order:'["rehearsal-publication","stable-Brain-release"]'}}});
  assert.throws(()=>priorityMigrationMutation({state:fresh.state(),events:fresh.events,plan:p2,archive}),/subject changed|standing order changed/);
});

test('standing order groups inherited outcomes and source reviews without creating a rehearsal dependency',()=>{
  const f=fixture();f.item('ENG-1',{queue_class:'stable-Brain-release'});f.item('ENG-2',{queue_class:'rehearsal-publication'});
  f.item('ENG-3',{queue_class:'Chipnet-withdrawal'});f.item('ENG-4',{}, {parent:'ENG-1',priority:-10});
  f.item('REV-1',{review_source_item:'ENG-2',review_target:{head:'captured'},review_round_cap:1},{role:'reviewer'});
  const s=f.state(),items=[...s.items.values()].filter(i=>i.kind!=='goal');
  assert.equal(queueClass(s,s.items.get('ENG-4')),'stable-Brain-release');
  assert.deepEqual(orderQueue(s,items).map(i=>i.id),['ENG-4','ENG-1','REV-1','ENG-2','ENG-3']);
  assert.deepEqual(s.links,[]);
  const signature=haltObservation({state:s,events:f.events,identity:'fixture',config:{}}).signature;
  f.add({type:'item.updated',id:'G-1',fields:{meta:{queue_order:'["Chipnet-withdrawal","rehearsal-publication","stable-Brain-release"]'}}});
  assert.equal(orderQueue(f.state(),items)[0].id,'ENG-3');
  assert.notEqual(haltObservation({state:f.state(),events:f.events,identity:'fixture',config:{}}).signature,signature);
});

test('standing selection never inherits proposal selection from a parent and malformed order fails closed',()=>{
  const f=fixture();f.item('ENG-1',{queue_selected:true});f.item('ENG-2',{}, {parent:'ENG-1',from_run:'R-old'});
  const s=f.state();assert.equal(queueSelected(s.items.get('ENG-2')),false);
  assert.equal(queueSelected({...s.items.get('ENG-2'),meta:{queue_selected:true}}),true);
  assert.equal(queueSelected({...s.items.get('ENG-1'),meta:{queue_selected:false}}),false);
  for(const queue_order of ['garbage','[]','["same","same"]']){
    s.items.get('G-1').meta.queue_order=queue_order;assert.throws(()=>queuePolicy(s),/queue_order/);
  }
});
