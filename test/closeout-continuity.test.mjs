import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, hold } from './helpers/retire-fixture.mjs';
import { transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { digest } from '../lib/completion.mjs';
import { readCloseoutEntries, closeoutRevision, closeoutKey, closeoutOutcomeObservation, safeCloseoutRetry, scheduleLineCloseouts } from '../lib/closeout.mjs';
import { reconcile } from '../supervisor/reconcile.mjs';
import { createLineService as createMeasuredLineService, sourceRoot } from '../line-service/line-service.mjs';
// These controls count the effect executor's reads. The independent census has
// its own oracle/lock controls and cannot resolve an original native intent.
const createLineService=options=>createMeasuredLineService({...options,closeoutMeasure:()=>{}});
import { closeoutEvaluations } from '../lib/closeout.mjs';
import { readCloseoutObservations, appendCloseoutObservation } from '../lib/closeout-diagnostics.mjs';
import { closeoutWaitId, closeoutWaitState, registerCloseoutWait, nativeCloseoutWait } from '../lib/closeout-status.mjs';
import { obsoleteOutcomeDecision } from '../line-service/outcome-decision.mjs';
import { unresolvedCloseoutEffect } from '../lib/closeout.mjs';
import { events, setup, evaluations, effects, retainNativeOutcome } from './helpers/closeout-fixture.mjs';

// Spend the target's allowance after the ownership locks are held. An already
// expired allowance is rejected at lock entry, before any target is evaluated.
function drainWithSpentTargetBudget(f,key) {
  const now=Date.now,command=f.options.command,deadline=now()+60000;
  let spent=false;
  f.options.command=(exe,args,opt)=>{
    const result=command(exe,args,opt);
    if(!spent&&exe===f.job.herdr){spent=true;Date.now=()=>deadline;}
    return result;
  };
  let result;
  try{result=f.drain({keys:[key],retirementOptions:{...f.options,deadline}});}
  finally{Date.now=now;f.options.command=command;}
  assert.equal(spent,true,'the target reached native observation before its budget expired');
  return result;
}

test('phase1 conditional source completion binds one real landed worktree removal without promotion callback',t=>{
  const f=setup(t,{occupied:false});f.git(['merge','--ff-only',f.head]);f.report();
  const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]);
  const target=rows[0].closeout_targets.find(t=>t.signal==='landed');assert.ok(target);assert.equal(target.head,f.head);
  const result=f.drain({keys:[target.key]});assert.equal(result.evaluated[0]?.completed,true);assert.equal(fs.existsSync(f.lane),false);
});

test('phase1 deadline-deferred closeout retries its original unattempted target and exits once with a fresh budget',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=rows[0].closeout_targets.find(t=>t.signal==='landed');
  const bytes=fs.readFileSync(f.eventFile);
  assert.throws(()=>f.drain({keys:[entry.key],retirementOptions:{...f.options,deadline:Date.now()-1}}),{code:'RETIREMENT_DEADLINE'});
  assert.deepEqual(fs.readFileSync(f.eventFile),bytes,'expired lock entry evaluates no target');assert.deepEqual(f.read().actions,[]);
  const first=drainWithSpentTargetBudget(f,entry.key);
  assert.equal(first.evaluated[0].completed,false);assert.match(first.evaluated[0].reason,/deadline/);assert.equal(effects(f).some(e=>e.action==='agent-exit-requested'),false);
  assert.equal(first.evaluated[0].diagnostic,true);assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,bytes.length),bytes);
  assert.equal(first.evaluated[0].condition.kind,'pre-effect-budget');
  assert.equal(first.evaluated[0].condition.continuation.kind,'pre-effect-observation');
  assert.equal(events(f).some(e=>e.type==='closeout.waiting'&&e.key===entry.key),false,'the closer owns its fresh budget; no outside completion is invented');
  const deferredBytes=fs.readFileSync(f.eventFile);
  assert.equal(readCloseoutObservations(f.common,f.org,events(f)).length,1);
  assert.deepEqual(f.drain({keys:[entry.key]}).evaluated,[],'restart suppresses the unchanged observation');
  assert.deepEqual(fs.readFileSync(f.eventFile),deferredBytes,'unchanged restart adds no wait');
  const next=f.drain({keys:[entry.key],retrySafe:true});assert.equal(next.evaluated[0]?.completed,true,JSON.stringify(next));
  assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1);assert.equal(fs.existsSync(f.lane),false);
});

