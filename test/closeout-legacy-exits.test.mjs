import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup,events,effects,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {currentCloseoutEntries,unresolvedCloseoutEffect} from '../lib/closeout.mjs';
import {legacyExitIntent,legacyExitSettlement,observeLegacyExitAbsence} from '../lib/closeout-legacy-exits.mjs';
import {nativeCloseoutWait,closeoutWaitState} from '../lib/closeout-status.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {gitProject} from '../lib/project.mjs';

function fixture(t,{merged=true,vacant=true}={}) {
  const f=setup(t,{direct:true,bound:true,merged});selectCurrentCleanup(f);f.report();
  const entry=currentCloseoutEntries(f.common,f.org,events(f))[0],p=entry.panes[0];
  const target={tab_id:'w:t',occupant:['worker','codex',p.pane,p.workspace,entry.cwd,p.terminal,p.session],
    shell:(({pid,identity,command})=>({pid,identity,command}))(f.state.info.process_tree[0])};
  const intent=f.append([{type:'closeout.effect',identity:f.common,key:entry.key,source:entry.source,run:entry.run,item:entry.item,
    effect:'original-pre-fix-exit',producer:'native-closeout/v2',outcome:{action:'agent-exit-requested',run:entry.run,
      pane:p.pane,tab_id:target.tab_id,occupant:target.occupant,shell:target.shell}}])[0];
  const native_result={action:'skip-close',reason:'occupant or shell identity changed during agent exit'};
  f.append([nativeCloseoutWait(entry,intent.outcome,intent.effect),
    {type:'closeout.evaluated',identity:f.common,key:entry.key,source:entry.source,run:entry.run,item:entry.item,
      revision:entry.source.seq,completed:false,reason:'unresolved native exit/close intent retained; reconcile its original identity/outcome without replay',
      native_result,code:{code:{kind:'checkout',root:f.repo,common:f.common,commit:f.head,graph:'closer-imports/v1',
        files:'b52b10e3883eb09e2692c14e41ea771cb4604ce38363e3693d2cea88dc50bce5'},epoch:{branch:'main',tip:f.head}}},
    {type:'closeout.command-failed',identity:f.common,key:entry.key,source:entry.source,intent:intent.effect,
      native_result,failure:{kind:'unknown',code:'OUTCOME_UNKNOWN'}}]);
  if(vacant){f.state.workspaces=[];f.state.tabs=[];f.state.panes=[];f.state.agents=[];f.save();}
  f.turn=()=>runCloseoutTurn({project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},maxSteps:1,
    cli:(_file,args)=>args[0]==='drain'?JSON.stringify(f.drain({keys:JSON.parse(args[args.indexOf('--keys')+1]),
      retrySafe:true,sessionsOnly:args.includes('--sessions-only')})):'{}'});
  return Object.assign(f,{entry,intent});
}

test('line settles only the old absent allocation then removes its clean merged folder without replay',t=>{
  const f=fixture(t),original=events(f),wait=original.find(e=>e.type==='closeout.waiting');
  assert.equal(legacyExitIntent(f.entry,original).effect,f.intent.effect);
  assert.equal(f.turn().steps,1);
  const all=events(f),settlement=legacyExitSettlement(f.entry,f.intent,all);
  assert.ok(settlement);assert.equal(settlement.intent_seq,f.intent.seq);
  assert.equal(settlement.original_outcome,'UNKNOWN');assert.equal(settlement.disposition,'allocation-absent');
  assert.equal(unresolvedCloseoutEffect(f.entry,all),undefined);
  assert.equal(closeoutWaitState(wait,all),'complete');
  assert.equal(all.findLast(e=>e.type==='closeout.evaluated').resources.session.status,'absent');
  assert.ok(fs.existsSync(f.lane),'settlement grants no immediate Git effect');
  assert.equal(f.turn().steps,1);assert.equal(fs.existsSync(f.lane),false);
  assert.equal(f.git(['branch','--list','lane/topic']),'');
  assert.deepEqual(events(f).slice(0,original.length),original);
  assert.equal(effects(f).filter(e=>e.action==='agent-exit-requested').length,1);
  assert.equal(effects(f).some(e=>e.action==='exit-observed'),false);
  assert.deepEqual(f.read().actions,[]);
  assert.equal(f.turn().steps,0,'completed disposition does not repeat');
});

test('settled absence removes a clean unlanded folder and keeps its exact branch',t=>{
  const f=fixture(t,{merged:false});f.turn();f.turn();
  assert.equal(fs.existsSync(f.lane),false);
  assert.equal(f.git(['rev-parse','refs/heads/lane/topic']),f.head);
  assert.ok(effects(f).some(e=>e.action==='branch-kept'));
  assert.deepEqual(f.read().actions,[]);
});

for(const kind of ['finished-separate','active','reused-lane','reused-session'])test(`legacy original allocation with a ${kind} successor`,t=>{
  const f=fixture(t),meta={agent:'later',pane:'later:p',worker_workspace:'later',terminal_id:'later-term',agent_session_id:'later-session'};
  if(kind==='reused-session')meta.agent_session_id='session';
  f.append([{type:'run.started',id:'R-2',item:'ENG-1',workspace:kind==='reused-lane'?f.lane:f.lane+'-later',meta},
    ...(kind==='active'?[]:[{type:'report.ingested',run:'R-2',report:{outcome:'done'},sha256:'later'}])]);
  f.turn();f.turn();
  assert.equal(fs.existsSync(f.lane),kind!=='finished-separate');
  assert.deepEqual(f.read().actions,[]);
  if(kind!=='finished-separate')assert.equal(events(f).some(e=>e.type==='closeout.exit-settled'),false);
});

