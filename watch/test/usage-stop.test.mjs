import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from '../../test/helpers/bounded-test.mjs';
import {brainOwner} from '../../lib/run-owner.mjs';
import {transact} from '../../lib/store.mjs';
import {classifyUsageStop,reconcileUsageStop,usageStopFile} from '../usage-stop.mjs';
import {noReportNotice} from '../notice.mjs';

const reset='2026-11-01T14:20:00Z';
const limit=`■ You've hit your usage limit. Visit settings or try again at ${reset}.`;
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'usage-stop-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
  git(['init','-b','main']);
  git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-m','unlanded worker commit']);
  const head=git(['rev-parse','HEAD']),org=path.join(root,'.org'),identity=git(['rev-parse','--absolute-git-dir']);
  const owner=brainOwner(),ownership={owner,generation:3};
  const native={name:'worker',pane_id:'pane',workspace_id:'workspace',terminal_id:'terminal',
    agent_session:{value:'original-session'},cwd:root,agent:'codex',agent_status:'done'};
  const current={id:'R-1',item:'ENG-1',workspace:root,report_path:path.join(root,'report.md'),meta:{
    agent:native.name,pane:native.pane_id,worker_workspace:native.workspace_id,terminal_id:native.terminal_id,
    agent_session_id:native.agent_session.value,dispatch_project:identity,dispatch_record:org,
    dispatch_attempt:'original',dispatch_journal:path.join(org,'dispatch.json')}};
  fs.mkdirSync(org);
  fs.writeFileSync(path.join(org,'events.jsonl'),'');
  const add=events=>transact(org,()=>({add:events}),{actor:'fixture'});
  add([{type:'item.added',id:'ENG-1',role:'engineer',title:'Usage recovery'},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace:root,report_path:current.report_path,meta:current.meta},
    {type:'run.claimed',run:'R-1',project:identity,record:org,owner}]);
  fs.writeFileSync(path.join(root,'unsaved.txt'),'preserve me');
  let screen=limit,clock=Date.parse(reset)-10000,prompts=0,reads=0,input='delivered',hook=()=>{};
  const box=['\x1b[48;5;234m \x1b[0m','\x1b[48;5;234m\x1b[1m› \x1b[2mAsk Codex to do anything\x1b[0m',
    '\x1b[48;5;234m \x1b[0m',`GPT · ${root}`].join('\n');
  const call=(_command,args)=>{
    hook(args);
    if(args[0]==='pane') {reads++;return `${screen}\n\n${box}`;}
    if(args[1]==='get')return JSON.stringify({result:{agent:native}});
    if(args[1]==='prompt'){
      prompts++;
      const saved=JSON.parse(fs.readFileSync(usageStopFile(org,'R-1')));
      assert.equal(saved.phase,'offering','durable intent precedes input');
      assert.match(args[3],/Continue the existing run R-1/);
      if(input==='uncertain')throw Error('lost input acknowledgement');
      if(input==='refused')return JSON.stringify({error:{code:'agent_blocked'}});
      return JSON.stringify({result:{}});
    }
    throw Error(`unexpected native call ${args}`);
  };
  const options={org,current,ownership,canonical:root,native,herdr:'fixture-herdr',call,now:()=>clock,confirmSeconds:0};
  return {root,org,git,head,native,current,owner,ownership,add,options,
    reconcile:()=>reconcileUsageStop(options),saved:()=>JSON.parse(fs.readFileSync(usageStopFile(org,'R-1'))),
    setScreen:value=>{screen=value;},setClock:value=>{clock=value;},setInput:value=>{input=value;},
    setHook:value=>{hook=value;},prompts:()=>prompts,reads:()=>reads};
}

test('usage stop recognizes native wording variants and holds ambiguous reset times',()=>{
  for(const text of [limit,`■ Account quota reached; resets at ${reset}.`,
    `■ Rate limit exceeded. Try again at ${reset}.`,`■ Insufficient credits; try again at ${reset}.`]){
    const observed=classifyUsageStop(text);
    assert.equal(observed.kind,'usage-limit',text);assert.equal(observed.reset_at,'2026-11-01T14:20:00.000Z');
  }
  assert.equal(classifyUsageStop('■ You’ve hit your usage limit. Try again at Nov 4th, 2026 12:36 AM.').kind,'usage-limit');
  for(const text of ['■ Usage limit reached; try again later.','■ Usage limit reached; resets at 2:20 PM.'])
    assert.equal(classifyUsageStop(text).reset_at,null);
  for(const text of ['A quoted usage limit in source','■ Disk full',`${limit}\n\n• A later assistant turn finished`])
    assert.equal(classifyUsageStop(text).kind,'unclassified-stop');
  assert.match(noReportNotice({run:'R-1',state:'done'}),/stop=unclassified reset=unknown/);
});

