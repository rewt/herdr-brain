import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {gitProject} from '../lib/project.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {claimRetirementOwner,currentCloseoutEntries} from '../lib/closeout.mjs';
import {refreshCloseouts} from '../lib/closeout-consumer.mjs';
import {wakeLineService} from '../line-service/line-service.mjs';
import {createLineService,sourceRoot} from '../line-service/line-service.mjs';
import {fold} from '../lib/state.mjs';
import {transact} from '../lib/store.mjs';
import {closeoutRevision} from '../lib/closeout.mjs';
import {registerCloseoutWait} from '../lib/closeout-status.mjs';
import {queueOutcomeDecision} from '../line-service/outcome-decision.mjs';
import {launchPlist} from '../line-service/plist.mjs';
import {events,setup,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';

function fixture(t){
  const f=setup(t,{direct:true,bound:true,merged:true}),binding=selectCurrentCleanup(f),project=gitProject(f.repo);
  const guard=()=>{for(const file of [path.join(binding.directory,'STOP'),...['STOP','HOLD-WORKER-TAB-CLOSE'].map(n=>path.join(f.repo,'.lane/supervisor',n))])if(fs.existsSync(file))throw Error('STOP/HOLD');};
  const args={project,org:f.org,env:f.env,guard,measure:()=>{},maxSteps:1,cli:(file,argv)=>{
    assert.equal(fs.existsSync(path.join(f.org,'lock')),false,'no native command under a report transaction');
    if(argv[0]==='refresh')return '{"created":[]}';
    return JSON.stringify(f.drain({keys:JSON.parse(argv[argv.indexOf('--keys')+1]),retrySafe:true}));
  }};
  return{...f,...binding,args};
}

test('lost publication and lost acknowledgement recover a committed report without the slow pass lock',t=>{
  const f=fixture(t);f.report();
  const release=noticeLock(path.join(f.directory,'pass.lock'));
  try{
    assert.throws(()=>runCloseoutTurn({...f.args,fault:stage=>{if(stage==='after-publication')throw Error('injected crash');}}),/injected crash/);
    const first=runCloseoutTurn({...f.args,fault:stage=>{if(stage==='before-ack')throw Error('lost acknowledgement');}});
    assert.fail(JSON.stringify(first));
  }catch(error){assert.match(error.message,/lost acknowledgement/);}
  finally{release();}
  assert.equal(fs.existsSync(f.lane),false,'closeout proceeds while review owns the general lock');
  const actions=f.read().actions;
  assert.equal(runCloseoutTurn(f.args).steps,0);
  assert.deepEqual(f.read().actions,actions,'no native effect replay after lost acknowledgement');
});

test('measurement runs once after all closeout locks release and diagnostic failure preserves the turn result',t=>{
  const f=fixture(t);f.report();let calls=0;
  const measure=context=>{
    calls++;assert.equal(context.project.identity,f.common);assert.equal(context.org,f.org);
    for(const lock of [path.join(f.org,'lock'),path.join(f.common,'lane-promote.lock'),path.join(f.common,'retirement/owner.lock'),
      path.join(f.directory,'closeout-turn.lock')])assert.equal(fs.existsSync(lock),false,lock);
    assert.equal(fs.existsSync(f.lane),false,'effects precede measurement');
    throw Error('injected diagnostic census failure');
  };
  const result=runCloseoutTurn({...f.args,measure});assert.equal(result.result,'closeout-turn-complete');assert.deepEqual(result.errors,[]);
  assert.equal(calls,1);assert.match(fs.readFileSync(path.join(f.directory,'closeout.log'),'utf8'),/closeout-measurement-failed/);
});

test('retained dirty work permits original binding refresh on each of three finite turns',t=>{
  const f=fixture(t);f.report();
  const dirty=path.join(f.lane,'unsaved'),bytes='irreplaceable draft\n';fs.writeFileSync(dirty,bytes);
  const target=currentCloseoutEntries(f.common,f.org,events(f))[0];
  const prior=f.drain({keys:[target.key],retrySafe:true}).evaluated[0];
  assert.equal(prior.condition.kind,'dirty-work');assert.equal(prior.resources.folder.status,'kept');
  const actions=f.read().actions;
  const effects=()=>events(f).filter(e=>e.type==='closeout.effect'&&e.key===target.key&&e.outcome.action!=='allocation-absent');
  const originalEffects=effects();
  const unbound=f.lane+'-unbound';f.git(['worktree','add','-qb','lane/unbound-report',unbound,f.head]);
  f.append([{type:'item.added',id:'ENG-2',role:'engineer',title:'Missing original allocation'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:unbound,meta:{dispatch_project:f.common}},
    {type:'report.ingested',run:'R-2',sha256:'missing',report:{outcome:'done'}}]);
  // Retain an old producer's report without an envelope. Refresh can bind its
  // physical allocation from original evidence without inventing a session.
  const all=events(f).filter(e=>!(e.type==='closeout.binding-kept'&&e.run==='R-2'));
  delete all.find(e=>e.type==='report.ingested'&&e.run==='R-2').closeout_targets;
  fs.writeFileSync(f.eventFile,all.map(e=>JSON.stringify(e)+'\n').join(''));
  assert.equal(currentCloseoutEntries(f.common,f.org,events(f)).some(e=>e.run==='R-2'),false);
  const calls=[];
  const cli=(file,argv)=>{
    calls.push(argv[0]);
    if(argv[0]==='refresh')return JSON.stringify(refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options}));
    return f.args.cli(file,argv);
  };
  for(let turn=1;turn<=3;turn++){
    const result=runCloseoutTurn({...f.args,cli,budgetMs:600000});
    assert.equal(result.steps,1);assert.deepEqual(result.errors,[]);
    assert.equal(calls.filter(command=>command==='refresh').length,turn,'refresh is bounded to the first turn, then every turn');
    const disposition=events(f).find(e=>e.type==='closeout.binding-kept'&&e.run==='R-2');
    assert.ok(disposition,'unbound report gains a typed disposition by turn one');
    assert.equal(disposition.condition.kind,'missing-identity');
    assert.ok(events(f).some(e=>e.type==='cleanup.bound'&&e.run==='R-2'),'refresh binds the unbound allocation by turn one');
    assert.equal(fs.readFileSync(dirty,'utf8'),bytes);
    assert.equal(f.git(['rev-parse','refs/heads/lane/topic']),target.head);
    assert.deepEqual(f.read().actions,actions,'no duplicate native or Git effect on the dirty allocation');
    assert.deepEqual(effects(),originalEffects,'fresh absence observations cannot repeat an effect command');
  }
  assert.deepEqual(calls,['drain','refresh','drain','refresh','drain','refresh']);
});

