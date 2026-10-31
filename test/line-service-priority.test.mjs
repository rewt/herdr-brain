import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import {fold,itemStatus} from '../lib/state.mjs';
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

test('new and reopened release blockers precede lower-class fix-forwards without changing tie breakers',()=>{
  const f=fixture();
  f.add({type:'item.updated',id:'G-1',fields:{meta:{queue_order:['stable-Brain-release','finish-open-owned-work','rehearsal-publication']}}});
  f.item('ENG-release',{queue_class:'stable-Brain-release',hold:true});
  f.item('ENG-reopened',{}, {priority:-100});
  f.add({type:'run.started',id:'R-old',item:'ENG-reopened',meta:{}});
  f.add({type:'run.abandoned',id:'R-old'});
  f.add({type:'item.closed',id:'ENG-reopened',as:'done'});
  f.add({type:'item.reopened',id:'ENG-reopened'});
  f.item('ENG-new',{queue_class:'rehearsal-publication'}, {priority:10});
  f.item('ENG-fix',{queue_class:'finish-open-owned-work',review_fix_of:'original'}, {priority:3800});
  f.item('REV-release',{review_source_item:'ENG-release',review_target:{head:'captured'},review_round_cap:1},{role:'reviewer'});
  const ids=['ENG-reopened','ENG-new','ENG-fix','REV-release'];
  const order=()=>{const s=f.state();return orderQueue(s,ids.map(id=>s.items.get(id))).map(i=>i.id);};
  assert.equal(queueClass(f.state(),f.state().items.get('ENG-reopened')),'finish-open-owned-work');
  assert.deepEqual(order(),['REV-release','ENG-fix','ENG-reopened','ENG-new']);
  for(const blocker of ['ENG-reopened','ENG-new'])f.add({type:'link.added',blocker,blocked:'ENG-release'});
  const s=f.state(),before=structuredClone(s);
  assert.equal(queueClass(s,s.items.get('ENG-reopened')),'stable-Brain-release');
  assert.deepEqual(order(),['REV-release','ENG-new','ENG-reopened','ENG-fix']);
  assert.equal(itemStatus(s,'ENG-reopened'),'ready');
  assert.equal(itemStatus(s,'ENG-release'),'blocked');
  orderQueue(s,[...s.items.values()]);assert.deepEqual(s,before,'ordering never rewrites holds, selection, links or state');
});

test('dependency inheritance is transitive, cycle safe and uses the highest standing class without demotion',()=>{
  const f=fixture();
  f.item('ENG-top',{queue_class:'finish-open-owned-work'});
  f.item('ENG-middle',{queue_class:'stable-Brain-release'});
  f.item('ENG-leaf',{queue_class:'Chipnet-withdrawal',queue_selected:false});
  f.item('ENG-low',{queue_class:'rehearsal-publication'});
  for(const [blocker,blocked] of [['ENG-leaf','ENG-middle'],['ENG-middle','ENG-top'],['ENG-top','ENG-middle'],['ENG-leaf','ENG-low']])
    f.add({type:'link.added',blocker,blocked});
  const s=f.state();
  for(const id of ['ENG-top','ENG-middle','ENG-leaf'])assert.equal(queueClass(s,s.items.get(id)),'finish-open-owned-work');
  assert.equal(queueSelected(s.items.get('ENG-leaf')),false,'rank does not select excluded work');
  assert.equal(itemStatus(s,'ENG-leaf'),'ready');
  assert.equal(itemStatus(s,'ENG-top'),'blocked','rank does not release a dependency cycle');
  f.add({type:'item.updated',id:'G-1',fields:{meta:{queue_order:['Chipnet-withdrawal','rehearsal-publication','stable-Brain-release','finish-open-owned-work']}}});
  assert.equal(queueClass(f.state(),f.state().items.get('ENG-leaf')),'Chipnet-withdrawal','a lower downstream class cannot demote own work');
});

test('removing a link or closing its target removes inherited urgency and reopening restores it',()=>{
  const f=fixture();f.item('ENG-blocker',{queue_class:'historical-backlog'});
  f.item('ENG-release',{queue_class:'stable-Brain-release'});
  f.item('ENG-unknown',{}, {parent:null});
  f.add({type:'link.added',blocker:'ENG-blocker',blocked:'ENG-unknown'});
  const group=()=>{const s=f.state();return queueClass(s,s.items.get('ENG-blocker'));};
  assert.equal(group(),'historical-backlog','unclassified targets do not invent a class');
  f.add({type:'link.added',blocker:'ENG-blocker',blocked:'ENG-release'});
  assert.equal(group(),'stable-Brain-release');
  f.add({type:'item.closed',id:'ENG-release',as:'done'});assert.equal(group(),'historical-backlog');
  f.add({type:'item.reopened',id:'ENG-release'});assert.equal(group(),'stable-Brain-release');
  f.add({type:'link.removed',blocker:'ENG-blocker',blocked:'ENG-release'});assert.equal(group(),'historical-backlog');
});
