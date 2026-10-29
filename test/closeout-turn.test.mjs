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
import {launchPlist} from '../line-service/plist.mjs';
import {events,setup,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';

function fixture(t){
  const f=setup(t,{direct:true,bound:true,merged:true}),binding=selectCurrentCleanup(f),project=gitProject(f.repo);
  const guard=()=>{for(const file of [path.join(binding.directory,'STOP'),...['STOP','HOLD'].map(n=>path.join(f.repo,'.lane/supervisor',n))])if(fs.existsSync(file))throw Error('STOP/HOLD');};
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
  const originalEffects=events(f).filter(e=>e.type==='closeout.effect'&&e.key===target.key);
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
    assert.deepEqual(events(f).filter(e=>e.type==='closeout.effect'&&e.key===target.key),originalEffects);
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
  runCloseoutTurn({...f.args,cli});
  assert.deepEqual(seen,[target.key,second.key]);
  const checkpoint=JSON.parse(fs.readFileSync(path.join(f.directory,'closeout-turn.json')));
  assert.equal(checkpoint.pending,undefined);assert.equal(checkpoint.continuation.reconcile_committed_sources,true);
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

for(const change of ['STOP','HOLD','claim','current','head','session'])test(`finite turn retains a ${change} boundary change without a native effect`,t=>{
  const f=fixture(t);f.report();
  if(change==='STOP')fs.writeFileSync(path.join(f.directory,'STOP'),'stop');
  if(change==='HOLD')fs.mkdirSync(path.join(f.repo,'.lane/supervisor/HOLD'),{recursive:true});
  if(change==='head')f.git(['commit','--allow-empty','-m','replacement generation'],f.lane);
  if(change==='session'){f.state.agents[0].agent_session.value='foreign';f.save();}
  if(change==='current')f.append([{type:'run.started',id:'R-2',item:'ENG-1',workspace:f.lane}]);
  if(change==='claim')f.append([{type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner:{controller:'foreign',legacy:true,release:null}}]);
  if(['STOP','HOLD'].includes(change))assert.throws(()=>runCloseoutTurn(f.args),/STOP\/HOLD/);
  else runCloseoutTurn(f.args);
  assert.deepEqual(f.read().actions,[]);assert.equal(fs.existsSync(f.lane),true);
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