test('two wakeups share one owner and checkpoint a kept target before serving an independent target',t=>{
  const f=fixture(t),[source]=f.report(),target=source.closeout_targets[0];
  const secondLane=f.lane+'-second';f.git(['worktree','add','-qb','lane/second',secondLane,f.head]);
  f.append([{type:'item.added',id:'ENG-2',role:'engineer',title:'Independent target'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:secondLane,meta:{lane:'second'}}]);
  const [finished]=f.append([{type:'report.ingested',run:'R-2',sha256:'second',report:{outcome:'done'}}]),second=finished.closeout_targets[0];
  let nested,seen=[];
  const cli=(file,args)=>{
    if(args[0]==='refresh')return '{}';
    seen.push(JSON.parse(args[args.indexOf('--keys')+1])[0]);
    nested=runCloseoutTurn({...f.args,cli});
    return JSON.stringify({evaluated:[{completed:false,reason:'working original allocation kept'}]});
  };
  const first=runCloseoutTurn({...f.args,cli});
  assert.equal(first.steps,1);assert.equal(first.continuation.closeout,1);assert.equal(nested.already_running,true);
  assert.equal(first.subjects[0].key,target.key);assert.equal(first.subjects[0].status,'evaluated');
  assert.equal(first.subjects[0].evaluations[0].completed,false);
  runCloseoutTurn({...f.args,cli});
  assert.deepEqual(seen,[target.key,second.key]);
  const checkpoint=JSON.parse(fs.readFileSync(path.join(f.directory,'closeout-turn.json')));
  assert.equal(checkpoint.pending,undefined);assert.equal(checkpoint.continuation.reconcile_committed_sources,true);
});

