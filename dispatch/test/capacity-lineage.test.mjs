import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fixture,sessionCapSetting} from './dispatch-fixture.mjs';
import {validateCapacityAllocation} from '../capacity-lineage.mjs';

const events=f=>fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const journals=f=>f.jobs().map(journal=>({...JSON.parse(fs.readFileSync(journal)),journal}));
const resign=r=>{const {id,...payload}=r;return{id:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),...payload};};

test('actual serialized dispatcher selects report-released A to B to C and rejects broken original links',t=>{
  const f=fixture(t);sessionCapSetting(f,1);
  const launch=(item,lane)=>{
    const result=f.dispatch([item,'--lane',lane,'--route','engineer','--brief',f.brief]);
    assert.equal(result.status,0,result.stderr+result.stdout);
    const receipt=JSON.parse(result.stdout),job=JSON.parse(fs.readFileSync(receipt.journal));
    assert.ok(job.capacityAllocation,job.capacityLineageUnknown);
    assert.deepEqual(job.sessionCap.capacity_allocation,job.capacityAllocation);
    return{...job,journal:receipt.journal};
  };
  const finish=job=>{
    const file=path.join(f.root,job.run+'.md');
    fs.writeFileSync(file,`---\nrun: ${job.run}\noutcome: done\nsummary: Fixture source complete\nheadline: Fixture source complete\n---\n`);
    f.rec(['ingest',file]);
  };
  const a=launch(f.item,'a');assert.equal(a.capacityAllocation.freedBy,null);
  const itemB=f.rec(['add','B consumes A capacity','--role','engineer']).match(/ENG-\d+/)[0];
  const held=f.dispatch([itemB,'--lane','b','--route','engineer','--brief',f.brief]);
  assert.notEqual(held.status,0);assert.match(held.stderr,/cap 1 reached/);
  assert.equal(journals(f).filter(j=>j.run).length,1,'no start or lineage fabricated while full');
  finish(a);const b=launch(itemB,'b');finish(b);
  const itemC=f.rec(['add','C consumes B capacity','--role','engineer']).match(/ENG-\d+/)[0],c=launch(itemC,'c');
  const all=events(f),jobs=journals(f),capacity=c.capacityAllocation.capacity;
  for(const [parent,child]of [[a,b],[b,c]]){
    const r=child.capacityAllocation,p=parent.capacityAllocation;
    assert.equal(r.slot,p.slot);assert.deepEqual(r.predecessor,{id:p.id,journal:parent.journal});
    const release=all.find(e=>e.seq===r.freedBy.seq);
    assert.equal(release.type,'report.ingested');assert.equal(release.run,parent.run);
    assert.equal(r.freeAt,release.at);assert.equal(r.freedBy.sha256,release.sha256);
    assert.ok(Date.parse(child.sessionBinding.prompted_at)>=Date.parse(r.freeAt));
    assert.equal(validateCapacityAllocation(r,{events:all,journals:jobs,capacity}),r);
  }
  // These controls repair receipt hashes too: source joins, not a checksum
  // mismatch alone, must reject them. Unknown history never receives freeAt.
  const original=c.capacityAllocation;
  for(const change of [
    r=>{r.freedBy=null;},
    r=>{r.allocation.claim_generation++;},
    r=>{r.capacity.pool='review';},
    r=>{r.predecessor.id='f'.repeat(64);},
    r=>{r.freedBy.seq=a.capacityAllocation.allocation.started_seq;},
  ]){
    let bad=structuredClone(original);change(bad);bad=resign(bad);
    const changed=structuredClone(jobs),current=changed.find(j=>j.run===c.run);current.capacityAllocation=bad;
    assert.throws(()=>validateCapacityAllocation(bad,{events:all,journals:changed,capacity}),/capacity lineage:/);
  }
  assert.throws(()=>validateCapacityAllocation(null,{events:all,journals:jobs,capacity}),/missing/);
  const missing=all.filter(e=>e.seq!==original.freedBy.seq);
  assert.throws(()=>validateCapacityAllocation(original,{events:missing,journals:jobs,capacity}),/release/);
  const fork=structuredClone(jobs);fork.push({...c,journal:'other',capacityAllocation:{...original,id:'other'}});
  assert.throws(()=>validateCapacityAllocation(original,{events:all,journals:fork,capacity}),/another allocation/);
  assert.equal(validateCapacityAllocation(original,{events:all,journals:jobs,capacity}),original,'untouched original recovers');
  t.diagnostic(JSON.stringify({rehearsal:'A to B to C through dispatch.mjs, checkSessionCap and actual report ingestion',
    allocations:[a,b,c].map(j=>j.capacityAllocation),
    releases:all.filter(e=>[b,c].some(j=>j.capacityAllocation.freedBy.seq===e.seq)),
    inputs:[a,b,c].map(j=>({run:j.run,prompted_at:j.sessionBinding.prompted_at}))}));
});
