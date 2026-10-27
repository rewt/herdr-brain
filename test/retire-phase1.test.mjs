// Actual exit/close path in an isolated native adapter. No live panes/probes.
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {exitFixture} from './helpers/retire-exit-fixture.mjs';
import {planRetirement,executeRetirement,chainFor} from '../lib/retire.mjs';
import {loadEvents,transact} from '../lib/store.mjs';

test('phase1 retirement exits and closes its unchanged bound session despite unrelated record and native churn',t=>{
  const f=exitFixture(t,{bound:true}),adapter=f.retirement(),plan=adapter.plan(f.lane);
  assert.equal(plan.close[0].decision,'exit');
  transact(f.org,()=>({add:[{type:'item.added',id:'ENG-2',role:'engineer',title:'Independent work'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:'/other/lane',meta:{agent:'other',pane:'other:p'}},
    {type:'note.added',id:'ENG-2',text:'Unrelated progress'}]}));
  const native=f.read();native.workspaces.push({workspace_id:'other',worktree:{checkout_path:'/other/lane',repo_key:'/other/.git'}});
  native.agents.push({name:'other',agent:'codex',agent_status:'working',pane_id:'other:p',workspace_id:'other',cwd:'/other/lane',terminal_id:'other-terminal',agent_session:{value:'other-session'}});fs.writeFileSync(f.file,JSON.stringify(native));
  fs.writeFileSync(path.join(f.repo,'independent'),'another landing');f.git(['add','independent']);f.git(['commit','-qm','Unrelated main landing']);
  const fresh=adapter.plan(f.lane);assert.notEqual(fresh.token,plan.token);assert.equal(fresh.close[0].token,plan.close[0].token);
  const result=adapter.apply(plan,f.lane);assert.ok(result.some(r=>r.action==='closed'),JSON.stringify(result));
  assert.deepEqual(f.read().actions,[['agent','prompt','worker','/quit'],['tab','close','w:t']]);
});

test('phase1 retirement target token retains claims source native identity callbacks and HOLD before any exit',t=>{
  const f=exitFixture(t,{bound:true}),snapshot=f.retirement().observe(f.lane),plan=planRetirement(snapshot);
  assert.equal(plan.close[0].decision,'exit');
  const cases=[
    ['session',s=>s.agents[0].agent_session={value:'replacement'}],
    ['terminal',s=>s.agents[0].terminal_id='replacement'],
    ['working',s=>s.agents[0].agent_status='working'],
    ['claim',s=>{s.record.runs[0].owner={controller:'foreign',release:{root:'/foreign'}};s.record.runs[0].owner_generation=99;}],
    ['source head',s=>s.git[0].head='f'.repeat(40)],
    ['shell birth',s=>s.panes[0].process_info.process_tree[0].identity='replacement'],
    ['callback',s=>s.references.push({run:'R-1',kind:'live callback'})],
    ['HOLD',s=>s.retirementHold='operator HOLD'],
    ['archive/integration',s=>{s.git[0].integrated=false;s.git[0].archived=false;}],
  ];
  for(const[name,change]of cases){const current=structuredClone(snapshot);change(current);let exits=0,closed=0;
    const rows=executeRetirement(plan,{observe:()=>current,exit:()=>exits++,close:()=>closed++});
    assert.equal(exits,0,name);assert.equal(closed,0,name);assert.ok(rows.some(r=>['held','skip-close'].includes(r.action)),name);
  }
  assert.equal(loadEvents(f.org).events.some(e=>e.type==='retirement.release'),false);
});

