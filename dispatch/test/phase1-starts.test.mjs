import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './dispatch-fixture.mjs';
import {preflightContinuation,initialCapacityRefusal,implementationChangeOutcome} from '../preflight.mjs';
import {createHash} from 'node:crypto';

async function driverResult(journal){
  const file=`${journal}.driver/results.jsonl`,until=Date.now()+60000;
  while(!fs.existsSync(file)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(fs.existsSync(file),true,'owned detached fixture reaches a durable terminal receipt');
  return JSON.parse(fs.readFileSync(file,'utf8').trim());
}

test('permanent preflight continuation requires positive zero-native evidence and retains unknown refused foreign or spent attempts',t=>{
  const f=fixture(t),root=fs.realpathSync(new URL('../../',import.meta.url)),common=f.git(['rev-parse','--path-format=absolute','--git-common-dir']);
  const file=path.join(f.org,'dispatch','saved.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  const job={token:'saved',repo:f.repo,org:f.org,common,release:{root},reviewQueueProtocol:1,phase1_protocol:1,detached:true,detached_refused:true,stage:'start',run:null,worker:null,error:'loaded queue/dispatch implementation changed; wait for next real pass',native_launch_attempted:false};
  const save=value=>fs.writeFileSync(file,JSON.stringify(value));save(job);
  const args={journal:file,repo:f.repo,org:f.org,common,root,events:[]};assert.ok(preflightContinuation(args));
  for(const patch of [{native_launch_attempted:true},{native_launch_attempted:undefined},{worker:{agentName:'existing'}},{stage:'launching'},{run:'R-9'},{error:'EPERM native refusal'},{error:'native identity changed'},{release:{root:f.root}}]){save({...job,...patch});assert.equal(preflightContinuation(args),null,JSON.stringify(patch));}
  save(job);const proof=preflightContinuation(args);save({...job,preflightContinuations:[{capability:proof.capability}]});assert.equal(preflightContinuation(args),null);
  save({...job,native_launch_attempted:undefined});fs.mkdirSync(file+'.driver');fs.writeFileSync(file+'.driver/results.jsonl',JSON.stringify({journal:file,stage:'start',run:null,exit_code:1,native_launch_attempted:false,error:job.error})+'\n');assert.ok(preflightContinuation(args),'retained explicit terminal false is positive evidence for an older journal');
});

test('typed preflight capacity evidence permits unknown occupancy wording while actual native and ownership uncertainty remains stopped',t=>{
  const f=fixture(t),root=fs.realpathSync(new URL('../../',import.meta.url)),common=f.git(['rev-parse','--path-format=absolute','--git-common-dir']),journal=path.join(f.org,'dispatch/capacity.json');fs.mkdirSync(path.dirname(journal),{recursive:true});
  const reason='review cap 3 reached: unknown liveness and uncertain launch retain their slots',job={token:'capacity',repo:f.repo,org:f.org,common,release:{root},reviewQueueProtocol:1,stage:'open',run:null,native_launch_attempted:false,error:reason},save=value=>fs.writeFileSync(journal,JSON.stringify(value)),args={journal,repo:f.repo,org:f.org,common,root};
  save(job);assert.equal(preflightContinuation(args),null,'text alone cannot grant a continuation');
  const typed={kind:'capacity',code:'DISPATCH_REVIEW_CAP',stage:'open',native_launch_attempted:false};save({...job,failure:typed});const proof=preflightContinuation(args);assert.equal(proof.capacity,true);assert.ok(proof.key);save({...job,failure:typed,preflightContinuations:[{capability:proof.capability}]});assert.ok(preflightContinuation(args),'fresh final admission, not a source hash change, owns capacity continuation');
  for(const patch of [{native_launch_attempted:true},{native_launch_attempted:undefined},{worker:{agentName:'existing'}},{error:'EPERM native refusal'},{error:'native identity UNKNOWN'}]){save({...job,failure:typed,...patch});assert.equal(preflightContinuation(args),null);}
  save(job);const file=path.join(f.org,'line-service',createHash('sha256').update(JSON.stringify(common)).digest('hex').slice(0,20),'effects.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({identity:common,org:f.org,actions:{original:{receipt:{status:1,signal:null,stdout:JSON.stringify({result:'failed',code:'DISPATCH_REVIEW_CAP',reason,journal})}}}}));assert.ok(preflightContinuation(args),'actual retained typed source receipt works without rewriting the old journal');
  save({...job,native_launch_attempted:undefined});fs.mkdirSync(journal+'.driver');fs.writeFileSync(journal+'.driver/results.jsonl',JSON.stringify({journal,stage:'open',run:null,exit_code:1,code:'DISPATCH_REVIEW_CAP',error:reason,native_launch_attempted:null})+'\n');assert.equal(preflightContinuation(args),null,'unavailable launch knowledge stays null');
});

test('old implementation-change outcome is typed without broad text exemptions or converting TRUE and unknown native attempts to zero',t=>{
  const f=fixture(t),root=fs.realpathSync(new URL('../../',import.meta.url)),common=f.git(['rev-parse','--path-format=absolute','--git-common-dir']),journal=path.join(f.org,'dispatch/old-source.json');fs.mkdirSync(path.dirname(journal),{recursive:true});
  const job={token:'old-source',repo:f.repo,org:f.org,common,release:{root},reviewQueueProtocol:1,stage:'open',run:null,error:'loaded queue/dispatch implementation changed; wait for next real pass',native_launch_attempted:false},args={journal,repo:f.repo,org:f.org,common,root};
  fs.writeFileSync(journal,JSON.stringify(job));const result=preflightContinuation(args);assert.equal(result.journal,journal);assert.equal(result.outcome.kind,'implementation-changed');assert.equal(result.outcome.source,'exact-legacy-outcome');
  for(const flag of [true,null,undefined]){const changed={...job,native_launch_attempted:flag};fs.writeFileSync(journal,JSON.stringify(changed));assert.equal(preflightContinuation(args),null);assert.equal(implementationChangeOutcome(changed).native_launch_attempted,flag===true?true:null);}
  assert.equal(implementationChangeOutcome({...job,error:'another implementation changed UNKNOWN outcome'}),null);
  assert.equal(implementationChangeOutcome({...job,error:'typed diagnostic',failure:{code:'DISPATCH_IMPLEMENTATION_CHANGED'}}).source,'typed-failure');
});

test('typed initial capacity refusal accepts only a completed no-journal guard response and never a native or unknown launch',()=>{
  const entry={error:'capacity refused',receipt:{status:1,signal:null,stdout:JSON.stringify({result:'failed',code:'DISPATCH_REVIEW_CAP',reason:'unknown liveness retains capacity'})}};assert.ok(initialCapacityRefusal(entry));
  for(const value of [{...entry,receipt:{...entry.receipt,signal:'SIGTERM'}},{...entry,error:'EPERM native refusal'},{...entry,receipt:{...entry.receipt,status:null}},{...entry,receipt:{...entry.receipt,stdout:JSON.stringify({result:'failed',code:'DISPATCH_FAILED',reason:'UNKNOWN'})}},{...entry,receipt:{...entry.receipt,stdout:JSON.stringify({result:'failed',code:'DISPATCH_REVIEW_CAP',reason:'capacity',journal:'/original/request.json'})}}])assert.equal(initialCapacityRefusal(value),null);
});

test('permanent preflight continuation resumes one original detached request without replacing launch evidence or repeating native input',async t=>{
  const f=fixture(t);f.fail('prepare');const first=f.start(['--detach']);assert.equal(first.status,0,first.stderr);const {journal}=JSON.parse(first.stdout),terminal=await driverResult(journal);assert.equal(terminal.native_launch_attempted,false);
  const launch=fs.readFileSync(journal+'.driver/launch.json');fs.unlinkSync(path.join(f.root,'fail'));
  const resumed=f.dispatch(['--retry',journal,'--continue-preflight']);assert.equal(resumed.status,0,resumed.stderr);assert.equal(JSON.parse(resumed.stdout).journal,journal);
  const results=journal+'.driver/results.jsonl',until=Date.now()+60000;let rows=[];
  while(Date.now()<until){rows=fs.readFileSync(results,'utf8').trim().split('\n').map(JSON.parse);if(rows.length>=2&&rows.at(-1).stage==='complete')break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(rows.at(-1).stage,'complete',JSON.stringify(rows));assert.deepEqual(fs.readFileSync(journal+'.driver/launch.json'),launch);assert.equal(f.jobs().length,1);
  assert.equal(f.calls().filter(c=>c.type==='herdr'&&c.a[0]==='agent'&&c.a[1]==='prompt').length,1);
  assert.equal(f.dispatch(['--retry',journal,'--continue-preflight']).status,1,'native-attempted continuation cannot be replayed');
  assert.equal(f.calls().filter(c=>c.type==='herdr'&&c.a[0]==='agent'&&c.a[1]==='prompt').length,1);
});

test('phase1 detached native start keeps one original prompt and its record-only watcher while a fresh STOP prevents input',async t=>{
  for(const stopped of [false,true]){
    const f=fixture(t);
    if(stopped){const file=path.join(f.root,'bin/watch');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace("} else if(type==='watch') {", "} else if(type==='watch') {\n fs.mkdirSync(path.join(process.cwd(),'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(process.cwd(),'.lane/supervisor/STOP'),'fixture STOP after launch, before prompt');"));}
    const started=f.start(['--detach']);assert.equal(started.status,0,started.stderr);const receipt=JSON.parse(started.stdout),result=await driverResult(receipt.journal);
    const prompts=f.calls().filter(c=>c.type==='herdr'&&c.a[0]==='agent'&&c.a[1]==='prompt');
    assert.equal(prompts.length,stopped?0:1);
    if(stopped)assert.match(result.error,/STOP/);else{assert.equal(result.exit_code,0,JSON.stringify(result));assert.equal(result.stage,'complete');}
    assert.ok(f.calls().find(c=>c.type==='watch').a.includes('--record-only'));
  }
});

test('saved-phase frozen request ignores routine predecessor phase evidence but holds a genuinely changed task after native start without retrying its unknown session',async t=>{
  for(const changed of [false,true]){
    const f=fixture(t,{lateSession:changed?'late':''}),prior=f.rec(['start',f.item,'--workspace',f.repo]).match(/^(R-\d+) started/m)[1],file=path.join(f.root,'original-blocked.md'),text=`---\nrun: ${prior}\noutcome: blocked\nsummary: Original immutable blocked report.\nblockers: []\n---\n`;
    fs.writeFileSync(file,text);f.rec(['ingest',file,'--run',prior]);f.rec(['set',f.item,'title=Genuinely changed input']);const owner=f.show(prior).owner;
    const watch=path.join(f.root,'bin/watch'),record=new URL('../../bin/org.mjs',import.meta.url).pathname;
    const injection=changed?`const phase=spawnSync(process.execPath,[${JSON.stringify(record)},'set',${JSON.stringify(f.item)},'title=Another actual task change'],{stdio:['ignore','pipe','pipe']});if(phase.status)process.exit(phase.status);`:`for(const a of [['note',${JSON.stringify(prior)},'Bounded source phase42 PASS; full F2/live gaps remain.'],['set',${JSON.stringify(f.item)},'meta.phase_receipt=owned/phase-receipt.json']]){const phase=spawnSync(process.execPath,[${JSON.stringify(record)},...a],{stdio:['ignore','pipe','pipe']});if(phase.status)process.exit(phase.status);}`;
    fs.writeFileSync(watch,fs.readFileSync(watch,'utf8').replace("} else if(type==='watch') {","} else if(type==='watch') {\n"+injection));
    const result=f.start(['--detach']);assert.equal(result.status,0,result.stderr);const {journal}=JSON.parse(result.stdout),terminal=await driverResult(journal),job=JSON.parse(fs.readFileSync(journal));assert.equal(job.native_launch_attempted,true);assert.ok(job.watcher.pid);assert.deepEqual(f.show(prior).owner,owner);assert.equal(fs.readFileSync(file,'utf8'),text);assert.equal(f.show(prior).report.outcome,'blocked');
    assert.equal(fs.readFileSync(path.join(f.org,f.show(prior).report.file),'utf8'),text);
    if(changed){assert.match(terminal.error,/frozen request/);assert.equal(job.worker.agentSessionId,null);assert.equal(f.calls().filter(c=>c.type==='herdr'&&c.a[0]==='agent'&&c.a[1]==='prompt').length,0);assert.equal(preflightContinuation({journal,repo:f.repo,org:f.org,common:job.common,root:job.release.root,events:[]}),null);}
    else{assert.equal(terminal.exit_code,0,JSON.stringify(terminal));assert.equal(terminal.stage,'complete');assert.equal(f.calls().filter(c=>c.type==='herdr'&&c.a[0]==='agent'&&c.a[1]==='prompt').length,1);}
    assert.equal(f.jobs().length,1,'no replacement or second request');
  }
});

test('phase1 dispatch memory admission pauses only for proving and does not wait on low-memory ordering',t=>{
  const f=fixture(t),memory=path.join(f.root,'memory.json');fs.writeFileSync(memory,JSON.stringify({available:0,swap_used:1024**3}));f.fail('prepare');
  const result=f.start([],{env:{...f.env,TEST_MEMORY_FILE:memory}});assert.equal(result.status,1);assert.match(result.stderr,/injected prepare/);assert.doesNotMatch(result.stderr,/waiting; memory pressure/);
  assert.ok(f.calls().some(c=>c.type==='lane'&&c.a[0]==='open'));
});

test('phase1 detached start saves the original journal receipt before returning and does not replay on retry',async t=>{
  const f=fixture(t);f.fail('prepare');
  const result=f.start(['--detach']);assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);
  assert.equal(receipt.result,'detached');assert.ok(receipt.journal);const saved=JSON.parse(fs.readFileSync(receipt.journal));assert.equal(saved.item,f.item);assert.equal(saved.detached,true);
  // The saved job owns recovery. The request is not submitted again by the line.
  assert.equal(fs.existsSync(receipt.journal),true);assert.equal(f.jobs().length,1);
  const resultFile=`${receipt.journal}.driver/results.jsonl`,until=Date.now()+20000;
  while(!fs.existsSync(resultFile)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(fs.existsSync(resultFile),true,'owned detached fixture writes its terminal receipt before cleanup');
  const finished=JSON.parse(fs.readFileSync(resultFile,'utf8').trim());assert.equal(finished.exit_code,1);assert.equal(finished.native_launch_attempted,false);
});
