import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fold} from '../lib/state.mjs';
import {gitProject} from '../lib/project.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';
import {sharedWatcherDischarged} from '../lib/shared-watcher-release.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {events,setup,selectCurrentCleanup,effects} from './helpers/closeout-fixture.mjs';

function fixture(t,{recordOnly=true,phase='complete'}={}) {
  const f=setup(t,{direct:true,bound:true,merged:true}),binding=selectCurrentCleanup(f),run='R-1',
    owner={controller:'brain',legacy:false,release:{id:'source',commit:null,root:f.repo,identity:f.common}};
  f.append([{type:'run.claimed',run,record:f.org,project:f.common,owner},
    {type:'run.updated',id:run,meta:{watcher_pid:901,watcher_identity:'shared-host-birth'}}]);
  const [source]=f.report(),state=fold(events(f)),r=state.runs.get(run),worker=effectiveWorkerIdentity(r,state),
    ownership={owner,generation:r.owner_generation},id=`watch:${run}:final`;
  const duty={schema:'brain.shared-watch/v1',run,org:f.org,project:f.common,repo:f.repo,cwd:f.repo,source:f.repo,ownership,
    native:{agent:worker.agent,pane:worker.pane,workspace:worker.worker_workspace,terminal:worker.terminal_id,session:worker.agent_session_id,cwd:f.lane},
    to:worker.agent,report:path.join(f.org,`runs/${run}/report.md`),argv:[run,...(recordOnly?['--record-only']:[])],
    consumer:'watch/watch.mjs --step',stuck_owner:worker.agent};
  const host={schema:'brain.run-observer-owner/v1',org:f.org,repo:f.repo,project:f.common,source:f.repo,pid:901,identity:'shared-host-birth'},
    step={schema:'brain.watch-step/v1',run,ownership,signature:'a'.repeat(64),phase,next_at:null},
    receipt={ownership,inbox:path.join(f.org,'supervisor/inbox.log'),deliveries:[id]},
    files={duty:path.join(f.org,`watch/shared/${run}.json`),host:path.join(f.org,'watch/observer/owner.json'),
      step:path.join(f.org,`watch/steps/${run}.json`),receipt:path.join(f.org,`watch/${run}.json`),held:path.join(f.org,`watch/observer/held/${run}.json`)};
  const put=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value)+'\n');};
  for(const [key,value] of Object.entries({duty,host,step,receipt}))put(files[key],value);
  if(recordOnly)f.append([{type:'note.added',id:run,text:'[watch record-only] original final report',watch_notice_id:id,watch_ownership:ownership}]);
  const notice={type:'notice',id,to:'supervisor-test',owner:'supervisor-inbox',message:'Original final report',
    project:{repo:f.repo,identity:f.common,org:f.org},correlation:{run,project:f.common,record:f.org}},owned={type:'owned',id,pid:902};
  const inbox=(n=notice,tail=[owned])=>{
    fs.mkdirSync(path.dirname(receipt.inbox),{recursive:true});fs.writeFileSync(receipt.inbox,[n,...tail].map(e=>JSON.stringify(e)+'\n').join(''));
  };
  if(!recordOnly)inbox();
  const proof=()=>{const all=events(f),s=fold(all);return{run:s.runs.get(run),state:s,events:all,scope:{run,cwd:f.lane},org:f.org,common:f.common,project:f.repo};};
  const original=f.options.readOwner;f.options.readOwner=o=>o.pid===901?true:original(o);
  const cli=(_file,argv)=>argv[0]==='refresh'?'{}':JSON.stringify(f.drain({keys:JSON.parse(argv[argv.indexOf('--keys')+1]),retrySafe:true}));
  return{...f,...binding,source,ownership,duty,host,step,receipt,files,put,proof,notice,owned,inbox,
    args:{project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},maxSteps:1,cli}};
}

