import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {sessionBindFact} from './helpers/session-bind.mjs';
import {fold,itemStatus} from '../lib/state.mjs';
import {workerReceipt} from '../lib/worker-identity.mjs';
import {appendTiming,timingJournal} from '../lib/run-timing.mjs';
import {disposeStoppedAllocations,pendingEndedAllocation} from '../lib/closeout-allocations.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {gitProject} from '../lib/project.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const f=setup(t,{direct:true,bound:false,merged:true});selectCurrentCleanup(f);
  const journal=path.join(f.org,'dispatch/attempt.json'),report=path.join(f.org,'runs/R-1/report.md');
  fs.mkdirSync(path.dirname(journal),{recursive:true});fs.mkdirSync(path.dirname(report),{recursive:true});
  fs.writeFileSync(f.eventFile,JSON.stringify({type:'item.added',id:'ENG-1',role:'engineer',title:'Binding-gated work',seq:1,at:new Date().toISOString()})+'\n');
  const worker={agentName:'worker',pane:'w:p',workspaceId:'w',agentSessionId:'session',terminalId:'term',cwd:f.lane};
  f.append([{type:'run.started',id:'R-1',item:'ENG-1',workspace:f.lane,report_path:report,
    meta:{lane:'topic',dispatch_journal:journal,dispatch_attempt:'attempt',dispatch_project:f.common,dispatch_record:f.org}},
  {type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner:{controller:'brain',legacy:false,
    release:{id:'source',root:process.cwd(),commit:null,identity:f.common}}},
  {type:'run.updated',id:'R-1',meta:{agent:'worker',pane:'w:p',worker_workspace:'w',terminal_id:'term',agent_session_id:'session'}}]);
  const state=fold(events(f)),run=state.runs.get('R-1'),start=Date.parse(run.started.at)+1000;
  const job={token:'attempt',repo:f.repo,common:f.common,org:f.org,lane:'topic',workspace:f.lane,base:f.head,item:'ENG-1',run:'R-1',
    ownership:{owner:run.owner,generation:run.owner_generation},worker,launchProcess:{pid:2,identity:'native'},
    workerSessionWaitProtocol:2,stage:'complete',native_launch_attempted:true,
    sessionBinding:{status:'unbound',process:{pid:2,identity:'native'},receipt:workerReceipt(run,state),
      prompted_at:new Date(start).toISOString(),deadline:new Date(start+60000).toISOString(),
      reason:'native session observation deadline expired'}};
  const end={at:new Date(start+61000).toISOString(),run:'R-1',item:'ENG-1',lane:'topic',kind:'process_end',outcome:'done'};
  appendTiming(journal,end);f.append([{type:'run.updated',id:'R-1',meta:{process_end:JSON.stringify(end)}}]);
  f.state.agents[0].agent_status='done';f.save();
  const complete=()=>{
    fs.writeFileSync(journal,JSON.stringify(job)+'\n');
    f.append([{type:'dispatch.completed',project:f.common,journal,attempt:'attempt',item:'ENG-1',run:'R-1',stage:job.stage,
      exit_code:job.stage==='complete'?0:1,native_launch_attempted:true,failure:job.failure??null,request_sha256:sha(fs.readFileSync(journal))}]);
  };
  complete();
  const dispose=()=>disposeStoppedAllocations({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
  let allocationCalls=0;
  const turn=()=>runCloseoutTurn({project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},
    cli:(_file,args)=>{
      if(args[0]==='allocations'){allocationCalls++;return JSON.stringify(dispose());}
      if(args[0]==='refresh')return '{}';
      return JSON.stringify(f.drain({keys:JSON.parse(args[args.indexOf('--keys')+1]),retrySafe:true}));
    }});
  const pending=()=>pendingEndedAllocation(gitProject(f.repo),f.org,events(f),fold(events(f)));
  return{...f,journal,report,job,end,complete,dispose,turn,pending,allocationCalls:()=>allocationCalls};
}

test('one finite turn abandons an ended unbound gate-wait run and releases its original session and clean folder',t=>{
  const f=fixture(t),original=fs.readFileSync(f.eventFile),bytes=fs.readFileSync(f.journal),timing=fs.readFileSync(timingJournal(f.journal));
  const result=f.turn();assert.deepEqual(result.errors,[]);assert.equal(result.steps,1);
  const all=events(f),state=fold(all),abandoned=all.find(e=>e.type==='run.abandoned'&&e.id==='R-1');
  assert.equal(abandoned.authorization.kind,'positive-unbound-ended-allocation');
  assert.equal(abandoned.authorization.proof.missing_session_binding,true);
  assert.deepEqual(abandoned.authorization.proof.process_end.event,f.end);
  assert.equal(abandoned.producer.request_sha256,sha(bytes));assert.equal(itemStatus(state,'ENG-1'),'ready');
  assert.equal(fs.existsSync(f.lane),false);assert.equal(f.git(['branch','--list','lane/topic']),'');
  assert.deepEqual(f.read().agents,[]);assert.ok(all.some(e=>e.type==='closeout.evaluated'&&e.completed));
  assert.equal(all.some(e=>e.type==='run.session_bound'),false);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,original.length),original);
  assert.deepEqual(fs.readFileSync(f.journal),bytes);assert.deepEqual(fs.readFileSync(timingJournal(f.journal)),timing);
  assert.deepEqual(f.dispose().results,[],'original attempt is finalized once');
});

