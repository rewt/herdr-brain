import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {requireRecordCompatibility,requireRecordFileCompatibility} from '../lib/record-compatibility.mjs';
import {runRelease} from '../lib/releases.mjs';
import {transact} from '../lib/store.mjs';

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
    {type:'report.ingested',run:'R-1',seq:8},{type:'opaque.observation',pending:true,seq:11}];
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
  const marker=path.join(f.scratch,'selected-command-executed');
  fs.writeFileSync(path.join(f.bundle,'bin/org.mjs'),`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'executed');\n`);
  fs.writeFileSync(state,beforeObligations());reseal(f);
  fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),'{"release":"compatible"}\n');
  f.git('add','.herdr-release.json');f.git('commit','-qm','Select obligation compatibility fixture');
  transact(f.env.ORG_DIR,()=>({add:[{type:'report.available',run:'R-1'}]}));
  assert.throws(()=>runRelease('bin/org.mjs',[],{cwd:f.cwd,home:f.installationHome}),/obligation fold for report.available/);
  assert.equal(fs.existsSync(marker),false);
  fs.writeFileSync(state,current);reseal(f);
  assert.equal(runRelease('bin/org.mjs',[],{cwd:f.cwd,home:f.installationHome}),0);
  assert.equal(fs.readFileSync(marker,'utf8'),'executed');
});
