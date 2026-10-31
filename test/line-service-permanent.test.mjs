import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {sourceRoot,serviceDirectory,createLineService} from '../line-service/line-service.mjs';
import {recordReviewResults,recordReviewCompletion,reviewCompletionPlan,ensureReviewBoundary} from '../line-service/phase1.mjs';
import {inspectReviewCompletion,reconcileReviewCompletion} from '../line-service/review-completion.mjs';
import {commandIntent,finishCommand,forgetActiveCommand} from '../lib/command-receipt.mjs';
import {chainFor,terminalReason} from '../lib/retire.mjs';
import {readCloseoutEntries} from '../lib/closeout.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(t,{verdict='FAIL'}={}){
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity,base=f.git('rev-parse','HEAD');fs.writeFileSync(path.join(f.cwd,'source'),'actual changed source');f.git('add','source');f.git('commit','-qm','Source change');
  const head=f.git('rev-parse','HEAD'),workspace=path.join(f.ownerRoot,'review-lane');f.git('worktree','add','-qb','lane/review-source-1',workspace);
  const sourceText=`---\nrun: R-0\noutcome: done\nsummary: Landed source.\nartifacts:\n  - "Commit: ${head}"\n---\n`;fs.writeFileSync(path.join(org,'reports/R-0.md'),sourceText);
  const target={head,base,reportHash:hash(sourceText),evidence:path.join(org,'reports/R-0.md')},key=`ENG-1:${head}`,directory=serviceDirectory(org,identity),owner={controller:'brain',legacy:false,release:{id:'source',root:sourceRoot,commit:null,identity:gitProject(sourceRoot).identity}};
  const text=`---\nrun: R-1\noutcome: done\nsummary: Completed independent judgment.\nverdict: ${verdict}\nproposals: []\n---\nVerdict: **${verdict}**\n${verdict!=='PASS'?'- [Major] source:1 - correction remains independently owned.\n':''}`;fs.writeFileSync(path.join(org,'reports/R-1.md'),text);
  transact(org,()=>({add:[{type:'item.added',id:'G-1',kind:'goal',title:'Goal'}, {type:'item.added',id:'ENG-1',role:'engineer',title:'Source',parent:'G-1'},
    {type:'run.started',id:'R-0',item:'ENG-1',workspace:f.cwd},{type:'run.claimed',run:'R-0',record:org,project:identity,owner},
    {type:'report.ingested',run:'R-0',file:'reports/R-0.md',sha256:hash(sourceText),report:{outcome:'done',artifacts:[`Commit: ${head}`],extra:{},blockers:[],proposals:[]}},
    {type:'item.added',id:'REV-1',role:'reviewer',title:'Review',parent:'G-1',meta:{review_source_item:'ENG-1',review_source_run:'R-0',review_key:key,review_target:target,review_round_cap:1}},
    {type:'run.started',id:'R-1',item:'REV-1',workspace,meta:{lane:'review-source-1',agent:'reviewer',pane:'review:p',worker_workspace:'review-w',terminal_id:'review-term',agent_session_id:'review-sid'}},
    {type:'run.claimed',run:'R-1',record:org,project:identity,owner},
    {type:'report.ingested',run:'R-1',file:'reports/R-1.md',sha256:hash(text),report:{run:'R-1',outcome:'done',summary:'Judgment complete',blockers:[],proposals:[],extra:{verdict}}}]}));
  const policy=JSON.parse(fs.readFileSync(path.join(f.cwd,'.lane.json')));policy.retirement={closeout_queue:true};fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify(policy));f.git('add','.lane.json');f.git('commit','-qm','Fixture closeout policy');
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({at:'2026-10-27T01:00:00Z',repo:f.cwd,org,source:sourceRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  const env={...f.env};delete env.HERDR_ENV;delete env.HERDR_PANE_ID;
  const context=()=>{const events=loadEvents(org).events;return{events,state:fold(events)};},add=rows=>transact(org,()=>({add:rows}));
  return{...f,org,identity,key,directory,workspace,env,context,add,args:{repo:f.cwd,org,runId:'R-1',env}};
}
test('permanent flow completion releases a FAIL reviewer with its open linked fix and queues guarded retirement without closing product work',t=>{
  const f=fixture(t),release=noticeLock(path.join(f.directory,'pass.lock'));
  try{
    recordReviewResults(f.args);const c=f.context(),fix=[...c.state.items.values()].find(i=>i.meta.review_fix_of===f.key);assert.ok(fix);f.add([{type:'link.added',blocker:fix.id,blocked:'REV-1'}]);
    assert.equal(recordReviewCompletion(f.args).review_closed,true);assert.equal(recordReviewCompletion(f.args).review_closed,false);
    const done=f.context(),review=done.state.items.get('REV-1');assert.equal(review.closed.as,'done');assert.equal(done.state.items.get(fix.id).closed,null);assert.equal(done.state.items.get('ENG-1').closed,null);
    const entry=readCloseoutEntries(f.identity).find(e=>e.run==='R-1'&&e.signal==='landed');assert.ok(entry);assert.equal(entry.panes[0].session,'review-sid');
    const record={...done.state,reviewCompletions:done.events.filter(e=>e.type==='change.reviewed'||e.type==='item.closed')},run=done.state.runs.get('R-1'),chain=chainFor(record,run);
    assert.equal(chain.ids.has(fix.id),false);assert.equal(terminalReason(chain,{path:f.workspace,clean:true,integrated:true,lane:'review-source-1'}),null);
    f.add([{type:'item.added',id:'HUM-1',role:'human',parent:'REV-1',title:'New reserved decision',meta:{operator_reserved:true}}]);
    const held=f.context();assert.match(terminalReason(chainFor({...held.state,reviewCompletions:record.reviewCompletions},held.state.runs.get('R-1'))),/HUM-1/);
  }finally{release();}
});
test('permanent flow completion retains missing verdict held reopened foreign-owned and independently blocked reviews',t=>{
  for(const kind of ['missing','held','reopened','blocker','question','owner']){
    const f=fixture(t),release=noticeLock(path.join(f.directory,'pass.lock'));
    try{
      if(kind!=='missing')recordReviewResults(f.args);
      if(kind==='held')f.add([{type:'item.updated',id:'REV-1',fields:{meta:{hold:true}}}]);
      if(kind==='reopened')f.add([{type:'item.closed',id:'REV-1',as:'done'},{type:'item.reopened',id:'REV-1'}]);
      if(kind==='blocker')f.add([{type:'item.added',id:'ENG-99',role:'engineer',title:'Independent unfinished work'},{type:'link.added',blocker:'ENG-99',blocked:'REV-1'}]);
      if(kind==='question')f.add([{type:'item.added',id:'HUM-1',role:'human',parent:'REV-1',title:'Reserved decision',meta:{operator_reserved:true}}]);
      if(kind==='owner')f.add([{type:'run.claimed',run:'R-1',record:f.org,project:f.identity,owner:{...f.context().state.runs.get('R-1').owner,controller:'foreign'}}]);
      assert.throws(()=>recordReviewCompletion(f.args),/verdict|judgment|reopened|blocker|OWNED|controller/i);assert.equal(f.context().state.items.get('REV-1').closed,null);
    }finally{release();}
  }
});

for(const change of ['unrelated','hold','claim','claim-generation','STOP','report'])test(`completion preparation ${change==='unrelated'?'refreshes an unrelated append once':`retains a late ${change} refusal`}`,t=>{
  const f=fixture(t),release=noticeLock(path.join(f.directory,'pass.lock')),mkdir=fs.mkdirSync;let injected=false;
  recordReviewResults(f.args);
  fs.mkdirSync=function(file,...args){const out=mkdir.call(this,file,...args);if(file===path.join(f.org,'lock')&&!injected){
    injected=true;
    const owner=f.context().state.runs.get('R-1').owner;
    const event=change==='hold'?{type:'item.updated',id:'REV-1',fields:{meta:{hold:true}}}:change.startsWith('claim')?{type:'run.claimed',run:'R-1',record:f.org,project:f.identity,owner:change==='claim'?{...owner,controller:'foreign'}:owner}:{type:'note.added',id:'ENG-99',text:'Unrelated work continues'};
    fs.appendFileSync(path.join(f.org,'events.jsonl'),JSON.stringify({seq:f.context().events.at(-1).seq+1,...event})+'\n');
    if(change==='STOP')fs.writeFileSync(path.join(f.directory,'STOP'),'stop');
    if(change==='report')fs.appendFileSync(path.join(f.org,'reports/R-1.md'),'changed');
  }return out;};
  try{
    if(change==='unrelated')assert.equal(recordReviewCompletion(f.args).review_closed,true);
    else assert.throws(()=>recordReviewCompletion(f.args),/judgment|OWNED|STOP|bytes changed/);
    assert.equal(injected,true);
    const closed=f.context().events.filter(e=>e.type==='item.closed'&&e.id==='REV-1');
    assert.equal(closed.length,change==='unrelated'?1:0);
    const conflicts=fs.readFileSync(path.join(f.org,'record-conflicts.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(conflicts.map(c=>[c.attempt,c.retry,c.effects_started,c.record_effects]),[[1,true,false,false]]);
  }finally{fs.mkdirSync=mkdir;release();}
});

for(const change of ['report','STOP','claim'])test(`short review preparation refuses a late ${change} before publishing a verdict`,t=>{
  const f=fixture(t),release=noticeLock(path.join(f.directory,'pass.lock')),mkdir=fs.mkdirSync;let injected=false;
  fs.mkdirSync=function(file,...args){const out=mkdir.call(this,file,...args);if(file===path.join(f.org,'lock')&&!injected){injected=true;if(change==='report')fs.appendFileSync(path.join(f.org,'reports/R-1.md'),'changed');if(change==='STOP')fs.writeFileSync(path.join(f.directory,'STOP'),'stop');if(change==='claim')fs.appendFileSync(path.join(f.org,'events.jsonl'),JSON.stringify({seq:f.context().events.at(-1).seq+1,type:'future.unknown'})+'\n');}return out;};
  try{assert.throws(()=>recordReviewResults(f.args),/conflict/);assert.equal(f.context().events.some(e=>e.type==='change.reviewed'),false);}
  finally{fs.mkdirSync=mkdir;release();}
});

function failedCompletion(t,{attempt='73313d79-0733-4adf-93b9-3cde935541d0',verdict='PASS'}={}){
  const f=fixture(t,{verdict}),release=noticeLock(path.join(f.directory,'pass.lock'));
  try{recordReviewResults(f.args);}finally{release();}
  if(verdict!=='PASS'){const fix=[...f.context().state.items.values()].find(i=>i.meta.review_fix_of===f.key);assert.ok(fix);f.add([{type:'link.added',blocker:fix.id,blocked:'REV-1'}]);}
  const plan=reviewCompletionPlan({...f.context(),runId:'R-1'}),key=`review-complete:R-1:${plan.token}`,at=new Date().toISOString();
  const ref=commandIntent(f.directory,{exe:'line-operation',args:['review-complete',key],cwd:f.cwd,project:f.identity,org:f.org,subject:'REV-1',key,consumer:'line-service'});
  const error=Object.assign(Error('record planning conflict: source changed; no append was made'),{code:'RECORD_PLANNING_CONFLICT'});
  finishCommand(ref,{status:1,stderr:error.message,error});forgetActiveCommand(ref);
  const entry={state:'held',owner:'line-service',subject:key,execution_subject:'REV-1',attempt,consumer:'line-service',at,commands:[ref],error:error.message,failure:{code:error.code,kind:'unknown'},finished_at:new Date().toISOString()};
  const file=path.join(f.directory,'effects.json'),save=()=>fs.writeFileSync(file,JSON.stringify({identity:f.identity,org:f.org,actions:{[key]:entry}}));save();
  const args={...f.args,key},original=fs.readFileSync(file),command=fs.readFileSync(ref.receipt);
  return{...f,key,entry,ref,file,save,original,command,reconcile:()=>reconcileReviewCompletion(args),inspect:()=>inspectReviewCompletion(args)};
}
for(const attempt of ['73313d79-0733-4adf-93b9-3cde935541d0','ffd7d23a-e3c6-4db2-b4ef-794375479499'])test(`original completion reconciles ${attempt} once without replay or changing original bytes`,t=>{
  const f=failedCompletion(t,{attempt}),before=f.context().events.length,inspected=f.inspect();
  assert.equal(inspected.proof.attempt,attempt);assert.equal(f.context().events.length,before);
  const release=noticeLock(path.join(f.directory,'pass.lock'));
  try{
    const result=f.reconcile();assert.equal(result.existing,false);assert.equal(f.reconcile().existing,true);
    const c=f.context(),receipts=c.events.filter(e=>e.type==='line-service.review-completion-reconciled');assert.equal(receipts.length,1);
    assert.equal(c.state.items.get('REV-1').closed.as,'done');assert.equal(c.state.items.get('ENG-1').closed,null);
    assert.equal(receipts[0].proof.verdict_seq,inspected.proof.verdict_seq);assert.equal(receipts[0].original_command_replayed,false);
    assert.deepEqual(fs.readFileSync(f.file),f.original);assert.deepEqual(fs.readFileSync(f.ref.receipt),f.command);
    const archive=JSON.parse(fs.readFileSync(receipts[0].archive.file));assert.deepEqual(archive.original,f.entry);assert.deepEqual(archive.command,JSON.parse(f.command));
    assert.ok(readCloseoutEntries(f.identity).some(e=>e.run==='R-1'&&e.signal==='landed'));
  }finally{release();}
});

for(const stage of ['lstatSync','realpathSync','readFileSync'])test(`original completion ignores an unrelated command forgotten during ${stage}`,t=>{
  const f=failedCompletion(t),release=noticeLock(path.join(f.directory,'pass.lock'));
  const ref=commandIntent(f.directory,{exe:'unrelated',args:[],cwd:f.cwd,project:f.identity,org:f.org,subject:'ENG-99'});
  finishCommand(ref,{status:0});const terminal=fs.readFileSync(ref.receipt),read=fs[stage];let forgotten=false;
  fs[stage]=Object.assign(function(file,...args){
    if(file===ref.file&&!forgotten){forgotten=true;forgetActiveCommand(ref);}
    return read.call(this,file,...args);
  },read);
  try{
    assert.equal(f.reconcile().existing,false);assert.equal(forgotten,true);
    assert.equal(f.context().state.items.get('REV-1').closed.as,'done');
    assert.equal(f.context().events.filter(e=>e.type==='line-service.review-completion-reconciled').length,1);
    assert.deepEqual(fs.readFileSync(f.file),f.original);assert.deepEqual(fs.readFileSync(f.ref.receipt),f.command);
    assert.deepEqual(fs.readFileSync(ref.receipt),terminal);
  }finally{fs[stage]=read;release();}
});

for(const kind of ['EACCES','malformed'])test(`original completion retains ${kind} active-command evidence and recovers after repair`,t=>{
  const f=failedCompletion(t),release=noticeLock(path.join(f.directory,'pass.lock'));
  const ref=commandIntent(f.directory,{exe:'unrelated',args:[],cwd:f.cwd,project:f.identity,org:f.org,subject:'ENG-99'});
  finishCommand(ref,{status:0});const marker=fs.readFileSync(ref.file),read=fs.readFileSync;
  if(kind==='malformed')fs.writeFileSync(ref.file,'{');
  else fs.readFileSync=function(file,...args){if(file===ref.file)throw Object.assign(Error('denied marker read'),{code:'EACCES'});return read.call(this,file,...args);};
  try{
    assert.throws(f.reconcile,error=>kind==='malformed'?error instanceof SyntaxError:error.code==='EACCES');
    assert.equal(f.context().state.items.get('REV-1').closed,null);
    assert.equal(f.context().events.some(e=>e.type==='line-service.review-completion-reconciled'),false);
    assert.deepEqual(fs.readFileSync(f.file),f.original);assert.deepEqual(fs.readFileSync(f.ref.receipt),f.command);
    fs.readFileSync=read;fs.writeFileSync(ref.file,marker);
    assert.equal(f.reconcile().existing,false);
    assert.equal(f.context().events.filter(e=>e.type==='line-service.review-completion-reconciled').length,1);
  }finally{fs.readFileSync=read;release();}
});

for(const kind of ['status','signal','stdout','native-refusal','message','intent','missing-receipt','active','history','token','claim','report','verdict','duplicate-verdict','blocker','reserved','ancestor-hold','STOP','HOLD','native-context','no-lock','unknown-command','archive'])test(`original completion retains ${kind} without a replacement or closure`,t=>{
  const f=failedCompletion(t),release=kind==='no-lock'?()=>{}:noticeLock(path.join(f.directory,'pass.lock'));
  try{
    if(['status','signal','stdout','native-refusal','message','intent'].includes(kind)){
      const command=JSON.parse(f.command);
      if(kind==='status')command.result.status=0;
      if(kind==='signal')command.result.signal='SIGTERM';
      if(kind==='stdout')command.result.stdout='unknown effects';
      if(kind==='native-refusal')command.result.error.code='NATIVE_REFUSAL';
      if(kind==='message')command.result.stderr='record planning conflict';
      if(kind==='intent')command.intent.args=['some-other-operation',f.key];
      fs.writeFileSync(f.ref.receipt,JSON.stringify(command));
    }
    if(kind==='missing-receipt')fs.unlinkSync(f.ref.receipt);
    if(kind==='active'){f.entry.state='started';f.save();}
    if(kind==='history'){f.entry.history=[{attempt:'older'}];f.save();}
    if(kind==='token')f.add([{type:'item.updated',id:'REV-1',fields:{title:'Changed review scope'}}]);
    if(kind==='claim')f.add([{type:'run.claimed',run:'R-1',record:f.org,project:f.identity,owner:f.context().state.runs.get('R-1').owner}]);
    if(kind==='report')fs.appendFileSync(path.join(f.org,'reports/R-1.md'),'changed bytes');
    if(kind==='verdict')f.add([{type:'item.updated',id:'REV-1',fields:{meta:{review_target:{...f.context().state.items.get('REV-1').meta.review_target,head:'a'.repeat(40)}}}}]);
    if(kind==='duplicate-verdict'){const {seq,at,by,...fact}=f.context().events.find(e=>e.type==='change.reviewed');f.add([fact]);}
    if(kind==='blocker')f.add([{type:'item.added',id:'ENG-99',role:'engineer',title:'Independent blocker'},{type:'link.added',blocker:'ENG-99',blocked:'REV-1'}]);
    if(kind==='reserved')f.add([{type:'item.updated',id:'REV-1',fields:{meta:{operator_reserved:true}}}]);
    if(kind==='ancestor-hold')f.add([{type:'item.updated',id:'G-1',fields:{meta:{hold:true}}}]);
    if(kind==='STOP')fs.writeFileSync(path.join(f.directory,'STOP'),'stop');
    if(kind==='HOLD'){fs.mkdirSync(path.join(f.cwd,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.cwd,'.lane/supervisor/HOLD'),'hold');}
    if(kind==='native-context')f.env.HERDR_ENV='1';
    if(kind==='unknown-command')commandIntent(f.directory,{exe:'unknown',args:[],cwd:f.cwd,project:f.identity,org:f.org,subject:'REV-1'});
    if(kind==='archive'){const file=path.join(f.org,'evidence/review-completion-reconciliation',`completion-${f.entry.attempt}.json`);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'changed archive');}
    const original=fs.readFileSync(f.file);assert.throws(f.reconcile);
    assert.equal(f.context().state.items.get('REV-1').closed,null);assert.equal(f.context().events.some(e=>e.type==='line-service.review-completion-reconciled'),false);assert.deepEqual(fs.readFileSync(f.file),original);
  }finally{release();}
});

for(const kind of ['pre-typed','missing-receipt','token'])test(`ordinary line retains an unqualified ${kind} original across passes without writer effects`,t=>{
  const f=failedCompletion(t,{verdict:kind==='missing-receipt'?'FAIL':'PASS'});
  // Model an already installed line; first-install boundary creation has its
  // own landing lock and is outside the measured completion passes.
  const release=noticeLock(path.join(f.directory,'pass.lock'));
  try{ensureReviewBoundary(f.args);}finally{release();}
  if(kind==='pre-typed'){delete f.entry.commands;delete f.entry.consumer;delete f.entry.execution_subject;f.save();}
  if(kind==='missing-receipt')fs.unlinkSync(f.ref.receipt);
  if(kind==='token')f.add([{type:'item.updated',id:'REV-1',fields:{title:'Changed review scope'}}]);
  const original=JSON.stringify(f.entry),command=kind==='missing-receipt'?null:fs.readFileSync(f.ref.receipt),mkdir=fs.mkdirSync;
  const lock=path.join(f.identity,'lane-promote.lock');let landingLocks=0;
  fs.mkdirSync=function(file,...args){if(file===lock)landingLocks++;return mkdir.call(this,file,...args);};
  try{
    for(let pass=0;pass<2;pass++){
      // A fresh service instance also proves the diagnostic survives a reload.
      const service=createLineService({repo:f.cwd,org:f.org,to:'fixture-supervisor',env:f.env,maxStarts:0,maxStepsPerStage:0,
        command:()=>({status:1,stderr:'No external command selected by this fixture'})});
      service.pass({reconcileCloseout:false});
      const journal=JSON.parse(fs.readFileSync(f.file));
      assert.equal(JSON.stringify(journal.actions[f.key]),original);
      assert.equal(Object.keys(journal.actions).filter(k=>k.startsWith('review-complete:R-1:')).length,1);
      if(command)assert.deepEqual(fs.readFileSync(f.ref.receipt),command);else assert.equal(fs.existsSync(f.ref.receipt),false);
      const commands=fs.readdirSync(path.join(f.directory,'command-receipts')).map(name=>JSON.parse(fs.readFileSync(path.join(f.directory,'command-receipts',name))));
      assert.equal(commands.some(c=>c.intent.exe==='line-operation'&&c.intent.args[0]==='review-completion-reconcile'),false);
      assert.equal(fs.readdirSync(path.join(f.directory,'active-commands')).length,0);
      assert.equal(landingLocks,0);
      const rows=fs.readFileSync(path.join(f.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.filter(r=>r.action==='review-completion-held'&&r.run==='R-1').length,1);
      const notes=rows.filter(r=>r.action==='hold'&&r.boundary==='review-complete:R-1');
      assert.equal(notes.length,1);assert.equal(notes[0].notice_record.entry.count,1);
      assert.equal(f.context().state.items.get('REV-1').closed,null);
      assert.equal(f.context().events.some(e=>e.type==='line-service.review-completion-reconciled'),false);
    }
  }finally{fs.mkdirSync=mkdir;}
});

for(const verdict of ['FAIL','NEEDS-WORK'])test(`ordinary line recovers an original ${verdict} completion once and retains its judgment and corrections`,t=>{
  const f=failedCompletion(t,{verdict}),before=f.context();
  const fact=before.events.find(e=>e.type==='change.reviewed'),fixes=[...before.state.items.values()].filter(i=>i.meta.review_fix_of===f.context().state.items.get('REV-1').meta.review_key);
  assert.ok(fixes.length);
  // Missing positive terminal proof must hold even a supported verdict. Restore
  // the exact receipt to recover the retained attempt, without changing its token.
  fs.unlinkSync(f.ref.receipt);
  const calls=[],service=createLineService({repo:f.cwd,org:f.org,to:'fixture-supervisor',env:f.env,maxStarts:0,maxStepsPerStage:0,
    command:(_exe,args)=>{calls.push(args);return{status:1,stderr:'No external command selected by this fixture'};}});
  service.pass({reconcileCloseout:false});
  assert.equal(f.context().state.items.get('REV-1').closed,null);
  assert.equal(f.context().events.some(e=>e.type==='line-service.review-completion-reconciled'),false);
  fs.writeFileSync(f.ref.receipt,f.command);
  service.pass({reconcileCloseout:false});
  service.pass({reconcileCloseout:false});
  const c=f.context(),receipts=c.events.filter(e=>e.type==='line-service.review-completion-reconciled');
  assert.equal(c.state.items.get('REV-1').closed?.as,'done');assert.equal(receipts.length,1);
  assert.deepEqual(c.events.filter(e=>e.type==='change.reviewed'),[fact]);
  assert.equal(c.state.items.get('ENG-1').closed,null);
  for(const fix of fixes)assert.equal(c.state.items.get(fix.id).closed,null);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).actions[f.key],f.entry);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(f.file)).actions).filter(k=>k.startsWith('review-complete:R-1:')).length,1);
  assert.deepEqual(fs.readFileSync(f.ref.receipt),f.command);
  assert.equal(calls.some(args=>args.includes('review-complete')),false);
  const close=c.events.find(e=>e.type==='item.closed'&&e.id==='REV-1');
  assert.equal(close.review_verdict,fact.seq);assert.ok(close.note.includes(`recorded ${verdict}`));
  const release=noticeLock(path.join(f.directory,'pass.lock'));
  try{assert.equal(f.reconcile().existing,true);}finally{release();}
  assert.equal(f.context().events.filter(e=>e.type==='line-service.review-completion-reconciled').length,1);
});

