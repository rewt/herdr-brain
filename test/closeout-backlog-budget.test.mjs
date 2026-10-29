import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {fold} from '../lib/state.mjs';
import {reconcileCloseoutBacklog} from '../lib/closeout-backlog.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';

test('backlog reconciliation shares the turn deadline, keeps partial progress and reuses observed state',t=>{
  const f=setup(t,{direct:true,bound:true}),{directory}=selectCurrentCleanup(f);
  const [source]=f.report(),entry=source.closeout_targets[0],project=gitProject(f.repo);
  f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,source:{seq:source.seq,type:source.type},
    run:entry.run,item:entry.item,revision:source.seq,completed:false,reason:'original native refusal; owner evidence required'},
  ...Array.from({length:128},(_,i)=>({type:'closeout.waiting',identity:f.common,key:entry.key,
    source:{seq:source.seq,type:source.type},wait_id:`budget-${i}`,
    waiting:{owner:'line-service',defect:'No existing completion writer',producers:[]}}))]);
  const before=events(f),bytes=fs.readFileSync(f.eventFile),calls=f.herdrCalls(),gitCalls=f.gitCalls(),actions=f.read().actions;
  const args={project,org:f.org,events:before,state:fold(before),guard:()=>{}};
  // An expired call must not even enumerate the history or read the state.
  assert.deepEqual(reconcileCloseoutBacklog({...args,expired:()=>true,
    events:{[Symbol.iterator](){assert.fail('expired history enumerated');}},
    state:{get runs(){assert.fail('expired allocations read');}}}),[]);
  // Expiration while indexing also avoids all per-wait observations and writes.
  let scans=0;
  assert.deepEqual(reconcileCloseoutBacklog({...args,expired:()=>++scans>5}),[]);
  assert.deepEqual(events(f),before);

  // Exercise the production caller: the old implementation classified waits
  // even at budget zero because it never received this turn's expired check.
  let ticks=0;
  const result=runCloseoutTurn({project,org:f.org,env:f.env,guard:()=>{},measure:()=>{},
    budgetMs:0,clock:()=>ticks++,cli:()=>assert.fail('expired turn issued a command')});
  assert.equal(result.backlog_classified,0);assert.equal(result.steps,0);
  assert.ok(result.backlog_reconcile_ms>0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'closeout-turn.json'))).backlog_reconcile_ms,result.backlog_reconcile_ms);
  assert.equal(events(f).some(e=>e.type==='closeout.wait-classified'),false);

  // Spend the allowance during one completed observation. Commit that row,
  // then stop before inspecting the next wait or folding allocations again.
  let elapsed=0,reads=0;
  const observed=before.map(e=>e.type==='closeout.waiting'?{...e}:e),waits=observed.filter(e=>e.type==='closeout.waiting');
  Object.defineProperty(waits[0],'wait_id',{get(){elapsed=10;return 'budget-0';}});
  Object.defineProperty(waits[1],'waiting',{get(){assert.fail('next wait inspected past deadline');}});
  const partial=reconcileCloseoutBacklog({...args,events:observed,expired:()=>elapsed>=10,
    state:{get runs(){assert.fail('allocations folded past deadline');}}});
  assert.equal(partial.length,1);assert.equal(partial[0].wait_id,'budget-0');assert.equal(partial[0].disposition,'held');
  assert.ok(elapsed>=10);

  // Use the real pre-folded observation for allocation selection. Its runs
  // accessor is a witness that the caller's state is used (not folded again).
  const current=events(f),state=fold(current);
  const remaining=reconcileCloseoutBacklog({...args,events:current,state:{get runs(){reads++;return state.runs;}},maxRows:256});
  assert.equal(reads,1);assert.equal(remaining.length,127);
  assert.ok(remaining.every(e=>e.disposition==='held'));
  assert.deepEqual(reconcileCloseoutBacklog({...args,events:events(f),state:fold(events(f))}),[]);
  // Already-classified skips also check the allowance between waits; an empty
  // output batch must not imply permission to rescan the entire backlog.
  elapsed=0;
  const classified=events(f).map(e=>e.type==='closeout.waiting'?{...e}:e),skips=classified.filter(e=>e.type==='closeout.waiting');
  Object.defineProperty(skips[0],'wait_id',{get(){elapsed=10;return 'budget-0';}});
  Object.defineProperty(skips[1],'waiting',{get(){assert.fail('classified wait scanned past deadline');}});
  assert.deepEqual(reconcileCloseoutBacklog({...args,events:classified,expired:()=>elapsed>=10,
    state:{get runs(){assert.fail('expired classified backlog refolded');}},guard:()=>assert.fail('no new batch to append')}),[]);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,bytes.length),bytes);
  assert.deepEqual(events(f).slice(0,before.length),before);
  assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.gitCalls(),gitCalls);assert.deepEqual(f.read().actions,actions);
  assert.equal(events(f).slice(before.length).some(e=>['closeout.effect','run.started','run.abandoned','run.session_bound'].includes(e.type)),false);
});
