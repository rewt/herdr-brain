import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup,events,effects,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {currentCloseoutEntries} from '../lib/closeout.mjs';

function stoppedUnbound(t){
  const f=setup(t,{occupied:false,direct:true,merged:true});selectCurrentCleanup(f);
  // A stopped dispatch has no worker receipt at all. Keep an unnamed native
  // occupant elsewhere in the global census, as on the live project.
  const original=events(f).map(e=>e.type==='run.started'?{...e,meta:{lane:'topic'}}:e);
  fs.writeFileSync(f.eventFile,original.map(e=>JSON.stringify(e)+'\n').join(''));
  f.state.agents=[{agent:'native',agent_status:'working',cwd:f.repo,pane_id:'other:p',
    tab_id:'other:t',workspace_id:'other',terminal_id:'other-term'}];f.save();
  f.append([{type:'run.abandoned',id:'R-1',note:'Original dispatch stopped before native launch.'}]);
  const entry=currentCloseoutEntries(f.common,f.org,events(f))[0];
  assert.deepEqual(entry.panes,[]);assert.equal(entry.allocation.worker,null);
  return{...f,entry,drain:()=>f.drain({keys:[entry.key],retrySafe:true})};
}

test('stopped unbound allocation ignores an unrelated unnamed occupant and keeps its original source',t=>{
  const f=stoppedUnbound(t),before=fs.readFileSync(f.eventFile),occupants=structuredClone(f.state.agents);
  const result=f.drain(),row=result.evaluated[0];assert.equal(row.completed,true,JSON.stringify(result));
  assert.equal(fs.existsSync(f.lane),false);assert.equal(f.git(['branch','--list','lane/topic']),'');
  assert.deepEqual(f.read().agents,occupants);assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
  assert.equal(row.resources.session.status,'unbound');assert.equal(row.resources.session.completion,'UNKNOWN');
  assert.equal(effects(f).some(e=>e.action==='agent-exit-requested'),false);
  assert.equal(events(f).some(e=>e.type==='run.session_bound'||e.type==='cleanup.bound'),false);
});

for(const kind of ['occupant','dirty','UNKNOWN','refusal','claim','HOLD'])test(`stopped unbound allocation with an unrelated unnamed agent retains ${kind}`,t=>{
  const f=stoppedUnbound(t);
  if(kind==='occupant'){f.state.agents[0].cwd=f.lane;f.save();}
  if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'unsaved'),'unique');
  if(kind==='UNKNOWN')f.append([{type:'closeout.effect',identity:f.common,key:f.entry.key,source:f.entry.source,
    effect:'original',producer:'native-closeout/v2',outcome:{action:'shell-close-requested',tab_id:'w:t',panes:[{pane:'w:p',terminal:'term'}]}}]);
  if(kind==='refusal')f.append([{type:'closeout.evaluated',identity:f.common,key:f.entry.key,source:f.entry.source,
    run:'R-1',reason:'EPERM native refusal',completed:false}]);
  if(kind==='claim')f.append([{type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner:{controller:'foreign',legacy:true}}]);
  if(kind==='HOLD')fs.mkdirSync(path.join(f.repo,'.lane/supervisor/HOLD'),{recursive:true});
  const before=fs.readFileSync(f.eventFile),calls=f.herdrCalls();f.drain();
  assert.equal(fs.existsSync(f.lane),true);assert.deepEqual(f.read().actions,[]);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
  if(kind==='dirty')assert.equal(fs.readFileSync(path.join(f.lane,'unsaved'),'utf8'),'unique');
  if(['UNKNOWN','refusal'].includes(kind))assert.deepEqual(f.herdrCalls(),calls);
});
