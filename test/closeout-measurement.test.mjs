import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {copyProduct,productFiles} from '../lib/product-files.mjs';
import {measureCloseouts,closeoutCohort,recordCloseoutTurn,measurementDirectory,collectCloseoutInventory,readCloseoutMeasurement,historicalInventoryPaths} from '../line-service/closeout-measurement.mjs';
import {MAX_AUDIT_FRAME_BYTES} from '../line-service/closeout-measurement-audit.mjs';

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
  const inventory={coverage:{native:true,git:true,process:true},errors:[],agents:[],panes:[],worktrees:[],branches:[{branch:'lane/work',head:'head'}],folders:[{cwd,present:false}],processes:[]},historical=[{id:'original',cutoff:{seq:6},members:[{run:'R-1'}]}];
  const args={project,org,events,inventory,source,historical,now:120000};
  return{...args,args,add,report,resources,effects,measure:extra=>measureCloseouts({...args,...extra})};
}
// A scratch record owns its targets; the pure oracle's placeholder org is not
// evidence that those targets belong to an unrelated on-disk record.
const recordBytes=(events,org)=>events.map(e=>JSON.stringify({...e,...(e.closeout_targets?{closeout_targets:e.closeout_targets.map(t=>({...t,org}))}:{})})+'\n').join('');

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
  const org=path.join(directory,'org');fs.mkdirSync(org);fs.writeFileSync(path.join(org,'events.jsonl'),recordBytes(f.events,org));
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