test('phase1 scoped retirement bounds watcher owner reads while retaining target unknown and native alias holds',t=>{
  const f=exitFixture(t,{bound:true}),reads=[];
  transact(f.org,()=>({add:[{type:'run.updated',id:'R-1',meta:{watcher_pid:11,watcher_identity:'target'}},
    {type:'item.added',id:'ENG-2',role:'engineer',title:'Historical work'},
    ...Array.from({length:2035},(_,i)=>({type:'run.started',id:`R-${i+2}`,item:'ENG-2',workspace:path.join(f.scratch,'history',String(i)),meta:{watcher_pid:i+100,watcher_identity:`history-${i}`}}))]}));
  const adapter=f.retirement({readOwner:owner=>{reads.push(owner.pid);return owner.pid===11;}});
  const snapshot=adapter.observe(f.lane);
  assert.deepEqual(reads,[11],'unrelated historical watcher owners are not queried');
  assert.match(planRetirement(snapshot).keep[0].why,/watcher callback/,'actual target watcher still holds');
  transact(f.org,()=>({add:[{type:'run.started',id:'R-3000',item:'ENG-2',meta:{watcher_pid:9001,watcher_identity:'unknown'}},
    {type:'item.added',id:'ENG-3',role:'engineer',title:'Contradictory native binding'},
    {type:'run.started',id:'R-3001',item:'ENG-3',workspace:path.join(f.scratch,'other'),meta:{pane:'w:p',watcher_pid:9002,watcher_identity:'alias'}}]}));
  reads.length=0;
  const guarded=f.retirement({readOwner:owner=>{reads.push(owner.pid);if(owner.pid===9001)throw Error('unknown owner');return false;}}).observe(f.lane);
  assert.deepEqual(reads,[11,9001,9002]);
  assert.ok(guarded.references.some(r=>r.run==='R-3000'&&r.global),'unknown callback scope remains a project hold');
  assert.equal(planRetirement(guarded).close.length,0);
  reads.length=0;adapter.observe();assert.equal(reads.length,2038,'unscoped inspection retains the complete owner inventory');
  assert.deepEqual(f.read().actions,[],'observation never performs a native effect');
});

test('phase1 queue reviewer retires its own completed chain without borrowing the open goal and retains its callback',t=>{
  const f=exitFixture(t,{bound:true}),head='a'.repeat(40),meta={review_source_item:'ENG-2',review_source_run:'R-2',review_key:`ENG-2:${head}`,review_target:{head},review_round_cap:1};
  transact(f.org,()=>({add:[{type:'item.added',id:'G-3',kind:'goal',title:'Ongoing project'},
    {type:'item.added',id:'ENG-2',role:'engineer',parent:'G-3',title:'Independent source'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:path.join(f.scratch,'other')},
    {type:'item.updated',id:'ENG-1',fields:{role:'reviewer',parent:'G-3',meta}}]}));
  const events=loadEvents(f.org).events;events.find(e=>e.type==='report.ingested').report.extra={verdict:'PASS'};
  fs.writeFileSync(f.eventFile,events.map(e=>JSON.stringify(e)+'\n').join(''));
  const adapter=f.retirement(),snapshot=adapter.observe(f.lane),plan=planRetirement(snapshot);
  assert.equal(chainFor(snapshot.record,snapshot.record.runs.find(r=>r.id==='R-1')).root.id,'ENG-1');
  assert.equal(plan.close[0].decision,'exit');
  const guarded=structuredClone(snapshot);guarded.references.push({kind:'review callback',run:'R-1'});let effects=0;
  executeRetirement(plan,{observe:()=>guarded,exit:()=>effects++,close:()=>effects++});assert.equal(effects,0);
  const legacy=structuredClone(snapshot);delete legacy.record.items.find(i=>i.id==='ENG-1').meta.review_target;
  assert.equal(chainFor(legacy.record,legacy.record.runs.find(r=>r.id==='R-1')).root.id,'G-3','legacy or incomplete review evidence keeps the old parent chain');
  assert.equal(planRetirement(legacy).close.length,0);
  const result=adapter.apply(plan,f.lane);assert.ok(result.some(r=>r.action==='closed'),JSON.stringify(result));
  assert.deepEqual(f.read().actions,[['agent','prompt','worker','/quit'],['tab','close','w:t']]);
});
