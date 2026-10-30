import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {gitProject} from '../lib/project.mjs';
import {lineDirectory} from '../line-service/cutoff.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {recipientAgent} from './helpers/recipient-agent.mjs';

async function fixture(t){
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity,directory=lineDirectory(org,identity);
  const pin=release=>{fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),JSON.stringify({release})+'\n');f.git('add','.herdr-release.json');f.git('commit','-qm','Accept '+release);};
  pin('compatible');
  const agent=f.observation.agents[0],env={...f.env,HERDR_ENV:'1',HERDR_PANE_ID:agent.pane_id,HERDR_WORKSPACE_ID:agent.workspace_id,CODEX_THREAD_ID:agent.agent_session.value};
  const recipients=new Map([[agent.name,agent]]),calls=[];
  let loaded=false,bootstrapError;
  const call=(_exe,args)=>JSON.stringify({result:{agent:args[2]===agent.pane_id?agent:recipients.get(args[2])}});
  const command=(exe,args,options)=>{
    calls.push({exe,args});
    if(exe==='/usr/bin/plutil')return spawnSync(exe,args,options);
    assert.equal(exe,'/bin/launchctl');
    if(args[0]==='print')return loaded?{status:0,stdout:'fixture job'}:{status:113,stderr:'Could not find service in domain'};
    if(args[0]==='bootstrap'){if(bootstrapError)return{status:1,stderr:bootstrapError};loaded=true;return{status:0,stdout:''};}
    if(args[0]==='bootout'){loaded=false;return{status:0,stdout:''};}
    throw Error('unexpected effect '+args.join(' '));
  };
  const module=(relative,root=f.bundle)=>import(pathToFileURL(path.join(root,relative)).href);
  const {main}=await module('line-service/launchd.mjs'),{installRelease}=await module('line-service/install.mjs');
  const options={repo:f.cwd,org,id:'fresh-line',herdr:'/fixture/bin/herdr',socket:'/fixture/native.sock',cwd:f.cwd,env,call,command,home:f.installationHome};
  const argv=['install','--repo',f.cwd,'--org',org,'--id',options.id,'--herdr',options.herdr,'--socket',options.socket];
  const plan=()=>main([...argv,'--dry-run'],options),apply=sha=>main([...argv,'--expected-plan',sha],options);
  const saved=path.join(org,'dispatch');fs.mkdirSync(saved,{recursive:true});
  const jobs=path.join(saved,'retained.json');fs.writeFileSync(jobs,'{"state":"UNKNOWN","watcher":"original","source":"retained"}\n');
  const before={record:fs.readFileSync(path.join(org,'events.jsonl'),'utf8'),pin:fs.readFileSync(path.join(f.cwd,'.herdr-release.json'),'utf8'),jobs:fs.readFileSync(jobs,'utf8')};
  return {...f,org,identity,directory,pin,agent,recipients,calls,module,main,installRelease,options,argv,plan,apply,before,jobs,
    file:path.join(directory,'service.plist'),receipt:path.join(directory,'installation.json'),stop:path.join(directory,'STOP'),
    setLoaded:v=>loaded=v,setBootstrapError:v=>bootstrapError=v};
}
const boots=f=>f.calls.filter(c=>c.args[0]==='bootstrap');
function untouched(f){
  assert.equal(fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8'),f.before.record);
  assert.equal(fs.readFileSync(path.join(f.cwd,'.herdr-release.json'),'utf8'),f.before.pin);
  assert.equal(fs.readFileSync(f.jobs,'utf8'),f.before.jobs);
}

test('fresh accepted release previews without effects, records actual cutoff and installs exactly once',async t=>{
  const f=await fixture(t),head=f.git('rev-parse','HEAD'),preview=f.plan();
  assert.equal(preview.dry_run,true);assert.equal(preview.runtime_started,false);
  assert.equal(preview.plan.cutover.canonical_head,head);assert.equal(preview.plan.installation.source,f.bundle);
  assert.equal(preview.plan.installation.recipient,f.agent.name);assert.match(preview.plan.plist,/\/fixture\/native.sock/);
  assert.equal(fs.existsSync(f.directory),false);assert.equal(boots(f).length,0);untouched(f);
  assert.throws(()=>f.main(f.argv,f.options),/expected-plan/);assert.equal(fs.existsSync(f.directory),false);
  const result=f.apply(preview.expected_plan);assert.equal(result.installed,true);assert.equal(boots(f).length,1);
  const events=loadEvents(f.org).events,cutovers=events.filter(e=>e.type==='line-service.cutover');
  assert.equal(cutovers.length,1);assert.equal(cutovers[0].canonical_head,head);assert.equal(cutovers[0].source,f.bundle);
  assert.equal(events.some(e=>e.type==='line-service.runtime-migrated'),false);
  assert.equal(fs.statSync(result.archive.file).mode&0o777,0o444);
  const {installedContext,postCutoffLanding}=await f.module('line-service/cutoff.mjs');
  assert.equal(installedContext(f.cwd,f.org).installation.phase,'installed');
  // The fresh installer intentionally has no wall-clock timestamp. Its actual
  // installed receipt must still support the non-session record producer.
  assert.equal(result.installation.at,undefined);
  const {serviceRecordBinding}=await f.module('line-service/record-inbox.mjs');
  const release=noticeLock(path.join(f.directory,'pass.lock'));
  try{assert.match(serviceRecordBinding({repo:f.cwd,org:f.org,env:{...f.env,HERDR_ENV:'',HERDR_PANE_ID:''}}).epoch,/^[a-f0-9]{64}$/);}
  finally{release();}
  assert.throws(()=>postCutoffLanding({events,repo:f.cwd,org:f.org,identity:f.identity,head}),/at\/before/);
  fs.writeFileSync(path.join(f.cwd,'later'),'actual later landing');f.git('add','later');f.git('commit','-qm','Land later source');
  assert.equal(postCutoffLanding({events,repo:f.cwd,org:f.org,identity:f.identity,head:f.git('rev-parse','HEAD')}).head,head);
  for(const id of ['fresh-line','replacement'])assert.throws(()=>f.installRelease({...f.options,id,expectedPlan:preview.expected_plan}),/existing\/UNKNOWN/);
  assert.equal(boots(f).length,1);assert.equal(fs.readFileSync(f.jobs,'utf8'),f.before.jobs);
  const saved=fs.readFileSync(f.receipt,'utf8'),archive=fs.readFileSync(result.archive.file,'utf8');
  fs.chmodSync(result.archive.file,0o644);fs.appendFileSync(result.archive.file,' ');assert.throws(()=>installedContext(f.cwd,f.org),/intent changed/);fs.writeFileSync(result.archive.file,archive);fs.chmodSync(result.archive.file,0o444);
  fs.writeFileSync(f.receipt,JSON.stringify({...JSON.parse(saved),phase:'starting'}));assert.throws(()=>installedContext(f.cwd,f.org),/drifted/);fs.writeFileSync(f.receipt,saved);
});

test('fresh install refuses held, dirty, foreign, loaded and unknown native state without effects',async t=>{
  const f=await fixture(t);
  fs.mkdirSync(path.join(f.cwd,'.lane/supervisor'),{recursive:true});
  for(const name of ['STOP','HOLD']){const file=path.join(f.cwd,'.lane/supervisor',name);fs.writeFileSync(file,'retain');assert.throws(()=>f.plan(),/STOP\/HOLD/);fs.unlinkSync(file);}
  fs.writeFileSync(path.join(f.cwd,'dirty'),'retain');assert.throws(()=>f.plan(),/clean canonical/);fs.unlinkSync(path.join(f.cwd,'dirty'));
  assert.throws(()=>f.installRelease({...f.options,dryRun:true,env:{...f.options.env,CODEX_THREAD_ID:'foreign'}}),/native caller/);
  f.setLoaded(true);assert.throws(()=>f.plan(),/already loaded/);f.setLoaded(false);
  assert.throws(()=>f.installRelease({...f.options,dryRun:true,command:()=>({status:1,stderr:'Permission denied'})}),/Permission denied/);
  assert.equal(fs.existsSync(f.directory),false);assert.equal(boots(f).length,0);untouched(f);
  fs.mkdirSync(f.directory,{recursive:true});fs.writeFileSync(path.join(f.directory,'effects.json'),'{"attempt":"UNKNOWN"}');
  assert.throws(()=>f.plan(),/existing\/UNKNOWN/);assert.equal(fs.readFileSync(path.join(f.directory,'effects.json'),'utf8'),'{"attempt":"UNKNOWN"}');untouched(f);
});

test('preview rejects unaccepted releases, payload drift, redirected paths and existing cutover records',async t=>{
  const f=await fixture(t),manifest=path.join(f.bundle,'.release-manifest.json'),bytes=fs.readFileSync(manifest),record=JSON.parse(bytes);
  record.acceptance.ready=false;fs.writeFileSync(manifest,JSON.stringify(record));assert.throws(()=>f.plan(),/acceptance/);fs.writeFileSync(manifest,bytes);
  const payload=path.join(f.bundle,'line-service/install.mjs'),original=fs.readFileSync(payload);fs.appendFileSync(payload,'\n// drift');assert.throws(()=>f.plan(),/incomplete release/);fs.writeFileSync(payload,original);
  fs.mkdirSync(path.dirname(f.directory),{recursive:true});fs.symlinkSync(f.cwd,f.directory);assert.throws(()=>f.plan(),/ELOOP|ENOTDIR|redirected/);fs.unlinkSync(f.directory);
  untouched(f);assert.equal(boots(f).length,0);
  transact(f.org,()=>({add:[{type:'line-service.cutover',project:f.identity,repo:f.cwd,org:f.org,id:'retained'}]}));
  assert.throws(()=>f.plan(),/existing\/UNKNOWN service record/);assert.equal(fs.existsSync(f.directory),false);
});

test('apply binds the preview to record, canonical head, recipient, pin and transport',async t=>{
  const f=await fixture(t),preview=f.plan();
  assert.throws(()=>f.installRelease({...f.options,socket:'/changed.sock',expectedPlan:preview.expected_plan}),/plan changed/);
  f.agent.terminal_id='new-terminal';assert.throws(()=>f.apply(preview.expected_plan),/plan changed/);f.agent.terminal_id='terminal';
  assert.equal(fs.existsSync(f.directory),false);untouched(f);
  transact(f.org,()=>({add:[{type:'note',target:'fixture',text:'new record context'}]}));
  assert.throws(()=>f.apply(preview.expected_plan),/plan changed/);assert.equal(fs.existsSync(f.directory),false);
  const next=f.plan();fs.writeFileSync(path.join(f.cwd,'later'),'source');f.git('add','later');f.git('commit','-qm','Move canonical head');
  assert.throws(()=>f.apply(next.expected_plan),/plan changed/);
  f.pin(null);assert.throws(()=>f.plan(),/explicit accepted project pin/);assert.equal(boots(f).length,0);
});

test('apply respects live locks and rechecks controls and configuration before bootstrap',async t=>{
  const f=await fixture(t),preview=f.plan(),promotion=noticeLock(path.join(f.identity,'lane-promote.lock'),{recover:false});
  try{assert.throws(()=>f.apply(preview.expected_plan),/lock/);}finally{promotion();}
  assert.equal(fs.readdirSync(f.directory).length,0);untouched(f);
  for(const name of ['control.lock','pass.lock']){
    const release=noticeLock(path.join(f.directory,name),{recover:false});
    try{assert.throws(()=>f.plan(),/existing\/UNKNOWN/);}finally{release();}
  }
  let prints=0;
  const command=(exe,args,options)=>{const result=f.options.command(exe,args,options);if(args[0]==='print'&&++prints===3)fs.appendFileSync(f.file,'\nretained drift');return result;};
  assert.throws(()=>f.installRelease({...f.options,expectedPlan:preview.expected_plan,command}),/CAS changed before bootstrap/);
  assert.match(fs.readFileSync(f.file,'utf8'),/retained drift/);assert.equal(boots(f).length,0);assert.ok(fs.existsSync(f.stop));
  assert.throws(()=>f.plan(),/existing\/UNKNOWN/);
});

test('partial installs retain the original intent and never replay under either id or restart',async t=>{
  for(const phase of ['intent','plist','installation']){
    const f=await fixture(t),preview=f.plan();
    assert.throws(()=>f.installRelease({...f.options,expectedPlan:preview.expected_plan,fault:point=>{if(point===phase)throw Error('interrupted at '+phase);}}),/interrupted/);
    const retained=fs.readFileSync(preview.archive.file,'utf8');
    for(const id of ['fresh-line','new-id'])assert.throws(()=>f.installRelease({...f.options,id,expectedPlan:preview.expected_plan}),/existing\/UNKNOWN/);
    assert.throws(()=>f.main(['restart','--repo',f.cwd,'--org',f.org],f.options),/cutover|binding|drifted/);
    assert.equal(fs.readFileSync(preview.archive.file,'utf8'),retained);assert.equal(boots(f).length,0);
  }
});

test('a refused native bootstrap is preserved with STOP and never retried',async t=>{
  const f=await fixture(t),preview=f.plan();f.setBootstrapError('native refused');
  assert.throws(()=>f.apply(preview.expected_plan),/native refused/);assert.equal(boots(f).length,1);
  const receipt=fs.readFileSync(f.receipt,'utf8'),events=fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8');
  assert.equal(JSON.parse(receipt).phase,'uncertain-or-refused');assert.ok(fs.existsSync(f.stop));
  for(const id of ['fresh-line','new-id'])assert.throws(()=>f.installRelease({...f.options,id,expectedPlan:preview.expected_plan}),/existing\/UNKNOWN/);
  assert.throws(()=>f.main(['restart','--repo',f.cwd,'--org',f.org],f.options),/drifted/);
  assert.equal(boots(f).length,1);assert.equal(fs.readFileSync(f.receipt,'utf8'),receipt);assert.equal(fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8'),events);
});

test('fresh release history supports stopped retarget, restart, upgrade and rollback without a migration',async t=>{
  const f=await fixture(t);f.apply(f.plan().expected_plan);
  const controls=['--repo',f.cwd,'--org',f.org];f.main(['stop',...controls],f.options);
  const nextOwner=recipientAgent('next-supervisor',f.cwd);f.recipients.set(nextOwner.name,nextOwner);
  const retarget=['retarget',...controls,'--to',nextOwner.name];
  assert.equal(f.main([...retarget,'--dry-run'],f.options).dry_run,true);f.main(retarget,f.options);
  assert.equal(f.main(['restart',...controls],f.options).restarted,true);assert.equal(boots(f).length,2);
  f.main(['stop',...controls],f.options);
  const next=f.release('successor',{commit:'2'.repeat(40)});f.pin('successor');
  const {main}=await f.module('line-service/launchd.mjs',next);
  const args=['upgrade',...controls,'--id','fresh-upgrade','--from-root',f.bundle,'--target-root',next];
  const preview=main([...args,'--dry-run'],f.options);assert.equal(main([...args,'--expected-plan',preview.archive.sha256],f.options).upgraded,true);
  const {installedContext}=await f.module('line-service/cutoff.mjs',next);assert.equal(installedContext(f.cwd,f.org).installation.source,next);
  f.pin('compatible');const rollback=['upgrade',...controls,'--id','fresh-rollback','--from-root',next,'--target-root',f.bundle,'--rollback'];
  const back=main([...rollback,'--dry-run'],f.options);assert.equal(main([...rollback,'--expected-plan',back.archive.sha256],f.options).upgraded,true);
  const {installedContext:original}=await f.module('line-service/cutoff.mjs');assert.equal(original(f.cwd,f.org).installation.source,f.bundle);
  assert.equal(loadEvents(f.org).events.some(e=>e.type==='line-service.runtime-migrated'),false);
  assert.equal(fs.readFileSync(f.jobs,'utf8'),f.before.jobs);
});