test('installed product without docs/evidence records live measurements and separately fails each missing historical cohort',async t=>{
  const f=fixture(),directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'closeout-installed-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const bundle=path.join(directory,'product'),org=path.join(directory,'org');
  copyProduct(path.resolve(import.meta.dirname,'..'),bundle);
  fs.rmSync(path.join(bundle,'docs/evidence'),{recursive:true,force:true});
  fs.writeFileSync(path.join(bundle,'.release-commit'),f.source.commit+'\n');
  assert.equal(fs.existsSync(path.join(bundle,'.git')),false);assert.equal(fs.existsSync(path.join(bundle,'docs/evidence')),false);
  assert.ok(fs.statSync(path.join(bundle,'docs/contracts/formats.json')).isFile());
  const installed=await import(pathToFileURL(path.join(bundle,'line-service/closeout-measurement.mjs')));
  fs.mkdirSync(org);const eventsFile=path.join(org,'events.jsonl'),before=recordBytes(f.events,org);fs.writeFileSync(eventsFile,before);
  const args={project:f.project,org,collect:()=>f.inventory,command:()=>{throw Error('installed measurement must not need Git');}};
  const run=at=>installed.recordCloseoutTurn({...args,now:()=>at}),result=run(120000),read=()=>installed.readCloseoutMeasurement(result.file);
  const doc=read(),ids=['r1176','sol-research','claude-research'];
  assert.equal(result.green,false);assert.equal(doc.aggregate.green,true);assert.equal(doc.aggregate.denominator,1);
  assert.ok(result.failures.includes('historical-inventory-missing'));
  assert.equal(path.resolve(doc.source.root),bundle);assert.equal(doc.source.commit,f.source.commit);assert.equal(doc.source.loaded_commit,f.source.commit);assert.equal(doc.source.changed,false);
  assert.deepEqual(doc.historical.map(r=>r.id),ids);
  for(const row of doc.historical){
    assert.equal(row.availability,'missing');assert.equal(row.inventory_complete,false);assert.equal(row.green,false);
    assert.ok(row.failures.includes('historical-inventory-missing'));assert.equal(row.cutoff,null);assert.deepEqual(row.source,[]);assert.deepEqual(row.rows,[]);
    assert.equal(row.file,path.join(bundle,'docs/evidence/ENG-864',`${row.id}.json`));
  }
  const dir=path.dirname(result.file),audit=path.join(dir,'closeout-measurements.jsonl'),bytes=fs.readFileSync(audit);
  run(150000);assert.ok(fs.readFileSync(audit).subarray(0,bytes.length).equals(bytes));assert.equal(read().interval_ms,30000);
  const diagnostics=fs.readFileSync(path.join(dir,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(diagnostics.length,2);assert.ok(diagnostics.every(r=>r.measurement.green===false&&r.measurement.failures.includes('historical-inventory-missing')));

  const history=path.join(bundle,'docs/evidence/ENG-864');fs.mkdirSync(history,{recursive:true});
  const put=(id,extra={})=>fs.writeFileSync(path.join(history,`${id}.json`),JSON.stringify({...f.historical[0],id,inventory_complete:true,...extra}));
  put('r1176');run(180000);const partial=read();
  assert.equal(partial.aggregate.green,true);assert.equal(partial.green,false);assert.equal(partial.historical[0].availability,'present');assert.equal(partial.historical[0].green,true);
  assert.deepEqual(partial.historical.filter(r=>r.availability==='missing').map(r=>r.id),ids.slice(1));
  put('sol-research');put('claude-research');assert.equal(run(210000).green,true);
  put('claude-research',{inventory_complete:false});assert.equal(run(240000).green,false);assert.equal(read().historical[2].green,false);
  const completeAudit=fs.readFileSync(audit);
  fs.writeFileSync(path.join(history,'r1176.json'),'{broken');assert.throws(()=>run(270000),SyntaxError);
  fs.unlinkSync(path.join(history,'r1176.json'));fs.symlinkSync(path.join(history,'sol-research.json'),path.join(history,'r1176.json'));
  assert.throws(()=>run(270000));assert.deepEqual(fs.readFileSync(audit),completeAudit);
  assert.equal(fs.readFileSync(eventsFile,'utf8'),before);
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

// Produce exactly ten events per allocation with distinct native/cwd/ref facts.
function manyAllocations(count){
  const f=fixture(),events=[],folders=[],branches=[];
  for(let i=0;i<count;i++){
    const offset=i*10,run=`R-${i+1}`,cwd=`/fixture/lane-${i+1}`,branch=`lane/work-${i+1}`,time=i*20000;
    const rows=structuredClone(f.events.slice(1));
    for(const e of rows){
      e.seq+=offset-1;e.at=new Date(Date.parse(e.at)+time).toISOString();
      if(e.run)e.run=run;if(e.id==='R-1')e.id=run;
      if(e.type==='run.started')e.workspace=cwd;
      if(e.type==='run.updated')e.meta={...e.meta,pane:`w${i+1}:p1`,terminal_id:`term-${i+1}`,agent_session_id:`session-${i+1}`};
      if(e.type==='report.available'){e.started_seq=offset+1;e.claim_generation=offset+2;e.observed_at=new Date(Date.parse(e.observed_at)+time).toISOString();}
      if(e.closeout_targets)for(const t of e.closeout_targets)Object.assign(t,{run,cwd,branch,key:`key-${i+1}`,allocation:{run,started_seq:offset+1,claim_generation:offset+2}});
      if(e.key)e.key=`key-${i+1}`;
      if(e.source)e.source={...e.source,seq:e.source.seq+offset-1};
      if(e.outcome?.cwd)Object.assign(e.outcome,{cwd,branch});
      if(e.resources)for(const r of Object.values(e.resources))r.receipt.seq+=offset-1;
      events.push(e);
    }
    folders.push({cwd,present:false});branches.push({branch,head:'head'});
  }
  return{...f.args,events,inventory:{...f.inventory,folders,branches},historical:[{id:'original',members:[{run:'R-1'}]}],now:100000+count*20000};
}

for(const type of ['cleanup.bound','item.closed','review.verdict'])test(`late ${type} joins the same allocation without borrowing terminal-source receipts`,()=>{
  const f=fixture(),target=f.report.closeout_targets[0];delete f.report.closeout_targets;
  const bound={seq:7,at:new Date(105500).toISOString(),type,run:'R-1',id:'ENG-1',closeout_targets:[target]};
  f.events.splice(6,0,bound);
  for(const e of f.events.slice(7)){e.seq++;if(e.source)e.source={seq:7,type};}
  for(const r of Object.values(f.resources))r.receipt.seq++;
  const doc=f.measure();assert.equal(doc.green,true,JSON.stringify(doc));assert.equal(doc.aggregate.accounted,1);
  assert.equal(doc.aggregate.counts.unexplained_disappearance,0);assert.equal(doc.aggregate.latency.first_disposition.unknown,0);
  assert.deepEqual(doc.cohort[0].source,{seq:6,type:'report.ingested'});assert.equal(doc.cohort[0].obligations[0].type,type);
  for(const field of ['run','identity','key']){
    const events=structuredClone(f.events);for(const e of events)if(e.type.startsWith('closeout.'))e[field]='foreign';
    const wrong=f.measure({events});assert.equal(wrong.green,false);assert.equal(wrong.aggregate.accounted,0);
  }
  const events=structuredClone(f.events);events[6].closeout_targets[0].allocation={run:'R-1',started_seq:2,claim_generation:999};
  assert.equal(f.measure({events}).aggregate.accounted,0);
});

test('declared activation window can pass while all fifty legacy rows and their absolute resources remain visible',()=>{
  const args=manyAllocations(51),after_seq=500;
  for(const e of args.events.filter(e=>e.seq<=after_seq)){
    if(e.type==='report.available')e.type='legacy.origin-unavailable';
    if(e.type==='closeout.evaluated')delete e.resources;
  }
  args.now=8000000;args.window={id:'candidate-window',after_seq,activated_at:new Date(1100000).toISOString(),commit:args.source.commit};
  args.historical=[{id:'claude-research',inventory_complete:false,members:[{run:'R-1'}]}];
  args.inventory.agents=[{pane_id:'w1:p1',terminal_id:'term-1',cwd:'/fixture/lane-1'}];
  args.inventory.worktrees=[{worktree:'/fixture/lane-1',clean:true}];args.inventory.folders[0].present=true;
  args.inventory.processes=[{pid:42,identity:'birth-42',cwd:'/fixture/lane-2'}];
  const doc=measureCloseouts(args);
  assert.equal(doc.window.green,true,JSON.stringify(doc.window));assert.equal(doc.window.denominator,1);
  assert.equal(doc.aggregate.denominator,51);assert.equal(doc.legacy.denominator,50);assert.equal(doc.legacy.row_ids.length,50);
  assert.equal(doc.aggregate.counts.open_over_2h,1);assert.equal(doc.aggregate.counts.clean_retained,1);assert.equal(doc.aggregate.counts.orphan_processes,1);
  assert.equal(doc.green,false);assert.equal(doc.historical_green,false);assert.ok(doc.historical_failures.includes('historical-inventory-incomplete'));
  args.inventory.agents=[];args.inventory.worktrees=[];args.inventory.folders[0].present=false;args.inventory.processes=[];
  assert.equal(measureCloseouts(args).green,true);
  // A declared prefix can begin before activation; it need not start at seq 1.
  assert.equal(measureCloseouts({...args,events:args.events.slice(10)}).window.green,true);
  for(const failure of ['manual','inventory','refusal','exclusion']){
    const bad=structuredClone(args);
    if(failure==='manual')bad.events.push({seq:511,at:new Date(args.now).toISOString(),type:'closeout.manual-assistance',run:'R-51',project:args.project.identity});
    if(failure==='inventory')bad.inventory.coverage.native=false;
    if(failure==='refusal')bad.events.at(-1).condition={kind:'native-refusal'};
    if(failure==='exclusion')bad.cohort=[];
    assert.equal(measureCloseouts(bad).window.green,false,failure);
  }
  assert.ok(measureCloseouts({...args,window:{...args.window,commit:'wrong'}}).failures.includes('measurement-window-invalid'));
});

test('offline 72-hour window accounts for 100 closeouts with legacy history and injected failures',t=>{
  const args=manyAllocations(150),after_seq=500,activated=1100000,duration=72*60*60*1000,end=activated+duration,
    spacing=Math.floor((duration-20000)/(99*60000))*60000;
  // Fifty pre-activation allocations retain their missing clocks/resources.
  // Spread the next hundred completions across the entire synthetic window.
  for(const e of args.events){
    if(e.seq<=after_seq){
      if(e.type==='report.available')e.type='legacy.origin-unavailable';
      if(e.type==='closeout.evaluated')delete e.resources;
    }else{
      const allocation=Math.floor((e.seq-1)/10),shift=(allocation-50)*(spacing-20000);
      e.at=new Date(Date.parse(e.at)+shift).toISOString();
      if(e.observed_at)e.observed_at=new Date(Date.parse(e.observed_at)+shift).toISOString();
    }
  }
  args.window={id:'offline-72-hours',after_seq,activated_at:new Date(activated).toISOString(),commit:args.source.commit};
  args.historical=[{id:'claude-research',inventory_complete:false,members:[{run:'R-1'}]}];
  const allEvents=args.events;let cursor=0,previous=null,doc,samples=0;
  // Observe each minute from the first completed allocation, including quiet
  // periods. This tests continuity without waiting or touching a live service.
  for(let at=activated+10000;;at=Math.min(at+60000,end)){
    while(cursor<allEvents.length&&Date.parse(allEvents[cursor].at)<=at)cursor++;
    doc=measureCloseouts({...args,events:allEvents.slice(0,cursor),now:at,previous});samples++;
    assert.equal(doc.green,true,`synthetic minute ${samples}: ${JSON.stringify(doc.failures)}`);
    assert.equal(doc.window.green,true);assert.equal(doc.window.accounted,doc.window.denominator);
    assert.equal(doc.legacy.denominator,50);assert.equal(doc.historical_green,false);
    assert.ok(doc.historical_failures.includes('historical-inventory-incomplete'));
    previous={observed_at:doc.observed_at,source:doc.source,cutoff:doc.cutoff,window_declaration:doc.window_declaration};
    if(at===end)break;
  }
  args.now=end;
  assert.equal(Date.parse(doc.observed_at)-Date.parse(doc.window.activated_at),duration);
  assert.equal(doc.aggregate.denominator,150);assert.equal(doc.window.denominator,100);assert.equal(doc.window.accounted,100);
  assert.equal(doc.legacy.row_ids.length,50);assert.equal(cursor,allEvents.length);assert.equal(samples,4321);
  assert.equal(new Set(doc.cohort.map(r=>r.id)).size,150);
  for(const clock of ['first_disposition','session_close','folder_removal'])assert.equal(doc.window.latency[clock].unknown,0);

  const retained=structuredClone(args);
  retained.inventory.agents=[{pane_id:'w1:p1',terminal_id:'term-1',cwd:'/fixture/lane-1'}];
  retained.inventory.worktrees=[{worktree:'/fixture/lane-1',clean:true}];retained.inventory.folders[0].present=true;
  retained.inventory.processes=[{pid:42,identity:'birth-42',cwd:'/fixture/lane-2'}];
  const absolute=measureCloseouts(retained);
  assert.equal(absolute.window.green,true);assert.equal(absolute.green,false);
  for(const count of ['open_over_2h','clean_retained','orphan_processes'])assert.equal(absolute.aggregate.counts[count],1);

  for(const failure of ['manual','native','git','process','refusal','exclusion','cadence']){
    const bad=structuredClone(args);
    if(failure==='manual')bad.events.push({seq:1501,at:new Date(end).toISOString(),type:'closeout.manual-assistance',run:'R-150',project:args.project.identity});
    if(['native','git','process'].includes(failure))bad.inventory.coverage[failure]=false;
    if(failure==='refusal')bad.events.at(-1).condition={kind:'native-refusal'};
    if(failure==='exclusion')bad.cohort=doc.cohort.slice(0,-1);
    if(failure==='cadence')bad.previous={...previous,observed_at:new Date(end-60001).toISOString()};
    const result=measureCloseouts(bad);
    assert.equal(result.window.green,false,failure);assert.equal(result.green,false,failure);
    assert.equal(result.window.denominator,100);assert.equal(result.legacy.denominator,50);
  }
  t.diagnostic(`offline exposure: ${duration} ms; ${samples} samples; 100 current and 50 legacy allocations; live acceptance UNRUN`);
});

test('installed payload includes every default historical path and reads all three without an override',async t=>{
  const f=fixture(),directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'closeout-payload-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const root=path.resolve(import.meta.dirname,'..'),files=productFiles(root),bundle=path.join(directory,'product'),org=path.join(directory,'org');
  for(const relative of historicalInventoryPaths)assert.ok(files.includes(relative),relative);
  copyProduct(root,bundle);assert.deepEqual(productFiles(bundle),files);
  fs.writeFileSync(path.join(bundle,'.release-commit'),f.source.commit+'\n');
  const installed=await import(pathToFileURL(path.join(bundle,'line-service/closeout-measurement.mjs')));
  fs.mkdirSync(org);fs.writeFileSync(path.join(org,'events.jsonl'),recordBytes(f.events,org));
  const dir=measurementDirectory(org,f.project.identity);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'closeout-measurement-window.json'),JSON.stringify({id:'installed-window',after_seq:0,activated_at:new Date(100000).toISOString(),commit:f.source.commit}));
  const result=installed.recordCloseoutTurn({project:f.project,org,now:()=>120000,collect:()=>f.inventory,command:()=>{throw Error('installed source must not invoke Git');}});
  const doc=installed.readCloseoutMeasurement(result.file);
  assert.deepEqual(doc.historical.map(r=>r.id),['r1176','sol-research','claude-research']);
  assert.ok(doc.historical.every(r=>r.availability==='present'));assert.equal(doc.historical.length,3);
  assert.equal(doc.window.green,true);assert.equal(doc.green,true);assert.equal(doc.historical_green,false);
});

test('three thousand members over thirty thousand events reuse immutable evidence within bounded audit frames',t=>{
  const args=manyAllocations(3000),directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'closeout-bounded-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const org=path.join(directory,'org');fs.mkdirSync(org);assert.equal(args.events.length,30000);
  fs.writeFileSync(path.join(org,'events.jsonl'),recordBytes(args.events,org));
  const call={project:args.project,org,source:args.source,historical:args.historical,collect:()=>args.inventory,now:()=>args.now};
  const start=performance.now(),first=recordCloseoutTurn(call),elapsed=performance.now()-start;
  assert.ok(elapsed<10000,`30,000-event turn took ${elapsed} ms; bound is 10,000 ms`);t.diagnostic(`30,000-event turn: ${elapsed.toFixed(1)} ms; bound 10,000 ms`);
  assert.equal(first.green,true);
  const audit=path.join(path.dirname(first.file),'closeout-measurements.jsonl'),prefix=fs.readFileSync(audit),objects=fs.readdirSync(path.join(path.dirname(first.file),'closeout-objects')).sort();
  recordCloseoutTurn({...call,now:()=>args.now+30000});
  const bytes=fs.readFileSync(audit),frames=bytes.toString().trim().split('\n');assert.ok(bytes.subarray(0,prefix.length).equals(prefix));assert.equal(frames.length,2);
  for(const frame of frames)assert.ok(Buffer.byteLength(frame+'\n')<MAX_AUDIT_FRAME_BYTES);
  const [a,b]=frames.map(JSON.parse);assert.deepEqual(a.cohort,b.cohort);assert.deepEqual(a.inventory,b.inventory);
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(first.file),'closeout-objects')).sort(),objects);
  const doc=readCloseoutMeasurement(first.file);assert.equal(doc.cohort.length,3000);assert.equal(new Set(doc.cohort.map(r=>r.id)).size,3000);assert.ok(doc.cohort.every(r=>r.effect_receipts.length===4));
  t.diagnostic(`audit bytes per frame: ${frames.map(r=>Buffer.byteLength(r+'\n')).join(', ')}`);
  fs.appendFileSync(audit,'torn');const torn=fs.readFileSync(audit);assert.throws(()=>recordCloseoutTurn(call),/incomplete measurement audit tail/);assert.deepEqual(fs.readFileSync(audit),torn);
});

