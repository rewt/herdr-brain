import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup,events,effects,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {currentCloseoutEntries,unresolvedCloseoutEffect} from '../lib/closeout.mjs';
import {legacyExitSettlement,legacyShellClose} from '../lib/closeout-legacy-exits.mjs';
import {nativeCloseoutWait,closeoutWaitState} from '../lib/closeout-status.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {gitProject} from '../lib/project.mjs';
import {initialShellFile} from '../lib/initial-shell.mjs';

function fixture(t,{merged=true}={}) {
  const f=setup(t,{direct:true,bound:true,merged});selectCurrentCleanup(f);f.report();
  const entry=currentCloseoutEntries(f.common,f.org,events(f))[0],p=entry.panes[0];
  const shell=(({pid,identity,command})=>({pid,identity,command}))(f.state.info.process_tree[0]);
  const intent=f.append([{type:'closeout.effect',identity:f.common,key:entry.key,source:entry.source,run:entry.run,item:entry.item,
    effect:'original-pre-fix-exit',producer:'native-closeout/v2',outcome:{action:'agent-exit-requested',run:entry.run,
      pane:p.pane,tab_id:'w:t',occupant:['worker','codex',p.pane,p.workspace,entry.cwd,p.terminal,p.session],shell}}])[0];
  const native_result={action:'skip-close',reason:'occupant or shell identity changed during agent exit'};
  f.append([nativeCloseoutWait(entry,intent.outcome,intent.effect),
    {type:'closeout.evaluated',identity:f.common,key:entry.key,source:entry.source,run:entry.run,item:entry.item,
      revision:entry.source.seq,completed:false,reason:'unresolved native exit/close intent retained; reconcile its original identity/outcome without replay',
      native_result,code:{code:{kind:'checkout',root:f.repo,common:f.common,commit:f.head,graph:'closer-imports/v1',
        files:'b52b10e3883eb09e2692c14e41ea771cb4604ce38363e3693d2cea88dc50bce5'},epoch:{branch:'main',tip:f.head}}},
    {type:'closeout.command-failed',identity:f.common,key:entry.key,source:entry.source,intent:intent.effect,
      native_result,failure:{kind:'unknown',code:'OUTCOME_UNKNOWN'}}]);
  f.state.agents=[];
  Object.assign(f.state.panes[0],{foreground_cwd:f.lane});
  f.state.info.foreground_processes=[{pid:shell.pid,name:'zsh'}];
  f.state.info.process_tree=[{...shell,command:'-zsh',state:'S'}];f.save();
  f.turn=()=>runCloseoutTurn({project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},maxSteps:1,
    cli:(_file,args)=>args[0]==='drain'?JSON.stringify(f.drain({keys:JSON.parse(args[args.indexOf('--keys')+1]),
      retrySafe:true,sessionsOnly:args.includes('--sessions-only')})):'{}'});
  return Object.assign(f,{entry,intent});
}

for(const merged of [true,false])test(`line closes the exact inert original shell; merged=${merged}`,t=>{
  const f=fixture(t,{merged}),original=events(f),wait=original.find(e=>e.type==='closeout.waiting');
  assert.equal(f.turn().steps,1);
  const all=events(f),close=legacyShellClose(f.entry,f.intent,all),settlement=legacyExitSettlement(f.entry,f.intent,all);
  assert.ok(close);assert.ok(settlement);
  assert.equal(close.outcome.legacy_exit.intent_seq,f.intent.seq);
  assert.equal(settlement.schema,'legacy-exit-settlement/v2');
  assert.equal(settlement.close_intent,close.effect);assert.equal(settlement.original_outcome,'UNKNOWN');
  assert.equal(all.find(e=>e.seq===settlement.close_receipt).intent,close.effect);
  assert.ok(all.some(e=>e.outcome?.action==='legacy-shell-verified'&&e.intent===close.effect));
  assert.equal(closeoutWaitState(wait,all),'complete');assert.equal(unresolvedCloseoutEffect(f.entry,all),undefined);
  assert.deepEqual(all.slice(0,original.length),original);
  assert.equal(effects(f).filter(e=>e.action==='agent-exit-requested').length,1);
  assert.equal(effects(f).some(e=>e.action==='exit-observed'),false);
  assert.deepEqual(f.read().actions,[['tab','close','w:t']]);assert.ok(fs.existsSync(f.lane));
  f.turn();assert.equal(fs.existsSync(f.lane),false);
  assert.equal(f.git(['branch','--list','lane/topic']),merged?'':'lane/topic');
  if(!merged)assert.equal(f.git(['rev-parse','lane/topic']),f.head);
});