test('future telemetry diagnostics cannot override a durable native refusal or manufacture completion',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=readCloseoutEntries(f.common).find(e=>e.key===rows[0].closeout_targets.find(t=>t.signal==='landed').key);
  const revision=closeoutRevision(entry,events(f));
  const row={type:'closeout.evaluated',key:entry.key,identity:f.common,item:entry.item,run:entry.run,source:entry.source,revision,completed:false,reason:'native refusal; original identity retained'};
  transact(f.org,()=>({add:[row]}));
  appendCloseoutObservation(f.common,f.org,{...row,reason:'retirement deadline reached; request remains pending'},events(f));
  assert.equal(closeoutEvaluations(f.common,f.org,events(f)).find(e=>e.key===entry.key).reason,row.reason);
  const bytes=fs.readFileSync(f.eventFile);assert.deepEqual(f.drain({keys:[entry.key],retrySafe:true}).evaluated,[]);assert.deepEqual(f.read().actions,[]);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,bytes.length),bytes,'original refusal is never rewritten');
  const wait=events(f).find(e=>e.type==='closeout.waiting'&&e.key===entry.key);assert.ok(wait);assert.equal(closeoutWaitState(wait,events(f)),'defect');
  assert.match(wait.waiting.defect,/native refusal/);assert.equal(closeoutEvaluations(f.common,f.org,events(f)).find(e=>e.key===entry.key).reason,row.reason);
  const recorded=fs.readFileSync(f.eventFile);assert.deepEqual(f.drain({keys:[entry.key],retrySafe:true}).evaluated,[]);assert.deepEqual(fs.readFileSync(f.eventFile),recorded);
  const log=path.join(f.common,'closeout/worker.log');fs.appendFileSync(log,JSON.stringify({schema:'closeout-diagnostic/v1',org:f.org,observed_seq:events(f).at(-1).seq,evaluation:{...row,completed:true}})+'\n');
  assert.throws(()=>f.drain({keys:[entry.key],retrySafe:true}),/invalid closeout diagnostic/);assert.deepEqual(f.read().actions,[]);
});

test('retirement phase closes its one bound session after slow preparation and leaves physical cleanup independent',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=rows[0].closeout_targets.find(t=>t.signal==='landed'),command=f.options.command;
  const realNow=Date.now,started=realNow();let delayed=false;
  f.options.command=(exe,args,opt)=>{if(!delayed&&exe===f.job.herdr){delayed=true;Date.now=()=>started+200000;}return command(exe,args,opt);};
  let phase;try{phase=f.drain({keys:[entry.key],sessionsOnly:true});}finally{Date.now=realNow;f.options.command=command;}
  assert.equal(phase.evaluated[0]?.sessions_retired,true,JSON.stringify(phase));assert.equal(phase.evaluated[0].completed,false);assert.equal(fs.existsSync(f.lane),true);
  assert.ok(effects(f).some(e=>e.action==='exit-observed'));assert.ok(effects(f).some(e=>e.action==='closed'));assert.equal(effects(f).some(e=>e.action==='worktree-removed'),false);
  assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1);
  const physical=f.drain({keys:[entry.key],retrySafe:true});assert.equal(physical.evaluated[0]?.completed,true,JSON.stringify(physical));assert.equal(fs.existsSync(f.lane),false);
  assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1,'physical completion never replays quit');
});

test('retirement phase fair selection finds native work among thousands of physical requests and preserves one-target phases',()=>{
  const physical=Array.from({length:2035},(_,n)=>({key:String(n),source:{seq:n+1},panes:[{pane:`old:${n}`}]})),build={key:'build',source:{seq:4000},panes:[{pane:'build:p'}]},review={key:'review',source:{seq:4001},panes:[{pane:'review:p'}]};
  const rows=physical.map((e,n)=>({type:'closeout.evaluated',key:e.key,seq:n+1,sessions_retired:true})),entries=[...physical,build,review];
  let chosen=scheduleLineCloseouts(entries,rows);assert.deepEqual(chosen.map(c=>[c.entry.key,c.sessionsOnly]),[['build',true],['0',false]]);
  chosen=scheduleLineCloseouts(entries,[...rows,{type:'closeout.evaluated',key:'build',seq:5000,reason:'original native outcome UNKNOWN'}]);
  assert.deepEqual(chosen.map(c=>[c.entry.key,c.sessionsOnly]),[['review',true],['0',false]],'a retained original intent gets no priority over a never-attempted independent session');
});

test('cleanup retention selects removal work before a continuing stream of empty ready bookkeeping',()=>{
  const landed={key:'landed',signal:'landed',source:{seq:1},panes:[{pane:'retired:p'}]},
    parked={key:'parked',signal:'parked',source:{seq:2},panes:[]},
    review={key:'review',signal:'review-done',source:{seq:3},panes:[{pane:'review:p'}]};
  const rows=[{type:'closeout.evaluated',key:landed.key,seq:100,sessions_retired:true}];
  const ready=Array.from({length:1000},(_,n)=>({key:`ready-${n}`,signal:'ready',source:{seq:1000+n},panes:[]}));
  const before=JSON.stringify([ready,rows,landed,parked,review]);
  let selected=scheduleLineCloseouts([...ready,landed,review],rows);
  assert.deepEqual(selected.map(s=>[s.entry.key,s.sessionsOnly]),[['review',true],['landed',false]]);
  selected=scheduleLineCloseouts([...ready,landed,parked,review],rows);
  assert.deepEqual(selected.map(s=>[s.entry.key,s.sessionsOnly]),[['review',true],['parked',false]],'unattempted removal keeps its normal order within removal work');
  assert.deepEqual(scheduleLineCloseouts(ready,rows).map(s=>[s.entry.key,s.sessionsOnly]),[['ready-0',false]],'bookkeeping still runs when removal work is exhausted');
  assert.equal(JSON.stringify([ready,rows,landed,parked,review]),before,'selection never rewrites queued bytes or evidence');
});

