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

test('stopped unbound allocation retains an unnamed agent in a lane subdirectory from another workspace',t=>{
  const f=stoppedUnbound(t);
  fs.mkdirSync(path.join(f.lane,'nested','work'),{recursive:true});
  f.state.agents[0].cwd=path.join(f.lane,'nested','work');f.save();
  const occupants=structuredClone(f.state.agents),before=fs.readFileSync(f.eventFile);
  const row=f.drain().evaluated[0];
  assert.equal(row.completed,false);assert.match(row.reason,/still has a native occupant/);
  assert.equal(fs.existsSync(f.lane),true);assert.notEqual(f.git(['branch','--list','lane/topic']),'');
  assert.deepEqual(f.read().agents,occupants);assert.deepEqual(f.read().actions,[]);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
  assert.equal(effects(f).some(e=>e.action==='agent-exit-requested'),false);
});

test('stopped unbound allocation ignores an unnamed agent in a sibling sharing the lane prefix',t=>{
  const f=stoppedUnbound(t),sibling=f.lane+'-other';
  fs.mkdirSync(sibling);f.state.agents[0].cwd=sibling;f.save();
  const occupants=structuredClone(f.state.agents),row=f.drain().evaluated[0];
  assert.equal(row.completed,true,JSON.stringify(row));assert.equal(fs.existsSync(f.lane),false);
  assert.equal(fs.existsSync(sibling),true);assert.deepEqual(f.read().agents,occupants);
});

for(const field of ['cwd','foreground_cwd'])test(`stopped unbound allocation retains a pane with ${field} in a lane subdirectory`,t=>{
  const f=stoppedUnbound(t),cwd=path.join(f.lane,'nested');fs.mkdirSync(cwd);
  f.state.tabs=[{tab_id:'w:t',workspace_id:'w'}];
  f.state.panes=[{pane_id:'w:p',tab_id:'w:t',workspace_id:'w',[field]:cwd}];f.save();
  const panes=structuredClone(f.state.panes),row=f.drain().evaluated[0];
  assert.equal(row.completed,false);assert.match(row.reason,/unproven native pane/);
  assert.equal(fs.existsSync(f.lane),true);assert.deepEqual(f.read().panes,panes);
  assert.deepEqual(f.read().actions,[]);
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
