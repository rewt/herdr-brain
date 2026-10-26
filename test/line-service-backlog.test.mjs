import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { loadEvents } from '../lib/store.mjs';
import { recordMessages } from '../messages/operator-inbox.mjs';
import { inboxTransaction, readInbox } from '../supervisor/prompt-supervisor.mjs';
import { noticeLock } from '../supervisor/notice-lock.mjs';
import { handlePendingLineNotices } from '../supervisor/line-notice-aggregate.mjs';

const source=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
function fixture(t) {
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,file=path.join(org,'supervisor/inbox.log');
  fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,'');
  const actor=structuredClone(f.observation.agents[0]),recipient={...structuredClone(actor),name:'brain-chat',pane_id:'chat:pane',terminal_id:'chat:terminal',agent_session:{value:'chat:session'}};
  const project={repo:f.cwd,identity:path.join(f.cwd,'.git'),org};
  const env={...f.env,HERDR_BRAIN_ROOT:source,HERDR_ENV:'1',HERDR_PANE_ID:actor.pane_id,HERDR_WORKSPACE_ID:actor.workspace_id,CODEX_THREAD_ID:actor.agent_session.value};
  const calls=[];
  const call=(_herdr,args)=>{calls.push(args);assert.deepEqual(args.slice(0,2),['agent','get']);const a=args[2]===actor.pane_id?actor:args[2]==='brain-chat'?recipient:null;assert.ok(a);return JSON.stringify({result:{agent:a}});};
  const put=(rows,events=[])=>inboxTransaction(file,(_entries,append)=>{for(const row of rows)append({type:'notice',id:row.id,to:'brain-chat',message:'[line-service] historical hold',project,herdr:'herdr',attempts:5,retrySeconds:10,...row});for(const e of events)append(e);},{recover:false});
  const messages=()=>recordMessages(loadEvents(org).events);
  const run=(id='backlog-fixture',extra={})=>handlePendingLineNotices({org,id,cwd:f.cwd,env,call,...extra});
  return {...f,org,file,actor,recipient,project,env,calls,put,messages,run};
}

test('pending backlog aggregates all 518 current pending notices, preserves history and unrelated order, and replays without effects',t=>{
  const f=fixture(t); f.put(Array.from({length:518},(_,n)=>({id:`line-${n}`})).concat([{id:'other-message',message:'[org-report] own callback'},{id:'other-recipient',to:'other-supervisor'},{id:'reserved',message:'[operator-ask] existing reserved pointer'},{id:'sent'},{id:'uncertain'}]),[
    {type:'sending',id:'sent',occupant:'saved'},{type:'sent',id:'sent'},{type:'sending',id:'uncertain',occupant:'saved'},
  ]);
  const before=fs.readFileSync(f.file,'utf8'),order=readInbox(f.file).map(e=>e.id),kill=process.kill;
  let result;
  process.kill=()=>{throw Error('no native owner probes allowed');};
  try {result=f.run();} finally {process.kill=kill;}
  assert.equal(result.handled,518);assert.equal(result.selected,518);assert.equal(result.delivered,false);assert.equal(result.model_consumed,false);
  assert.equal(f.messages().length,1);assert.equal(f.messages()[0].envelope.payload.transport_aggregate.count,518);
  assert.ok(fs.readFileSync(f.file,'utf8').startsWith(before));const entries=readInbox(f.file);assert.deepEqual(entries.map(e=>e.id),order);
  for(let n=0;n<518;n++)assert.equal(entries.find(e=>e.id===`line-${n}`).state,'handled');
  for(const id of ['other-message','other-recipient','reserved'])assert.equal(entries.find(e=>e.id===id).state,'pending');
  assert.equal(entries.find(e=>e.id==='sent').state,'sent');assert.equal(entries.find(e=>e.id==='uncertain').state,'uncertain');
  const suffix=fs.readFileSync(f.file,'utf8').slice(before.length).trim().split('\n').map(JSON.parse);
  assert.equal(suffix.length,518);assert.ok(suffix.every(e=>e.type==='autopilot'&&e.result.disposition==='handled'&&e.result.delivered===false));
  const handled=fs.readFileSync(f.file,'utf8');assert.equal(f.run().handled,0);assert.equal(fs.readFileSync(f.file,'utf8'),handled);assert.equal(f.messages().length,1);
});

test('pending backlog actual recipient shape without session is record-only and preserves native caller session proof',t=>{
  const f=fixture(t);f.put([{id:'pending'}]);
  Object.assign(f.recipient,{name:'brain-chat',pane_id:'w3PD:p1',workspace_id:'w3PD',terminal_id:'term_65e986559ca3e1',agent:'codex',agent_status:'working'});delete f.recipient.agent_session;
  const result=f.run('actual-shape'),manifest=JSON.parse(fs.readFileSync(result.manifest));
  assert.equal(result.handled,1);assert.equal(result.delivered,false);assert.equal(result.model_consumed,false);
  assert.equal(manifest.recipient.session,null);assert.equal(manifest.caller.session,f.actor.agent_session.value);
  assert.equal(f.messages()[0].envelope.producer.epoch,f.actor.agent_session.value);
  assert.equal(f.run('actual-shape').handled,0);assert.equal(f.messages().length,1);
});

