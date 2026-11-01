import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import {fold,itemStatus} from '../lib/state.mjs';
import {itemLaunchHold} from '../lib/item-launch-hold.mjs';
import {queueClass,queueSelected,orderQueue} from '../line-service/priority-order.mjs';

function fixture(targetMeta={}){
  const events=[];
  const add=e=>events.push({...e,seq:events.length+1,at:'2026-10-31T00:00:00Z',by:'fixture'});
  add({type:'item.added',id:'G-1',kind:'goal',title:'Outcomes',meta:{queue_order:['release','ordinary']}});
  const item=(id,meta)=>add({type:'item.added',id,kind:'work',role:'engineer',parent:'G-1',title:id,meta});
  item('ENG-1',{queue_class:'ordinary',queue_selected:true});
  item('ENG-2',{queue_class:'release',queue_selected:true,...targetMeta});
  item('ENG-3',{queue_class:'ordinary',queue_selected:true});
  add({type:'item.updated',id:'ENG-3',fields:{priority:100}});
  add({type:'link.added',blocker:'ENG-1',blocked:'ENG-2'});
  return {add,item,state:()=>fold(events)};
}

for(const meta of [{hold:true},{queue_selected:false},{hold:true,queue_selected:false}]){
  test(`open target lends urgency despite admission state ${JSON.stringify(meta)}`,()=>{
    const f=fixture(meta);
    const observe=()=>{
      const s=f.state(),before=structuredClone(s),blocker=s.items.get('ENG-1'),target=s.items.get('ENG-2');
      const result={group:queueClass(s,blocker),order:orderQueue(s,[s.items.get('ENG-3'),blocker]).map(i=>i.id)};
      assert.equal(queueSelected(target),meta.queue_selected!==false);
      assert.equal(target.meta.hold,meta.hold);
      assert.equal(Boolean(itemLaunchHold(s,target.id)),Boolean(meta.hold));
      assert.equal(queueSelected(blocker),true);
      assert.equal(itemStatus(s,blocker.id),'ready');
      assert.equal(itemLaunchHold(s,blocker.id),null);
      assert.equal(itemStatus(s,target.id),'blocked');
      assert.deepEqual(s,before,'classification preserves selection, holds and dependency state');
      return result;
    };
    const urgent={group:'release',order:['ENG-1','ENG-3']};
    const ordinary={group:'ordinary',order:['ENG-3','ENG-1']};
    assert.deepEqual(observe(),urgent,'selected blocker outranks unrelated selected ordinary work');
    f.add({type:'item.closed',id:'ENG-2',as:'done'});
    const closed=f.state();
    assert.equal(queueClass(closed,closed.items.get('ENG-1')),'ordinary','closed target stops lending urgency');
    assert.deepEqual(orderQueue(closed,['ENG-1','ENG-3'].map(id=>closed.items.get(id))).map(i=>i.id),ordinary.order);
    f.add({type:'item.reopened',id:'ENG-2'});
    assert.deepEqual(observe(),urgent,'reopening restores urgency without clearing admission state');
    f.add({type:'link.removed',blocker:'ENG-1',blocked:'ENG-2'});
    const unlinked=f.state();
    assert.equal(queueClass(unlinked,unlinked.items.get('ENG-1')),'ordinary','removed link stops lending urgency');
    f.add({type:'link.added',blocker:'ENG-1',blocked:'ENG-2'});
    assert.deepEqual(observe(),urgent,'restoring the link restores urgency');
  });
}

test('transitive urgency crosses excluded held targets and preserves blocker admission fences',()=>{
  const f=fixture({hold:true,queue_selected:false});
  f.item('ENG-4',{queue_class:'ordinary',queue_selected:false,hold:true});
  f.add({type:'link.removed',blocker:'ENG-1',blocked:'ENG-2'});
  f.add({type:'link.added',blocker:'ENG-1',blocked:'ENG-4'});
  f.add({type:'link.added',blocker:'ENG-4',blocked:'ENG-2'});
  for(const meta of [{queue_selected:false},{queue_selected:true,hold:true},{queue_selected:true,hold:false}]){
    f.add({type:'item.updated',id:'ENG-1',fields:{meta}});
    const s=f.state(),before=structuredClone(s),blocker=s.items.get('ENG-1');
    assert.equal(queueClass(s,blocker),'release');
    assert.equal(queueClass(s,s.items.get('ENG-4')),'release');
    assert.equal(queueSelected(s.items.get('ENG-4')),false);
    assert.equal(queueSelected(blocker),meta.queue_selected);
    assert.equal(itemStatus(s,blocker.id),'ready','holds are enforced separately from dependency readiness');
    assert.equal(Boolean(itemLaunchHold(s,blocker.id)),Boolean(meta.hold));
    assert.deepEqual(s,before,'urgency never changes admission state');
  }
});