test('launch-time binding timeout before prompt delivery uses the same guarded abandonment',t=>{
  const f=fixture(t);Object.assign(f.job,{stage:'prompt',launchSessionBindProtocol:1,
    error:'original launch session binding is unbound; prompt not sent',failure:{kind:'unknown',stage:'prompt',native_launch_attempted:true}});f.complete();
  assert.equal(f.dispose().results[0].disposition,'UNBOUND_ENDED');
  assert.ok(fold(events(f)).runs.get('R-1').abandoned);
});

test('a fully absent ended worker releases its clean folder without inventing a native close',t=>{
  const f=fixture(t);f.state.agents=[];f.state.panes=[];f.state.tabs=[];f.save();
  const result=f.turn();assert.deepEqual(result.errors,[]);assert.equal(fs.existsSync(f.lane),false);
  assert.equal(events(f).find(e=>e.type==='run.abandoned').authorization.proof.status,'gone');
  assert.deepEqual(f.read().actions.filter(a=>['agent','tab'].includes(a[0])),[]);
});

for(const kind of ['observation-failed','continuity-unavailable'])test(`non-deadline ${kind} releases an ended unbound worker in one turn`,t=>{
  const f=fixture(t);
  f.job.sessionBinding.reason=kind==='observation-failed'?'native session observation failed: temporary transport error':
    'native process continuity unavailable at launch';
  if(kind==='continuity-unavailable'){
    f.job.launchProcess=null;f.job.sessionBinding.process=null;
    f.state.agents=[];f.state.panes=[];f.state.tabs=[];f.save();
  }
  const end={...f.end,at:new Date(Date.parse(f.job.sessionBinding.prompted_at)+10000).toISOString()};
  appendTiming(f.journal,end);f.append([{type:'run.updated',id:'R-1',meta:{process_end:JSON.stringify(end)}}]);f.complete();
  assert.equal(f.pending(),true);
  const bytes=fs.readFileSync(f.journal),timing=fs.readFileSync(timingJournal(f.journal)),result=f.turn();
  assert.deepEqual(result.errors,[]);assert.equal(f.allocationCalls(),1);assert.equal(fs.existsSync(f.lane),false);
  const proof=events(f).find(e=>e.type==='run.abandoned').authorization.proof;
  assert.deepEqual(proof.process_end.event,end);assert.equal(proof.binding.reason,f.job.sessionBinding.reason);
  assert.equal(events(f).some(e=>e.type==='run.session_bound'),false);
  assert.deepEqual(fs.readFileSync(f.journal),bytes);assert.deepEqual(fs.readFileSync(timingJournal(f.journal)),timing);
});

test('retained ended allocation retries periodically without per-turn attempt growth and recovers when clean',t=>{
  const f=fixture(t),dirty=path.join(f.lane,'unsaved');fs.writeFileSync(dirty,'retain');
  assert.equal(f.pending(),true);f.turn();assert.equal(f.allocationCalls(),1);
  const attempts=()=>events(f).filter(e=>e.type==='closeout.allocation-attempted');
  assert.equal(attempts().length,1);assert.equal(f.pending(),false);
  const calls=f.herdrCalls();
  f.turn();f.turn();assert.equal(f.allocationCalls(),1);assert.equal(attempts().length,1);
  assert.deepEqual(f.herdrCalls(),calls,'intervening turns do not repeat native inventory');
  assert.equal(fold(events(f)).runs.get('R-1').abandoned,null);
  fs.unlinkSync(dirty);
  const result=f.turn();assert.deepEqual(result.errors,[]);assert.equal(f.allocationCalls(),2);
  assert.ok(fold(events(f)).runs.get('R-1').abandoned);assert.equal(fs.existsSync(f.lane),false);
});

for(const kind of ['working','birth'])test(`retained ${kind} allocation leaves intervening turns quiet`,t=>{
  const f=fixture(t);
  if(kind==='working')f.state.agents[0].agent_status='working';else f.state.info.process_tree[1].identity='other';
  f.save();f.turn();assert.equal(f.allocationCalls(),1);assert.equal(f.pending(),false);
  const before=events(f).filter(e=>e.type==='closeout.allocation-attempted').length,calls=f.herdrCalls();
  f.turn();assert.equal(f.allocationCalls(),1);assert.equal(events(f).filter(e=>e.type==='closeout.allocation-attempted').length,before);
  assert.deepEqual(f.herdrCalls(),calls);assert.equal(fold(events(f)).runs.get('R-1').abandoned,null);
});