for(const kind of ['original-terminal','moved-terminal','lane-agent','moved-session','incomplete'])test(`legacy absence keeps ${kind} without sending native input`,t=>{
  const f=fixture(t,{vacant:kind!=='original-terminal'});
  if(kind==='moved-terminal'){
    f.state.workspaces=[{workspace_id:'elsewhere'}];f.state.panes=[{pane_id:'elsewhere:p',workspace_id:'elsewhere',terminal_id:'term'}];f.save();
  }
  if(['lane-agent','moved-session'].includes(kind)){
    f.state.agents=[{name:'other',pane_id:'other:p',terminal_id:'other-term',cwd:kind==='lane-agent'?f.lane:path.dirname(f.lane),
      agent_session:{value:kind==='moved-session'?'session':'other-session'}}];f.save();
  }
  if(kind==='incomplete'){
    const command=f.options.command;
    f.options.command=(exe,args,options)=>exe===f.job.herdr&&args[0]==='workspace'?
      {status:1,stdout:'',stderr:'inventory unavailable'}:command(exe,args,options);
  }
  const original=events(f);assert.equal(f.turn().steps,1);
  assert.equal(events(f).some(e=>e.type==='closeout.exit-settled'),false);
  assert.ok(unresolvedCloseoutEffect(f.entry,events(f)));assert.ok(fs.existsSync(f.lane));
  assert.deepEqual(events(f).slice(0,original.length),original);assert.deepEqual(f.read().actions,[]);
});

test('new or conflicting UNKNOWN evidence cannot select the legacy observation',t=>{
  const f=fixture(t),original=events(f);
  for(const kind of ['new-producer','wrong-source','wrong-session','refused','post-snapshot','other-diagnostic','unknown-failure']){
    const rows=structuredClone(original),intent=rows.find(e=>e.effect===f.intent.effect),evaluation=rows.find(e=>e.type==='closeout.evaluated'),failure=rows.find(e=>e.type==='closeout.command-failed');
    if(kind==='new-producer')evaluation.code.code.files='f'.repeat(64);
    if(kind==='wrong-source')intent.source.seq++;
    if(kind==='wrong-session')intent.outcome.occupant[6]='replacement';
    if(kind==='refused')failure.failure={kind:'fence',code:'NATIVE_REFUSAL'};
    if(kind==='post-snapshot')failure.native_result.exit_observation={pane:'replacement'};
    if(kind==='other-diagnostic')failure.native_result.reason='agent did not exit';
    if(kind==='unknown-failure')failure.failure.code='ETIMEDOUT';
    assert.equal(legacyExitIntent(f.entry,rows),undefined,kind);
  }
});

for(const kind of ['dirty','STOP','HOLD','head','claim','native-refusal'])test(`legacy settlement preserves the ${kind} guard`,t=>{
  const f=fixture(t);
  if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'unsaved'),'keep me');
  if(kind==='STOP'||kind==='HOLD')fs.mkdirSync(path.join(f.repo,'.lane/supervisor',kind),{recursive:true});
  if(kind==='head')f.git(['commit','--allow-empty','-m','changed allocation'],f.lane);
  if(kind==='claim')f.append([{type:'run.claimed',run:'R-1',owner:{controller:'brain',legacy:false}}]);
  if(kind==='native-refusal'){
    const command=f.options.command;
    f.options.command=(exe,args,options)=>exe===f.job.herdr?
      {status:1,stdout:'',stderr:JSON.stringify({error:{code:'NATIVE_REFUSAL',message:'native permission required'}})}:command(exe,args,options);
  }
  f.turn();f.turn();
  assert.equal(fs.existsSync(f.lane),true);assert.deepEqual(f.read().actions,[]);
  assert.equal(effects(f).some(e=>e.action==='worktree-removed'),false);
  if(kind==='dirty')assert.equal(fs.readFileSync(path.join(f.lane,'unsaved'),'utf8'),'keep me');
  else assert.equal(events(f).some(e=>e.type==='closeout.exit-settled'),false);
  if(kind==='native-refusal'){
    const calls=f.herdrCalls();f.turn();assert.deepEqual(f.herdrCalls(),calls,'refused observation stops permanently');
  }
});

test('settlement consumers reject unlinked or incomplete proof and retain the original UNKNOWN',t=>{
  const f=fixture(t),before=events(f),settlement=observeLegacyExitAbsence(f.entry,f.intent,before,
    {errors:[],nativeInventory:{complete:true,panes:[]},agents:[]},new Date().toISOString());
  assert.ok(settlement);
  for(const kind of ['unlinked','wrong-qualification','present-terminal','present-agent','incomplete']){
    const row={...structuredClone(settlement),seq:before.at(-1).seq+1};
    if(kind==='unlinked')row.intent='other';
    if(kind==='wrong-qualification')row.qualification.failure++;
    if(kind==='present-terminal')row.observation.panes.push({pane_id:'moved',terminal_id:'term'});
    if(kind==='present-agent')row.observation.agents.push({pane_id:'moved',terminal_id:'other',cwd:f.lane});
    if(kind==='incomplete')row.observation.complete=false;
    assert.equal(legacyExitSettlement(f.entry,f.intent,[...before,row]),undefined,kind);
    assert.ok(unresolvedCloseoutEffect(f.entry,[...before,row]),kind);
  }
  assert.deepEqual(f.read().actions,[]);
});
