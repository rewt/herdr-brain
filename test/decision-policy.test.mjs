import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import {recordOnlyJudgment} from '../line-service/decision-policy.mjs';

test('retired judgment selection includes cleanup holds and leaves original typed answers and ordinary work alone',()=>{
  for(const key of ['review:ENG-1:head','dispatch:REV-1:input','closeout:original'])
    assert.equal(recordOnlyJudgment({meta:{uncertain_outcome:{check:{key}}}}),true);
  assert.equal(recordOnlyJudgment({meta:{backlog_batch:1}}),true);
  for(const item of [{},
    {meta:{uncertain_outcome:{check:{key:'source-complete:R-1:report'}}}},
    {meta:{decision_request:{schema:'line-decision/v1'}}}, {meta:{operator_reserved:true}},
    {meta:{uncertain_outcome:{check:{key:'unknown-class'}}}}])
    assert.equal(recordOnlyJudgment(item),false);
});
