import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {copyProduct} from '../lib/product-files.mjs';
import {setup,events,effects,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {refreshCloseouts} from '../lib/closeout-consumer.mjs';
import {currentCloseoutEntries,unresolvedCloseoutEffect} from '../lib/closeout.mjs';
import {reconcileCloseoutBacklog} from '../lib/closeout-backlog.mjs';
import {settleVacantCloseouts} from '../lib/closeout-vacancy.mjs';
import {gitProject} from '../lib/project.mjs';
import {fold} from '../lib/state.mjs';
import {runCloseoutTurn,CLOSEOUT_TURN_BUDGET_MS} from '../line-service/closeout-turn.mjs';

function partial(t,{merged=true,absent=false,abandoned=false,envelope=true,binding='dispatch'}={}){
  const f=setup(t,{occupied:false,direct:true,merged});selectCurrentCleanup(f);
  const old=events(f);old.find(e=>e.type==='run.started').meta={lane:'topic',agent_session_id:'session',...(binding==='dispatch'?{dispatch_project:f.common}:{})};
  fs.writeFileSync(f.eventFile,old.map(e=>JSON.stringify(e)+'\n').join(''));
  if(binding==='claim')f.append([{type:'run.claimed',run:'R-1',project:f.common,record:f.org,owner:{controller:'brain',legacy:true}}]);
  if(absent){f.git(['worktree','remove',f.lane]);if(merged)f.git(['branch','-d','lane/topic']);f.state.workspaces=[];f.save();}
  const [source]=f.append([abandoned?{type:'run.abandoned',id:'R-1'}:{type:'report.ingested',run:'R-1',sha256:'fixture',report:{outcome:'done'}}]);
  if(!envelope){const rows=events(f);delete rows.find(e=>e.seq===source.seq).closeout_targets;
    fs.writeFileSync(f.eventFile,rows.map(e=>JSON.stringify(e)+'\n').join(''));}
  f.refresh=()=>refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
  return f;
}

for(const abandoned of [false,true])test(`BCH missing envelope with absent native folder and branch settles ${abandoned?'abandonment':'report'} without effects`,t=>{
  const f=partial(t,{absent:true,abandoned,envelope:false}),before=fs.readFileSync(f.eventFile),actions=f.read().actions;
  const result=f.refresh();assert.deepEqual(result.settled,['R-1']);
  const receipt=events(f).find(e=>e.type==='closeout.vacancy-settled');assert.ok(receipt);
  assert.equal(receipt.resources.folder.status,'absent');assert.equal(receipt.resources.folder.preservation,'UNKNOWN');
  assert.equal(receipt.resources.session.completion,'UNKNOWN');assert.equal(receipt.native_completion,false);
  assert.equal(receipt.resources.branch.status,'absent');
  assert.ok(events(f).some(e=>e.type==='closeout.binding-settled'));
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
  assert.deepEqual(effects(f),[]);assert.deepEqual(f.read().actions,actions);
  const calls=f.herdrCalls();assert.deepEqual(f.refresh().settled,[]);assert.deepEqual(f.herdrCalls(),calls);
});

test('BCH old bound missing-folder hold settles current vacancy while keeping historical preservation unknown',t=>{
  const f=setup(t,{occupied:false,direct:true,merged:true});selectCurrentCleanup(f);const [source]=f.report(),target=source.closeout_targets[0];
  f.append([{type:'closeout.evaluated',identity:f.common,key:target.key,source:{seq:source.seq,type:source.type},run:'R-1',item:'ENG-1',
    revision:source.seq,completed:false,reason:'queued worktree absent without a preservation proof; keep'}]);
  f.git(['worktree','remove',f.lane]);f.git(['branch','-d','lane/topic']);f.state.workspaces=[];f.save();
  const before=events(f),result=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
  assert.deepEqual(result.settled,['R-1']);assert.deepEqual(events(f).slice(0,before.length),before);
  const row=events(f).findLast(e=>e.type==='closeout.evaluated'&&e.key===target.key);
  assert.equal(row.completed,true);assert.equal(row.completion_kind,'current-vacancy');assert.equal(row.native_completion,false);
  assert.equal(row.resources.folder.preservation,'UNKNOWN');assert.deepEqual(effects(f),[]);
  assert.deepEqual(f.drain({keys:[target.key],retrySafe:true}).evaluated,[]);
});

test('BCH legacy target at another cwd does not bind an absent allocation',t=>{
  const f=setup(t,{occupied:false,direct:true,merged:true});selectCurrentCleanup(f);f.report();
  const rows=events(f),run=rows.find(e=>e.type==='run.started'),target=rows.find(e=>e.type==='report.ingested').closeout_targets[0];
  assert.equal(run.meta.dispatch_project,undefined);assert.equal(rows.some(e=>e.type==='run.claimed'),false);
  assert.equal(target.run,run.id);assert.equal(target.cwd,run.workspace);
  target.cwd=path.join(f.scratch,'another-allocation');
  fs.writeFileSync(f.eventFile,rows.map(e=>JSON.stringify(e)+'\n').join(''));
  f.git(['worktree','remove',f.lane]);f.git(['branch','-d','lane/topic']);f.state.workspaces=[];f.save();
  const before=fs.readFileSync(f.eventFile),calls=f.herdrCalls(),actions=f.read().actions;
  assert.deepEqual(settleVacantCloseouts({project:gitProject(f.repo),org:f.org,events:rows,state:fold(rows),guard:()=>{},
    observe:()=>assert.fail('an unbound run must not reach native observation')}),[]);
  assert.deepEqual(fs.readFileSync(f.eventFile),before);
  assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.read().actions,actions);assert.deepEqual(effects(f),[]);
});