test('shared host separation requires the exact completed duty and original final callback',t=>{
  const f=fixture(t);assert.equal(sharedWatcherDischarged(f.proof()),true);
  const changes=[
    ['scope',p=>{p.scope.run='R-2';}],['report',p=>{p.run.report=null;}],
    ['claim',p=>{p.run.owner_generation++;}],['legacy',p=>{p.run.owner.legacy=true;}],
    ['project',p=>{p.common+='/other';}],['record',p=>{p.org+='/other';}],
    ['native conflict',p=>{p.state.sessionBindings.set('R-1',[{},{}]);}],
    ['missing final fact',p=>{p.events=p.events.filter(e=>e.type!=='note.added');}],
    ['foreign final fact',p=>{p.events.find(e=>e.watch_notice_id).watch_ownership.generation++;}],
  ];
  for(const[name,change]of changes){const p=structuredClone(f.proof());change(p);assert.notEqual(sharedWatcherDischarged(p),true,name);}
  const files=[
    ['duty',d=>{d.run='R-2';}],['duty',d=>{d.source+='/other';}],['duty',d=>{d.native.session='replacement';}],
    ['duty',d=>{d.ownership.generation++;}],['host',d=>{d.pid++;}],['host',d=>{d.identity='replacement';}],
    ['host',d=>{d.project+='/other';}],['step',d=>{d.ownership.generation++;}],['step',d=>{d.run='R-2';}],
    ...['running','waiting','held','failed'].map(phase=>['step',d=>{d.phase=phase;}]),
    ['step',d=>{d.signature='unknown';}],['step',d=>{d.error='original failure';}],
    ['receipt',d=>{d.intent='record-only';}],['receipt',d=>{d.deliveries=[];}],
    ['receipt',d=>{d.deliveries.push('original-unfinished-callback');}],['receipt',d=>{d.ownership.generation++;}],
  ];
  for(const[key,change]of files){const value=structuredClone(f[key]);change(value);f.put(f.files[key],value);
    assert.equal(sharedWatcherDischarged(f.proof()),false,key);f.put(f.files[key],f[key]);}
  f.put(f.files.held,{run:'R-1',reason:'original failure',stuck_owner:f.duty.stuck_owner});
  assert.equal(sharedWatcherDischarged(f.proof()),false,'held failure cannot become discharged');fs.unlinkSync(f.files.held);
  f.put(f.files.duty,null);assert.equal(sharedWatcherDischarged(f.proof()),false,'malformed registration cannot fall back to per-run mode');
  f.put(f.files.duty,f.duty);fs.renameSync(f.files.step,f.files.step+'.saved');fs.symlinkSync(f.files.step+'.saved',f.files.step);
  assert.equal(sharedWatcherDischarged(f.proof()),false,'redirected completion keeps the original');
});

