import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createLineService,sourceRoot} from '../line-service/line-service.mjs';
import {refreshCloseouts} from '../lib/closeout-consumer.mjs';
import {currentCloseoutEntries} from '../lib/closeout.mjs';
import {withPromotionGuard} from '../promote/guard.mjs';
import {gitProject} from '../lib/project.mjs';
import {setup,events,effects,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';

function fixture(t,{merged=true}={}){
  const f=setup(t,{direct:true,bound:true,merged}),binding=selectCurrentCleanup(f),commands=[];
  const service=createLineService({repo:f.repo,org:f.org,to:'supervisor-test',env:f.env,maxStepsPerStage:1,closeoutMeasure:()=>{},
    command:(exe,args,options)=>{
      commands.push(args);
      if(args[0]===path.join(sourceRoot,'bin/org.mjs'))return spawnSync(exe,args,{...options,env:{...f.env,ORG_ACTOR:'line-service'}});
      assert.equal(args[0],path.join(sourceRoot,'supervisor/closeout.mjs'));
      const result=args[1]==='refresh'?refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options}):
        f.drain({keys:JSON.parse(args[args.indexOf('--keys')+1]),retrySafe:true,sessionsOnly:args.includes('--sessions-only')});
      return{status:0,stdout:JSON.stringify(result),stderr:''};
    }});
  const hold=()=>{fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.repo,'.lane/supervisor/HOLD'),'proving HOLD');};
  return{...f,...binding,service,commands,hold};
}

for(const merged of [true,false])test(`project HOLD releases a reported session and clean folder in one turn; merged=${merged}`,t=>{
  const f=fixture(t,{merged});f.report();const original=events(f),main=f.git(['rev-parse','main']);f.hold();
  assert.throws(()=>withPromotionGuard({canonical:f.repo,identity:f.common,workspace:f.lane,topic:'topic'}),{code:'PROMOTION_HELD'});
  const result=f.service.closeout();
  assert.equal(result.result,'closeout-turn-complete');assert.deepEqual(result.errors,[]);assert.equal(result.steps,1);
  const row=result.subjects[0].evaluations[0];assert.equal(row.completed,true);
  assert.equal(row.resources.session.status,'closed');assert.equal(row.resources.folder.status,'removed');
  assert.equal(fs.existsSync(f.lane),false);assert.deepEqual(f.read().tabs,[]);
  assert.equal(f.git(['branch','--list','lane/topic']),merged?'':'lane/topic');
  if(!merged)assert.equal(f.git(['rev-parse','lane/topic']),f.head);
  assert.ok(effects(f).some(e=>e.action==='report-evidence'));
  for(const action of ['lane-preflight','agent-exit-requested','closed','worktree-removed','lane-removed'])
    assert.ok(effects(f).some(e=>e.action===action),action);
  assert.deepEqual(events(f).slice(0,original.length),original);
  assert.equal(f.git(['rev-parse','main']),main,'no landing under HOLD');
  assert.match(f.service.pass({reconcileCloseout:false}).held,/STOP\/HOLD prevents line-service effects/);
  assert.ok(f.commands.every(args=>args[0].endsWith('/supervisor/closeout.mjs')),'no dispatch or start command');
  assert.ok(fs.existsSync(path.join(f.repo,'.lane/supervisor/HOLD')),'closeout does not clear HOLD');
});

