import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fold} from '../lib/state.mjs';
import {initOrg,transact,loadRecord} from '../lib/store.mjs';
import {gitProject} from '../lib/project.mjs';
import {createLineService,sourceRoot,serviceDirectory} from '../line-service/line-service.mjs';
import {rotatePassJournal} from '../line-service/pass-journal.mjs';
import {evaluateWitness,witnessHash,SPEC_PREFIX,RESULT_PREFIX,resultMutation,pendingWitnesses,witnessResults} from '../measurement/live-witnesses.mjs';

const project='/project/.git',from='2026-10-31T00:00:00Z',cutoff='2026-10-31T00:10:00Z',now='2026-10-31T00:11:00Z';
const at=minute=>new Date(Date.parse(from)+minute*60000).toISOString();
const spec=(kind,extra={})=>({schema:'brain.live-witness/v1',id:'witness',project,owner:'existing-owner',next:'next finite line pass',from,cutoff,kind,...extra});
function inputs(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'live-witness-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'passes.jsonl'),events=[];
  const event=(minute,e)=>{const row={at:at(minute),seq:events.length+1,by:'fixture',...e};events.push(row);return row;};
  event(0,{type:'item.added',id:'ENG-1',role:'engineer',title:'Subject'});
  const write=rows=>fs.writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const evaluate=s=>evaluateWitness({spec:s,events,project,passes:file,now});
  const pass=(pid,start,end,extra={})=>[{action:'pass-start',pid,at:at(start),identity:project,source_head:'a'.repeat(40)},
    {action:'queue-order',pid,at:at(start+.1),policy:{order:['release','ordinary']},candidates:[{item:'ENG-1',class:'release'}]},
    {action:'pass-complete',pid,at:at(end),evaluations:{admission_skipped:1,source_skipped:1},...extra}];
  return{dir,file,events,event,write,evaluate,pass};
}

test('empty windows and supervisor prose cannot become live proof',async t=>{
  const f=inputs(t);f.write([]);f.event(1,{type:'note.added',id:'ENG-1',text:'Supervisor witness PASS: MET all conditions.'});
  for(const s of [spec('same-revision-skips'),spec('folder-median',{under_ms:600000}),spec('start-within-pass',{subject:'ENG-1',trigger:{type:'item.reopened',after_seq:1}}),spec('unavailable',{reason:'no durable HOLD interval'})]){
    const result=await f.evaluate(s);assert.equal(result.status,'UNRUN');assert.equal(result.terminal,true);
  }
  const early=await evaluateWitness({spec:spec('same-revision-skips'),events:f.events,project,passes:f.file,now:at(-1)});
  assert.equal(early.status,'UNRUN');assert.equal(early.terminal,false);
});

test('first completed pass records a missed start, then a fresh real trigger can recover',async t=>{
  const f=inputs(t);const trigger=f.event(1,{type:'item.reopened',id:'ENG-1'});f.write(f.pass(10,2,3));
  const s=spec('start-within-pass',{subject:'ENG-1',trigger:{type:'item.reopened',after_seq:1}});
  const red=await f.evaluate(s);assert.equal(red.status,'NOT MET');assert.equal(red.condition_at,at(3));assert.equal(red.delay_ms,8*60000);
  f.event(4,{type:'item.reopened',id:'ENG-1'});
  f.event(6,{type:'run.started',id:'R-1',item:'ENG-1',by:'line-service',meta:{dispatch_project:project}});
  f.event(6.1,{type:'run.session_bound',run:'R-1',session:'original-session'});
  const second=f.pass(11,5,7);second.splice(2,0,{action:'admission-started',pid:11,at:at(6.05),decision_at:at(5.9),item:'ENG-1'});
  f.write([...f.pass(10,2,3),...second]);
  assert.equal((await f.evaluate(s)).status,'NOT MET','later success cannot erase the first missed pass');
  const recovered=await f.evaluate({...s,id:'new-window',trigger:{type:'item.reopened',after_seq:trigger.seq}});
  assert.equal(recovered.status,'MET');assert.equal(recovered.evidence.run,'R-1');
});

