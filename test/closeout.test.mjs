import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, hold } from './helpers/retire-fixture.mjs';
import { transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { readCloseoutEntries, closeoutRevision, scheduleLineCloseouts } from '../lib/closeout.mjs';
import { refreshCloseouts } from '../lib/closeout-consumer.mjs';
import { currentCloseoutEntries } from '../lib/closeout.mjs';
import { correctionSource } from '../lib/report-closeout.mjs';
import { events, setup, evaluations, effects, retainNativeOutcome, selectCurrentCleanup } from './helpers/closeout-fixture.mjs';

test('direct report all outcomes close the allocation and clean unlanded folder together with durable fixer evidence',t=>{
  for(const outcome of ['done','blocked','needs_human','failed']){
    const f=setup(t,{direct:true});
    f.append([{type:'report.ingested',run:'R-1',report:{outcome,summary:'Finished',artifacts:['failed-control.tap','unrun-controls.md']},sha256:'fixture'}]);
    const [entry]=currentCloseoutEntries(f.common,f.org,events(f));
    assert.equal(entry.reportCloseout,true);assert.equal(readCloseoutEntries(f.common).length,0,'no new per-lane queue file');
    const result=f.drain({keys:[entry.key],sessionsOnly:true});
    assert.equal(result.evaluated[0].completed,true,JSON.stringify(result));
    assert.equal(fs.existsSync(f.lane),false);assert.equal(f.read().tabs.length,0);
    assert.equal(f.git(['rev-parse','refs/heads/lane/topic']),f.head,'exact unlanded branch survives');
    const packet=effects(f).find(e=>e.action==='report-evidence');
    const saved=JSON.parse(fs.readFileSync(packet.packet));
    assert.equal(saved.head,f.head);assert.match(saved.diff,/changed/);assert.equal(saved.check.outcome,'unrun');
    assert.deepEqual(saved.proof_locations,['failed-control.tap','unrun-controls.md']);
    const state=fold(events(f));
    state.items.set('REV-1',{id:'REV-1',runs:['R-2'],meta:{review_source_run:'R-1',review_target:{base:saved.base,head:f.head,diff_sha256:'diff',evidence:packet.packet}}});
    state.runs.set('R-2',{id:'R-2',report:{file:'runs/R-2/report.md'}});
    const fix={id:'ENG-2',parent:'REV-1',runs:[],accept:['specific Major control'],meta:{review_fix_of:'ENG-1:'+f.head,review_source_run:'R-1'}};
    const finding={type:'review.finding-linked',correction_item:'ENG-2',review_run:'R-2',finding_key:'major-1',finding:{severity:'major',text:'path:1 - reproduce the failed saved-branch trigger'}};
    const source=correctionSource({item:fix,state,events:[...events(f),finding],repo:f.repo,org:f.org});
    assert.equal(source.base,f.head);assert.equal(source.ref,'refs/heads/lane/topic');
    assert.match(source.brief,/runs\/R-1\/report.md/);assert.match(source.brief,/runs\/R-2\/report.md/);assert.match(source.brief,/specific Major control/);
    assert.match(source.brief,/failed-control.tap/);
    const before=events(f).length;assert.deepEqual(f.drain({keys:[entry.key]}).evaluated,[]);assert.equal(events(f).length,before);
  }
});

test('direct report merged branch is deleted in the same pass with no landed twin or session midpoint',t=>{
  const f=setup(t,{direct:true,merged:true});const [report]=f.report();
  const [entry]=currentCloseoutEntries(f.common,f.org,events(f));
  assert.deepEqual(scheduleLineCloseouts([entry],events(f),{batch:true}).map(e=>e.sessionsOnly),[false]);
  const [closed]=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]);
  assert.equal(closed.closeout_targets,undefined);
  const result=f.drain({keys:[entry.key]});assert.equal(result.evaluated[0].disposition,'closed',JSON.stringify(result));
  assert.equal(fs.existsSync(f.lane),false);assert.equal(f.git(['branch','--list','lane/topic']),'');
  assert.ok(effects(f).some(e=>e.action==='branch-removed'));assert.equal(evaluations(f).filter(e=>e.sessions_retired).length,0);
  assert.equal(report.closeout_targets[0].reportCloseout,true);
});

