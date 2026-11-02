import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fixture} from './helpers/line-service-probation-fixture.mjs';
import {fixture as dispatchFixture} from '../dispatch/test/dispatch-fixture.mjs';
import {commandIntent,assertCommandQuiescence} from '../lib/command-receipt.mjs';

const absent=2147483647;
function deadOwner(t,f,{code='ESRCH',pid=absent,identified=true}={}){
  const kill=process.kill;
  t.mock.method(process,'kill',(target,signal)=>{
    if(target===absent)throw Object.assign(Error('private fixture probe'),{code});
    return kill(target,signal);
  });
  const directory=path.join(f.directory,'pass.lock'),owner={pid,...(identified?{at:'2026-11-02T17:00:00Z',argv:['node','line-service.mjs','--once']}:{})};
  fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'owner.json'),JSON.stringify(owner));
  return{directory,bytes:fs.readFileSync(path.join(directory,'owner.json'))};
}
function orphan(f,subject){
  const ref=commandIntent(f.directory,{exe:process.execPath,args:['original-command'],cwd:f.cwd,
    project:f.identity,org:f.org,consumer:'line-service',subject,key:`original:${subject}`,stuck_owner:'fixture-supervisor'});
  const value=JSON.parse(fs.readFileSync(ref.file));value.caller=absent;
  fs.writeFileSync(ref.file,JSON.stringify(value)+'\n');ref.sha256=createHash('sha256').update(fs.readFileSync(ref.file)).digest('hex');
  return ref;
}
const restart=f=>f.main(['restart','--repo',f.cwd,'--org',f.org],f.args);

test('same-root installed restart recovers a crashed pass and retains its UNKNOWN subject while independent work proceeds',async t=>{
  const f=await fixture(t);f.authorize();f.enter();
  const d=dispatchFixture(t,{project:f}),other=d.rec(['add','Independent work','--role','engineer']);
  const ref=orphan(f,d.item),intent=fs.readFileSync(ref.file),stale=deadOwner(t,f);
  const before={installation:fs.readFileSync(f.installationFile),plist:fs.readFileSync(f.file),jobs:fs.readFileSync(f.retained)};
  assert.equal(restart(f).restarted,true);assert.equal(fs.existsSync(stale.directory),false);
  const controls=fs.readFileSync(path.join(f.directory,'controls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(controls.filter(r=>r.phase==='pass-lock-recovery').map(r=>r.recovery.phase),['intent','recovered']);
  assert.equal(controls.find(r=>r.phase==='restart-command-holds').holds[0].status,'UNKNOWN');
  assert.deepEqual(fs.readFileSync(ref.file),intent);assert.equal(fs.existsSync(ref.receipt),false);
  assert.throws(()=>assertCommandQuiescence(f.directory),/active or UNKNOWN/,'restart never proves maintenance quiescence');
  const {createLineService}=await f.module(f.next,'line-service/line-service.mjs'),starts=[];
  const service=createLineService({repo:f.cwd,org:f.org,to:f.agent.name,runtimeHome:f.installationHome,env:d.env,maxStarts:2,haltAfter:100,
    capacity:()=>({count:0,cap:4}),recordNotice:()=>({state:'record-only'}),command:(_exe,args)=>{
      if(args[0].endsWith('/dispatch/dispatch.mjs'))starts.push(args[1]);
      return{status:0,stdout:'{"created":[]}'};
    }});
  assert.equal(service.pass().result,'pass-complete');assert.ok(starts.includes(other));assert.ok(!starts.includes(d.item));
  assert.deepEqual(fs.readFileSync(ref.file),intent);assert.equal(fs.existsSync(ref.receipt),false);
  for(const [key,file]of Object.entries({installation:f.installationFile,plist:f.file,jobs:f.retained}))assert.deepEqual(fs.readFileSync(file),before[key]);
});

for(const mode of ['live','EPERM','unidentified','HOLD','audit-failure'])test(`installed restart preserves a ${mode} pass owner without bootstrap`,async t=>{
  const f=await fixture(t);f.authorize();f.enter();
  const stale=deadOwner(t,f,{pid:mode==='live'?process.pid:absent,code:mode==='EPERM'?'EPERM':'ESRCH',identified:mode!=='unidentified'});
  if(mode==='HOLD'){
    const held=path.join(f.cwd,'.lane/supervisor/HOLD');fs.mkdirSync(path.dirname(held),{recursive:true});fs.writeFileSync(held,'held');
  }
  if(mode==='audit-failure')fs.mkdirSync(path.join(f.directory,'controls.jsonl'));
  assert.throws(()=>restart(f),/locked:|owner identity|STOP\/HOLD|EISDIR/);
  assert.deepEqual(fs.readFileSync(path.join(stale.directory,'owner.json')),stale.bytes);
  assert.ok(fs.existsSync(f.stop));assert.equal(f.calls.filter(c=>c.args[0]==='bootstrap').length,0);
});

for(const mode of ['live-caller','foreign','bad-receipt'])test(`installed restart refuses ${mode} command evidence and keeps the original marker`,async t=>{
  const f=await fixture(t);f.authorize();f.enter();deadOwner(t,f);
  const ref=orphan(f,'ENG-1'),value=JSON.parse(fs.readFileSync(ref.file));
  if(mode==='live-caller')value.caller=process.pid;
  if(mode==='foreign')value.project+='-foreign';
  fs.writeFileSync(ref.file,JSON.stringify(value)+'\n');
  if(mode==='bad-receipt')fs.writeFileSync(ref.receipt,'{"schema":"untrusted"}');
  const bytes=fs.readFileSync(ref.file);
  assert.throws(()=>restart(f),/positively dead|binding changed/);
  assert.deepEqual(fs.readFileSync(ref.file),bytes);assert.ok(fs.existsSync(f.stop));assert.equal(f.calls.filter(c=>c.args[0]==='bootstrap').length,0);
});