test('cleanup retention advances a retired landed session to guarded physical removal ahead of empty ready requests',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=readCloseoutEntries(f.common).find(e=>e.key===rows[0].closeout_targets.find(t=>t.signal==='landed').key);
  const first=f.drain({keys:[entry.key],sessionsOnly:true});
  assert.equal(first.evaluated[0]?.sessions_retired,true,JSON.stringify(first));assert.equal(first.evaluated[0].completed,false);assert.equal(fs.existsSync(f.lane),true);
  const ready=Array.from({length:32},(_,n)=>({key:`ready-${n}`,signal:'ready',source:{seq:rows[0].seq+n+1},panes:[]}));
  const selected=scheduleLineCloseouts([...ready,entry],closeoutEvaluations(f.common,f.org,events(f)));
  assert.deepEqual(selected.map(s=>[s.entry.key,s.sessionsOnly]),[[entry.key,false]]);
  const result=f.drain({keys:[selected[0].entry.key],retrySafe:true,sessionsOnly:selected[0].sessionsOnly});
  assert.equal(result.evaluated[0]?.completed,true,JSON.stringify(result));assert.equal(fs.existsSync(f.lane),false);
  assert.ok(effects(f).some(e=>e.action==='lane-removed'));assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1,'physical selection never replays the session exit');
});

test('cleanup retention priority preserves HOLD dirty source and original unknown native effects',t=>{
  for(const kind of ['hold','dirty','unknown']){
    const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=readCloseoutEntries(f.common).find(e=>e.key===rows[0].closeout_targets.find(t=>t.signal==='landed').key);
    if(kind==='unknown'){
      f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:entry.run,item:entry.item,source:entry.source,effect:'original-unknown',outcome:{action:'workspace-close-requested',workspace_id:'original-unknown-workspace'}}]);
    }else{
      const first=f.drain({keys:[entry.key],sessionsOnly:true});assert.equal(first.evaluated[0]?.sessions_retired,true,JSON.stringify(first));
      if(kind==='hold')hold(f);else fs.writeFileSync(path.join(f.lane,'unique-untracked-evidence'),'must remain');
    }
    const ready={key:'ready',signal:'ready',source:{seq:rows[0].seq+1},panes:[]},
      selected=scheduleLineCloseouts([ready,entry],[{type:'closeout.evaluated',key:entry.key,seq:rows[0].seq+2,sessions_retired:true}]);
    assert.equal(selected[0].entry.key,entry.key);assert.equal(selected[0].sessionsOnly,false);
    const file=path.join(f.common,'closeout/entries',entry.key+'.json'),bytes=fs.readFileSync(file),before=f.read().actions.length;
    const result=f.drain({keys:[entry.key],retrySafe:true});assert.equal(result.evaluated[0]?.completed,false,JSON.stringify(result));
    assert.match(result.evaluated[0].reason,kind==='hold'?/HOLD/:kind==='dirty'?/clean|dirty|untracked/:/unresolved native/);
    assert.equal(fs.existsSync(f.lane),true);assert.deepEqual(fs.readFileSync(file),bytes);
    assert.equal(effects(f).some(e=>e.action==='lane-removed'),false);
    if(kind==='unknown')assert.equal(f.read().actions.length,before,'unknown original outcome grants no native effect');
  }
});

test('retirement phase retains original unknown exits and a fresh service STOP before any native effect',t=>{
  for(const kind of ['unknown','stop']){
    const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=rows[0].closeout_targets.find(t=>t.signal==='landed');
    if(kind==='unknown'){
      const candidate=f.retirement(f.options).plan(f.lane).close[0];f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:'R-1',item:'ENG-1',source:{seq:rows[0].seq,type:'item.closed'},effect:'preserved-original-intent',outcome:{action:'agent-exit-requested',run:candidate.run,pane:candidate.pane,tab_id:candidate.tab_id,occupant:candidate.occupant,shell:candidate.shell}}]);
    }else{
      const base=f.options.command;let stopped=false;f.options.command=(exe,args,opt)=>{const result=base(exe,args,opt);if(!stopped&&exe===f.job.herdr){stopped=true;const directory=path.join(f.org,'line-service',createHash('sha256').update(JSON.stringify(f.common)).digest('hex').slice(0,20));fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'STOP'),'actual STOP after selection');}return result;};
    }
    const result=f.drain({keys:[entry.key],sessionsOnly:true,retrySafe:true});assert.equal(result.evaluated[0]?.completed,false);assert.notEqual(result.evaluated[0]?.sessions_retired,true);assert.match(result.evaluated[0].reason,/unresolved native|STOP|UNKNOWN/);assert.deepEqual(f.read().actions,[]);
  }
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=rows[0].closeout_targets.find(t=>t.signal==='landed');
  f.state.agents=[];f.state.tabs=[];f.state.panes=[];f.save();
  const result=f.drain({keys:[entry.key],sessionsOnly:true,retrySafe:true});assert.equal(result.evaluated[0].completed,false);assert.equal(result.evaluated[0].sessions_retired,true);
  assert.ok(effects(f).some(e=>e.action==='allocation-absent'&&e.pane==='w:p'&&e.terminal==='term'&&e.session==='session'));
  assert.equal(effects(f).some(e=>['exit-observed','session-released','lane-removed'].includes(e.action)),false,'absence invents no exit, release or removal');
  assert.equal(fs.existsSync(f.lane),true);assert.deepEqual(f.read().actions,[]);
});