test('uncommitted sessions and missing admission stay unknown; direct dispatch fails the witness',async t=>{
  const f=inputs(t);f.event(1,{type:'item.reopened',id:'ENG-1'});
  const start=f.event(2.5,{type:'run.started',id:'R-1',item:'ENG-1',by:'line-service',meta:{dispatch_project:project}});
  f.write(f.pass(10,2,3));const s=spec('start-within-pass',{subject:'ENG-1',trigger:{type:'item.reopened',after_seq:1}});
  assert.equal((await f.evaluate(s)).status,'UNRUN');
  start.by='supervisor';assert.equal((await f.evaluate(s)).status,'NOT MET');
});

test('incomplete earlier queue passes cannot be replaced by later completed passes',async t=>{
  const f=inputs(t);f.event(1,{type:'item.reopened',id:'ENG-1'});
  f.write([...f.pass(10,2,3).slice(0,2),...f.pass(11,4,5)]);
  const result=await f.evaluate(spec('start-within-pass',{subject:'ENG-1',trigger:{type:'item.reopened',after_seq:1}}));
  assert.equal(result.status,'UNRUN');assert.match(result.reason,/incomplete/);
});

test('queue witnesses check actual inherited class and preceding lower-class admissions',async t=>{
  const f=inputs(t);f.event(1,{type:'item.updated',id:'ENG-1'});
  f.event(2.5,{type:'run.started',id:'R-1',item:'ENG-1',by:'line-service',meta:{dispatch_project:project}});f.event(2.6,{type:'run.session_bound',run:'R-1'});
  const rows=f.pass(10,2,3);rows[1].candidates.push({item:'ENG-2',class:'ordinary'});
  rows.splice(2,0,{action:'admission-started',pid:10,at:at(2.3),decision_at:at(2.2),item:'ENG-2'},
    {action:'admission-started',pid:10,at:at(2.55),decision_at:at(2.4),item:'ENG-1'});
  f.write(rows);const s=spec('start-within-pass',{subject:'ENG-1',trigger:{type:'item.updated',after_seq:1},required_class:'release'});
  assert.equal((await f.evaluate(s)).status,'NOT MET');
  rows.splice(2,1);f.write(rows);assert.equal((await f.evaluate(s)).status,'MET');
  rows[1].candidates[0].class='ordinary';f.write(rows);assert.equal((await f.evaluate(s)).status,'NOT MET');
});

test('same-revision warm passes preserve zeros, unknowns, interleaving and rotated history',async t=>{
  const f=inputs(t);const rows=[...f.pass(10,1,2),...f.pass(11,3,4)];f.write(rows);
  const s=spec('same-revision-skips');assert.equal((await f.evaluate(s)).status,'MET');
  rotatePassJournal(f.file,{maxBytes:1});assert.equal((await f.evaluate(s)).status,'MET');
  const g=inputs(t),zero=[...g.pass(10,1,2),...g.pass(11,3,4,{evaluations:{admission_skipped:0,source_skipped:1}})];g.write(zero);
  assert.equal((await g.evaluate(s)).status,'NOT MET');
  zero[3].source_head='b'.repeat(40);g.write(zero);assert.equal((await g.evaluate(s)).status,'UNRUN');
  zero[3].source_head='a'.repeat(40);delete zero[5].evaluations;g.write(zero);assert.equal((await g.evaluate(s)).status,'UNRUN');
  g.events[0].seq=2;assert.equal((await g.evaluate(s)).status,'UNRUN','truncated record coverage cannot prove absence');
});

test('complete record sequences remain complete when transaction clocks straddle the cutoff',async t=>{
  const f=inputs(t);f.event(10.1,{type:'run.claimed',run:'R-unrelated'});f.event(9.9,{type:'note.added',id:'ENG-1',text:'Earlier transaction time, appended later'});
  f.write([...f.pass(10,1,2),...f.pass(11,3,4)]);
  const result=await f.evaluate(spec('same-revision-skips'));
  assert.equal(result.status,'MET');assert.equal(result.evidence.record.through_seq,3);
  f.events.splice(1,1);assert.equal((await f.evaluate(spec('same-revision-skips'))).status,'UNRUN','an actual missing source event still fails closed');
});

