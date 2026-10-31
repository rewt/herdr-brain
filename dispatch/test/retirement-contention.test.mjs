import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {dispatchAllocationEffect} from '../allocation-effect.mjs';
import {gitProject} from '../../lib/project.mjs';
import {claimRetirementAllocation,retirementAllocationLock,retirementOwnerLock,currentCloseoutEntries} from '../../lib/closeout.mjs';
import {retirementLock} from '../../lib/retire-lock.mjs';
import {runCloseoutTurn} from '../../line-service/closeout-turn.mjs';
import {setup,events,selectCurrentCleanup} from '../../test/helpers/closeout-fixture.mjs';
import {fixture,promptCalls} from './dispatch-fixture.mjs';

test('a finite closeout removes an independent reported folder while dispatch retains its allocation',t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});selectCurrentCleanup(f);f.report();
  const project=gitProject(f.repo),branch='lane/unrelated-launch',original=events(f);
  const result=dispatchAllocationEffect({project,org:f.org,branch},()=>{
    assert.ok(fs.existsSync(retirementAllocationLock(f.common,branch)));
    assert.equal(fs.existsSync(retirementOwnerLock(f.common)),false);
    return runCloseoutTurn({project,org:f.org,env:f.env,maxSteps:1,measure:()=>{},
      guard:()=>{for(const marker of ['STOP','HOLD'])assert.equal(fs.existsSync(path.join(f.repo,'.lane/supervisor',marker)),false);},
      cli:(_file,args)=>args[0]==='refresh'?'{}':JSON.stringify(f.drain({keys:JSON.parse(args[args.indexOf('--keys')+1]),retrySafe:true}))});
  });
  assert.equal(result.result,'closeout-turn-complete');assert.deepEqual(result.errors,[]);
  assert.equal(result.subjects.length,1);assert.equal(result.subjects[0].evaluations[0].completed,true);
  assert.equal(result.subjects[0].evaluations[0].resources.folder.status,'removed');
  assert.equal(fs.existsSync(f.lane),false);
  assert.deepEqual(events(f).slice(0,original.length),original);
  assert.ok(events(f).some(e=>e.type==='closeout.effect'&&e.outcome.action==='worktree-removed'));
  assert.equal(fs.existsSync(retirementAllocationLock(f.common,branch)),false);
});

test('the same allocation remains kept during dispatch and a later safe drain preserves the original keep',t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});f.report();
  const project=gitProject(f.repo),entry=currentCloseoutEntries(f.common,f.org,events(f))[0],calls=f.herdrCalls();
  const result=dispatchAllocationEffect({project,org:f.org,branch:entry.branch},()=>f.drain({keys:[entry.key],retrySafe:true}));
  assert.equal(result.evaluated.length,1);assert.equal(result.evaluated[0].completed,false);
  assert.match(result.evaluated[0].reason,/locked:.*retirement\/allocations/);
  assert.deepEqual(f.herdrCalls(),calls);assert.equal(fs.existsSync(f.lane),true);
  const original=events(f),next=f.drain({keys:[entry.key],retrySafe:true});
  assert.equal(next.evaluated[0].completed,true);assert.equal(fs.existsSync(f.lane),false);
  assert.deepEqual(events(f).slice(0,original.length),original);
});

test('held owner or allocation refuses dispatch before its operation and releases only its own claims',t=>{
  const f=setup(t),project=gitProject(f.repo),branch='lane/launch',options={project,org:f.org,branch,waitMs:0};
  let calls=0;
  for(const lock of [retirementOwnerLock(f.common),retirementAllocationLock(f.common,branch)]){
    const release=retirementLock(lock),owner=fs.readFileSync(path.join(lock,'owner.json'));
    try{
      assert.throws(()=>dispatchAllocationEffect(options,()=>calls++),/locked:/);
      assert.deepEqual(fs.readFileSync(path.join(lock,'owner.json')),owner);
    }finally{release();}
    assert.equal(fs.existsSync(retirementOwnerLock(f.common)),false);
    assert.equal(fs.existsSync(retirementAllocationLock(f.common,branch)),false);
  }
  assert.equal(calls,0);
});

