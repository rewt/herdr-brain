import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {legacyNeverSentProof,recoverNeverStartedCloseouts} from '../lib/closeout-unsent.mjs';
import {closeoutNextStage} from '../lib/closeout-status.mjs';
import {readCloseoutEntries,unresolvedCloseoutEffect,CLOSEOUT_EXIT_PENDING} from '../lib/closeout.mjs';
import {events,setup,effects,retainNativeOutcome} from './helpers/closeout-fixture.mjs';
import {hold} from './helpers/retire-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {recordSourceConflict} from '../lib/record-observation.mjs';

const producer='291c4da2e2dfecda82c8626588ae841d7cc21a28';
const graph='4c077ad48f13c6b2d7ae2afaa439589547dda558b6773c9ef696fa6222c5c825';
const replacement='b514f744b935e99b0d107ae2b14b47af57b174bd';
function historical(entry,intent){
  const code={kind:'checkout',root:entry.project,common:entry.common,graph:'closer-imports/v1'};
  const handoff={type:'closeout.code-handoff',identity:entry.common,keys:[entry.key],seq:intent.seq+1,at:new Date(Date.parse(intent.at)+100).toISOString(),
    old:{code:{...code,commit:producer,files:graph},epoch:{branch:'main',tip:producer}},
    current:{code:{...code,commit:replacement,files:'a'.repeat(64)},epoch:{branch:'main',tip:replacement}}};
  const installed={old:producer,head:replacement,second:Math.floor(Date.parse(intent.at)/1000)-2,message:`merge ${replacement}: Fast-forward`};
  const history={main:{sha256:'b'.repeat(64),rows:[installed]},head:{sha256:'c'.repeat(64),rows:[{...installed}]}};
  return{handoff,history};
}
function stale(f,action='agent-exit-requested'){
  f.report();const [source]=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]);
  const entry=readCloseoutEntries(f.common).find(e=>e.key===source.closeout_targets.find(t=>t.signal==='landed').key);
  const target=f.retirement(f.options).plan(f.lane).close[0];assert.equal(target.decision,'exit');
  const outcome=action==='agent-exit-requested'?{action,run:target.run,pane:target.pane,tab_id:target.tab_id,occupant:target.occupant,shell:target.shell}:
    {action,tab_id:target.tab_id,panes:[{pane:'w:p',terminal:'term'}]};
  const [intent]=f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:entry.run,item:entry.item,source:entry.source,effect:'original-never-sent',outcome}]);
  const h=historical(entry,intent);
  const [handoff]=f.append([h.handoff]);
  // Preserve a real old defect wait: the positive proof must admit the next
  // ordinary pass rather than waiting for a nonexistent native producer.
  const [prior]=f.append([{type:'closeout.evaluated',key:entry.key,identity:f.common,run:entry.run,item:entry.item,source:entry.source,
    revision:handoff.seq,completed:false,reason:CLOSEOUT_EXIT_PENDING}]);
  f.append([{type:'closeout.waiting',key:entry.key,identity:f.common,source:entry.source,revision:prior.revision,wait_id:'old-defect',
    waiting:{owner:'line-service',defect:'No original completion transport',producers:[]}}]);
  return{entry,intent,prior,history:h.history,project:{identity:f.common,canonical:f.repo}};
}

