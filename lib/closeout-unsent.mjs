// A narrow bridge for intents written before the pre-send guard had its own
// no-start receipt. A handoff, absence or elapsed time alone proves nothing.
import fs from './record-observation.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadEvents,planTransaction} from './store.mjs';
import {closeoutBindingMatches,closeoutSourceEnabled} from './closeout.mjs';
import {closeoutCommandNotStarted,linkedCloseoutStatuses} from './closeout-status.mjs';

// Audited immutable producers: each journals the intent immediately before
// invoke(), whose first operation verifies the loaded closer graph. See the
// ENG-812 contract note. Unknown producers must keep their UNKNOWN outcome.
const producers=new Map([
  ['291c4da2e2dfecda82c8626588ae841d7cc21a28','4c077ad48f13c6b2d7ae2afaa439589547dda558b6773c9ef696fa6222c5c825'],
  ['b809c8233fc3075878d1b5d3adffd13a205d8e31','227fba5ead3e957db15edb63aff60a3ed07e045065dd22c6a9f2d31600f6eb9e'],
  ['cebeb152c97cf88a9875da267c381c02574058b4','46e872c85bb342915b78d50c125cffd7ebe10d8a4801b787980db2c59bf7bbc1'],
  ['77317d62b69150e16672bd96366b3aeac6db27fb','2c780c244483bfc3c94118a6f7b06b6c80974bf7d9f35b30f8dacec49c2a318d'],
]);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const native=action=>['agent-exit-requested','shell-close-requested'].includes(action);
const mine=(entry,e)=>e.identity===entry.common&&e.key===entry.key&&same(e.source,entry.source);
const fence=e=>e.failure?.kind==='fence'||/EPERM|EACCES|native.refus|permission denied|operation not permitted/i.test(e.reason??'');

function readHistory(common) {
  const read=file=>{
    const bytes=fs.readFileSync(file,'utf8');
    if(!fs.lstatSync(file).isFile()||fs.realpathSync(file)!==file||!bytes.endsWith('\n'))throw Error('unproven source reflog');
    const rows=bytes.trimEnd().split('\n').map(line=>{
      const m=/^([a-f0-9]{40}) ([a-f0-9]{40}) .+ (\d+) [+-]\d{4}\t(.+)$/.exec(line);
      if(!m)throw Error('unproven source reflog row');
      return{old:m[1],head:m[2],second:Number(m[3]),message:m[4]};
    });
    return{sha256:createHash('sha256').update(bytes).digest('hex'),rows};
  };
  return{main:read(path.join(common,'logs/refs/heads/main')),head:read(path.join(common,'logs/HEAD'))};
}

