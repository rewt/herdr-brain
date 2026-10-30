import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fold} from '../lib/state.mjs';
import {gitProject} from '../lib/project.mjs';
import {reportWatcherHandedOff} from '../lib/report-watcher-release.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {wakeLineService} from '../line-service/line-service.mjs';
import {events,setup,selectCurrentCleanup,effects} from './helpers/closeout-fixture.mjs';

function fixture(t,{merged=true}={}) {
  const f=setup(t,{direct:true,bound:true,merged}),binding=selectCurrentCleanup(f);
  const owner={controller:'brain',legacy:false,release:{id:'source',commit:null,root:f.repo,identity:f.common}};
  f.append([{type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner},
    {type:'run.updated',id:'R-1',meta:{watcher_pid:901,watcher_identity:'watcher-birth'}}]);
  const [source]=f.report(),state=fold(events(f)),run=state.runs.get('R-1'),scope={run:run.id,cwd:f.lane},
    inbox=path.join(f.org,'supervisor/inbox.log'),receiptFile=path.join(f.org,'watch/R-1.json');
  fs.mkdirSync(path.dirname(inbox),{recursive:true});fs.mkdirSync(path.dirname(receiptFile),{recursive:true});
  const receipt={ownership:{owner,generation:run.owner_generation},intent:'delivery',inbox,deliveries:['watch:R-1:final']},
    notice={type:'notice',id:'watch:R-1:final',to:'supervisor-test',owner:'supervisor-inbox',message:'Original final report',
      project:{repo:f.repo,identity:f.common,org:f.org},correlation:{run:run.id,project:f.common,record:f.org}},
    owned={type:'owned',id:notice.id,pid:902};
  const save=(r=receipt,n=notice,tail=[owned])=>{
    fs.writeFileSync(receiptFile,JSON.stringify(r));
    fs.writeFileSync(inbox,[n,...tail].map(e=>JSON.stringify(e)+'\n').join(''));
  };save();
  const originalOwner=f.options.readOwner;f.options.readOwner=o=>o.pid===901?true:originalOwner(o);
  const cli=(_file,argv)=>argv[0]==='refresh'?'{}':JSON.stringify(f.drain({keys:JSON.parse(argv[argv.indexOf('--keys')+1]),retrySafe:true}));
  return{...f,...binding,state,run,scope,inbox,receiptFile,receipt,notice,owned,save,
    proof:{run,state,scope,org:f.org,common:f.common,project:f.repo},
    args:{project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},maxSteps:1,cli},source};
}

test('only the original claimed final transport handoff releases its synthetic watcher reference',t=>{
  const f=fixture(t);assert.equal(reportWatcherHandedOff(f.proof),true);
  const changes=[
    ['no source scope',p=>{p.scope=null;}],['other allocation',p=>{p.scope.cwd+='/other';}],
    ['no ingested report',p=>{p.run.report=null;}],['legacy claim',p=>{p.run.owner.legacy=true;}],
    ['foreign project',p=>{p.common+='/other';}],['foreign record',p=>{p.run.meta.dispatch_record+='/other';}],
    ['changed generation',(_p,r)=>{r.ownership.generation++;}],['changed owner',(_p,r)=>{r.ownership.owner.controller='foreign';}],
    ['other watcher intent',(_p,r)=>{r.intent='process-end';}],['no final ID',(_p,r)=>{r.deliveries=[];}],
    ['malformed deliveries string',(_p,r)=>{r.deliveries='watch:R-1:final';}],
    ['malformed deliveries entry',(_p,r)=>{r.deliveries.push({id:'other'});}],
    ['other inbox',(_p,r)=>{r.inbox+='.other';}],['no original notice',(_p,_r,n)=>{n.id='other';}],
    ['foreign correlation',(_p,_r,n)=>{n.correlation.run='R-2';}],['foreign inbox project',(_p,_r,n)=>{n.project.identity+='/other';}],
    ['worker continuation',(_p,_r,n)=>{n.to='worker';}],['pane continuation',(_p,_r,n)=>{n.to='w:p';}],
    ['no acknowledged transport owner',(_p,_r,_n,tail)=>{tail.length=0;}],
    ['uncertain original input',(_p,_r,n,tail)=>{tail.push({type:'sending',id:n.id,occupant:'original'});}],
    ['refused original input',(_p,_r,n,tail)=>{tail.push({type:'autopilot',id:n.id,result:{disposition:'handled',undeliverable:{reason:'refused'}}});}],
  ];
  for(const[name,change]of changes){
    const p=structuredClone(f.proof),r=structuredClone(f.receipt),n=structuredClone(f.notice),tail=[f.owned];
    change(p,r,n,tail);f.save(r,n,tail);assert.equal(reportWatcherHandedOff(p),false,name);
  }
  f.save();fs.appendFileSync(f.inbox,'{"type":');assert.equal(reportWatcherHandedOff(f.proof),false,'torn original inbox');
  f.save();fs.renameSync(f.receiptFile,f.receiptFile+'.saved');fs.symlinkSync(f.receiptFile+'.saved',f.receiptFile);
  assert.equal(reportWatcherHandedOff(f.proof),false,'redirected receipt');
});

