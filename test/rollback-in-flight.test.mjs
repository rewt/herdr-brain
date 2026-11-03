// What BCH's pin does with work its successor left open. The pin's code cannot
// change, so each case records its actual behaviour for the owner's acceptance.
// Native effects are recorded, never run. The real rollback path is in
// line-service-runtime.test.mjs; this file swaps the running code directly.
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {fold,itemStatus,itemConditions} from '../lib/state.mjs';
import {gitProject} from '../lib/project.mjs';
import {requireCorrectedMajors} from '../lib/consumer-offer.mjs';
import {readCloseoutEntries,unresolvedCloseoutEffect} from '../lib/closeout.mjs';
import {sourceRoot,serviceDirectory} from '../line-service/line-service.mjs';
import {PASS_JOURNAL_LIMIT,appendPassJournal,passJournalExtent,passJournalSize,readPassJournal,rotatePassJournal} from '../line-service/pass-journal.mjs';
import {planJournalHandoff,applyJournalHandoff} from '../line-service/journal-handoff.mjs';
import {recordCloseoutTurn} from '../line-service/closeout-measurement.mjs';
import {canonical} from '../messages/schema.mjs';
import {setup,selectCurrentCleanup,events,effects} from './helpers/closeout-fixture.mjs';

const PIN='98002dc75cb064dd639e79c922ddeb98d3781bc2',hash=b=>createHash('sha256').update(b).digest('hex');
function historical(f){
  const root=path.join(f.scratch,'pin');fs.mkdirSync(root,{recursive:true});
  execFileSync('tar',['-x','-C',root],{input:execFileSync('git',['archive',PIN,'--',':(exclude)test',':(exclude)docs',':(exclude)acceptance'],{maxBuffer:128*1024*1024})});
  // Outside a sealed release the pin names its source by its own Git head.
  for(const args of [['init','-q'],['add','.'],['-c','user.name=Pin','-c','user.email=pin@example.invalid','commit','-qm','Pin source']])execFileSync('git',['-C',root,...args]);
  return root;
}
function fixture(t){
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity,base=f.git('rev-parse','HEAD'),directory=serviceDirectory(org,identity),workspace=path.join(f.scratch,'source-lane');
  f.git('worktree','add','-qb','lane/source',workspace);
  const git=(args,cwd=workspace)=>{const r=spawnSync('git',['-C',cwd,...args],{env:f.env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  fs.writeFileSync(path.join(workspace,'source'),'1');git(['add','.']);git(['commit','-qm','Build']);const head=git(['rev-parse','HEAD']);f.git('merge','--ff-only',head);
  const dispatch=path.join(org,'dispatch/source.json');fs.mkdirSync(path.dirname(dispatch),{recursive:true});
  fs.writeFileSync(dispatch,JSON.stringify({token:'source',stage:'complete',run:'R-1',item:'ENG-1',org,common:identity,workspace,base}));
  const report=`---\nrun: R-1\noutcome: done\nsummary: Actual committed build.\nartifacts:\n  - "Commit: ${head}"\n---\n`;fs.mkdirSync(path.join(org,'reports'),{recursive:true});fs.writeFileSync(path.join(org,'reports/R-1.md'),report);
  const owner={controller:'brain',legacy:false,release:{id:'source',root:sourceRoot,commit:null,identity:gitProject(sourceRoot).identity}};
  transact(org,()=>({add:[{type:'line-service.cutover',id:'old-service',project:identity,repo:f.cwd,org,source:sourceRoot,main:'main',canonical_head:base},
    {type:'line-service.phase0',id:'phase0',project:identity,repo:f.cwd,org,source:sourceRoot,main:'main',canonical_head:base,cutoff_at:'2026-10-26T23:55:00.000Z'},
    {type:'item.added',id:'ENG-1',title:'Build',role:'engineer'},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace,report_path:path.join(org,'runs/R-1/report.md'),meta:{lane:'source',dispatch_record:org,dispatch_project:identity,dispatch_journal:dispatch,dispatch_attempt:'source'}},
    {type:'run.claimed',run:'R-1',record:org,project:identity,owner},
    {type:'report.ingested',run:'R-1',item:'ENG-1',file:'reports/R-1.md',sha256:hash(report),report:{run:'R-1',outcome:'done',summary:'Actual source',artifacts:[`Commit: ${head}`],extra:{},blockers:[],proposals:[]}}]}));
  fs.mkdirSync(directory,{recursive:true});
  const install=root=>fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({at:'2026-10-27T00:00:00Z',repo:f.cwd,org,source:root,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  const env={...f.env};for(const k of ['HERDR_ENV','HERDR_PANE_ID','CODEX_THREAD_ID'])delete env[k];
  const pass=async(root,{maxStarts=0}={})=>{
    install(root);
    const {createLineService:create}=await import(pathToFileURL(path.join(root,'line-service/line-service.mjs')).href);
    const attempts=[],cwd=process.cwd();
    const service=create({repo:f.cwd,org,to:'fixture-supervisor',env,haltAfter:100,maxStarts,closeoutMeasure:()=>{},capacity:()=>({count:0,cap:4}),recordNotice:d=>({id:d.id,state:'record-only'}),
      command:(exe,args,options)=>{
        const file=exe===process.execPath?path.relative(root,args[0]):exe;
        if(file==='bin/org.mjs')return spawnSync(exe,args,options);
        attempts.push({file,args:exe===process.execPath?args.slice(1):args});
        return{status:0,stdout:'{"created":[]}',stderr:''};
      }});
    process.chdir(f.cwd);
    try{return {result:service.pass(),attempts};}finally{process.chdir(cwd);}
  };
  const read=()=>{const events=loadEvents(org).events;return{events,state:fold(events)};};
  return{...f,org,identity,base,head,workspace,directory,owner,env,git,pass,read,add:rows=>transact(org,()=>({add:rows})),rows:()=>fs.readFileSync(path.join(directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse)};
}
const reviewReport=(run,head)=>`---\nrun: ${run}\noutcome: done\nsummary: One Major at the captured head.\nverdict: FAIL\nfindings:\n  - severity: major\n    text: The change drops the original refusal.\n    correction_check: Assert the original refusal stays refused.\nartifacts:\n  - "Reviewed: ${head}"\n---\n\nBody.\n`;
function startRun(f,{run,item,lane}){
  const workspace=path.join(f.scratch,`lane-${run}`);f.git(['worktree','add','-qb',`lane/${lane}`,workspace],f.cwd);
  const journal=path.join(f.org,`dispatch/${run}.json`);
  fs.writeFileSync(journal,JSON.stringify({token:run,stage:'complete',run,item,org:f.org,common:f.identity,workspace,base:f.head}));
  f.add([{type:'run.started',id:run,item,workspace,report_path:path.join(f.org,`runs/${run}/report.md`),meta:{lane,dispatch_record:f.org,dispatch_project:f.identity,dispatch_journal:journal,dispatch_attempt:run}},
    {type:'run.claimed',run,record:f.org,project:f.identity,owner:f.owner}]);
  return{workspace,report:path.join(f.org,`runs/${run}/report.md`)};
}
const writeReport=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
const launches=attempts=>attempts.filter(a=>a.file==='dispatch/dispatch.mjs').map(a=>a.args[0]);
const holds=f=>f.rows().filter(r=>r.action==='hold').map(r=>r.reason);
const journal=f=>JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json')));
const corrections=f=>[...f.read().state.items.values()].filter(i=>i.meta.review_fix_of);
// The successor queued the review and its reviewer's report is on disk.
async function reportedReview(f,recorder){
  await f.pass(sourceRoot);
  const review=startRun(f,{run:'R-2',item:'REV-1',lane:'review-rev-1-1'});writeReport(review.report,reviewReport('R-2',f.head));
  return recorder?f.pass(recorder):null;
}

// The real handoff's conversion, which the real rollback path applies in line-service-runtime.test.mjs.
function handoff(f,fromRoot,targetRoot){
  const args={directory:f.directory,fromRoot,targetRoot},plan=planJournalHandoff(args);
  applyJournalHandoff({...args,expected:plan.receipt});
  return plan.receipt;
}
test('the pin refuses every general pass on a rotated journal until the handoff converts its checkpoint, and the successor needs the conversion back',async t=>{
  const f=fixture(t),pin=historical(f),audit=path.join(f.directory,'passes.jsonl');
  assert.equal((await f.pass(pin)).result.result,'pass-complete');
  // BCH's journal is far over this limit, so its first successor pass rotates it.
  fs.appendFileSync(audit,JSON.stringify({action:'fixture-history',pad:'x'.repeat(PASS_JOURNAL_LIMIT)})+'\n');
  assert.equal((await f.pass(sourceRoot)).result.result,'pass-complete');
  const live=()=>fs.statSync(audit).size,logical=journal(f).notice_audit_offset;
  assert.ok(fs.existsSync(audit+'.segments/index.json'));
  assert.ok(logical>PASS_JOURNAL_LIMIT&&live()<PASS_JOURNAL_LIMIT,'the saved offset now counts retired bytes too');
  // No retry helps: the failure comes before the pin can rewrite its checkpoint.
  const saved=journal(f),starts=()=>f.rows().filter(r=>r.action==='pass-start').length,started=starts();
  for(let n=0;n<2;n++)await assert.rejects(f.pass(pin),/notice audit checkpoint is inconsistent/);
  assert.deepEqual(journal(f),saved);assert.equal(starts(),started,'no general work, no pass row and no notice from the pin');
  // Recovery without changing anything: the successor still reads its own journal.
  assert.equal((await f.pass(sourceRoot)).result.result,'pass-complete');
  const down=handoff(f,sourceRoot,pin);
  assert.equal(down.basis,'live-file');assert.equal(journal(f).notice_audit_offset,down.offset_before-down.retired_bytes);assert.deepEqual(down.notices_folded,[]);
  assert.equal((await f.pass(pin)).result.result,'pass-complete');
  assert.ok(f.rows().filter(r=>r.action==='pass-start').length>started,'the pin runs general passes again');
  // The pin saved a physical offset, so a return needs the opposite conversion.
  await assert.rejects(f.pass(sourceRoot),/notice audit checkpoint is not a row boundary/);
  const physical=journal(f).notice_audit_offset,up=handoff(f,pin,sourceRoot);
  assert.equal(up.basis,'whole-journal');assert.equal(journal(f).notice_audit_offset,physical+up.retired_bytes);
  assert.equal((await f.pass(sourceRoot)).result.result,'pass-complete');
  // A second rotation and a second trip use the larger retired size.
  fs.appendFileSync(audit,JSON.stringify({action:'fixture-history',pad:'x'.repeat(PASS_JOURNAL_LIMIT)})+'\n');
  assert.equal((await f.pass(sourceRoot)).result.result,'pass-complete');
  assert.ok(handoff(f,sourceRoot,pin).retired_bytes>up.retired_bytes);
  assert.equal((await f.pass(pin)).result.result,'pass-complete');
  handoff(f,pin,sourceRoot);assert.equal((await f.pass(sourceRoot)).result.result,'pass-complete');
  assert.equal(passJournalSize(audit),[...readPassJournal(audit)].reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row))+1,0),'no retired or live byte was lost');
});

test('a closeout write alone rotates the journal, and the rollback folds in the unread rows it retired',async t=>{
  const f=fixture(t),pin=historical(f),audit=path.join(f.directory,'passes.jsonl'),project=gitProject(f.cwd);
  assert.equal((await f.pass(sourceRoot)).result.result,'pass-complete');
  const boundary='dispatch:ENG-1',reason='retained failure',scope={item:'ENG-1'},key=hash(canonical([boundary,reason,scope]));
  const entry={id:`line-record-${key}`,boundary,reason,scope,count:1,first_at:'2026-11-03T00:00:00Z'};
  // BCH's saved offset is behind its journal's end, so its unread rows retire with the rest.
  appendPassJournal(audit,{action:'hold',boundary,notice_record:{key,entry}});
  fs.appendFileSync(audit,JSON.stringify({action:'fixture-history',pad:'x'.repeat(PASS_JOURNAL_LIMIT)})+'\n');
  const saved=fs.readFileSync(path.join(f.directory,'effects.json'));
  recordCloseoutTurn({project,org:f.org,source:{id:'fixture',root:sourceRoot},historical:[],collect:()=>({coverage:{native:true,git:true,process:true},errors:[],workspaces:[],panes:[],worktrees:[],branches:[],processes:[]})});
  assert.ok(fs.existsSync(audit+'.segments/index.json'),'no pass ran and the journal rotated');
  assert.deepEqual(fs.readFileSync(path.join(f.directory,'effects.json')),saved);
  await assert.rejects(f.pass(pin),/notice audit checkpoint is inconsistent/);
  const {retired,size}=passJournalExtent(audit),before=journal(f).notice_audit_offset;assert.ok(before<retired);
  const down=handoff(f,sourceRoot,pin);
  assert.deepEqual(down.notices_folded,[key]);assert.equal(down.offset_after,size-retired);
  assert.equal(journal(f).record_notices[key].count,1,'nothing the pin would have replayed is lost');
  assert.equal((await f.pass(pin)).result.result,'pass-complete');
  handoff(f,pin,sourceRoot);assert.equal((await f.pass(sourceRoot)).result.result,'pass-complete');
  assert.equal(journal(f).record_notices[key].count,1);
});

test('the conversion refuses what it cannot place, finishes an interrupted rotation, and is nothing without a rotation',async t=>{
  const f=fixture(t),pin=historical(f),audit=path.join(f.directory,'passes.jsonl'),file=path.join(f.directory,'effects.json'),args={directory:f.directory,fromRoot:sourceRoot,targetRoot:pin};
  assert.equal(planJournalHandoff(args),null,'no effects yet');
  assert.equal((await f.pass(sourceRoot)).result.result,'pass-complete');
  assert.equal(planJournalHandoff(args),null,'nothing rotated, so both releases read the same number');
  assert.equal(planJournalHandoff({...args,targetRoot:sourceRoot}),null,'both releases rotate');
  assert.throws(()=>rotatePassJournal(audit,{maxBytes:1,fault:phase=>{if(phase==='renamed')throw Error('interrupted');}}),/interrupted/);
  const interrupted=planJournalHandoff(args).receipt,bytes=fs.readFileSync(file);
  assert.ok(interrupted.offset_before<interrupted.retired_bytes);assert.equal(interrupted.offset_after,interrupted.journal_bytes-interrupted.retired_bytes);
  // A closeout turn outliving its job could rotate past this plan.
  const lock=path.join(f.directory,'closeout-turn.lock');fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}));
  assert.throws(()=>planJournalHandoff(args),/active writer \(closeout-turn.lock\)/);
  assert.throws(()=>applyJournalHandoff({...args,expected:interrupted}),/active writer/);
  fs.rmSync(lock,{recursive:true});
  // A changed journal or checkpoint needs a fresh plan.
  fs.writeFileSync(file,JSON.stringify({...JSON.parse(bytes),pass_number:99},null,2)+'\n');
  assert.throws(()=>applyJournalHandoff({...args,expected:interrupted}),/changed since its handoff plan/);
  fs.writeFileSync(file,bytes);
  applyJournalHandoff({...args,expected:interrupted});
  assert.equal(JSON.parse(fs.readFileSync(audit+'.segments/index.json')).pending,null);
  assert.equal(journal(f).notice_audit_offset,interrupted.offset_after);
  assert.equal((await f.pass(pin)).result.result,'pass-complete');
  // A saved offset outside what the pin could have written stays as found.
  const physical=fs.readFileSync(file),up={...args,fromRoot:pin,targetRoot:sourceRoot};
  fs.writeFileSync(file,JSON.stringify({...JSON.parse(physical),notice_audit_offset:passJournalSize(audit)},null,2)+'\n');
  assert.throws(()=>planJournalHandoff(up),/outside the pass journal/);
  // One byte into a row is refused at the preview, not on the first pass after restart.
  fs.writeFileSync(file,JSON.stringify({...JSON.parse(physical),notice_audit_offset:1},null,2)+'\n');
  assert.throws(()=>planJournalHandoff(up),/not a row boundary/);
});

