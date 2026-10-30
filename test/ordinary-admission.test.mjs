import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import {fold} from '../lib/state.mjs';
import {fold as oldFold} from './fixtures/state-pre-session-bind.mjs';
import {validatePolicy} from '../lib/config-policy.mjs';
import {ordinaryAdmissionHold} from '../lib/ordinary-admission.mjs';
import {queueSelected} from '../line-service/priority-order.mjs';
import {readOrdinaryAdmission,readReviewAdmission} from '../line-service/review-admission.mjs';
import {setConfig,configSnapshot} from '../lib/config-command.mjs';
import {configFixture} from './helpers/config-home-fixture.mjs';

test('ordinary admission validates project-only exact selectors even when disabled',()=>{
  for(const policy of [{selected_only:false},{selected_only:true},{selected_only:true,items:['G-9','ENG-2']}]){
    assert.equal(validatePolicy('lane',{ordinary_admission:policy}).ordinary_admission,policy);
    for(const kind of ['identity','routing'])assert.throws(()=>validatePolicy(kind,{ordinary_admission:policy}),/project lane policy only/);
    assert.doesNotThrow(()=>validatePolicy('routing-snapshot',{ordinary_admission:policy}));
  }
  for(const bad of [null,[],{},true,{selected_only:1},{selected_only:true,typo:[]},{selected_only:true,items:'ENG-2'},
    {selected_only:true,items:['*']},{selected_only:true,items:['ENG-2','ENG-2']},{selected_only:false,items:['ENG-0']}])
    assert.throws(()=>validatePolicy('lane',{ordinary_admission:bad}),/ordinary_admission/);
});

test('ordinary admission is opt-in and selects exact own flags or a named item/ancestor set without changing folds',()=>{
  const events=[{type:'item.added',id:'G-9',kind:'goal',title:'Selected wave'},
    {type:'item.added',id:'ENG-1',role:'engineer',title:'Legacy backlog'},
    {type:'item.added',id:'ENG-2',role:'engineer',title:'Flag',meta:{queue_selected:true}},
    {type:'item.added',id:'ENG-3',role:'engineer',title:'Descendant proposal',parent:'G-9',from_run:'R-1'},
    {type:'item.added',id:'ENG-4',role:'engineer',title:'Explicit veto',parent:'G-9',meta:{queue_selected:false}},
    {type:'item.added',id:'ENG-5',role:'engineer',title:'Named proposal',from_run:'R-1'},
    {type:'item.added',id:'ENG-6',role:'engineer',title:'Unselected proposal',from_run:'R-1'},
    {type:'item.added',id:'REV-1',role:'reviewer',title:'Existing review'}];
  const state=fold(events),policy={selected_only:true,items:['G-9','ENG-5']};
  for(const id of ['ENG-2','ENG-3','ENG-5','REV-1'])assert.equal(queueSelected(state.items.get(id),state,policy),true,id);
  for(const id of ['ENG-1','ENG-4','ENG-6'])assert.equal(queueSelected(state.items.get(id),state,policy),false,id);
  assert.equal(ordinaryAdmissionHold(policy,{item:state.items.get('ENG-1'),state}).code,'ORDINARY_ADMISSION_NOT_SELECTED');
  assert.equal(ordinaryAdmissionHold(policy,{item:state.items.get('ENG-4'),state}).code,'ORDINARY_ADMISSION_DESELECTED');
  for(const disabled of [undefined,{selected_only:false,items:['G-9']}])for(const item of state.items.values()){
    assert.equal(ordinaryAdmissionHold(disabled,{item,state}),null);
    assert.equal(queueSelected(item,state,disabled),queueSelected(item));
  }
  const historical=oldFold(events);
  for(const item of state.items.values())assert.equal(queueSelected(historical.items.get(item.id),historical,policy),queueSelected(item,state,policy));
  assert.equal(queueSelected(state.items.get('ENG-3')),false,'default keeps proposal own-selection rule');
});

for(const adopted of [false,true])test(`ordinary admission supported writer preserves project provenance and default-off restore (${adopted?'home':'repository'})`,async t=>{
  const f=configFixture(t,{custom:true,routing:true});if(adopted)await f.adopt();
  const policy={selected_only:true,items:['G-9','ENG-2']};
  assert.deepEqual(readOrdinaryAdmission(f.cwd,f.env),{selected_only:false});
  setConfig('ordinary_admission',JSON.stringify(policy),{cwd:f.cwd,env:f.env,who:'explicit fixture wave'});
  assert.deepEqual(readOrdinaryAdmission(f.cwd,f.env),policy);
  const review={enabled:true,producer_groups:[`ENG-16:R-32:${'a'.repeat(64)}`],canonical_commits:['b'.repeat(40)],hold_ordinary:true};
  setConfig('review_admission',JSON.stringify(review),{cwd:f.cwd,env:f.env,who:'retained review freeze'});
  setConfig('review_admission.hold_ordinary','false',{cwd:f.cwd,env:f.env,who:'admit only selected ordinary work'});
  assert.deepEqual(readReviewAdmission(f.cwd,f.env),{...review,hold_ordinary:false});
  const rows=configSnapshot({cwd:f.cwd,env:f.env}).values.filter(r=>r.key.startsWith('ordinary_admission.'));
  assert.equal(rows.length,2);assert.ok(rows.every(r=>r.scope==='project'));
  if(adopted)assert.throws(()=>setConfig('ordinary_admission',JSON.stringify(policy),{cwd:f.cwd,env:f.env,scope:'identity'}),/project lane policy only/);
  setConfig('ordinary_admission','',{cwd:f.cwd,env:f.env,unset:true});
  assert.deepEqual(readOrdinaryAdmission(f.cwd,f.env),{selected_only:false});
});