for(const kind of ['no-protocol','report','proposed','changed','observation-refusal','unknown-reason','receipt','completion-CAS','unavailable-occupied',
  'unavailable-with-process','failure-before-observation'])test(`allocation priority rejects ${kind}`,t=>{
  const f=fixture(t);
  if(kind==='no-protocol')delete f.job.workerSessionWaitProtocol;
  if(kind==='report')fs.writeFileSync(f.report,'pending report');
  if(kind==='proposed')f.job.sessionBinding.proposed={type:'run.session_bound'};
  if(kind==='changed')f.job.sessionBinding.reason='native process changed';
  if(kind==='observation-refusal')f.job.sessionBinding.reason='native session observation failed: EPERM';
  if(kind==='unknown-reason')f.job.sessionBinding.reason='unknown observation outcome';
  if(kind==='receipt')f.job.sessionBinding.receipt.seq++;
  if(kind.startsWith('unavailable')){
    f.job.sessionBinding.reason='native process continuity unavailable at launch';
    if(kind==='unavailable-occupied'){f.job.launchProcess=null;f.job.sessionBinding.process=null;}
  }
  if(kind==='failure-before-observation'){
    f.job.sessionBinding.reason='native session observation failed: transport error';
    const end={...f.end,at:new Date(Date.parse(f.job.sessionBinding.prompted_at)-1).toISOString()};
    appendTiming(f.journal,end);f.append([{type:'run.updated',id:'R-1',meta:{process_end:JSON.stringify(end)}}]);
  }
  f.complete();if(kind==='completion-CAS')fs.appendFileSync(f.journal,' ');
  // Occupied/no-continuity admission is deliberately deferred to fresh native
  // inventory; all other failures can be rejected by the read-only predicate.
  if(kind!=='unavailable-occupied')assert.equal(f.pending(),false);
  f.turn();assert.equal(f.allocationCalls(),kind==='unavailable-occupied'?1:0);
  assert.equal(fold(events(f)).runs.get('R-1').abandoned,null);assert.ok(fs.existsSync(f.lane));
  if(kind==='unavailable-occupied')assert.equal(f.pending(),false);
});

for(const kind of ['bound-slow','bound-ended','proposed','commit-unknown','record-refusal','prompting','no-protocol','resume',
  'no-end','idle-end','early-end','wrong-end','missing-timing','binding-receipt','process','working','birth','replacement','dirty','report',
  'native-refusal','claim','journal-CAS','request-live','HOLD'])test(`ended unbound finality preserves ${kind}`,t=>{
  const f=fixture(t);
  if(kind.startsWith('bound')){
    const s=fold(events(f));f.append([sessionBindFact(s.runs.get('R-1'),s)]);
    if(kind==='bound-slow'){f.state.agents[0].agent_status='working';f.save();}
  }
  if(kind==='proposed')f.job.sessionBinding.proposed={type:'run.session_bound',run:'R-1'};
  if(kind==='commit-unknown')f.job.sessionBinding.commit_attempts=[{outcome:'unknown'}];
  if(kind==='record-refusal')f.job.sessionBinding.record_refusal=true;
  if(kind==='prompting')f.job.stage='prompting';
  if(kind==='no-protocol')delete f.job.workerSessionWaitProtocol;
  if(kind==='resume')f.job.resumeSession='saved';
  if(['no-end','idle-end','early-end','wrong-end'].includes(kind)){
    const end={...f.end,...(kind==='idle-end'?{outcome:'idle'}:kind==='early-end'?{at:f.job.sessionBinding.prompted_at}:kind==='wrong-end'?{run:'R-2'}:{})};
    f.append([{type:'run.updated',id:'R-1',meta:{process_end:kind==='no-end'?null:JSON.stringify(end)}}]);
  }
  if(kind==='missing-timing')fs.unlinkSync(timingJournal(f.journal));
  if(kind==='binding-receipt')f.job.sessionBinding.receipt.seq++;
  if(kind==='process')f.job.sessionBinding.process.identity='other';
  if(kind==='working'){f.state.agents[0].agent_status='working';f.save();}
  if(kind==='birth'){f.state.info.process_tree[1].identity='other';f.save();}
  if(kind==='replacement'){f.state.agents[0].terminal_id='other';f.save();}
  if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'unsaved'),'retain');
  if(kind==='report')fs.writeFileSync(f.report,'pending report bytes');
  if(kind==='native-refusal'){f.job.failure={kind:'fence',stage:'complete'};f.job.error='EPERM native refusal';}
  if(kind==='claim')f.append([{type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner:{controller:'foreign',legacy:true}}]);
  if(kind==='request-live')fs.writeFileSync(f.journal+'.lock',String(process.pid));
  if(kind==='HOLD')fs.mkdirSync(path.join(f.repo,'.lane/supervisor/HOLD'),{recursive:true});
  f.complete();if(kind==='journal-CAS')fs.appendFileSync(f.journal,' ');
  const before=fs.readFileSync(f.eventFile),bytes=fs.readFileSync(f.journal);
  if(kind==='HOLD')assert.throws(f.dispose,/STOP\/HOLD/);else f.dispose();
  assert.equal(fold(events(f)).runs.get('R-1').abandoned,null);assert.ok(fs.existsSync(f.lane));
  assert.deepEqual(f.read().actions,[]);assert.deepEqual(fs.readFileSync(f.journal),bytes);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
});