test('BCH legacy project claim settles an absent allocation without a dispatch binding or target',t=>{
  const f=partial(t,{absent:true,binding:'claim'});
  assert.equal(events(f).find(e=>e.type==='run.started').meta.dispatch_project,undefined);
  assert.deepEqual(events(f).find(e=>e.type==='report.ingested').closeout_targets,[]);
  assert.deepEqual(f.refresh().settled,['R-1']);
  const row=events(f).find(e=>e.type==='closeout.vacancy-settled');
  assert.equal(row.resources.folder.preservation,'UNKNOWN');assert.equal(row.native_completion,false);
  assert.deepEqual(effects(f),[]);assert.deepEqual(f.read().actions,[]);
});

test('BCH explicit foreign dispatch retains a legacy target without vacancy settlement',t=>{
  const f=setup(t,{occupied:false,direct:true,merged:true});selectCurrentCleanup(f);f.report();
  const rows=events(f);assert.ok(rows.find(e=>e.type==='report.ingested').closeout_targets.length);
  rows.find(e=>e.type==='run.started').meta.dispatch_project='/foreign/git';
  fs.writeFileSync(f.eventFile,rows.map(e=>JSON.stringify(e)+'\n').join(''));
  f.git(['worktree','remove',f.lane]);f.git(['branch','-d','lane/topic']);f.state.workspaces=[];f.save();
  assert.deepEqual(refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options}).settled,[]);
  assert.equal(events(f).some(e=>e.type==='closeout.vacancy-settled'),false);assert.deepEqual(effects(f),[]);
});

test('BCH vacancy leaves a main-ancestor branch intact and records its exact head',t=>{
  const f=partial(t,{absent:true});f.git(['branch','lane/topic',f.head]);
  assert.deepEqual(f.refresh().settled,['R-1']);
  const receipt=events(f).find(e=>e.type==='closeout.vacancy-settled');
  assert.equal(receipt.resources.branch.status,'retained');assert.equal(receipt.resources.branch.integrated,true);
  assert.equal(f.git(['rev-parse','lane/topic']),f.head);assert.deepEqual(effects(f),[]);
});

