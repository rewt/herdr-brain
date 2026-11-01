import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {notificationFixture} from './helpers/operational-notification-fixture.mjs';
import {validateQueuedReview} from '../line-service/review-queue.mjs';
import {readPassJournal} from '../line-service/pass-journal.mjs';
import {enqueueSupervisor,drainInbox,readInbox} from '../supervisor/prompt-supervisor.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const notes=(f,run)=>f.events().filter(e=>e.type==='note.added'&&e.id===run).map(e=>e.text);
function start(f){const r=f.start();assert.equal(r.status,0,r.stderr+r.stdout);f.assertOpened();return f.job();}
function retained(f,job){
  const row=f.events().findLast(e=>e.type==='closeout.allocation-kept'&&e.run===job.run);
  assert.ok(row,'consumer must record why an unreported allocation cannot progress');
  assert.equal(row.continuation.kind,'original-dispatch-finalization');
  assert.equal(row.continuation.journal,job.journal);
  assert.equal(f.state().runs.get(job.run).abandoned,null);
  assert.ok(fs.existsSync(f.lane));return row;
}
function queueReview(f,{priorHistory=false}={}){
  // Overnight records already contain dispatch history. Keep the original
  // fresh-record controls below red too: ENG-986 owns that distinct defect.
  if(priorHistory)fs.mkdirSync(path.join(f.org,'dispatch'),{recursive:true});
  fs.writeFileSync(path.join(f.repo,'reviewed-source'),'new canonical source');
  f.git(['add','reviewed-source']);f.git(['commit','-qm','Source to review']);const head=f.git(['rev-parse','HEAD']);
  const q=f.queueCanonicalReview(head);
  assert.equal(fs.existsSync(path.join(f.directory,'installation.json')),false,'queue setup leaves no installed background owner');
  assert.equal(q.status,0,q.stderr+q.stdout);const review=JSON.parse(q.stdout).review_item;
  const launch=()=>f.dispatch([review,'--lane','review-notification','--base',head,'--route','reviewer','--brief',f.brief]);
  return{review,launch};
}

// Each outcome crosses a real workspace, lane, dispatch, watcher, durable record
// and finite line consumer. These are separate from unit notice-string tests.
for(const outcome of ['done','blocked','needs_human','failed'])test(`operational final ${outcome} note survives restart and the line ingests the original report`,t=>{
  const f=notificationFixture(t),job=start(f),report=f.writeReport(job.run,outcome),bytes=fs.readFileSync(report);
  const watched=f.watch(job.run);assert.equal(watched.status,0,watched.stderr+watched.stdout);
  assert.ok(notes(f,job.run).some(s=>s.includes('[org-report]')&&s.includes(`outcome=${outcome}`)));
  assert.equal(f.state().runs.get(job.run).report,null,'the final notice is not ingestion');
  const available=f.events().find(e=>e.type==='report.available'&&e.run===job.run);
  assert.equal(available.sha256,digest(bytes));
  const before=f.events(),turn=f.turn();assert.equal(turn.result,'closeout-turn-complete',JSON.stringify(turn));assert.deepEqual(turn.errors,[]);assert.equal(turn.ingested,1);
  assert.equal(f.state().runs.get(job.run).report.outcome,outcome);
  assert.deepEqual(fs.readFileSync(report),bytes);
  assert.deepEqual(f.events().slice(0,before.length),before,'the source notice remains immutable');
  assert.equal(f.turn().ingested,0,'a fresh finite turn must not ingest twice');
  assert.equal(f.events().filter(e=>e.type==='report.ingested'&&e.run===job.run).length,1);
  const again=f.execute('bin/org.mjs',['show',job.run,'--json']);assert.equal(again.status,0,again.stderr);
  assert.equal(JSON.parse(again.stdout).report.outcome,outcome,'another process reads the durable status');
});

