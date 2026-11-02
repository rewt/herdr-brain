import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fixture,sessionCapSetting} from './dispatch-fixture.mjs';
import {validateCapacityAllocation,selectCapacityAllocation} from '../capacity-lineage.mjs';

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
  const a=launch(f.item,'turnover-a');assert.equal(a.capacityAllocation.freedBy,null);
  const itemB=f.rec(['add','B consumes A capacity','--role','engineer']).match(/ENG-\d+/)[0];
  const held=f.dispatch([itemB,'--lane','turnover-b','--route','engineer','--brief',f.brief]);
  assert.notEqual(held.status,0);assert.match(held.stderr,/cap 1 reached/);
  assert.equal(journals(f).filter(j=>j.run).length,1,'no start or lineage fabricated while full');
  finish(a);const b=launch(itemB,'turnover-b');finish(b);
  const itemC=f.rec(['add','C consumes B capacity','--role','engineer']).match(/ENG-\d+/)[0],c=launch(itemC,'turnover-c');
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

function turnoverFixture(t){
  const f=fixture(t);sessionCapSetting(f,1);
  const add=(title,role='engineer')=>f.rec(['add',title,'--role',role]).match(/(?:ENG|DEC)-\d+/)[0];
  const launch=(item,lane)=>{
    const result=f.dispatch([item,'--lane',lane,'--route','engineer','--brief',f.brief]);
    assert.equal(result.status,0,result.stderr+result.stdout);
    const {journal}=JSON.parse(result.stdout),job={...JSON.parse(fs.readFileSync(journal)),journal};
    assert.ok(job.capacityAllocation,job.capacityLineageUnknown);
    return job;
  };
  const finish=job=>{
    const file=path.join(f.root,job.run+'.md');
    fs.writeFileSync(file,`---\nrun: ${job.run}\noutcome: done\nsummary: Fixture complete\nheadline: Fixture complete\n---\n`);
    f.rec(['ingest',file]);
  };
  const validate=jobs=>{
    const context={events:events(f),journals:journals(f),capacity:jobs[0].capacityAllocation.capacity};
    for(const j of jobs)assert.equal(validateCapacityAllocation(j.capacityAllocation,context),j.capacityAllocation);
    return context;
  };
  const linked=(parent,child)=>{
    const r=child.capacityAllocation;
    assert.equal(r.slot,parent.capacityAllocation.slot);
    assert.deepEqual(r.predecessor,{id:parent.capacityAllocation.id,journal:parent.journal});
    const report=events(f).find(e=>e.type==='report.ingested'&&e.run===parent.run);
    assert.deepEqual(r.freedBy,{type:report.type,seq:report.seq,run:report.run,sha256:report.sha256});
    assert.equal(r.freeAt,report.at);
  };
  return{f,add,launch,finish,validate,linked};
}

test('decision occupancy changes native_cap without splitting configured A to B to C capacity',t=>{
  const {f,add,launch,finish,validate,linked}=turnoverFixture(t);
  const a=launch(f.item,'configured-a');
  const decision=launch(add('Live decision occupant','decision'),'configured-decision');
  assert.equal(decision.sessionCap.kind,'decision');
  finish(a);const b=launch(add('Reuse with a live decision'),'configured-b');
  assert.equal(b.sessionCap.native_cap,a.sessionCap.native_cap+1);
  assert.ok(b.sessionCap.sessions.every(s=>s.kind==='worker'));
  assert.equal(b.sessionCap.native_count,1,'the live decision is counted by final admission');
  f.rec(['abandon',decision.run,'--note','Fixture decision ended']);
  finish(b);const c=launch(add('Reuse after decision ends'),'configured-c');
  assert.equal(c.sessionCap.native_cap,a.sessionCap.native_cap);
  for(const j of [b,c])assert.deepEqual(j.capacityAllocation.capacity,a.capacityAllocation.capacity);
  linked(a,b);linked(b,c);validate([a,b,c]);
  // Exercise actual configuration reads, not an identity-only projection.
  finish(c);sessionCapSetting(f,2);
  const d=launch(add('Changed pool limit'),'configured-d');
  assert.notDeepEqual(d.capacityAllocation.capacity,c.capacityAllocation.capacity);
  finish(d);
  const file=path.join(f.repo,'.lane.json'),config=JSON.parse(fs.readFileSync(file));
  config.dispatch.max_total_sessions=d.sessionCap.native_cap;fs.writeFileSync(file,JSON.stringify(config));
  const e=launch(add('Explicit shared ceiling'),'configured-e');
  assert.equal(e.sessionCap.native_cap,d.sessionCap.native_cap,'even the same numeric ceiling changes its configured source');
  assert.notDeepEqual(e.capacityAllocation.capacity,d.capacityAllocation.capacity);
  t.diagnostic(JSON.stringify({rehearsal:'decision occupancy and configured limits',allocations:[a,b,c,d,e].map(j=>j.capacityAllocation)}));
});