function duringVacancyObservation(f,append){
  const command=f.options.command;let observed=false;
  f.options.command=(exe,args,options)=>{
    if(!observed&&exe===f.job.herdr&&args[0]==='workspace'){
      observed=true;append();
    }
    return command(exe,args,options);
  };
  return()=>assert.equal(observed,true,'change must occur during the vacancy observation');
}

test('BCH vacancy survives an unrelated concurrent append',t=>{
  const f=partial(t,{absent:true}),before=events(f);
  const observed=duringVacancyObservation(f,()=>f.append([{type:'note',id:'ENG-2',text:'unrelated concurrent writer'}]));
  assert.deepEqual(f.refresh().settled,['R-1']);observed();
  const after=events(f);
  assert.ok(after.some(e=>e.type==='closeout.vacancy-settled'&&e.run==='R-1'));
  assert.ok(after.some(e=>e.type==='note'&&e.id==='ENG-2'&&e.text==='unrelated concurrent writer'));
  assert.deepEqual(after.slice(0,before.length),before);assert.deepEqual(effects(f),[]);assert.deepEqual(f.read().actions,[]);
});

test('BCH vacancy retains a concurrent change to its own run',t=>{
  const f=partial(t,{absent:true});
  const observed=duringVacancyObservation(f,()=>f.append([{type:'run.claimed',run:'R-1',project:f.common,record:f.org,
    owner:{controller:'foreign',legacy:true}}]));
  assert.deepEqual(f.refresh().settled,[]);observed();
  assert.equal(events(f).some(e=>e.type==='closeout.vacancy-settled'&&e.run==='R-1'),false);
  assert.deepEqual(effects(f),[]);assert.deepEqual(f.read().actions,[]);
});

test('BCH vacancy survives a settlement failure and still binds another finished run',t=>{
  const f=partial(t,{absent:true}),second=path.join(f.scratch,'second');
  f.git(['worktree','add','-b','lane/second',second]);
  f.append([{type:'item.added',id:'ENG-2',role:'engineer'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:second,
      meta:{lane:'second',agent_session_id:'second-session',dispatch_project:f.common}}]);
  f.append([{type:'report.ingested',run:'R-2',sha256:'second',report:{outcome:'done'}}]);
  const observed=duringVacancyObservation(f,()=>{throw Error('injected vacancy observation failure');});
  const result=f.refresh();observed();
  const bound=currentCloseoutEntries(f.common,f.org,events(f)).find(e=>e.run==='R-2'&&e.source.type==='cleanup.bound');
  assert.ok(bound,JSON.stringify(result));assert.ok(result.created.includes(bound.key));
  assert.ok(result.errors.some(e=>e.stage==='vacancy'&&/injected vacancy observation failure/.test(e.reason)),JSON.stringify(result));
  assert.deepEqual(result.settled,[]);assert.deepEqual(effects(f),[]);assert.deepEqual(f.read().actions,[]);
});

test('BCH vacancy retains a concurrently reused allocation',t=>{
  const f=partial(t,{absent:true});
  const observed=duringVacancyObservation(f,()=>f.append([{type:'item.added',id:'ENG-2',role:'engineer'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:f.lane,meta:{dispatch_project:f.common}}]));
  assert.deepEqual(f.refresh().settled,[]);observed();
  assert.equal(events(f).some(e=>e.type==='closeout.vacancy-settled'),false);assert.deepEqual(effects(f),[]);
});

test('BCH vacancy skips foreign and unbound finished runs without vacancy rows or native work',t=>{
  const f=partial(t,{absent:true}),rows=events(f);
  // Keep both an explicitly foreign allocation and a legacy unbound allocation.
  rows.find(e=>e.type==='run.started').meta.dispatch_project='/foreign/git';
  fs.writeFileSync(f.eventFile,rows.map(e=>JSON.stringify(e)+'\n').join(''));
  f.append([{type:'item.added',id:'ENG-2',role:'engineer'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:path.join(f.scratch,'legacy'),meta:{lane:'legacy'}},
    {type:'report.ingested',run:'R-2',report:{outcome:'done'}}]);
  const calls=f.herdrCalls();
  assert.deepEqual(f.refresh().settled,[]);
  assert.equal(events(f).some(e=>e.type.startsWith('closeout.vacancy-')),false);
  assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(effects(f),[]);
});