test('ordinary line consumes the original completion without invoking its command or minting another attempt',t=>{
  const f=failedCompletion(t),calls=[];
  const service=createLineService({repo:f.cwd,org:f.org,to:'fixture-supervisor',env:f.env,maxStarts:0,maxStepsPerStage:0,
    command:(_exe,args)=>{calls.push(args);return{status:1,stderr:'No external command selected by this fixture'};}});
  service.pass({reconcileCloseout:false});
  service.pass({reconcileCloseout:false});
  const c=f.context();assert.equal(c.state.items.get('REV-1').closed?.as,'done');
  const journal=JSON.parse(fs.readFileSync(f.file));assert.deepEqual(journal.actions[f.key],f.entry);
  assert.equal(Object.keys(journal.actions).filter(k=>k.startsWith('review-complete:R-1:')).length,1);
  assert.equal(c.events.filter(e=>e.type==='line-service.review-completion-reconciled').length,1);
  assert.equal(calls.some(args=>args.includes('review-complete')),false);
});

for(const change of ['unrelated','claim','report'])test(`original completion preparation ${change==='unrelated'?'refreshes one unrelated append':`retains a late ${change}`}`,t=>{
  const f=failedCompletion(t),release=noticeLock(path.join(f.directory,'pass.lock')),mkdir=fs.mkdirSync;let injected=false;
  fs.mkdirSync=function(file,...args){const out=mkdir.call(this,file,...args);if(file===path.join(f.org,'lock')&&!injected){
    injected=true;
    const event=change==='claim'?{type:'run.claimed',run:'R-1',record:f.org,project:f.identity,owner:f.context().state.runs.get('R-1').owner}:{type:'note.added',id:'ENG-1',text:'Unrelated work'};
    fs.appendFileSync(path.join(f.org,'events.jsonl'),JSON.stringify({seq:f.context().events.at(-1).seq+1,at:new Date().toISOString(),...event})+'\n');
    if(change==='report')fs.appendFileSync(path.join(f.org,'reports/R-1.md'),'changed');
  }return out;};
  try{
    if(change==='unrelated')assert.equal(f.reconcile().existing,false);else assert.throws(f.reconcile);
    assert.equal(injected,true);assert.equal(f.context().events.filter(e=>e.type==='line-service.review-completion-reconciled').length,change==='unrelated'?1:0);
    assert.deepEqual(fs.readFileSync(f.file),f.original);assert.deepEqual(fs.readFileSync(f.ref.receipt),f.command);
  }finally{fs.mkdirSync=mkdir;release();}
});
