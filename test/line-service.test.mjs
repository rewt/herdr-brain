import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLineService, wakeLineService, sourceRoot, reviewAttempt, serviceDirectory, routeFor } from '../line-service/line-service.mjs';
import {readSchedulingJournal} from '../line-service/journal.mjs';
import { launchPlist } from '../line-service/launchd.mjs';
import { noticeLock } from '../supervisor/notice-lock.mjs';
import { gitProject } from '../lib/project.mjs';
import { loadEvents,transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { captureProductCheckout } from '../lib/product-files.mjs';
import { tierFiles } from './helpers/tier.mjs';
import {createHash} from 'node:crypto';
import {haltObservation,completeHaltPass} from '../line-service/halt-repair.mjs';
import {dispatchInput} from '../line-service/phase1.mjs';
import {closeoutKey} from '../lib/closeout.mjs';
import {closeoutWaitId} from '../lib/closeout-status.mjs';
import {queueOutcomeDecision} from '../line-service/outcome-decision.mjs';
import {commandIntent,finishCommand,forgetActiveCommand} from '../lib/command-receipt.mjs';
import {stoppedDispatchReadmission} from '../dispatch/stopped-readmission.mjs';
import {prejournalReadmission} from '../dispatch/prejournal-readmission.mjs';
import {clearedHoldReadmission} from '../dispatch/hold-readmission.mjs';
import {setup as closeoutFixture,events as closeoutEvents,evaluations as closeoutEvaluations} from './helpers/closeout-fixture.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'line-service-'))), repo = path.join(root, 'project'), org = path.join(repo, '.org');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(repo); fs.writeFileSync(path.join(root, '.identity-root'), 'fixture\n');
  const env = { ...process.env, ORG_DIR: org, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['LANE_CONFIG', 'HERDR_ENV', 'HERDR_PANE_ID', 'CODEX_THREAD_ID']) delete env[key];
  const exec = (exe, args) => {
    const r = spawnSync(exe, args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim();
  };
  const git = args => exec('git', args), record = args => exec(process.execPath, [path.join(sourceRoot, 'bin/org.mjs'), ...args]);
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Line fixture']); git(['config', 'user.email', 'line@example.invalid']);
  fs.writeFileSync(path.join(repo, 'source'), 'initial'); git(['add', '.']); git(['commit', '-qm', 'Initial']); record(['init']);
  fs.writeFileSync(path.join(repo, '.lane.json'), JSON.stringify({ routes: { engineer: { kind: 'codex', model: 'fixture', effort: 'high' } }, dispatch: { max_sessions: 2 } }));
  const boundary = {id:'fixture-cutover',project:gitProject(repo).identity,repo,org,source:fs.realpathSync(sourceRoot),main:'main',canonical_head:git(['rev-parse','HEAD'])};
  // These fixtures start after a recorded boundary, before any fixture work.
  transact(org,()=>({add:['line-service.cutover','line-service.phase0'].map(type=>({...boundary,type}))}));
  // Review steps mutate only through an installed service binding, as in production.
  const directory = serviceDirectory(org, boundary.project); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'installation.json'), JSON.stringify({ at: '2026-10-27T00:00:00Z', repo, org, source: sourceRoot, node: process.execPath, file: path.join(directory, 'service.plist'), target: `gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}` }));
  const add = (title, priority = 1, extra = []) => record(['add', title, '--role', 'engineer', '--priority', String(priority), ...extra]).split(' ')[0];
  const show = id => JSON.parse(record(['show', id, '--json']));
  const calls = [], refreshes = [], notes = [];
  let fail;
  const command = (exe, args, options) => {
    if (args[0] === path.join(sourceRoot, 'supervisor/closeout.mjs')) {
      assert.deepEqual(args.slice(0,6), [path.join(sourceRoot, 'supervisor/closeout.mjs'), 'refresh', '--repo', repo, '--org', org]);assert.equal(args[6],'--deadline');assert.ok(Number.isSafeInteger(Number(args[7])));
      refreshes.push({ exe, args, options });
      return { status: 0, stdout: '{"created":[]}', stderr: '' };
    }
    calls.push({ exe, args, options });
    if (fail) return { status: 1, stdout: '', stderr: fail };
    return { status: 0, stdout: JSON.stringify({ result: args[1] === 'handle' ? 'review_pending' : 'dispatched' }), stderr: '' };
  };
  const service = (overrides = {}) => createLineService({ repo, org, to: 'supervisor-test', env, command,
    haltAfter:100,capacity: () => ({ count: 0, cap: 2 }), recordNotice: data => { notes.push({ to:'supervisor-test',text:data.reason,options:data }); return { id:data.id,state:'record-only' }; }, ...overrides });
  return { repo, org, env, record, git, add, show, calls, refreshes, notes, command, service, setFailure: value => { fail = value; } };
}

function stoppedFixture(t,{reason='Supervisor STOP appeared before dispatch; no new worker launched',stage='start'}={}) {
  const f=fixture(t),item=f.add('HOLD-stopped engineering'),service=f.service(),common=gitProject(f.repo).identity;
  const input=`${f.show(item).created.seq}:ordinary`,key=`dispatch:${item}:${input}`;
  const brief=path.join(service.directory,createHash('sha256').update(JSON.stringify(key)).digest('hex')+'.ask.md');
  fs.writeFileSync(brief,'# Original assignment\n');
  const journal=path.join(f.org,'dispatch/stopped-original.json');fs.mkdirSync(path.dirname(journal),{recursive:true});
  const job={token:'stopped-original',repo:f.repo,org:f.org,common,item,brief,lineInput:input,stage,run:null,
    release:{root:sourceRoot},completion_protocol:1,detached:true,detached_refused:true,native_launch_attempted:false,error:reason,
    failure:{code:'DISPATCH_STOPPED',kind:'fence',stage,native_launch_attempted:false}};
  const bytes=JSON.stringify(job);fs.writeFileSync(journal,bytes);fs.mkdirSync(journal+'.driver');
  const terminal={journal,stage,run:null,exit_code:0,error:reason,code:'DISPATCH_STOPPED',native_launch_attempted:false};
  fs.writeFileSync(journal+'.driver/results.jsonl',JSON.stringify(terminal)+'\n');
  const completion={type:'dispatch.completed',project:common,journal,attempt:job.token,item,run:null,stage,exit_code:0,
    native_launch_attempted:false,failure:job.failure,request_sha256:createHash('sha256').update(bytes).digest('hex')};
  transact(f.org,()=>({add:[completion]}));
  const original={state:'held',at:'2026-11-01T05:00:00Z',error:'Original dispatch stopped: DISPATCH_STOPPED',
    result:{result:'detached',journal,run:null,item,pid:12345},failure:job.failure};
  const file=path.join(service.directory,'effects.json');fs.writeFileSync(file,JSON.stringify({identity:common,org:f.org,actions:{[key]:original}}));
  const proof=()=>({journal,repo:f.repo,org:f.org,common,item,brief,input,events:loadEvents(f.org).events});
  return {...f,item,service,common,key,brief,journal,job,terminal,completion,original,file,bytes,proof};
}

function prejournalFixture(t,reason='fix base differs from actual saved author branch or main',alterIntent=value=>value){
  const f=fixture(t),item=f.add('Pre-journal refused work'),service=f.service(),common=gitProject(f.repo).identity;
  const key=`dispatch:${item}:${f.show(item).created.seq}:ordinary`,directory=service.directory;
  const brief=path.join(directory,createHash('sha256').update(JSON.stringify(key)).digest('hex')+'.ask.md');
  fs.writeFileSync(brief,'# Original pre-journal ask\n');
  const at=new Date().toISOString(),receipt={status:1,signal:null,stdout:JSON.stringify({result:'failed',code:'DISPATCH_FAILED',reason})+'\n',stderr:`dispatch: ${reason}\n`};
  const ref=commandIntent(directory,alterIntent({exe:process.execPath,args:[path.join(sourceRoot,'dispatch/dispatch.mjs'),item,'--repo',f.repo,'--org',f.org,'--brief',brief,'--detach'],
    cwd:f.repo,project:common,org:f.org,subject:item,key,consumer:'line-service'}));
  finishCommand(ref,receipt);forgetActiveCommand(ref);
  const original={state:'held',owner:'line-service',consumer:'line-service',subject:key,execution_subject:item,attempt:'original-attempt',at,
    commands:[ref],receipt,error:`dispatch: ${reason}`,finished_at:new Date().toISOString(),failure:{code:'DISPATCH_FAILED',kind:'unknown'},
    original_outcome:{status:'unknown',reason:'original request outcome unavailable; no replacement',native_launch_attempted:null,run:null}};
  const file=path.join(directory,'effects.json');fs.writeFileSync(file,JSON.stringify({identity:common,org:f.org,actions:{[key]:original}}));
  const proof=entry=>prejournalReadmission({entry,key,repo:f.repo,org:f.org,common,directory,item,brief,events:loadEvents(f.org).events,outcome:entry.original_outcome});
  return{...f,item,line:service,common,key,directory,brief,original,file,ref,proof};
}

for(const reason of ['fix base differs from actual saved author branch or main',
  'record changed repeatedly while preparing a consistent read; no mutation attempted',
  'session cap 1 reached: pending start original-other-journal',
  'review cap 3 reached: original-other-runs'])test(`pre-journal terminal refusal readmits once and preserves evidence: ${reason}`,t=>{
  const f=prejournalFixture(t,reason),receipt=fs.readFileSync(f.ref.receipt,'utf8');
  const barrier=path.join(f.repo,'.lane/supervisor/HOLD');fs.mkdirSync(path.dirname(barrier),{recursive:true});fs.writeFileSync(barrier,'held');
  assert.match(f.line.pass().held,/HOLD/);assert.equal(f.calls.length,0);fs.unlinkSync(barrier);
  f.line.pass();assert.equal(f.calls.length,1,'one fresh dispatch after the guard lifts');
  f.service().pass();f.service().pass();assert.equal(f.calls.length,1,'restarts retain the replacement outcome');
  const actions=JSON.parse(fs.readFileSync(f.file)).actions,recovery=actions[f.key].prejournal_recovery;
  assert.equal(recovery.kind,'terminal-prejournal-refusal');assert.equal(recovery.native_launch_attempted,false);
  const {prejournal_recovery,...original}=actions[f.key];assert.deepEqual(original,f.original);
  assert.equal(actions[recovery.key].state,'complete');
  assert.equal(fs.readFileSync(f.brief,'utf8'),'# Original pre-journal ask\n');assert.equal(fs.readFileSync(f.ref.receipt,'utf8'),receipt);
  const call=f.calls[0];assert.equal(call.args[1],f.item);assert.ok(!call.args.includes('--retry'));
  assert.notEqual(call.args[call.args.indexOf('--brief')+1],f.brief,'new attempt owns a separate ask');
  const events=loadEvents(f.org).events,admitted=events.filter(e=>e.type==='line-service.dispatch-readmitted');
  assert.equal(admitted.length,1);assert.equal(admitted[0].proof.command.sha256,f.ref.sha256);
  assert.ok(events.every(e=>!/^item\.|^run\./.test(e.type)||e.seq<=f.show(f.item).created.seq),'recovery introduces no item/run event');
});

for(const mode of ['refusal','detached'])test(`pre-journal recovery ${mode} gives the original item one outcome owner across restarts`,t=>{
  const f=prejournalFixture(t),receipt=fs.readFileSync(f.ref.receipt,'utf8');
  const journal=path.join(f.org,'dispatch/recovered.json');
  if(mode==='refusal')f.setFailure('dispatch: fix base differs from actual saved author branch or main\n');
  const command=(exe,args,options)=>{
    const result=f.command(exe,args,options);
    if(mode!=='detached'||args[0]!==path.join(sourceRoot,'dispatch/dispatch.mjs'))return result;
    const failure={code:'DISPATCH_FAILED',kind:'error',stage:'open',native_launch_attempted:false};
    const job={token:'recovered',item:f.item,brief:args[args.indexOf('--brief')+1],repo:f.repo,org:f.org,common:f.common,
      stage:'open',completion_protocol:1,native_launch_attempted:false,error:'dispatch setup failed',failure};
    const bytes=JSON.stringify(job);fs.mkdirSync(path.dirname(journal),{recursive:true});fs.writeFileSync(journal,bytes);
    fs.mkdirSync(journal+'.driver');fs.writeFileSync(journal+'.driver/results.jsonl',JSON.stringify({journal,stage:job.stage,
      exit_code:1,run:null,native_launch_attempted:false,error:job.error,code:failure.code})+'\n');
    transact(f.org,()=>({add:[{type:'dispatch.completed',project:f.common,journal,attempt:job.token,item:f.item,run:null,
      stage:job.stage,exit_code:1,native_launch_attempted:false,failure,request_sha256:createHash('sha256').update(bytes).digest('hex')}]}));
    return{status:0,stdout:JSON.stringify({result:'detached',journal,run:null,item:f.item}),stderr:''};
  };
  const service=()=>f.service({command});
  service().pass();service().pass();service().pass();service().pass();
  const effects=JSON.parse(fs.readFileSync(f.file)),recovery=effects.actions[f.key].prejournal_recovery;
  assert.equal(f.calls.length,1,'only the one fresh attempt is dispatched');
  const signals=loadEvents(f.org).events.filter(e=>e.type==='item.added'&&e.meta?.uncertain_outcome?.check.key===recovery.key);
  assert.equal(signals.length,1,'one durable outcome handoff, including after restart');
  assert.equal(signals[0].parent,f.item);assert.equal(signals[0].meta.uncertain_outcome.check.subject.original_key,f.key);
  assert.equal(effects.outcome_decisions[recovery.key].item,signals[0].id);
  if(mode==='detached')assert.equal(effects.actions[recovery.key].recorded_dispatch_status.journal,journal);
  const {prejournal_recovery,...original}=effects.actions[f.key];assert.deepEqual(original,f.original);
  assert.equal(fs.readFileSync(f.ref.receipt,'utf8'),receipt);assert.equal(fs.readFileSync(f.brief,'utf8'),'# Original pre-journal ask\n');
});

test('pre-journal recovery typed capacity refusal retries its saved recovery key and ask',t=>{
  const f=prejournalFixture(t);let attempts=0;
  const command=(exe,args,options)=>{
    const result=f.command(exe,args,options);
    if(args[0]===path.join(sourceRoot,'dispatch/dispatch.mjs')&&++attempts===1)
      return{status:1,stdout:JSON.stringify({result:'failed',code:'DISPATCH_SESSION_CAP',reason:'session capacity reached'}),stderr:''};
    return result;
  };
  f.service({command}).pass();f.service({command}).pass();f.service({command}).pass();
  assert.equal(f.calls.length,2);const asks=f.calls.map(c=>c.args[c.args.indexOf('--brief')+1]);
  assert.equal(asks[0],asks[1]);assert.notEqual(asks[0],f.brief);
  const effects=JSON.parse(fs.readFileSync(f.file)),key=effects.actions[f.key].prejournal_recovery.key;
  assert.equal(effects.actions[key].history.length,1);assert.equal(effects.actions[key].state,'complete');
  assert.equal(Object.keys(effects.outcome_decisions??{}).length,0,'capacity remains ordinary retry admission');
});

test('pre-journal recovery keeps legacy opaque keys and hands their held failure to the original item',t=>{
  const f=prejournalFixture(t),key='dispatch-recovered:legacy-saved-digest';
  const saved=JSON.parse(fs.readFileSync(f.file));
  saved.actions[f.key].prejournal_recovery={...f.proof(f.original),key,at:new Date().toISOString()};
  saved.actions[key]={state:'held',execution_subject:f.item,at:new Date().toISOString(),
    error:'dispatch: fix base differs from actual saved author branch or main',receipt:{status:1,stdout:'',stderr:'dispatch failed'}};
  fs.writeFileSync(f.file,JSON.stringify(saved));
  f.service().pass();f.service().pass();f.service().pass();
  const effects=JSON.parse(fs.readFileSync(f.file));assert.equal(f.calls.length,0,'old held key grants no second launch');
  assert.deepEqual(effects.actions[f.key],saved.actions[f.key]);assert.ok(effects.outcome_decisions[key]);
  const signals=loadEvents(f.org).events.filter(e=>e.type==='item.added'&&e.meta?.uncertain_outcome?.check.key===key);
  assert.equal(signals.length,1);assert.equal(signals[0].parent,f.item);
});