test('an abandoned holder re-roots its slot without inventing a report release, then B to C links normally',t=>{
  const {f,add,launch,finish,validate,linked}=turnoverFixture(t);
  const a=launch(f.item,'abandoned-a');
  f.rec(['abandon',a.run,'--note','Fixture holder ended without a report']);
  const b=launch(add('New chain after abandonment'),'abandoned-b'),r=b.capacityAllocation;
  assert.equal(r.slot,a.capacityAllocation.slot);
  assert.equal(r.predecessor,null);assert.equal(r.freeAt,null);assert.equal(r.freedBy,null);
  assert.equal(r.reset_after.id,a.capacityAllocation.id);
  assert.equal(r.reset_after.source.seq,events(f).find(e=>e.type==='run.abandoned'&&e.id===a.run).seq);
  finish(b);const c=launch(add('Reuse new chain'),'abandoned-c');linked(b,c);
  const context=validate([b,c]);
  assert.deepEqual(JSON.parse(fs.readFileSync(a.journal)).capacityAllocation,a.capacityAllocation);
  assert.equal(a.capacityAllocation.freeAt,null);
  assert.equal(events(f).some(e=>e.type==='report.ingested'&&e.run===a.run),false);
  const missing=context.events.filter(e=>e.seq!==r.reset_after.source.seq);
  assert.throws(()=>validateCapacityAllocation(r,{...context,events:missing}),/abandonment/);
  const changed=structuredClone(context.journals);changed.find(j=>j.run===a.run).ownership.generation++;
  assert.throws(()=>validateCapacityAllocation(r,{...context,journals:changed}),/generation/);
  const fork=structuredClone(context.journals);fork.push({capacityAllocation:{id:'fork',reset_after:r.reset_after}});
  assert.throws(()=>validateCapacityAllocation(r,{...context,journals:fork}),/another allocation/);
  t.diagnostic(JSON.stringify({rehearsal:'abandoned A, new root B, report-released C',allocations:[a,b,c].map(j=>j.capacityAllocation)}));
});

function selectionHistory(){
  const events=[],journals=[],evidence={kind:'build',cap:1,build_cap:1,review_cap:3,decision_cap:1,shared_cap:null};
  const at='2026-11-02T00:00:00.000Z';
  const append=event=>{const e={seq:events.length+1,at,...event};events.push(e);return e;};
  const start=()=>{
    const n=journals.length+1,journal=`/fixture/${n}.json`,job={run:`R-${n}`,token:`attempt-${n}`,common:'/fixture/.git',org:'/fixture/org',workspace:`/fixture/lane-${n}`,journal};
    append({type:'run.started',id:job.run,workspace:job.workspace,meta:{dispatch_project:job.common,dispatch_record:job.org,dispatch_attempt:job.token,dispatch_journal:journal}});
    const claim=append({type:'run.claimed',run:job.run,project:job.common,record:job.org});
    job.ownership={generation:claim.seq};journals.push(job);return job;
  };
  const select=(job,inputs={})=>job.capacityAllocation=selectCapacityAllocation({job,journal:job.journal,events,journals,evidence,now:()=>at,...inputs});
  const finish=job=>append({type:'report.ingested',run:job.run,sha256:`digest-${job.run}`});
  return{events,journals,start,select,finish};
}

test('a report between run start and final admission is eligible only within the saved admission fence',()=>{
  const h=selectionHistory(),a=h.start();h.select(a);
  const b=h.start(),report=h.finish(a);h.select(b);
  assert.ok(report.seq>b.capacityAllocation.allocation.started_seq);
  assert.equal(b.capacityAllocation.admission_seq,report.seq);
  assert.equal(b.capacityAllocation.freedBy.seq,report.seq);
  const context={events:h.events,journals:h.journals,capacity:b.capacityAllocation.capacity};
  assert.equal(validateCapacityAllocation(b.capacityAllocation,context),b.capacityAllocation);
  let bad=resign({...b.capacityAllocation,admission_seq:b.ownership.generation});
  const changed=structuredClone(h.journals);changed[1].capacityAllocation=bad;
  assert.throws(()=>validateCapacityAllocation(bad,{...context,journals:changed}),/release/);
  const {admission_seq,...legacy}=a.capacityAllocation;
  const legacyReceipt=resign(legacy),legacyJobs=[{...a,capacityAllocation:legacyReceipt}];
  assert.equal(validateCapacityAllocation(legacyReceipt,{...context,journals:legacyJobs}),legacyReceipt,'old root remains verifiable');
});

test('admission validates only the head link while capture still rejects a broken older ancestor',()=>{
  const h=selectionHistory();let prior;
  for(let i=0;i<40;i++){
    const job=h.start();if(prior)h.finish(prior);h.select(job);prior=job;
  }
  h.finish(prior);const next=h.start();let reads=0;
  const counted=new Proxy(h.events,{get(target,key){
    if(key==='find'||key==='findLast')return(...args)=>{reads++;return target[key](...args);};
    return Reflect.get(target,key);
  }});
  const receipt=h.select(next,{events:counted});
  assert.ok(reads<=12,`head-only event lookups: ${reads}`);
  const context={events:h.events,journals:h.journals,capacity:receipt.capacity};
  assert.equal(validateCapacityAllocation(receipt,context),receipt);
  const changed=structuredClone(h.journals);changed[0].ownership.generation++;
  assert.throws(()=>validateCapacityAllocation(receipt,{...context,journals:changed}),/generation/);
});