for(const merged of [true,false])test(`BCH partial original SID permits vacant clean folder disposal with ${merged?'landed':'unlanded'} branch protection`,t=>{
  const f=partial(t,{merged}),before=fs.readFileSync(f.eventFile),result=f.refresh();
  assert.equal(result.created.length,1,JSON.stringify(result));
  const target=currentCloseoutEntries(f.common,f.org,events(f))[0];
  assert.equal(target.source.type,'cleanup.bound');assert.deepEqual(target.panes,[]);
  assert.equal(target.cleanup.physical_identity.agent_session_id,'session');
  const row=f.drain({keys:[target.key],retrySafe:true}).evaluated[0];assert.equal(row.completed,true,JSON.stringify(row));
  assert.equal(fs.existsSync(f.lane),false);assert.equal(row.resources.session.completion,'UNKNOWN');
  assert.equal(f.git(['branch','--list','lane/topic']).length>0,!merged);
  if(!merged)assert.equal(f.git(['rev-parse','lane/topic']),f.head);
  assert.equal(effects(f).some(e=>['agent-exit-requested','shell-close-requested'].includes(e.action)),false);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
});

for(const obstruction of ['moved-session','pane','dirty','UNKNOWN','refusal','claim','HOLD','incomplete'])test(`BCH partial identity retains ${obstruction}`,t=>{
  const f=partial(t),original=currentCloseoutEntries(f.common,f.org,events(f))[0];
  if(obstruction==='moved-session'){f.state.agents=[{name:'other',agent:'native',agent_status:'idle',cwd:f.repo,
    pane_id:'other:p',workspace_id:'other',terminal_id:'other-term',agent_session:{value:'session'}}];f.save();}
  if(obstruction==='pane'){f.state.panes=[{pane_id:'w:p',workspace_id:'w',tab_id:'w:t',cwd:f.lane}];f.state.tabs=[{tab_id:'w:t',workspace_id:'w'}];f.save();}
  if(obstruction==='dirty')fs.writeFileSync(path.join(f.lane,'draft'),'irreplaceable');
  if(obstruction==='UNKNOWN')f.append([{type:'closeout.effect',identity:f.common,key:original.key,run:'R-1',source:original.source,effect:'original',producer:'native-closeout/v2',outcome:{action:'agent-exit-requested',pane:'w:p'}}]);
  if(obstruction==='refusal')f.append([{type:'closeout.evaluated',identity:f.common,key:original.key,run:'R-1',source:original.source,completed:false,reason:'original native refusal',failure:{kind:'fence'}}]);
  if(obstruction==='claim')f.append([{type:'run.claimed',run:'R-1',project:f.common,record:f.org,owner:{controller:'foreign',legacy:true}}]);
  if(obstruction==='HOLD')fs.mkdirSync(path.join(f.repo,'.lane/supervisor/HOLD'),{recursive:true});
  if(obstruction==='incomplete'){const command=f.options.command;f.options.command=(exe,args,options)=>exe===f.job.herdr&&args[0]==='workspace'?
    {status:1,stdout:'',stderr:'inventory unavailable'}:command(exe,args,options);}
  const before=fs.readFileSync(f.eventFile);
  if(obstruction==='HOLD')assert.throws(f.refresh,/STOP\/HOLD/);
  else {f.refresh();const target=currentCloseoutEntries(f.common,f.org,events(f))[0];if(target)f.drain({keys:[target.key],retrySafe:true});}
  assert.equal(fs.existsSync(f.lane),true);assert.equal(f.git(['rev-parse','lane/topic']),f.head);
  assert.deepEqual(f.read().actions,[]);assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
  if(obstruction==='dirty')assert.equal(fs.readFileSync(path.join(f.lane,'draft'),'utf8'),'irreplaceable');
  if(obstruction==='UNKNOWN')assert.ok(unresolvedCloseoutEffect(original,events(f)));
});