for(const fence of ['started','pending'])test(`pre-journal recovery respects the item ${fence} subject fence`,t=>{
  const f=prejournalFixture(t);
  if(fence==='started'){
    const saved=JSON.parse(fs.readFileSync(f.file));saved.actions['unrelated-effect']={state:'started',execution_subject:f.item};
    fs.writeFileSync(f.file,JSON.stringify(saved));
  }else commandIntent(f.directory,{exe:'unknown',args:[],cwd:f.repo,project:f.common,org:f.org,subject:f.item,key:'pending-effect',consumer:'line-service'});
  f.line.pass();f.service().pass();assert.equal(f.calls.length,0);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).actions[f.key].prejournal_recovery,undefined);
});

test('pre-journal readiness change leaves recovery unspent and the original notice recurring',t=>{
  const f=prejournalFixture(t);
  const service=f.service({capacity:()=>{
    transact(f.org,()=>({add:[{type:'item.updated',id:f.item,fields:{meta:{hold:true}}}]}));return{count:0,cap:2};
  }});
  service.pass();assert.equal(f.calls.length,0);
  let effects=JSON.parse(fs.readFileSync(f.file));assert.deepEqual(effects.actions[f.key],f.original);
  assert.equal(Object.keys(effects.actions).length,1,'readiness race saves no recovery intent');
  // A saved edge without a start/owner must not silence the original notice.
  const proof=f.proof(f.original),key=`dispatch-recovered:${f.item}:not-started`;
  effects.actions[f.key].prejournal_recovery={...proof,key};fs.writeFileSync(f.file,JSON.stringify(effects));
  f.service().pass();f.service().pass();
  effects=JSON.parse(fs.readFileSync(f.file));
  assert.ok(Object.values(effects.record_notices).some(n=>n.boundary===`outcome:${f.key}`&&n.scope.item===f.item&&n.inspection_due));
  // Restore the unspent original after this missing-edge notice control.
  effects.actions[f.key]=f.original;fs.writeFileSync(f.file,JSON.stringify(effects));
  transact(f.org,()=>({add:[{type:'item.updated',id:f.item,fields:{meta:{hold:false}}}]}));
  f.service().pass();f.service().pass();assert.equal(f.calls.length,1,'readiness recovery can start once');
});

test('pre-journal proof rejects correctly hashed foreign command bindings and nonfresh invocations',t=>{
  const mutations=[...['project','org','cwd','key','subject','consumer'].map(field=>intent=>({...intent,[field]:'foreign'})),
    ...['--repo','--org','--brief'].map(flag=>intent=>({...intent,args:intent.args.map((v,i)=>i===intent.args.indexOf(flag)+1?'foreign':v)})),
    intent=>({...intent,args:intent.args.filter(v=>v!=='--detach')}),
    intent=>({...intent,args:[...intent.args,'--retry','foreign.json']}),
    intent=>({...intent,args:intent.args.map((v,i)=>i===1?'ENG-999':v)})];
  for(const alter of mutations){
    const f=prejournalFixture(t,undefined,alter);assert.equal(f.proof(f.original),null,'valid immutable hash does not excuse a foreign binding');
  }
});

test('pre-journal proof rejects uncertain, contradictory, foreign and incomplete attempts',t=>{
  const f=prejournalFixture(t);assert.ok(f.proof(f.original));
  for(const alter of [e=>e.state='started',e=>e.native_launch_attempted=true,e=>e.worker={},e=>e.run='R-1',
    e=>e.launchProcess={},e=>e.sessionBinding={},e=>e.result={journal:'original'},e=>e.history=[{}],
    e=>e.failure.kind='fence',e=>e.failure.native_launch_attempted=true,e=>e.original_outcome.journal='original',e=>e.receipt.signal='SIGTERM',
    e=>e.receipt.signal_sent=true,e=>e.receipt.error={message:'lost'},e=>e.commands=[],
    e=>e.execution_subject='ENG-999',e=>e.finished_at=e.at='invalid',
    e=>e.receipt.stdout=JSON.stringify({result:'failed',code:'DISPATCH_FAILED',reason:'fix base differs from actual saved author branch or main',native_launch_attempted:true}),
    e=>e.error='native outcome unknown']){
    const entry=structuredClone(f.original);alter(entry);assert.equal(f.proof(entry),null);
  }
  const entry=structuredClone(f.original);entry.commands[0].sha256='foreign';assert.throws(()=>f.proof(entry),/binding changed/);
  fs.unlinkSync(f.ref.receipt);assert.throws(()=>f.proof(f.original),/ENOENT/);
  f.line.pass();assert.equal(f.calls.length,0,'missing terminal receipt remains held');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).actions[f.key],f.original);
});

test('pre-journal readmission retains a concurrent recorded start before a fresh effect',t=>{
  const f=prejournalFixture(t);let checked=false;
  const service=createLineService({repo:f.repo,org:f.org,to:'supervisor-test',env:f.env,command:f.command,haltAfter:100,
    capacity:()=>{
      if(!checked){checked=true;transact(f.org,()=>({add:[{type:'run.started',id:'R-1',item:f.item,meta:{}}]}));}
      return{count:0,cap:2};
    },recordNotice:data=>({id:data.id,state:'record-only'})});
  service.pass();assert.equal(f.calls.length,0);assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).actions[f.key],f.original);
  assert.equal(loadEvents(f.org).events.some(e=>e.type==='line-service.dispatch-readmitted'),false);
});

test('pre-journal readmission retains a journal contradicting its cached unknown outcome',t=>{
  const f=prejournalFixture(t),journal=path.join(f.org,'dispatch/original.json');fs.mkdirSync(path.dirname(journal),{recursive:true});
  fs.writeFileSync(journal,JSON.stringify({token:'original',item:f.item,brief:f.brief,repo:f.repo,org:f.org,common:f.common,
    stage:'launching',native_launch_attempted:true}));
  f.line.pass();f.service().pass();assert.equal(f.calls.length,0);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).actions[f.key],f.original);
  assert.equal(loadEvents(f.org).events.some(e=>e.type==='line-service.dispatch-readmitted'),false);
});

for(const fence of ['HOLD','service STOP'])test(`HOLD-stopped dispatch starts once on the first pass after ${fence} lifts and retains its original attempt`,t=>{
  const f=stoppedFixture(t,{...(fence==='service STOP'?{reason:'service STOP appeared before detached effect',stage:'open'}:{})});
  const barrier=fence==='HOLD'?path.join(f.repo,'.lane/supervisor/HOLD'):path.join(f.service.directory,'STOP');
  fs.mkdirSync(path.dirname(barrier),{recursive:true});fs.writeFileSync(barrier,'proving hold');
  assert.match(f.service.pass().held,/STOP|HOLD/);assert.equal(f.calls.length,0);
  fs.unlinkSync(barrier);
  assert.equal(f.service.pass().result,'pass-complete');assert.equal(f.calls.length,1,'first eligible pass dispatches');
  const restarted=createLineService({repo:f.repo,org:f.org,to:'supervisor-test',env:f.env,command:f.command,
    haltAfter:100,capacity:()=>({count:0,cap:2}),recordNotice:data=>({id:data.id,state:'record-only'})});
  restarted.pass();restarted.pass();assert.equal(f.calls.length,1,'restart cannot double-launch');
  const call=f.calls[0];assert.equal(call.args[1],f.item);assert.ok(!call.args.includes('--retry'));
  assert.notEqual(call.args[call.args.indexOf('--brief')+1],f.brief);
  assert.equal(fs.readFileSync(f.journal,'utf8'),f.bytes);assert.equal(fs.readFileSync(f.brief,'utf8'),'# Original assignment\n');
  assert.equal(fs.readFileSync(f.journal+'.driver/results.jsonl','utf8'),JSON.stringify(f.terminal)+'\n');
  const actions=JSON.parse(fs.readFileSync(f.file)).actions;
  assert.deepEqual(actions[f.key].result,f.original.result);assert.deepEqual(actions[f.key].failure,f.original.failure);
  assert.equal(actions[actions[f.key].stop_recovery.key].state,'complete');
  const admissions=loadEvents(f.org).events.filter(e=>e.type==='line-service.dispatch-readmitted');
  assert.equal(admissions.length,1);assert.equal(admissions[0].proof.native_launch_attempted,false);
  assert.equal(loadEvents(f.org).events.some(e=>e.type==='item.added'&&e.meta?.uncertain_outcome),false);
});

test('HOLD-stopped dispatch requires exact original zero-launch evidence and released driver ownership',t=>{
  const f=stoppedFixture(t),args=f.proof(),save=job=>fs.writeFileSync(f.journal,JSON.stringify(job));
  assert.ok(stoppedDispatchReadmission(args));
  for(const patch of [{native_launch_attempted:true},{native_launch_attempted:null},{run:'R-1'},{worker:{}},{launchProcess:{}},{sessionBinding:{}},
    {stage:'launching'},{repo:'/foreign'},{lineInput:'other'},{detached_refused:false},{error:'EPERM native refusal'},
    {failure:{...f.job.failure,code:'EACCES'}},{failure:{...f.job.failure,native_launch_attempted:null}}]){
    save({...f.job,...patch});assert.equal(stoppedDispatchReadmission(args),null,JSON.stringify(patch));
  }
  save(f.job);
  for(const patch of [{native_launch_attempted:null},{journal:'/foreign'},{run:'R-1'},{code:'EACCES'},{error:'unknown'}, {stage:'worker'}]){
    fs.writeFileSync(f.journal+'.driver/results.jsonl',JSON.stringify({...f.terminal,...patch})+'\n');
    assert.equal(stoppedDispatchReadmission(args),null,JSON.stringify(patch));
  }
  fs.writeFileSync(f.journal+'.driver/results.jsonl',JSON.stringify(f.terminal)+'\n');
  for(const patch of [{project:'/foreign'},{attempt:'other'},{request_sha256:'changed'},{run:'R-1'},{native_launch_attempted:null},{failure:null},{exit_code:1}]){
    assert.equal(stoppedDispatchReadmission({...args,events:args.events.map(e=>e.type==='dispatch.completed'?{...e,...patch}:e)}),null,JSON.stringify(patch));
  }
  assert.equal(stoppedDispatchReadmission({...args,events:[]}),null);
  assert.equal(stoppedDispatchReadmission({...args,events:[...args.events,{type:'run.started',item:f.item,seq:99999}]}),null);
  fs.writeFileSync(f.journal+'.lock','original driver');assert.equal(stoppedDispatchReadmission(args),null);fs.unlinkSync(f.journal+'.lock');
  fs.mkdirSync(f.journal+'.locks');fs.writeFileSync(f.journal+'.locks/original','ticket');assert.equal(stoppedDispatchReadmission(args),null);
  fs.unlinkSync(f.journal+'.locks/original');assert.ok(stoppedDispatchReadmission(args));
  fs.unlinkSync(f.journal+'.driver/results.jsonl');assert.equal(stoppedDispatchReadmission(args),null);
  f.service.pass();assert.equal(f.calls.length,0,'missing terminal evidence stays held');
});

// ARCH-41 shape: a foreground refusal older than published completions, whose
// saved outcome froze as retained before its terminal could prove not-started.
function holdRefusalFixture(t) {
  const f=fixture(t),review=f.record(['add','Completed review','--role','reviewer']).split(' ')[0],parent=f.add('Open follow-up',1,['--parent',review]);
  const item=f.add('Refused ordinary work',1,['--parent',parent]),service=f.service(),common=gitProject(f.repo).identity;
  transact(f.org,()=>({add:[{type:'item.closed',id:review,as:'done'},{type:'item.updated',id:parent,fields:{meta:{hold:true}}}]}));
  const key=`dispatch:${item}:${f.show(item).created.seq}:ordinary`;
  const brief=path.join(service.directory,createHash('sha256').update(JSON.stringify(key)).digest('hex')+'.ask.md');
  fs.writeFileSync(brief,'# Original assignment\n');
  const journal=path.join(f.org,'dispatch/hold-original.json');fs.mkdirSync(path.dirname(journal),{recursive:true});
  const reason=`dispatch launch input changed: item/ancestor ${parent} is closed/held/reserved`;
  const failure={code:'DISPATCH_INPUT_CHANGED',kind:'guard-or-command',stage:'open',native_launch_attempted:false,
    launch_input:{journal,token:'hold-original',item,run:null,project:common,subject:parent}};
  const job={token:'hold-original',repo:f.repo,org:f.org,common,item,brief,stage:'open',run:null,release:{root:'/retired/source'},
    phase1_protocol:1,native_launch_attempted:false,error:reason,failure};
  const bytes=JSON.stringify(job);fs.writeFileSync(journal,bytes);fs.mkdirSync(journal+'.driver');fs.mkdirSync(journal+'.locks');
  const terminal={journal,stage:'open',run:null,exit_code:1,error:reason,code:failure.code,native_launch_attempted:false};
  fs.writeFileSync(journal+'.driver/results.jsonl',JSON.stringify(terminal)+'\n');
  const original={state:'held',at:'2026-10-27T19:18:31.591Z',error:`dispatch: ${reason}\nrequest: ${journal}`,finished_at:'2026-10-27T19:18:36.780Z',
    receipt:{status:1,signal:null,stdout:JSON.stringify({result:'failed',code:failure.code,reason,journal})+'\n',stderr:`dispatch: ${reason}\nrequest: ${journal}\n`},
    original_outcome:{status:'retained',journal,request_sha256:createHash('sha256').update(bytes).digest('hex'),stage:'open',run:null,native_launch_attempted:false,error:reason}};
  const file=path.join(service.directory,'effects.json');fs.writeFileSync(file,JSON.stringify({identity:common,org:f.org,actions:{[key]:original}}));
  const hold=value=>transact(f.org,()=>({add:[{type:'item.updated',id:parent,fields:{meta:{hold:value}}}]}));
  const proof=(entry=original,extra=[])=>{
    const events=[...loadEvents(f.org).events,...extra];
    return clearedHoldReadmission({entry,journal,repo:f.repo,org:f.org,common,item,brief,events,state:fold(events)});
  };
  const holds=()=>fs.readFileSync(path.join(service.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.action==='hold'&&r.boundary===`outcome:${key}`).length;
  // The open parent is independent ready work once its own hold lifts.
  const starts=()=>f.calls.filter(c=>c.args[1]===item);
  return {...f,item,parent,review,line:service,common,key,brief,journal,job,terminal,failure,reason,original,file,bytes,hold,proof,holds,starts};
}

test('a launch-hold refusal stays held while its hold stands, then starts once and retains its original attempt',t=>{
  const f=holdRefusalFixture(t);
  assert.equal(f.proof(),null);f.line.pass();assert.equal(f.starts().length,0,'a current hold keeps the attempt held');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).actions[f.key],f.original);
  f.hold(false);f.line.pass();assert.equal(f.starts().length,1,'first eligible pass starts one fresh attempt');
  f.service().pass();f.service().pass();assert.equal(f.starts().length,1,'restart cannot double-launch');
  const [call]=f.starts();assert.ok(!call.args.includes('--retry'));
  assert.notEqual(call.args[call.args.indexOf('--brief')+1],f.brief,'new attempt owns a separate ask');
  assert.equal(fs.readFileSync(f.journal,'utf8'),f.bytes);assert.equal(fs.readFileSync(f.brief,'utf8'),'# Original assignment\n');
  assert.equal(fs.readFileSync(f.journal+'.driver/results.jsonl','utf8'),JSON.stringify(f.terminal)+'\n');
  const actions=JSON.parse(fs.readFileSync(f.file)).actions,{stop_recovery:recovery,...kept}=actions[f.key];
  assert.deepEqual(kept,f.original);assert.equal(recovery.kind,'launch-hold-cleared');assert.equal(recovery.subject,f.parent);
  assert.equal(recovery.journal,f.journal);assert.equal(actions[recovery.key].state,'complete');
  const admissions=loadEvents(f.org).events.filter(e=>e.type==='line-service.dispatch-readmitted');
  assert.equal(admissions.length,1);assert.equal(admissions[0].proof.native_launch_attempted,false);
});