test('the pin holds a review its successor queued until the successor returns, while it launches a review it queued itself',async t=>{
  const own=fixture(t),ownPin=historical(own);await own.pass(ownPin);
  assert.deepEqual(launches((await own.pass(ownPin,{maxStarts:1})).attempts),['REV-1']);
  const f=fixture(t),pin=historical(f);await f.pass(sourceRoot);
  const held=await f.pass(pin,{maxStarts:1});
  assert.deepEqual(launches(held.attempts),[]);assert.equal(held.result.result,'pass-complete');
  assert.ok(holds(f).includes('queued review launch held by existing item attempt: existing same-change service intent/result'));
  assert.equal(itemStatus(f.read().state,'REV-1'),'ready');
  // The pin compares the whole saved target, and the successor's has more in it.
  const target=g=>Object.values(journal(g).actions).find(a=>a.review_operation==='record-queue').review_target;
  assert.ok(Object.keys(target(f)).some(key=>!(key in target(own))));
  assert.deepEqual(launches((await f.pass(sourceRoot,{maxStarts:1})).attempts),['REV-1']);
});

test('the pin records a review report its successor left open and keeps the required check, with no second correction on return',async t=>{
  const f=fixture(t),pin=historical(f);await reportedReview(f);
  const recorded=await f.pass(pin);
  assert.equal(recorded.result.result,'pass-complete');assert.deepEqual(launches(recorded.attempts),[]);
  const {events:all,state}=f.read(),[correction]=corrections(f);
  assert.equal(itemStatus(state,'REV-1'),'done');assert.equal(all.filter(e=>e.type==='change.reviewed'&&e.verdict==='FAIL').length,1);
  assert.deepEqual(Object.values(correction.meta.review_correction_checks),['Assert the original refusal stays refused.']);
  assert.equal(correction.finding_bindings.length,1,'the successor reads the pin\'s finding link');
  await f.pass(sourceRoot);
  assert.equal(corrections(f).length,1);assert.equal(f.read().events.filter(e=>e.type==='review.finding-linked').length,1);
});