test('a recorded fence refusal with an empty drain yields to a newer report on a later one-step turn',t=>{
  const f=fixture(t),[source]=f.report(),old=source.closeout_targets[0],
    secondLane=f.lane+'-second';
  f.git(['worktree','add','-qb','lane/second',secondLane,f.head]);
  f.append([{type:'closeout.command-failed',identity:f.common,key:old.key,source:{seq:source.seq,type:source.type},
    run:'R-1',failure:{kind:'fence'},reason:'original native refusal'},
    {type:'item.added',id:'ENG-2',role:'engineer',title:'Newer finished report'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:secondLane,meta:{lane:'second'}}]);
  const [next]=f.append([{type:'report.ingested',run:'R-2',sha256:'second',report:{outcome:'done'}}]),newer=next.closeout_targets[0],
    original=events(f),calls=f.herdrCalls(),seen=[];
  const cli=(file,argv)=>{
    if(argv[0]==='refresh')return '{}';
    const key=JSON.parse(argv[argv.indexOf('--keys')+1])[0];seen.push(key);
    // Exercise actual executor admission for the refused subject. The newer
    // subject's stub only proves selection and grants no native authority.
    return JSON.stringify(key===old.key?f.drain({keys:[key],retrySafe:true}):{evaluated:[]});
  };
  const first=runCloseoutTurn({...f.args,cli}),second=runCloseoutTurn({...f.args,cli});
  assert.equal(first.steps,1);assert.equal(second.steps,1);
  assert.deepEqual(first.errors,[]);assert.deepEqual(second.errors,[]);
  assert.deepEqual(seen,[old.key,newer.key]);
  assert.equal(first.subjects[0].status,'not-evaluated');assert.deepEqual(first.subjects[0].evaluations,[]);
  const all=events(f);assert.deepEqual(all.slice(0,original.length),original);
  assert.equal(all.some(e=>['closeout.evaluated','closeout.effect'].includes(e.type)&&e.key===old.key),false);
  assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.read().actions,[]);
  assert.equal(fs.existsSync(f.lane),true);
});

test('new defect decisions follow independent report cleanup and existing decisions spend no later decision slots',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.scratch,'.identity-root'),'fixture');
  fs.writeFileSync(f.file,JSON.stringify({...f.receipt,at:new Date().toISOString()}));f.report();
  const secondLane=f.lane+'-defect';f.git(['worktree','add','-qb','lane/defect',secondLane,f.head]);
  f.append([{type:'item.added',id:'ENG-2',role:'engineer',title:'Original held allocation'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:secondLane,meta:{lane:'defect',dispatch_project:f.common}}]);
  const [source]=f.append([{type:'report.ingested',run:'R-2',sha256:'second',report:{outcome:'done'}}]),entry=source.closeout_targets[0];
  const [refusal]=f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,source:{seq:source.seq,type:source.type},
    run:entry.run,item:entry.item,revision:source.seq,completed:false,reason:'EPERM native refusal'}]);
  const original=events(f),decisions=()=>[...fold(events(f)).items.values()].filter(i=>i.meta.uncertain_outcome);
  let closed=false;
  const result=runCloseoutTurn({...f.args,fault:stage=>{
    if(stage==='before-closeout')assert.equal(decisions().length,0,'decision creation cannot delay independent cleanup');
    if(stage==='after-closeout')closed=!fs.existsSync(f.lane);
  }});
  assert.equal(closed,true);assert.deepEqual(result.errors,[]);assert.equal(result.subjects[0].evaluations[0].completed,true);
  assert.equal(result.subjects[0].evaluations[0].resources.folder.status,'removed');
  assert.deepEqual(result.decisions,{existing:0,attempted:1});assert.equal(decisions().length,1);
  assert.equal(decisions()[0].meta.uncertain_outcome.check.subject.key,entry.key);
  const next=runCloseoutTurn(f.args);assert.deepEqual(next.errors,[]);assert.deepEqual(next.decisions,{existing:1,attempted:0});
  assert.equal(decisions().length,1);assert.equal(fs.existsSync(secondLane),true);
  assert.deepEqual(events(f).slice(0,original.length),original);assert.deepEqual(events(f).find(e=>e.seq===refusal.seq),refusal);
});

test('finite project HOLD defers allocations and new decisions quietly, then resumes them',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.scratch,'.identity-root'),'fixture');
  fs.writeFileSync(f.file,JSON.stringify({...f.receipt,at:new Date().toISOString()}));f.report();
  const [entry]=currentCloseoutEntries(f.common,f.org,events(f));
  f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,source:entry.source,
    run:entry.run,item:entry.item,revision:closeoutRevision(entry,events(f)),completed:false,reason:'EPERM native refusal'}]);
  const original=events(f),hold=path.join(f.repo,'.lane/supervisor/HOLD');
  fs.mkdirSync(path.dirname(hold),{recursive:true});fs.writeFileSync(hold,'proving');
  let allocations=0;
  const args={...f.args,cli:(file,argv)=>{
    if(argv[0]==='allocations'){allocations++;return '{}';}
    return f.args.cli(file,argv);
  }},decisions=()=>[...fold(events(f)).items.values()].filter(i=>i.meta.uncertain_outcome);
  for(let turn=0;turn<4;turn++){
    const result=runCloseoutTurn(args);assert.deepEqual(result.errors,[]);
    assert.deepEqual(result.decisions,{existing:0,attempted:0});assert.equal(result.continuation.decisions,1);
  }
  assert.equal(allocations,0);assert.equal(decisions().length,0);assert.deepEqual(f.read().actions,[]);
  fs.unlinkSync(hold);
  for(let turn=0;turn<4;turn++)assert.deepEqual(runCloseoutTurn(args).errors,[]);
  assert.equal(allocations,1);assert.equal(decisions().length,1);
  assert.deepEqual(decisions()[0].meta.uncertain_outcome.check.subject.source,entry.source);
  assert.deepEqual(events(f).slice(0,original.length),original);assert.deepEqual(f.read().actions,[]);
  const checkpoint=path.join(f.directory,'closeout-turn.json'),state=JSON.parse(fs.readFileSync(checkpoint));
  state.turn=11;fs.writeFileSync(checkpoint,JSON.stringify(state));
  const failed=runCloseoutTurn({...args,cli:(file,argv)=>{
    if(argv[0]==='allocations')throw Error('actual allocation failure');return args.cli(file,argv);
  }});
  assert.deepEqual(failed.errors,[{stage:'allocations',reason:'actual allocation failure'}]);
});

