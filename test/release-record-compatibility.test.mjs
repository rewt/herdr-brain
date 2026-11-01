import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {requireRecordCompatibility,requireRecordFileCompatibility} from '../lib/record-compatibility.mjs';
import {runRelease} from '../lib/releases.mjs';
import {transact} from '../lib/store.mjs';
import {copyProduct} from '../lib/product-files.mjs';

function legacyObligations() {
  const result=spawnSync('git',['show','6dc33698bb52b0e398164c15e8030f7e71b76f72:lib/obligations.mjs'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(createHash('sha256').update(result.stdout).digest('hex'),'8f4e3cc3ce09ebf632d5a21b0eda28edf505e556480cb5044cf849e02d2b04f0');
  return result.stdout;
}

function beforeObligations() {
  const historical=spawnSync('git',['show','0976c9f3^:lib/state.mjs'],{encoding:'utf8'});
  assert.equal(historical.status,0,historical.stderr);
  assert.doesNotMatch(historical.stdout,/applyObligationEvent/);
  return historical.stdout;
}

function reseal(f) {
  const result=spawnSync(process.execPath,[path.resolve('herdr/releases.mjs'),'manifest',f.bundle,path.join(f.bundle,'.release-acceptance.json')],{env:f.env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
}

test('release admission refuses the historical stale acceptance fold before executing a command',t=>{
  const f=configFixture(t,{custom:true});
  const events=[{type:'item.added',id:'ENG-1',accept:['Original'],seq:1},
    {type:'item.acceptance-amended',id:'ENG-1',accept:['Current'],seq:2}];
  assert.equal(requireRecordCompatibility(f.bundle,events).through,2);
  const historical=spawnSync('git',['show','a96eaa9c47:lib/state.mjs'],{encoding:'utf8'});
  assert.equal(historical.status,0,historical.stderr);
  fs.writeFileSync(path.join(f.bundle,'lib/state.mjs'),historical.stdout);
  assert.throws(()=>requireRecordCompatibility(f.bundle,events),/record-incompatible:.*item.acceptance-amended/);
  // This is a synthetic, newly sealed fixture; no installed bundle is edited.
  const manifest=spawnSync(process.execPath,[path.resolve('herdr/releases.mjs'),'manifest',f.bundle,path.join(f.bundle,'.release-acceptance.json')],{env:f.env,encoding:'utf8'});
  assert.equal(manifest.status,0,manifest.stderr);
  fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),'{"release":"compatible"}\n');
  f.git('add','.herdr-release.json');f.git('commit','-qm','Select historical fold fixture');
  transact(f.env.ORG_DIR,()=>({add:events.map(({seq,...event})=>event)}));
  assert.throws(()=>runRelease('bin/org.mjs',['show','ENG-1'],{cwd:f.cwd,home:f.installationHome}),/record-incompatible:.*item.acceptance-amended/);
});

test('unrecognized core events and fold layouts refuse while opaque subsystem receipts remain readable',t=>{
  const f=configFixture(t,{custom:true});
  assert.throws(()=>requireRecordCompatibility(f.bundle,[{type:'item.future-contract',seq:3}]),/record-incompatible/);
  assert.deepEqual(requireRecordCompatibility(f.bundle,[{type:'line-service.runtime-upgraded',seq:4}]).required_types,[]);
  fs.writeFileSync(path.join(f.bundle,'lib/state.mjs'),'export const fold = () => ({});\n');
  assert.throws(()=>requireRecordCompatibility(f.bundle,[]),/unknown fold contract/);
});

test('session hook selects installed resolvers ahead of a development canary',t=>{
  const f=configFixture(t,{custom:true}),installed=path.join(f.home,'.local/bin'),canary=path.join(f.home,'.local/share/herdr-monitor/canary/bin');
  fs.mkdirSync(installed,{recursive:true});fs.mkdirSync(canary,{recursive:true});
  for(const [dir,label] of [[installed,'installed'],[canary,'development']])
    fs.writeFileSync(path.join(dir,'record'),`#!/bin/sh\nprintf '${label}\\n'\n`,{mode:0o755});
  const file=path.join(f.scratch,'session-env');
  const hook=spawnSync('/bin/sh',[path.resolve('herdr/canary-env.sh')],{env:{...f.env,CLAUDE_ENV_FILE:file},encoding:'utf8'});
  assert.equal(hook.status,0,hook.stderr);
  const result=spawnSync('/bin/sh',['-c','. "$1"; record','session',file],{env:{...f.env,PATH:canary+':/usr/bin:/bin'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'installed');
});

test('streaming admission preserves decision-reader receipts and refuses a torn or incompatible tail',t=>{
  const f=configFixture(t,{custom:true}),file=path.join(f.scratch,'record.jsonl');
  const events=[{type:'decision.restart',seq:1},{type:'decision.consequence',seq:2},
    {type:'item.added',id:'ENG-1',title:'Unicode '+ 'é'.repeat(40000),seq:3},
    {type:'item.acceptance-amended',id:'ENG-1',accept:['Current'],seq:4}];
  fs.writeFileSync(file,events.map(JSON.stringify).join('\n')+'\n');
  assert.deepEqual(requireRecordFileCompatibility(f.bundle,file),requireRecordCompatibility(f.bundle,events));
  fs.appendFileSync(file,'{"type":');
  assert.throws(()=>requireRecordFileCompatibility(f.bundle,file),/incomplete record/);
  fs.writeFileSync(file,JSON.stringify({type:'item.future',seq:5})+'\n');
  assert.throws(()=>requireRecordFileCompatibility(f.bundle,file),/record-incompatible:.*item.future/);
});

test('historical switch-only targets refuse delegated obligations, including completions and shared core cases',t=>{
  const f=configFixture(t,{custom:true}),state=path.join(f.bundle,'lib/state.mjs');
  fs.writeFileSync(state,beforeObligations());
  // Neither an ordinary subject nor an opaque receipt needs the new delegate.
  assert.deepEqual(requireRecordCompatibility(f.bundle,[{type:'item.added',id:'ENG-1',seq:1},
    {type:'run.started',id:'R-1',item:'ENG-1',seq:2},{type:'line-service.runtime-upgraded',seq:3}]).required_types,
    ['item.added','run.started']);
  const events=[
    {type:'report.available',run:'R-1'},
    {type:'report.ingested',run:'R-1'},
    {type:'report.ingested',run:'R-1',report:{outcome:'done'}},
    {type:'change.landed',run:'R-1'},
    {type:'closeout.binding-kept',run:'R-1'},
    {type:'closeout.evaluated'},
    {type:'closeout.waiting'},
    {type:'closeout.producer-status'},
    {type:'closeout.wait-classified'},
    {type:'closeout.effect',intent:'original'},
    {type:'closeout.effect',outcome:{action:'agent-exit-requested'}},
    {type:'closeout.command-failed',intent:'original'},
    {type:'closeout.command-not-started',intent:'original'},
    {type:'closeout.exit-settled',intent:'original'},
    {type:'dispatch.completed',run:'R-1'},
    {type:'run.started',id:'R-1',meta:{dispatch_attempt:'original'}},
    {type:'item.added',id:'REV-1',meta:{review_source_run:'R-1'}},
    {type:'item.closed',id:'ENG-1',completed_run:'R-1'},
    {type:'opaque.observation',closeout_targets:[{common:'project',key:'lane',run:'R-1'}]},
    {type:'opaque.observation',closeout_binding_errors:[{run:'R-1'}]},
    {type:'opaque.observation',pending:true},
    {type:'future.waiting'},
    {type:'future.requested'},
  ];
  for(const event of events) {
    const captured={...event,seq:17};
    assert.throws(()=>requireRecordCompatibility(f.bundle,[captured]),error=>{
      assert.match(error.message,/record-incompatible:.*obligation fold/);
      assert.ok(error.message.includes(event.type),error.message);
      assert.match(error.message,/first sequence 17/);return true;
    },JSON.stringify(captured));
  }
});

test('streaming admission recovers the same delegated event capture with a matching actual fold',t=>{
  const f=configFixture(t,{custom:true}),state=path.join(f.bundle,'lib/state.mjs'),current=fs.readFileSync(state,'utf8');
  const file=path.join(f.scratch,'obligation-record.jsonl');
  const events=[{type:'line-service.runtime-upgraded',seq:1},{type:'report.available',run:'R-1',seq:5},
    {type:'report.ingested',run:'R-1',report:{outcome:'done'},seq:8},{type:'opaque.observation',pending:true,seq:11}];
  fs.writeFileSync(file,events.map(JSON.stringify).join('\n')+'\n');
  fs.writeFileSync(state,beforeObligations());
  assert.throws(()=>requireRecordFileCompatibility(f.bundle,file),/obligation fold for report.available.*first sequence 5/);
  fs.writeFileSync(state,current);
  const admitted=requireRecordFileCompatibility(f.bundle,file);
  assert.deepEqual(admitted,requireRecordCompatibility(f.bundle,events));
  assert.equal(admitted.through,11);
  assert.deepEqual(admitted.required_types,['opaque.observation','report.available','report.ingested']);
});

test('delegate admission checks actual wiring and source, leaving unfamiliar target code unexecuted',t=>{
  const f=configFixture(t,{custom:true}),state=path.join(f.bundle,'lib/state.mjs'),current=fs.readFileSync(state,'utf8');
  const helper=path.join(f.bundle,'lib/obligations.mjs'),original=fs.readFileSync(helper,'utf8');
  const events=[{type:'report.available',run:'R-1',seq:1}];
  fs.writeFileSync(state,current.replace('  applyObligationEvent(s, e);',''));
  assert.throws(()=>requireRecordCompatibility(f.bundle,events),/obligation fold for report.available/);
  fs.writeFileSync(state,current.replace('obligations: new Map()','other: new Map()'));
  assert.throws(()=>requireRecordCompatibility(f.bundle,events),/unknown obligation fold contract/);
  fs.writeFileSync(state,current.replace('  applyObligationEvent(s, e);','  anotherFold(s, e);'));
  assert.throws(()=>requireRecordCompatibility(f.bundle,[]),/unknown fold contract/);
  fs.writeFileSync(state,current.replace('  s.lastAt = e.at;','  anotherFold(s, e);\n  s.lastAt = e.at;'));
  assert.throws(()=>requireRecordCompatibility(f.bundle,[]),/unknown fold contract/);
  fs.writeFileSync(state,current);
  const marker=path.join(f.scratch,'target-module-executed');
  fs.writeFileSync(helper,original+`\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'executed');\n`);
  assert.throws(()=>requireRecordCompatibility(f.bundle,events),/obligation fold for report.available/);
  assert.equal(fs.existsSync(marker),false);
  fs.unlinkSync(helper);
  assert.throws(()=>requireRecordCompatibility(f.bundle,events),/unreadable obligation fold contract/);
  fs.writeFileSync(helper,original);
  assert.equal(requireRecordCompatibility(f.bundle,events).through,1);
});

test('selected release command stays unexecuted on obligation refusal and runs after fixture recovery',t=>{
  const f=configFixture(t,{custom:true}),state=path.join(f.bundle,'lib/state.mjs'),current=fs.readFileSync(state,'utf8');
  const helper=path.join(f.bundle,'lib/obligations.mjs'),legacy=legacyObligations();
  const marker=path.join(f.scratch,'selected-command-executed');
  fs.writeFileSync(path.join(f.bundle,'bin/org.mjs'),`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'executed');\n`);
  fs.writeFileSync(state,beforeObligations());reseal(f);
  fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),'{"release":"compatible"}\n');
  f.git('add','.herdr-release.json');f.git('commit','-qm','Select obligation compatibility fixture');
  transact(f.env.ORG_DIR,()=>({add:[{type:'report.available',run:'R-1'}]}));
  assert.throws(()=>runRelease('bin/org.mjs',[],{cwd:f.cwd,home:f.installationHome}),/obligation fold for report.available/);
  assert.equal(fs.existsSync(marker),false);
  fs.writeFileSync(state,current);fs.writeFileSync(helper,legacy);reseal(f);
  assert.equal(runRelease('bin/org.mjs',[],{cwd:f.cwd,home:f.installationHome}),0);
  assert.equal(fs.readFileSync(marker,'utf8'),'executed');
});

test('obligation capability recognizes actual legacy and current contracts per event and payload',t=>{
  const f=configFixture(t,{custom:true}),helper=path.join(f.bundle,'lib/obligations.mjs');
  const current=fs.readFileSync(helper,'utf8'),legacy=legacyObligations();
  assert.notEqual(current,legacy);
  const events=[
    {type:'report.available',run:'R-1'}, {type:'report.ingested',run:'R-1',report:{outcome:'done'}},
    {type:'change.landed',run:'R-1'}, {type:'item.added',id:'REV-1',meta:{review_source_run:'R-1'}},
    {type:'run.started',id:'R-1',meta:{dispatch_attempt:'original'}}, {type:'dispatch.completed',run:'R-1'},
    {type:'item.closed',id:'ENG-1',completed_run:'R-1'}, {type:'item.reopened',id:'ENG-1'},
    {type:'closeout.binding-kept'}, {type:'closeout.evaluated'}, {type:'closeout.waiting'},
    {type:'closeout.producer-status'}, {type:'closeout.wait-classified'},
    {type:'closeout.effect',outcome:{action:'agent-exit-requested'}},
    ...['closeout.effect','closeout.command-failed','closeout.command-not-started','closeout.exit-settled'].map(type=>({type,intent:'original'})),
    {type:'opaque.receipt',closeout_targets:[{common:'project',key:'lane'}]},
    {type:'opaque.receipt',closeout_binding_errors:[{run:'R-1'}]},
    {type:'opaque.receipt',pending:true}, {type:'future.waiting'}, {type:'future.requested'},
  ].map((e,i)=>({...e,seq:i+1}));
  for(const source of [legacy,current]) {
    fs.writeFileSync(helper,source);
    for(const event of events) assert.equal(requireRecordCompatibility(f.bundle,[event]).through,event.seq,JSON.stringify(event));
    assert.equal(requireRecordCompatibility(f.bundle,events).through,events.length);
  }
  // A known digest is not blanket admission of new core contracts.
  fs.writeFileSync(helper,legacy);
  assert.throws(()=>requireRecordCompatibility(f.bundle,[...events,{type:'item.future',seq:99}]),/item.future.*first sequence 99/);
  for(const field of ['closeout_targets','closeout_binding_errors'])
    assert.throws(()=>requireRecordCompatibility(f.bundle,[{type:'opaque.receipt',[field]:{},seq:37}]),/payload contract.*first sequence 37/);
});

test('obligation capability refuses missing specialized source despite generic retention and leaves target code unexecuted',t=>{
  const f=configFixture(t,{custom:true}),helper=path.join(f.bundle,'lib/obligations.mjs'),legacy=legacyObligations();
  const marker=path.join(f.scratch,'untrusted-helper-ran');
  for(const [from,to,event] of [
    ["e.type === 'report.available'","e.type === 'other.available'",{type:'report.available',pending:true}],
    ['e.closeout_targets','e.other_targets',{type:'opaque.receipt',closeout_targets:[{key:'k'}],pending:true}],
    ['e.closeout_binding_errors','e.other_errors',{type:'opaque.receipt',closeout_binding_errors:[{run:'R-1'}],pending:true}],
  ]) {
    fs.writeFileSync(helper,legacy.replaceAll(from,to));
    assert.throws(()=>requireRecordCompatibility(f.bundle,[{type:'opaque.receipt',seq:1},{...event,seq:17}]),/obligation fold.*first sequence 17/);
  }
  fs.writeFileSync(helper,legacy+`\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');\n`);
  assert.throws(()=>requireRecordCompatibility(f.bundle,[{type:'future.waiting',seq:29}]),/first sequence 29/);
  assert.equal(fs.existsSync(marker),false);
  const state=path.join(f.bundle,'lib/state.mjs'),source=fs.readFileSync(state,'utf8');
  fs.writeFileSync(state,source.replace("import { applyObligationEvent } from './obligations.mjs';",''));
  assert.throws(()=>requireRecordCompatibility(f.bundle,[]),/unknown obligation fold contract/);
});

test('obligation capability keeps old profiles across canonical changes but refuses new requirements on old names and generic fallback',t=>{
  const f=configFixture(t,{custom:true}),canonical=path.join(f.scratch,'canonical');
  copyProduct(path.resolve(import.meta.dirname,'..'),canonical);
  fs.writeFileSync(path.join(f.bundle,'lib/obligations.mjs'),legacyObligations());
  // Only canonical implementation bytes move; frozen target and profiles stay.
  fs.appendFileSync(path.join(canonical,'lib/obligations.mjs'),'\n// Compatible canonical implementation revision.\n');
  const run=events=>{
    const script=`import {requireRecordCompatibility as admit} from ${JSON.stringify(pathToFileURL(path.join(canonical,'lib/record-compatibility.mjs')).href)};
      try{console.log(JSON.stringify(admit(${JSON.stringify(f.bundle)},${JSON.stringify(events)})))}catch(e){console.log(JSON.stringify({error:e.message}))}`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:f.env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  assert.equal(run([{type:'report.available',seq:3}]).through,3);
  const requirements=path.join(canonical,'lib/obligation-capabilities.mjs');
  fs.writeFileSync(requirements,fs.readFileSync(requirements,'utf8').replace('const required = [];',
    "const required = []; if (e.type === 'future.waiting' || e.type === 'report.available' && e.contract === 2) required.push('specialized.future/v2');"));
  for(const source of [legacyObligations(),fs.readFileSync(path.resolve('lib/obligations.mjs'),'utf8')]) {
    fs.writeFileSync(path.join(f.bundle,'lib/obligations.mjs'),source);
    for(const event of [{type:'future.waiting'},{type:'report.available',contract:2}]) {
      const result=run([{type:'opaque.receipt',seq:1},{...event,seq:41}]);
      assert.match(result.error,/specialized.future\/v2.*first sequence 41/);
    }
  }
});

test('obligation capability file and one-shot iterable admission agree with bounded scratch state and torn-tail refusal',t=>{
  const f=configFixture(t,{custom:true}),file=path.join(f.scratch,'stream.jsonl');
  fs.writeFileSync(path.join(f.bundle,'lib/obligations.mjs'),legacyObligations());
  const count=20000;
  function* events(){for(let seq=1;seq<=count;seq++)yield {type:'report.ingested',run:`R-${seq}`,report:{outcome:'done'},seq};}
  const fd=fs.openSync(file,'w');try{for(const e of events())fs.writeSync(fd,JSON.stringify(e)+'\n');}finally{fs.closeSync(fd);}
  const iterable=events(),admitted=requireRecordCompatibility(f.bundle,iterable);
  assert.equal(iterable.next().done,true);assert.equal(admitted.through,count);
  assert.deepEqual(requireRecordFileCompatibility(f.bundle,file),admitted);
  fs.appendFileSync(file,'{"type":"report.available"');
  assert.throws(()=>requireRecordFileCompatibility(f.bundle,file),/incomplete record/);
});

test('obligation capability historical reconciliation preserves original identity and guarded consumers across both profiles',async t=>{
  const stamp=events=>events.map((e,i)=>({seq:i+1,at:'2026-10-31T12:00:00Z',by:'fixture',...e}));
  const project='/synthetic/.git',hash='d'.repeat(64),base='a'.repeat(40),head='b'.repeat(40);
  const start=[{type:'item.added',id:'ENG-1',role:'engineer',title:'worker'},
    {type:'run.started',id:'R-1',item:'ENG-1',meta:{dispatch_project:project}},
    {type:'run.claimed',run:'R-1',owner:{controller:'brain'}}];
  const report={type:'report.ingested',run:'R-1',sha256:hash,file:'report.md',report:{outcome:'done'}};
  const landing={type:'change.landed',run:'R-1',item:'ENG-1',project,head,base,
    source:{run:'R-1',claim_generation:3},producer:{ownership_generation:3}};
  const queue={type:'item.added',id:'REV-1',role:'reviewer',meta:{review_source_run:'R-1',review_source_item:'ENG-1',review_round_cap:1,
    review_target:{head,base,reportHash:hash,source_group:{run:'R-1',owned_commits:[head]}}}};
  const sources=[legacyObligations(),fs.readFileSync(path.resolve('lib/obligations.mjs'),'utf8')];
  for(const [index,source] of sources.entries()) {
    const f=configFixture(t,{custom:true});fs.writeFileSync(path.join(f.bundle,'lib/obligations.mjs'),source);
    const {fold,extendFold}=await import(pathToFileURL(path.join(f.bundle,'lib/state.mjs')).href);
    const {closeoutWaitState,closeoutNextStage}=await import(pathToFileURL(path.join(f.bundle,'lib/closeout-status.mjs')).href);
    const {unresolvedCloseoutEffect}=await import(pathToFileURL(path.join(f.bundle,'lib/closeout.mjs')).href);
    const row=(s,kind)=>[...s.obligations.values()].find(r=>r.kind===kind);
    const available={type:'report.available',run:'R-1',file:report.file,started_seq:2,claim_generation:3};
    const history=stamp([...start,{...available,sha256:'draft'},{...available,sha256:hash},landing,queue,report]);
    requireRecordCompatibility(f.bundle,history);
    const s=fold(history),intakes=[...s.obligations.values()].filter(r=>r.kind==='report-intake');
    assert.equal(intakes[0].report.sha256,'draft');assert.equal(intakes[0].outcome,null);
    assert.equal(intakes[0].supported,index===0); // Status repair, not a reading contract change.
    assert.equal(intakes[1].claim_generation,3);assert.equal(intakes[1].started_seq,2);
    assert.equal(intakes[1].outcome.result.sha256,hash);
    const review=row(s,'review-handoff'),first=structuredClone(review.outcome);
    assert.deepEqual(review.landings[0].binding,landing.source);
    assert.equal(review.outcome.result.review_item,'REV-1');assert.equal(review.supported,index===1);
    const later=stamp([{...landing,head:'c'.repeat(40)},{...queue,id:'REV-2',meta:{...queue.meta,review_target:{head,base,reportHash:'wrong'}}}])
      .map((e,i)=>({...e,seq:history.length+i+1}));
    extendFold(s,later);assert.deepEqual(review.outcome,first);assert.equal(review.queues[1].accepted,false);
    assert.deepEqual(review.uncovered_heads,['c'.repeat(40)]);

    const worker={kind:'worker-report',run:'R-1',claim:3};
    const workerHistory=stamp([...start,{type:'closeout.waiting',identity:project,key:'worker-lane',source:{seq:1,type:'item.added'},
      wait_id:'worker-wait',revision:3,waiting:{owner:'worker-report',producers:[worker]}},report,
      {type:'closeout.producer-status',identity:project,key:'worker-lane',source:{seq:1,type:'item.added'},wait_id:'worker-wait',
        producer:worker,status:'complete',completion:{type:'report.ingested',seq:5}}]);
    requireRecordCompatibility(f.bundle,workerHistory);
    const workerState=fold(workerHistory),workerWait=row(workerState,'closeout-wait');
    assert.equal(Boolean(workerWait.outcome),index===0); // Old status can finish BEFORE parent observation.
    assert.equal(closeoutWaitState(workerHistory[3],workerHistory),'complete');
    extendFold(workerState,[{type:'closeout.evaluated',identity:project,key:'worker-lane',source:{seq:1,type:'item.added'},completed:true,seq:7}]);
    assert.ok(workerWait.outcome);

    // Historical/prose closure is not an original conditional-completion result.
    const closed=stamp([...start,{type:'item.closed',id:'ENG-1',as:'done'},report]);
    requireRecordCompatibility(f.bundle,closed);
    const completed=fold(closed),completion=row(completed,'source-completion');
    assert.equal(completion.outcome,null);assert.equal(completion.supported,index===0);
    extendFold(completed,stamp([{type:'item.reopened',id:'ENG-1'},{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}])
      .map((e,i)=>({...e,seq:closed.length+i+1})));
    assert.equal(completion.outcome.result.completed_run,'R-1');
    const completionResult=structuredClone(completion.outcome);
    extendFold(completed,[{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1',seq:99}]);
    assert.deepEqual(completion.outcome,completionResult);

    const target={common:project,key:'lane',run:'R-1'},ref={seq:4,type:'cleanup.bound'},scope={identity:project,key:'lane',source:ref,run:'R-1'};
    const producer={kind:'native-command',key:'lane',source:ref,intent:'original-intent',action:'agent-exit-requested',pane:'pane',terminal:'terminal',session:'session'};
    const intent={type:'closeout.effect',...scope,effect:producer.intent,producer:'native-closeout/v2',
      outcome:{action:producer.action,pane:'pane',occupant:['worker','codex','pane','workspace','/synthetic/lane','terminal','session']}};
    const wait={type:'closeout.waiting',...scope,wait_id:'wait',revision:4,waiting:{owner:'original-closer',producers:[producer]}};
    const status={type:'closeout.producer-status',...scope,wait_id:'wait',producer};
    const unknown=stamp([...start,{type:'cleanup.bound',closeout_targets:[target]},intent,wait,
      {type:'closeout.command-failed',...scope,intent:producer.intent,failure:{kind:'unknown',code:'OUTCOME_UNKNOWN'}},
      {...status,status:'failed',completion:{type:'closeout.command-failed',seq:7}},
      {type:'closeout.evaluated',...scope,completed:true}]);
    const entry={common:project,key:'lane',source:ref},prior={completed:false,revision:4,reason:'unresolved native intent'};
    const pending=fold(unknown);
    assert.equal(row(pending,'native-outcome').outcome,null);assert.equal(row(pending,'closeout-wait').outcome,null);
    assert.equal(closeoutWaitState(unknown[5],unknown),'failed');
    assert.deepEqual(unresolvedCloseoutEffect(entry,unknown),intent.outcome);
    assert.equal(closeoutNextStage(entry,prior,unknown),undefined);
    const disposition=stamp([...unknown,{type:'closeout.command-not-started',...scope,intent:producer.intent,native_started:false},
      {...status,status:'complete',completion:{type:'closeout.command-not-started',seq:10}}]);
    requireRecordCompatibility(f.bundle,disposition);
    const disposed=fold(disposition),native=row(disposed,'native-outcome'),waiting=row(disposed,'closeout-wait');
    assert.equal(native.attempt,producer.intent);assert.deepEqual(native.original,intent.outcome);
    assert.equal(native.outcome.result.state,'never-started');assert.equal(Boolean(waiting.outcome),index===1);
    // The existing consumer validates exact original completion, regardless of
    // compact wait status; a replacement intent and recorded refusal stay held.
    assert.equal(closeoutWaitState(disposition[5],disposition),'complete');
    const wrong=structuredClone(disposition);wrong[9].intent='replacement';
    assert.equal(closeoutWaitState(wrong[5],wrong),'failed');
    assert.deepEqual(unresolvedCloseoutEffect(entry,wrong),intent.outcome);
    const fence={type:'closeout.command-failed',...scope,intent:producer.intent,seq:12,failure:{kind:'fence',code:'EACCES'}};
    const result=structuredClone(native.outcome);extendFold(disposed,[fence]);
    assert.deepEqual(native.outcome,result);assert.equal(closeoutNextStage(entry,prior,[...disposition,fence]),undefined);

    // The conditional close consumer also reads original history: even when a
    // compact completion looks supported, reopening needs owner judgment.
    transact(f.env.ORG_DIR,()=>({add:[...start,report,{type:'item.closed',id:'ENG-1',as:'done'}]}));
    transact(f.env.ORG_DIR,()=>({add:[{type:'item.reopened',id:'ENG-1'}]}));
    const cli=spawnSync(process.execPath,[path.join(f.bundle,'bin/org.mjs'),'close','ENG-1','--if-current-run','R-1'],{cwd:f.cwd,env:f.env,encoding:'utf8'});
    assert.notEqual(cli.status,0);assert.match(cli.stderr,/reopened after completion.*conditional close needs supervisor judgment/);
  }
});