test('phase1 deadline retry retains the original pending native exit without evaluation or readback',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry={...rows[0].closeout_targets.find(t=>t.signal==='landed'),source:{seq:rows[0].seq,type:'item.closed'}};
  const deferred=drainWithSpentTargetBudget(f,entry.key);assert.equal(deferred.evaluated[0]?.condition.kind,'pre-effect-budget');
  const intent='fixture-original-exit-intent',outcome={action:'agent-exit-requested',run:'R-1',pane:'w:p',tab_id:'w:t',occupant:['worker','codex','w:p','w',f.lane,'term','session'],shell:{pid:1,identity:'shell',command:'[zsh]'}};
  f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:'R-1',item:'ENG-1',source:entry.source,effect:intent,producer:'native-closeout/v2',outcome},nativeCloseoutWait(entry,outcome,intent)]);
  const retained=retainNativeOutcome(f,entry),prior=evaluations(f);
  assert.deepEqual(f.drain({keys:[entry.key],retrySafe:true}).evaluated,[]);retained();
  f.append([{type:'closeout.retry',identity:f.common,keys:[entry.key],why:'fixture manual retry cannot resolve the original native intent'}]);
  assert.deepEqual(f.drain({keys:[entry.key]}).evaluated,[]);retained();
  assert.deepEqual(evaluations(f),prior);assert.deepEqual(f.read().actions,[]);
});

test('phase1 lost exit reply stays unresolved after named retries without native readback or resend',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry={...rows[0].closeout_targets.find(t=>t.signal==='landed'),source:{seq:rows[0].seq,type:'item.closed'}},base=f.options.command;
  const now=Date.now,deadline=now()+180000;
  f.options.command=(exe,args,opt)=>{const result=base(exe,args,opt);if(exe===f.job.herdr&&args[0]==='agent'&&args[1]==='prompt'){Date.now=()=>deadline;return{...result,status:1,stderr:'lost exit acknowledgement'};}return result;};
  let first;try{first=f.drain({keys:[entry.key],retirementOptions:{...f.options,deadline}});}finally{Date.now=now;}
  assert.equal(first.evaluated[0].completed,false);assert.deepEqual(f.read().actions,[['agent','prompt','worker','/quit']]);
  assert.equal(safeCloseoutRetry(evaluations(f).at(-1),{entry,events:events(f)}),false);
  // This retained legacy predicate grants no permission to select a readback.
  assert.equal(closeoutOutcomeObservation(evaluations(f).at(-1),{entry,events:events(f)}),true);
  const retained=retainNativeOutcome(f,entry),prior=evaluations(f);
  for(let pass=0;pass<2;pass++){assert.deepEqual(f.drain({keys:[entry.key],retrySafe:true}).evaluated,[]);retained();}
  assert.deepEqual(evaluations(f),prior);assert.equal(effects(f).some(e=>e.action==='exit-observed'),false);
  assert.equal(safeCloseoutRetry(evaluations(f).at(-1),{entry,events:events(f)}),false);
  assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1);
});

test('phase1 unresolved exit retains live replaced and refused evidence without new native reads',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry={...rows[0].closeout_targets.find(t=>t.signal==='landed'),source:{seq:rows[0].seq,type:'item.closed'}};
  const candidate=f.retirement(f.options).plan(f.lane).close[0];assert.equal(candidate.decision,'exit');
  f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:'R-1',item:'ENG-1',source:entry.source,effect:'original-unknown-exit',outcome:{action:'agent-exit-requested',run:candidate.run,pane:candidate.pane,tab_id:candidate.tab_id,occupant:candidate.occupant,shell:candidate.shell}}]);
  const retained=retainNativeOutcome(f,entry);
  const first=f.drain({keys:[entry.key],retrySafe:true});assert.equal(first.evaluated[0].completed,false);assert.match(first.evaluated[0].reason,/unresolved native/);retained();assert.deepEqual(f.read().actions,[]);
  for(const reason of ['EPERM native refusal','foreign source','native identity changed','HOLD'])assert.equal(closeoutOutcomeObservation({completed:false,reason},{entry,events:events(f)}),false,reason);
  f.state.agents[0].agent_session={value:'replacement'};
  const shell=f.state.info.process_tree[0];f.state.info={shell_pid:shell.pid,foreground_processes:[{pid:shell.pid,name:'zsh'}],process_tree_complete:true,process_tree:[shell]};f.save();
  const prior=evaluations(f);assert.deepEqual(f.drain({keys:[entry.key],retrySafe:true}).evaluated,[]);retained();
  assert.deepEqual(evaluations(f),prior);assert.deepEqual(f.read().actions,[]);
});