test('a failed subject keeps its original binding and receipt while an independent subject completes in the same turn',t=>{
  const f=fixture(t);f.report();const target=currentCloseoutEntries(f.common,f.org,events(f))[0];
  const secondLane=f.lane+'-second';f.git(['worktree','add','-qb','lane/second',secondLane,f.head]);
  f.append([{type:'item.added',id:'ENG-2',role:'engineer',title:'Independent target'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:secondLane,meta:{lane:'second'}}]);
  const [source]=f.append([{type:'report.ingested',run:'R-2',sha256:'second',report:{outcome:'done'}}]),second=source.closeout_targets[0];
  const result=runCloseoutTurn({...f.args,maxSteps:2,cli:(file,args)=>{
    if(args[0]==='refresh')return '{}';
    const key=JSON.parse(args[args.indexOf('--keys')+1])[0];
    if(key===target.key)throw Error('locked: original project owner; owner is live or unknown');
    assert.equal(key,second.key);return JSON.stringify({evaluated:[{key,source:{seq:source.seq,type:source.type},completed:true}]});
  }});
  assert.equal(result.steps,2);assert.equal(result.subjects[0].status,'failed');assert.equal(result.subjects[0].run,target.run);
  assert.deepEqual(result.subjects[0].source,target.source);assert.match(result.subjects[0].reason,/original project owner/);
  assert.equal(result.subjects[1].status,'evaluated');assert.equal(result.subjects[1].evaluations[0].completed,true);
  assert.equal(result.errors.length,1);assert.equal(result.errors[0].key,target.key);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory,'closeout-turn.json'))).subjects,result.subjects);
  assert.deepEqual(f.read().actions,[],'the stubbed independent completion grants no native or Git authority');
});

test('crash before ingest and a dropped availability wake reconcile the original report',t=>{
  const f=fixture(t),all=events(f),run=all.find(e=>e.type==='run.started'&&e.id==='R-1');
  const report=path.join(f.org,'runs/R-1/report.md');fs.mkdirSync(path.dirname(report),{recursive:true});
  fs.writeFileSync(report,'---\nrun: R-1\noutcome: blocked\nsummary: Finished with preserved source\nheadline: Source needs follow-up\nblockers: [Specific remaining work]\n---\n');
  // Fixture launch events carry an original project/record and current claim.
  run.report_path=report;run.meta={...run.meta,dispatch_project:f.common,dispatch_record:f.org};
  fs.writeFileSync(f.eventFile,all.map(e=>JSON.stringify(e)+'\n').join(''));
  f.append([{type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner:{controller:'brain',legacy:false,
    release:{id:'source',root:process.cwd(),commit:null,identity:gitProject(process.cwd()).identity}}}]);
  let calls=0;
  const cli=(file,args)=>{
    if(args[0]==='refresh')return '{}';
    if(args[0]==='ingest'){
      calls++;const result=spawnSync(process.execPath,[path.resolve(file),...args],{cwd:f.repo,env:{...f.env,ORG_ACTOR:'line-service'},encoding:'utf8'});
      assert.equal(result.status,0,result.stderr+result.stdout);return result.stdout;
    }
    return f.args.cli(file,args);
  };
  const args={...f.args,cli};
  assert.throws(()=>runCloseoutTurn({...args,fault:stage=>{if(stage==='before-ingest')throw Error('before ingest crash');}}),/before ingest crash/);
  assert.equal(calls,0);
  const hash=createHash('sha256').update(fs.readFileSync(report)).digest('hex');
  const hint=spawnSync(process.execPath,[path.resolve('bin/org.mjs'),'report-available','--run','R-1','--sha256',hash],
    {cwd:f.repo,env:{...f.env,ORG_ACTOR:'watcher-fixture'},encoding:'utf8'});
  assert.equal(hint.status,0,hint.stderr+hint.stdout);
  assert.equal(events(f).find(e=>e.type==='report.available').sha256,hash,'hint publication precedes acknowledgement');
  const result=runCloseoutTurn(args);assert.deepEqual(result.errors,[]);assert.equal(result.ingested,1);assert.equal(calls,1);
  assert.equal(events(f).filter(e=>e.type==='report.ingested').length,1);
  assert.equal(runCloseoutTurn(args).ingested,0);
});