for(const kind of ['agent','moved-session','child','zombie','foreground','shell-birth','terminal','moved-terminal','dirty','staged','untracked','skip-worktree','assume-unchanged',
  'focus','reference','STOP','HOLD','claim','head','incomplete'])test(`inert close keeps ${kind}`,t=>{
  const f=fixture(t),s=f.state;
  if(['agent','moved-session'].includes(kind))s.agents=[{name:'other',agent:'codex',pane_id:kind==='agent'?'w:p':'else:p',
    tab_id:kind==='agent'?'w:t':'else:t',workspace_id:'w',terminal_id:kind==='agent'?'term':'other',cwd:kind==='agent'?f.lane:f.repo,
    agent_session:{value:kind==='agent'?'other':'session'},agent_status:'idle'}];
  if(['child','zombie'].includes(kind))s.info.process_tree.push({pid:3,ppid:1,identity:'child',state:kind==='zombie'?'Z':'S',command:'[node]'});
  if(kind==='foreground')s.info.foreground_processes=[{pid:9,name:'node'}];
  if(kind==='shell-birth')s.info.process_tree[0].identity='replacement';
  if(kind==='terminal')s.panes[0].terminal_id='replacement';
  if(kind==='moved-terminal'){s.workspaces.push({workspace_id:'other'});s.panes.push({pane_id:'other:p',tab_id:'other:t',workspace_id:'other',terminal_id:'term'});}
  if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'seed'),'unsaved');
  if(kind==='staged'){fs.writeFileSync(path.join(f.lane,'seed'),'staged');f.git(['add','seed'],f.lane);}
  if(kind==='untracked')fs.writeFileSync(path.join(f.lane,'unsaved'),'unsaved');
  if(['skip-worktree','assume-unchanged'].includes(kind)){
    f.git(['update-index','--'+kind,'seed'],f.lane);fs.writeFileSync(path.join(f.lane,'seed'),'hidden unsaved work');
  }
  if(kind==='focus')s.panes[0].focused=true;
  if(kind==='reference')fs.writeFileSync(path.join(f.org,'references/live.json'),JSON.stringify({schema:'herdr-reference/v1',
    kind:'owner',state:'running',owner:'owner',job:'job',item:'ENG-1',cwd:f.lane,
    created_at:new Date().toISOString(),expires_at:new Date(Date.now()+600000).toISOString()}));
  if(['STOP','HOLD'].includes(kind))fs.mkdirSync(path.join(f.repo,'.lane/supervisor',kind),{recursive:true});
  if(kind==='claim')f.append([{type:'run.claimed',run:'R-1',owner:{controller:'brain',legacy:false}}]);
  if(kind==='head')f.git(['commit','--allow-empty','-m','changed'],f.lane);
  f.save();
  if(kind==='incomplete'){
    const command=f.options.command;
    f.options.command=(exe,args,options)=>exe===f.job.herdr&&args[0]==='workspace'?
      {status:1,stdout:'',stderr:'incomplete inventory'}:command(exe,args,options);
  }
  const original=events(f);f.turn();
  assert.deepEqual(f.read().actions,[]);assert.ok(fs.existsSync(f.lane));
  assert.equal(events(f).some(e=>e.type==='closeout.exit-settled'),false);
  assert.equal(legacyShellClose(f.entry,f.intent,events(f)),undefined);
  assert.deepEqual(events(f).slice(0,original.length),original);
});