for(const obstruction of ['unlanded','UNKNOWN','moved-session','unreported','foreign'])test(`BCH absent allocation does not settle ${obstruction}`,t=>{
  const f=partial(t,{absent:true,merged:obstruction!=='unlanded'}),rows=events(f),target=rows.find(e=>e.type==='report.ingested').closeout_targets?.[0];
  if(obstruction==='unreported')fs.writeFileSync(f.eventFile,rows.filter(e=>e.type!=='report.ingested').map(e=>JSON.stringify(e)+'\n').join(''));
  if(obstruction==='foreign'){rows.find(e=>e.type==='run.started').meta.dispatch_project='/foreign/git';delete rows.find(e=>e.type==='report.ingested').closeout_targets;
    fs.writeFileSync(f.eventFile,rows.map(e=>JSON.stringify(e)+'\n').join(''));}
  if(obstruction==='UNKNOWN'){
    // Model a pre-removal source target retained from the original writer.
    assert.ok(target===undefined);f.append([{type:'closeout.effect',identity:f.common,run:'R-1',key:'unbound-original',source:{seq:3,type:'report.ingested'},
      effect:'original',producer:'native-closeout/v2',outcome:{action:'shell-close-requested',tab_id:'old:t'}}]);
  }
  if(obstruction==='moved-session'){f.state.agents=[{name:'other',agent:'native',agent_status:'idle',cwd:f.repo,agent_session:{value:'session'}}];f.save();}
  assert.deepEqual(f.refresh().settled,[]);assert.equal(events(f).some(e=>e.type==='closeout.vacancy-settled'),false);assert.deepEqual(f.read().actions,[]);
});

test('BCH historical unreported classification finalizes its same ingested run and retains protected folder truth',t=>{
  const f=partial(t),old=events(f),report=old.find(e=>e.type==='report.ingested');
  // Preserve an old observation of the run before its report arrived.
  f.append([{type:'closeout.allocation-kept',identity:f.common,run:'R-1',item:'ENG-1',started_seq:old.find(e=>e.type==='run.started').seq,
    reason:'No final report or authorized abandonment; original dispatch owner retains allocation.'}]);
  const before=events(f),args={project:gitProject(f.repo),org:f.org,events:before,state:fold(before),guard:()=>{}};
  const [row]=reconcileCloseoutBacklog(args);assert.equal(row.type,'closeout.allocation-finalized');
  assert.equal(row.finished_seq,report.seq);assert.equal(row.disposition,'reported');
  assert.equal(fs.existsSync(f.lane),true);assert.deepEqual(effects(f),[]);assert.deepEqual(f.read().actions,[]);
  assert.deepEqual(events(f).slice(0,before.length),before);assert.deepEqual(reconcileCloseoutBacklog({...args,events:events(f),state:undefined}),[]);
});

test('BCH clean protected publication folder stays held after report finality is recognized',t=>{
  const f=partial(t),file=path.join(f.lane,'.publication','packet');
  fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,'protected publication state');
  fs.appendFileSync(path.join(f.common,'info/exclude'),'\n.publication/\n');
  const policy=path.join(f.repo,'.lane.json'),config=JSON.parse(fs.readFileSync(policy));
  config.retirement.protected_paths=['**/.publication/**'];fs.writeFileSync(policy,JSON.stringify(config));
  assert.equal(f.git(['status','--porcelain'],f.lane),'');f.refresh();
  const target=currentCloseoutEntries(f.common,f.org,events(f))[0];
  const row=f.drain({keys:[target.key],retrySafe:true}).evaluated[0];
  assert.equal(row.completed,false);assert.match(row.reason,/protected.*publication/);
  assert.equal(row.resources.folder.status,'kept');assert.equal(row.resources.folder.owner,'R-1');
  assert.equal(fs.readFileSync(file,'utf8'),'protected publication state');
  assert.equal(f.git(['rev-parse','lane/topic']),f.head);assert.deepEqual(f.read().actions,[]);
});

