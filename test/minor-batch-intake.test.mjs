import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fold, itemConditions, itemStatus } from '../lib/state.mjs';
import { proposalSelection } from '../lib/proposal-intake.mjs';
import { correctionBrief } from '../lib/correction-brief.mjs';
import { REVIEW_LIVE_WITNESS_PREFIX } from '../lib/review-live-trigger.mjs';
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
  {severity:'minor',text:'b.mjs:8 - Retry loses context'}];

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
    assert.equal(itemStatus(state,item.id),'proposed');
    assert.equal(proposalSelection(item),'unselected');
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
  for (const edit of [report=>{report.extra.verdict='FAIL';},report=>{report.extra.verdict='NEEDS-WORK';},report=>{delete report.extra.acceptance;}]) {
    const events=seed(),report=data(minors);edit(report);
    const added=intake(events,report),state=fold(stamp([...events,...added,{type:'report.ingested',run:'R-2',sha256:reviewHash,report}]));
    assert.notEqual(itemConditions(state,'ENG-1').Accepted.status,'True');
    const batch=added.find(e=>e.type==='item.added');
    assert.equal(queueSelected(state.items.get(batch.id),state),false);
    if(report.extra.verdict!=='PASS')assert.equal(itemConditions(state,'ENG-1').phase,'needs-work');
  }
});

test('immediate Minors and distinct triggers have separate unselected owners and retain explicit brief triggers', () => {
  const events=seed(), findings=[...minors,
    {severity:'minor',text:'First conditional',live_trigger:'First race observed live'},
    {severity:'minor',text:'Same conditional trigger',live_trigger:'First race observed live'},
    {severity:'minor',text:'Second conditional',live_trigger:'Second race observed live'}];
  const report=data(findings), added=intake(events,report), batches=added.filter(e=>e.type==='item.added');
  assert.equal(batches.length,3);
  assert.deepEqual(batches.map(b=>b.meta.review_finding_keys.length),[2,2,1]);
  let recorded=stamp([...events,...added,{type:'report.ingested',run:'R-2',sha256:reviewHash,report}]);
  let state=fold(recorded);
  assert.equal(itemConditions(state,'ENG-1').phase,'accepted');
  for(const batch of batches) assert.equal(queueSelected(state.items.get(batch.id),state),false);
  recorded=stamp([...recorded,...batches.map(b=>({type:'item.updated',id:b.id,fields:{meta:{queue_selected:true}}}))]);
  state=fold(recorded);
  assert.equal(queueSelected(state.items.get(batches[0].id),state),true);
  for(const batch of batches.slice(1)) assert.equal(queueSelected(state.items.get(batch.id),state),false);
  const first=state.items.get(batches[1].id);
  for(const binding of first.finding_bindings) recorded=stamp([...recorded,{type:'note.added',id:first.id,
    text:REVIEW_LIVE_WITNESS_PREFIX+JSON.stringify({schema:'brain.review-live-witness/v1',finding_key:binding.finding_key,
      trigger:binding.finding.live_trigger,observed_at:'2026-11-01T17:59:00Z',evidence:'/evidence/live'})}]);
  state=fold(recorded);
  assert.equal(queueSelected(state.items.get(first.id),state),true);
  assert.ok(dispatchInput({events:recorded,state,item:state.items.get(first.id)}));
  assert.equal(queueSelected(state.items.get(batches[2].id),state),false);
  assert.equal(dispatchInput({events:recorded,state,item:state.items.get(batches[2].id)}),null);
  const brief=correctionBrief({item:first,findings:first.finding_bindings,prior:[],org:'/record',repo:'/repo'});
  assert.match(brief,/Live trigger for .*: First race observed live/);
  assert.deepEqual(intake(recorded,report),[]);
});

test('batch proposals retain rationale, acceptance, capability and all scoped metadata in fixer context', () => {
  const proposals=[{role:'engineer',title:'Repair retries',why:'Keep caller context',accept:['Retry retains caller'],
    capability:'node',extra:{custom_hint:'Inspect saved caller'}}];
  for(const list of [proposals,[...proposals,{role:'engineer',title:'Repair empty input',why:'Keep empty reason',accept:['Empty retains reason'],extra:{custom_hint:'Second hint'}}]]) {
    const events=seed(), added=intake(events,data(minors,list)), batch=added.find(e=>e.type==='item.added');
    assert.deepEqual(batch.meta.review_batch_proposals,list);
    assert.match(batch.why,/Keep caller context/);
    assert.ok(batch.accept.some(value=>value.includes('Retry retains caller')));
    if(list.length===1){assert.equal(batch.capability,'node');assert.equal(batch.meta.custom_hint,'Inspect saved caller');}
    const item=fold(stamp([...events,...added])).items.get(batch.id);
    const brief=correctionBrief({item,findings:item.finding_bindings,org:'/record',repo:'/repo'});
    for(const proposal of list) assert.ok(brief.includes(JSON.stringify(proposal)));
  }
});

test('witnessing one selected conditional trigger allows its fix without waiting for an unrelated trigger', () => {
  const events=seed(), report=data([
    {severity:'minor',text:'First condition',live_trigger:'First live trigger'},
    {severity:'minor',text:'Second condition',live_trigger:'Second live trigger'}]);
  const added=intake(events,report), batches=added.filter(e=>e.type==='item.added');
  let recorded=stamp([...events,...added,{type:'report.ingested',run:'R-2',sha256:reviewHash,report},
    ...batches.map(b=>({type:'item.updated',id:b.id,fields:{meta:{queue_selected:true}}}))]);
  let state=fold(recorded);
  assert.equal(itemConditions(state,'ENG-1').phase,'accepted');
  const binding=state.items.get(batches[0].id).finding_bindings[0];
  recorded=stamp([...recorded,{type:'note.added',id:batches[0].id,text:REVIEW_LIVE_WITNESS_PREFIX+JSON.stringify({
    schema:'brain.review-live-witness/v1',finding_key:binding.finding_key,trigger:binding.finding.live_trigger,
    observed_at:'2026-11-01T17:59:00Z',evidence:'/evidence/first-trigger'})}]);
  state=fold(recorded);
  assert.equal(itemConditions(state,'ENG-1').phase,'needs-work');
  assert.equal(queueSelected(state.items.get(batches[0].id),state),true);
  assert.ok(dispatchInput({events:recorded,state,item:state.items.get(batches[0].id)}));
  assert.equal(queueSelected(state.items.get(batches[1].id),state),false);
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