test('legacy never-sent proof requires the audited pre-send guard and both earlier stable reflogs',()=>{
  const entry={key:'key',common:'/project/.git',project:'/project',cwd:'/lane',run:'R-1',source:{seq:1,type:'item.closed'},
    panes:[{pane:'p',tab:'t',terminal:'term',session:'sid',agent:'agent',workspace:'w'}]};
  const intent={type:'closeout.effect',seq:2,at:'2026-10-27T02:58:00.576Z',effect:'intent',key:entry.key,identity:entry.common,source:entry.source,
    outcome:{action:'agent-exit-requested',run:'R-1',pane:'p',tab_id:'t',occupant:['agent','codex','p','w','/lane','term','sid'],shell:{pid:1,identity:'shell',command:'[zsh]'}}};
  const {handoff,history}=historical(entry,intent),all=[intent,handoff];
  const proof=legacyNeverSentProof(entry,intent,handoff,all,history);assert.equal(proof.kind,'pre-intent-code-change/v1');
  for(const kind of ['same-second','later-change','missing-head','different-checkout','unknown-producer','same-graph','foreign-key','unbound-session','intervening-result','later-refusal','rewind','gap','wrong-head']){
    const e=structuredClone(entry),i=structuredClone(intent),h=structuredClone(handoff),logs=structuredClone(history),rows=[i,h];
    if(kind==='same-second')for(const log of Object.values(logs))log.rows[0].second=Math.floor(Date.parse(i.at)/1000);
    if(kind==='later-change')for(const log of Object.values(logs))log.rows[0].second=Math.floor(Date.parse(i.at)/1000)+1;
    if(kind==='missing-head')delete logs.head;
    if(kind==='different-checkout')h.old.code.root='/elsewhere';
    if(kind==='unknown-producer')h.old.code.commit='f'.repeat(40);
    if(kind==='same-graph')h.current.code.files=h.old.code.files;
    if(kind==='foreign-key')h.keys=['other'];
    if(kind==='unbound-session')i.outcome.occupant[6]='other';
    if(kind==='intervening-result'){h.seq++;rows.push({type:'closeout.command-failed',seq:3,key:e.key,identity:e.common,source:e.source});}
    if(kind==='later-refusal')rows.push({type:'closeout.command-failed',seq:5,key:e.key,identity:e.common,source:e.source,reason:'EPERM native refusal'});
    if(kind==='wrong-head')logs.head.rows[0].head='e'.repeat(40);
    if(kind==='rewind'||kind==='gap')logs.head.rows.push({old:kind==='gap'?'e'.repeat(40):replacement,head:producer,
      second:kind==='rewind'?logs.head.rows[0].second-1:Math.floor(Date.parse(h.at)/1000)+2,message:'reset'});
    assert.equal(legacyNeverSentProof(e,i,h,rows,logs),undefined,kind);
  }
});

for(const state of ['agent-present','bare-shell','gone','gone-and-folder-missing'])test(`never-sent stale intent resolves from current allocation (${state})`,t=>{
  const f=setup(t,{merged:true}),s=stale(f),original=events(f);
  if(state==='bare-shell'){
    f.state.agents=[];f.state.info={shell_pid:1,foreground_processes:[{pid:1,name:'zsh'}],process_tree_complete:true,process_tree:[f.state.info.process_tree[0]]};f.save();
  }
  if(state.startsWith('gone')){f.state.tabs=[];f.state.panes=[];f.state.agents=[];f.save();}
  if(state==='gone-and-folder-missing')f.git(['worktree','remove',f.lane]);
  const added=recoverNeverStartedCloseouts({...s,org:f.org,entries:[s.entry],guard:()=>{}});
  assert.equal(added.filter(e=>e.type==='closeout.command-not-started').length,1);
  assert.equal(unresolvedCloseoutEffect(s.entry,events(f)),undefined);
  assert.deepEqual(events(f).slice(0,original.length),original,'preserve original UNKNOWN evidence and intent');
  assert.equal(closeoutNextStage(s.entry,s.prior,events(f)).stage,'never-sent');
  assert.deepEqual(recoverNeverStartedCloseouts({...s,org:f.org,entries:[s.entry],guard:()=>{}}),[],'one immutable no-start receipt');
  const result=f.drain({keys:[s.entry.key],retrySafe:true});
  assert.equal(result.evaluated[0]?.completed,state!=='gone-and-folder-missing',JSON.stringify(result));
  const actions=f.read().actions;
  assert.equal(actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,state==='agent-present'?1:0);
  assert.equal(actions.filter(a=>a[0]==='tab'&&a[1]==='close').length,state.startsWith('gone')?0:1);
  if(state.startsWith('gone'))assert.ok(effects(f).some(e=>e.action==='closed'&&e.observed_absent&&e.never_sent_intent===s.intent.effect));
  if(state==='gone-and-folder-missing')assert.match(result.evaluated[0].reason,/without a preservation proof/);
  const after=events(f),calls=f.herdrCalls();
  for(let pass=0;pass<3;pass++)assert.deepEqual(f.drain({keys:[s.entry.key],retrySafe:true}).evaluated,[]);
  assert.deepEqual(f.herdrCalls(),calls,'zero repeated native reads or effects after resolution/keep');
  assert.deepEqual(events(f),after,'zero repeated evaluations');
});

