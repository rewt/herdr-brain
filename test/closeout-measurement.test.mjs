import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {measureCloseouts,closeoutCohort,recordCloseoutTurn,measurementDirectory,collectCloseoutInventory} from '../line-service/closeout-measurement.mjs';

function fixture(){
  const project={identity:'/fixture/project/.git',canonical:'/fixture/project'},org='/fixture/record',cwd='/fixture/lane',source={commit:'a'.repeat(40),module_sha256:'b'.repeat(64)},events=[];
  const add=e=>{const row={seq:events.length+1,at:new Date(100000+events.length*1000).toISOString(),by:'line-service',...e};events.push(row);return row;};
  add({type:'item.added',id:'ENG-1',title:'Work',role:'engineer'});
  add({type:'run.started',id:'R-1',item:'ENG-1',workspace:cwd,meta:{harness:'codex',dispatch_project:project.identity}});
  add({type:'run.claimed',run:'R-1',owner:{controller:'brain'}});
  add({type:'run.updated',id:'R-1',meta:{agent:'worker',pane:'w1:p1',worker_workspace:'w1',terminal_id:'term-1',agent_session_id:'session-1'}});
  add({type:'report.available',run:'R-1',item:'ENG-1',sha256:'hash',project:project.identity,started_seq:2,claim_generation:3,producer:'original-report-watcher',observed_at:new Date(103000).toISOString()});
  const report=add({type:'report.ingested',run:'R-1',item:'ENG-1',sha256:'hash',report:{outcome:'done'}}),scope={seq:report.seq,type:report.type};
  report.closeout_targets=[{key:'key',common:project.identity,org,run:'R-1',cwd,branch:'lane/work',head:'head'}];
  const effects=['closed','worktree-removed','branch-kept','report-evidence'].map((action,i)=>add({type:'closeout.effect',identity:project.identity,run:'R-1',item:'ENG-1',key:'key',source:scope,effect:`effect-${i}`,outcome:{action,cwd,branch:'lane/work',head:'head'}}));
  const resources=Object.fromEntries(['session','folder','branch','author_packet'].map((name,i)=>[name,{status:['closed','removed','retained','preserved'][i],receipt:{seq:effects[i].seq,effect:effects[i].effect},...(name==='author_packet'?{packet:'packet',sha256:'sha'}:{})}]));
  add({type:'closeout.evaluated',identity:project.identity,run:'R-1',key:'key',source:scope,resources,code:{code:{commit:source.commit}},completed:true});
  const inventory={coverage:{native:true,git:true,process:true},errors:[],agents:[],panes:[],worktrees:[],folders:[{cwd,present:false}],processes:[]},historical=[{id:'original',cutoff:{seq:6},members:[{run:'R-1'}]}];
  const args={project,org,events,inventory,source,historical,now:120000};
  return{...args,args,add,report,resources,effects,measure:extra=>measureCloseouts({...args,...extra})};
}

test('exact receipts produce sliced clocks and preserve an empty slice as no evidence',()=>{
  const f=fixture(),doc=f.measure();
  assert.equal(doc.green,true,JSON.stringify(doc));assert.equal(doc.aggregate.denominator,1);assert.equal(doc.aggregate.accounted,1);
  assert.equal(doc.aggregate.latency.ingest.p95_ms,2000);assert.equal(doc.aggregate.latency.first_disposition.p95_ms,7000);
  assert.equal(doc.slices.find(s=>s.project===f.project.identity&&s.harness==='claude'&&s.dispatch==='line').evidence,false);
  assert.equal(doc.cohort[0].effect_receipts.length,4);assert.equal(doc.historical[0].rows.length,1);
});

test('oracle: a manual close or unexplained absence cannot improve the result',()=>{
  const f=fixture();assert.equal(f.measure().green,true);
  f.effects[0].outcome.action='manual-close';
  f.add({type:'closeout.manual-assistance',run:'R-1',project:f.project.identity,resource:'session',evidence:'injected supervisor hand close'});
  const doc=f.measure();assert.equal(doc.green,false);assert.equal(doc.aggregate.counts.manual_cleanup,1);assert.equal(doc.aggregate.counts.unexplained_disappearance,1);
  assert.ok(doc.cohort[0].failures.includes('resource-proof-incomplete'));
});

test('oracle: missing native, Git or process inventory independently prevents green',()=>{
  for(const kind of ['native','git','process']){const f=fixture();f.inventory.coverage[kind]=false;const doc=f.measure();assert.equal(doc.green,false);assert.ok(doc.failures.includes(`${kind}-inventory-incomplete`));assert.equal(doc.aggregate.denominator,1);}
});

test('oracle: a false refusal stays visible and cannot exclude the held allocation',()=>{
  const f=fixture();f.events.at(-1).condition={schema:'closeout-condition/v1',kind:'native-refusal',reason:'not a native refusal'};
  f.resources.session={status:'kept',reason:'not a native refusal'};
  const doc=f.measure();assert.equal(doc.green,false);assert.equal(doc.aggregate.denominator,1);assert.ok(doc.cohort[0].failures.includes('refusal-evidence-unproven'));
});

test('oracle: excluding the historical or current cohort never turns the original denominator green',()=>{
  const f=fixture();assert.equal(f.measure().green,true);
  const excluded=f.measure({cohort:[]});assert.equal(excluded.green,false);assert.equal(excluded.aggregate.denominator,1);assert.equal(excluded.exclusions.omitted.length,1);
  const history=f.measure({historical:[{id:'guarded',members:[{run:'R-missing'}]}]});assert.equal(history.green,false);assert.ok(history.failures.includes('historical-cohort-unaccounted'));
});

