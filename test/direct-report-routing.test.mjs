import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { ROUTE_PRESET } from '../lanes/preset.mjs';
import { resumeSessionArguments } from '../lanes/routes.mjs';
import { reviewQueueRoute } from '../line-service/review-queue.mjs';

const queued = () => ({meta:{review_source_run:'R-1',review_source_item:'ENG-1'}});
const context = (family, meta = {}) => ({
  runs:new Map([['R-1',{meta:{harness:family,session_label:family==='codex'?'claude':'codex'}}]]),
  items:new Map([['ENG-1',{meta}]]),
});

test('judgment-heavy and outward reviews select the other declared family; routine reviews use the default', t=>{
  const config=structuredClone(ROUTE_PRESET);
  let independent=0;
  for(const family of ['codex','claude']){
    for(const flag of ['judgment_heavy','outward']){
      const route=reviewQueueRoute(config,queued(),context(family,{[flag]:true}));
      assert.equal(route,family==='codex'?'review':'review-codex');
      assert.notEqual(config.routes[route].kind,family);
      independent++;
    }
    assert.equal(reviewQueueRoute(config,queued(),context(family)),'review');
  }
  assert.deepEqual([config.routes.review.kind,config.routes.review.model,config.routes.review.effort],['claude','opus','high']);
  assert.deepEqual([config.routes['review-codex'].kind,config.routes['review-codex'].model,config.routes['review-codex'].effort],['codex','gpt-6.1-sol','xhigh']);
  t.diagnostic(`judgment/outward other-family route share: ${independent}/4 (100%); routine default: 2/2`);
});

test('routine reviews need neither an other-family policy nor usable producer routing',()=>{
  const config={routes:{review:{kind:'claude'}}},item=queued();
  assert.equal(reviewQueueRoute(config,item,context()),'review');
  const state=context();state.runs.get('R-1').meta.route='removed-producer-route';
  assert.equal(reviewQueueRoute(config,item,state),'review');
  assert.equal(reviewQueueRoute(config,item,context('claude',{judgment_heavy:false,outward:false})),'review');
  config.routes.reviewer={kind:'codex'};
  assert.equal(reviewQueueRoute(config,item,state),'reviewer','project routine default stays authoritative');
});

test('judgment and outward reviews fail closed when the declared independent route is unavailable',()=>{
  for(const flag of ['judgment_heavy','outward']){
    const state=context('claude',{[flag]:true}),item=queued();
    const missing=structuredClone(ROUTE_PRESET);delete missing.selection_policy.by_task_class['review-other-family'];
    assert.throws(()=>reviewQueueRoute(missing,item,state),/other-family review unavailable.*unknown task class/);
    delete missing.selection_policy;
    assert.throws(()=>reviewQueueRoute(missing,item,state),/other-family review unavailable.*no selection_policy/);
    const pool=structuredClone(ROUTE_PRESET);pool.selection_policy={by_task_class:{'review-other-family':{codex:'review'}}};
    assert.throws(()=>reviewQueueRoute(pool,item,state),/other-family review unavailable.*no claude pool/);
    const bad=structuredClone(ROUTE_PRESET);delete bad.routes['review-codex'];
    assert.throws(()=>reviewQueueRoute(bad,item,state),/other-family review unavailable.*unknown route/);
    assert.throws(()=>reviewQueueRoute(ROUTE_PRESET,item,context(undefined,{[flag]:true})),/declared producer/);
    const declared=context(undefined,{[flag]:true});declared.runs.get('R-1').meta.route='review';
    assert.equal(reviewQueueRoute(ROUTE_PRESET,item,declared),'review-codex','declared producer route fallback');
  }
});

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
