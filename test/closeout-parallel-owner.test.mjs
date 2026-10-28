import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,isolatedEnv,hold} from './helpers/retire-fixture.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {bindCloseoutSources,currentCloseoutEntries,retirementOwnerLock} from '../lib/closeout.mjs';
import {drainCloseoutParallel} from '../lib/closeout-executor.mjs';

test('parallel cleanup retains one parent consumer and retirement owner through both lane outcomes',async t=>{
  const f=fixture(t,{occupied:false});isolatedEnv(t,f);
  fs.symlinkSync(f.org,path.join(f.repo,'.org'));
  fs.appendFileSync(path.join(f.common,'info/exclude'),'\n.org\n.lane/\n');
  fs.writeFileSync(path.join(f.repo,'.lane.json'),'{"retirement":{"closeout_queue":true}}');
  const second=path.join(f.scratch,'second');f.git(['worktree','add','-b','lane/second',second]);
  fs.writeFileSync(f.eventFile,loadEvents(f.org).events.filter(e=>!['item.closed','report.ingested'].includes(e.type)).map(e=>JSON.stringify(e)+'\n').join(''));
  transact(f.org,events=>bindCloseoutSources({cwd:f.repo,org:f.org,events,env:f.env,mutation:{add:[
    {type:'item.added',id:'ENG-2',role:'engineer',title:'Independent lane'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:second,meta:{agent:'second',pane:'b:p',worker_workspace:'b',terminal_id:'b-terminal',agent_session_id:'b-session',lane:'second'}},
    ...['R-1','R-2'].map(run=>({type:'report.ingested',run,sha256:'fixture',report:{outcome:'blocked',summary:'Stopped work'}})),
  ]}}));
  const entries=currentCloseoutEntries(f.common,f.org,loadEvents(f.org).events);assert.equal(entries.length,2);
  hold(f);let claims=0,exits=0;
  const consumer=path.join(f.common,'closeout/consumer.lock'),owner=retirementOwnerLock(f.common);
  const result=await drainCloseoutParallel({cwd:f.repo,org:f.org,env:f.env,keys:entries.map(e=>e.key),
    onClaim:()=>{claims++;assert.ok(fs.existsSync(consumer));},beforeExit:()=>{
      exits++;assert.ok(fs.existsSync(consumer));assert.ok(fs.existsSync(owner));
      for(const directory of [consumer,owner])assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'owner.json'))).pid,process.pid);
    }});
  assert.equal(claims,1);assert.equal(exits,1);assert.equal(result.evaluated.length,2,JSON.stringify(result));
  assert.ok(result.evaluated.every(e=>!e.completed&&/retirement held:/.test(e.reason)));
  assert.equal(fs.existsSync(consumer),false);assert.equal(fs.existsSync(owner),false);
  assert.ok(fs.existsSync(f.lane)&&fs.existsSync(second));assert.equal(f.herdrCalls().length,0);
  const rows=loadEvents(f.org).events.filter(e=>e.type==='closeout.evaluated');
  assert.equal(rows.length,2);assert.ok(rows[0].seq<rows[1].seq,'record appends retain their normal order');
});
