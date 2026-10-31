import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup,events,effects,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {runCloseoutTurn,CLOSEOUT_TURN_BUDGET_MS} from '../line-service/closeout-turn.mjs';
import {currentCloseoutEntries,scheduleLineCloseouts,unresolvedCloseoutEffect} from '../lib/closeout.mjs';
import {closeoutWaitState} from '../lib/closeout-status.mjs';
import {reconcileCloseoutBacklog} from '../lib/closeout-backlog.mjs';

const target=f=>currentCloseoutEntries(f.common,f.org,events(f))[0];
const drain=f=>f.drain({keys:[target(f).key],retrySafe:true});

test('finite line completes inventory-sized folder removal and merged branch deletion after native close',t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});selectCurrentCleanup(f);f.report();
  fs.appendFileSync(path.join(f.common,'info/exclude'),'\nnode_modules/\n');
  fs.mkdirSync(path.join(f.lane,'node_modules'));
  for(let i=0;i<3900;i++)fs.writeFileSync(path.join(f.lane,'node_modules',String(i)),'rebuildable');
  let elapsed=0;const realNow=Date.now(),command=f.options.command;
  t.mock.method(Date,'now',()=>realNow+elapsed);
  f.options.command=(exe,args,options)=>{
    const removing=exe==='git'&&args[2]==='worktree'&&args[3]==='remove';
    if(removing)assert.ok(options.timeout>=69000,`original inventory allowance: ${options.timeout}`);
    const result=command(exe,args,options);if(removing)elapsed+=65000;return result;
  };
  const result=runCloseoutTurn({project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},maxSteps:1,
    clock:()=>elapsed,now:()=>Date.now(),cli:(file,args)=>{
      if(args[0]==='refresh')return '{}';
      f.options.deadline=Number(args[args.indexOf('--deadline')+1]);
      assert.equal(f.options.deadline-Date.now(),CLOSEOUT_TURN_BUDGET_MS);
      return JSON.stringify(drain(f));
    }});
  assert.deepEqual(result.errors,[]);assert.equal(result.steps,1);
  assert.equal(fs.existsSync(f.lane),false);assert.equal(f.git(['branch','--list','lane/topic']),'');
  assert.ok(effects(f).some(e=>e.action==='worktree-removed'));assert.ok(effects(f).some(e=>e.action==='branch-removed'));
});

test('a deferred preservation copy is explicitly discarded and a fresh finite turn removes the lane',t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});f.report();
  let elapsed=0;const realNow=Date.now(),log=f.options.log;
  t.mock.method(Date,'now',()=>realNow+elapsed);
  f.options.deadline=Date.now()+180000;
  f.options.log=row=>{log(row);if(row.action==='lane-preflight')elapsed+=170000;};
  const first=drain(f).evaluated[0];assert.equal(first.completed,false);assert.equal(first.condition.kind,'pre-effect-budget');
  const discarded=effects(f).find(e=>e.action==='lane-evidence-discarded');assert.ok(discarded);
  assert.equal(fs.existsSync(discarded.directory),false);assert.equal(fs.existsSync(f.lane),true);
  f.options.log=log;f.options.deadline=Date.now()+180000;
  assert.equal(drain(f).evaluated[0].completed,true);assert.equal(fs.existsSync(f.lane),false);
});

test('legacy physical continuations cannot starve behind repeatedly eligible direct keeps',()=>{
  const direct={key:'direct',reportCloseout:true,source:{seq:1},panes:[{}]},legacy={key:'legacy',signal:'landed',source:{seq:2},panes:[]};
  assert.deepEqual(scheduleLineCloseouts([direct,legacy],[],{batch:true,attempts:{direct:10}}).map(x=>x.entry.key),['legacy','direct']);
});

test('a lock-contended report gets a bounded slot beside a never-attempted legacy backlog',()=>{
  const direct={key:'report',reportCloseout:true,source:{seq:3000},panes:[{}]},
    legacy=Array.from({length:30},(_,i)=>({key:`old-${i}`,signal:'landed',source:{seq:i+1},panes:[]}));
  for(const turn of [1,2]){
    const selected=scheduleLineCloseouts([...legacy,direct],[],{batch:true,attempts:{report:2568},turn});
    assert.ok(selected.slice(0,2).some(x=>x.entry.key==='report'),'an admission refusal cannot bury the report behind every historical key');
    assert.ok(selected.slice(0,2).some(x=>x.entry.key.startsWith('old-')),'legacy cleanup retains its slot');
    assert.equal(new Set(selected.map(x=>x.entry.key)).size,31);
    assert.equal(selected.find(x=>x.entry.key==='report').sessionsOnly,false);
    assert.deepEqual(selected.filter(x=>x.entry.key!=='report').map(x=>x.entry.key),legacy.map(x=>x.key));
  }
});