test('continuity service retains a lost tab close outcome without native readback or invented completion',t=>{
  const f=setup(t,{merged:true});f.report();f.append([{type:'line-service.phase0',id:'bound',project:f.common,repo:f.repo,org:f.org,main:'main',canonical_head:f.head}]);
  const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry={...rows[0].closeout_targets.find(t=>t.signal==='landed'),source:{seq:rows[0].seq,type:'item.closed'}},base=f.options.command;
  const now=Date.now,deadline=now()+180000;
  let lost=false;f.options.command=(exe,args,opt)=>{const result=base(exe,args,opt);if(!lost&&exe===f.job.herdr&&args[0]==='tab'&&args[1]==='close'){lost=true;Date.now=()=>deadline;return{...result,status:1,stderr:'lost tab-close acknowledgement'};}return result;};
  const drains=[],service=createLineService({repo:f.repo,org:f.org,to:'brain-chat',env:f.env,maxStarts:0,recordNotice:d=>({id:d.id,state:'record-only'}),command:(_exe,args)=>{
    assert.equal(args[0],path.join(sourceRoot,'supervisor/closeout.mjs'));assert.ok(args.includes('--retry-safe'));
    const keys=JSON.parse(args[args.indexOf('--keys')+1]);assert.deepEqual(keys,[entry.key]);
    const result=f.drain({keys,retrySafe:true,sessionsOnly:args.includes('--sessions-only'),retirementOptions:{...f.options,...(!drains.length?{deadline}:{})}});drains.push(result);return{status:0,stdout:JSON.stringify(result),stderr:''};
  }});
  try{service.pass();}finally{Date.now=now;}
  assert.equal(lost,true);assert.equal(effects(f).some(e=>e.action==='closed'&&e.tab_id==='w:t'),false);assert.equal(f.read().tabs.length,0);
  const original=f.read().actions;assert.deepEqual(original,[['agent','prompt','worker','/quit'],['tab','close','w:t']]);
  assert.equal(closeoutOutcomeObservation(evaluations(f).at(-1),{entry,events:events(f)}),true);
  const retained=retainNativeOutcome(f,entry),prior=evaluations(f);
  for(let pass=0;pass<3;pass++){service.pass();retained();}
  assert.deepEqual(evaluations(f),prior);assert.deepEqual(f.read().actions,original);
  assert.equal(effects(f).filter(e=>e.action==='closed'&&e.tab_id==='w:t'&&e.reconciled).length,0);
  assert.equal(safeCloseoutRetry(evaluations(f).at(-1),{entry,events:events(f)}),false);
  assert.notEqual(evaluations(f).at(-1).sessions_retired,true);
  assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1);assert.equal(f.read().actions.filter(a=>a[0]==='tab'&&a[1]==='close').length,1);
  for(const drain of drains.slice(1))assert.deepEqual(drain.evaluated,[]);
});

test('midpoint progress line passes carry a retired session to physical removal and resolve its ready twin with no decision or wait',t=>{
  const f=setup(t,{merged:true});f.append([{type:'line-service.phase0',id:'bound',project:f.common,repo:f.repo,org:f.org,main:'main',canonical_head:f.head}]);
  const ready=f.report()[0].closeout_targets.find(t=>t.signal==='ready'),rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),landed=rows[0].closeout_targets.find(t=>t.signal==='landed');
  const drains=[],service=createLineService({repo:f.repo,org:f.org,to:'brain-chat',env:f.env,maxStarts:0,recordNotice:d=>({id:d.id,state:'record-only'}),command:(_exe,args)=>{
    const keys=JSON.parse(args[args.indexOf('--keys')+1]),result=f.drain({keys,retrySafe:true,sessionsOnly:args.includes('--sessions-only')});
    drains.push([keys[0],args.includes('--sessions-only'),result]);return{status:0,stdout:JSON.stringify(result),stderr:''};
  }});
  service.pass();
  const retired=evaluations(f).findLast(e=>e.key===landed.key);assert.equal(retired.sessions_retired,true,JSON.stringify(drains));assert.equal(retired.waiting.next,'physical');
  assert.match(evaluations(f).findLast(e=>e.key===ready.key).reason,/^landed or parked request owns/);
  // The 052 flood stored a defect wait for this exact midpoint; it is old evidence, not a gate.
  f.append([{type:'closeout.waiting',identity:f.common,key:landed.key,run:'R-1',item:'ENG-1',source:retired.source,revision:retired.revision,wait_id:closeoutWaitId(readCloseoutEntries(f.common).find(e=>e.key===landed.key),retired),
    waiting:{owner:'line-service',defect:'No existing completion writer for this exact wait: bound sessions retired; physical cleanup remains queued',producers:[]}}]);
  for(let pass=0;pass<4;pass++)service.pass();
  assert.equal(fs.existsSync(f.lane),false,JSON.stringify(drains.map(d=>[d[0]===landed.key?'landed':'ready',d[1],d[2].evaluated?.[0]?.reason??d[2].evaluated?.[0]?.completed])));
  assert.equal(evaluations(f).findLast(e=>e.key===landed.key).completed,true);
  const twin=evaluations(f).findLast(e=>e.key===ready.key);assert.equal(twin.completed,true);assert.match(twin.reason,/retired by a later bound request/);
  const all=events(f),state=fold(all);
  assert.equal([...state.items.values()].filter(i=>i.role==='decision').length,0,'ordinary progress never becomes a decision');
  assert.deepEqual(all.filter(e=>e.type==='closeout.waiting'&&e.revision!==undefined).map(e=>e.waiting.defect),['No existing completion writer for this exact wait: bound sessions retired; physical cleanup remains queued'],'only the injected historical wait exists');
  assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1);assert.equal(f.read().actions.filter(a=>a[0]==='tab'&&a[1]==='close').length,1);
  const count=drains.length;for(let pass=0;pass<3;pass++)service.pass();assert.equal(drains.length,count,'settled history is not re-drained');
});