test('a stale never-sent tab close observes absence and never resends the old close',t=>{
  const f=setup(t,{merged:true}),s=stale(f,'shell-close-requested');
  f.state.tabs=[];f.state.panes=[];f.state.agents=[];f.save();
  recoverNeverStartedCloseouts({...s,org:f.org,entries:[s.entry],guard:()=>{}});
  assert.equal(f.drain({keys:[s.entry.key],retrySafe:true}).evaluated[0]?.completed,true);
  assert.equal(f.read().actions.some(a=>a[0]==='tab'||a[0]==='agent'),false);
  assert.ok(effects(f).some(e=>e.action==='closed'&&e.never_sent_intent===s.intent.effect));
});

test('never-sent proof retains current identity STOP HOLD and native-read refusals',t=>{
  for(const kind of ['replaced','moved','hold','stop','read-refused']){
    const f=setup(t,{merged:true}),s=stale(f);
    recoverNeverStartedCloseouts({...s,org:f.org,entries:[s.entry],guard:()=>{}});
    if(kind==='replaced'){f.state.panes[0].terminal_id='replacement';f.save();}
    if(kind==='moved'){f.state.tabs=[];f.state.panes=[];f.state.agents[0].pane_id='elsewhere';f.save();}
    if(kind==='hold')hold(f);
    if(kind==='stop'){fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.repo,'.lane/supervisor/STOP'),'stop');}
    if(kind==='read-refused'){const command=f.options.command;f.options.command=(exe,args,opt)=>exe===f.job.herdr?{status:1,stderr:'EPERM native refusal',stdout:''}:command(exe,args,opt);}
    const result=f.drain({keys:[s.entry.key],retrySafe:true});
    assert.equal(result.evaluated[0]?.completed,false,`${kind}: ${JSON.stringify(result)}`);
    assert.deepEqual(f.read().actions,[],kind);assert.equal(fs.existsSync(f.lane),true,kind);
    assert.equal(effects(f).some(e=>e.action==='closed'),false,kind);
  }
});

test('a handoff after an actual uncertain invocation cannot manufacture never-sent proof',t=>{
  const f=setup(t,{merged:true}),s=stale(f),prior=events(f);
  // The only changed input is a ref transition too late to prove no send.
  for(const log of Object.values(s.history))log.rows[0].second=Math.floor(Date.parse(s.intent.at)/1000)+1;
  assert.deepEqual(recoverNeverStartedCloseouts({...s,org:f.org,entries:[s.entry],guard:()=>{}}),[]);
  assert.deepEqual(events(f),prior);
  const retained=retainNativeOutcome(f,s.entry);
  f.drain({keys:[s.entry.key],retrySafe:true});retained();
});

test('unprovable legacy UNKNOWNs skip record/source planning instead of aborting current refresh',t=>{
  const f=setup(t,{merged:true}),s=stale(f),original=events(f);
  for(const log of Object.values(s.history))log.rows[0].second=Math.floor(Date.parse(s.intent.at)/1000)+1;
  const originalMkdir=fs.mkdirSync;
  fs.mkdirSync=function(file,...args){
    assert.notEqual(file,path.join(f.org,'lock'),'no no-op record lock acquisition');
    return originalMkdir.call(this,file,...args);
  };
  try{
    assert.deepEqual(recoverNeverStartedCloseouts({...s,org:f.org,entries:[s.entry],guard:()=>{
      assert.fail('unprovable history must not enter a source guard vulnerable to unrelated landings');
    }}),[]);
  }finally{fs.mkdirSync=originalMkdir;}
  assert.deepEqual(events(f),original);
  assert.ok(unresolvedCloseoutEffect(s.entry,events(f)),'original UNKNOWN is retained');
  assert.deepEqual(f.read().actions,[]);
});