function reportCandidate(f,id,{owner={controller:'brain',legacy:false,release:{id:'source',root:process.cwd(),commit:null,identity:gitProject(process.cwd()).identity}},project=f.common}={}){
  const item=`ENG-${id.slice(2)}`,report=path.join(f.org,'runs',id,'report.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});
  fs.writeFileSync(report,`---\nrun: ${id}\noutcome: blocked\nsummary: Preserved report\nheadline: Source needs follow-up\nblockers: [Remaining work]\n---\n`);
  f.append([{type:'item.added',id:item,role:'engineer',title:'Report candidate'},
    {type:'run.started',id,item,report_path:report,meta:{dispatch_project:project}},
    ...(owner?[{type:'run.claimed',run:id,record:f.org,project:f.common,owner}]:[])]);
  return{item,report};
}
function ingestReports(f,calls){
  return(file,args)=>{
    if(args[0]!=='ingest')return '{}';
    calls.push(args);
    const result=spawnSync(process.execPath,[path.resolve(file),...args],{cwd:f.repo,env:{...f.env,ORG_ACTOR:'line-service'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr+result.stdout);return result.stdout;
  };
}

test('three repeated ingest failures emit one grouped diagnostic while closeout is occupied and recovery clears it',t=>{
  const f=fixture(t),calls=[];reportCandidate(f,'R-2');
  const lock=path.join(f.directory,'closeout-turn.lock'),release=noticeLock(lock),owner=fs.readFileSync(path.join(lock,'owner.json'));
  const checkpoint=()=>JSON.parse(fs.readFileSync(path.join(f.directory,'report-intake.json')));
  const alarms=()=>fs.existsSync(path.join(f.directory,'closeout.log'))?
    fs.readFileSync(path.join(f.directory,'closeout.log'),'utf8').trim().split('\n').map(JSON.parse)
      .filter(row=>row.action==='report-intake-supervisor-alarm'):[];
  let failed=true;
  const cli=(file,args)=>{
    if(args[0]==='ingest'&&failed){calls.push(args);throw Error('report validation failed');}
    return ingestReports(f,calls)(file,args);
  };
  try{
    for(let turn=1;turn<=4;turn++){
      assert.equal(runCloseoutTurn({...f.args,cli}).already_running,true);
      assert.equal(calls.length,turn,'only the scheduled ingest attempt runs');
      assert.equal(checkpoint().failures['R-2'].turns,turn);
      assert.equal(alarms().length,turn<3?0:1,'unchanged failures dedupe across fresh turns');
      assert.equal(events(f).some(e=>e.type==='report.ingested'),false);
      assert.deepEqual(fs.readFileSync(path.join(lock,'owner.json')),owner);
    }
    const [alarm]=alarms();assert.equal(alarm.owner,'project-supervisor');assert.equal(alarm.count,1);
    assert.deepEqual(alarm.scopes,[{run:'R-2',stage:'ingest',reason:'report validation failed',first_seen:checkpoint().failures['R-2'].first_seen}]);
    failed=false;
    runCloseoutTurn({...f.args,cli});assert.equal(calls.length,5);
    assert.equal(events(f).filter(e=>e.type==='report.ingested'&&e.run==='R-2').length,1);
    assert.deepEqual(checkpoint().failures,{});assert.deepEqual(checkpoint().errors,[]);
    assert.equal(alarms().length,2);assert.equal(alarms()[1].count,0);assert.deepEqual(alarms()[1].scopes,[]);
    runCloseoutTurn({...f.args,cli});assert.equal(calls.length,5);assert.equal(alarms().length,2);
    assert.deepEqual(f.read().actions,[],'diagnostics never acquire or replay native closeout effects');
  }finally{release();}
});

test('report intake commits while both closeout and scheduling owners retain their original locks',t=>{
  const f=fixture(t),calls=[];reportCandidate(f,'R-2');
  const locks=['closeout-turn.lock','pass.lock'].map(name=>path.join(f.directory,name));
  const releases=locks.map(lock=>noticeLock(lock)),owners=locks.map(lock=>fs.readFileSync(path.join(lock,'owner.json')));
  try{
    const result=runCloseoutTurn({...f.args,cli:ingestReports(f,calls)});
    assert.equal(result.already_running,true,'closeout remains with its original owner');
    assert.equal(events(f).filter(e=>e.type==='report.ingested'&&e.run==='R-2').length,1);
    assert.equal(calls.length,1);
    const checkpoint=JSON.parse(fs.readFileSync(path.join(f.directory,'report-intake.json')));
    assert.equal(checkpoint.ingest['R-2'],1);assert.deepEqual(checkpoint.errors,[]);
    for(let n=0;n<locks.length;n++)assert.deepEqual(fs.readFileSync(path.join(locks[n],'owner.json')),owners[n]);
    runCloseoutTurn({...f.args,cli:ingestReports(f,calls)});
    assert.equal(calls.length,1,'next wake consumes committed intake without replay');
  }finally{for(const release of releases.toReversed())release();}
});

test('report intake retains an occupied intake owner and resumes on the next wake',t=>{
  const f=fixture(t),calls=[];reportCandidate(f,'R-2');
  const lock=path.join(f.directory,'report-intake.lock'),release=noticeLock(lock),owner=fs.readFileSync(path.join(lock,'owner.json'));
  try{
    runCloseoutTurn({...f.args,cli:ingestReports(f,calls)});
    assert.deepEqual(calls,[]);assert.deepEqual(fs.readFileSync(path.join(lock,'owner.json')),owner);
  }finally{release();}
  runCloseoutTurn({...f.args,cli:ingestReports(f,calls)});assert.equal(calls.length,1);
});

test('scheduled intake wakes return while their finite closeout child remains occupied',t=>{
  const f=fixture(t),calls=[],commands=[];reportCandidate(f,'R-2');
  const lock=path.join(f.directory,'closeout-turn.lock'),release=noticeLock(lock),owner=fs.readFileSync(path.join(lock,'owner.json'));
  const service=createLineService({repo:f.repo,org:f.org,to:'supervisor-test',env:f.env,maxStarts:0,closeoutMeasure:()=>{},
    command:(exe,args)=>{commands.push(args);return{status:0,stdout:ingestReports(f,calls)(path.relative(sourceRoot,args[0]),args.slice(1)),stderr:''};}});
  service.closeout=()=>{assert.fail('the scheduled parent must not wait for closeout');};
  let launches=0;
  const wake=()=>wakeLineService({service,launch:()=>({pid:100}),launchCloseout:()=>{launches++;return{pid:200};}});
  try{
    assert.equal(wake().intake.ingested,1);reportCandidate(f,'R-3');
    assert.equal(wake().intake.ingested,1);assert.equal(launches,2);
    assert.deepEqual(calls.map(args=>args[args.indexOf('--run')+1]),['R-2','R-3']);
    assert.deepEqual(fs.readFileSync(path.join(lock,'owner.json')),owner);
    const before=commands.length;
    service.pass({reconcileCloseout:false});
    assert.equal(commands.slice(before).some(args=>args[0].endsWith('supervisor/closeout.mjs')),false,'general children do not repeat closeout');
  }finally{release();}
});

test('historical and foreign report files spend no finite ingest slots across repeated turns',t=>{
  const f=fixture(t),calls=[];
  reportCandidate(f,'R-2');f.append([{type:'item.closed',id:'ENG-2',as:'done'}]);
  reportCandidate(f,'R-3',{owner:null});
  reportCandidate(f,'R-4',{owner:{controller:'brain',legacy:true,release:null}});
  reportCandidate(f,'R-5',{owner:{controller:'foreign',legacy:false,release:{id:'source',root:process.cwd(),commit:null,identity:gitProject(process.cwd()).identity}}});
  reportCandidate(f,'R-6',{project:'/foreign/project/.git'});
  reportCandidate(f,'R-7',{project:null});
  reportCandidate(f,'R-8');f.append([{type:'run.started',id:'R-18',item:'ENG-8'},
    {type:'report.ingested',run:'R-18',sha256:'successor',report:{outcome:'blocked'}}]);
  reportCandidate(f,'R-9');f.append([{type:'run.abandoned',id:'R-9'}]);
  reportCandidate(f,'R-10');f.append([{type:'report.ingested',run:'R-10',sha256:'reported',report:{outcome:'blocked'}}]);
  reportCandidate(f,'R-20');reportCandidate(f,'R-21');
  const args={...f.args,cli:ingestReports(f,calls)};
  for(const id of ['R-20','R-21']){
    const result=runCloseoutTurn(args);assert.deepEqual(result.errors,[]);assert.equal(result.ingested,1);
    assert.deepEqual(calls.at(-1).slice(-2),['--if-current-run',id]);
  }
  const final=runCloseoutTurn(args);assert.deepEqual(final.errors,[]);assert.equal(final.ingested,0);assert.equal(final.continuation.ingest,0);
  assert.deepEqual(calls.map(args=>args[args.indexOf('--run')+1]),['R-20','R-21']);
  const checkpoint=JSON.parse(fs.readFileSync(path.join(f.directory,'closeout-turn.json')));
  assert.deepEqual(Object.keys(checkpoint.ingest),['R-20','R-21'],'skips never receive an attempt checkpoint');
  assert.deepEqual(f.read().actions,[]);
});

test('an earlier report ingests while its current successor is unreported',t=>{
  const f=fixture(t),calls=[];reportCandidate(f,'R-2');
  f.append([{type:'run.started',id:'R-3',item:'ENG-2'}]);
  const args={...f.args,cli:ingestReports(f,calls)},result=runCloseoutTurn(args);
  assert.deepEqual(result.errors,[]);assert.equal(result.ingested,1);assert.equal(calls.length,1);
  assert.deepEqual(calls[0].slice(-2),['--run','R-2']);
  const report=events(f).find(e=>e.type==='report.ingested'&&e.run==='R-2');assert.ok(report);assert.equal(report.late,false);
  assert.equal(runCloseoutTurn(args).ingested,0);assert.deepEqual(f.read().actions,[]);
});

for(const change of ['closed','claim','successor-report'])test(`bounded ingest rechecks a ${change} change after selection`,t=>{
  const f=fixture(t),calls=[];reportCandidate(f,'R-2');
  const result=runCloseoutTurn({...f.args,cli:ingestReports(f,calls),fault:stage=>{
    if(stage!=='before-ingest')return;
    if(change==='closed')f.append([{type:'item.closed',id:'ENG-2',as:'done'}]);
    if(change==='claim')f.append([{type:'run.claimed',run:'R-2',record:f.org,project:f.common,owner:{controller:'foreign',legacy:true,release:null}}]);
    if(change==='successor-report')f.append([{type:'run.started',id:'R-3',item:'ENG-2'},
      {type:'report.ingested',run:'R-3',sha256:'successor',report:{outcome:'blocked'}}]);
  }});
  assert.equal(result.errors.length,1);assert.match(result.errors[0].reason,/eligibility changed/);
  assert.deepEqual(calls,[]);assert.deepEqual(f.read().actions,[]);
});

for(const change of ['STOP','HOLD','claim','current','head','session','start','dispatch','report'])test(`finite turn retains a ${change} boundary change without a native effect`,t=>{
  const f=fixture(t);f.report();
  if(change==='STOP')fs.writeFileSync(path.join(f.directory,'STOP'),'stop');
  if(change==='HOLD')fs.mkdirSync(path.join(f.repo,'.lane/supervisor/HOLD-WORKER-TAB-CLOSE'),{recursive:true});
  if(change==='head')f.git(['commit','--allow-empty','-m','replacement generation'],f.lane);
  if(change==='session'){f.state.agents[0].agent_session.value='foreign';f.save();}
  if(change==='current')f.append([{type:'run.started',id:'R-2',item:'ENG-1',workspace:f.lane}]);
  if(change==='claim')f.append([{type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner:{controller:'foreign',legacy:true,release:null}}]);
  if(['start','dispatch','report'].includes(change)){
    const all=events(f);
    if(change==='start')all.find(e=>e.type==='run.started'&&e.id==='R-1').seq++;
    if(change==='dispatch')f.append([{type:'run.updated',id:'R-1',meta:{dispatch_attempt:'replacement'}}]);
    else{
      if(change==='report')all.find(e=>e.type==='report.ingested'&&e.run==='R-1').sha256='changed';
      fs.writeFileSync(f.eventFile,all.map(e=>JSON.stringify(e)+'\n').join(''));
    }
  }
  if(['STOP','HOLD'].includes(change))assert.throws(()=>runCloseoutTurn(f.args),/STOP\/HOLD/);
  else runCloseoutTurn(f.args);
  assert.deepEqual(f.read().actions,[]);assert.equal(fs.existsSync(f.lane),true);
});

test('a reaped general-pass owner recovers on wake while live and unidentified owners retain the lock',t=>{
  const f=fixture(t),lock=path.join(f.directory,'pass.lock');
  const child=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8',env:f.env});
  assert.equal(child.status,0,child.stderr);
  fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:Number(child.stdout),token:'dead-original'}));
  let launches=0;
  const service={directory:f.directory,closeout:()=>({steps:0})},launch=()=>{launches++;return{pid:123};};
  assert.equal(wakeLineService({service,launch}).general.pid,123);assert.equal(launches,1);
  const release=noticeLock(lock);
  try{assert.equal(wakeLineService({service,launch}).general.already_running,true);assert.equal(launches,1);}
  finally{release();}
  fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),'{}');
  assert.equal(wakeLineService({service,launch}).general.already_running,true);assert.equal(launches,1);
});

