import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {fixture,state} from './helpers/line-service-probation-fixture.mjs';
import {recoveryContract} from '../lib/record-compatibility.mjs';
import {requireRecoveryEntry,recoveryEntryDecision,observeRecoveryAdmission} from '../line-service/recovery-admission.mjs';
import {loadEvents,transact} from '../lib/store.mjs';

const product=path.resolve(import.meta.dirname,'..');
const future=source=>source.replace("    case 'item.added':", "    case 'item.future-contract':\n    case 'item.added':");

test('recovery contract catches absent future events and new requirement selectors before any candidate write',t=>{
  const f=configFixture(t,{custom:true}),candidate=f.bundle,recovery=product;
  assert.deepEqual(recoveryContract(candidate,recovery).excess,[]);
  const file=path.join(candidate,'lib/state.mjs'),original=fs.readFileSync(file,'utf8');
  fs.writeFileSync(file,future(original));assert.notEqual(future(original),original);
  assert.deepEqual(recoveryContract(candidate,recovery).excess,['event:item.future-contract']);
  assert.throws(()=>requireRecoveryEntry({candidate,recovery,events:[],owner:'supervisor'}),/recovery-contract-exceeded.*item.future-contract/);
  fs.writeFileSync(file,original);
  const selectors=path.join(candidate,'lib/obligation-capabilities.mjs'),source=fs.readFileSync(selectors,'utf8');
  fs.writeFileSync(selectors,source.replace('const required = [];',"const required = ['future/v2'];"));
  assert.match(recoveryContract(candidate,recovery).excess.join(','),/unknown-requirement-selectors:/);
  fs.writeFileSync(selectors,source);
  assert.deepEqual(recoveryContract(candidate,recovery).excess,[]);
  fs.appendFileSync(path.join(candidate,'lib/obligations.mjs'),'\n// Unknown helper contract\n');
  assert.match(recoveryContract(candidate,recovery).excess.join(','),/unknown-obligation-fold:/);
});

test('reviewed frozen legacy recovery keeps its capability floor without receiving future grants',t=>{
  const f=configFixture(t,{custom:true});
  const old=spawnSync('git',['show','6dc33698bb52b0e398164c15e8030f7e71b76f72:lib/obligations.mjs'],{cwd:product,encoding:'utf8'});
  assert.equal(old.status,0,old.stderr);
  fs.writeFileSync(path.join(f.bundle,'lib/obligations.mjs'),old.stdout);
  fs.unlinkSync(path.join(f.bundle,'lib/obligation-capabilities.mjs'));
  assert.deepEqual(recoveryContract(product,f.bundle).excess,[]);
  const stateFile=path.join(f.bundle,'lib/state.mjs');
  // A target with no delegate cannot accept a candidate that needs it.
  fs.writeFileSync(stateFile,fs.readFileSync(stateFile,'utf8').replace('  applyObligationEvent(s, e);',''));
  assert.ok(recoveryContract(product,f.bundle).excess.includes('capability:report.available/v1'));
});

test('only the exact separate native supervisor decision acknowledges excess and owning holds remain authoritative',t=>{
  const f=configFixture(t,{custom:true}),candidate=f.bundle,recovery=product;
  const file=path.join(candidate,'lib/state.mjs');fs.writeFileSync(file,future(fs.readFileSync(file,'utf8')));
  const contract=recoveryEntryDecision(candidate,recovery),note={type:'note.added',id:'G-1',seq:42,decision:true,by:'supervisor',text:contract.required_decision};
  let validated=0;
  const args={candidate,recovery,events:[note],authority:42,owner:'supervisor',validateOwner:n=>{assert.equal(n,note);validated++;}};
  assert.equal(requireRecoveryEntry(args).authority,42);assert.equal(validated,1);
  for(const changed of [{decision:false},{by:'worker'},{text:'ordinary entry authority'},{seq:43}])
    assert.throws(()=>requireRecoveryEntry({...args,events:[{...note,...changed}]}),/separate explicit decision/);
  assert.throws(()=>requireRecoveryEntry({...args,validateOwner:()=>{throw Error('owning HOLD');}}),/owning HOLD/);
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('item.future-contract','item.other-contract'));
  assert.throws(()=>requireRecoveryEntry(args),/separate explicit decision/);
});