const floodDecision=(id,entry,source)=>({type:'item.added',id,kind:'work',role:'decision',title:'Resolve a missing completion producer or recorded refusal',accept:['fixture copy of a 052 flood proposal'],
  meta:{route:'unblock',queue_selected:true,uncertain_outcome:{key:`flood-${id}`,check:{key:`closeout:${entry.key}`,subject:{item:'ENG-1',run:'R-1',key:entry.key,head:entry.head,source},status:'defect'}}}});

test('flood backlog fixed pass defers obsolete midpoint and twin decisions from their current stage while cleanup still completes',t=>{
  const f=setup(t,{merged:true});f.append([{type:'line-service.phase0',id:'bound',project:f.common,repo:f.repo,org:f.org,main:'main',canonical_head:f.head}]);
  const [report]=f.report(),ready=report.closeout_targets.find(t=>t.signal==='ready'),rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),landed=rows[0].closeout_targets.find(t=>t.signal==='landed');
  const launches=[],service=createLineService({repo:f.repo,org:f.org,to:'brain-chat',env:f.env,maxStarts:1,capacity:()=>({cap:7,count:0}),recordNotice:d=>({id:d.id,state:'record-only'}),command:(_exe,args)=>{
    if(!args[0].endsWith('supervisor/closeout.mjs')){launches.push(args);return{status:1,stdout:'',stderr:'fixture launch refused'};}
    const keys=JSON.parse(args[args.indexOf('--keys')+1]);return{status:0,stdout:JSON.stringify(f.drain({keys,retrySafe:true,sessionsOnly:args.includes('--sessions-only')})),stderr:''};
  }});
  const deferred=()=>fs.readFileSync(path.join(service.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse).findLast(r=>r.action==='pass-complete').timing.outcome_decisions_deferred;
  service.pass();assert.equal(evaluations(f).findLast(e=>e.key===landed.key).sessions_retired,true);
  // Parentless copies, so a closed subject's launch hold cannot be what defers them.
  transact(f.org,()=>({add:[floodDecision('DEC-901',landed,{seq:rows[0].seq,type:'item.closed'}),floodDecision('DEC-902',ready,{seq:report.seq,type:'report.ingested'})]}),{actor:'fixture'});
  const before=JSON.stringify(['DEC-901','DEC-902'].map(id=>fold(events(f)).items.get(id)));
  service.pass();assert.equal(deferred(),2,'midpoint and twin proposals are both obsolete at their current stage');
  for(let pass=0;pass<4;pass++)service.pass();
  assert.equal(fs.existsSync(f.lane),false,'cleanup eligibility never waits on the proposals');
  assert.equal(evaluations(f).findLast(e=>e.key===ready.key).completed,true);
  assert.equal(deferred(),2,'completed and unqueued requests stay deferred');
  assert.deepEqual(launches,[],'no judge launch was attempted');
  const state=fold(events(f));assert.equal(JSON.stringify(['DEC-901','DEC-902'].map(id=>state.items.get(id))),before,'proposals are deferred, not closed or rewritten');
  assert.equal([...state.items.values()].filter(i=>i.role==='decision').length,2,'no proposal is recreated or added');
});

test('flood backlog current refusal decisions stay owned while changed or unlinked subjects are obsolete',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),source={seq:rows[0].seq,type:'item.closed'};
  const entries=readCloseoutEntries(f.common),entry=entries.find(e=>e.source.seq===source.seq),decision=floodDecision('DEC-903',entry,source).meta.uncertain_outcome;
  const view=()=>({events:events(f),entries,evaluations:new Map(closeoutEvaluations(f.common,f.org,events(f)).map(e=>[e.key,e]))}),item={meta:{uncertain_outcome:decision}};
  assert.match(obsoleteOutcomeDecision(item,view()),/no current defect/,'an unevaluated request has no defect to judge');
  const [refusal]=f.append([{type:'closeout.evaluated',key:entry.key,identity:f.common,run:'R-1',item:'ENG-1',source,revision:closeoutRevision(entry,events(f)),completed:false,reason:'EPERM native refusal'}]);
  transact(f.org,current=>({add:registerCloseoutWait(entry,refusal,current,entries)}),{actor:'fixture'});
  assert.equal(obsoleteOutcomeDecision(item,view()),null,'a recorded native refusal keeps its decision owner');
  assert.match(obsoleteOutcomeDecision({meta:{uncertain_outcome:{...decision,check:{...decision.check,subject:{...decision.check.subject,source:{seq:1,type:'item.closed'}}}}}},view()),/source binding changed/);
  assert.equal(obsoleteOutcomeDecision({meta:{uncertain_outcome:{key:'other',check:{key:'dispatch:ENG-9:input'}}}},view()),null,'non-cleanup outcome decisions keep their existing path');
});

