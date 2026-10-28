import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fold} from '../lib/state.mjs';
import {reviewAttempt} from '../line-service/review.mjs';
import {producerReviewObservation} from '../line-service/review-observation.mjs';

function fixture(t){
  const repo=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'review-observation-'))),org=path.join(repo,'.org'),identity=path.join(repo,'.git');
  t.after(()=>fs.rmSync(repo,{recursive:true,force:true}));const dir=path.join(org,'evidence/ENG-1/R-1');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'landings-and-review-observation.json'),head='a'.repeat(40),base='b'.repeat(40),target={head,base,reportHash:'c'.repeat(64),evidence_kind:'native-landings/v1',scope:{commits:[head],unresolved:[]}};
  const events=[{type:'item.added',id:'ENG-1',role:'engineer',title:'Source'},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace:repo,meta:{lane:'source'}},
    {type:'run.claimed',run:'R-1',owner:{controller:'brain',legacy:false}},
    {type:'run.updated',id:'R-1',meta:{agent:'worker',pane:'pane',worker_workspace:'workspace',terminal_id:'terminal',agent_session_id:'session'}},
    {type:'change.landed',item:'ENG-1',run:'R-1',head,base,project:identity,landed_at:'2026-10-27T00:00:00Z',producer:{agent:'worker',pane:'pane',terminal:'terminal',session:'session',ownership_generation:3}},
    {type:'item.added',id:'REV-1',role:'reviewer',title:'Existing review',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_target:target,review_round_cap:1}},
    {type:'run.started',id:'R-2',item:'REV-1',workspace:repo},
    {type:'report.ingested',run:'R-1',report:{outcome:'done',artifacts:[file,`Commit: ${head}`]},sha256:'c'.repeat(64)}].map((e,i)=>({...e,seq:i+1,at:'2026-10-27T00:00:00Z',by:'fixture'}));
  const state=fold(events),value={observed_at:'2026-10-27T00:01:00Z',landed:[events[4]],reviews:[{item:'REV-1',run:'R-1',head,base,cap:1,runs:['R-2'],closed:null,evidence_kind:'native-landings/v1'}]};
  fs.writeFileSync(file,JSON.stringify(value));
  const context={events,state,item:'ENG-1',run:'R-1',identity,nativeHeads:new Set([head])};
  const attempt=()=>reviewAttempt(state.items.get('ENG-1'),{events,state,org,repo,identity,target,capturedRun:'R-1',ignoreQueue:'REV-1'});
  return {repo,org,dir,file,head,base,target,events,state,value,context,attempt};
}

test('record-backed landing and existing-review readback is producer evidence despite its pathname; real UNKNOWN attempts still hold',t=>{
  const f=fixture(t);assert.equal(producerReviewObservation(f.value,f.context),true);assert.equal(f.attempt(),null);
  const unknown=path.join(f.dir,'actual-review-unknown.json');fs.writeFileSync(unknown,JSON.stringify({run:'R-1',head:f.head,native_launch_attempted:true,qualification:'UNKNOWN'}));
  assert.match(f.attempt(),/UNKNOWN/);fs.unlinkSync(unknown);
  for(const patch of [{native_launch_attempted:false},{qualification:'UNKNOWN'},{landed:[{...f.value.landed[0],project:'/foreign'}]},{reviews:[{...f.value.reviews[0],runs:['R-999']}]},{reviews:[{...f.value.reviews[0],head:'d'.repeat(40)}]}]){
    const value={...f.value,...patch};assert.equal(producerReviewObservation(value,f.context),false);fs.writeFileSync(f.file,JSON.stringify(value));
    assert.equal(f.attempt(),null,'rejected producer observation without a typed attempt cannot hold the change');
    const typed={...value,run:'R-1',head:f.head,native_launch_attempted:true,qualification:'UNKNOWN'};
    fs.writeFileSync(f.file,JSON.stringify(typed));const bytes=fs.readFileSync(f.file);
    assert.match(f.attempt(),/UNKNOWN/);assert.deepEqual(fs.readFileSync(f.file),bytes,'positive UNKNOWN attempt remains immutable');
  }
});

test('an actual existing same-change queue and copied foreign or changed native receipts remain exclusive',t=>{
  const f=fixture(t);
  assert.match(reviewAttempt(f.state.items.get('ENG-1'),{events:f.events,state:f.state,org:f.org,repo:f.repo,identity:f.context.identity,target:f.target,capturedRun:'R-1'}),/existing whole producer/);
  assert.equal(producerReviewObservation(f.value,{...f.context,nativeHeads:new Set()}),false);
  assert.equal(producerReviewObservation({...f.value,landed:[{...f.value.landed[0],producer:{agent:'someone-else'}}]},f.context),false);
  fs.writeFileSync(f.file,JSON.stringify({run:'R-1',head:f.head,stage:'launching'}));assert.match(f.attempt(),/UNKNOWN/);
});