test('a launch-hold refusal keeps its outcome diagnostic until the fresh attempt records a run',t=>{
  const f=holdRefusalFixture(t);
  f.hold(false);f.line.pass();const first=f.holds();assert.ok(first>0);
  f.service().pass();const second=f.holds();assert.ok(second>first,'admitted but unstarted keeps the diagnostic');
  const effects=JSON.parse(fs.readFileSync(f.file));effects.actions[effects.actions[f.key].stop_recovery.key].original_outcome={status:'recorded-run',run:'R-9'};
  fs.writeFileSync(f.file,JSON.stringify(effects));
  f.service().pass();assert.equal(f.holds(),second,'the recorded run ends the diagnostic');assert.equal(f.starts().length,1);
});

test('a launch-hold refusal requires its exact typed zero-effect evidence and released driver ownership',t=>{
  const f=holdRefusalFixture(t);f.hold(false);assert.ok(f.proof());
  const journalled=(patch,terminal=f.terminal)=>{
    fs.writeFileSync(f.journal,JSON.stringify({...f.job,...patch}));
    fs.writeFileSync(f.journal+'.driver/results.jsonl',JSON.stringify(terminal)+'\n');
    const proof=f.proof();fs.writeFileSync(f.journal,f.bytes);fs.writeFileSync(f.journal+'.driver/results.jsonl',JSON.stringify(f.terminal)+'\n');return proof;
  };
  const native='EPERM native refusal';
  for(const [patch,terminal] of [
    [{native_launch_attempted:true},f.terminal],[{worker:{name:'original'}},f.terminal],[{launchProcess:{pid:1}},f.terminal],[{sessionBinding:{}},f.terminal],[{run:'R-1'},f.terminal],
    [{error:native},{...f.terminal,error:native}],
    [{failure:{...f.failure,code:'DISPATCH_FAILED'}},{...f.terminal,code:'DISPATCH_FAILED'}],
    [{failure:{...f.failure,kind:'fence'}},f.terminal],
    [{failure:{...f.failure,launch_input:undefined}},f.terminal],
    [{failure:{...f.failure,launch_input:{...f.failure.launch_input,subject:f.review}}},f.terminal],
    [{failure:{...f.failure,launch_input:{...f.failure.launch_input,item:f.parent}}},f.terminal],
    [{failure:{...f.failure,launch_input:{...f.failure.launch_input,journal:f.journal+'.other'}}},f.terminal],
    [{failure:{...f.failure,launch_input:{...f.failure.launch_input,token:'other'}}},f.terminal],
    [{stage:'start',failure:{...f.failure,stage:'start'}},{...f.terminal,stage:'start'}],
    [{},{...f.terminal,exit_code:0}],[{},{...f.terminal,native_launch_attempted:null}],[{},{...f.terminal,run:'R-1'}],[{},{...f.terminal,error:'other'}],
  ])assert.equal(journalled(patch,terminal),null,JSON.stringify([patch,terminal]));
  assert.ok(f.proof(),'restored evidence still proves');
  for(const alter of [e=>e.state='started',e=>e.history=[{}],e=>e.at='invalid',e=>e.failure={kind:'fence'},e=>e.stop_recovery={},e=>e.prejournal_recovery={},
    e=>e.receipt.status=0,e=>e.receipt.signal='SIGTERM',e=>e.receipt.signal_sent=true,e=>e.receipt.error={message:'lost'},e=>e.receipt.stdout='not json',
    ...[{result:'detached'},{code:'DISPATCH_FAILED'},{reason:'other'},{journal:f.journal+'.other'}].map(patch=>e=>e.receipt.stdout=JSON.stringify({...JSON.parse(e.receipt.stdout),...patch}))]){
    const entry=structuredClone(f.original);alter(entry);assert.equal(f.proof(entry),null,alter.toString());
  }
  for(const start of [{item:f.item,at:'2026-11-03T00:00:00Z',meta:{}},{item:f.parent,at:'2026-10-01T00:00:00Z',meta:{dispatch_journal:f.journal}},{item:f.parent,at:'2026-10-01T00:00:00Z',meta:{dispatch_attempt:'hold-original'}}])
    assert.equal(f.proof(f.original,[{type:'run.started',id:'R-9',seq:99999,...start}]),null,JSON.stringify(start));
  assert.equal(clearedHoldReadmission({entry:f.original,journal:f.journal,repo:f.repo,org:f.org,common:f.common,item:f.item,brief:f.brief+'.other',events:loadEvents(f.org).events,state:fold(loadEvents(f.org).events)}),null,'foreign ask');
  fs.writeFileSync(f.journal+'.lock','original driver');assert.equal(f.proof(),null);fs.unlinkSync(f.journal+'.lock');
  fs.writeFileSync(f.journal+'.locks/original','ticket');assert.equal(f.proof(),null);fs.unlinkSync(f.journal+'.locks/original');
  assert.ok(f.proof());
  fs.unlinkSync(f.journal+'.driver/results.jsonl');assert.equal(f.proof(),null);
  f.line.pass();assert.equal(f.starts().length,0,'missing terminal evidence stays held');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).actions[f.key],f.original);
});

test('HOLD-stopped dispatch rechecks the original proof after capacity observation before a fresh command',t=>{
  const f=stoppedFixture(t);
  const service=createLineService({repo:f.repo,org:f.org,to:'supervisor-test',env:f.env,command:f.command,haltAfter:100,
    recordNotice:data=>({id:data.id,state:'record-only'}),capacity:()=>{
      fs.writeFileSync(f.journal,JSON.stringify({...f.job,native_launch_attempted:true}));return{count:0,cap:2};
    }});
  service.pass();assert.equal(f.calls.length,0);
  assert.equal(loadEvents(f.org).events.some(e=>e.type==='line-service.dispatch-readmitted'),false);
});

for(const code of ['DISPATCH_STOPPED','DISPATCH_FAILED'])test(`HOLD-stopped dispatch records a recovery's ${code} outcome once across another HOLD and restart`,t=>{
  const f=stoppedFixture(t),barrier=path.join(f.repo,'.lane/supervisor/HOLD');
  const journal=path.join(f.org,'dispatch/stopped-recovery.json');
  const command=(exe,args,options)=>{
    const result=f.command(exe,args,options);
    if(args[0]!==path.join(sourceRoot,'dispatch/dispatch.mjs')||args[1]!==f.item)return result;
    const job={...f.job,token:'stopped-recovery',brief:args[args.indexOf('--brief')+1],
      ...(code==='DISPATCH_FAILED'?{error:'dispatch setup failed',failure:{...f.job.failure,code,kind:'error'}}:{})};
    const bytes=JSON.stringify(job),terminal={...f.terminal,journal,code,error:job.error};
    fs.writeFileSync(journal,bytes);fs.mkdirSync(journal+'.driver');
    fs.writeFileSync(journal+'.driver/results.jsonl',JSON.stringify(terminal)+'\n');
    transact(f.org,()=>({add:[{...f.completion,journal,attempt:job.token,failure:job.failure,
      request_sha256:createHash('sha256').update(bytes).digest('hex')}]}));
    return{status:0,stdout:JSON.stringify({result:'detached',journal,run:null,item:f.item}),stderr:''};
  };
  const service=()=>createLineService({repo:f.repo,org:f.org,to:'supervisor-test',env:f.env,command,haltAfter:100,
    capacity:()=>({count:0,cap:2}),recordNotice:data=>({id:data.id,state:'record-only'})});
  const line=service();fs.mkdirSync(path.dirname(barrier),{recursive:true});fs.writeFileSync(barrier,'first HOLD');
  assert.match(line.pass().held,/HOLD/);fs.unlinkSync(barrier);line.pass();
  const key=JSON.parse(fs.readFileSync(f.file)).actions[f.key].stop_recovery.key;
  assert.equal(fs.existsSync(journal+'.lock'),false,'fresh driver lock is released');
  fs.writeFileSync(barrier,'second HOLD');assert.match(line.pass().held,/HOLD/);fs.unlinkSync(barrier);
  line.pass();line.pass();service().pass();
  const effects=JSON.parse(fs.readFileSync(f.file));
  assert.equal(effects.actions[key].recorded_dispatch_status.journal,journal);
  const signals=loadEvents(f.org).events.filter(e=>e.type==='item.added'&&e.meta?.uncertain_outcome?.check.key===key);
  assert.equal(signals.length,1,'one durable owner decision, including after restart');
  assert.equal(signals[0].parent,f.item);
  assert.deepEqual(signals[0].meta.uncertain_outcome.check.subject,{item:f.item,run:null,journal,attempt:'stopped-recovery',
    original_key:f.key,original_journal:f.journal});
  assert.equal(signals[0].meta.uncertain_outcome.check.status.failure.code,code);
  assert.equal(f.calls.filter(call=>call.args[1]===f.item).length,1,'no further fresh command for the retained attempt');
  assert.equal(loadEvents(f.org).events.filter(e=>e.type==='line-service.dispatch-readmitted').length,1);
  assert.equal(fs.readFileSync(f.journal,'utf8'),f.bytes);
  assert.equal(fs.readFileSync(f.journal+'.driver/results.jsonl','utf8'),JSON.stringify(f.terminal)+'\n');
  assert.equal(fs.readFileSync(f.brief,'utf8'),'# Original assignment\n');
});

test('HOLD-stopped dispatch capacity retry keeps its recovery ask and preserves the original across restart',t=>{
  const f=stoppedFixture(t);let attempts=0;
  const command=(exe,args,options)=>{
    const result=f.command(exe,args,options);
    if(args[0]!==path.join(sourceRoot,'dispatch/dispatch.mjs')||args[1]!==f.item)return result;
    if(++attempts===1)return{status:1,stdout:JSON.stringify({result:'failed',code:'DISPATCH_SESSION_CAP',reason:'session capacity reached'}),stderr:''};
    return result;
  };
  const service=()=>createLineService({repo:f.repo,org:f.org,to:'supervisor-test',env:f.env,command,haltAfter:100,
    capacity:()=>({count:0,cap:2}),recordNotice:data=>({id:data.id,state:'record-only'})});
  service().pass();service().pass();service().pass();
  const calls=f.calls.filter(call=>call.args[1]===f.item);
  assert.equal(calls.length,2,'one capacity refusal and one successful retry');
  const asks=calls.map(call=>call.args[call.args.indexOf('--brief')+1]);
  const effects=JSON.parse(fs.readFileSync(f.file)),key=effects.actions[f.key].stop_recovery.key;
  assert.equal(asks[0],path.join(f.service.directory,createHash('sha256').update(JSON.stringify(key)).digest('hex')+'.ask.md'));
  assert.equal(asks[1],asks[0]);assert.notEqual(asks[1],f.brief);
  assert.equal(loadEvents(f.org).events.some(e=>e.type==='item.added'&&e.meta?.uncertain_outcome?.check.key===key),false,'capacity wait is not a terminal owner decision');
  assert.equal(fs.readFileSync(f.journal,'utf8'),f.bytes);
  assert.equal(fs.readFileSync(f.journal+'.driver/results.jsonl','utf8'),JSON.stringify(f.terminal)+'\n');
  assert.equal(fs.readFileSync(f.brief,'utf8'),'# Original assignment\n');
});

test('REV-63 session retirement advances to physical cleanup',t=>{
  for(const refused of [false,true]){
    const f=closeoutFixture(t,{merged:true}),command=f.options.command;
    let refusals=0;
    if(refused)f.options.command=(exe,args,options)=>{
      if(exe===f.job.herdr&&args[0]==='tab'&&args[1]==='close'){
        refusals++;return{status:1,stdout:'',stderr:JSON.stringify({error:{code:'EACCES',message:'original native refusal'}})};
      }
      return command(exe,args,options);
    };
    f.append([{type:'line-service.phase0',id:'bound',project:f.common,repo:f.repo,org:f.org,main:'main',canonical_head:f.head}]);
    f.report();const [source]=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]);
    const target=source.closeout_targets.find(e=>e.signal==='landed'),drains=[];
    const service=createLineService({repo:f.repo,org:f.org,to:'brain-chat',env:f.env,maxStarts:0,closeoutMeasure:()=>{},
      recordNotice:d=>({id:d.id,state:'record-only'}),command:(_exe,args)=>{
        assert.ok(args[0].endsWith('/supervisor/closeout.mjs'));
        if(args[1]==='refresh')return{status:0,stdout:'{}',stderr:''};
        assert.equal(args[1],'drain');assert.equal(args.includes('--parallel'),false);
        const keys=JSON.parse(args[args.indexOf('--keys')+1]),sessionsOnly=args.includes('--sessions-only');
        const result=f.drain({keys,retrySafe:true,sessionsOnly});drains.push({keys,sessionsOnly,result});
        return{status:0,stdout:JSON.stringify(result),stderr:''};
      }});
    service.pass();
    const first=closeoutEvaluations(f).findLast(e=>e.key===target.key);
    if(refused){
      assert.equal(first.completed,false);assert.equal(first.failure.code,'EACCES');assert.equal(first.sessions_retired,undefined);
      const calls=f.herdrCalls(),actions=f.read().actions;
      service.pass();service.pass();assert.equal(refusals,1);assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.read().actions,actions);
      assert.equal(fs.existsSync(f.lane),true);assert.equal(closeoutEvaluations(f).some(e=>e.key===target.key&&e.completed),false);
    }else{
      assert.equal(first.sessions_retired,true,JSON.stringify(drains));assert.equal(first.waiting.next,'physical');
      assert.equal(fs.existsSync(f.lane),true);
      service.pass();
      assert.equal(closeoutEvaluations(f).findLast(e=>e.key===target.key).completed,true,JSON.stringify(drains));
      assert.equal(fs.existsSync(f.lane),false);
      const stages=drains.filter(d=>d.keys.includes(target.key));assert.deepEqual(stages.map(d=>d.sessionsOnly),[true,false]);
      const all=closeoutEvents(f);assert.equal(all.some(e=>e.type==='item.added'&&e.meta?.uncertain_outcome),false);
      assert.equal(all.some(e=>e.type==='closeout.waiting'&&e.key===target.key&&e.revision!==undefined),false);
    }
  }
});

test('default routing handles known role and narrow task aliases without recasting supervisor or orchestrator work',()=>{
  const route={kind:'codex'},config={routes:{narrow:route},selection_policy:{by_task_class:{'implementation-narrow':'narrow'}}};
  for(const role of ['engineer','engineering'])assert.equal(routeFor({role,meta:{}},config),'narrow');
  for(const role of ['supervisor','orchestrator'])assert.throws(()=>routeFor({role,meta:{}},config),/unsupported line role/);
  assert.throws(()=>routeFor({role:'engineer',capability:'unknown',meta:{}},config),/unknown task class: unknown/);
  assert.equal(routeFor({role:'supervisor',meta:{route:'narrow'}},config),'narrow','an explicit existing route remains authoritative');
  for(const role of ['architect','architecture','planner'])assert.equal(routeFor({role,meta:{}},{routes:{unblock:route},selection_policy:{by_task_class:{review:'unblock'}}}),'unblock','partial project selection policy retains the established planning route');
});

test('a changed supervisor address recovers only the exact zero-effect pre-journal failure once and preserves its original receipt',t=>{
  const f=fixture(t),item=f.add('Previously stranded engineering'),s=f.service(),directory=s.directory;
  const configFile=path.join(f.repo,'.lane.json'),config=JSON.parse(fs.readFileSync(configFile));config.routes.review={kind:'claude'};fs.writeFileSync(configFile,JSON.stringify(config));
  const created=f.show(item).created.seq,key=`dispatch:${item}:${created}:ordinary`,brief=path.join(directory,createHash('sha256').update(JSON.stringify(key)).digest('hex')+'.ask.md');
  const reason='Worker brief missing required fields: PROJECT SUPERVISOR address (configure owning project promote.to or launch MONITOR_SUPERVISOR_AGENT); no worker spawned';
  fs.writeFileSync(brief,'# Original assignment\n');
  const original={state:'held',at:'2026-10-27T00:00:00Z',error:'dispatch: '+reason,receipt:{status:1,signal:null,stdout:JSON.stringify({result:'failed',code:'DISPATCH_FAILED',reason}),stderr:'dispatch: '+reason}};
  fs.writeFileSync(path.join(directory,'effects.json'),JSON.stringify({identity:gitProject(f.repo).identity,org:f.org,actions:{[key]:original}}));
  s.pass();assert.equal(f.calls.length,0,'an unchanged missing address never retries');
  const changed={env:{...f.env,MONITOR_SUPERVISOR_AGENT:'supervisor-test'}};
  f.service(changed).pass();f.service(changed).pass();assert.equal(f.calls.length,1,fs.readFileSync(path.join(directory,'passes.jsonl'),'utf8'));assert.equal(f.calls[0].args[1],item);
  const actions=JSON.parse(fs.readFileSync(path.join(directory,'effects.json'))).actions;
  assert.deepEqual(actions[key].receipt,original.receipt);assert.ok(actions[key].prejournal_recovery);
  assert.equal(actions[actions[key].prejournal_recovery.key].state,'complete');
});

