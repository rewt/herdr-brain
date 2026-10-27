import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { ROUTE_PRESET } from '../lanes/preset.mjs';
import { resumeSessionArguments } from '../lanes/routes.mjs';
import { reviewQueueRoute } from '../line-service/review-queue.mjs';

test('direct report review routing uses the declared producer family and preserves fresh saved-session launch syntax',()=>{
  const config=structuredClone(ROUTE_PRESET);
  for(const [family,route]of [['codex','review'],['claude','review-codex']]){
    const item={meta:{review_source_run:'R-1',review_source_item:'ENG-1',review_other_family:true}};
    const state={runs:new Map([['R-1',{meta:{harness:family,session_label:family==='codex'?'claude':'codex'}}]]),items:new Map()};
    assert.equal(reviewQueueRoute(config,item,state),route);
    const wrong=structuredClone(config);wrong.selection_policy.by_task_class['review-other-family'][family]=family==='codex'?'review-codex':'review';
    assert.throws(()=>reviewQueueRoute(wrong,item,state),/matches producer family/);
    assert.throws(()=>reviewQueueRoute(config,item,{...state,runs:new Map()}),/declared producer/);
  }
  const id='01a173a6-8116-7051-a945-b630511218dd';
  assert.deepEqual(resumeSessionArguments({kind:'codex',launch:['/owned/bin/ai','--profile','owner']},id),['resume',id]);
  assert.deepEqual(resumeSessionArguments({kind:'claude',launch:['ai']},id),['--resume',id]);
  assert.throws(()=>resumeSessionArguments({kind:'codex'},id),/identity wrapper/);
  assert.throws(()=>resumeSessionArguments({kind:'codex',launch:['ai']},'--last'),/explicit saved native/);
});
