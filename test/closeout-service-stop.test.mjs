import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createLineService,sourceRoot} from '../line-service/line-service.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {refreshCloseouts} from '../lib/closeout-consumer.mjs';
import {currentCloseoutEntries} from '../lib/closeout.mjs';
import {withPromotionGuard} from '../promote/guard.mjs';
import {setup,events,effects,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';

function fixture(t,{merged=true}={}) {
  const f=setup(t,{direct:true,bound:true,merged}),binding=selectCurrentCleanup(f),commands=[];
  const service=createLineService({repo:f.repo,org:f.org,to:'supervisor-test',env:f.env,maxStepsPerStage:1,closeoutMeasure:()=>{},
    command:(exe,args)=>{
      commands.push(args);
      assert.equal(args[0],path.join(sourceRoot,'supervisor/closeout.mjs'),'only the existing closer runs');
      assert.ok(['refresh','drain'].includes(args[1]));
      assert.ok(args.includes('--release-only'),'explicit scope survives the process boundary');
      const releaseOnly=args.includes('--release-only');
      const result=args[1]==='refresh'?refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options,releaseOnly}):
        f.drain({keys:JSON.parse(args[args.indexOf('--keys')+1]),retrySafe:true,releaseOnly});
      return{status:0,stdout:JSON.stringify(result),stderr:''};
    }});
  const stop=path.join(binding.directory,'STOP'),hold=path.join(f.repo,'.lane/supervisor/HOLD');
  fs.mkdirSync(path.dirname(hold),{recursive:true});
  fs.writeFileSync(stop,'original stopped service\n');fs.writeFileSync(hold,'BCH proving HOLD\n');
  return{...f,...binding,service,commands,stop,hold,release:()=>service.closeout({releaseOnly:true})};
}

for(const merged of [true,false])test(`release-only closes reported resources under service STOP and project HOLD; merged=${merged}`,t=>{
  const f=fixture(t,{merged});f.report();const original=events(f),main=f.git(['rev-parse','main']);
  assert.throws(()=>f.service.closeout(),/STOP/);
  assert.throws(()=>f.service.intake(),/STOP/);
  assert.throws(()=>withPromotionGuard({canonical:f.repo,identity:f.common,workspace:f.lane,topic:'topic'}),{code:'PROMOTION_HELD'});
  const result=f.release();
  assert.equal(result.result,'closeout-turn-complete');assert.deepEqual(result.errors,[]);
  assert.equal(result.ingested,0);assert.equal(result.steps,1);assert.equal(result.decisions.attempted,0);
  const row=result.subjects[0].evaluations[0];assert.equal(row.completed,true);
  assert.equal(row.resources.session.status,'closed');assert.equal(row.resources.folder.status,'removed');
  assert.equal(fs.existsSync(f.lane),false);assert.deepEqual(f.read().tabs,[]);
  assert.equal(f.git(['branch','--list','lane/topic']),merged?'':'lane/topic');
  if(!merged)assert.equal(f.git(['rev-parse','lane/topic']),f.head);
  for(const action of ['report-evidence','lane-preflight','agent-exit-requested','closed','worktree-removed','lane-removed'])
    assert.ok(effects(f).some(e=>e.action===action),action);
  assert.deepEqual(events(f).slice(0,original.length),original);
  assert.equal(f.git(['rev-parse','main']),main);
  assert.equal(fs.readFileSync(f.stop,'utf8'),'original stopped service\n');
  assert.equal(fs.readFileSync(f.hold,'utf8'),'BCH proving HOLD\n');
  assert.match(f.service.pass({reconcileCloseout:false}).held,/STOP\/HOLD/);
  const actions=f.read().actions;assert.equal(f.release().steps,0);
  assert.deepEqual(f.read().actions,actions,'completed effects never replay');
});

test('release-only refreshes an empty original report binding without resuming the line',t=>{
  const f=fixture(t);f.report();const original=events(f);
  original.find(e=>e.type==='report.ingested').closeout_targets[0].panes=[];
  fs.writeFileSync(f.eventFile,original.map(e=>JSON.stringify(e)+'\n').join(''));
  assert.throws(()=>refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options}),/STOP/);
  const refreshed=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options,releaseOnly:true});
  assert.equal(refreshed.created.length,1);assert.deepEqual(f.read().actions,[]);
  assert.deepEqual(f.release().errors,[]);assert.equal(fs.existsSync(f.lane),false);
  assert.deepEqual(events(f).slice(0,original.length),original);
});