test('three completed engineering-idle passes file and immediately dispatch one repair across restart while original native refusal remains retained',t=>{
  const f=fixture(t),item=f.add('Native refusal'),options={haltAfter:3};f.setFailure('native permission refused');
  // Admission records the refusal before the first end-of-pass idle observation.
  // Readback on pass two stays diagnostic: no decision changes the signature.
  // completeHaltPass therefore counts this same episode as 1, 2, then 3.
  f.service(options).pass();
  const journal=path.join(f.service().directory,'effects.json'),key=Object.keys(JSON.parse(fs.readFileSync(journal)).actions).find(k=>k.startsWith(`dispatch:${item}:`));
  const original=JSON.parse(fs.readFileSync(journal)).actions[key].receipt;
  assert.equal(JSON.parse(fs.readFileSync(journal)).actions[key].state,'held');
  assert.equal(original.status,1);assert.match(original.stderr,/native permission refused/);
  const repairs=()=>[...fold(loadEvents(f.org).events).items.values()].filter(i=>i.meta.halt_repair===1);
  assert.equal(repairs().length,0,'the first completed idle pass is below threshold');
  assert.equal([...fold(loadEvents(f.org).events).items.values()].filter(i=>i.meta.uncertain_outcome).length,0);
  const initial=JSON.parse(fs.readFileSync(journal)).halt_progress;
  assert.equal(initial.count,1);
  f.service(options).pass();assert.equal(repairs().length,0);
  assert.equal([...fold(loadEvents(f.org).events).items.values()].filter(i=>i.meta.uncertain_outcome).length,0);
  const readback=JSON.parse(fs.readFileSync(journal)).halt_progress;
  assert.equal(readback.count,2);assert.equal(readback.episode,initial.episode);
  f.service(options).pass();
  assert.equal(repairs().length,1);const repair=repairs()[0];
  const threshold=JSON.parse(fs.readFileSync(journal)).halt_progress;
  assert.equal(threshold.count,options.haltAfter);assert.equal(threshold.episode,initial.episode);
  assert.equal(threshold.signature,initial.signature);assert.equal(threshold.item,repair.id);
  assert.equal(repair.meta.halt_episode,initial.episode);assert.equal(repair.meta.halt_pass,threshold.pass);
  assert.equal(f.calls.filter(c=>c.args[1]===item).length,1);
  assert.equal(f.calls.filter(c=>c.args[1]===repair.id).length,1,'fresh ordinary dispatch in the threshold pass');
  for(let n=0;n<3;n++)f.service(options).pass();
  assert.equal(repairs().length,1);assert.equal(f.calls.filter(c=>c.args[1]===repair.id).length,1);
  assert.equal(JSON.parse(fs.readFileSync(journal)).actions[key].state,'held');
  assert.deepEqual(JSON.parse(fs.readFileSync(journal)).actions[key].receipt,original);
  const release=noticeLock(path.join(f.service().directory,'pass.lock'));
  try{assert.throws(()=>f.service(options).pass(),/locked/);}finally{release();}
  assert.equal(repairs().length,1);
});