for(const change of ['Git','record'])test(`positive never-sent proof re-prepares after unrelated ${change} movement without replaying effects`,t=>{
  const f=setup(t,{merged:true}),s=stale(f),original=events(f);
  let guards=0,changed=false;
  const originalMkdir=fs.mkdirSync;
  if(change==='record')fs.mkdirSync=function(file,...args){
    const result=originalMkdir.call(this,file,...args);
    if(file===path.join(f.org,'lock')&&!changed){
      changed=true;
      // A separate fixture writer wins just before this preparation's CAS.
      fs.appendFileSync(f.eventFile,JSON.stringify({type:'note.added',id:'ENG-1',text:'unrelated writer',
        seq:original.at(-1).seq+1,at:new Date().toISOString(),by:'fixture'})+'\n');
    }
    return result;
  };
  let added;
  try{
    added=recoverNeverStartedCloseouts({...s,org:f.org,entries:[s.entry],guard:()=>{
      gitProject(f.repo);guards++;
      if(change==='Git'&&!changed){changed=true;f.git(['commit','--allow-empty','-qm','unrelated landing']);}
    }});
  }finally{fs.mkdirSync=originalMkdir;}
  assert.ok(changed);assert.ok(guards>=3,'fresh preparation reruns both source guards');
  assert.equal(added.filter(e=>e.type==='closeout.command-not-started').length,1);
  assert.equal(events(f).filter(e=>e.type==='closeout.command-not-started').length,1);
  assert.deepEqual(events(f).slice(0,original.length),original);
  assert.deepEqual(f.read().actions,[],'proof preparation has no native executor');
});

test('a re-preparation reads changed reflogs again and retains newly unprovable intent',t=>{
  const f=setup(t,{merged:true}),s=stale(f),original=events(f);
  const writeHistory=()=>{
    for(const [name,file]of [['main','logs/refs/heads/main'],['head','logs/HEAD']])
      fs.writeFileSync(path.join(f.common,file),s.history[name].rows.map(row=>
        `${row.old} ${row.head} Fixture <fixture@example.invalid> ${row.second} +0000\t${row.message}\n`).join(''));
  };
  writeHistory();let guards=0;
  const added=recoverNeverStartedCloseouts({...s,history:undefined,org:f.org,entries:[s.entry],guard:()=>{
    if(++guards===2){
      for(const log of Object.values(s.history))log.rows[0].second=Math.floor(Date.parse(s.intent.at)/1000)+1;
      writeHistory();
      throw recordSourceConflict('fixture source changed before append');
    }
  }});
  assert.ok(guards>=3);assert.deepEqual(added,[]);
  assert.deepEqual(events(f),original);
  assert.ok(unresolvedCloseoutEffect(s.entry,events(f)));
  assert.deepEqual(f.read().actions,[]);
});

for(const code of ['EPERM','CLOSEOUT_CODE_CHANGED','RECORD_OBSERVATION_CONFLICT'])test(`never-sent preparation preserves a real ${code} guard refusal without retry`,t=>{
  const f=setup(t,{merged:true}),s=stale(f),original=events(f);
  const refusal=Object.assign(Error('original source/native guard refused'),{code});let guards=0;
  assert.throws(()=>recoverNeverStartedCloseouts({...s,org:f.org,entries:[s.entry],guard:()=>{
    guards++;throw refusal;
  }}),error=>error===refusal);
  assert.equal(guards,1);assert.deepEqual(events(f),original);assert.deepEqual(f.read().actions,[]);
});