function report(f,n,reportMinute,folderMinute){
  const run=`R-${n}`,start=f.event(0,{type:'run.started',id:run,item:'ENG-1',meta:{dispatch_project:project}}),claim=f.event(0,{type:'run.claimed',run});
  f.event(reportMinute,{type:'report.available',run,project,started_seq:start.seq,claim_generation:claim.seq,producer:'original-report-watcher',observed_at:at(reportMinute),sha256:run});
  const ingest=f.event(reportMinute,{type:'report.ingested',run,sha256:run});
  if(folderMinute!==null){
    const effect=f.event(folderMinute,{type:'closeout.effect',run,identity:project,source:{seq:ingest.seq,type:ingest.type},key:run,effect:'folder',outcome:{action:'worktree-removed'}});
    f.event(folderMinute,{type:'closeout.evaluated',run,identity:project,source:{seq:ingest.seq,type:ingest.type},key:run,resources:{folder:{status:'removed',receipts:[{seq:effect.seq,effect:effect.effect}]}}});
  }
}
test('folder median uses the full authenticated report cohort and retains missing completions',async t=>{
  const f=inputs(t);report(f,1,1,3);report(f,2,2,6);f.write([]);
  const s=spec('folder-median',{under_ms:600000}),result=await f.evaluate(s);
  assert.equal(result.status,'MET');assert.equal(result.evidence.lifecycle.latency.median_ms,180000);
  assert.equal((await f.evaluate({...s,under_ms:120000})).status,'NOT MET');
  report(f,3,7,null);assert.equal((await f.evaluate(s)).status,'UNRUN');
  const open=await evaluateWitness({spec:s,events:f.events,project,passes:f.file,now:at(9)});assert.equal(open.status,'UNRUN');assert.equal(open.terminal,false);
});

test('reader failures preserve malformed bytes instead of producing an empty MET',async t=>{
  const f=inputs(t);fs.writeFileSync(f.file,'{"at":');
  await assert.rejects(f.evaluate(spec('same-revision-skips')),/incomplete/);
  assert.equal(fs.readFileSync(f.file,'utf8'),'{"at":');
  await assert.rejects(f.evaluate({...spec('same-revision-skips'),project:'/foreign'}),/matching project/);
});

test('result-only mutation deduplicates, retains failure history and fences changed specs',()=>{
  const s=spec('same-revision-skips'),events=[{seq:1,type:'item.added',id:'ENG-1',role:'engineer',title:'Witness'},
    {seq:2,type:'note.added',id:'ENG-1',text:SPEC_PREFIX+JSON.stringify(s)}];
  const result={schema:'brain.live-witness-result/v1',id:s.id,spec_sha256:witnessHash(s),status:'UNRUN',reason:'pending',terminal:false};
  const mutation=()=>resultMutation({state:fold(events),item:'ENG-1',specNote:2,result});
  assert.deepEqual(mutation().add.map(e=>e.type),['note.added']);events.push({...mutation().add[0],seq:3});assert.equal(mutation().add.length,0);
  result.status='NOT MET';result.reason='missed';result.terminal=true;events.push({...mutation().add[0],seq:4});
  assert.equal(pendingWitnesses(fold(events).items.get('ENG-1')).length,0);assert.equal(witnessResults(fold(events).items.get('ENG-1')).length,2);
  events.push({seq:5,type:'note.added',id:'ENG-1',text:SPEC_PREFIX+JSON.stringify({...s,cutoff:at(20)})});
  assert.throws(mutation,/spec changed/);assert.equal(pendingWitnesses(fold(events).items.get('ENG-1')).length,1);
});

