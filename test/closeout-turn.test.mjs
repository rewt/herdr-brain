import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {gitProject} from '../lib/project.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {claimRetirementOwner,currentCloseoutEntries} from '../lib/closeout.mjs';
import {wakeLineService} from '../line-service/line-service.mjs';
import {launchPlist} from '../line-service/plist.mjs';
import {events,setup,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';

function fixture(t){
  const f=setup(t,{direct:true,bound:true,merged:true}),binding=selectCurrentCleanup(f),project=gitProject(f.repo);
  const guard=()=>{for(const file of [path.join(binding.directory,'STOP'),...['STOP','HOLD'].map(n=>path.join(f.repo,'.lane/supervisor',n))])if(fs.existsSync(file))throw Error('STOP/HOLD');};
  const args={project,org:f.org,env:f.env,guard,maxSteps:1,cli:(file,argv)=>{
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

test('two wakeups share one owner and checkpoint a kept target before serving an independent target',t=>{
  const f=fixture(t),[source]=f.report(),target=source.closeout_targets[0];
  const second={...target,key:'b'.repeat(64),run:'R-2',cwd:target.cwd+'-second'};
  f.append([{type:'cleanup.bound',run:'R-2',closeout_targets:[second]}]);
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

test('crash before ingest is repaired without an availability hint and before any slow work',t=>{
  const f=fixture(t),all=events(f),run=all.find(e=>e.type==='run.started'&&e.id==='R-1');
  const report=path.join(f.org,'runs/R-1/report.md');fs.mkdirSync(path.dirname(report),{recursive:true});
  fs.writeFileSync(report,'---\nrun: R-1\noutcome: blocked\nsummary: Finished with preserved source\nheadline: Source needs follow-up\nblockers: [Specific remaining work]\n---\n');
  // Fixture launch events carry an original project/record and current claim.
  run.report_path=report;run.meta={...run.meta,dispatch_project:f.common,dispatch_record:f.org};
  fs.writeFileSync(f.eventFile,all.map(e=>JSON.stringify(e)+'\n').join(''));
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
  const result=runCloseoutTurn(args);assert.equal(result.ingested,1);assert.equal(calls,1);
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
