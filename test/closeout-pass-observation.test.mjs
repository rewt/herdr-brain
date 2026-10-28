import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,isolatedEnv} from './helpers/retire-fixture.mjs';
import {createCloseoutObservation,closeoutLaneGroups,runCloseoutLanes} from '../lib/closeout.mjs';
import {sweepCommands} from './helpers/retire-sweep-fixture.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {loadRecord,transact} from '../lib/store.mjs';

test('one verified pass observation serves multiple retirement targets and refreshes changed authority once',t=>{
  const f=fixture(t,{occupied:false});isolatedEnv(t,f);
  let reads=0;
  const observation=createCloseoutObservation(f.org,{read:org=>{reads++;return loadRecord(org);}});
  const adapters=[f.retirement({readRecord:()=>observation.read()}),f.retirement({readRecord:()=>observation.read()})];
  for(const adapter of adapters)for(const target of [f.lane,f.repo,f.lane])adapter.observe(target);
  assert.equal(reads,1,'native target observations must not reload/refold unchanged history');
  transact(f.org,()=>({add:[{type:'item.updated',id:'ENG-1',fields:{meta:{hold:true}}}]}));
  for(const adapter of adapters)assert.equal(adapter.observe(f.lane).record.items.find(i=>i.id==='ENG-1').meta.hold,true);
  assert.equal(reads,2,'a changed subject is reloaded once, then shared');
  fs.appendFileSync(f.eventFile,'{"incomplete":');
  assert.throws(()=>adapters[0].observe(f.lane),/incomplete closeout record/);
});

test('parallel lane grouping excludes same-lane and transitive native aliases',()=>{
  const target=(key,cwd,panes=[])=>({entry:{key,cwd,common:'/repo/.git',branch:`lane/${key}`,gitDirectory:`/git/${key}`,panes}});
  const a=target('a','/lanes/a',[{pane:'a:p',tab:'a:t'}]),b=target('b','/lanes/b',[{pane:'b:p',tab:'b:t'}]);
  const same=target('same','/lanes/a'),bridge=target('bridge','/lanes/c',[{pane:'b:p',tab:'a:t'}]);
  assert.deepEqual(closeoutLaneGroups([a,b,same]),[[a,same],[b]]);
  assert.deepEqual(closeoutLaneGroups([a,b,same,bridge]),[[a,b,same,bridge]]);
});


test('independent cleanup lanes overlap while each lane has one writer and a failed lane does not cancel its sibling',async()=>{
  const target=(key,cwd)=>({entry:{key,cwd,common:'/repo/.git',branch:`lane/${cwd.slice(1)}`,gitDirectory:`/git${cwd}`,panes:[]}});
  const targets=[target('a1','/a'),target('b1','/b'),target('a2','/a'),target('c1','/c')];
  let startB,releaseB;
  const bStarted=new Promise(resolve=>{startB=resolve;}),bReleased=new Promise(resolve=>{releaseB=resolve;});
  const active=new Set(),seen=[];
  const results=await runCloseoutLanes(targets,async group=>{
    for(const {entry}of group){
      assert.equal(active.has(entry.cwd),false,'no overlapping writer for the same lane');
      active.add(entry.cwd);seen.push(entry.key);
      if(entry.key==='a1'){await bStarted;assert.ok(active.has('/b'),'independent native work overlaps');releaseB();}
      if(entry.key==='b1'){startB();await bReleased;active.delete(entry.cwd);throw Error('original target UNKNOWN');}
      active.delete(entry.cwd);
    }
    return group.map(t=>t.entry.key);
  });
  assert.ok(seen.indexOf('a2')>seen.indexOf('a1'));assert.ok(seen.includes('c1'));
  assert.equal(results.filter(r=>r.error).length,1);assert.match(results.find(r=>r.error).error.message,/UNKNOWN/);
});


test('shared cleanup observations refuse changed HOLD claim and main CAS at the removal boundary',t=>{
  for(const change of ['HOLD','claim','CAS']){
    const f=fixture(t,{occupied:false});isolatedEnv(t,f);
    const observation=createCloseoutObservation(f.org),rows=[];
    const {command}=sweepCommands(f);let reached=false;
    const adapter=f.retirement({command,readRecord:()=>observation.read(),log:row=>rows.push(row),lockRemoval:()=>{
      const release=acquireLock(path.join(f.common,'lane-promote.lock'));reached=true;
      try{
        if(change==='HOLD'){fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.repo,'.lane/supervisor/HOLD-WORKER-TAB-CLOSE'),'held');}
        if(change==='claim')transact(f.org,()=>({add:[{type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner:{controller:'foreign',legacy:true,release:null}}]}));
        if(change==='CAS')f.git(['update-ref','refs/heads/main',`${f.head}^`,f.head]);
      }catch(error){release();throw error;}
      return release;
    }});
    assert.throws(()=>adapter.removeLane({lane:f.lane,branch:'lane/topic',expectedTip:f.head,gitOnly:true}),/held|authority changed|epoch|project changed/i,change);
    assert.equal(reached,true,change+' reached final locked boundary');
    assert.ok(fs.existsSync(f.lane),change);assert.equal(f.git(['rev-parse','refs/heads/lane/topic']),f.head);
    assert.equal(rows.some(row=>['worktree-removed','branch-removed'].includes(row.action)),false,change);
  }
});