function commandFixture(t){
  const f=inputs(t),repo=path.join(f.dir,'project'),org=path.join(repo,'.org');fs.mkdirSync(repo);fs.writeFileSync(path.join(f.dir,'.identity-root'),'fixture\n');
  const env={...process.env,ORG_DIR:org,ORG_ACTOR:'line-service',HERDR_BRAIN_ROOT:sourceRoot,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  for(const key of ['HERDR_ENV','HERDR_PANE_ID','HERDR_WORKSPACE_ID','HERDR_TAB_ID','CODEX_THREAD_ID','LANE_CONFIG'])delete env[key];
  const git=(...args)=>{const r=spawnSync('git',args,{cwd:repo,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-qb','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(repo,'source'),'one');git('add','.');git('commit','-qm','initial');
  initOrg(org);const identity=gitProject(repo).identity,directory=serviceDirectory(org,identity);fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(repo,'.lane.json'),JSON.stringify({routes:{engineer:{kind:'codex'}}}));
  const append=add=>transact(org,()=>({add}),{at:new Date(from),actor:'fixture'});
  const boundary={id:'fixture',repo,org,project:identity,source:sourceRoot,main:'main',canonical_head:git('rev-parse','HEAD')};
  append(['line-service.cutover','line-service.phase0'].map(type=>({type,...boundary})));
  const s={...spec('unavailable',{reason:'saved trigger interval does not exist'}),project:identity};
  append([{type:'item.added',id:'ENG-1',role:'engineer',title:'Witness',meta:{hold:true}},
    {type:'note.added',id:'ENG-1',text:SPEC_PREFIX+JSON.stringify(s)}]);
  const command=args=>spawnSync(process.execPath,[path.join(sourceRoot,'bin/org.mjs'),'witness','evaluate',...args],{cwd:repo,env,encoding:'utf8'});
  return{...f,repo,org,env,identity,directory,append,command};
}
test('record command writes only result notes, is idempotent, and preserves STOP and foreign-record fences',t=>{
  const f=commandFixture(t),before=loadRecord(f.org).events;
  let r=f.command(['--dry-run']);assert.equal(r.status,0,r.stderr);assert.equal(loadRecord(f.org).events.length,before.length);
  r=f.command([]);assert.equal(r.status,0,r.stderr);const after=loadRecord(f.org).events;
  assert.deepEqual(after.slice(before.length).map(e=>e.type),['note.added']);assert.match(after.at(-1).text,/UNRUN/);
  r=f.command([]);assert.equal(r.status,0,r.stderr);assert.equal(loadRecord(f.org).events.length,after.length);
  fs.writeFileSync(path.join(f.directory,'STOP'),'hold');r=f.command([]);assert.notEqual(r.status,0);assert.match(r.stderr,/STOP\/HOLD/);
  const foreign=path.join(f.dir,'foreign');initOrg(foreign);
  r=spawnSync(process.execPath,[path.join(sourceRoot,'bin/org.mjs'),'witness','evaluate'],{cwd:f.repo,env:{...f.env,ORG_DIR:foreign},encoding:'utf8'});
  assert.notEqual(r.status,0);assert.equal(loadRecord(foreign).events.length,0);
});

test('the finite command records reader failure and recovery without replacing the original result',t=>{
  const f=commandFixture(t),s={...spec('same-revision-skips'),id:'reader-recovery',project:f.identity};
  f.append([{type:'note.added',id:'ENG-1',text:SPEC_PREFIX+JSON.stringify(s)}]);
  const file=path.join(f.directory,'passes.jsonl');fs.writeFileSync(file,'{"at":');
  let r=f.command([]);assert.equal(r.status,0,r.stderr);
  assert.equal(fs.readFileSync(file,'utf8'),'{"at":');
  let results=witnessResults(loadRecord(f.org).state.items.get('ENG-1')).filter(row=>row.result.id===s.id);
  assert.equal(results[0].result.status,'UNRUN');assert.equal(results[0].result.terminal,false);
  fs.writeFileSync(file,[...f.pass(10,1,2),...f.pass(11,3,4)].map(row=>JSON.stringify({...row,...(row.identity?{identity:f.identity}:{})})).join('\n')+'\n');
  r=f.command([]);assert.equal(r.status,0,r.stderr);
  results=witnessResults(loadRecord(f.org).state.items.get('ENG-1')).filter(row=>row.result.id===s.id);
  assert.deepEqual(results.map(row=>row.result.status),['UNRUN','MET']);
});

test('an existing finite line pass evaluates specs and the following pass needs no duplicate call',t=>{
  const f=commandFixture(t);let calls=0;
  const pass=()=>createLineService({repo:f.repo,org:f.org,env:f.env,to:'supervisor-test',haltAfter:100,capacity:()=>({count:0,cap:4}),recordNotice:d=>({id:d.id,state:'record-only'}),
    command:(exe,args,options)=>{if(args[0].endsWith('/bin/org.mjs')&&args[1]==='witness'){calls++;return spawnSync(exe,args,options);}return{status:0,stdout:'{}',stderr:''};}}).pass({reconcileCloseout:false});
  assert.equal(pass().result,'pass-complete');assert.equal(calls,1);
  assert.equal(witnessResults(loadRecord(f.org).state.items.get('ENG-1')).length,1);
  assert.equal(pass().result,'pass-complete');assert.equal(calls,1);
});
