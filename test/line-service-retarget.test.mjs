import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {recipientAgent} from './helpers/recipient-agent.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {gitProject} from '../lib/project.mjs';
import {lineDirectory} from '../line-service/cutoff.mjs';
import {launchPlist} from '../line-service/plist.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {fixture as probationFixture,state as probationState} from './helpers/line-service-probation-fixture.mjs';

async function fixture(t){
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity,directory=lineDirectory(org,identity);
  const pin=id=>{fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),JSON.stringify({release:id})+'\n');f.git('add','.herdr-release.json');f.git('commit','-qm','Accept '+id);};
  pin('compatible');fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'service.plist'),stop=path.join(directory,'STOP'),installationFile=path.join(directory,'installation.json');
  const saved={at:'2026-10-29T19:00:00Z',target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`,repo:f.cwd,org,source:f.bundle,node:process.execPath,file,phase:'installed'};
  fs.writeFileSync(installationFile,JSON.stringify(saved)+'\n');
  fs.writeFileSync(file,launchPlist({label:`dev.herdr.line.${path.basename(directory)}`,repo:f.cwd,org,to:'brain-chat',herdr:'/saved/bin/herdr',socket:'/saved/native.sock',directory,
    node:process.execPath,source:f.bundle,interval:47,searchPath:'/saved/bin:/usr/bin:/bin'}));
  fs.writeFileSync(stop,'Keep this intentional stop\n');
  transact(org,()=>({add:[{type:'line-service.cutover',id:'original-cutover',project:identity,repo:f.cwd,org,source:f.bundle,main:'main',canonical_head:f.git('rev-parse','HEAD')}]}));
  fs.writeFileSync(path.join(directory,'effects.json'),'retained UNKNOWN effects\n');
  fs.mkdirSync(path.join(org,'dispatch'),{recursive:true});fs.writeFileSync(path.join(org,'dispatch','saved.json'),'original saved watcher/job\n');
  const agent=f.observation.agents[0],recipient=recipientAgent('next-supervisor',f.cwd),agents=new Map([[agent.pane_id,agent],[agent.name,agent],[recipient.name,recipient]]);
  const env={...f.env,HERDR_ENV:'1',HERDR_PANE_ID:agent.pane_id,HERDR_WORKSPACE_ID:agent.workspace_id,CODEX_THREAD_ID:agent.agent_session.value};
  const calls=[];let loaded=false;
  const call=(exe,args,options)=>{
    calls.push({exe,args,options});assert.deepEqual(args.slice(0,2),['agent','get']);
    if(args[2]===recipient.name)assert.equal(options.env.HERDR_SOCKET_PATH,'/saved/native.sock');
    return JSON.stringify({result:{agent:agents.get(args[2])}});
  };
  const command=(exe,args,options)=>{
    calls.push({exe,args});if(exe==='/usr/bin/plutil')return spawnSync(exe,args,options);
    assert.equal(exe,'/bin/launchctl');
    if(args[0]==='print')return loaded?{status:0,stdout:'saved job'}:{status:113,stderr:'Could not find service in domain'};
    if(args[0]==='bootstrap'){loaded=true;return{status:0,stdout:''};}
    throw Error('unexpected service effect');
  };
  const module=(relative,root=f.bundle)=>import(pathToFileURL(path.join(root,relative)).href);
  const {main}=await module('line-service/launchd.mjs');
  const options={cwd:f.cwd,env,call,command,home:f.installationHome};
  const argv=['retarget','--repo',f.cwd,'--org',org,'--to',recipient.name];
  const snapshot=()=>Object.fromEntries([installationFile,file,stop,path.join(org,'events.jsonl'),path.join(directory,'effects.json'),path.join(org,'dispatch','saved.json')].map(file=>[file,fs.readFileSync(file,'utf8')]));
  return {...f,org,identity,directory,file,stop,installationFile,saved,agent,recipient,agents,options,argv,main,module,pin,snapshot,calls,setLoaded:value=>loaded=value,
    retarget:extra=>main([...argv,...(extra??[])],options)};
}
const parsePlist=file=>JSON.parse(spawnSync('/usr/bin/plutil',['-convert','json','-o','-','--',file],{encoding:'utf8'}).stdout);

test('bootstrap retarget refuses preview apply and no-op without changes on the candidate recovery and return',async t=>{
  const f=await probationFixture(t,{development:true}),preview=f.control({dryRun:true});f.authorize();
  const recovery=preview.scope.previous.release.root;
  const switchTo=(main,id,from,to)=>{
    const args=['probation-switch','--repo',f.cwd,'--org',f.org,'--trial','original-trial','--id',id,'--from-root',from,'--target-root',to];
    const plan=main([...args,'--dry-run'],f.args);
    const authority=transact(f.org,()=>({add:[{type:'note.added',id:'G-1',decision:true,text:plan.required_decision}]}),{actor:f.agent.name}).added[0].seq;
    return main([...args,'--expected-plan',plan.plan_sha256,'--authority',String(authority)],f.args);
  };
  const refuse=async root=>{
    const {main}=await f.module(root,'line-service/launchd.mjs');
    const {installedContext}=await f.module(root,'line-service/cutoff.mjs');
    assert.equal(installedContext(f.cwd,f.org).installation.probation_bootstrap.trial,'original-trial');
    const before={...probationState(f),stop:fs.readFileSync(f.stop,'utf8')},listing=fs.readdirSync(f.directory).sort();
    f.calls.length=0;
    for(const to of ['next-supervisor',f.agent.name])for(const extra of [[],['--dry-run']]){
      assert.throws(()=>main(['retarget','--repo',f.cwd,'--org',f.org,'--to',to,...extra],f.args),/retarget refuses a bootstrap-bound installation until development history replays recipient changes/);
      assert.deepEqual({...probationState(f),stop:fs.readFileSync(f.stop,'utf8')},before);
      assert.deepEqual(fs.readdirSync(f.directory).sort(),listing);
    }
    assert.equal(f.calls.length,0,'refusal precedes service inspection and mutation');
    assert.equal(installedContext(f.cwd,f.org).installation.source,root,'unchanged history remains admissible');
    return main;
  };
  switchTo(f.main,'entry',f.cwd,f.next);await refuse(f.next);
  assert.equal(switchTo(f.main,'recovery',f.next,recovery).runtime.root,recovery);
  const recoveryMain=await refuse(recovery);
  assert.equal(switchTo(recoveryMain,'return',recovery,f.next).runtime.root,f.next);
  await refuse(f.next);
  assert.equal(loadEvents(f.org).events.filter(e=>e.type==='line-service.recipient-retargeted').length,0);
});

test('retarget dry-run is read-only; apply changes only recipient and appends an immutable receipt without starting a service',async t=>{
  const f=await fixture(t),before=f.snapshot(),listing=fs.readdirSync(f.directory).sort();
  const plan=f.retarget(['--dry-run']);assert.equal(plan.old_recipient,'brain-chat');assert.equal(plan.new_recipient,'next-supervisor');
  assert.deepEqual(f.snapshot(),before);assert.deepEqual(fs.readdirSync(f.directory).sort(),listing);
  const oldPlist=parsePlist(f.file),result=f.retarget(),saved=JSON.parse(fs.readFileSync(f.installationFile)),receipt=JSON.parse(fs.readFileSync(result.archive.file));
  assert.deepEqual(saved,{...f.saved,recipient:f.recipient.name});oldPlist.ProgramArguments[8]=f.recipient.name;assert.deepEqual(parsePlist(f.file),oldPlist);
  assert.equal(receipt.schema,'line-recipient-retarget/v1');assert.equal(receipt.old_recipient,'brain-chat');assert.equal(receipt.new_recipient,f.recipient.name);
  assert.equal(receipt.before.installation,before[f.installationFile]);assert.equal(receipt.before.plist,before[f.file]);
  assert.equal(fs.statSync(result.archive.file).mode&0o777,0o444);
  const events=loadEvents(f.org).events,changes=events.filter(e=>e.type==='line-service.recipient-retargeted');assert.equal(changes.length,1);
  assert.equal(changes[0].recipient.session,f.recipient.agent_session.value);assert.equal(changes[0].native_caller.name,f.agent.name);
  const after=f.snapshot();for(const file of [f.stop,path.join(f.directory,'effects.json'),path.join(f.org,'dispatch/saved.json')])assert.equal(after[file],before[file]);
  assert.equal(f.retarget().unchanged,true);assert.deepEqual(f.snapshot(),after);
  assert.equal(f.calls.some(c=>['bootstrap','bootout'].includes(c.args[0])),false);
  const {installedContext}=await f.module('line-service/cutoff.mjs');assert.equal(installedContext(f.cwd,f.org).installation.recipient,f.recipient.name);
});

test('retarget refuses loaded, unstopped, held, locked, dirty, unknown-phase and foreign native bindings',async t=>{
  const f=await fixture(t),before=f.snapshot();
  f.setLoaded(true);assert.throws(()=>f.retarget(),/remains loaded/);f.setLoaded(false);
  fs.unlinkSync(f.stop);assert.throws(()=>f.retarget(),/ENOENT|own STOP/);fs.writeFileSync(f.stop,before[f.stop]);
  fs.mkdirSync(path.join(f.cwd,'.lane/supervisor'),{recursive:true});
  for(const name of ['STOP','HOLD']){const file=path.join(f.cwd,'.lane/supervisor',name);fs.writeFileSync(file,'keep');assert.throws(()=>f.retarget(),/STOP\/HOLD/);fs.unlinkSync(file);}
  for(const file of [path.join(f.directory,'pass.lock'),path.join(f.directory,'control.lock'),path.join(f.identity,'lane-promote.lock')]){
    const release=noticeLock(file,{recover:false});try{assert.throws(()=>f.retarget(),/lock/);}finally{release();}
  }
  fs.writeFileSync(path.join(f.cwd,'dirty'),'keep');assert.throws(()=>f.retarget(),/clean canonical main/);fs.unlinkSync(path.join(f.cwd,'dirty'));
  for(const phase of ['starting','uncertain-or-refused','unexpected']){fs.writeFileSync(f.installationFile,JSON.stringify({...f.saved,phase}));assert.throws(()=>f.retarget(),/known installed phase/);}
  fs.writeFileSync(f.installationFile,before[f.installationFile]);
  assert.throws(()=>f.main(f.argv,{...f.options,env:{...f.options.env,CODEX_THREAD_ID:'foreign-session'}}),/native caller/);
  f.agents.delete(f.recipient.name);assert.throws(()=>f.retarget(),/recipient/);f.agents.set(f.recipient.name,f.recipient);
  for(const change of [{name:'wrong'},{agent_session:{}},{agent_status:'stopped'},{cwd:f.scratch}]){
    f.agents.set(f.recipient.name,{...f.recipient,...change});assert.throws(()=>f.retarget(),/recipient|Git|git/);
  }
  f.agents.set(f.recipient.name,f.recipient);assert.deepEqual(f.snapshot(),before);
  assert.equal(f.calls.some(c=>['bootstrap','bootout'].includes(c.args[0])),false);
});

test('retarget refuses a recipient or saved source CAS change before writing an intent',async t=>{
  const f=await fixture(t),before=f.snapshot();let gets=0;
  const call=(exe,args,options)=>{
    if(args[2]===f.recipient.name&&++gets===2)f.agents.set(f.recipient.name,{...f.recipient,agent_session:{value:'replacement-session'}});
    return f.options.call(exe,args,options);
  };
  assert.throws(()=>f.main(f.argv,{...f.options,call}),/CAS changed/);assert.deepEqual(f.snapshot(),before);
  f.agents.set(f.recipient.name,f.recipient);let prints=0;
  const command=(exe,args,options)=>{const result=f.options.command(exe,args,options);if(args[0]==='print'&&++prints===2)fs.appendFileSync(f.file,'\n');return result;};
  assert.throws(()=>f.main(f.argv,{...f.options,command}),/CAS changed/);assert.equal(fs.existsSync(path.join(f.directory,'retargets')),false);
});

for(const point of ['intent','plist','installation'])test(`interrupted retarget at ${point} retains STOP and fences restart and further changes`,async t=>{
  const f=await fixture(t),{retargetService}=await f.module('line-service/retarget.mjs');
  assert.throws(()=>retargetService({...f.options,repo:f.cwd,org:f.org,to:f.recipient.name,fault:phase=>{if(phase===point)throw Error('lost reply');}}),/lost reply/);
  assert.equal(loadEvents(f.org).events.filter(e=>e.type==='line-service.recipient-retargeted').length,0);
  assert.equal(fs.readFileSync(f.stop,'utf8'),'Keep this intentional stop\n');
  for(const args of [[],['--dry-run']])assert.throws(()=>f.retarget(args),/UNKNOWN recipient retarget/);
  assert.throws(()=>f.main(['restart','--repo',f.cwd,'--org',f.org],f.options),/UNKNOWN recipient retarget/);
  assert.equal(f.calls.some(c=>['bootstrap','bootout'].includes(c.args[0])),false);
});

test('recipient history survives migration, later retargets, upgrade and rollback; changed archives fence startup',async t=>{
  const f=await fixture(t);f.retarget();
  const next=f.release('next',{commit:'2'.repeat(40)});f.pin('next');
  const {main}=await f.module('line-service/launchd.mjs',next),migration=['migrate','--repo',f.cwd,'--org',f.org,'--id','next-migration'];
  const plan=main([...migration,'--dry-run'],f.options);main([...migration,'--expected-plan',plan.archive.sha256],f.options);
  const second=recipientAgent('second-supervisor',f.cwd);f.agents.set(second.name,second);
  const result=main(['retarget','--repo',f.cwd,'--org',f.org,'--to',second.name],f.options);
  const third=f.release('third',{commit:'3'.repeat(40)});f.pin('third');
  const {main:upgrade}=await f.module('line-service/launchd.mjs',third);
  const args=['upgrade','--repo',f.cwd,'--org',f.org,'--id','third-upgrade','--from-root',next,'--target-root',third];
  const upgradePlan=upgrade([...args,'--dry-run'],f.options);upgrade([...args,'--expected-plan',upgradePlan.archive.sha256],f.options);
  const {installedContext}=await f.module('line-service/cutoff.mjs',third);assert.equal(installedContext(f.cwd,f.org).installation.recipient,second.name);
  f.pin('next');const rollback=['upgrade','--repo',f.cwd,'--org',f.org,'--id','rollback','--from-root',third,'--target-root',next,'--rollback'];
  const rollbackPlan=upgrade([...rollback,'--dry-run'],f.options);upgrade([...rollback,'--expected-plan',rollbackPlan.archive.sha256],f.options);
  const {installedContext:current}=await f.module('line-service/cutoff.mjs',next);assert.equal(current(f.cwd,f.org).installation.recipient,second.name);
  fs.chmodSync(result.archive.file,0o644);fs.appendFileSync(result.archive.file,'\n');assert.throws(()=>current(f.cwd,f.org),/retarget archive changed/);
  assert.equal(f.calls.some(c=>['bootstrap','bootout'].includes(c.args[0])),false);
});

test('new installs default to their actual canonical supervisor and validate an explicit recipient',async t=>{
  // Start genuinely fresh: deleting an installation while retaining its
  // cutoff/UNKNOWN effects is no longer an authorized initialization path.
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR;
  fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),'{"release":"compatible"}\n');f.git('add','.herdr-release.json');f.git('commit','-qm','Accept release');
  const agent=f.observation.agents[0],directory=lineDirectory(org,gitProject(f.cwd).identity),file=path.join(directory,'service.plist');
  const options={cwd:f.cwd,home:f.installationHome,
    env:{...f.env,HERDR_ENV:'1',HERDR_PANE_ID:agent.pane_id,HERDR_WORKSPACE_ID:agent.workspace_id,CODEX_THREAD_ID:agent.agent_session.value},
    call:(_exe,args)=>JSON.stringify({result:{agent:[agent.pane_id,agent.name].includes(args[2])?agent:null}}),
    command:(_exe,args)=>args[0]==='print'?{status:113,stderr:'Could not find service in domain'}:{status:0,stdout:''}};
  const {main}=await import(pathToFileURL(path.join(f.bundle,'line-service/launchd.mjs')).href);
  const args=['install','--repo',f.cwd,'--org',org,'--id','recipient-install','--herdr','/saved/bin/herdr','--socket','/saved/native.sock'];
  assert.throws(()=>main([...args,'--to','absent-agent','--dry-run'],options),/recipient/);assert.equal(fs.existsSync(directory),false);
  const preview=main([...args,'--dry-run'],options),explicit=main([...args,'--to',agent.name,'--dry-run'],options);
  assert.equal(preview.expected_plan,explicit.expected_plan);assert.equal(fs.existsSync(directory),false);
  const result=main([...args,'--to',agent.name,'--expected-plan',explicit.expected_plan],options);
  assert.equal(result.installation.recipient,agent.name);assert.equal(parsePlist(file).ProgramArguments[8],agent.name);
});
