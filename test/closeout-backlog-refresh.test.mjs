import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {reconcileCloseoutBacklog} from '../lib/closeout-backlog.mjs';

test('a corrected legacy classification appends its binding exception without replacing the original wait or attempt',t=>{
  const f=setup(t,{direct:true,bound:true});selectCurrentCleanup(f);const [source]=f.report(),entry=source.closeout_targets[0];
  const original=events(f);original.find(e=>e.seq===source.seq).closeout_targets[0].schema='closeout-entry/v1';
  fs.writeFileSync(f.eventFile,original.map(e=>JSON.stringify(e)+'\n').join(''));
  const [evaluation]=f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,source:{seq:source.seq,type:source.type},
    run:entry.run,item:entry.item,revision:source.seq,completed:false,reason:'retirement deadline reached; request remains pending'}]);
  f.append([{type:'closeout.waiting',identity:f.common,key:entry.key,source:{seq:source.seq,type:source.type},wait_id:'original-wait',
    waiting:{owner:'line-service',defect:'No existing completion writer',producers:[]}},
  {type:'closeout.wait-classified',identity:f.common,key:entry.key,source:{seq:source.seq,type:source.type},wait_id:'original-wait',
    evaluation_seq:evaluation.seq,disposition:'continuation'}]);
  const before=events(f),calls=f.herdrCalls(),args={project:gitProject(f.repo),org:f.org,events:before,guard:()=>{}};
  const rows=reconcileCloseoutBacklog(args);assert.equal(rows.length,1);assert.equal(rows[0].disposition,'held');
  assert.deepEqual(rows[0].binding,{schema:'closeout-entry/v1',actionable:false});
  assert.deepEqual(events(f).slice(0,before.length),before);assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.read().actions,[]);
  assert.deepEqual(reconcileCloseoutBacklog({...args,events:events(f)}),[]);
});