for(const registered of [true,false])test(`finite refusal decision is owned once across turns and general passes (${registered?'registered':'missing'} wait)`,t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.scratch,'.identity-root'),'fixture');
  fs.writeFileSync(f.file,JSON.stringify({...f.receipt,at:new Date().toISOString()}));f.report();
  const entry=currentCloseoutEntries(f.common,f.org,events(f))[0];
  const [refusal]=f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,source:entry.source,
    run:entry.run,item:entry.item,revision:closeoutRevision(entry,events(f)),completed:false,reason:'EPERM native refusal'}]);
  if(registered)transact(f.org,current=>({add:registerCloseoutWait(entry,refusal,current,[entry])}),{actor:'fixture'});
  const original=fs.readFileSync(f.eventFile);
  for(let turn=0;turn<2;turn++){
    const result=runCloseoutTurn(f.args);assert.deepEqual(result.errors,[]);assert.equal(result.steps,0);
  }
  const commands=[];
  const service=createLineService({repo:f.repo,org:f.org,to:'brain-chat',env:f.env,maxStarts:0,closeoutMeasure:()=>{},
    recordNotice:d=>({id:d.id,state:'record-only'}),command:(_exe,args)=>{
      commands.push(args);return{status:0,stdout:'{}',stderr:''};
    }});
  for(let pass=0;pass<2;pass++)service.pass();
  const decisions=[...fold(events(f)).items.values()].filter(i=>i.role==='decision');
  assert.equal(decisions.length,1);
  assert.equal(decisions[0].meta.uncertain_outcome.check.key,`closeout:${entry.key}`);
  assert.equal(decisions[0].meta.uncertain_outcome.check.status,'defect');
  assert.deepEqual(decisions[0].meta.uncertain_outcome.check.subject.source,entry.source);
  assert.deepEqual(f.read().actions,[]);
  assert.equal(commands.some(args=>args.includes('drain')),false,'a refusal never reaches a native executor');
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,original.length),original);
  const check=decisions[0].meta.uncertain_outcome.check,options={repo:f.repo,org:f.org,env:f.env,owner:'closeout-turn',check};
  assert.throws(()=>queueOutcomeDecision(options),/actual owned closeout-turn lock/);
  const lock=path.join(f.directory,'closeout-turn.lock');fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,identity:'reused process birth'}));
  assert.throws(()=>queueOutcomeDecision(options),/actual owned closeout-turn lock/);
  assert.throws(()=>queueOutcomeDecision({...options,check:{...check,key:'dispatch:foreign'}}),/only closeout decisions/);
});

