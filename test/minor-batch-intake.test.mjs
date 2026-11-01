import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fold, itemConditions } from '../lib/state.mjs';
import { transact } from '../lib/store.mjs';
import { reviewResultEvents, dispatchInput } from '../line-service/phase1.mjs';
import { queueSelected } from '../line-service/priority-order.mjs';
import { collectMinors } from '../measurement/minor-batches.mjs';
import { batchedMinorKey, batchedMinorSection } from '../lib/batched-minors.mjs';
import { setupOrg } from './helpers.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40), reportHash = 'c'.repeat(64), reviewHash = 'd'.repeat(64), project = '/fixture/.git';
const stamp = events => events.map((e,i)=>({ seq:i+1, at:'2026-11-01T18:00:00Z', by:'fixture', ...e }));
const seed = () => stamp([
  { type:'item.added', id:'ENG-1', role:'engineer' },
  { type:'run.started', id:'R-1', item:'ENG-1', meta:{dispatch_project:project} },
  { type:'run.claimed', run:'R-1', owner:{controller:'brain'} },
  { type:'change.landed', run:'R-1', item:'ENG-1', head, base, project, producer:{ownership_generation:3} },
  { type:'report.ingested', run:'R-1', sha256:reportHash, report:{outcome:'done'} },
  { type:'item.added', id:'REV-1', role:'reviewer', meta:{review_key:`ENG-1:${head}`,review_source_item:'ENG-1',review_source_run:'R-1',
    review_target:{head,base,reportHash,source_provenance:{claim_generation:3},scope:{commits:[head]}}} },
  { type:'run.started', id:'R-2', item:'REV-1' },
]);
const data = (findings, proposals=[]) => ({outcome:'done', proposals, extra:{verdict:'PASS', findings,
  acceptance:{fulfilled:true,source_run:'R-1',source_report_sha256:reportHash,head,claim_generation:3}}});
const intake = (events,report,body='') => reviewResultEvents({events,state:fold(events),run:fold(events).runs.get('R-2'),report,body,sha256:reviewHash});
const minors = [{severity:'minor',text:'a.mjs:4 - Empty input loses context'},
  {severity:'minor',text:'b.mjs:8 - Retry loses context',live_trigger:'A retry loses context live'}];

test('one unselected batch keeps all Minor keys and leaves a fulfilled PASS accepted until selection or an attempt', () => {
  for (const proposals of [[],[{role:'engineer',title:'First',blocking:true},{role:'engineer',title:'Second',blocking:true}]]) {
    const events=seed(), report=data(minors,proposals), added=intake(events,report), batch=added.find(e=>e.type==='item.added');
    assert.equal(added.filter(e=>e.type==='item.added').length,1);
    assert.equal(batch.meta.queue_selected,false);
    assert.equal(batch.meta.review_minor_batch,'v1');
    assert.deepEqual(batch.meta.review_correction_checks,{});
    assert.equal(batch.meta.review_finding_keys.length,2);
    assert.equal(added.filter(e=>e.type==='link.added').length,0);
    const recorded=stamp([...events,...added,{type:'report.ingested',run:'R-2',sha256:reviewHash,report}]);
    const state=fold(recorded), item=state.items.get(batch.id);
    assert.equal(item.finding_bindings.length,2);
    assert.equal(queueSelected(item,state),false);
    assert.equal(queueSelected(item,state,{selected_only:true}),false);
    assert.equal(itemConditions(state,'ENG-1').Accepted.status,'True');
    assert.equal(itemConditions(state,'ENG-1').phase,'accepted');
    assert.deepEqual(intake(recorded,report),[]);
    for (const event of [
      {type:'item.updated',id:batch.id,fields:{meta:{queue_selected:true}}},
      {type:'run.started',id:'R-3',item:batch.id},
    ]) assert.equal(itemConditions(fold(stamp([...recorded,event])),'ENG-1').phase,'needs-work');
    const selected=fold(stamp([...recorded,{type:'item.updated',id:batch.id,fields:{meta:{queue_selected:true}}}]));
    assert.equal(queueSelected(selected.items.get(batch.id),selected),true);
    assert.ok(dispatchInput({events:recorded,state:selected,item:selected.items.get(batch.id)}));
  }
});

test('a waiting Minor batch cannot turn a negative judgment or missing intent evidence into acceptance', () => {
  for (const edit of [report=>{report.extra.verdict='FAIL';},report=>{delete report.extra.acceptance;}]) {
    const events=seed(),report=data(minors);edit(report);
    const added=intake(events,report),state=fold(stamp([...events,...added,{type:'report.ingested',run:'R-2',sha256:reviewHash,report}]));
    assert.notEqual(itemConditions(state,'ENG-1').Accepted.status,'True');
    if(report.extra.verdict==='FAIL')assert.equal(itemConditions(state,'ENG-1').phase,'needs-work');
  }
});