test('direct report dirty and untracked work closes the finished session but keeps the folder and fixer refuses to branch around it',t=>{
  for(const name of ['seed','untracked']){
    const f=setup(t,{direct:true});f.report();fs.writeFileSync(path.join(f.lane,name),'unsaved work');
    const [entry]=currentCloseoutEntries(f.common,f.org,events(f));const result=f.drain({keys:[entry.key]});
    assert.equal(result.evaluated[0].disposition,'kept',JSON.stringify(result));assert.match(result.evaluated[0].reason,/not clean/);
    assert.equal(f.read().tabs.length,0);assert.equal(fs.readFileSync(path.join(f.lane,name),'utf8'),'unsaved work');
    const state=fold(events(f));state.items.set('REV-1',{id:'REV-1',runs:[],meta:{review_source_run:'R-1',review_target:{head:f.head}}});
    assert.throws(()=>correctionSource({item:{id:'ENG-2',parent:'REV-1',runs:[],meta:{review_fix_of:'fix',review_source_run:'R-1'}},state,events:events(f),repo:f.repo,org:f.org}),/unsaved author work/);
  }
});

test('direct report protects working other-run and HOLD allocations and deduplicates unchanged kept outcomes',t=>{
  for(const kind of ['working','other-run','HOLD']){
    const f=setup(t,{direct:true,merged:true});f.report();
    if(kind==='working'){f.state.agents[0].agent_status='working';f.save();}
    if(kind==='other-run')f.append([{type:'run.started',id:'R-2',item:'ENG-1',workspace:f.lane,meta:{...events(f).find(e=>e.type==='run.started').meta}}]);
    if(kind==='HOLD')hold(f);
    const [entry]=currentCloseoutEntries(f.common,f.org,events(f));const first=f.drain({keys:[entry.key]});
    assert.equal(first.evaluated[0].disposition,'kept',JSON.stringify(first));assert.equal(fs.existsSync(f.lane),true);assert.equal(f.read().actions.length,0);
    const count=events(f).filter(e=>e.type==='closeout.evaluated').length;
    f.drain({keys:[entry.key]});assert.equal(events(f).filter(e=>e.type==='closeout.evaluated').length,count);
    if(kind==='working'){
      const live=f.read();live.agents[0].agent_status='idle';fs.writeFileSync(f.file,JSON.stringify(live));
      const next=f.drain({keys:[entry.key]});assert.equal(next.evaluated[0].completed,true,JSON.stringify(next));assert.equal(fs.existsSync(f.lane),false);
    }
  }
});

test('direct report backlog derives already-ingested unlanded allocations and does not treat old shared-session reports as active',t=>{
  const f=setup(t);selectCurrentCleanup(f);
  const meta=events(f).find(e=>e.type==='run.started').meta;
  transact(f.org,()=>({add:[{type:'report.ingested',run:'R-1',report:{outcome:'failed'},sha256:'old'},
    {type:'run.started',id:'R-2',item:'ENG-1',workspace:f.lane,meta:{...meta}},
    {type:'report.ingested',run:'R-2',report:{outcome:'blocked'},sha256:'new'}]}));
  const refresh=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
  const entry=currentCloseoutEntries(f.common,f.org,events(f)).find(e=>e.reportCloseout);
  assert.ok(entry,JSON.stringify(refresh));assert.equal(entry.run,'R-2');assert.equal(readCloseoutEntries(f.common).length,0);
  assert.equal(entry.allocation.run,'R-2');assert.equal(entry.allocation.report_sha256,'new');
  assert.deepEqual(entry.panes.map(p=>p.run),['R-2'],'the newest run owns the shared native session');
  const result=f.drain({keys:[entry.key]});assert.equal(result.evaluated[0].completed,true,JSON.stringify(result));
  assert.equal(fs.existsSync(f.lane),false);assert.equal(f.git(['rev-parse','refs/heads/lane/topic']),f.head);
});

