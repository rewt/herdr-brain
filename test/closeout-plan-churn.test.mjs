import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {currentCloseoutEntries} from '../lib/closeout.mjs';
import {closeoutNextStage} from '../lib/closeout-status.mjs';
import {TAB_RETIREMENT_AUTHORITY_CHANGED} from '../lib/retire.mjs';
import {setup,events,effects,selectCurrentCleanup,retainNativeOutcome} from './helpers/closeout-fixture.mjs';

function fixture(t,{continued=false,transport}={}) {
  const f=setup(t,{direct:true,bound:true,merged:true});selectCurrentCleanup(f);f.report();
  const [entry]=currentCloseoutEntries(f.common,f.org,events(f)),command=f.options.command,log=f.options.log;
  const observations=[];let reads=0;
  f.options.command=(exe,args,opt)=>{
    if(exe===f.options.herdr&&args[0]==='workspace'&&args[1]==='list'){
      reads++;
      // Absence read, initial plan, then the executor's fresh observation.
      // The retry similarly plans at read four and checks at read five.
      if(reads===3)f.append([{type:'item.closed',id:'ENG-1',as:'done'}]);
      if(continued&&reads===5)f.append([{type:'note.added',id:'R-1',text:'Concurrent owner observation'}]);
    }
    if(transport&&exe===f.options.herdr&&args[0]==='agent'&&args[1]==='prompt')return transport(command,exe,args,opt);
    return command(exe,args,opt);
  };
  f.options.log=row=>{log(row);observations.push(row);};
  const drain=f.drain;
  return Object.assign(f,{entry,observations,drain:()=>drain({keys:[entry.key],retrySafe:true})});
}

test('bound closer replans an item close between plan and apply in the same finite step',t=>{
  const f=fixture(t),row=f.drain().evaluated[0];
  assert.equal(row.completed,true,JSON.stringify(row));
  assert.equal(f.observations.filter(r=>r.action==='skip-close'&&r.why===TAB_RETIREMENT_AUTHORITY_CHANGED).length,1);
  assert.equal(effects(f).filter(r=>r.action==='agent-exit-requested').length,1);
  assert.equal(effects(f).filter(r=>r.action==='shell-close-requested').length,1);
  assert.equal(row.resources.session.status,'closed');assert.equal(row.resources.folder.status,'removed');
  assert.equal(row.resources.branch.status,'deleted');assert.equal(fs.existsSync(f.lane),false);
});

test('bound closer bounds continued authority churn and resumes through its original finite owner',t=>{
  const f=fixture(t,{continued:true}),first=f.drain().evaluated[0],original=events(f);
  assert.equal(first.completed,false);assert.equal(first.reason,TAB_RETIREMENT_AUTHORITY_CHANGED);
  assert.equal(first.condition.kind,'pre-effect-change');assert.equal(first.condition.owner,'lane-closeout');
  assert.deepEqual(closeoutNextStage(f.entry,first,original),{stage:'pre-effect-observation',ready:true});
  assert.equal(f.observations.filter(r=>r.action==='skip-close').length,2);
  assert.deepEqual(f.read().actions,[]);assert.equal(effects(f).some(r=>r.action==='lane-preflight'),false);
  assert.ok(fs.existsSync(f.lane));
  const second=f.drain().evaluated[0];assert.equal(second.completed,true,JSON.stringify(second));
  assert.deepEqual(events(f).slice(0,original.length),original,'the first disposition remains immutable');
  assert.equal(effects(f).filter(r=>r.action==='agent-exit-requested').length,1);
  assert.equal(effects(f).filter(r=>r.action==='shell-close-requested').length,1);
});

for(const kind of ['UNKNOWN','refusal'])test(`bound closer retains an original native ${kind} after replanning`,t=>{
  let sends=0;
  const f=fixture(t,{transport:(command,exe,args,opt)=>{
    sends++;
    if(kind==='UNKNOWN')command(exe,args,opt); // Executed, but its reply was lost.
    return{status:1,stdout:'',stderr:kind==='UNKNOWN'?'lost native reply':JSON.stringify({error:{code:'NATIVE_REFUSAL'}})};
  }});
  const row=f.drain().evaluated[0];assert.equal(row.completed,false);assert.equal(sends,1);
  assert.equal(row.condition.kind,kind==='UNKNOWN'?'uncertain-invocation':'native-refusal');
  assert.equal(f.observations.filter(r=>r.action==='skip-close'&&r.why===TAB_RETIREMENT_AUTHORITY_CHANGED).length,1);
  assert.equal(effects(f).some(r=>r.action==='shell-close-requested'),false);
  const retained=retainNativeOutcome(f,f.entry);f.drain();retained();assert.equal(sends,1);
});

test('bound closer keeps STOP and HOLD at its fresh replan boundary',t=>{
  for(const name of ['STOP','HOLD']){
    const f=fixture(t),log=f.options.log;
    f.options.log=row=>{
      log(row);
      if(row.action==='skip-close'){
        fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});
        fs.writeFileSync(path.join(f.repo,'.lane/supervisor',name),'Original project hold');
      }
    };
    const row=f.drain().evaluated[0];assert.equal(row.completed,false);assert.match(row.reason,/STOP|HOLD/);
    assert.deepEqual(f.read().actions,[]);assert.ok(fs.existsSync(f.lane));
    assert.equal(effects(f).some(r=>r.action==='agent-exit-requested'||r.action==='shell-close-requested'),false);
  }
});