test('engineering-idle ignores retired automatic judgments across completed passes and still admits independent engineering',t=>{
  const f=fixture(t);
  transact(f.org,()=>({add:Array.from({length:12},(_,n)=>({type:'item.added',id:`DEC-${n+1}`,kind:'work',role:'decision',title:'Retained outcome',
    meta:{queue_selected:true,route:'unblock',...(n===11?{backlog_batch:1}:{uncertain_outcome:{check:{key:`${n===10?'dispatch':'review'}:retained-${n}`}}})}}))}));
  const original=loadEvents(f.org).events;
  for(let n=0;n<3;n++)f.service({haltAfter:3}).pass();
  assert.equal(f.calls.length,0,'no new judgment or recursive repair dispatch');
  assert.deepEqual(loadEvents(f.org).events,original,'retired READY records and their full history stay intact');
  const journal=readSchedulingJournal(path.join(f.service().directory,'effects.json'));
  assert.equal(journal.halt_progress.count,0);assert.deepEqual(journal.actions,{});
  const observations=fs.readFileSync(path.join(f.service().directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.action==='engineering-idle-observation');
  assert.equal(observations.length,3);assert.ok(observations.every(r=>r.observation.ready.length===0));
  const rows=fs.readFileSync(path.join(f.service().directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  for(let n=1;n<=12;n++){
    const hold=rows.find(r=>r.action==='admission-held'&&r.item===`DEC-${n}`);
    assert.equal(hold?.code,'RETIRED_JUDGMENT');assert.match(hold.reason,/retired; no saved dispatch for this exact input/);
    assert.equal(journal.negative_evaluations.entries[`admission:DEC-${n}`].reason,hold.reason,'warm negative observations retain the hold explanation');
  }
  const ready=f.add('Independent engineering');f.service({haltAfter:3}).pass();
  assert.deepEqual(f.calls.map(c=>c.args[1]),[ready]);
});

test('selected decision admission records a policy hold and launches once after its removal',t=>{
  const f=fixture(t);
  transact(f.org,()=>({add:[{type:'item.added',id:'DEC-1',kind:'work',role:'decision',title:'Selected decision',
    meta:{queue_selected:true,route:'engineer',uncertain_outcome:{check:{key:'dispatch:original'}}}}]}));
  const service=f.service(),rows=()=>fs.readFileSync(path.join(service.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  service.pass();
  assert.equal(f.calls.length,0);assert.equal(rows().find(r=>r.action==='admission-held'&&r.item==='DEC-1')?.code,'RETIRED_JUDGMENT');
  f.record(['set','DEC-1','meta.uncertain_outcome=null']);
  f.record(['set','DEC-1','meta.reserved=true']);
  service.pass();
  assert.equal(f.calls.length,0,'removing retirement does not bypass reserved authority');
  assert.ok(rows().some(r=>r.action==='hold'&&r.boundary==='dispatch:DEC-1'&&/reserved/.test(r.reason)));
  f.record(['set','DEC-1','meta.reserved=false']);
  service.pass();service.pass();
  assert.deepEqual(f.calls.map(c=>c.args[1]),['DEC-1'],'fresh policy observation dispatches once without hand dispatch');
  assert.equal(rows().filter(r=>r.action==='admission-attempted'&&r.item==='DEC-1').length,1);
  assert.equal(rows().filter(r=>r.action==='admission-started'&&r.item==='DEC-1').length,1);
});

test('engineering-idle keeps only exact saved judgment inputs and rechecks them before repair intent without replay',t=>{
  const f=fixture(t);
  transact(f.org,()=>({add:[1,2,3].map(n=>({type:'item.added',id:`DEC-${n}`,kind:'work',role:'decision',title:'Retained judgment',
    meta:n===3?{}:{queue_selected:true,route:'unblock',uncertain_outcome:{check:{key:`${n===1?'review':'dispatch'}:original`}}}}))}));
  const events=loadEvents(f.org).events,state=fold(events),identity=gitProject(f.repo).identity;
  const input=dispatchInput({state,events,item:state.items.get('DEC-1'),org:f.org,identity}),key=`dispatch:DEC-1:${input}`;
  const original={state:'complete',result:{result:'dispatched'},receipt:{status:0,stdout:'original dispatch',stderr:''}};
  const actions={[key]:original,'dispatch:DEC-2:stale-input':original};
  assert.deepEqual(haltObservation({state,events,org:f.org,identity,config:{},actions}).ready,['DEC-1','DEC-3'],'manual decisions remain ordinary work, stale saved inputs do not qualify');
  // Leave only the exact retained decision eligible so the transactional recheck
  // must receive the same actions as the observation, including after restart.
  f.record(['set','DEC-3','meta.hold=true']);
  const journal=path.join(f.service().directory,'effects.json');fs.writeFileSync(journal,JSON.stringify({identity,org:f.org,actions}));
  f.service({haltAfter:1}).pass();
  const repairs=[...fold(loadEvents(f.org).events).items.values()].filter(i=>i.meta.halt_repair===1);
  assert.equal(repairs.length,1,'exact saved work survives the record-intent recheck');
  assert.deepEqual(f.calls.map(c=>c.args[1]),[repairs[0].id],'retained judgment is never replayed');
  const retained=JSON.parse(fs.readFileSync(journal)).actions;
  assert.deepEqual(retained[key],original);assert.deepEqual(retained['dispatch:DEC-2:stale-input'],original);
});

test('outcome retirement line pass never creates cleanup judgments or evaluates terminal proposals',t=>{
  const f=fixture(t),service=f.service(),identity=gitProject(f.repo).identity,retired=[];
  const config=JSON.parse(fs.readFileSync(path.join(f.repo,'.lane.json')));config.routes.unblock={kind:'codex',model:'fixture',effort:'high'};
  fs.writeFileSync(path.join(f.repo,'.lane.json'),JSON.stringify(config));
  const release=noticeLock(path.join(service.directory,'pass.lock'));
  try{
    for(const key of ['review:old','dispatch:old'])retired.push(queueOutcomeDecision({repo:f.repo,org:f.org,env:f.env,
      check:{key,subject:{run:'R-1',key:'unqueued',source:{seq:1,type:'item.closed'}}}}).item);
    assert.equal(queueOutcomeDecision({repo:f.repo,org:f.org,env:f.env,
      check:{key:'closeout:unqueued',subject:{run:'R-1',key:'unqueued',source:{seq:1,type:'item.closed'}}}}).held,true);
    const source={seq:1,type:'item.closed'},key=closeoutKey(f.repo,'R-2','landed'),entry={schema:'closeout-entry/v2',common:identity,
      signal:'landed',run:'R-2',branch:'lane/cleanup',key,cwd:f.repo,gitDirectory:identity,org:f.org,project:f.repo,source,
      head:f.git(['rev-parse','HEAD']),worktreeIdentity:{},gitIdentity:{},panes:[]};
    const directory=path.join(identity,'closeout/entries');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,key+'.json'),JSON.stringify(entry));
    const prior={type:'closeout.evaluated',identity,key,source,run:'R-2',revision:1,completed:false,reason:'EPERM native refusal',failure:{kind:'fence',code:'EPERM'}};
    transact(f.org,()=>({add:[prior,{type:'closeout.waiting',identity,key,source,run:'R-2',revision:1,wait_id:closeoutWaitId(entry,prior),
      waiting:{owner:'line-service',defect:'Original native refusal needs its owner',producers:[]}}]}));
    const live=queueOutcomeDecision({repo:f.repo,org:f.org,env:f.env,check:{key:`closeout:${key}`,subject:{run:'R-2',key,source}}});
    assert.equal(live.held,true);assert.equal(live.item,undefined);assert.match(live.reason,/original owner evidence/);
  }finally{release();}
  service.pass();
  const rows=fs.readFileSync(path.join(service.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(r=>r.action==='pass-complete'));
  assert.ok(!rows.some(r=>retired.includes(r.item)),'no admission probe, policy hold or dispatch for terminal proposals');
  const effects=readSchedulingJournal(path.join(service.directory,'effects.json'));
  for(const id of retired)assert.equal(effects.negative_evaluations?.entries[`admission:${id}`],undefined,'not even a cached admission evaluation');
  assert.equal(f.calls.some(c=>/^DEC-/.test(c.args[1]??'')),false,'the native refusal stays owned without a judgment session');
  assert.equal(loadEvents(f.org).events.some(e=>e.type==='closeout.effect'),false,'fixture never executes or clears the refused cleanup');
});

test('engineering-idle ignores obsolete closeout decisions across completed passes without replay and admits independent engineering',t=>{
  const f=fixture(t),identity=gitProject(f.repo).identity;
  transact(f.org,()=>({add:[{type:'item.added',id:'DEC-1',kind:'work',role:'decision',title:'Retained cleanup outcome',
    meta:{queue_selected:true,route:'unblock',uncertain_outcome:{check:{key:'closeout:unqueued',subject:{key:'unqueued',source:{seq:1,type:'report.ingested'}}}}}}]}));
  const events=loadEvents(f.org).events,state=fold(events),input=dispatchInput({state,events,item:state.items.get('DEC-1'),org:f.org,identity});
  assert.ok(input,'the obsolete decision otherwise has dispatch input');
  const key=`dispatch:DEC-1:${input}`,original={state:'complete',result:{result:'dispatched'},receipt:{status:0,stdout:'original cleanup decision',stderr:''}};
  const journal=path.join(f.service().directory,'effects.json');fs.writeFileSync(journal,JSON.stringify({identity,org:f.org,actions:{[key]:original}}));
  for(let n=0;n<3;n++)assert.equal(f.service({haltAfter:3}).pass().result,'pass-complete');
  assert.equal(f.calls.length,0,'obsolete cleanup alone cannot dispatch a judgment or repair');
  assert.deepEqual(loadEvents(f.org).events,events,'retained decision history stays intact');
  const saved=JSON.parse(fs.readFileSync(journal));assert.equal(saved.halt_progress.count,0);assert.deepEqual(saved.actions,{[key]:original});
  const observations=fs.readFileSync(path.join(f.service().directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.action==='engineering-idle-observation');
  assert.equal(observations.length,3);assert.ok(observations.every(r=>r.observation.ready.length===0));
  const holds=fs.readFileSync(path.join(f.service().directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.action==='admission-held'&&r.item==='DEC-1');
  assert.equal(holds.length,3);assert.ok(holds.every(r=>r.code==='OBSOLETE_OUTCOME_DECISION'&&r.reason==='cleanup request is no longer queued'));
  const ready=f.add('Independent engineering');f.service({haltAfter:3}).pass();
  assert.deepEqual(f.calls.map(c=>c.args[1]),[ready]);
});

test('engineering-idle shares closeout deferrals and excludes current cleanup defects from repair intent',t=>{
  const f=fixture(t),identity=gitProject(f.repo).identity,directory=path.join(identity,'closeout/entries');fs.mkdirSync(directory,{recursive:true});
  const cases=['source-changed','completed','owned-stage','unlinked','defect'],entries=[],add=[];
  for(const [n,name] of cases.entries()){
    const id=`DEC-${n+1}`,run=`R-${n+1}`,source={seq:1,type:'line-service.cutover'},key=closeoutKey(f.repo,run,'landed');
    const entry={schema:'closeout-entry/v2',common:identity,signal:'landed',run,branch:'lane/cleanup',key,cwd:f.repo,gitDirectory:identity,
      org:f.org,project:f.repo,source,head:f.git(['rev-parse','HEAD']),worktreeIdentity:{},gitIdentity:{},panes:[]};
    entries.push(entry);fs.writeFileSync(path.join(directory,key+'.json'),JSON.stringify(entry));
    add.push({type:'item.added',id,kind:'work',role:'decision',title:name,meta:{queue_selected:true,route:'unblock',uncertain_outcome:{check:{key:`closeout:${key}`,
      subject:{key,source:name==='source-changed'?{...source,seq:2}:source}}}}});
    const prior={type:'closeout.evaluated',identity,key,source,run,item:id,revision:1,completed:name==='completed',
      reason:name==='owned-stage'?'no bound session target; physical cleanup remains separate':'original native refusal',
      ...(name==='owned-stage'?{}:{failure:{kind:'fence',code:'EPERM'}})};
    add.push(prior);
    if(name==='defect')add.push({type:'closeout.waiting',identity,key,source,run,item:id,revision:1,wait_id:closeoutWaitId(entry,prior),
      waiting:{owner:'line-service',defect:'Original native refusal needs its owner',producers:[]}});
  }
  add.push({type:'item.added',id:'DEC-6',kind:'work',role:'decision',title:'Ordinary manual decision',meta:{queue_selected:true}});
  transact(f.org,()=>({add}));
  const events=loadEvents(f.org).events,state=fold(events),observation=haltObservation({state,events,org:f.org,identity,config:{}});
  for(const id of ['DEC-1','DEC-2','DEC-3','DEC-4','DEC-5','DEC-6'])assert.ok(dispatchInput({state,events,item:state.items.get(id),org:f.org,identity}),id);
  assert.deepEqual(observation.ready,['DEC-6'],'only the ordinary manual decision counts');
  const options={repo:f.repo,org:f.org,env:f.env,observation,route:'engineer',after:1,audit:'fixture audit',effects:'fixture effects'};
  const release=noticeLock(path.join(f.service().directory,'pass.lock'));t.after(release);
  const result=completeHaltPass({...options,pass:'current-defect'});
  assert.equal(result.dispatch,true,'the transactional recheck uses the same closeout policy');
  const repair=fold(loadEvents(f.org).events).items.get(result.item);assert.match(repair.meta.scope,/ready items DEC-6/);
  const entry=entries.at(-1);fs.writeFileSync(path.join(directory,entry.key+'.json'),JSON.stringify({...entry,source:{...entry.source,seq:2}}));
  assert.deepEqual(haltObservation({state,events,org:f.org,identity,config:{}}).ready,['DEC-6'],'changing a cleanup source cannot make a zero-effect judgment ready');
  transact(f.org,()=>({add:[{type:'item.updated',id:'DEC-6',fields:{meta:{queue_selected:false}}}]}));
  assert.throws(()=>completeHaltPass({...options,pass:'changed-source'}),/halt ready inputs changed/,'changed ordinary ready work cannot pass a stale repair-intent recheck');
  assert.equal(f.calls.length,0,'observation and intent do not execute cleanup or replay the refusal');
  assert.deepEqual(loadEvents(f.org).events.slice(0,events.length),events);
});

test('engineering-idle excludes held ancestry reserved work and unchanged blocked reports while independent work still dispatches',t=>{
  const f=fixture(t),held=f.add('Explicit hold'),parent=f.record(['add','Dropped review ancestry','--role','reviewer']).split(' ')[0],child=f.add('Selected child',99,['--parent',parent]),blocked=f.add('Unchanged blocked report');
  const reserved=f.add('Reserved publication'),ancestor=f.add('Reserved ancestor'),descendant=f.add('Reserved descendant',99,['--parent',ancestor]);
  transact(f.org,()=>({add:[
    {type:'item.updated',id:held,fields:{meta:{hold:true}}},
    // Only completed work releases ordinary children; dropped work closes its subtree.
    {type:'item.closed',id:parent,as:'dropped'},
    {type:'item.updated',id:child,fields:{meta:{queue_selected:true}}},
    {type:'item.updated',id:reserved,fields:{meta:{category:'publish'}}},
    {type:'item.updated',id:ancestor,fields:{meta:{operator_reserved:true}}},
    {type:'run.started',id:'R-1',item:blocked,meta:{}},
    {type:'report.ingested',run:'R-1',sha256:'unchanged-report',file:'reports/R-1.md',report:{outcome:'blocked',summary:'Needs a real reframe.'}},
    {type:'link.added',blocker:parent,blocked}
  ]}));
  const original=loadEvents(f.org).events;
  for(let n=0;n<3;n++)f.service({haltAfter:3}).pass();
  assert.equal(f.calls.length,0,'no native dispatch or recursive repair for inadmissible work');
  const observed=loadEvents(f.org).events,state=fold(observed);
  assert.equal([...state.items.values()].some(i=>i.meta.halt_repair===1),false);
  assert.deepEqual(observed.slice(0,original.length),original,'holds, reports and ancestry stay unchanged');
  // The finite closeout role observes this report's missing native binding.
  // Admit only that typed keep; dispatch/repair must not add any other event.
  const added=observed.slice(original.length),source=original.find(e=>e.type==='report.ingested');
  assert.equal(added.length,1,'only the original report gets a missing-binding observation across repeated passes');
  const [kept]=added;
  assert.equal(kept.type,'closeout.binding-kept');
  assert.equal(kept.identity,gitProject(f.repo).identity);
  assert.equal(kept.run,'R-1');assert.equal(kept.item,blocked);
  assert.deepEqual(kept.source,{seq:source.seq,type:source.type});
  assert.equal(kept.completed,false);assert.equal(kept.condition.kind,'missing-identity');
  for(const resource of ['session','folder','branch'])assert.equal(kept.resources[resource].status,'kept');
  const effects=JSON.parse(fs.readFileSync(path.join(f.service().directory,'effects.json')));
  assert.equal(effects.halt_progress.count,0);
  const observations=fs.readFileSync(path.join(f.service().directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.action==='engineering-idle-observation');
  assert.ok(observations.every(r=>r.observation.ready.length===0));
  const ready=f.add('Independent eligible engineering'),beforeDispatch=loadEvents(f.org).events;
  f.service({haltAfter:3}).pass();
  assert.deepEqual(f.calls.map(c=>c.args[1]),[ready],'existing ordinary dispatch admits independent work');
  assert.ok(!f.calls.some(c=>[held,child,blocked,reserved,ancestor,descendant].includes(c.args[1])));
  const repeated=loadEvents(f.org).events.slice(beforeDispatch.length).filter(e=>e.type==='closeout.binding-kept'&&e.run==='R-1');
  assert.deepEqual(repeated,[],'independent dispatch does not repeat the missing-binding observation');
});

test('engineering-idle includes an authorized blocked restart even before the record status changes',()=>{
  const events=[
    {type:'item.added',id:'ENG-1',kind:'work',role:'engineer',title:'Blocked engineering'},
    {type:'run.started',id:'R-1',item:'ENG-1',meta:{}},
    {type:'report.ingested',run:'R-1',sha256:'original-report',file:'reports/R-1.md',report:{outcome:'blocked'}},
  ].map((e,n)=>({...e,seq:n+1,by:'fixture',at:'2026-10-27T00:00:00Z'}));
  const observe=()=>haltObservation({events,state:fold(events),identity:'fixture',config:{}});
  assert.deepEqual(observe().ready,[]);
  events.push({type:'item.updated',id:'ENG-1',fields:{title:'Explicitly reframed engineering'},seq:4,by:'fixture'});
  assert.deepEqual(observe().ready,['ENG-1'],'use the normal changed-input restart predicate');
});

test('priority READY dispatch uses existing admission and retains its one effect across restart', t => {
  const f = fixture(t); const high = f.add('High', 7);
  const s = f.service({ to: 'brain-chat', env: { ...f.env, MONITOR_SUPERVISOR_AGENT: 'supervisor-test' } });
  s.pass(); s.pass();
  assert.equal(f.calls.length, 1);
  const call = f.calls[0]; assert.equal(call.args[0], path.join(sourceRoot, 'dispatch/dispatch.mjs')); assert.equal(call.args[1], high);
  assert.ok(!call.args.includes('--to')); assert.ok(!call.args.includes('--reuse'));
  assert.equal(call.options.env.HERDR_PANE_ID, undefined); assert.equal(call.options.env.HERDR_ENV, undefined);
  assert.equal(call.options.env.MONITOR_SUPERVISOR_AGENT, 'supervisor-test');
});
test('reopened dispatch gets one fresh start and preserves creation-key UNKNOWN and held attempts',t=>{
  for(const retained of ['started','held']){
    const f=fixture(t),item=f.add('Reopened engineering'),service=f.service(),file=path.join(service.directory,'effects.json');
    const key=`dispatch:${item}:${f.show(item).created.seq}:ordinary`;
    const original={state:retained,at:'2026-10-27T00:00:00Z',error:'Original UNKNOWN outcome retained',
      receipt:{status:null,stdout:'original receipt',stderr:'UNKNOWN'},original_outcome:{status:'unknown',error:'Original UNKNOWN outcome retained'}};
    fs.writeFileSync(file,JSON.stringify({identity:gitProject(f.repo).identity,org:f.org,actions:{[key]:original}}));
    service.pass();assert.equal(f.calls.length,0,'unchanged input retains the original attempt');
    for(let cycle=1;cycle<=2;cycle++){
      f.record(['close',item]);f.record(['reopen',item]);
      const reopened=loadEvents(f.org).events.findLast(e=>e.type==='item.reopened'&&e.id===item);
      f.service().pass();assert.equal(f.calls.length,cycle,'the first line pass starts the new input');
      f.record(['note',item,'Routine status does not create dispatch input']);
      f.service().pass();assert.equal(f.calls.length,cycle,'repeated passes and notes cannot double-dispatch');
      const actions=JSON.parse(fs.readFileSync(file)).actions;
      assert.deepEqual(actions[key],original,'the old UNKNOWN/held attempt remains byte-equivalent as data');
      assert.equal(actions[`${key}:reopened-${reopened.seq}`].state,'complete');
    }
    assert.ok(f.calls.every(c=>c.args[0]===path.join(sourceRoot,'dispatch/dispatch.mjs')&&c.args[1]===item&&!c.args.includes('--retry')));
  }
});
test('reported dispatch starts reopened work within one line pass and suppresses every open-run duplicate',t=>{
  const f=fixture(t),item=f.add('Reported work'),service=f.service(),file=path.join(service.directory,'effects.json');
  transact(f.org,()=>({add:[{type:'run.started',id:'R-1',item,meta:{}},
    {type:'report.ingested',run:'R-1',sha256:'original-report',report:{outcome:'done',artifacts:[]}},
    {type:'item.closed',id:item,as:'done'}]}));
  const key=`dispatch:${item}:R-1:ordinary`,original={state:'held',at:'2026-10-27T00:00:00Z',error:'Original held dispatch',original_outcome:{status:'unknown'}};
  fs.writeFileSync(file,JSON.stringify({identity:gitProject(f.repo).identity,org:f.org,actions:{[key]:original}}));
  f.record(['reopen',item]);
  const command=(exe,args,options)=>{
    if(args[0]===path.join(sourceRoot,'dispatch/dispatch.mjs')){
      assert.equal(args[1],item);assert.ok(args.includes('--detach'));assert.ok(!args.includes('--retry'));
      transact(f.org,()=>({add:[{type:'run.started',id:'R-2',item,meta:{}}]}));
    }
    return f.command(exe,args,options);
  };
  f.service({command}).pass();assert.equal(f.calls.length,1,'reopen alone causes the line to start work in its next pass');
  // Even a later explicit reopen cannot bypass an open run. A newer abandoned
  // run must not hide the earlier open run from readiness, either.
  transact(f.org,()=>({add:[{type:'item.reopened',id:item},{type:'run.started',id:'R-3',item,meta:{}},{type:'run.abandoned',id:'R-3'}]}));
  f.service({command}).pass();f.service({command}).pass();assert.equal(f.calls.length,1);
  const events=loadEvents(f.org).events,state=fold(events);
  assert.equal(dispatchInput({events,state,item:state.items.get(item),org:f.org,identity:gitProject(f.repo).identity}),null);
  assert.equal(state.runs.get('R-1').report.sha256,'original-report');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).actions[key],original);
});
test('reported dispatch returning to ready gets a new input without reopening or replaying old attempts',t=>{
  for(const outcome of ['failed','blocked']){
    const f=fixture(t),item=f.add('Work returning to ready'),service=f.service(),file=path.join(service.directory,'effects.json');
    const key=`dispatch:${item}:${f.show(item).created.seq}:ordinary`,original={state:'started',at:'2026-10-27T00:00:00Z',error:'Original UNKNOWN'};
    fs.writeFileSync(file,JSON.stringify({identity:gitProject(f.repo).identity,org:f.org,actions:{[key]:original}}));
    transact(f.org,()=>({add:[{type:'run.started',id:'R-1',item,meta:{}},
      {type:'report.ingested',run:'R-1',sha256:'reported-run',report:{outcome,artifacts:[]}},
      ...(outcome==='blocked'?[{type:'item.added',id:'HUM-1',role:'human',title:'Original blocker'},
        {type:'link.added',blocker:'HUM-1',blocked:item},{type:'item.closed',id:'HUM-1',as:'done'}]:[])]}));
    f.service().pass();assert.equal(f.calls.length,1,'the reported-run input is admitted in one pass');
    f.service().pass();assert.equal(f.calls.length,1,'the same ready input gets only one start');
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).actions[key],original);
    assert.ok(Object.keys(JSON.parse(fs.readFileSync(file)).actions).some(k=>k.startsWith(`dispatch:${item}:R-1:`)));
  }
});
test('reopened dispatch keeps active command and unrelated UNKNOWN subject fences',t=>{
  for(const held of ['active-command','other-effect']){
    const f=fixture(t),item=f.add('Reopened fenced work'),service=f.service(),file=path.join(service.directory,'effects.json');
    const key=`dispatch:${item}:${f.show(item).created.seq}:ordinary`,original={state:'started',at:'2026-10-27T00:00:00Z',error:'Original UNKNOWN'};
    const actions={[key]:original,...(held==='other-effect'?{[`source-complete:${item}:unknown`]:{state:'started',execution_subject:item,error:'Other UNKNOWN effect'}}:{})};
    fs.writeFileSync(file,JSON.stringify({identity:gitProject(f.repo).identity,org:f.org,actions}));
    const pending=held==='active-command'?commandIntent(service.directory,{exe:'original-dispatch',args:[],cwd:f.repo,subject:item,key}):null;
    f.record(['close',item]);f.record(['reopen',item]);
    f.service().pass();assert.equal(f.calls.length,0,'a new reopen cannot bypass active/UNKNOWN command or other-effect ownership');
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).actions[key],original);
    if(pending){
      finishCommand(pending,{status:0,stdout:'original command completed'});forgetActiveCommand(pending);
      f.service().pass();assert.equal(f.calls.length,1,'the new input can start after the original terminal command receipt');
    }
  }
});
test('dispatch alias generations admit one later reopen while retaining same-input UNKNOWN and open-run fences',t=>{
  for(const alias of ['dispatch-recovered:original-digest','dispatch-preflight:original-token:original-key']){
    const f=fixture(t),item=f.add('Recovered work'),service=f.service(),file=path.join(service.directory,'effects.json');
    const input=`${f.show(item).created.seq}:ordinary`,original={state:'started',execution_subject:item,
      admission:{item,input},at:'2026-10-27T00:00:00Z',error:'Original UNKNOWN',receipt:{status:null,stdout:'saved receipt'}};
    fs.writeFileSync(file,JSON.stringify({identity:gitProject(f.repo).identity,org:f.org,actions:{[alias]:original}}));
    service.pass();assert.equal(f.calls.length,0,'same-generation alias remains held');
    f.record(['close',item]);f.record(['reopen',item]);
    f.service().pass();assert.equal(f.calls.length,1,'the next line pass admits the fresh generation');
    f.service().pass();assert.equal(f.calls.length,1,'restart cannot repeat the admitted input');
    transact(f.org,()=>({add:[{type:'run.started',id:'R-1',item,meta:{}},{type:'item.reopened',id:item}]}));
    f.service().pass();assert.equal(f.calls.length,1,'an open run still suppresses a newer reopen');
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).actions[alias],original);
    assert.ok(f.calls.every(c=>!c.args.includes('--retry')),'fresh work never replays the original alias');
  }
});
test('dispatch alias generations retain pending commands until their original terminal receipt',t=>{
  for(const alias of ['dispatch-recovered:original-digest','dispatch-preflight:original-token:original-key']){
    const f=fixture(t),item=f.add('Recovered fenced work'),service=f.service(),file=path.join(service.directory,'effects.json');
    const original={state:'started',execution_subject:item,admission:{item,input:`${f.show(item).created.seq}:ordinary`}};
    fs.writeFileSync(file,JSON.stringify({identity:gitProject(f.repo).identity,org:f.org,actions:{[alias]:original}}));
    const pending=commandIntent(service.directory,{exe:'original-dispatch',args:[],cwd:f.repo,subject:item,key:alias});
    f.record(['close',item]);f.record(['reopen',item]);
    f.service().pass();assert.equal(f.calls.length,0,'a later generation cannot bypass the original command');
    finishCommand(pending,{status:0,stdout:'original completed'});forgetActiveCommand(pending);
    f.service().pass();assert.equal(f.calls.length,1,'terminal command proof releases only the fresh generation');
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).actions[alias],original);
  }
});
test('dispatch alias generations keep missing foreign invalid and unrelated generation evidence held',t=>{
  for(const invalid of ['missing','foreign','invalid-reopen','unrelated']){
    const f=fixture(t),item=f.add('Unproven recovery'),service=f.service(),file=path.join(service.directory,'effects.json');
    const key=invalid==='unrelated'?`source-complete:${item}:unknown`:'dispatch-recovered:unproven-digest';
    const original={state:'started',execution_subject:item,...(invalid==='missing'?{}:
      {admission:{item:invalid==='foreign'?'ENG-999':item,input:`${f.show(item).created.seq}:ordinary${invalid==='invalid-reopen'?':reopened-999999':''}`}})};
    fs.writeFileSync(file,JSON.stringify({identity:gitProject(f.repo).identity,org:f.org,actions:{[key]:original}}));
    f.record(['close',item]);f.record(['reopen',item]);
    f.service().pass();assert.equal(f.calls.length,0,`${invalid} evidence cannot authorize a new dispatch`);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).actions[key],original);
  }
});
test('standing order changes the next native dispatch and skips held, reserved, dependent and unselected proposals',t=>{
  const f=fixture(t),a=f.add('Stable Brain',1),b=f.add('Rehearsal',9999),ready=f.add('Independent normal work',0);
  const goal=f.record(['add','Standing outcomes','--goal']).split(' ')[0];
  const setOrder=order=>f.record(['set',goal,`meta.queue_order=${JSON.stringify(order)}`]);
  setOrder(['stable','rehearsal']);
  f.record(['set',a,'meta.queue_class=stable']);f.record(['set',b,'meta.queue_class=rehearsal']);
  const held=f.add('Real hold',20000),reserved=f.add('Reserved',19000),dependent=f.add('Dependent',18000),proposal=f.add('Unselected record',17000);
  f.record(['set',held,'meta.hold=true','meta.queue_class=stable']);
  f.record(['set',reserved,'meta.operator_reserved=true','meta.queue_class=stable']);
  f.record(['block',dependent,'--by',held]);f.record(['set',dependent,'meta.queue_class=stable']);
  // Simulate normal report-proposal provenance without invoking intake.
  transact(f.org,()=>({add:[{type:'item.added',id:'ENG-900',kind:'work',role:'engineer',title:'Spawned proposal',from_run:'R-previous',priority:30000,meta:{queue_class:'stable'}},
    {type:'item.updated',id:proposal,fields:{meta:{queue_selected:false}}}]}));
  f.service({maxStarts:1}).pass();assert.equal(f.calls.at(-1).args[1],a);
  setOrder(['rehearsal','stable']);f.service({maxStarts:1}).pass();assert.equal(f.calls.at(-1).args[1],b);
  f.service({maxStarts:1}).pass();assert.equal(f.calls.at(-1).args[1],ready,'lower ready work is not gated by blocked higher outcomes');
  assert.ok(f.calls.every(c=>![held,reserved,dependent,proposal,'ENG-900'].includes(c.args[1])));
  f.record(['set','ENG-900','meta.queue_selected=true']);f.service({maxStarts:1}).pass();assert.equal(f.calls.at(-1).args[1],'ENG-900');
  const trace=fs.readFileSync(path.join(f.service().directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(trace.filter(r=>r.action==='queue-order').at(-1).policy.order,['rehearsal','stable']);
});
test('standing outcome selection does not launch a child of a held or reserved ancestor',t=>{
  const f=fixture(t),parent=f.add('Held ancestor'),child=f.add('Child',999,['--parent',parent]),ready=f.add('Independent');
  f.record(['set',parent,'meta.hold=true']);f.record(['set',child,'meta.queue_selected=true']);
  f.service().pass();assert.deepEqual(f.calls.map(c=>c.args[1]),[ready]);
  f.record(['set',parent,'meta.hold=false','meta.operator_reserved=true']);f.service().pass();assert.ok(!f.calls.some(c=>c.args[1]===child));
});

function selectedFormalCorrection(f) {
  const head=f.git(['rev-parse','HEAD']),key=`ENG-9000:${head}`,finding='review-finding/v1:admission-major';
  transact(f.org,()=>({add:[
    {type:'item.added',id:'ENG-9000',role:'engineer',title:'Original source'},
    {type:'run.started',id:'R-9000',item:'ENG-9000',workspace:f.repo},
    {type:'report.ingested',run:'R-9000',sha256:'author-report',report:{outcome:'done'}},
    {type:'item.closed',id:'ENG-9000',as:'done'},
    {type:'item.added',id:'REV-9000',role:'reviewer',title:'Completed review',meta:{review_key:key,review_source_item:'ENG-9000',review_source_run:'R-9000',review_target:{base:head,head},review_round_cap:1}},
    {type:'run.started',id:'R-9001',item:'REV-9000',workspace:f.repo},
    {type:'report.ingested',run:'R-9001',sha256:'review-report',report:{outcome:'done'}},
    {type:'item.added',id:'ENG-9001',role:'engineer',title:'Selected formal correction',parent:'REV-9000',from_run:'R-9001',meta:{queue_selected:true,review_fix_of:key,review_source_item:'ENG-9000',review_source_run:'R-9000',review_finding_keys:[finding]}},
    {type:'review.finding-linked',correction_item:'ENG-9001',finding_key:finding,finding:{severity:'major',text:'exact correction'},review_item:'REV-9000',review_run:'R-9001',source_item:'ENG-9000',head,base:head},
    {type:'item.added',id:'ENG-9002',role:'engineer',title:'Correction with no linked finding',parent:'REV-9000',from_run:'R-9001',meta:{queue_selected:true,review_fix_of:key,review_source_item:'ENG-9000',review_source_run:'R-9000'}},
    {type:'item.added',id:'ENG-9003',role:'engineer',title:'Ordinary review proposal',parent:'REV-9000',from_run:'R-9001',meta:{queue_selected:true}},
    {type:'item.closed',id:'REV-9000',as:'done'},
  ]}));
  return {head,finding};
}

test('line admission dispatches a selected formal correction beneath its completed review and observes it as eligible engineering',t=>{
  const f=fixture(t),{head}=selectedFormalCorrection(f),events=loadEvents(f.org).events,state=fold(events);
  const observation=haltObservation({state,events,org:f.org,identity:gitProject(f.repo).identity,config:{}});
  assert.deepEqual(observation.ready.toSorted(),['ENG-9001','ENG-9003'],'idle diagnosis uses the same typed correction exemption');
  f.service().pass();f.service().pass();
  assert.deepEqual(f.calls.map(c=>c.args[1]).toSorted(),['ENG-9001','ENG-9003'],'one dispatch each, with the unlinked correction still held');
  const args=f.calls.find(c=>c.args[1]==='ENG-9001').args;
  assert.equal(args[args.indexOf('--base')+1],head);
  assert.match(fs.readFileSync(args[args.indexOf('--brief')+1],'utf8'),/exact correction/);
  const after=loadEvents(f.org).events;
  assert.deepEqual(after.slice(0,events.length),events,'original evidence remains immutable');
  assert.equal(fold(after).items.get('REV-9000').closed.as,'done');
});

test('line admission rechecks the formal finding at its fresh effect boundary',t=>{
  const f=fixture(t),{head,finding}=selectedFormalCorrection(f);let changed=false;
  transact(f.org,()=>({add:[{type:'item.updated',id:'ENG-9003',fields:{meta:{queue_selected:false}}}]}));
  f.service({capacity:()=>{
    if(!changed){changed=true;transact(f.org,()=>({add:[{type:'review.finding-linked',correction_item:'ENG-9002',finding_key:finding,review_item:'REV-9000',review_run:'R-9001',source_item:'ENG-9000',head,base:head}]}));}
    return {count:0,cap:2};
  }}).pass();
  assert.equal(changed,true,'the correction reached ordinary capacity admission');
  assert.deepEqual(f.calls,[],'changed typed linkage refuses before native dispatch');
  const {directory}=f.service(),actions=JSON.parse(fs.readFileSync(path.join(directory,'effects.json'))).actions;
  assert.equal(Object.keys(actions).some(key=>key.startsWith('dispatch:ENG-9001:')),false,'readiness defers before spending an attempt');
  const rows=fs.readFileSync(path.join(directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(r=>r.action==='hold'&&r.boundary==='dispatch:ENG-9001'&&/readiness/.test(r.reason)));
});

for(const change of ['standing order','candidate class','inherited class','selection'])test(`admission defers ${change} changed during capacity without spending an effect`,t=>{
  const f=fixture(t),goal=f.record(['add','Standing outcomes','--goal']).split(' ')[0];
  f.record(['set',goal,'meta.queue_order=["stable","rehearsal"]','meta.queue_class=rehearsal']);
  const a=f.add('Old preferred candidate',1),b=f.add('New preferred candidate',999,change==='inherited class'?['--parent',goal]:[]);
  f.record(['set',a,'meta.queue_class=stable']);
  if(change!=='inherited class')f.record(['set',b,`meta.queue_class=${change==='selection'?'stable':'rehearsal'}`]);
  if(change==='selection')f.record(['set',b,'meta.queue_selected=false']);
  const held=f.add('Held',10000),reserved=f.add('Reserved',9000),uncertain=f.add('Uncertain launch',8000);
  f.record(['set',held,'meta.hold=true','meta.queue_class=stable']);
  f.record(['set',reserved,'meta.operator_reserved=true','meta.queue_class=stable']);
  const directory=f.service().directory,journal=path.join(directory,'effects.json'),key=`dispatch:${uncertain}:${f.show(uncertain).created.seq}:ordinary`;
  const original={state:'started',at:'2026-10-27T00:00:00Z',error:'native outcome UNKNOWN'};
  fs.writeFileSync(journal,JSON.stringify({identity:gitProject(f.repo).identity,org:f.org,actions:{[key]:original}}));
  let changed=false;
  const s=f.service({maxStarts:1,capacity:()=>{
    if(!changed){
      changed=true;
      if(change==='standing order')f.record(['set',goal,'meta.queue_order=["rehearsal","stable"]']);
      else if(change==='candidate class')f.record(['set',b,'meta.queue_class=stable']);
      else if(change==='inherited class')f.record(['set',goal,'meta.queue_class=stable']);
      else f.record(['set',b,'meta.queue_selected=true']);
    }
    return {count:0,cap:1};
  }});
  s.pass();assert.equal(changed,true);assert.equal(f.calls.length,0,'the stale candidate never launches');
  const actions=JSON.parse(fs.readFileSync(journal)).actions;
  assert.deepEqual(Object.keys(actions),[key],'a harmless selection change creates no failed dispatch effect');
  assert.deepEqual(actions[key].at,original.at);assert.equal(actions[key].state,'started');
  s.pass();assert.deepEqual(f.calls.map(c=>c.args[1]),[b],'the next pass recomputes the newly preferred eligible candidate');
  s.pass();assert.deepEqual(f.calls.map(c=>c.args[1]),[b,a],'the deferred candidate remains launchable later');
  assert.equal(JSON.parse(fs.readFileSync(journal)).actions[key].state,'started','the uncertain original remains occupied');
  const trace=fs.readFileSync(path.join(directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(trace.some(r=>r.action==='queue-selection-changed'&&r.stage==='after-capacity'&&r.item===a));
});
test('blocked and reserved work stays held while another READY item dispatches', t => {
  const f = fixture(t), blocker = f.add('Blocker'); const blocked = f.add('Blocked', 20);
  f.record(['block', blocked, '--by', blocker]); const reserved = f.add('Reserved', 30); f.record(['set', reserved, 'meta.operator_reserved=true']);
  const ready = f.add('Ready', 10); f.service().pass(); f.service().pass(); f.service().pass();
  assert.ok(f.calls.every(call => ![blocked, reserved].includes(call.args[1])));
  assert.equal(f.calls[0].args[1], ready); assert.equal(f.notes.length,0);const notices=Object.values(JSON.parse(fs.readFileSync(path.join(f.service().directory,'effects.json'))).record_notices);assert.ok(notices.some(n=>/reserved/.test(n.reason)&&n.count===1&&n.inspection_due===true));
});
test('STOP, HOLD and an incomplete tail prevent all effects', t => {
  const f = fixture(t); f.add('Ready'); const s = f.service();
  fs.writeFileSync(path.join(s.directory, 'STOP'), 'stop'); assert.match(s.pass().held, /STOP/); fs.unlinkSync(path.join(s.directory, 'STOP'));
  fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.lane/supervisor/HOLD'), 'hold'); assert.match(s.pass().held, /HOLD/);
  fs.unlinkSync(path.join(f.repo, '.lane/supervisor/HOLD')); fs.appendFileSync(path.join(f.org, 'events.jsonl'), '{'); assert.match(s.pass().held, /tail/);
  assert.equal(f.calls.length, 0);
});
test('wake closeout failure is durable before independent admission in the same invocation', t => {
  const f=fixture(t),ready=f.add('Independent ready work'),s=f.service({closeoutMeasure:()=>{}});
  const checkpoint=path.join(s.directory,'closeout-turn.json'),bytes='{';fs.writeFileSync(checkpoint,bytes);
  const audit=()=>fs.readFileSync(path.join(s.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  let launches=0;
  const wake=wakeLineService({service:s,launch:()=>{
    launches++;
    assert.equal(audit().filter(row=>row.action==='closeout-held').length,1,'failure is durable before admission');
    return s.pass();
  }});
  assert.equal(launches,1);assert.equal(wake.result,'line-wake-complete');assert.match(wake.closeout.held,/JSON/);
  assert.equal(wake.general.result,'pass-complete');assert.deepEqual(f.calls.map(call=>call.args[1]),[ready]);
  assert.equal(audit().filter(row=>row.action==='closeout-held'&&row.reason===wake.closeout.held).length,2,'wake and pass share error handling');
  assert.equal(fs.readFileSync(checkpoint,'utf8'),bytes,'failed closeout checkpoint stays unchanged');
});
test('wake closeout failure retains its original code and command receipt before considering admission', t => {
  const f=fixture(t),s=f.service({closeoutMeasure:()=>{}}),receipt={status:1,signal:null,stdout:'',stderr:'original native refusal',error:'EACCES'};
  let closeouts=0,launches=0;
  s.closeout=()=>{closeouts++;throw Object.assign(Error('closeout native refusal'),{code:'EACCES',receipt});};
  const wake=wakeLineService({service:s,launch:()=>{
    launches++;
    const rows=fs.readFileSync(path.join(s.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.filter(row=>row.action==='closeout-held').map(({at,...row})=>row),
      [{pid:process.pid,action:'closeout-held',reason:'closeout native refusal',code:'EACCES',receipt}]);
    return{considered:true};
  }});
  assert.equal(closeouts,1,'the refused closeout is not retried');assert.equal(launches,1);
  assert.deepEqual(wake.closeout,{held:'closeout native refusal',code:'EACCES',receipt});assert.equal(wake.general.considered,true);
});
for(const fence of ['STOP','HOLD','identity'])test(`wake closeout failure leaves the ${fence} admission fence effective`, t => {
  const f=fixture(t);f.add('Fenced ready work');let changed=false;
  const s=f.service({closeoutMeasure:()=>{},identify:repo=>{
    const project=gitProject(repo);return changed?{...project,identity:project.identity+'-foreign'}:project;
  }});
  if(fence==='identity')changed=true;
  else if(fence==='STOP')fs.writeFileSync(path.join(s.directory,'STOP'),'original stop');
  else{fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.repo,'.lane/supervisor/HOLD'),'original hold');}
  const wake=wakeLineService({service:s,launch:()=>s.pass()});
  assert.match(wake.general.held,fence==='identity'?/identity changed/:/STOP\/HOLD/);
  // A proving HOLD stops new work, not finished resource release; the closer
  // keeps its own effect fences. STOP and a changed identity hold closeout too.
  if(fence==='HOLD')assert.equal(wake.closeout.held,undefined);
  else assert.match(wake.closeout.held,fence==='identity'?/identity changed/:/^STOP prevents line closeout$/);
  assert.equal(f.calls.length,0);if(fence!=='HOLD')assert.equal(f.refreshes.length,0);
  const journal=path.join(s.directory,'effects.json');
  // A changed identity refuses before this project's journal is even opened.
  if(fence==='identity')assert.equal(fs.existsSync(journal),false);
  else assert.deepEqual(JSON.parse(fs.readFileSync(journal)).actions,{});
  const rows=fs.readFileSync(path.join(s.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(r=>r.action==='pass-held'&&r.reason===wake.general.held),'the refusal stays in the pass log');
});
test('wake closeout failure keeps an original native refusal while admitting independent work', t => {
  const f=fixture(t),refused=f.add('Refused own effect',20),s=f.service({closeoutMeasure:()=>{}});
  f.setFailure(JSON.stringify({error:{code:'EACCES',message:'original native refusal'}}));s.pass();
  const journal=path.join(s.directory,'effects.json'),actions=()=>JSON.parse(fs.readFileSync(journal)).actions;
  const key=Object.keys(actions()).find(key=>key.startsWith(`dispatch:${refused}:`)),original=actions()[key];
  assert.equal(original.state,'held');assert.equal(original.failure.kind,'fence');assert.equal(original.failure.code,'EACCES');
  f.setFailure(undefined);const ready=f.add('Independent eligible work');
  fs.writeFileSync(path.join(s.directory,'closeout-turn.json'),'{');
  const wake=wakeLineService({service:s,launch:()=>s.pass()});
  assert.match(wake.closeout.held,/JSON/);assert.equal(wake.general.result,'pass-complete');
  assert.deepEqual(f.calls.map(call=>call.args[1]),[refused,ready]);
  const {original_outcome,...retained}=actions()[key];
  assert.deepEqual(retained,original,'original refused effect and receipt stay immutable');
  assert.equal(original_outcome.status,'unknown','the existing readback does not invent a successful outcome');
});
test('a real command refusal is recorded once and never re-executed on restart', t => {
  const f = fixture(t); f.add('Ready'); f.setFailure('native permission refused'); const s = f.service(); s.pass(); f.service().pass(); f.service().pass();
  assert.equal(f.calls.length, 1);
  assert.equal(f.refreshes.length, 3, 'independent cleanup refresh remains allowed on every completed pass');
  const evidence = JSON.parse(fs.readFileSync(path.join(s.directory, 'effects.json'))); const action = Object.values(evidence.actions)[0];
  assert.equal(action.state, 'held'); assert.equal(action.receipt.status, 1); assert.match(action.error, /native permission/);
  assert.ok(f.notes.length <= 2);
});
for(const reply of ['lost','invalid','throw','detached','dispatched'])test(`a one-start pass charges a ${reply} dispatch reply and admits independent work only on a later pass`,t=>{
  const f=fixture(t),first=f.add('Original dispatch',20),next=f.add('Independent work',10),last=f.add('Later work');
  const command=(exe,args,options)=>{
    const result=f.command(exe,args,options);
    if(args[0]!==path.join(sourceRoot,'dispatch/dispatch.mjs')||args[1]!==first)return result;
    if(reply==='lost')return{status:1,stdout:'',stderr:'native prompt reply lost; outcome uncertain'};
    if(reply==='invalid')return{status:0,stdout:'incomplete reply {',stderr:''};
    if(reply==='throw')throw Error('original command reply missing; outcome UNKNOWN');
    return{status:0,stdout:JSON.stringify({result:reply,item:first}),stderr:''};
  };
  const service=()=>f.service({maxStarts:1,command}),s=service(),journal=path.join(s.directory,'effects.json');
  const actions=()=>JSON.parse(fs.readFileSync(journal)).actions;
  const rows=()=>fs.readFileSync(path.join(s.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  s.pass();assert.deepEqual(f.calls.map(c=>c.args[1]),[first],'one uncertain attempt exhausts this pass too');
  const key=Object.keys(actions()).find(k=>k.startsWith(`dispatch:${first}:`)),original=actions()[key];
  const held=['lost','invalid','throw'].includes(reply);
  assert.equal(original.state,held?'held':'complete');
  assert.equal(rows().findLast(r=>r.action==='pass-complete').starts,1);
  assert.deepEqual(rows().filter(r=>r.action==='admission-attempted').map(r=>r.item),[first]);
  assert.equal(rows().filter(r=>r.action==='admission-started').length,held?0:1);
  service().pass();assert.deepEqual(f.calls.map(c=>c.args[1]),[first,next],'a fresh allowance does not replay the original');
  const {original_outcome,...retained}=actions()[key];assert.deepEqual(retained,original,'original effect and receipts remain intact');
  service().pass();assert.deepEqual(f.calls.map(c=>c.args[1]),[first,next,last]);
  assert.deepEqual(rows().filter(r=>r.action==='pass-complete').map(r=>r.starts),[1,1,1]);
  t.diagnostic(JSON.stringify({reply,items:[first,next,last],attempts:rows().filter(r=>r.action==='admission-attempted'),original_state:original.state}));
});
for(const maxStarts of [0,2,undefined])test(`failed dispatches obey the ${maxStarts??'configured default'} start allowance`,t=>{
  const f=fixture(t),items=[f.add('First',30),f.add('Second',20),f.add('Third',10)];
  f.setFailure('native reply lost; outcome uncertain');
  const s=f.service({maxStarts});s.pass();
  const limit=maxStarts??2;
  assert.deepEqual(f.calls.map(c=>c.args[1]),items.slice(0,limit));
  const rows=fs.readFileSync(path.join(s.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.findLast(r=>r.action==='pass-complete').starts,limit);
});
test('unknown native capacity holds dispatch without spending an effect', t => {
  const f = fixture(t); f.add('Ready'); const s = f.service({ capacity: () => { throw Object.assign(Error('actual cap reached'), { code: 'DISPATCH_SESSION_CAP' }); } });
  s.pass(); assert.equal(f.calls.length, 0);
  f.service().pass(); assert.equal(f.calls.length, 1);
});
test('singleton rejects a concurrent pass without stealing its owner', t => {
  const f = fixture(t); f.add('Ready'); const s = f.service(), release = noticeLock(path.join(s.directory, 'pass.lock'));
  try { assert.throws(() => s.pass(), /locked/); assert.equal(f.calls.length, 0); } finally { release(); }
  s.pass(); assert.equal(f.calls.length, 1);
});
test('existing uncertain native review on any item run holds a second review', t => {
  const f = fixture(t), item = f.add('Code');
  const run = f.record(['start', item, '--workspace', f.repo]).match(/R-\d+/)[0];
  const events = loadEvents(f.org).events, identity = gitProject(f.repo).identity, current = fold(events).items.get(item);
  const directory = path.join(f.org, 'retirement/occupants'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'native.json'), JSON.stringify({ kind: 'settle', common: identity, run }));
  assert.equal(reviewAttempt(current, { org: f.org, identity, events }), 'existing native reviewer');
});
test('host recovery diagnostic deltas survive a fresh service object without changing record or fences',t=>{
  const f=fixture(t),service=f.service(),record=fs.readFileSync(path.join(f.org,'events.jsonl'));
  assert.ok(service.observeHostRecovery().some(n=>n.boundary==='login-registration'));
  service.observeHostRecovery();f.service().observeHostRecovery();
  const rows=()=>fs.readFileSync(path.join(service.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.action==='host-recovery-notice');
  assert.equal(rows().length,1);
  fs.writeFileSync(path.join(service.directory,'STOP'),'keep stopped');
  assert.ok(f.service().observeHostRecovery().some(n=>n.boundary==='fence'));
  assert.equal(rows().length,2);assert.equal(fs.readFileSync(path.join(service.directory,'STOP'),'utf8'),'keep stopped');
  assert.deepEqual(fs.readFileSync(path.join(f.org,'events.jsonl')),record);
});

test('launchd uses only actual transport paths, an explicit project and no caller identity', () => {
  const plist = launchPlist({ label: 'fixture', repo: '/project', org: '/record', to: 'supervisor-test', herdr: '/bin/herdr', socket: '/actual/socket', directory: '/record/service', node: '/node20', searchPath: '/bin', interval: 30 });
  assert.match(plist, /--once/); assert.match(plist, /StartInterval.*30/); assert.match(plist, /HERDR_SOCKET_PATH/);
  assert.doesNotMatch(plist, /HERDR_ENV|PANE_ID|SESSION_ID|THREAD_ID/);
  assert.ok(!plist.includes('KeepAlive')); assert.match(plist, /<string>\/project<\/string>/);
});

test('historical closed, retired and unclaimed reports do not recreate review debt or disturb a held review', t => {
  const f = fixture(t);
  const reported = (title, workspace, owned = false, outcome = 'done') => {
    const item = f.add(title), run = f.record(['start', item, '--workspace', workspace]).match(/R-\d+/)[0];
    if (owned) f.record(['claim', run, '--controller', 'brain']);
    const file = f.show(run).report_path;
    fs.writeFileSync(file, `---\nrun: ${run}\noutcome: ${outcome}\nsummary: Historical completed work.\nheadline: Historical work finished\nblockers: []\nproposals: []\nartifacts: []\n---\n`);
    f.record(['ingest', file]); return { item, run };
  };
  const old = reported('Old closed work', f.repo); f.record(['close', old.item]);
  const retired = path.join(f.repo, 'retired'); fs.mkdirSync(retired);
  const missing = reported('Retired work', retired, true); fs.rmSync(retired, { recursive: true });
  reported('Old unclaimed work', f.repo);
  const held = reported('Recent held async review', f.repo, true, 'blocked'), saved = path.join(f.org, 'settle', `${held.run}.json`);
  fs.mkdirSync(path.dirname(saved), { recursive: true }); const receipt = '{"stage":"reviewing","reason":"native refusal; preserve original attempt"}\n'; fs.writeFileSync(saved, receipt);
  const ready = f.add('Independent ready work', 9);
  f.service().pass(); f.service().pass();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args[1], ready);
  assert.equal(f.notes.length, 0); assert.equal(fs.readFileSync(saved, 'utf8'), receipt);
  assert.equal(f.show(missing.run).abandoned, null); assert.equal(f.show(held.item).closed, null);
});

test('source inventory includes line-service and its release controls while retaining runtime parity guard', t => {
  const f = fixture(t);
  for (const name of ['line-service', 'lib']) fs.mkdirSync(path.join(f.repo, name));
  fs.writeFileSync(path.join(f.repo, 'line-service/line-service.mjs'), 'export const service = true;\n');
  fs.writeFileSync(path.join(f.repo, 'lib/module.mjs'), 'export const guard = true;\n');
  f.git(['add', 'line-service', 'lib']); f.git(['commit', '-qm', 'Runtime fixture']);
  const captured = captureProductCheckout(f.repo);
  assert.ok(captured.runtime.includes('line-service/line-service.mjs'));
  assert.ok(tierFiles('release').includes('test/line-service.test.mjs'));
  fs.writeFileSync(path.join(f.repo, 'lib/.DS_Store'), 'Finder metadata');
  assert.throws(() => captureProductCheckout(f.repo), /source runtime inventory mismatch/);
  fs.unlinkSync(path.join(f.repo, 'lib/.DS_Store'));
  fs.writeFileSync(path.join(f.repo, 'lib/untracked-runtime.mjs'), 'export const extra = true;\n');
  assert.throws(() => captureProductCheckout(f.repo), /source runtime inventory mismatch/);
});

function completedSource(f) {
  fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '\n.org/\n.lane/\n');
  f.git(['add', '.lane.json']); f.git(['commit', '-qm', 'Committed fixture routing']);
  const item = f.add('Finished source'), run = f.record(['start', item, '--workspace', f.repo]).match(/R-\d+/)[0];
  f.record(['claim', run, '--controller', 'brain']);
  const file = f.show(run).report_path;
  fs.writeFileSync(file, `---\nrun: ${run}\noutcome: done\nsummary: The committed source is finished.\nheadline: The source is finished\nblockers: []\nproposals: []\nartifacts: []\n---\n`);
  f.record(['ingest', file]);
  const saved = path.join(f.org, 'settle', `${run}.json`), review = '{"stage":"reviewing","reason":"native review held; no retry"}\n';
  fs.mkdirSync(path.dirname(saved), { recursive: true }); fs.writeFileSync(saved, review);
  const command = (exe, args, options) => {
    f.calls.push({ exe, args, options });
    if (args[0] === path.join(sourceRoot, 'bin/org.mjs') && args[1] === 'close') {
      const directory = f.activeService.directory, effects = JSON.parse(fs.readFileSync(path.join(directory, 'effects.json')));
      assert.equal(Object.entries(effects.actions).find(([key]) => key.startsWith(`source-complete:${run}:`))?.[1].state, 'started');
      assert.equal(options.env.ORG_GUARD_OVERRIDE, undefined); assert.equal(options.env.ORG_ACTOR, 'line-service');
      return spawnSync(exe, args, options); // Real conditional record transaction, not an invented receipt.
    }
    return { status: 0, stdout: JSON.stringify({ result: 'dispatched' }), stderr: '' };
  };
  return { item, run, saved, review, command };
}

test('conditional source completion closes real done source while retaining review and physical holds', t => {
  const f = fixture(t), done = completedSource(f);
  fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE'), 'physical hold');
  const ready = f.add('Independent ready work', 9);
  f.activeService = f.service({ command: done.command, env: { ...f.env, ORG_GUARD_OVERRIDE: 'forbidden-inherited-override' } });
  f.activeService.pass(); f.activeService.pass();
  assert.equal(f.show(done.item).closed.as, 'done'); assert.equal(fs.readFileSync(done.saved, 'utf8'), done.review);
  assert.ok(fs.existsSync(path.join(f.repo, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE')));
  const closes = f.calls.filter(c => c.args[1] === 'close'); assert.equal(closes.length, 1);
  assert.deepEqual(closes[0].args.slice(1, 5), ['close', done.item, '--if-current-run', done.run]);
  assert.ok(f.calls.some(c => c.args[0].endsWith('/dispatch/dispatch.mjs') && c.args[1] === ready));
  const effects = JSON.parse(fs.readFileSync(path.join(f.activeService.directory, 'effects.json'))), entry = Object.entries(effects.actions).find(([key]) => key.startsWith(`source-complete:${done.run}:`))[1];
  assert.equal(entry.state, 'complete'); assert.equal(entry.result.close.status, 0); assert.equal(entry.result.report_sha256, f.show(done.run).report.sha256);
});

test('conditional source completion retains an exact needs-judgment refusal once and continues independent work', t => {
  const f = fixture(t), done = completedSource(f);
  f.record(['close', done.item, '--if-current-run', done.run]); f.record(['reopen', done.item]);
  const ready = f.add('Independent ready work', 9);
  f.activeService = f.service({ command: done.command,alertAfter:1 }); f.activeService.pass(); f.activeService.pass();
  assert.equal(f.show(done.item).closed, null); assert.equal(fs.readFileSync(done.saved, 'utf8'), done.review);
  const closes = f.calls.filter(c => c.args[1] === 'close'); assert.equal(closes.length, 1);
  assert.ok(closes[0].args.includes('--if-current-run'));
  const notes=Object.values(JSON.parse(fs.readFileSync(path.join(f.activeService.directory,'effects.json'))).record_notices).filter(n=>n.boundary.startsWith(`source-complete:${done.run}:`));
  assert.equal(notes.length,1);assert.match(notes[0].reason,/reopened after completion.*conditional close needs supervisor judgment/);assert.equal(f.notes.length,0);
  assert.ok(f.calls.some(c => c.args[0].endsWith('/dispatch/dispatch.mjs') && c.args[1] === ready));
  const effects = JSON.parse(fs.readFileSync(path.join(f.activeService.directory, 'effects.json'))), entry = Object.entries(effects.actions).find(([key]) => key.startsWith(`source-complete:${done.run}:`))[1];
  assert.equal(entry.state, 'held'); assert.notEqual(entry.receipt.status, 0); assert.match(entry.receipt.stderr, /supervisor judgment/);
});

test('producer linked source completion retains an old held effect without fabricating a landing and queues one defect',t=>{
  const f=fixture(t),done=completedSource(f);f.activeService=f.service({command:done.command});
  const run=f.show(done.run),directory=f.activeService.directory,file=path.join(directory,'effects.json'),key=`source-complete:${done.run}:${run.report.sha256}`;
  fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({at:'2026-10-27T00:00:00Z',repo:f.repo,org:f.org,source:sourceRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  fs.writeFileSync(file,JSON.stringify({identity:gitProject(f.repo).identity,org:f.org,actions:{[key]:{state:'held',at:'2026-10-26T00:00:00Z',error:'reported head was not integrated'}},notices:{}}));
  f.activeService.pass();f.activeService.pass();assert.equal(f.show(done.item).closed,null);
  const saved=JSON.parse(fs.readFileSync(file));assert.equal(saved.actions[key].state,'held');assert.equal(Object.keys(saved.outcome_decisions).length,1);
  assert.equal(f.calls.filter(c=>c.args[1]==='close').length,0);assert.equal(fs.readFileSync(done.saved,'utf8'),done.review);
});

for(const mode of [undefined,'process','shared'])test(`shared watch line choice ${mode??'default'} reaches ordinary dispatch`,t=>{
  const f=fixture(t),file=path.join(f.repo,'.lane.json'),config=JSON.parse(fs.readFileSync(file));
  if(mode)config.dispatch.watch_mode=mode;fs.writeFileSync(file,JSON.stringify(config));
  f.add('Selected shared work');let hosts=0;
  const command=(exe,args,options)=>{
    if(args[0]===path.join(sourceRoot,'watch/host.mjs')){hosts++;return{status:0,stdout:JSON.stringify({state:'ready'})};}
    return f.command(exe,args,options);
  };
  f.service({command}).pass();
  const dispatch=f.calls.find(c=>c.args[0]===path.join(sourceRoot,'dispatch/dispatch.mjs'));
  assert.ok(dispatch);assert.equal(dispatch.args[dispatch.args.indexOf('--watch-mode')+1],mode??'process');
  assert.equal(hosts,mode==='shared'?1:0);
});

test('shared watch missing binding stays pending, binds once, and releases after host recovery',t=>{
  const f=fixture(t),file=path.join(f.repo,'.lane.json'),config=JSON.parse(fs.readFileSync(file));
  config.dispatch.watch_mode='shared';fs.writeFileSync(file,JSON.stringify(config));f.add('Waiting for observer');
  let ready=false;const notices=[],commands=[];
  const command=(exe,args,options)=>{
    commands.push(args);
    if(args[0]===path.join(sourceRoot,'watch/host.mjs'))return{status:0,stdout:JSON.stringify(ready?{state:'ready'}:
      {id:'original-host',state:'held',code:'SHARED_OBSERVER_HELD',reason:'observer refused',evidence:'original-host.json'})};
    if(args[0]===path.join(sourceRoot,'supervisor/prompt-supervisor.mjs')){notices.push(args);return{status:3,stdout:JSON.stringify({queued:true,delivered:false,id:args[args.indexOf('--id')+1]})};}
    return f.command(exe,args,options);
  };
  const service=()=>f.service({command});service().pass();service().pass();
  const effects=()=>JSON.parse(fs.readFileSync(path.join(service().directory,'effects.json')));
  assert.equal(f.calls.length,0,'no dispatch or process fallback while shared host is held');assert.equal(notices.length,0);
  assert.equal(effects().shared_watch.code,'SHARED_OBSERVER_HELD');assert.equal(effects().shared_watch.owner,'project-supervisor');
  assert.equal(effects().shared_watch.notice.state,'pending');const id=effects().shared_watch.notice.id;
  assert.ok(commands.every(args=>args.every(value=>value!==null&&value!=='null')));
  assert.ok(Object.values(effects().record_notices).some(n=>n.scope.code==='SHARED_OBSERVER_HELD'&&n.inspection_due));
  f.env.MONITOR_SUPERVISOR_AGENT='supervisor-test';service().pass();service().pass();
  assert.equal(notices.length,1);assert.equal(notices[0][1],'supervisor-test');
  assert.ok(notices[0].includes('--project-supervisor'));assert.match(notices[0][2],/owner=project-supervisor/);
  assert.equal(effects().shared_watch.notice.id,id);assert.equal(effects().shared_watch.notice.state,'complete');
  const action=Object.values(effects().actions).find(a=>a.result?.id===id);assert.equal(action.state,'complete');
  ready=true;service().pass();assert.equal(f.calls.length,1);assert.equal(effects().shared_watch.state,'released');
  const released=effects().shared_watch.released_at;service().pass();assert.equal(effects().shared_watch.released_at,released);
});

for(const status of [3,1])test(`shared watch supervisor exit ${status} is retained without replay`,t=>{
  const f=fixture(t),file=path.join(f.repo,'.lane.json'),config=JSON.parse(fs.readFileSync(file));
  config.dispatch.watch_mode='shared';fs.writeFileSync(file,JSON.stringify(config));f.env.MONITOR_SUPERVISOR_AGENT='supervisor-test';
  let notices=0;
  const command=(exe,args,options)=>{
    if(args[0]===path.join(sourceRoot,'watch/host.mjs'))return{status:0,stdout:'{"id":"held","state":"held","reason":"observer refused"}'};
    if(args[0]===path.join(sourceRoot,'supervisor/prompt-supervisor.mjs')){notices++;return{status,stdout:JSON.stringify({queued:status===3,delivered:false,id:args[args.indexOf('--id')+1]})};}
    return f.command(exe,args,options);
  };
  const service=()=>f.service({command});service().pass();service().pass();
  const effects=JSON.parse(fs.readFileSync(path.join(service().directory,'effects.json')));
  assert.equal(notices,1);assert.equal(effects.shared_watch.notice.state,status===3?'complete':'held');
  const action=Object.entries(effects.actions).find(([key])=>key.startsWith('shared-observer-notice:'))[1];
  assert.equal(action.state,status===3?'complete':'held');
  if(status===1)assert.equal(action.receipt.status,1);
});

test('shared watch second host-command outage sends a new notice after recovery',t=>{
  const f=fixture(t),file=path.join(f.repo,'.lane.json'),config=JSON.parse(fs.readFileSync(file));
  config.dispatch.watch_mode='shared';fs.writeFileSync(file,JSON.stringify(config));f.env.MONITOR_SUPERVISOR_AGENT='supervisor-test';
  let ready=false;const notices=[];
  const command=(exe,args,options)=>{
    if(args[0]===path.join(sourceRoot,'watch/host.mjs'))return ready?{status:0,stdout:'{"state":"ready"}'}:{status:1,stderr:'host unavailable'};
    if(args[0]===path.join(sourceRoot,'supervisor/prompt-supervisor.mjs')){notices.push(args);return{status:3,stdout:JSON.stringify({queued:true,id:args[args.indexOf('--id')+1]})};}
    return f.command(exe,args,options);
  };
  const service=()=>f.service({command});service().pass();service().pass();assert.equal(notices.length,1);
  ready=true;service().pass();ready=false;service().pass();service().pass();
  assert.equal(notices.length,2);assert.notEqual(notices[0][notices[0].indexOf('--id')+1],notices[1][notices[1].indexOf('--id')+1]);
  const effects=JSON.parse(fs.readFileSync(path.join(service().directory,'effects.json')));
  assert.equal(effects.shared_watch.generation,1);assert.equal(effects.shared_watch.id,'host-command');
});

test('shared watch held saved duties notify without blocking selected process starts',t=>{
  const f=fixture(t),registry=path.join(f.org,'watch/shared');fs.mkdirSync(registry,{recursive:true});
  fs.writeFileSync(path.join(registry,'R-9.json'),'{}');f.add('Process work while old shared duty is held');
  f.env.MONITOR_SUPERVISOR_AGENT='supervisor-test';let notices=0;
  f.service({command:(exe,args,options)=>{
    if(args[0]===path.join(sourceRoot,'watch/host.mjs'))return{status:0,stdout:'{"id":"held","state":"held","reason":"observer refused"}'};
    if(args[0]===path.join(sourceRoot,'supervisor/prompt-supervisor.mjs')){notices++;return{status:3,stdout:JSON.stringify({queued:true,id:args[args.indexOf('--id')+1]})};}
    return f.command(exe,args,options);
  }}).pass();
  assert.equal(notices,1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].args[f.calls[0].args.indexOf('--watch-mode')+1],'process');
});

test('shared watch original registration failure retains role owner and pending notice without a binding',t=>{
  const f=fixture(t),item=f.add('Original shared registration failure'),service=f.service(),common=gitProject(f.repo).identity;
  const key=`dispatch:${item}:${f.show(item).created.seq}:ordinary`,journal=path.join(f.org,'dispatch/original-shared.json');
  fs.mkdirSync(path.dirname(journal),{recursive:true});
  fs.writeFileSync(journal,JSON.stringify({token:'original-shared',watchMode:'shared'}));
  const status={type:'dispatch.completed',project:common,journal,attempt:'original-shared',item,run:'R-1',stage:'watch',exit_code:1,
    failure:{code:'DISPATCH_FAILED',kind:'error',stage:'watch'}};
  transact(f.org,()=>({add:[status]}));
  const original={state:'held',original_outcome:{status:'dispatch-complete',journal,run:'R-1',producer:{attempt:'original-shared'}},recorded_dispatch_status:status};
  const file=path.join(service.directory,'effects.json');fs.writeFileSync(file,JSON.stringify({identity:common,org:f.org,actions:{[key]:original}}));
  service.pass();f.service().pass();
  const effects=JSON.parse(fs.readFileSync(file)),hold=effects.actions[key].shared_watch;
  assert.equal(hold.owner,'project-supervisor');assert.equal(hold.notice.state,'pending');assert.equal(hold.notice.id,'line-shared-watch:original-shared');
  assert.equal(hold.evidence,journal);assert.equal(f.calls.length,0);
  assert.ok(Object.values(effects.record_notices).some(n=>n.scope.item===item&&n.scope.owner==='project-supervisor'&&n.inspection_due));
  const bytes=fs.readFileSync(journal,'utf8'),notices=[];f.env.MONITOR_SUPERVISOR_AGENT='supervisor-test';
  const command=(exe,args,options)=>{
    if(args[0]===path.join(sourceRoot,'supervisor/prompt-supervisor.mjs')){notices.push(args);return{status:3,stdout:JSON.stringify({queued:true,id:args[args.indexOf('--id')+1]})};}
    return f.command(exe,args,options);
  };
  f.service({command}).pass();f.service({command}).pass();
  assert.equal(notices.length,1);assert.equal(notices[0][1],'supervisor-test');assert.ok(notices[0].includes('--project-supervisor'));
  assert.equal(JSON.parse(fs.readFileSync(file)).actions[key].shared_watch.notice.state,'complete');assert.equal(fs.readFileSync(journal,'utf8'),bytes);
});

test('shared watch invalid project choice holds instead of selecting process',t=>{
  const f=fixture(t),file=path.join(f.repo,'.lane.json'),config=JSON.parse(fs.readFileSync(file));
  config.dispatch.watch_mode='typo';fs.writeFileSync(file,JSON.stringify(config));f.add('Invalid observer choice');
  f.service().pass();assert.equal(f.calls.length,0);
});

function sharedLineFixture(t){
  const f=fixture(t),fleet=process.env.HERDR_MONITOR_FLEET;
  process.env.HERDR_MONITOR_FLEET=f.env.HERDR_MONITOR_FLEET=path.join(f.repo,'scratch-fleet');
  t.after(()=>{if(fleet===undefined)delete process.env.HERDR_MONITOR_FLEET;else process.env.HERDR_MONITOR_FLEET=fleet;});
  const policy=path.join(f.repo,'.lane.json'),config=JSON.parse(fs.readFileSync(policy));
  config.dispatch.watch_mode='shared';fs.writeFileSync(policy,JSON.stringify(config));
  return {...f,policy,config};
}

test('shared watch host command has one recoverable foreground receipt and retains a true UNKNOWN',t=>{
  const f=sharedLineFixture(t);let calls=0,original,bytes;
  const command=(exe,args,options)=>{
    if(args[0]!==path.join(sourceRoot,'watch/host.mjs'))return f.command(exe,args,options);
    calls++;original=options.commandReceipt;bytes=fs.readFileSync(original.file);
    const intent=JSON.parse(bytes);
    assert.equal(intent.subject,'shared-observer-host');assert.equal(intent.parent,undefined,'no caller-only line-operation parent');
    return {status:0,stdout:'{"state":"ready"}'};
  };
  const line=()=>f.service({command});line().pass();assert.equal(calls,1);
  // A completed helper whose dead caller never removed its marker is readable
  // on the next pass; the terminal result and original bytes are retained.
  const first=original,firstBytes=bytes,terminal=fs.readFileSync(first.receipt);fs.writeFileSync(first.file,firstBytes);
  line().pass();assert.equal(calls,2);assert.deepEqual(fs.readFileSync(first.receipt),terminal);assert.deepEqual(fs.readFileSync(first.file),firstBytes);
  const unresolved=commandIntent(line().directory,{exe:process.execPath,args:[path.join(sourceRoot,'watch/host.mjs'),'--repo',f.repo,'--org',f.org],
    cwd:f.repo,subject:'shared-observer-host',key:'shared-observer-host',stuck_owner:'project-supervisor'}),saved=fs.readFileSync(unresolved.file);
  line().pass();assert.equal(calls,2,'missing terminal evidence is not replay authority');assert.deepEqual(fs.readFileSync(unresolved.file),saved);
  const effects=readSchedulingJournal(path.join(line().directory,'effects.json'));
  assert.equal(effects.shared_watch.id,'unknown');assert.match(effects.shared_watch.reason,/command receipt/);
});

test('shared watch policy failure preserves the original outage until an observed recovery',t=>{
  const f=sharedLineFixture(t);f.env.MONITOR_SUPERVISOR_AGENT='supervisor-test';let ready=false,hosts=0,notices=0;
  const command=(exe,args,options)=>{
    if(args[0]===path.join(sourceRoot,'watch/host.mjs')){hosts++;return{status:0,stdout:JSON.stringify(ready?{state:'ready'}:{id:'outage',state:'held',reason:'original host outage'})};}
    if(args[0]===path.join(sourceRoot,'supervisor/prompt-supervisor.mjs')){notices++;return{status:3,stdout:JSON.stringify({queued:true,id:args[args.indexOf('--id')+1]})};}
    return f.command(exe,args,options);
  };
  const line=()=>f.service({command}),effects=()=>readSchedulingJournal(path.join(line().directory,'effects.json'));
  line().pass();const original=effects().shared_watch;assert.equal(notices,1);
  fs.writeFileSync(f.policy,JSON.stringify({...f.config,dispatch:{...f.config.dispatch,watch_mode:'invalid'}}));
  line().pass();assert.equal(hosts,1);assert.deepEqual(effects().shared_watch,original);
  fs.writeFileSync(f.policy,JSON.stringify(f.config));line().pass();assert.equal(notices,1);assert.equal(effects().shared_watch.generation,original.generation);
  ready=true;line().pass();assert.equal(effects().shared_watch.state,'released');
});

test('shared watch saved duties keep their observer when the new-start choice is process',t=>{
  const f=fixture(t),registry=path.join(f.org,'watch/shared');fs.mkdirSync(registry,{recursive:true});
  fs.writeFileSync(path.join(registry,'R-9.json'),'{}');f.add('Deliberate process choice');let hosts=0;
  f.service({command:(exe,args,options)=>{
    if(args[0]===path.join(sourceRoot,'watch/host.mjs')){hosts++;return{status:0,stdout:'{"state":"ready"}'};}
    return f.command(exe,args,options);
  }}).pass();
  assert.equal(hosts,1);const call=f.calls.find(c=>c.args[0]===path.join(sourceRoot,'dispatch/dispatch.mjs'));
  assert.equal(call.args[call.args.indexOf('--watch-mode')+1],'process');
});