test('usage stop waits for reset then resumes exactly once across watcher restarts preserving source',async t=>{
  const f=fixture(t);
  let result=await f.reconcile();
  assert.equal(result.handled,true);assert.equal(f.prompts(),0);assert.equal(f.saved().phase,'held');
  assert.equal(f.saved().reset_at,'2026-11-01T14:20:00.000Z');assert.ok(result.wait_ms<=30000);
  f.setClock(Date.parse(reset)+1000);
  result=await f.reconcile();assert.equal(result.receipt.phase,'delivered');assert.equal(f.prompts(),1);
  await f.reconcile();assert.equal(f.prompts(),1);
  assert.equal(f.git(['rev-parse','HEAD']),f.head);
  assert.equal(fs.readFileSync(path.join(f.root,'unsaved.txt'),'utf8'),'preserve me');
  assert.equal(f.saved().ownership.generation,3);assert.equal(f.saved().binding.session,'original-session');
});

test('usage stop never prompts a working, changed or busy worker and recovers after quiet',async t=>{
  const f=fixture(t);f.setClock(Date.parse(reset)+1000);
  f.native.agent_status='working';await f.reconcile();assert.equal(f.reads(),0);
  f.native.agent_status='done';f.native.agent_session.value='replacement';await f.reconcile();assert.equal(f.reads(),0);
  f.native.agent_session.value='original-session';f.native.interactive_ready=false;
  await f.reconcile();assert.equal(f.prompts(),0);assert.equal(f.saved().phase,'held');
  f.native.interactive_ready=true;await f.reconcile();assert.equal(f.prompts(),1);
});

for(const input of ['refused','uncertain'])test(`usage stop retains ${input} input without replay`,async t=>{
  const f=fixture(t);f.setClock(Date.parse(reset)+1000);f.setInput(input);
  await f.reconcile();assert.equal(f.saved().phase,input);assert.equal(f.prompts(),1);
  await f.reconcile();assert.equal(f.prompts(),1);
});

test('usage stop retains a pre-crash offering and admits a new attempt only after observed work',async t=>{
  const f=fixture(t);await f.reconcile();
  const file=usageStopFile(f.org,'R-1');fs.writeFileSync(file,JSON.stringify({...f.saved(),phase:'offering'}));
  f.setClock(Date.parse(reset)+1000);await f.reconcile();assert.equal(f.prompts(),0);
  f.native.agent_status='working';await f.reconcile();assert.equal(f.saved().phase,'working');
  f.native.agent_status='done';await f.reconcile();assert.equal(f.prompts(),1);assert.equal(f.saved().attempt,1);
});

test('usage stop surfaces unknown reasons and unreadable screens without speculative input',async t=>{
  const f=fixture(t);f.setClock(Date.parse(reset)+1000);
  f.setScreen('■ New unfamiliar native stop');
  let result=await f.reconcile();assert.equal(result.handled,false);assert.equal(f.saved().kind,'unclassified-stop');
  f.setScreen('■ Usage limit reached; reset time unavailable');
  result=await f.reconcile();assert.equal(result.handled,true);assert.equal(f.saved().reset_at,null);
  f.setHook(args=>{if(args[0]==='pane')throw Error('screen unavailable');});
  result=await f.reconcile();assert.equal(result.handled,false);assert.match(f.saved().reason,/screen unavailable/);
  assert.equal(f.prompts(),0);
});

for(const hold of ['STOP','HOLD','org-STOP','report','closed','item-hold','source','claim'])
test(`usage stop fresh ${hold} fence prevents input`,async t=>{
  const f=fixture(t);f.setClock(Date.parse(reset)+1000);
  if(['STOP','HOLD'].includes(hold)){
    fs.mkdirSync(path.join(f.root,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.root,'.lane/supervisor',hold),'held');
  }else if(hold==='org-STOP')fs.writeFileSync(path.join(f.org,'STOP'),'held');
  else if(hold==='report')fs.writeFileSync(f.current.report_path,'partial report');
  else if(hold==='closed')f.add([{type:'item.closed',id:'ENG-1'}]);
  else if(hold==='item-hold')f.add([{type:'item.updated',id:'ENG-1',fields:{meta:{hold:'held'}}}]);
  else if(hold==='source')f.add([{type:'run.updated',id:'R-1',meta:{dispatch_attempt:'changed'}}]);
  else f.add([{type:'run.claimed',run:'R-1',project:f.git(['rev-parse','--absolute-git-dir']),record:f.org,owner:f.owner}]);
  if(hold==='claim')await assert.rejects(f.reconcile(),/OWNED_ELSEWHERE/);
  else {await f.reconcile();assert.equal(f.saved().phase,'held');}
  assert.equal(f.prompts(),0);
});

test('usage stop rechecks fences during quiet confirmation without replaying an uncertain intent',async t=>{
  const f=fixture(t);f.setClock(Date.parse(reset)+1000);
  let reads=0;f.setHook(args=>{
    if(args[0]==='pane'&&++reads===3){fs.mkdirSync(path.join(f.root,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.root,'.lane/supervisor/HOLD'),'held');}
  });
  await f.reconcile();assert.equal(f.prompts(),0);assert.equal(f.saved().phase,'uncertain');
  fs.rmSync(path.join(f.root,'.lane/supervisor/HOLD'));await f.reconcile();assert.equal(f.prompts(),0);
});