test('pending backlog nullable recipient still refuses missing foreign or replaced physical binding and missing caller session',t=>{
  const f=fixture(t);f.put([{id:'pending'}]);delete f.recipient.agent_session;
  const original=structuredClone(f.recipient),before=fs.readFileSync(f.file,'utf8');
  for(const change of [{name:'foreign'},{pane_id:null},{workspace_id:null},{terminal_id:null},{cwd:null},{cwd:f.scratch}]){
    Object.assign(f.recipient,original,change);assert.throws(()=>f.run('binding-negative'),/recipient binding is missing\/foreign/);
  }
  Object.assign(f.recipient,original);const callerSession=f.actor.agent_session;delete f.actor.agent_session;
  assert.throws(()=>f.run('caller-negative'),/native caller binding is missing or changed/);f.actor.agent_session=callerSession;
  let reads=0;const call=(_h,args)=>{const value=args[2]===f.actor.pane_id?f.actor:{...f.recipient,terminal_id:++reads>1?'replacement-terminal':f.recipient.terminal_id};return JSON.stringify({result:{agent:value}});};
  assert.throws(()=>f.run('replaced-negative',{call}),/native caller\/recipient changed/);
  assert.equal(fs.readFileSync(f.file,'utf8'),before);assert.equal(f.messages().length,0);
});

test('pending backlog refuses existing drain or journal locks without probing, recovering or restarting their owner',t=>{
  const f=fixture(t);f.put([{id:'pending'}]);const before=fs.readFileSync(f.file,'utf8');
  for(const suffix of ['.drain.lock','.lock']) {
    const release=noticeLock(f.file+suffix,{recover:false}),kill=process.kill;process.kill=()=>{throw Error('owner probe forbidden');};
    try{assert.throws(()=>f.run(),/locked:/);}finally{process.kill=kill;release();}
  }
  const recordLock=path.join(f.org,'lock');fs.mkdirSync(recordLock);fs.writeFileSync(path.join(recordLock,'pid'),String(process.pid));const kill=process.kill;process.kill=()=>{throw Error('record owner probe forbidden');};
  try{assert.throws(()=>f.run('record-locked'),/record is locked/);}finally{process.kill=kill;fs.rmSync(recordLock,{recursive:true});}
  assert.equal(fs.readFileSync(f.file,'utf8'),before);assert.equal(f.messages().length,0);
});

test('pending backlog retains uncertain and in-flight policy attempts and qualifies an all-in-flight selection',t=>{
  const f=fixture(t);f.put([{id:'safe'},{id:'policy'},{id:'uncertain'}],[{type:'autopilot-started',id:'policy',pid:12345},{type:'sending',id:'uncertain',occupant:'saved'}]);
  const result=f.run();assert.equal(result.handled,1);assert.deepEqual(result.retained_ambiguous.map(e=>e.id),['policy','uncertain']);
  const entries=readInbox(f.file);assert.equal(entries.find(e=>e.id==='policy').state,'pending');assert.equal(entries.find(e=>e.id==='uncertain').state,'uncertain');
  const held=f.run('distinct-current');assert.equal(held.result,'pending-line-inflight-held');assert.equal(held.handled,0);assert.equal(f.messages().length,1);
});

test('pending backlog recovers intent record and partial append crashes into one aggregate without fake delivery',t=>{
  const f=fixture(t);f.put([{id:'one'},{id:'two'}]);
  assert.throws(()=>f.run('crash',{fault:phase=>{if(phase==='intent')throw Error('crash after intent');}}),/crash after intent/);
  assert.equal(f.messages().length,0);assert.ok(readInbox(f.file).every(e=>e.state==='pending'));
  assert.throws(()=>f.run('crash',{fault:phase=>{if(phase==='record')throw Error('crash after record');}}),/crash after record/);
  assert.equal(f.messages().length,1);assert.ok(readInbox(f.file).every(e=>e.state==='pending'));
  assert.throws(()=>f.run('crash',{fault:(phase,count)=>{if(phase==='handled'&&count===1)throw Error('crash after append');}}),/crash after append/);
  assert.deepEqual(readInbox(f.file).map(e=>e.state),['handled','pending']);
  assert.equal(f.run('crash').handled,1);assert.equal(f.messages().length,1);assert.ok(readInbox(f.file).every(e=>e.state==='handled'));
});

