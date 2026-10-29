import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {setConfig,configSnapshot} from '../lib/config-command.mjs';
import {reviewAdmissionHold} from '../lib/review-admission.mjs';
import {readReviewAdmission,reviewAdmissionSubject} from '../line-service/review-admission.mjs';

const key=`ENG-16:R-32:${'a'.repeat(64)}`,head='b'.repeat(40),policy={enabled:true,producer_groups:[key],canonical_commits:[head],hold_ordinary:true};
test('review admission matches exact captured groups and canonical commits without broadening ordinary or legacy reviews',()=>{
  for(const disabled of [undefined,{enabled:false}])for(const kind of ['producer','canonical','ordinary','unknown'])assert.equal(reviewAdmissionHold(disabled,{kind}),null);
  for(const subject of [{kind:'producer',selector:key},{kind:'canonical',selector:head}])assert.equal(reviewAdmissionHold(policy,subject),null);
  for(const [subject,code]of [[{kind:'producer',selector:`ENG-16:R-33:${'a'.repeat(64)}`},'PRODUCER_NOT_ALLOWED'],
    [{kind:'canonical',selector:head.slice(0,8)},'CANONICAL_NOT_ALLOWED'],[{kind:'ordinary'},'ORDINARY_HELD'],[{kind:'unknown'},'BINDING_UNKNOWN']])
    assert.equal(reviewAdmissionHold(policy,subject).code,`REVIEW_ADMISSION_${code}`);
  assert.equal(reviewAdmissionHold({...policy,hold_ordinary:false},{kind:'ordinary'}),null);
  const item={id:'REV-1',role:'reviewer',meta:{review_key:'ENG-16:'+head,review_round_cap:1,review_source_item:'ENG-16',review_source_run:'R-32',review_target:{head,reportHash:'a'.repeat(64),source_group:{key}}}};
  assert.deepEqual(reviewAdmissionSubject({item}),{kind:'producer',selector:key});
  item.meta.review_target={head,evidence_kind:'canonical-unattributed/v1'};
  assert.deepEqual(reviewAdmissionSubject({item}),{kind:'canonical',selector:head});
  assert.equal(reviewAdmissionSubject({item:{role:'reviewer',meta:{}}}).kind,'unknown');
  assert.deepEqual(reviewAdmissionSubject({selector:'canonical:'+head,target:{head}}),{kind:'canonical',selector:head});
});

for(const adopted of [false,true])test(`review admission supported writer is project scoped with provenance and default-off restore (${adopted?'home':'repository'})`,async t=>{
  const f=configFixture(t,{custom:true,routing:true});if(adopted)await f.adopt();
  assert.deepEqual(readReviewAdmission(f.cwd,f.env),{enabled:false});
  setConfig('review_admission',JSON.stringify(policy),{cwd:f.cwd,env:f.env,who:'scoped fixture selection'});
  assert.deepEqual(readReviewAdmission(f.cwd,f.env),policy);
  const rows=configSnapshot({cwd:f.cwd,env:f.env}).values.filter(r=>r.key.startsWith('review_admission.'));
  assert.equal(rows.length,4);assert.ok(rows.every(r=>r.scope==='project'));
  if(adopted)assert.throws(()=>setConfig('review_admission',JSON.stringify(policy),{cwd:f.cwd,env:f.env,scope:'identity'}),/project lane policy only/);
  setConfig('review_admission','',{cwd:f.cwd,env:f.env,unset:true});
  assert.deepEqual(readReviewAdmission(f.cwd,f.env),{enabled:false});
});
