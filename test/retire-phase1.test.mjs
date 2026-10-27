// Actual exit/close path in an isolated native adapter. No live panes/probes.
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {exitFixture} from './helpers/retire-exit-fixture.mjs';
import {planRetirement,executeRetirement} from '../lib/retire.mjs';
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