test('session_bound supersession preserves its already-bound predecessor under the current and historical event names',t=>{
  const f=setup(t,{merged:true});f.report();const key=closeoutKey(fs.realpathSync(f.lane),'R-1','ready');
  const original=readCloseoutEntries(f.common).find(e=>e.key===key),file=path.join(f.common,'closeout/entries',key+'.json'),bytes=fs.readFileSync(file);
  assert.deepEqual(original.panes.map(p=>[p.run,p.session]),[['R-1','session']]);
  f.append([{type:'run.started',id:'R-2',item:'ENG-1',workspace:f.lane,meta:{lane:'topic'}}]);
  for(const type of ['run.session_bound','run.session_bound','run.session-bound']){
    const [bound]=f.append([{type,run:'R-2',session:{agent_session_id:'later'}}]);
    assert.deepEqual(bound.closeout_targets,[],`${type}: the original source already owns its target`);
    assert.deepEqual(fs.readFileSync(file),bytes,'no successor identity or new source replaces the original target');
    assert.deepEqual(readCloseoutEntries(f.common).find(e=>e.key===key),original);
    assert.equal(readCloseoutEntries(f.common).filter(e=>e.run==='R-1'&&e.signal==='ready').length,1,type);
  }
  assert.ok(closeoutRevision(readCloseoutEntries(f.common).find(e=>e.key===key),events(f))>events(f).find(e=>e.type==='report.ingested').seq);
});

test('code handoff after a journaled exit intent records zero native start and strands no UNKNOWN intent',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),key=rows[0].closeout_targets.find(t=>t.signal==='landed').key;
  let moved=false;const log=f.options.log;
  f.options.log=row=>{log(row);if(row.action==='agent-exit-requested'&&!moved){moved=true;f.git(['checkout','-qb','moved-main']);}};
  let first;try{first=f.drain({keys:[key],sessionsOnly:true});}finally{f.options.log=log;if(moved)f.git(['checkout','-q','main']);}
  assert.equal(moved,true);assert.deepEqual(first.evaluated,[],JSON.stringify(first));assert.ok(first.restart?.keys?.includes(key),JSON.stringify(first));
  assert.deepEqual(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt'),[],'the refused guard ran before any native command');
  const all=events(f),intent=all.find(e=>e.type==='closeout.effect'&&e.key===key&&e.outcome.action==='agent-exit-requested'),unsent=all.filter(e=>e.type==='closeout.command-not-started');
  assert.equal(unsent.length,1);assert.equal(unsent[0].intent,intent.effect);assert.equal(unsent[0].native_started,false);assert.equal(unsent[0].code,'CLOSEOUT_CODE_CHANGED');
  const entry=readCloseoutEntries(f.common).find(e=>e.key===key);assert.equal(unresolvedCloseoutEffect(entry,all),undefined);
  assert.equal(closeoutWaitState(all.find(e=>e.type==='closeout.waiting'&&e.waiting.producers?.[0]?.intent===intent.effect),all),'complete');
  assert.equal(all.some(e=>e.type==='closeout.command-failed'),false);assert.ok(all.some(e=>e.type==='closeout.code-handoff'&&e.keys.includes(key)));
  const next=f.drain({keys:[key],sessionsOnly:true});assert.equal(next.evaluated[0]?.sessions_retired,true,JSON.stringify(next));
  assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1,'the first actual send happens once, after the handoff');
});