test('pending backlog source native recipient foreign-project and notice-state CAS failures preserve original bytes',t=>{
  const f=fixture(t);f.put([{id:'pending'}]);const before=fs.readFileSync(f.file,'utf8');
  assert.throws(()=>f.run('bad-root',{env:{...f.env,HERDR_BRAIN_ROOT:f.cwd}}),/matching development source/);
  assert.throws(()=>f.run('missing-native',{env:{...f.env,HERDR_ENV:'0'}}),/native caller binding/);
  let reads=0;const changing=(_h,args)=>{const a=args[2]===f.actor.pane_id?f.actor:{...f.recipient,terminal_id:++reads>1?'replaced':'chat:terminal'};return JSON.stringify({result:{agent:a}});};
  assert.throws(()=>f.run('changed-recipient',{call:changing}),/native caller\/recipient changed/);
  assert.equal(fs.readFileSync(f.file,'utf8'),before);assert.equal(f.messages().length,0);
  assert.throws(()=>f.run('state-cas',{fault:phase=>{if(phase==='intent')throw Error('planned crash');}}),/planned crash/);
  f.put([],[{type:'sending',id:'pending',occupant:'new-ambiguous'}]);
  assert.throws(()=>f.run('state-cas'),/notice CAS changed/);assert.equal(f.messages().length,0);assert.equal(readInbox(f.file)[0].state,'uncertain');
  f.put([{id:'foreign',project:{...f.project,identity:'/foreign/.git'}}]);
  assert.throws(()=>f.run('foreign'),/UNKNOWN\/foreign/);assert.equal(f.messages().length,0);
});

test('pending backlog keeps an incomplete record tail and pending transport bytes intact',t=>{
  const f=fixture(t);f.put([{id:'safe'}]);const record=path.join(f.org,'events.jsonl');fs.appendFileSync(record,'{"type":');
  const recordBefore=fs.readFileSync(record,'utf8'),inboxBefore=fs.readFileSync(f.file,'utf8');
  assert.throws(()=>f.run('torn-record'),/incomplete record/);
  assert.equal(fs.readFileSync(record,'utf8'),recordBefore);assert.equal(fs.readFileSync(f.file,'utf8'),inboxBefore);
});

test('pending backlog concurrent supported CLI controls produce one aggregate and retain lock losers',async t=>{
  const f=fixture(t);f.put([{id:'one'},{id:'two'}]);const bin=path.join(f.scratch,'aggregate-bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'herdr'),`#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]!=='agent'||a[1]!=='get')process.exit(93);const v=a[2]===${JSON.stringify(f.actor.pane_id)}?${JSON.stringify(f.actor)}:a[2]==='brain-chat'?${JSON.stringify(f.recipient)}:null;if(!v)process.exit(94);console.log(JSON.stringify({result:{agent:v}}));\n`,{mode:0o755});
  const args=[path.join(source,'supervisor/prompt-supervisor.mjs'),'--handle-pending-line','--org',f.org,'--id','concurrent'];
  const run=()=>new Promise(resolve=>{const child=spawn(process.execPath,args,{cwd:f.cwd,env:{...f.env,PATH:`${bin}:${f.env.PATH}`}});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('exit',status=>resolve({status,stdout,stderr}));});
  const replies=await Promise.all([run(),run()]);assert.ok(replies.some(r=>r.status===0),JSON.stringify(replies));
  for(const r of replies)if(r.status!==0)assert.match(r.stderr,/locked:/);
  assert.equal(f.messages().length,1);assert.ok(readInbox(f.file).every(e=>e.state==='handled'));
  const retry=await run();assert.equal(retry.status,0,retry.stderr);assert.equal(JSON.parse(retry.stdout).handled,0);assert.equal(f.messages().length,1);
});

test('pending backlog waits for a healthy journal writer release without owner probes',async t=>{
  const f=fixture(t);f.put([{id:'pending'}]);const bin=path.join(f.scratch,'writer-bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'herdr'),`#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]!=='agent'||a[1]!=='get')process.exit(93);const v=a[2]===${JSON.stringify(f.actor.pane_id)}?${JSON.stringify(f.actor)}:a[2]==='brain-chat'?${JSON.stringify(f.recipient)}:null;if(!v)process.exit(94);console.log(JSON.stringify({result:{agent:v}}));\n`,{mode:0o755});
  const marker=path.join(f.scratch,'journal-wait-observed'),hook=path.join(f.scratch,'journal-wait-hook.mjs');
  fs.writeFileSync(hook,`import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const exists=fs.existsSync;fs.existsSync=function(file){const found=exists(file);if(String(file)===${JSON.stringify(f.file+'.lock')}&&found)fs.writeFileSync(${JSON.stringify(marker)},'waiting');return found;};process.kill=()=>{throw Error('native owner probe forbidden');};syncBuiltinESMExports();`);
  const release=noticeLock(f.file+'.lock',{recover:false});let finished;
  const child=spawn(process.execPath,[path.join(source,'supervisor/prompt-supervisor.mjs'),'--handle-pending-line','--org',f.org,'--id','healthy-writer'],{cwd:f.cwd,env:{...f.env,PATH:`${bin}:${f.env.PATH}`,NODE_OPTIONS:`${f.env.NODE_OPTIONS??''} --import=${JSON.stringify(hook)}`}});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const done=new Promise(resolve=>child.on('exit',status=>{finished={status,stdout,stderr};resolve(finished);}));
  try{
    while(!fs.existsSync(marker)&&!finished)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(fs.existsSync(marker),JSON.stringify(finished));assert.ok(fs.existsSync(f.file+'.drain.lock'),'drain remains held while journal writer serializes');
  }finally{release();}
  const result=await done;assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).handled,1);
  assert.equal(f.messages().length,1);assert.equal(readInbox(f.file)[0].state,'handled');
});
