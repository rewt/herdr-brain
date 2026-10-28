import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fixture} from './dispatch-fixture.mjs';
import {preflightContinuation,initialCapacityRefusal,implementationChangeOutcome} from '../preflight.mjs';
import {createHash} from 'node:crypto';

function phase1Fixture(t,options={}){
  const f=fixture(t,{noticeRecipient:'supervisor-herdr',...options}),file=path.join(f.repo,'.lane.json'),config=JSON.parse(fs.readFileSync(file));
  // Detached worker briefs need an explicit review route and project exception address.
  config.routes.review={kind:'codex',model:'model-review',effort:'high'};
  fs.writeFileSync(file,JSON.stringify(config));
  return f;
}

async function driverResult(journal,{count=1,limit=60000}={}){
  const file=`${journal}.driver/results.jsonl`,until=Date.now()+limit;
  for(;;){
    const text=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
    // The append opens the file before writing. Only newline-terminated rows
    // are complete; a continuation must wait for its own row after older ones.
    const rows=text.slice(0,text.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(line=>JSON.parse(line));
    // The terminal row precedes completion publication and request cleanup.
    // Wait for both the owner lock and its arbitration ticket before retrying;
    // observing the row alone does not mean the original driver has released it.
    const held=fs.existsSync(journal+'.lock')||(fs.existsSync(journal+'.locks')&&fs.readdirSync(journal+'.locks').length>0);
    if(rows.length>=count&&!held)return rows.at(-1);
    if(Date.now()>=until){
      const log=`${journal}.driver.log`;
      assert.fail(`owned detached fixture needs ${count} complete terminal receipt(s); got ${rows.length}; request serialization held: ${held}; driver output: ${fs.existsSync(log)?fs.readFileSync(log,'utf8'):'<unavailable>'}`);
    }
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}

test('detached driver receipt reader waits for complete appends and retains terminal failure evidence',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'phase1-receipt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const journal=path.join(root,'request.json'),file=journal+'.driver/results.jsonl';fs.mkdirSync(journal+'.driver');
  const first={stage:'complete',exit_code:0},failed={stage:'worker',exit_code:1,error:'frozen request changed'};
  for(const prefix of ['',JSON.stringify(first).slice(0,-1)]){
    fs.writeFileSync(file,prefix);const pending=driverResult(journal);
    fs.appendFileSync(file,JSON.stringify(first).slice(prefix.length)+'\n');
    assert.deepEqual(await pending,first);
  }
  fs.appendFileSync(file,JSON.stringify(failed).slice(0,-1));const continued=driverResult(journal,{count:2});
  fs.appendFileSync(file,'}\n');assert.deepEqual(await continued,failed);
  fs.writeFileSync(file,'malformed completed row\n');await assert.rejects(driverResult(journal),SyntaxError);
  fs.writeFileSync(file,'');fs.writeFileSync(journal+'.driver.log','retained child stderr');
  await assert.rejects(driverResult(journal,{limit:0}),/got 0; request serialization held: false; driver output: retained child stderr/);
});

test('detached driver receipt reader waits for request cleanup after a terminal row without removing ownership evidence',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'phase1-cleanup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const journal=path.join(root,'request.json'),lock=journal+'.lock',directory=journal+'.locks',ticket=path.join(directory,'original');
  const failed={stage:'start',exit_code:1,native_launch_attempted:false,error:'injected prepare'};
  fs.mkdirSync(journal+'.driver');fs.mkdirSync(directory);fs.writeFileSync(lock,String(process.pid));fs.writeFileSync(ticket,'1');
  fs.writeFileSync(journal+'.driver/results.jsonl',JSON.stringify(failed)+'\n');
  await assert.rejects(driverResult(journal,{limit:0}),/got 1; request serialization held: true/);
  let resolved=false;const pending=driverResult(journal).then(result=>{resolved=true;return result;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(resolved,false,'terminal result does not release the request');
  assert.equal(fs.readFileSync(lock,'utf8'),String(process.pid));assert.equal(fs.readFileSync(ticket,'utf8'),'1');
  fs.unlinkSync(lock);
  await assert.rejects(driverResult(journal,{limit:0}),/got 1; request serialization held: true/);
  assert.equal(resolved,false,'the original arbitration ticket still owns the request');
  fs.unlinkSync(ticket);assert.deepEqual(await pending,failed,'cleanup preserves the original failure receipt');
});

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
  const f=phase1Fixture(t);f.fail('prepare');const first=f.start(['--detach']);assert.equal(first.status,0,first.stderr);const {journal}=JSON.parse(first.stdout),terminal=await driverResult(journal);assert.equal(terminal.native_launch_attempted,false);
  const launch=fs.readFileSync(journal+'.driver/launch.json'),original=JSON.parse(fs.readFileSync(journal));fs.unlinkSync(path.join(f.root,'fail'));
  const resumed=f.dispatch(['--retry',journal,'--continue-preflight']);assert.equal(resumed.status,0,resumed.stderr);assert.equal(JSON.parse(resumed.stdout).journal,journal);
  const terminalResumed=await driverResult(journal,{count:2});
  assert.equal(terminalResumed.stage,'complete',JSON.stringify(terminalResumed));assert.deepEqual(fs.readFileSync(journal+'.driver/launch.json'),launch);assert.equal(f.jobs().length,1);
  const continued=JSON.parse(fs.readFileSync(journal));
  for(const field of ['token','base','release','routeConfig'])assert.deepEqual(continued[field],original[field],`saved ${field} remains bound to the original request`);
  assert.equal(f.calls().filter(c=>c.type==='herdr'&&c.a[0]==='agent'&&c.a[1]==='prompt').length,1);
  assert.equal(f.dispatch(['--retry',journal,'--continue-preflight']).status,1,'native-attempted continuation cannot be replayed');
  assert.equal(f.calls().filter(c=>c.type==='herdr'&&c.a[0]==='agent'&&c.a[1]==='prompt').length,1);
});

test('phase1 detached native start keeps one original prompt and its record-only watcher while a fresh STOP prevents input',async t=>{
  for(const stopped of [false,true]){
    const f=phase1Fixture(t);
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
    const f=phase1Fixture(t,{lateSession:changed?'late':''}),prior=f.rec(['start',f.item,'--workspace',f.repo]).match(/^(R-\d+) started/m)[1],file=path.join(f.root,'original-blocked.md'),text=`---\nrun: ${prior}\noutcome: blocked\nsummary: Original immutable blocked report.\nblockers: []\n---\n`;
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
  const f=phase1Fixture(t);f.fail('prepare');
  const result=f.start(['--detach']);assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);
  assert.equal(receipt.result,'detached');assert.ok(receipt.journal);const saved=JSON.parse(fs.readFileSync(receipt.journal));assert.equal(saved.item,f.item);assert.equal(saved.detached,true);
  // The saved job owns recovery. The request is not submitted again by the line.
  assert.equal(fs.existsSync(receipt.journal),true);assert.equal(f.jobs().length,1);
  const finished=await driverResult(receipt.journal,{limit:20000});assert.equal(finished.exit_code,1);assert.equal(finished.native_launch_attempted,false);
});