test('code handoff unsent then uncertain native retry',t=>{
  for (const action of ['agent-exit-requested','shell-close-requested','workspace-close-requested']) {
    // Empty-workspace recovery runs after the independently authorized Git
    // removal. Exit/tab attempts must retain the still-present lane throughout.
    const workspace=action==='workspace-close-requested',f=setup(t,{merged:true,occupied:!workspace});
    f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),key=rows[0].closeout_targets.find(t=>t.signal==='landed').key;
    if(action==='shell-close-requested'){
      const candidate=f.retirement(f.options).plan(f.lane).close[0];
      f.state.agents=[];f.state.info={shell_pid:1,foreground_processes:[{pid:1,name:'zsh'}],process_tree_complete:true,process_tree:[f.state.info.process_tree[0]]};f.save();
      assert.equal(f.retirement(f.options).reconcileAgentExit(candidate),true,'fixture positively observes the prerequisite exit without sending');
    }
    let moved=false;const log=f.options.log;
    f.options.log=row=>{log(row);if(row.action===action&&!moved){moved=true;f.git(['checkout','-qb','moved-main']);}};
    let first;try{first=f.drain({keys:[key],sessionsOnly:!workspace});}finally{f.options.log=log;if(moved)f.git(['checkout','-q','main']);}
    assert.equal(moved,true,`${action}: ${JSON.stringify(first)}`);assert.ok(first.restart?.keys.includes(key),JSON.stringify(first));assert.deepEqual(f.read().actions,[],action);
    const before=events(f),original=before.find(e=>e.type==='closeout.effect'&&e.key===key&&e.outcome.action===action),unsent=before.find(e=>e.type==='closeout.command-not-started'&&e.intent===original.effect);
    assert.equal(unsent.native_started,false);assert.equal(unsent.code,'CLOSEOUT_CODE_CHANGED');
    const entry=readCloseoutEntries(f.common).find(e=>e.key===key),waitFor=(all,id)=>all.find(e=>e.type==='closeout.waiting'&&e.waiting.producers?.[0]?.intent===id);
    assert.equal(unresolvedCloseoutEffect(entry,before),undefined);assert.equal(closeoutWaitState(waitFor(before,original.effect),before),'complete');
    const removals=before.filter(e=>e.type==='closeout.effect'&&e.outcome.action==='lane-removed');assert.equal(removals.length,workspace?1:0);
    let sends=0;const command=f.options.command;
    f.options.command=(exe,args,opt)=>{
      if(exe===f.job.herdr&&(action==='agent-exit-requested'?args[0]==='agent'&&args[1]==='prompt':args[0]===(workspace?'workspace':'tab')&&args[1]==='close')){
        sends++;const state=f.read();state.actions.push(args);fs.writeFileSync(f.file,JSON.stringify(state));
        return{status:1,stdout:'',stderr:'native reply unavailable; outcome unknown'};
      }
      return command(exe,args,opt);
    };
    const actual=f.drain({keys:[key],sessionsOnly:!workspace}),all=events(f),attempts=all.filter(e=>e.type==='closeout.effect'&&e.key===key&&e.outcome.action===action),later=attempts.at(-1);
    assert.equal(actual.evaluated[0]?.completed,false,JSON.stringify({action,first,actual,waits:all.filter(e=>e.type==='closeout.waiting'&&e.key===key).map(e=>e.waiting)}));assert.equal(attempts.length,2);assert.notEqual(later.effect,original.effect);
    const laterWait=waitFor(all,later.effect);assert.ok(laterWait);assert.notEqual(laterWait.wait_id,waitFor(all,original.effect).wait_id);assert.ok(laterWait.seq>later.seq);
    assert.deepEqual(all.find(e=>e.seq===unsent.seq),unsent,'original positive no-start evidence stays immutable');
    assert.equal(closeoutWaitState(waitFor(all,original.effect),all),'complete');assert.equal(closeoutWaitState(laterWait,all),'failed');
    assert.deepEqual(unresolvedCloseoutEffect(entry,all),later.outcome);
    const failure=all.find(e=>e.type==='closeout.command-failed'&&e.intent===later.effect);assert.ok(failure);
    assert.ok(all.some(e=>e.type==='closeout.producer-status'&&e.wait_id===laterWait.wait_id&&e.producer.intent===later.effect&&e.status==='failed'&&e.completion.seq===failure.seq));
    for(let pass=0;pass<3;pass++)f.drain({keys:[key],retrySafe:true,sessionsOnly:!workspace});
    const retained=events(f);assert.equal(sends,1);assert.equal(f.read().actions.length,1);assert.deepEqual(unresolvedCloseoutEffect(entry,retained),later.outcome);
    assert.deepEqual(retained.filter(e=>e.type==='closeout.effect'&&e.outcome.action==='lane-removed'),removals,'uncertain invocation and safe drains authorize no lane removal');
    assert.equal(fs.existsSync(f.lane),!workspace);assert.deepEqual(retained.filter(e=>e.type==='closeout.command-not-started'),[unsent]);
  }
});

test('continuity unresolved tab close retains present replaced moved held stopped refused and unbound targets',t=>{
  for(const kind of ['present','replaced','moved','held','stop','native-read-refused','refused','unbound']){
    const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry={...rows[0].closeout_targets.find(t=>t.signal==='landed'),source:{seq:rows[0].seq,type:'item.closed'}};
    f.append([{type:'closeout.effect',key:entry.key,identity:f.common,source:entry.source,effect:'original-close',outcome:{action:'shell-close-requested',tab_id:'w:t',panes:[{pane:'w:p',terminal:kind==='unbound'?'foreign':'term'}]}},
      {type:'closeout.evaluated',key:entry.key,identity:f.common,run:entry.run,item:entry.item,source:entry.source,completed:false,revision:entry.source.seq,reason:kind==='refused'?'EPERM native refusal':'unresolved native exit/close intent retained; reconcile its original identity/outcome without replay'}]);
    if(kind==='replaced'){f.state.panes[0].terminal_id='replacement';f.save();}
    if(kind==='moved'){f.state.tabs=[];f.state.panes=[];f.state.agents[0].pane_id='elsewhere';f.save();}
    if(kind==='held')hold(f);
    if(kind==='stop'){fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.repo,'.lane/supervisor/STOP'),'stop');}
    if(kind==='native-read-refused'){const base=f.options.command;f.options.command=(exe,args,opt)=>exe===f.job.herdr?{status:1,stdout:'',stderr:'EPERM native refusal'}:base(exe,args,opt);}
    assert.equal(closeoutOutcomeObservation(evaluations(f).at(-1),{entry,events:events(f)}),!['refused','unbound'].includes(kind),kind);
    const retained=retainNativeOutcome(f,entry),prior=evaluations(f);
    assert.deepEqual(f.drain({keys:[entry.key],retrySafe:true}).evaluated,[],kind);retained();
    assert.deepEqual(evaluations(f),prior,kind);assert.equal(effects(f).some(e=>e.action==='closed'),false,kind);
    assert.deepEqual(f.read().actions,[],kind);assert.ok(fs.existsSync(f.lane),kind);
  }
});