test('legacy retirement retains the project fence and operation failure releases both claims',t=>{
  const f=setup(t),project=gitProject(f.repo),branch='lane/launch';
  fs.writeFileSync(path.join(f.repo,'.lane.json'),JSON.stringify({retirement:{closeout_queue:false}}));
  assert.throws(()=>dispatchAllocationEffect({project,org:f.org,branch},()=>{
    assert.ok(fs.existsSync(retirementOwnerLock(f.common)));
    assert.ok(fs.existsSync(retirementAllocationLock(f.common,branch)));
    assert.throws(()=>retirementLock(retirementOwnerLock(f.common)),/locked:/);
    throw Error('original operation failure');
  }),/original operation failure/);
  assert.equal(fs.existsSync(retirementOwnerLock(f.common)),false);
  assert.equal(fs.existsSync(retirementAllocationLock(f.common,branch)),false);
});

test('untransferred legacy housekeeping refuses queue admission without invoking the operation',t=>{
  const f=setup(t),project=gitProject(f.repo),branch='lane/launch',directory=path.join(f.org,'housekeeping/legacy/lock');
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'owner.json'),bytes=JSON.stringify({cwd:f.repo,retirement_queue_protocol:1});fs.writeFileSync(file,bytes);
  let calls=0;
  assert.throws(()=>dispatchAllocationEffect({project,org:f.org,branch},()=>calls++),/ownership transfer waits for legacy housekeeping/);
  assert.equal(calls,0);assert.equal(fs.readFileSync(file,'utf8'),bytes);
  assert.equal(fs.existsSync(retirementOwnerLock(f.common)),false);
  assert.equal(fs.existsSync(retirementAllocationLock(f.common,branch)),false);
});

test('ordinary dispatch yields the queue owner through open prepare launch and record binding',t=>{
  const f=fixture(t),common=f.git(['rev-parse','--path-format=absolute','--git-common-dir']);
  fs.symlinkSync(f.org,path.join(f.repo,'.org'));
  const hook=path.join(f.root,'lock-scope.mjs'),receipt=path.join(f.root,'lock-scope.jsonl');
  const module=new URL('../../lib/closeout.mjs',import.meta.url).href;
  fs.writeFileSync(hook,`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {claimRetirementAllocation,retirementAllocationLock,retirementOwnerLock} from ${JSON.stringify(module)};
import {retirementLock} from ${JSON.stringify(new URL('../../lib/retire-lock.mjs',import.meta.url).href)};
const type=path.basename(process.argv[1]),stage=process.argv[2];
if(type==='lane'&&['open','prepare','dispatch'].includes(stage)||type==='org.mjs'&&['start','worker'].includes(stage)){
 const common=${JSON.stringify(common)},branch=type==='lane'?'lane/'+process.argv[3]:'lane/topic-'+${JSON.stringify(f.item.toLowerCase())};
 assert.ok(fs.existsSync(retirementAllocationLock(common,branch)),stage);
 assert.equal(fs.existsSync(retirementOwnerLock(common)),false,stage);
 const release=retirementLock(retirementOwnerLock(common));release();
 const unrelated=claimRetirementAllocation(common,'lane/independent');unrelated();
 assert.throws(()=>claimRetirementAllocation(common,branch),/locked:/);
 fs.appendFileSync(${JSON.stringify(receipt)},JSON.stringify({stage,branch})+'\\n');
}`);
  const result=f.start([],{env:{...f.env,NODE_OPTIONS:`${f.env.NODE_OPTIONS??''} --import=${hook}`}});
  assert.equal(result.status,0,result.stderr+result.stdout);
  assert.deepEqual(fs.readFileSync(receipt,'utf8').trim().split('\n').map(JSON.parse).map(r=>r.stage),['open','prepare','start','dispatch','worker']);
  assert.equal(promptCalls(f).length,1);
  const job=JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(job.stage,'complete');
  assert.equal(fs.existsSync(retirementOwnerLock(common)),false);
  assert.equal(fs.existsSync(retirementAllocationLock(common,'lane/'+job.lane)),false);
});