test('old typed Minor owners, selection and UNKNOWN attempts survive new review intake', () => {
  const events=seed(),report=data(minors),initial=intake(events,report),batch=initial.find(e=>e.type==='item.added');
  // An old per-finding owner has no new batch marker and remains selected.
  delete batch.meta.review_minor_batch;batch.meta.queue_selected=true;
  const prior=stamp([...events,...initial.filter(e=>e.type!=='change.reviewed'),
    {type:'run.started',id:'R-3',item:batch.id,meta:{dispatch_attempt:'UNKNOWN'}}]);
  const before=fold(prior),added=intake(prior,report),after=fold(stamp([...prior,...added]));
  assert.equal(added.filter(e=>e.type==='item.added').length,0);
  assert.deepEqual(after.items.get(batch.id),before.items.get(batch.id));
  assert.deepEqual(after.runs.get('R-3'),before.runs.get('R-3'));
});

test('Part 1 backfill honors concrete manual dispositions and refuses malformed plain findings', () => {
  const body='## Batched Minors\n- a.mjs:4 - Empty input loses context\n- b.mjs:8 - Retry loses context';
  const alias=batchedMinorKey('REV-1','R-2',reviewHash,batchedMinorSection(body).rows[0]);
  const events=stamp([...seed(),{type:'change.reviewed',review_run:'R-2',review_key:`ENG-1:${head}`,verdict:'PASS',report_sha256:reviewHash,findings:[]},
    {type:'note.added',id:'REV-1',text:'minor-batch: '+JSON.stringify({schema:'brain.minor-batch/v1',finding:alias,status:'dismissed',
      reason:'Captured contract explicitly permits empty input',evidence:'/evidence/contract.md'})}]);
  const added=intake(events,data(undefined),body);
  assert.equal(added.filter(e=>e.type==='review.finding-linked').length,1);
  assert.equal(added.find(e=>e.type==='review.finding-linked').finding.text,'b.mjs:8 - Retry loses context');
  assert.deepEqual(intake(stamp([...events,...added]),data(undefined),body),[]);
  for(const invalid of ['## Batched Minors\n- missing location','## Batched Minors\n',body+'\ncontinued'])
    assert.throws(()=>intake(seed(),data(undefined),invalid),/Batched Minors requires/);
  assert.throws(()=>intake(seed(),data(minors,[{role:'engineer',title:'Repair',extra:{review_findings:['unknown']}}])),/missing\/ambiguous/);
});

test('re-ingesting an immutable Part 1 report backfills its aliases once, preserving report and judgment bytes', t => {
  const f=setupOrg();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  transact(f.dir,()=>({add:seed()}));
  const file=path.join(f.root,'review.md'),body='## Batched Minors\n- a.mjs:4 - Empty input loses context\n- a.mjs:4 - Empty input loses context\n- `b.mjs:8` - Retry loses context\n';
  const bytes=`---\nrun: R-2\noutcome: done\nsummary: Reviewed\nheadline: Review complete\nverdict: PASS\nproposals: []\n---\n${body}`;
  fs.writeFileSync(file,bytes);
  const hash=createHash('sha256').update(bytes).digest('hex');
  const original={type:'change.reviewed',item:'ENG-1',head,base,review_key:`ENG-1:${head}`,review_item:'REV-1',review_run:'R-2',verdict:'PASS',report_sha256:hash,findings:[]};
  fs.mkdirSync(path.join(f.dir,'reports'),{recursive:true});fs.writeFileSync(path.join(f.dir,'reports/R-2.md'),bytes);
  transact(f.dir,()=>({add:[{type:'report.ingested',run:'R-2',item:'REV-1',file:'reports/R-2.md',sha256:hash,report:{run:'R-2',outcome:'done',extra:{verdict:'PASS'}}},original]}));
  const old=f.events(), oldJudgment=old.find(e=>e.type==='change.reviewed');
  assert.match(f.ok(['ingest',file]),/unselected Minor batch/);
  const events=f.events(),batches=events.filter(e=>e.type==='item.added'&&e.meta?.review_minor_batch);
  assert.equal(batches.length,1);
  assert.equal(events.filter(e=>e.type==='review.finding-linked').length,2,'equal content retains one canonical key');
  assert.deepEqual(events.find(e=>e.type==='change.reviewed'),oldJudgment);
  assert.deepEqual(events.filter(e=>e.type==='report.ingested'),old.filter(e=>e.type==='report.ingested'));
  const inventory=collectMinors({events,org:f.dir});
  assert.equal(inventory.findings.length,3,'every original body-line identity survives');
  assert.deepEqual(inventory.pending,[]);
  assert.deepEqual(inventory.issues,[]);
  assert.ok(inventory.findings.every(row=>row.disposition.batch===batches[0].id));
  assert.equal(fs.readFileSync(path.join(f.dir,'reports/R-2.md'),'utf8'),bytes);
  assert.match(f.ok(['ingest',file]),/already recorded/);
  assert.equal(f.events().length,events.length);
});