for(const recordOnly of [true,false])
test(`shared discharge compares canonical record paths (record-only: ${recordOnly})`,t=>{
  const f=fixture(t,{recordOnly}),alias=f.org.startsWith('/private/var/')?f.org.slice('/private'.length):
    `${path.dirname(f.org)}/./${path.basename(f.org)}`,
    savedAlias=path.join(f.repo,'.org'),proof=()=>({...f.proof(),org:alias});
  assert.notEqual(alias,f.org);
  assert.equal(sharedWatcherDischarged(proof()),true,'aliased caller with canonical receipts');
  if(recordOnly)assert.equal(fs.existsSync(f.receipt.inbox),false,'record-only proof has no inbox file');
  f.put(f.files.duty,{...f.duty,org:savedAlias});
  f.put(f.files.host,{...f.host,org:savedAlias});
  f.put(f.files.receipt,{...f.receipt,inbox:path.join(savedAlias,'supervisor/inbox.log')});
  const aliasedProof=()=>{const p=proof();p.run.meta.dispatch_record=savedAlias;return p;};
  if(!recordOnly)f.inbox({...f.notice,project:{...f.notice.project,org:savedAlias},correlation:{...f.notice.correlation,record:savedAlias}});
  assert.equal(sharedWatcherDischarged(aliasedProof()),true,'canonicalize saved paths too');
  assert.equal(sharedWatcherDischarged({...aliasedProof(),org:f.org}),true,'canonical caller with aliased receipts');
  const foreign=path.join(f.scratch,'foreign-record');fs.mkdirSync(foreign);
  for(const key of ['duty','host','receipt']){
    const file=f.files[key],saved=JSON.parse(fs.readFileSync(file));
    f.put(file,{...saved,...(key==='receipt'?{inbox:path.join(foreign,'supervisor/inbox.log')}:{org:foreign})});
    assert.equal(sharedWatcherDischarged(aliasedProof()),false,`${key} from a different record stays held`);
    f.put(file,saved);assert.equal(sharedWatcherDischarged(aliasedProof()),true,'original path restores discharge');
  }
  const wrong=aliasedProof();wrong.run.meta.dispatch_record=foreign;
  assert.equal(sharedWatcherDischarged(wrong),false,'foreign dispatch record stays held');
  if(!recordOnly){
    for(const notice of [{...f.notice,project:{...f.notice.project,org:foreign}},
      {...f.notice,correlation:{...f.notice.correlation,record:foreign}}]){
      f.inbox(notice);assert.equal(sharedWatcherDischarged(aliasedProof()),false,'foreign transport record stays held');
    }
    f.inbox();assert.equal(sharedWatcherDischarged(aliasedProof()),true);
    fs.renameSync(f.receipt.inbox,f.receipt.inbox+'.saved');fs.symlinkSync(f.receipt.inbox+'.saved',f.receipt.inbox);
    assert.equal(sharedWatcherDischarged(aliasedProof()),false,'canonical comparison does not bypass no-redirect inbox reads');
  }
});

test('shared completion preserves uncertain refused and worker-addressed pending transport guards',t=>{
  const f=fixture(t,{recordOnly:false});assert.equal(sharedWatcherDischarged(f.proof()),true,'durable independent transport owns its pending notice');
  for(const tail of [[],[f.owned,{type:'sending',id:f.notice.id,occupant:'original'}],
    [f.owned,{type:'autopilot',id:f.notice.id,result:{disposition:'handled',undeliverable:{reason:'refused'}}}]]){
    f.inbox(f.notice,tail);assert.equal(sharedWatcherDischarged(f.proof()),false);
  }
  const workerNotice={...f.notice,to:f.duty.native.agent};f.inbox(workerNotice);
  assert.equal(sharedWatcherDischarged(f.proof()),false,'pending worker continuation still needs its session');
  f.inbox(workerNotice,[f.owned,{type:'sent',id:f.notice.id}]);
  assert.equal(sharedWatcherDischarged(f.proof()),true,'confirmed worker delivery is finished');
  f.inbox();fs.appendFileSync(f.receipt.inbox,'{"type":');assert.equal(sharedWatcherDischarged(f.proof()),false,'uncertain original tail');
});