test('a retirement-owned allocation refuses a new dispatch owner',t=>{
  const f=fixture(t),release=claimRetirementOwner(f.common);
  try{
    // A second process cannot borrow the in-process reentrant claim.
    const script=`import {claimRetirementOwner} from ${JSON.stringify(path.resolve('lib/closeout.mjs'))};claimRetirementOwner(${JSON.stringify(f.common)});`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:f.env,encoding:'utf8'});
    assert.notEqual(result.status,0);assert.match(result.stderr,/owner is live or unknown/);
  }finally{release();}
});

test('the existing installation wakes finite closeout while its general child is busy',t=>{
  const f=fixture(t);f.report();let launched=0;
  const service={directory:f.directory,closeout:()=>runCloseoutTurn(f.args)},release=noticeLock(path.join(f.directory,'pass.lock'));
  try{const wake=wakeLineService({service,launch:()=>{launched++;}});assert.equal(wake.closeout.steps,1);assert.equal(wake.general.already_running,true);}
  finally{release();}
  const result=wakeLineService({service,launch:()=>{launched++;return{pid:123};}});assert.equal(launched,1);assert.equal(result.general.pid,123);
  const xml=launchPlist({label:'line',repo:'/project',org:'/record',directory:'/service',herdr:'/bin/herdr',socket:'/socket',to:'brain-chat',interval:60});
  assert.match(xml,/line-service\/line-service.mjs/);assert.match(xml,/<integer>60<\/integer>/);assert.match(xml,/<key>RunAtLoad<\/key><true\/>/);
});