test('project HOLD admits finished report intake through the production line guard',t=>{
  const f=fixture(t),all=events(f),report=path.join(f.org,'runs/R-1/report.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});
  fs.writeFileSync(report,'---\nrun: R-1\noutcome: blocked\nsummary: Finished with preserved source\nheadline: Source needs follow-up\nblockers: [Remaining source work]\n---\n');
  const run=all.find(e=>e.type==='run.started'&&e.id==='R-1');
  run.report_path=report;run.meta={...run.meta,dispatch_project:f.common,dispatch_record:f.org};
  fs.writeFileSync(f.eventFile,all.map(e=>JSON.stringify(e)+'\n').join(''));
  f.append([{type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner:{controller:'brain',legacy:false,
    release:{id:'source',root:sourceRoot,commit:null,identity:gitProject(sourceRoot).identity}}}]);
  f.hold();const result=f.service.intake();assert.equal(result.ingested,1);assert.deepEqual(result.errors,[]);
  assert.ok(events(f).some(e=>e.type==='report.ingested'&&e.run==='R-1'));
  assert.deepEqual(f.read().actions,[],'intake grants no native retirement effect');
});

test('project HOLD permits original empty report binding refresh before one guarded closeout turn',t=>{
  const f=fixture(t);f.report();const old=events(f);
  old.find(e=>e.type==='report.ingested').closeout_targets[0].panes=[];
  fs.writeFileSync(f.eventFile,old.map(e=>JSON.stringify(e)+'\n').join(''));f.hold();
  const refreshed=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
  assert.equal(refreshed.created.length,1);assert.deepEqual(f.read().actions,[]);
  const result=f.service.closeout();assert.deepEqual(result.errors,[]);assert.equal(result.steps,1);
  assert.equal(result.subjects[0].evaluations[0].completed,true);assert.equal(fs.existsSync(f.lane),false);
  assert.deepEqual(events(f).slice(0,old.length),old);
});

for(const kind of ['service-STOP','project-STOP','retirement-HOLD','dirty','refused','unknown','abandoned','unreported-predecessor'])
test(`project HOLD preserves ${kind} and its original allocation`,t=>{
  const f=fixture(t);
  if(kind==='unreported-predecessor')f.append([
    {type:'item.added',id:'ENG-0',role:'engineer',title:'Unreported predecessor'},
    {type:'run.started',id:'R-0',item:'ENG-0',workspace:f.lane,meta:{agent:'predecessor',pane:'w:old',
      worker_workspace:'w',terminal_id:'old-terminal',agent_session_id:'old-session'}},
    {type:'run.abandoned',id:'R-0'}]);
  if(kind==='abandoned')f.append([{type:'run.abandoned',id:'R-1'}]);else f.report();
  const entry=currentCloseoutEntries(f.common,f.org,events(f)).find(e=>e.run==='R-1');f.hold();
  if(kind==='service-STOP')fs.writeFileSync(path.join(f.directory,'STOP'),'stop');
  if(kind==='project-STOP')fs.writeFileSync(path.join(f.repo,'.lane/supervisor/STOP'),'stop');
  if(kind==='retirement-HOLD')fs.writeFileSync(path.join(f.repo,'.lane/supervisor/HOLD-WORKER-TAB-CLOSE'),'keep');
  if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'unsaved'),'retain original work');
  if(kind==='refused')f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,source:entry.source,run:entry.run,
    completed:false,reason:'original native refusal',failure:{kind:'fence',code:'NATIVE_REFUSAL'}}]);
  if(kind==='unknown')f.append([{type:'closeout.effect',identity:f.common,key:entry.key,source:entry.source,run:entry.run,
    effect:'original-unknown',producer:'native-closeout/v2',outcome:{action:'agent-exit-requested',pane:'w:p'}}]);
  const original=events(f),calls=f.herdrCalls();
  if(kind==='unreported-predecessor'){
    assert.equal(entry.reportCloseout,true);assert.ok(events(f).some(e=>e.type==='report.ingested'&&e.run===entry.run));
    assert.ok(entry.panes.some(p=>p.run==='R-0'));assert.equal(events(f).some(e=>e.type==='report.ingested'&&e.run==='R-0'),false);
    const result=f.drain({keys:[entry.key]});
    assert.equal(result.evaluated[0].completed,false);
    assert.match(result.evaluated[0].reason,/STOP\/HOLD prevents queued retirement effect/);
  }else if(kind.endsWith('STOP'))assert.throws(()=>f.service.closeout(),/STOP/);else f.service.closeout();
  if(kind==='dirty'){
    assert.deepEqual(f.read().tabs,[],'finished session may close while unsaved work stays preserved');
    assert.equal(effects(f).some(e=>e.action==='worktree-removed'),false);
  }else assert.deepEqual(f.read().actions,[]);
  assert.ok(fs.existsSync(f.lane));
  assert.equal(f.git(['rev-parse','lane/topic']),f.head);
  assert.deepEqual(events(f).slice(0,original.length),original);
  if(['refused','unknown'].includes(kind))assert.deepEqual(f.herdrCalls(),calls,'original refusal/UNKNOWN cannot replay');
  if(kind==='dirty')assert.equal(fs.readFileSync(path.join(f.lane,'unsaved'),'utf8'),'retain original work');
});