test('operational opened worker with an undelivered prompt retains its failure and gives the line an original-owner reason',t=>{
  const f=notificationFixture(t);f.env.FAKE_HERDR_PROMPT_FAIL='1';
  const r=f.start();assert.equal(r.status,1,r.stderr+r.stdout);f.assertOpened();const job=f.job(),bytes=fs.readFileSync(job.journal);
  assert.ok(job.worker.agentName);assert.equal(f.native.state().prompted,undefined);
  assert.ok(notes(f,job.run).some(s=>s.includes('prompt not sent')));
  const completion=f.events().findLast(e=>e.type==='dispatch.completed');
  assert.equal(completion.exit_code,1);assert.equal(completion.run,job.run);
  assert.equal(completion.request_sha256,digest(bytes));
  f.pass();const row=retained(f,job);assert.equal(row.disposition,'dispatch-error-unreported');assert.ok(row.dispatch.error);
  const prompts=f.native.calls().filter(a=>a[0]==='agent'&&a[1]==='prompt').length;
  f.pass();assert.equal(f.native.calls().filter(a=>a[0]==='agent'&&a[1]==='prompt').length,prompts,'no blind redelivery');
  assert.deepEqual(fs.readFileSync(job.journal),bytes);assert.equal(f.jobs().length,1);
});

for(const priorHistory of [false,true])test('operational review launch with no agent preserves the ending status and the one-review cap after abandonment'+(priorHistory?' with existing dispatch history':''),t=>{
  const f=notificationFixture(t,{startFail:true,topic:'review-notification',item:'REV-1'});
  const {review,launch}=queueReview(f,{priorHistory}),r=launch();
  assert.equal(r.status,1,r.stderr+r.stdout);f.assertOpened();const job=f.job(),bytes=fs.readFileSync(job.journal);
  assert.equal(f.native.state().agent,undefined);assert.ok(!job.worker);
  const ending=f.events().findLast(e=>e.type==='dispatch.completed');assert.equal(ending.exit_code,1);assert.equal(ending.run,job.run);
  assert.equal(ending.request_sha256,digest(bytes));
  f.turn();retained(f,job);
  f.rec(['abandon',job.run]);
  const context={events:f.events(),state:f.state(),org:f.org,repo:f.repo,item:f.state().items.get(review)};
  assert.throws(()=>validateQueuedReview(context),/already has a run/,'abandonment does not silently grant a second review');
  // Two real passes let the line observe the unchanged abandoned request and
  // surface its recovery refusal for inspection, without granting another run.
  f.pass();f.pass();
  const held=Array.from(readPassJournal(path.join(f.directory,'passes.jsonl'))).findLast(row=>
    row.action==='hold'&&row.boundary===`review-progress:${review}`);
  assert.ok(held,'the capped abandoned review must leave an owner-visible line reason');
  assert.match(held.reason,/review progressed\/completed or is not an owned normal queue attempt/);
  assert.deepEqual(held.scope,{item:review,review:true});
  assert.equal(held.inspection_due,true,'the original review needs owner inspection');
  const shown=f.execute('bin/org.mjs',['show',review]);assert.equal(shown.status,0,shown.stderr);
  assert.match(shown.stdout,new RegExp(`${job.run} .*abandoned`),'the owner can identify the retained abandoned run');
  assert.deepEqual(fs.readFileSync(job.journal),bytes);assert.equal(f.jobs().length,1);
  assert.deepEqual(f.state().items.get(review).runs,[job.run]);
});

for(const priorHistory of [false,true])test('operational written review report crosses watcher and intake with its original Minor findings linked once'+(priorHistory?' with existing dispatch history':''),t=>{
  const f=notificationFixture(t,{topic:'review-notification',item:'REV-1'}),{launch}=queueReview(f,{priorHistory}),launched=launch();
  assert.equal(launched.status,0,launched.stderr+launched.stdout);f.assertOpened();const job=f.job();
  const report=f.writeReport(job.run),historical=fs.readFileSync(new URL('./fixtures/review-findings/R-1307.md',import.meta.url),'utf8');
  fs.writeFileSync(report,historical.replace(/^run: R-1307$/m,`run: ${job.run}`));const bytes=fs.readFileSync(report);
  const watched=f.watch(job.run);assert.equal(watched.status,0,watched.stderr+watched.stdout);
  assert.ok(notes(f,job.run).some(s=>s.includes('[org-report]')&&s.includes('outcome=done')));
  assert.equal(f.state().runs.get(job.run).report,null);
  const turn=f.turn();assert.deepEqual(turn.errors,[]);assert.equal(turn.ingested,1);
  assert.equal(f.state().runs.get(job.run).report.extra.verdict,'PASS');
  const findings=f.events().filter(e=>e.type==='review.finding-linked');assert.equal(findings.length,2);
  assert.equal(new Set(findings.map(e=>e.correction_item)).size,1);
  assert.equal(f.events().filter(e=>e.type==='change.reviewed').length,1);
  f.turn();assert.equal(f.events().filter(e=>e.type==='review.finding-linked').length,2);
  assert.deepEqual(fs.readFileSync(report),bytes);
});