test('recovery admission alarms on refusal and clears on recovery without record writes or foreign/ended trial alarms',t=>{
  const f=configFixture(t,{custom:true}),identity='/private/fixture/.git',org='/private/fixture/org',rows=[];
  const trial={type:'line-service.probation-authorized',id:'trial',project:identity,org,scope:{previous:{release:{root:f.bundle}}}};
  const events=[trial,{type:'item.future-contract',seq:19}],before=JSON.stringify(events);
  assert.equal(observeRecoveryAdmission({events,identity,org,log:row=>rows.push(row)})[0].admissible,false);
  assert.match(rows[0].reason,/item.future-contract.*first sequence 19/);
  assert.equal(rows[0].owner,'project-supervisor');assert.equal(JSON.stringify(events),before);
  const clear=observeRecoveryAdmission({events:[trial],identity,org,log:row=>rows.push(row)});
  assert.equal(clear[0].admissible,true);
  assert.equal(observeRecoveryAdmission({events,identity:'foreign',org,log:()=>{throw Error('foreign');}}).length,0);
  assert.equal(observeRecoveryAdmission({events:[...events,{type:'line-service.probation-completed',id:'trial',project:identity,org}],identity,org,log:()=>{throw Error('ended');}}).length,0);
  assert.equal(observeRecoveryAdmission({events:[trial],identity,org,tornTail:true,log:()=>{}})[0].admissible,false);
});

test('installed fixture pass leaves recovery alarm before its runtime or STOP refusal and preserves saved installation',async t=>{
  const f=await fixture(t,{development:true});f.authorize();
  const before=state(f),eventsFile=path.join(f.org,'events.jsonl');
  const {createLineService,main}=await f.module(f.next,'line-service/line-service.mjs');
  const service=createLineService({repo:f.cwd,org:f.org,to:f.agent.name,env:f.env,runtimeHome:f.installationHome,
    command:()=>{throw Error('no commands authorized');},capacity:()=>({count:0,cap:2})});
  transact(f.org,()=>({add:[{type:'item.future-contract',id:'ENG-1'}]}));
  await assert.rejects(main(['--once','--general-pass','--repo',f.cwd,'--org',f.org,'--to',f.agent.name],{home:f.installationHome}),/record-incompatible/);
  const rows=()=>fs.readFileSync(path.join(f.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.match(rows().find(row=>row.action==='recovery-admission-supervisor-alarm').reason,/item.future-contract/);
  assert.equal(fs.readFileSync(f.installationFile,'utf8'),before.installation);
  assert.equal(fs.readFileSync(f.file,'utf8'),before.plist);assert.equal(fs.readFileSync(f.retained,'utf8'),before.jobs);
  // Restore only the synthetic record copy, never a live record or root.
  fs.writeFileSync(eventsFile,before.events);
  assert.throws(()=>service.pass(),/STOP\/HOLD/);
  assert.equal(rows().filter(row=>row.action==='recovery-admission').at(-1).admissible,true);
  assert.equal(loadEvents(f.org).events.length,JSON.parse('['+before.events.trim().split('\n').join(',')+']').length);
});

test('probation authorization and switch refuse excess before intents and require separate exact decision through the CLI',async t=>{
  const f=await fixture(t,{development:true});
  const file=path.join(f.cwd,'lib/state.mjs'),source=fs.readFileSync(file,'utf8');
  const reduced=source.replace("    case 'item.acceptance-amended':",'');assert.notEqual(reduced,source);
  fs.writeFileSync(file,reduced);f.git('add','lib/state.mjs');f.git('commit','-qm','Reduce private recovery contract');
  const before=state(f);
  assert.throws(()=>f.control({dryRun:true}),/recovery-contract-exceeded.*item.acceptance-amended/);
  assert.deepEqual(state(f),before);
  const decide=text=>transact(f.org,()=>({add:[{type:'note.added',id:'G-1',decision:true,text}]}),{actor:f.agent.name}).added[0].seq;
  const recoveryAuthority=decide(recoveryEntryDecision(f.next,f.cwd).required_decision);
  const p=f.control({dryRun:true,recoveryAuthority});
  f.control({recoveryAuthority,authority:decide(p.required_decision),expectedPlan:p.plan_sha256});
  const recovery=p.scope.previous.release.root;
  const args=['probation-switch','--repo',f.cwd,'--org',f.org,'--trial','original-trial','--id','entry','--from-root',f.cwd,'--target-root',f.next];
  assert.throws(()=>f.main([...args,'--dry-run'],f.args),/recovery-contract-exceeded/);
  assert.equal(fs.existsSync(path.join(f.directory,'probation-switches')),false);
  const authority=decide(recoveryEntryDecision(f.next,recovery).required_decision);
  const explicit=[...args,'--recovery-authority',String(authority)];
  const plan=f.main([...explicit,'--dry-run'],f.args);
  const result=f.main([...explicit,'--expected-plan',plan.plan_sha256,'--authority',String(decide(plan.required_decision))],f.args);
  assert.equal(result.switched,true);assert.equal(result.runtime_started,false);
  const archive=JSON.parse(fs.readFileSync(path.join(f.directory,'probation-switches/entry.json')));
  assert.equal(archive.recovery_contract.authority,authority);
  assert.equal(f.calls.some(call=>call.args[0]==='bootstrap'),false);
});