for(const kind of ['project-STOP','retirement-HOLD','dirty','refused','unknown','abandoned','unreported-predecessor','working','changed-session'])
test(`release-only preserves ${kind} under service STOP`,t=>{
  const f=fixture(t);
  if(kind==='unreported-predecessor')f.append([
    {type:'item.added',id:'ENG-0',role:'engineer',title:'Unreported predecessor'},
    {type:'run.started',id:'R-0',item:'ENG-0',workspace:f.lane,meta:{agent:'predecessor',pane:'w:old',
      worker_workspace:'w',terminal_id:'old-terminal',agent_session_id:'old-session'}},
    {type:'run.abandoned',id:'R-0'}]);
  if(kind==='abandoned')f.append([{type:'run.abandoned',id:'R-1'}]);else f.report();
  const entry=currentCloseoutEntries(f.common,f.org,events(f)).find(e=>e.run==='R-1');
  if(kind==='project-STOP')fs.writeFileSync(path.join(f.repo,'.lane/supervisor/STOP'),'retain');
  if(kind==='retirement-HOLD')fs.writeFileSync(path.join(f.repo,'.lane/supervisor/HOLD-WORKER-TAB-CLOSE'),'retain');
  if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'unsaved'),'retain draft');
  if(kind==='refused')f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,source:entry.source,run:entry.run,
    completed:false,reason:'original native refusal',failure:{kind:'fence',code:'NATIVE_REFUSAL'}}]);
  if(kind==='refused')fs.unlinkSync(f.hold); // release-only must also suppress decisions without HOLD.
  if(kind==='unknown')f.append([{type:'closeout.effect',identity:f.common,key:entry.key,source:entry.source,run:entry.run,
    effect:'original-unknown',producer:'native-closeout/v2',outcome:{action:'agent-exit-requested',pane:'w:p'}}]);
  if(kind==='working'){f.state.agents[0].agent_status='working';f.save();}
  if(kind==='changed-session'){f.state.agents[0].agent_session.value='replacement';f.save();}
  const original=events(f),calls=f.herdrCalls();
  if(kind==='project-STOP')assert.throws(f.release,/STOP/);else f.release();
  if(kind==='dirty'){
    assert.deepEqual(f.read().tabs,[]);
    assert.equal(effects(f).some(e=>e.action==='worktree-removed'),false);
    assert.equal(fs.readFileSync(path.join(f.lane,'unsaved'),'utf8'),'retain draft');
  }else assert.deepEqual(f.read().actions,[]);
  assert.ok(fs.existsSync(f.lane));assert.equal(f.git(['rev-parse','lane/topic']),f.head);
  assert.deepEqual(events(f).slice(0,original.length),original);
  if(['refused','unknown'].includes(kind))assert.deepEqual(f.herdrCalls(),calls);
  if(['abandoned','unreported-predecessor'].includes(kind)){
    assert.deepEqual(f.drain({keys:[entry.key],releaseOnly:true}).evaluated,[],'executor independently enforces report scope');
  }
});

test('a fresh project STOP at drain admission retains its original held evaluation after the marker clears',t=>{
  const f=fixture(t);f.report();const marker=path.join(f.repo,'.lane/supervisor/STOP');
  // The executor rechecks after ownership admission, independently of turn selection.
  const entry=currentCloseoutEntries(f.common,f.org,events(f))[0];
  const held=f.drain({keys:[entry.key],releaseOnly:true,onClaim:()=>fs.writeFileSync(marker,'late STOP')});
  assert.equal(held.evaluated[0].completed,false);assert.match(held.evaluated[0].reason,/STOP/);
  assert.deepEqual(f.read().actions,[]);assert.ok(fs.existsSync(f.lane));
  fs.unlinkSync(marker);
  assert.equal(f.release().steps,0);assert.ok(fs.existsSync(f.lane));
  assert.deepEqual(f.read().actions,[],'clearing a fence does not replace its original held evaluation');
  assert.ok(fs.existsSync(f.stop));assert.ok(fs.existsSync(f.hold));
});

test('release-only skips pending report intake and fourth-turn allocation finalization',t=>{
  const f=fixture(t),all=events(f),report=path.join(f.org,'runs/R-1/report.md');
  fs.unlinkSync(f.hold); // The explicit mode, rather than HOLD, must skip these stages.
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'report awaiting intake');
  all.find(e=>e.type==='run.started').report_path=report;
  fs.writeFileSync(f.eventFile,all.map(e=>JSON.stringify(e)+'\n').join(''));
  fs.writeFileSync(path.join(f.directory,'closeout-turn.json'),JSON.stringify({schema:'line-closeout-turn/v1',identity:f.common,
    org:f.org,turn:3,attempt:0,targets:{},ingest:{}}));
  const result=f.release();assert.equal(result.ingested,0);assert.equal(result.steps,0);assert.deepEqual(result.errors,[]);
  assert.equal(events(f).some(e=>e.type==='report.ingested'),false);assert.deepEqual(f.read().actions,[]);
  assert.deepEqual(f.commands.map(args=>args[1]),['refresh']);
  assert.throws(()=>f.drain({releaseOnly:true}),/exact named/);
});

test('physical-code handoff retains release-only and the original finite deadline',t=>{
  const f=fixture(t);let successor;
  const result=runCloseoutTurn({project:{canonical:f.repo,identity:f.common},org:f.org,env:f.env,releaseOnly:true,
    guard:()=>{},measure:()=>{},budgetMs:5000,clock:()=>0,now:()=>1000,
    fault:stage=>{if(stage==='after-publication')throw Object.assign(Error('changed code'),{code:'CLOSEOUT_CODE_CHANGED'});},
    cli:(file,args)=>{successor={file,args};return '{"result":"successor"}';}});
  assert.equal(result.result,'closeout-code-handoff');assert.equal(successor.file,'line-service/closeout.mjs');
  assert.ok(successor.args.includes('--release-only'));assert.ok(successor.args.includes('--no-handoff'));
  assert.equal(successor.args[successor.args.indexOf('--deadline')+1],'6000');
});