test('a claimed initial-shell receipt accepts the same shell birth changing kernel/login spelling',t=>{
  const f=fixture(t),file=initialShellFile(f.common,'w:t');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({schema:'initial-shell/v1',common:f.common,cwd:f.lane,workspace:'w',tab:'w:t',
    pane:'w:p',terminal:'term',shell:f.intent.outcome.shell,claimed:true}));
  f.turn();assert.ok(legacyExitSettlement(f.entry,f.intent,events(f)));assert.deepEqual(f.read().actions,[['tab','close','w:t']]);
});

for(const kind of ['child','dirty','terminal'])test(`fresh proof stops ${kind} introduced after close intent`,t=>{
  const f=fixture(t),log=f.options.log;
  f.options.log=row=>{
    log(row);
    if(row.action==='shell-close-requested'){
      if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'unsaved'),'keep');
      else {const s=f.read();if(kind==='child')s.info.process_tree.push({pid:9,ppid:1,identity:'child',state:'S',command:'node'});
        else s.panes[0].terminal_id='replacement';fs.writeFileSync(f.file,JSON.stringify(s));}
    }
  };
  f.turn();assert.ok(legacyShellClose(f.entry,f.intent,events(f)));
  assert.deepEqual(f.read().actions,[]);assert.equal(events(f).some(e=>e.type==='closeout.exit-settled'),false);
  const calls=f.herdrCalls();f.turn();assert.deepEqual(f.herdrCalls(),calls,'new uncertain close is never replayed or reobserved');
});

for(const kind of ['unknown','refused'])test(`a new ${kind} close remains held without another invocation`,t=>{
  const f=fixture(t),command=f.options.command;
  f.options.command=(exe,args,options)=>exe===f.job.herdr&&args[0]==='tab'&&args[1]==='close'?
    {status:1,stdout:'',stderr:kind==='refused'?JSON.stringify({error:{code:'NATIVE_REFUSAL',message:'native permission required'}}):'lost close reply'}:
    command(exe,args,options);
  f.turn();assert.ok(legacyShellClose(f.entry,f.intent,events(f)));assert.ok(unresolvedCloseoutEffect(f.entry,events(f)));
  assert.equal(events(f).some(e=>e.type==='closeout.exit-settled'),false);assert.ok(fs.existsSync(f.lane));
  const calls=f.herdrCalls();f.turn();assert.deepEqual(f.herdrCalls(),calls);
});

test('new settlement consumers require linked close, boundary proof, completion and vacancy',t=>{
  const f=fixture(t);f.turn();const all=events(f),settlement=legacyExitSettlement(f.entry,f.intent,all);assert.ok(settlement);
  for(const kind of ['missing-close','missing-verification','missing-completion','wrong-link','wrong-birth','dirty-proof','index-proof','stale-vacancy','present-terminal']){
    let rows=structuredClone(all),row=rows.find(e=>e.type==='closeout.exit-settled');
    if(kind==='missing-close')rows=rows.filter(e=>e.effect!==row.close_intent);
    if(kind==='missing-verification')rows=rows.filter(e=>e.outcome?.action!=='legacy-shell-verified');
    if(kind==='missing-completion')rows=rows.filter(e=>e.seq!==row.close_receipt);
    if(kind==='wrong-link')row.close_intent='other';
    if(kind==='wrong-birth')rows.find(e=>e.outcome?.action==='legacy-shell-verified').outcome.legacy_exit.pane.process_info.process_tree_raw[0].identity='replacement';
    if(kind==='dirty-proof')rows.find(e=>e.outcome?.action==='legacy-shell-verified').outcome.legacy_exit.git.clean=false;
    if(kind==='index-proof')rows.find(e=>e.outcome?.action==='legacy-shell-verified').outcome.legacy_exit.index_flags_clear=false;
    if(kind==='stale-vacancy')row.observation.at=f.intent.at;
    if(kind==='present-terminal')row.observation.panes.push({pane_id:'moved',terminal_id:'term'});
    assert.equal(legacyExitSettlement(f.entry,f.intent,rows),undefined,kind);
    assert.ok(unresolvedCloseoutEffect(f.entry,rows),kind);
  }
});