// Positive historical proof: the replacement graph was installed in the
// canonical checkout BEFORE this intent's timestamp, and stayed there until
// the original producer's handoff. Reflog seconds must end strictly before
// intent time. Same-second transitions, rewinds, gaps and missing history keep.
export function legacyNeverSentProof(entry,intent,handoff,events,history) {
  if(!native(intent.outcome?.action)||!mine(entry,intent)||!intent.effect||
      handoff?.type!=='closeout.code-handoff'||handoff.identity!==entry.common||
      !handoff.keys?.includes(entry.key)||handoff.seq<=intent.seq)return;
  const target=intent.outcome,a=target.occupant;
  if(target.action==='agent-exit-requested'&&(!Array.isArray(a)||!target.shell?.identity||!target.shell?.command||
      !Number.isSafeInteger(target.shell?.pid)||!entry.panes.some(p=>(p.run??entry.run)===target.run&&
        p.pane===target.pane&&p.pane===a[2]&&p.agent===a[0]&&p.workspace===a[3]&&entry.cwd===a[4]&&
        p.terminal===a[5]&&p.session===a[6]&&(!p.tab||p.tab===target.tab_id))))return;
  if(target.action==='shell-close-requested'&&(!target.panes?.length||
      !target.panes.every(p=>entry.panes.some(b=>b.pane===p.pane&&b.terminal===p.terminal&&(!b.tab||b.tab===target.tab_id)))))return;
  const old=handoff.old?.code,current=handoff.current?.code;
  if(!producers.has(old?.commit)||producers.get(old.commit)!==old.files||
      old.kind!=='checkout'||current?.kind!=='checkout'||old.root!==entry.project||current.root!==entry.project||
      old.common!==entry.common||current.common!==entry.common||old.graph!=='closer-imports/v1'||current.graph!==old.graph||
      !/^[a-f0-9]{64}$/.test(current.files)||current.files===old.files||
      handoff.old.epoch?.branch!=='main'||handoff.current.epoch?.branch!=='main'||
      handoff.old.epoch.tip!==old.commit||handoff.current.epoch.tip!==current.commit)return;
  // A later handoff must not be attached to an earlier uncertain invocation.
  if(events.some(e=>e.seq>intent.seq&&e.seq<handoff.seq&&
      (mine(entry,e)||e.type==='closeout.code-handoff'&&e.keys?.includes(entry.key))))return;
  if(events.some(e=>mine(entry,e)&&fence(e)))return;
  const start=Date.parse(intent.at),end=Date.parse(handoff.at);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return;
  const witnesses={};
  for(const name of ['main','head']){
    const log=history[name],rows=log?.rows;
    if(!rows?.length)return;
    const index=rows.findLastIndex(r=>r.second*1000<=start);
    const installed=rows[index];
    if(!installed||installed.old!==old.commit||installed.head!==current.commit||(installed.second+1)*1000>=start||
        !/^merge [a-f0-9]{40}: Fast-forward$/.test(installed.message))return;
    // Require a contiguous, monotonic suffix through the handoff, including
    // the first following row. A removed/rewritten interval is not evidence.
    for(let i=index+1;i<rows.length;i++){
      const row=rows[i],prior=rows[i-1];
      if(row.old!==prior.head||row.second<prior.second)return;
      if(row.second*1000>end)break;
      return; // Any intervening ref/checkout transition makes this ambiguous.
    }
    witnesses[name]={sha256:log.sha256,index,installed};
  }
  if(!same(witnesses.main.installed,witnesses.head.installed))return;
  return{kind:'pre-intent-code-change/v1',handoff:{seq:handoff.seq,type:handoff.type},
    producer:old.commit,replacement:current.commit,intent_at:intent.at,handoff_at:handoff.at,reflogs:witnesses};
}

export function recoverNeverStartedCloseouts({project,org,entries,guard,history}) {
  const snapshot=loadEvents(org);
  if(snapshot.tornTail)throw Error('incomplete never-sent proof record');
  if(!entries.some(entry=>snapshot.events.some(e=>e.type==='closeout.code-handoff'&&e.identity===entry.common&&
      e.keys?.includes(entry.key)&&producers.has(e.old?.code?.commit)&&snapshot.events.some(i=>mine(entry,i)&&
        i.type==='closeout.effect'&&native(i.outcome?.action)&&i.seq<e.seq&&!snapshot.events.some(n=>
          mine(entry,n)&&n.type==='closeout.command-not-started'&&n.intent===i.effect)))))return[];
  let inspected=history;
  const result=planTransaction(org,events=>{
    guard();
    const add=[];
    for(const entry of entries){
      if(entry.common!==project.identity||entry.project!==project.canonical||entry.org!==org||
          !closeoutSourceEnabled(entry,events)||!closeoutBindingMatches(entry,events.find(e=>e.seq===entry.source.seq),events))continue;
      for(const intent of events.filter(e=>mine(entry,e)&&e.type==='closeout.effect'&&native(e.outcome?.action))){
        if(events.some(e=>mine(entry,e)&&e.type==='closeout.command-not-started'&&e.intent===intent.effect))continue;
        const handoff=events.find(e=>e.seq>intent.seq&&(mine(entry,e)||e.type==='closeout.code-handoff'&&e.keys?.includes(entry.key)));
        if(handoff?.type!=='closeout.code-handoff'||!producers.has(handoff.old?.code?.commit))continue;
        try{inspected??=readHistory(project.identity);}catch{continue;}
        const proof=legacyNeverSentProof(entry,intent,handoff,events,inspected);
        if(!proof)continue;
        add.push({...closeoutCommandNotStarted(entry,intent.effect,intent.outcome.action,
          {code:'CLOSEOUT_CODE_CHANGED',message:'Audited pre-send guard rejected the graph already installed before this intent was journaled.'}),proof});
      }
    }
    guard();
    return{add:[...add,...linkedCloseoutStatuses(events,add)]};
  },{actor:'never-sent closeout proof',strictTail:true});
  return result.added;
}