for(const scenario of ['landed','unlanded','dirty','cwd reference','uncertain input','unknown watcher'])
test(`one finite line step preserves the pending watcher and handles ${scenario} worker resources`,t=>{
  const f=fixture(t,{merged:scenario!=='unlanded'}),beforeInbox=fs.readFileSync(f.inbox),beforeReceipt=fs.readFileSync(f.receiptFile);
  if(scenario==='dirty')fs.writeFileSync(path.join(f.lane,'unsaved'),'irreplaceable draft');
  if(scenario==='cwd reference'){
    const command=f.options.command;
    f.options.command=(exe,argv,opt)=>exe==='/usr/sbin/lsof'&&argv.includes('-Fpn0')?
      {status:0,stdout:`p${process.pid}\0n${f.repo}\0\np901\0n${f.lane}\0\n`,stderr:''}:command(exe,argv,opt);
  }
  if(scenario==='uncertain input')f.save(f.receipt,f.notice,[f.owned,{type:'sending',id:f.notice.id,occupant:'original'}]);
  if(scenario==='unknown watcher')f.options.readOwner=()=>{throw Error('unknown original watcher');};
  const savedInbox=fs.readFileSync(f.inbox),result=runCloseoutTurn(f.args),all=events(f),row=all.findLast(e=>e.type==='closeout.evaluated');
  assert.equal(result.steps,1);assert.deepEqual(result.errors,[]);
  assert.deepEqual(fs.readFileSync(f.inbox),savedInbox,'transport bytes and original attempts survive');
  assert.deepEqual(fs.readFileSync(f.receiptFile),beforeReceipt,'original watcher is retained unchanged');
  if(['uncertain input','unknown watcher'].includes(scenario)){
    assert.equal(row.completed,false);assert.match(row.reason,/watcher callback/);assert.deepEqual(f.read().actions,[]);
    assert.equal(fs.existsSync(f.lane),true);
  }else{
    assert.ok(effects(f).some(e=>e.action==='closed'),'worker session closes in this step');
    if(['dirty','cwd reference'].includes(scenario)){
      assert.equal(row.completed,false);assert.equal(row.resources.folder.status,'kept');
      if(scenario==='dirty')assert.equal(fs.readFileSync(path.join(f.lane,'unsaved'),'utf8'),'irreplaceable draft');
      else assert.match(row.reason,/process cwd reference/);
    }else{
      assert.equal(row.completed,true);assert.equal(fs.existsSync(f.lane),false);
      assert.equal(f.git(['branch','--list','lane/topic'])!=='',scenario==='unlanded');
      assert.equal(row.resources.branch.status,scenario==='unlanded'?'retained':'deleted');
    }
    assert.deepEqual(fs.readFileSync(f.inbox),beforeInbox);
  }
});

test('a closeout error still allows the existing general child to start unrelated work',t=>{
  const f=fixture(t),logs=[];let starts=0;
  const wake=wakeLineService({service:{directory:f.directory,closeout:()=>{throw Error('injected closeout failure');},log:r=>logs.push(r)},
    launch:()=>{starts++;return{pid:123};}});
  assert.equal(starts,1);assert.equal(wake.general.pid,123);
  assert.ok(logs.some(r=>r.action==='closeout-held'&&r.reason==='injected closeout failure'));
  assert.deepEqual(f.read().actions,[]);
});