test('one-step turns rotate report and legacy service even with unequal historical attempt counters',()=>{
  const direct={key:'report',reportCloseout:true,source:{seq:3000},panes:[{}]},
    legacy=Array.from({length:30},(_,i)=>({key:`old-${i}`,signal:'landed',source:{seq:i+1},panes:[]})),attempts={report:2568};
  const selected=[];
  for(let turn=1;turn<=4;turn++){
    const first=scheduleLineCloseouts([...legacy,direct],[],{batch:true,attempts,turn})[0];
    selected.push(first.entry.key);attempts[first.entry.key]=2568+turn;
  }
  assert.deepEqual(selected,['report','old-0','report','old-1']);
});

test('line classifies parked UNKNOWN and missing preservation without replay, and retains unreported allocation truth',t=>{
  const f=setup(t,{direct:true,bound:true});selectCurrentCleanup(f);f.report();const entry=target(f);
  f.append([{type:'closeout.effect',identity:f.common,key:entry.key,source:entry.source,effect:'original',producer:'native-closeout/v2',
    outcome:{action:'shell-close-requested',tab_id:'original-tab',panes:[{pane:'w:p',terminal:'term'}]}},
  {type:'closeout.evaluated',identity:f.common,key:entry.key,source:entry.source,run:entry.run,item:entry.item,revision:entry.source.seq,completed:false,reason:'queued worktree absent without a preservation proof; keep'},
  {type:'closeout.waiting',identity:f.common,key:entry.key,source:entry.source,run:entry.run,item:entry.item,revision:entry.source.seq,wait_id:'old-wait',waiting:{owner:'line-service',defect:'No existing completion writer',producers:[]}},
  {type:'item.added',id:'ENG-2',role:'engineer',title:'Unreported original'},
  {type:'run.started',id:'R-2',item:'ENG-2',workspace:f.lane+'-open',meta:{dispatch_project:f.common,dispatch_journal:'/original/dispatch'}}]);
  const before=events(f),calls=f.herdrCalls(),actions=f.read().actions;
  const options={project:gitProject(f.repo),org:f.org,guard:()=>{},events:before};
  const rows=reconcileCloseoutBacklog(options);assert.equal(rows.length,2);
  const held=rows.find(e=>e.type==='closeout.wait-classified');assert.equal(held.disposition,'held');
  assert.equal(held.condition.kind,'uncertain-invocation');assert.equal(held.continuation.kind,'owner-evidence');
  assert.equal(rows.find(e=>e.type==='closeout.allocation-kept').disposition,'active-unreported');
  const all=events(f),wait=all.find(e=>e.wait_id==='old-wait');assert.equal(closeoutWaitState(wait,all),'defect');
  assert.ok(unresolvedCloseoutEffect(entry,all));assert.deepEqual(drain(f).evaluated,[]);
  assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.read().actions,actions);
  assert.deepEqual(all.slice(0,before.length),before);assert.deepEqual(reconcileCloseoutBacklog({...options,events:events(f)}),[]);
  assert.equal(fs.existsSync(f.lane),true);
});

test('original close completion is durable before fallible post-close receipt pruning',t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});f.report();const command=f.options.command;let closed=false;
  f.options.command=(exe,args,options)=>{
    if(closed&&exe===f.job.herdr&&args[0]==='workspace'&&args[1]==='list')return{status:1,stdout:'',stderr:'post-close inventory unavailable'};
    const result=command(exe,args,options);
    if(exe===f.job.herdr&&args[0]==='tab'&&args[1]==='close')closed=true;
    return result;
  };
  drain(f);assert.equal(closed,true);assert.ok(effects(f).some(e=>e.action==='closed'&&e.tab_id));
  assert.equal(unresolvedCloseoutEffect(target(f),events(f)),undefined);
});

test('an original failed native return retains its specific error and no later drain replays it',t=>{
  const f=setup(t,{direct:true,bound:true});f.report();const command=f.options.command;
  f.options.command=(exe,args,options)=>exe===f.job.herdr&&args[0]==='agent'&&args[1]==='prompt'?
    {status:1,stdout:'',stderr:JSON.stringify({error:{code:'agent_prompt_stalled',message:'original exit reply was not observed'}})}:command(exe,args,options);
  const row=drain(f).evaluated[0];assert.equal(row.native_result.error.code,'agent_prompt_stalled');
  assert.match(row.native_result.reason,/original exit reply/);
  const failed=events(f).find(e=>e.type==='closeout.command-failed');assert.deepEqual(failed.native_result,row.native_result);
  const calls=f.herdrCalls();assert.deepEqual(drain(f).evaluated,[]);assert.deepEqual(f.herdrCalls(),calls);
});

test('a turn with too little exit observation time keeps before intent and continues on a fresh allowance',t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});f.report();
  f.options.deadline=Date.now()+45000;
  const first=drain(f).evaluated[0];assert.equal(first.condition.kind,'pre-effect-budget');
  assert.equal(effects(f).some(e=>e.action==='agent-exit-requested'),false);
  assert.deepEqual(f.read().actions,[]);
  f.options.deadline=Date.now()+180000;
  assert.equal(drain(f).evaluated[0].completed,true);assert.equal(fs.existsSync(f.lane),false);
});