test('BCH partial identity rechecks moved native sessions before Git disposal',t=>{
  const f=partial(t);f.refresh();const target=currentCloseoutEntries(f.common,f.org,events(f))[0],log=f.options.log;
  f.options.log=row=>{log(row);if(row.action==='lane-preflight'){
    const state=f.read();state.agents=[{name:'moved',agent:'native',agent_status:'idle',cwd:f.repo,agent_session:{value:'session'}}];
    fs.writeFileSync(f.file,JSON.stringify(state));
  }};
  const row=f.drain({keys:[target.key],retrySafe:true}).evaluated[0];assert.equal(row.completed,false);
  assert.equal(fs.existsSync(f.lane),true);assert.equal(effects(f).some(e=>e.action==='git-removal-started'),false);
});

test('BCH recovery reopens only the unchanged pre-effect partial-identity hold',t=>{
  const f=partial(t),original=currentCloseoutEntries(f.common,f.org,events(f))[0];
  const first=f.drain({keys:[original.key],retrySafe:true}).evaluated[0];
  assert.equal(first.reason,'unbound allocation original worker/claim changed; keep');
  const before=events(f);assert.equal(f.refresh().created.length,1);
  const target=currentCloseoutEntries(f.common,f.org,events(f))[0];
  assert.equal(f.drain({keys:[target.key],retrySafe:true}).evaluated[0].completed,true);
  assert.deepEqual(events(f).slice(0,before.length),before);assert.equal(fs.existsSync(f.lane),false);
  assert.equal(effects(f).some(e=>e.action==='agent-exit-requested'),false);
});

test('BCH retirement still completes after preservation exceeds the old three minute allowance',t=>{
  const f=setup(t,{occupied:false,direct:true,merged:true});selectCurrentCleanup(f);f.report();
  const target=currentCloseoutEntries(f.common,f.org,events(f))[0],realNow=Date.now(),log=f.options.log;let elapsed=0;
  t.mock.method(Date,'now',()=>realNow+elapsed);
  f.options.log=row=>{log(row);if(row.action==='lane-preflight')elapsed+=210000;};
  const result=runCloseoutTurn({project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},maxSteps:1,
    clock:()=>elapsed,now:()=>Date.now(),cli:(_file,args)=>{
      if(args[0]==='refresh')return '{}';
      f.options.deadline=Number(args[args.indexOf('--deadline')+1]);
      assert.equal(f.options.deadline-Date.now(),CLOSEOUT_TURN_BUDGET_MS);
      return JSON.stringify(f.drain({keys:[target.key],retrySafe:true}));
    }});
  assert.deepEqual(result.errors,[]);assert.equal(result.steps,1);assert.equal(fs.existsSync(f.lane),false);
  assert.ok(effects(f).some(e=>e.action==='worktree-removed'));
});