test('producer linked ordinary native exit and close publish exact completion links and passive stage timings',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=rows[0].closeout_targets.find(t=>t.signal==='landed');
  const result=f.drain({keys:[entry.key]});assert.equal(result.evaluated[0].completed,true,JSON.stringify(result));
  const all=events(f),statuses=all.filter(e=>e.type==='closeout.producer-status'&&e.key===entry.key);
  assert.ok(statuses.some(e=>e.producer.action==='agent-exit-requested'&&e.status==='complete'));
  assert.ok(statuses.some(e=>e.producer.action==='shell-close-requested'&&e.status==='complete'));
  for(const status of statuses)assert.ok(all.some(e=>e.seq===status.completion.seq&&e.type===status.completion.type));
  assert.ok(result.evaluated[0].stages.apply_ms>=0);assert.ok(result.evaluated[0].stages.remove_lane_ms>=0);
  const before=f.read().actions.length;assert.deepEqual(f.drain({keys:[entry.key]}).evaluated,[]);assert.equal(f.read().actions.length,before);
});

test('producer linked unresolved native waits do not replay or reobserve after manual retry or elapsed time',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=rows[0].closeout_targets.find(t=>t.signal==='landed');
  f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:'R-1',item:'ENG-1',source:{seq:rows[0].seq,type:'item.closed'},effect:'original-intent',outcome:{action:'agent-exit-requested',run:'R-1',pane:'w:p',tab_id:'w:t',occupant:['worker','codex','w:p','w',f.lane,'term','session'],shell:{pid:1,identity:'shell',command:'[zsh]'}}}]);
  const first=f.drain({keys:[entry.key]});assert.equal(first.evaluated[0].completed,false);
  const calls=f.herdrCalls().length;f.append([{type:'closeout.retry',identity:f.common,keys:[entry.key],why:'old manual retry cannot resolve a missing runtime producer'}]);
  assert.deepEqual(f.drain({keys:[entry.key],retrySafe:true}).evaluated,[]);assert.equal(f.herdrCalls().length,calls);assert.deepEqual(f.read().actions,[]);
  const wait=events(f).findLast(e=>e.type==='closeout.waiting'&&e.key===entry.key&&e.revision!==undefined);assert.match(wait.waiting.defect,/no existing runtime transport/);
});

test('cleanup tail publishes every final report and abandonment without closing the item',t=>{
  for(const outcome of ['done','blocked','needs_human','failed','abandoned']){
    const f=setup(t,{merged:true});
    const add=outcome==='abandoned'?[{type:'run.abandoned',id:'R-1'}]:[{type:'report.ingested',run:'R-1',report:{outcome,summary:'Allocation finished'},sha256:'fixture'}];
    const rows=f.append(add),entry=readCloseoutEntries(f.common).find(e=>e.run==='R-1');
    assert.ok(entry,`${outcome} must publish an evaluation request`);assert.equal(entry.signal,'ready');
    assert.equal(fold(events(f)).items.get('ENG-1').closed,null);assert.equal(rows[0].closeout_targets[0].run,'R-1');
  }
});

function historicalTail(t,{kind='eligible'}={}){
  const f=setup(t,{merged:true}),raw=events(f);
  const meta=raw.find(e=>e.type==='run.started').meta;
  if(kind==='unknown')delete meta.agent_session_id;
  fs.writeFileSync(f.eventFile,raw.map(e=>JSON.stringify(e)+'\n').join(''));
  transact(f.org,()=>({add:[{type:'report.ingested',run:'R-1',report:{outcome:'blocked',summary:'old final allocation'},sha256:'old'}]}));
  if(kind==='refused'){
    // Historical refusal is an effect fact; report prose grants no authority.
    const report=events(f).find(e=>e.type==='report.ingested');
    f.append([{type:'closeout.command-failed',identity:f.common,run:'R-1',key:'original-refused-exit',
      source:{seq:report.seq,type:report.type},effect:'original-refused-exit',reason:'operation not permitted',
      failure:{kind:'fence',code:'EPERM'}}]);
  }
  if(kind==='working'){f.state.agents[0].agent_status='working';f.save();}
  if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'unique-uncommitted'),'retain');
  if(kind==='unlanded')f.git(['reset','--hard',`${f.head}^`]);
  if(kind==='reused')transact(f.org,()=>({add:[{type:'run.started',id:'R-2',item:'ENG-1',workspace:f.lane,meta:{...meta}}]}));
  if(kind==='foreign'){f.state.workspaces[0].worktree.repo_key='/foreign/common';f.save();}
  selectCurrentCleanup(f);
  if(kind==='uncertain'){
    const source=f.append([{type:'lane.ready',common:f.common,run:'R-1'}])[0],entry=readCloseoutEntries(f.common)[0],c=f.retirement(f.options).plan(f.lane).close[0];
    f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:'R-1',item:'ENG-1',source:{seq:source.seq,type:source.type},effect:'retained-original',outcome:{action:'agent-exit-requested',run:c.run,pane:c.pane,tab_id:c.tab_id,occupant:c.occupant,shell:c.shell}}]);
  }
  return f;
}