test('the pin runs an open correction without the proof its successor requires, and on return that Major stays unproven and blocks an offer',async t=>{
  const f=fixture(t),pin=historical(f);await reportedReview(f,sourceRoot);
  const [correction]=corrections(f);
  // Its brief still carries the required check, which is all that binds a worker here.
  const started=await f.pass(pin,{maxStarts:1}),launch=started.attempts.find(a=>a.file==='dispatch/dispatch.mjs').args;
  assert.equal(launch[0],correction.id);
  assert.match(fs.readFileSync(launch[launch.indexOf('--brief')+1],'utf8'),/required check: Assert the original refusal stays refused\./);
  const run=startRun(f,{run:'R-3',item:correction.id,lane:'line-fix-1'});
  fs.writeFileSync(path.join(run.workspace,'fix'),'x');f.git(['add','.'],run.workspace);f.git(['commit','-qm','Fix'],run.workspace);
  const fix=f.git(['rev-parse','HEAD'],run.workspace);f.git(['merge','--ff-only',fix],f.cwd);
  // No check result and no declaration, and nothing under the pin refuses it.
  writeReport(run.report,`---\nrun: R-3\noutcome: done\nsummary: Fixed it.\nartifacts:\n  - "Commit: ${fix}"\n---\n`);
  await f.pass(pin);
  const under=f.read();
  assert.equal(itemStatus(under.state,correction.id),'done');
  assert.equal(under.events.some(e=>e.type==='correction.discharged'),false);assert.deepEqual(under.state.runs.get('R-3').notes??[],[]);
  // Failure stays visible: the successor reads the same record and fails closed.
  const back=await f.pass(sourceRoot,{maxStarts:1}),after=f.read();
  assert.deepEqual(launches(back.attempts),[],'neither replayed nor repaired on return');
  assert.equal(after.events.some(e=>e.type==='correction.discharged'),false);
  assert.equal(itemConditions(after.state,correction.id).Accepted.status,'Unknown');
  assert.match(itemConditions(after.state,'ENG-1').Accepted.reason,/linked correction is not discharged/);
  assert.throws(()=>requireCorrectedMajors(after.state,{commit:fix,majors:{corrections:[{item:correction.id}]}},f.cwd),/unresolved or unaccounted recorded Major/);
});