test('missing watcher origin is UNKNOWN; hashes, claims and starts cannot borrow another clock',()=>{
  for(const field of ['sha256','claim_generation','started_seq','producer']){
    const f=fixture();f.events.find(e=>e.type==='report.available')[field]='wrong';const doc=f.measure();assert.equal(doc.green,false);assert.equal(doc.cohort[0].availability,null);assert.equal(doc.aggregate.latency.ingest.unknown,1);
  }
});

test('every final outcome, abandonment and failed dispatch stays in the cohort including unknown origin',()=>{
  const f=fixture();for(const outcome of ['blocked','failed','needs_human'])f.add({type:'report.ingested',run:'R-1',sha256:outcome,report:{outcome}});
  f.add({type:'run.abandoned',id:'R-1'});f.add({type:'dispatch.completed',run:null,project:f.project.identity,exit_code:1,attempt:'failed-before-run'});
  const rows=closeoutCohort(f.events,f.project);assert.equal(rows.length,6);assert.equal(new Set(rows.map(r=>r.id)).size,6);assert.equal(rows.at(-1).harness,'unknown');assert.equal(f.measure().green,false);
});

test('first turn accounting cannot be repaired retrospectively; holds retain oldest origin and absolute counts',()=>{
  const f=fixture(),first=f.events.at(-1);delete first.resources;
  f.add({...first,seq:f.events.length+1,resources:f.resources,at:new Date(115000).toISOString()});
  assert.equal(f.measure().aggregate.accounted,0);
  f.inventory.agents.push({pane_id:'w1:p1',terminal_id:'term-1',cwd:'/fixture/lane'});f.inventory.worktrees.push({worktree:'/fixture/lane',clean:true});f.inventory.folders[0].present=true;
  const old=f.measure({now:8000000});assert.equal(old.aggregate.counts.open_over_2h,1);assert.equal(old.aggregate.counts.clean_retained,1);assert.equal(old.cohort[0].age_ms,7897000);
});

test('cadence, source change, incomplete record, empty history and old runtime reset proof truth',()=>{
  const f=fixture(),previous=f.measure();
  assert.equal(f.measure({previous,now:180001}).green,false);
  assert.ok(f.measure({previous,source:{...f.source,commit:'new'}}).failures.includes('source-or-record-window-changed'));
  const old=f.measure({source:{...f.source,commit:'different'}});assert.ok(old.cohort[0].failures.includes('old-or-unknown-runtime'));
  assert.equal(f.measure({events:f.events.slice(1)}).green,false);assert.equal(f.measure({historical:[]}).green,false);
});

test('collector retains independent source failures with no native mutation command',()=>{
  const f=fixture(),calls=[];
  const inventory=collectCloseoutInventory({...f.args,command:(exe,args)=>{calls.push([exe,args]);return{status:1,stderr:'injected source unavailable'};},readProcesses:()=>({ok:false,error:'injected'})});
  assert.deepEqual(inventory.coverage,{native:false,git:false,process:false});assert.equal(inventory.errors.length,3);
  assert.ok(calls.every(([exe,args])=>exe==='git'||args[0]==='workspace'||exe==='/usr/sbin/lsof'));
});

test('service hook appends immutable census, latest view and existing diagnostic without touching the record',t=>{
  const f=fixture(),directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'closeout-measurement-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const org=path.join(directory,'org');fs.mkdirSync(org);fs.writeFileSync(path.join(org,'events.jsonl'),f.events.map(e=>JSON.stringify(e)+'\n').join(''));
  const before=fs.readFileSync(path.join(org,'events.jsonl'));
  const args={project:f.project,org,source:f.source,historical:f.historical,now:()=>120000,collect:()=>f.inventory};
  const result=recordCloseoutTurn(args);assert.equal(result.green,true);assert.deepEqual(fs.readFileSync(path.join(org,'events.jsonl')),before);
  const dir=measurementDirectory(org,f.project.identity),audit=path.join(dir,'closeout-measurements.jsonl'),bytes=fs.readFileSync(audit);
  recordCloseoutTurn({...args,now:()=>150000});assert.ok(fs.readFileSync(audit).subarray(0,bytes.length).equals(bytes));
  assert.equal(fs.readFileSync(audit,'utf8').trim().split('\n').length,2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'closeout-measurement.json'))).interval_ms,30000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'passes.jsonl'),'utf8').split('\n')[0]).action,'closeout-measurement');
  fs.appendFileSync(audit,'torn');assert.throws(()=>recordCloseoutTurn({...args,now:()=>180000}),/incomplete measurement audit tail/);
  assert.ok(fs.readFileSync(audit,'utf8').endsWith('torn'));
});

test('process census selects all absolute cwd paths and orphan counts deduplicate report aliases',()=>{
  const f=fixture();let selected;
  const inventory=collectCloseoutInventory({...f.args,command:(exe,args)=>({status:0,stdout:exe==='git'?'':JSON.stringify({result:args[0]==='workspace'?{workspaces:[]}:{agents:[]}})}),
    readCwds:root=>{selected=root;return[{job:'42',cwd:'/fixture/lane'}];},readProcesses:()=>({ok:true,value:new Map([[42,{identity:'birth-42',ppid:1}]])})});
  assert.equal(selected,'');assert.equal(inventory.coverage.process,true);assert.equal(inventory.processes[0].identity,'birth-42');
  f.inventory.processes=inventory.processes;
  f.add({...f.report,seq:f.events.length+1});
  const doc=f.measure();assert.equal(doc.aggregate.denominator,2);assert.equal(doc.aggregate.counts.orphan_processes,1);
});