test('absent pane bindings, ref mismatches and vanished processes retain exact inventory truth',()=>{
  const f=fixture();f.events.find(e=>e.type==='run.updated').meta={};f.inventory.agents=[{name:'unrelated'}];f.inventory.panes=[{}];
  assert.equal(f.measure({now:8000000}).aggregate.counts.open_over_2h,0);
  for(const branches of [undefined,[],[{branch:'lane/work',head:'foreign-head'}]]){
    const g=fixture();g.inventory.branches=branches;const doc=g.measure();assert.equal(doc.green,false);assert.ok(doc.cohort[0].failures.includes('branch-inventory-unproven'));
  }
  const g=fixture();g.resources.branch.status='deleted';g.effects[2].outcome.action='branch-removed';
  assert.equal(g.measure().green,false);g.inventory.branches=[];assert.equal(g.measure().green,true);
  const collect=readProcesses=>collectCloseoutInventory({...g.args,command:(exe,args)=>({status:0,stdout:exe==='git'?'':JSON.stringify({result:args[0]==='workspace'?{workspaces:[]}:{agents:[]}})}),
    readCwds:()=>[{job:'42',cwd:'/fixture/lane'}],readProcesses});
  const gone=collect(()=>({ok:true,value:new Map()}));assert.equal(gone.coverage.process,true);assert.deepEqual(gone.vanished_pids,[42]);assert.deepEqual(gone.processes,[]);
  assert.equal(collect(()=>({ok:true,value:new Map([[42,{identity:null}]])})).coverage.process,false);
  assert.equal(collect(()=>({ok:false,error:'source incomplete'})).coverage.process,false);
});