test('the pin finishes a report closeout its successor left, once, through its own closeout turn',async t=>{
  const f=setup(t,{direct:true,bound:true,merged:true}),pin=historical({scratch:path.dirname(f.repo)+'-pin'}),binding=selectCurrentCleanup(f);
  fs.writeFileSync(binding.file,JSON.stringify({...binding.receipt,source:pin}));
  f.report();
  const {runCloseoutTurn}=await import(pathToFileURL(path.join(pin,'line-service/closeout-turn.mjs')).href);
  const {drainCloseout}=await import(pathToFileURL(path.join(pin,'lib/closeout-consumer.mjs')).href);
  const turn=()=>runCloseoutTurn({project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},maxSteps:1,cli:(_file,argv)=>argv[0]==='refresh'?'{"created":[]}':
    JSON.stringify(drainCloseout({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options,keys:JSON.parse(argv[argv.indexOf('--keys')+1]),retrySafe:true}))});
  const finished=turn();assert.equal(finished.result,'closeout-turn-complete');assert.deepEqual(finished.errors,[]);
  assert.equal(fs.existsSync(f.lane),false);
  assert.deepEqual(f.read().actions,[['agent','prompt','worker','/quit'],['tab','close','w:t'],['workspace','close','w']]);
  assert.equal(effects(f).filter(e=>e.action==='agent-exit-requested').length,1);
  const actions=f.read().actions;assert.equal(turn().steps,0);assert.deepEqual(f.read().actions,actions,'no native effect replay');
});