test('cleanup tail creates a direct verified historical report binding under the paired current policy',async t=>{
  const f=historicalTail(t),{refreshCloseouts}=await import('../lib/closeout-consumer.mjs');
  selectCurrentCleanup(f);const before=fs.readFileSync(f.eventFile),result=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
  assert.equal(result.created.length,1,JSON.stringify(result));const entry=currentCloseoutEntries(f.common,f.org,events(f)).find(e=>e.key===result.created[0]);
  assert.equal(entry.source.type,'cleanup.bound');assert.equal(entry.signal,'ready');assert.equal(entry.reportCloseout,true);assert.equal(entry.panes[0].session,'session');
  assert.deepEqual(readCloseoutEntries(f.common),[],'historical reports use record targets, with no new queue file');
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before,'original launch and report history stay immutable');
  assert.equal(refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options}).created.length,0,'binding is resource-deduplicated');
  const next=f.drain({keys:[entry.key],sessionsOnly:true});assert.equal(next.evaluated[0]?.completed,true,JSON.stringify(next));
  assert.equal(next.evaluated[0].disposition,'closed');assert.equal(fs.existsSync(f.lane),false);assert.equal(f.read().tabs.length,0);
  assert.deepEqual(f.drain({keys:[entry.key],retrySafe:true}).evaluated,[],'same-pass completion is not replayed');
});

test('cleanup tail explicit abandonment permits only a guarded content-released allocation',t=>{
  const f=setup(t,{merged:true});f.append([{type:'run.abandoned',id:'R-1'}]);const entry=readCloseoutEntries(f.common)[0];
  assert.ok(entry);const result=f.drain({keys:[entry.key],sessionsOnly:true});
  assert.equal(result.evaluated[0]?.sessions_retired,true,JSON.stringify(result));assert.equal(fs.existsSync(f.lane),true);
  assert.equal(fold(events(f)).items.get('ENG-1').closed,null);
});

test('cleanup tail historical discovery keeps unsafe scopes and binds reported dirty and unlanded allocations',async t=>{
  const {refreshCloseouts}=await import('../lib/closeout-consumer.mjs');
  for(const kind of ['working','reused','foreign','unknown','refused','uncertain']){
    const f=historicalTail(t,{kind}),bytes=fs.readFileSync(f.eventFile),result=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
    assert.deepEqual(result.created,[],`${kind}: ${JSON.stringify(result)}`);
    assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,bytes.length),bytes,'original evidence stays immutable');
    const kept=events(f).filter(e=>e.type==='closeout.kept');assert.equal(kept.length,1,kind);assert.equal(kept[0].run,'R-1');assert.equal(kept[0].cwd,f.lane);
    const recorded=fs.readFileSync(f.eventFile);refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
    assert.deepEqual(fs.readFileSync(f.eventFile),recorded,'the kept outcome is deduplicated');assert.deepEqual(f.read().actions,[]);
  }
  for(const kind of ['dirty','unlanded']){
    const f=historicalTail(t,{kind}),result=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
    assert.equal(result.created.length,1,`${kind}: ${JSON.stringify(result)}`);
    const entry=currentCloseoutEntries(f.common,f.org,events(f)).find(e=>e.key===result.created[0]);assert.equal(entry.reportCloseout,true);
    const drained=f.drain({keys:[entry.key]});assert.equal(f.read().tabs.length,0,'finished sessions close in the same pass');
    if(kind==='dirty'){
      assert.equal(drained.evaluated[0].disposition,'kept');assert.match(drained.evaluated[0].reason,/not clean/);
      assert.equal(fs.readFileSync(path.join(f.lane,'unique-uncommitted'),'utf8'),'retain');
    }else{
      assert.equal(drained.evaluated[0].completed,true,JSON.stringify(drained));assert.equal(fs.existsSync(f.lane),false);
      assert.equal(f.git(['rev-parse','refs/heads/lane/topic']),f.head,'clean unlanded source stays on its exact branch');
    }
  }
});