for(const scenario of ['A2 completed and vanished','failed duty','pending duty','pending worker callback','unknown host','cwd reference'])
test(`guarded shared closeout: ${scenario}`,t=>{
  const f=fixture(t,{recordOnly:scenario!=='pending worker callback',phase:scenario==='failed duty'?'failed':scenario==='pending duty'?'waiting':'complete'});
  if(scenario==='pending worker callback')f.inbox({...f.notice,to:f.duty.native.agent});
  if(scenario==='unknown host')f.options.readOwner=()=>{throw Error('unknown shared host birth');};
  if(scenario==='cwd reference'){
    const command=f.options.command;f.options.command=(exe,argv,opt)=>exe==='/usr/sbin/lsof'&&argv.includes('-Fpn0')?
      {status:0,stdout:`p${process.pid}\0n${f.repo}\0\np901\0n${f.lane}\0\n`,stderr:''}:command(exe,argv,opt);
  }
  // A2's other duty vanished without a report. The same host remains alive;
  // its failed checkpoint, held owner and immutable registration must survive.
  const vanishedCwd=path.join(f.scratch,'vanished'),vanishedNative={agent:'original-vanished-owner',pane:'old:p',workspace:'old',
    terminal:'old-terminal',session:'old-session',cwd:vanishedCwd};
  f.append([{type:'item.added',id:'ENG-2',kind:'work',role:'engineer',title:'Vanished original worker'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:vanishedCwd,meta:{agent:vanishedNative.agent,pane:vanishedNative.pane,
      worker_workspace:vanishedNative.workspace,terminal_id:vanishedNative.terminal,agent_session_id:vanishedNative.session,
      dispatch_project:f.common,dispatch_record:f.org}},
    {type:'run.claimed',run:'R-2',record:f.org,project:f.common,owner:f.ownership.owner},
    {type:'run.updated',id:'R-2',meta:{watcher_pid:901,watcher_identity:'shared-host-birth'}}]);
  const vanished=fold(events(f)).runs.get('R-2'),ownership={owner:vanished.owner,generation:vanished.owner_generation},
    retained={...f.files,vanishedDuty:path.join(f.org,'watch/shared/R-2.json'),vanishedStep:path.join(f.org,'watch/steps/R-2.json'),
      vanishedHeld:path.join(f.org,'watch/observer/held/R-2.json')};
  delete retained.held;
  f.put(retained.vanishedDuty,{...f.duty,run:'R-2',ownership,native:vanishedNative,to:vanishedNative.agent,stuck_owner:vanishedNative.agent,
    report:path.join(f.org,'runs/R-2/report.md'),argv:['R-2','--record-only']});
  f.put(retained.vanishedStep,{...f.step,run:'R-2',ownership,phase:'failed',error:'original worker vanished without a valid report'});
  f.put(retained.vanishedHeld,{run:'R-2',ownership,reason:'original watcher exit 1',stuck_owner:'original-vanished-owner'});
  const saved=new Map(Object.values(retained).map(file=>[file,fs.readFileSync(file)])),result=runCloseoutTurn(f.args),all=events(f),
    row=all.findLast(e=>e.type==='closeout.evaluated'&&e.run==='R-1');
  assert.equal(result.steps,1);assert.deepEqual(result.errors,[]);
  for(const[file,bytes]of saved)assert.deepEqual(fs.readFileSync(file),bytes,'original observer, duties and callback receipts are unchanged');
  if(scenario==='A2 completed and vanished'){
    assert.equal(row.completed,true);assert.equal(row.resources.session.status,'closed');assert.equal(row.resources.folder.status,'removed');
    assert.equal(fs.existsSync(f.lane),false);assert.equal(f.git(['branch','--list','lane/topic']),'');
    assert.ok(effects(f).some(e=>e.action==='closed'));assert.ok(effects(f).some(e=>e.action==='lane-removed'));
    assert.ok(all.some(e=>e.type==='closeout.effect'&&e.outcome.action==='report-evidence'));
    t.diagnostic(JSON.stringify({witness:'A2-shared-host-closeout',completed_run:'R-1',vanished_run:'R-2',
      evaluation:{seq:row.seq,key:row.key,completed:row.completed,resources:row.resources},
      effects:all.filter(e=>e.type==='closeout.effect').map(e=>({seq:e.seq,effect:e.effect,outcome:e.outcome}))}));
  }else if(scenario==='cwd reference'){
    assert.equal(row.completed,false);assert.match(row.reason,/process cwd reference/);assert.equal(fs.existsSync(f.lane),true);
  }else{
    assert.equal(row.completed,false);assert.match(row.reason,/watcher callback/);assert.deepEqual(f.read().actions,[]);assert.equal(fs.existsSync(f.lane),true);
  }
  assert.equal(all.filter(e=>e.type==='report.ingested'&&e.run==='R-1').length,1);
  assert.equal(all.some(e=>e.type==='report.ingested'&&e.run==='R-2'),false,'failed vanished duty was not silently discharged');
});