test('the pin does not replay an exit request its successor left without an answer, and neither release clears it',async t=>{
  const f=setup(t,{terminal:true}),base=f.options.command,pin=historical({scratch:path.dirname(f.repo)+'-pin'});
  f.options.command=(exe,args,options)=>{const result=base(exe,args,options);return exe===f.job.herdr&&args.slice(0,2).join(' ')==='agent prompt'?{...result,status:1,stderr:'injected lost acknowledgement'}:result;};
  f.drain();
  const entry=readCloseoutEntries(f.common).find(e=>unresolvedCloseoutEffect(e,events(f))),intent=unresolvedCloseoutEffect(entry,events(f));
  assert.equal(intent.action,'agent-exit-requested');
  let calls=0;f.options.command=(exe,args,options)=>{if(exe===f.job.herdr)calls++;return base(exe,args,options);};
  const before=events(f).length;
  const {drainCloseout}=await import(pathToFileURL(path.join(pin,'lib/closeout-consumer.mjs')).href);
  const {unresolvedCloseoutEffect:pinOpen}=await import(pathToFileURL(path.join(pin,'lib/closeout.mjs')).href);
  assert.deepEqual(pinOpen(entry,events(f)),intent);
  assert.deepEqual(drainCloseout({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options}).evaluated,[]);
  assert.equal(calls,0);assert.equal(events(f).length,before);assert.ok(fs.existsSync(f.lane));
  assert.deepEqual(f.drain().evaluated,[]);assert.equal(calls,0);assert.deepEqual(unresolvedCloseoutEffect(entry,events(f)),intent);
});