test('cleanup refresh binds an abandoned kept lane once',t=>{
  const f=setup(t,{merged:true});transact(f.org,()=>({add:[{type:'run.abandoned',id:'R-1'}]}));
  fs.writeFileSync(path.join(f.lane,'unique-uncommitted'),'retain');selectCurrentCleanup(f);
  const lane=fs.realpathSync(f.lane),refresh=()=>refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
  const bound=()=>events(f).filter(e=>e.type==='cleanup.bound'&&e.run==='R-1'&&e.closeout_targets.some(t=>t.cwd===lane));
  const first=refresh();assert.equal(first.created.length,1,JSON.stringify(first));
  const entry=readCloseoutEntries(f.common).find(e=>e.key===first.created[0]),revision=closeoutRevision(entry,events(f));
  for(let pass=0;pass<3;pass++){
    const again=refresh();assert.deepEqual(again.created,[],`pass ${pass}: ${JSON.stringify(again)}`);
    assert.equal(bound().length,1,`pass ${pass}`);assert.equal(closeoutRevision(entry,events(f)),revision,`pass ${pass}`);
  }
  const evaluations=()=>events(f).filter(e=>e.type==='closeout.evaluated'&&e.key===entry.key);
  for(let pass=0;pass<3;pass++){f.drain({keys:[entry.key]});refresh();}
  assert.equal(bound().length,1);assert.ok(evaluations().filter(e=>e.disposition==='kept').length<=1,JSON.stringify(evaluations()));
  assert.ok(events(f).filter(e=>e.type==='closeout.kept'&&e.run==='R-1').length<=1);
  assert.equal(fs.readFileSync(path.join(f.lane,'unique-uncommitted'),'utf8'),'retain','dirty abandoned content stays');
  const g=setup(t,{merged:true});selectCurrentCleanup(g);
  transact(g.org,()=>({add:[{type:'report.ingested',run:'R-1',report:{outcome:'blocked'},sha256:'reported'}]}));
  for(let pass=0;pass<3;pass++)assert.equal(refreshCloseouts({cwd:g.repo,org:g.org,env:g.env,retirementOptions:g.options}).created.length,pass?0:1,`reported pass ${pass}`);
  const direct=events(g).filter(e=>e.type==='cleanup.bound');assert.equal(direct.length,1);assert.equal(direct[0].closeout_targets[0].reportCloseout,true,'a reported lane takes the direct path once');
  assert.equal(currentCloseoutEntries(g.common,g.org,events(g)).filter(e=>e.reportCloseout&&e.run==='R-1').length,1);
});

test('cleanup tail direct binding preserves an exact active settle reference as an executor fence',async t=>{
  const f=historicalTail(t),{refreshCloseouts}=await import('../lib/closeout-consumer.mjs');
  const directory=path.join(f.org,'settle');fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'R-1.json'),JSON.stringify({common:f.common,run:'R-1',workspace:f.lane,stage:'reviewing'}));
  const created=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});assert.equal(created.created.length,1,JSON.stringify(created));
  const entry=currentCloseoutEntries(f.common,f.org,events(f)).find(e=>e.key===created.created[0]),source=events(f).find(e=>e.seq===entry.source.seq);
  const original=JSON.stringify(source);assert.equal(entry.reportCloseout,true);assert.deepEqual(readCloseoutEntries(f.common),[]);
  const result=f.drain({keys:[entry.key],sessionsOnly:true});assert.match(result.evaluated[0]?.reason??'',/settle callback reference/);
  assert.equal(fs.existsSync(f.lane),true);assert.equal(JSON.stringify(events(f).find(e=>e.seq===entry.source.seq)),original,'the bound record target is immutable');
  assert.equal(f.read().actions.length,0);
});

test('cleanup tail physical CAS tolerates unrelated completed settle receipt activity',t=>{
  const f=setup(t,{merged:true});f.report();f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]);const entry=readCloseoutEntries(f.common).find(e=>e.signal==='landed');
  assert.equal(f.drain({keys:[entry.key],sessionsOnly:true}).evaluated[0]?.sessions_retired,true);
  const dir=path.join(f.org,'settle');fs.mkdirSync(dir,{recursive:true});const command=f.options.command;let observed=0;
  f.options.command=(exe,args,options)=>{if(exe===f.job.herdr)fs.writeFileSync(path.join(dir,'R-9999.json'),JSON.stringify({common:f.common,run:'R-9999',workspace:path.join(f.scratch,'other'),stage:'complete',observed:++observed}));return command(exe,args,options);};
  const result=f.drain({keys:[entry.key],retrySafe:true});assert.equal(result.evaluated[0]?.completed,true,JSON.stringify(result));assert.equal(fs.existsSync(f.lane),false);assert.ok(observed>1);
});