test('operational report left before intake is reconciled without a watcher availability hint',t=>{
  const f=notificationFixture(t),job=start(f);f.writeReport(job.run,'blocked');
  assert.equal(f.events().some(e=>e.type==='report.available'),false);
  const turn=f.turn();assert.deepEqual(turn.errors,[]);assert.equal(turn.ingested,1);
  assert.equal(f.state().runs.get(job.run).report.outcome,'blocked');
  const watch=f.watch(job.run);assert.equal(watch.status,0,watch.stderr+watch.stdout);
  assert.ok(notes(f,job.run).some(s=>s.includes('[org-report]')&&s.includes('outcome=blocked')));
});

test('operational older report ingests on its original run while its successor remains unreported',t=>{
  const f=notificationFixture(t),job=start(f),report=f.writeReport(job.run),bytes=fs.readFileSync(report);
  f.add([{type:'run.started',id:'R-2',item:f.item,workspace:f.lane}]);
  const turn=f.turn();assert.deepEqual(turn.errors,[]);assert.equal(turn.ingested,1);
  assert.equal(f.state().runs.get(job.run).report.outcome,'done');assert.equal(f.state().runs.get('R-2').report,null);
  const checkpoint=JSON.parse(fs.readFileSync(path.join(f.directory,'closeout-turn.json')));
  assert.deepEqual(checkpoint.errors,[]);
  assert.deepEqual(fs.readFileSync(report),bytes);assert.ok(fs.existsSync(f.lane));
});

test('operational capacity stop without a report becomes a durable watcher note and an owned line continuation',async t=>{
  const f=notificationFixture(t),job=start(f);
  // Model the native stop boundary, not an invented final report. The watcher
  // only knows done/no-report; a capacity diagnosis remains worker evidence.
  f.patchNative({agentReplacement:{agent_status:'done'}});
  await f.watchUntil(job.run,/\[watch-no-report\].*state=done/);
  assert.ok(notes(f,job.run).some(s=>s.includes('[watch-no-report]')&&s.includes('state=done')));
  f.pass();retained(f,job);assert.equal(f.state().runs.get(job.run).report,null);
  assert.equal(f.jobs().length,1);
});

test('operational exception while the project supervisor is absent stays pending under its original notice',async t=>{
  const f=notificationFixture(t),job=start(f),id=`exception:${job.run}:missing-supervisor`,inbox=path.join(f.org,'supervisor/inbox.log');
  const message=`Worker stopped before its report; original allocation retained. run=${job.run}`;
  f.rec(['note',job.run,message]);
  const options={org:f.org,cwd:f.repo,inbox,herdr:path.join(f.root,'bin/herdr'),projectSupervisor:true,
    id,owner:true,waitSeconds:0,confirmSeconds:0.01,pollSeconds:0.01};
  enqueueSupervisor('supervisor-test',message,options);
  const result=await drainInbox(inbox,options);assert.equal(result.delivered,false);
  const pending=readInbox(inbox).find(e=>e.id===id);assert.ok(pending);assert.equal(pending.state,'pending');
  assert.equal(pending.recipient_role,'project-supervisor');assert.equal(pending.message,message);
  assert.ok(notes(f,job.run).includes(message));
  const before=f.native.calls().filter(a=>a[0]==='agent'&&a[1]==='prompt').length;
  enqueueSupervisor('supervisor-test',message,options);
  const duplicate=await drainInbox(inbox,options);assert.equal(duplicate.delivered,false);
  assert.equal(readInbox(inbox).filter(e=>e.id===id).length,1);
  assert.equal(f.native.calls().filter(a=>a[0]==='agent'&&a[1]==='prompt').length,before,'missing binding authorizes no native input');
  f.pass();retained(f,job);
});