async function releaseCloseout(t,options={}){
  const f=setup(t,{direct:true,bound:true,merged:true,...options}),installation=selectCurrentCleanup(f);
  const bundle=path.join(f.scratch,'accepted-release');copyProduct(process.cwd(),bundle);
  fs.writeFileSync(path.join(bundle,'.release-commit'),'1'.repeat(40)+'\n');
  const summary=path.join(bundle,'.release-acceptance.json');fs.writeFileSync(summary,JSON.stringify({ready:true,candidateCommit:'1'.repeat(40),elapsedSeconds:1,counts:{PASS:1,FAIL:0,PENDING:0,SKIP:0}}));
  const manifest=spawnSync(process.execPath,[path.resolve('herdr/releases.mjs'),'manifest',bundle,summary],{cwd:f.repo,env:f.env,encoding:'utf8'});
  assert.equal(manifest.status,0,manifest.stderr);
  fs.writeFileSync(installation.file,JSON.stringify({...installation.receipt,source:bundle}));
  const {runCloseoutTurn,CLOSEOUT_TURN_BUDGET_MS}=await import(pathToFileURL(path.join(bundle,'line-service/closeout-turn.mjs')).href);
  const {refreshCloseouts,drainCloseout}=await import(pathToFileURL(path.join(bundle,'lib/closeout-consumer.mjs')).href);
  const refresh=()=>refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
  const turn=()=>runCloseoutTurn({project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},maxSteps:1,
    cli:(_file,args)=>{
      assert.equal(_file,'supervisor/closeout.mjs');
      if(args[0]==='refresh')return JSON.stringify(refresh());
      assert.equal(args[0],'drain');const deadline=Number(args[args.indexOf('--deadline')+1]);
      assert.ok(deadline-Date.now()>700000,'release uses the same twelve-minute closeout allowance');
      return JSON.stringify(drainCloseout({cwd:f.repo,org:f.org,env:f.env,retirementOptions:{...f.options,deadline},
        keys:JSON.parse(args[args.indexOf('--keys')+1]),retrySafe:true}));
    }});
  assert.equal(CLOSEOUT_TURN_BUDGET_MS,720000);
  return{...f,turn,refresh,bundle};
}

for(const obstruction of [null,'branch-absent','UNKNOWN','refusal','identity','claim','HOLD'])
test(`release line closes a proven original tab after folder removal: ${obstruction??'success'}`,async t=>{
  const f=await releaseCloseout(t),[source]=f.report(),original=source.closeout_targets[0];
  f.git(['worktree','remove',f.lane]);
  const success=!obstruction||obstruction==='branch-absent';
  if(obstruction==='branch-absent')f.git(['branch','-d','lane/topic']);
  if(obstruction==='UNKNOWN')f.append([{type:'closeout.effect',identity:f.common,key:original.key,run:'R-1',source:{seq:source.seq,type:source.type},
    effect:'original-unknown',producer:'native-closeout/v2',outcome:{action:'agent-exit-requested',pane:'w:p'}}]);
  if(obstruction==='refusal')f.append([{type:'closeout.evaluated',identity:f.common,key:original.key,run:'R-1',source:{seq:source.seq,type:source.type},
    completed:false,reason:'original native refusal',failure:{kind:'fence',code:'EACCES'}}]);
  if(obstruction==='identity'){f.state.agents[0].agent_session.value='replacement';f.save();}
  if(obstruction==='claim')f.append([{type:'run.claimed',run:'R-1',project:f.common,record:f.org,owner:{controller:'foreign',legacy:true}}]);
  if(obstruction==='HOLD')fs.mkdirSync(path.join(f.repo,'.lane/supervisor/HOLD'),{recursive:true});
  const before=events(f);
  if(obstruction==='HOLD')assert.throws(f.refresh,/STOP\/HOLD/);
  else f.turn();
  if(success){
    const target=currentCloseoutEntries(f.common,f.org,events(f)).find(e=>e.cleanup?.native_only);
    assert.ok(target,JSON.stringify(events(f).slice(before.length)));
    f.turn();f.turn();
    assert.equal(f.read().tabs.length,0,JSON.stringify(events(f).slice(before.length)));
    assert.equal(f.read().actions.filter(a=>a[0]==='tab'&&a[1]==='close').length,1);
    assert.ok(events(f).some(e=>e.type==='closeout.vacancy-settled'));
    assert.equal(effects(f).some(e=>['worktree-removed','branch-removed','lane-removed','git-removal-started'].includes(e.action)),false);
  }else{
    assert.equal(f.read().tabs.length,1);assert.deepEqual(f.read().actions,[]);
  }
  assert.equal(fs.existsSync(f.lane),false);
  if(obstruction==='branch-absent')assert.equal(f.git(['branch','--list','lane/topic']),'');
  else assert.equal(f.git(['rev-parse','lane/topic']),f.head);
  assert.deepEqual(events(f).slice(0,before.length),before);
});