test('cleanup tail retains an unresolved original intent despite allocation absence without native readback',t=>{
  const f=setup(t,{merged:true});f.report();f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]);const entry=readCloseoutEntries(f.common).find(e=>e.signal==='landed');
  const c=f.retirement(f.options).plan(f.lane).close[0];
  f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:entry.run,item:entry.item,source:entry.source,effect:'original-lost-reply',outcome:{action:'agent-exit-requested',run:c.run,pane:c.pane,tab_id:c.tab_id,occupant:c.occupant,shell:c.shell}}]);
  f.state.agents=[];f.state.panes=[];f.state.tabs=[];f.save();const retained=retainNativeOutcome(f,entry);
  const first=f.drain({keys:[entry.key],retrySafe:true});assert.equal(first.evaluated[0].completed,false);assert.match(first.evaluated[0].reason,/unresolved native/);retained();
  assert.equal(effects(f).some(e=>['allocation-absent','exit-observed','closed','session-released','lane-removed'].includes(e.action)),false);
  assert.deepEqual(f.drain({keys:[entry.key],retrySafe:true}).evaluated,[]);retained();
});

test('cleanup tail absence readback keeps moved replaced refused and unpreserved original scopes',t=>{
  for(const kind of ['moved','replaced','refused','unpreserved']){
    const f=setup(t,{merged:true});f.report();f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]);const entry=readCloseoutEntries(f.common).find(e=>e.signal==='landed'),c=f.retirement(f.options).plan(f.lane).close[0];
    f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:entry.run,item:entry.item,source:entry.source,effect:'original-intent',outcome:{action:'agent-exit-requested',run:c.run,pane:c.pane,tab_id:c.tab_id,occupant:c.occupant,shell:c.shell}}]);
    if(kind==='moved'){f.state.agents[0].pane_id='moved:p';f.state.panes=[];f.state.tabs=[];}
    if(kind==='replaced'){f.state.agents=[];f.state.panes[0].terminal_id='replacement';}
    if(kind==='refused')f.append([{type:'closeout.evaluated',key:entry.key,identity:f.common,run:entry.run,item:entry.item,source:entry.source,revision:closeoutRevision(entry,events(f)),completed:false,reason:'EPERM native refusal; retain original'}]);
    if(kind==='unpreserved'){f.state.agents=[];f.state.panes=[];f.state.tabs=[];f.git(['worktree','remove',f.lane]);}
    f.save();const bytes=fs.readFileSync(path.join(f.common,'closeout/entries',entry.key+'.json')),before=f.read().actions.length;
    f.drain({keys:[entry.key],retrySafe:true});assert.equal(effects(f).some(e=>e.action==='allocation-absent'),false,kind);assert.equal(f.read().actions.length,before,kind);
    assert.deepEqual(fs.readFileSync(path.join(f.common,'closeout/entries',entry.key+'.json')),bytes);
  }
});

test('cleanup tail fair serial batches continue independent targets and put attempted failures last',()=>{
  const sessions=Array.from({length:5},(_,n)=>({key:`s${n}`,signal:'ready',source:{seq:n+1},panes:[{pane:`p${n}`}]})),physical={key:'landed',signal:'landed',source:{seq:10},panes:[]},bookkeeping={key:'book',signal:'ready',source:{seq:11},panes:[]};
  const result=scheduleLineCloseouts([...sessions,bookkeeping,physical],[],{batch:true,attempts:{s0:2,s1:1}});
  assert.equal(result.length,7);assert.ok(result.findIndex(x=>x.entry.key==='s0')>result.findIndex(x=>x.entry.key==='s1'));
  assert.ok(result.findIndex(x=>x.entry.key==='landed')<result.findIndex(x=>x.entry.key==='book'));
  assert.equal(new Set(result.map(x=>x.entry.key)).size,7);
});
