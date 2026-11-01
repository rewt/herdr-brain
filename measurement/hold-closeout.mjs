// Projection of the existing finite-turn journal and original record receipts.
import {readPassJournal} from '../line-service/pass-journal.mjs';
import {evidenceHash} from '../line-service/hold-evidence.mjs';
import {fold} from '../lib/state.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=events=>evidenceHash(JSON.stringify(events));
const ref=e=>({seq:e.seq,type:e.type});
const ms=s=>Number.isFinite(Date.parse(s))?Date.parse(s):null;

export function evaluateHoldCloseout({proof,events,project,org,run,holdSha256}){
  const result=(status,reason,extra={})=>({status,reason,turn:proof?.id??null,...extra});
  const unknown=reason=>result('UNRUN',reason);
  if(proof?.schema!=='brain.hold-closeout/v1'||proof.project!==project||proof.org!==org||!proof.completed||
      !proof.id||!Number.isSafeInteger(proof.turn)||!proof.before||!proof.after)return unknown('finite turn identity or completion missing');
  const {before:a,after:b}=proof;
  if(a.errors?.length||b.errors?.length||!a.hold||!b.hold||!a.main||!b.main||!a.record||!b.record||
      ms(a.at)===null||ms(b.at)===null||ms(a.at)>ms(b.at))return unknown('HOLD, main or record capture incomplete');
  if(!a.hold.text?.trim()||a.hold.sha256!==holdSha256||evidenceHash(a.hold.text)!==holdSha256||!same(a.hold,b.hold))return unknown('written HOLD identity or content changed');
  if(!Number.isSafeInteger(a.record.seq)||a.record.seq<0||!Number.isSafeInteger(b.record.seq)||b.record.seq<a.record.seq||
      events.some((e,i)=>e.seq!==i+1)||(events.at(-1)?.seq??0)<b.record.seq||
      hash(events.slice(0,a.record.seq))!==a.record.sha256||hash(events.slice(0,b.record.seq))!==b.record.sha256||
      b.record.prefix_sha256!==a.record.sha256)return unknown('record fence coverage changed or incomplete');
  const interval=events.slice(a.record.seq,b.record.seq),starts=interval.filter(e=>e.type==='run.started'),
    moves=interval.filter(e=>['change.landed','promotion.reconciled'].includes(e.type)&&(e.project??e.identity)===project);
  if(starts.some(e=>e.meta?.dispatch_project===project)||moves.length)return result('NOT MET','project start or landing recorded during HOLD',{violations:[...starts.filter(e=>e.meta?.dispatch_project===project),...moves].map(ref)});
  if(starts.some(e=>!e.meta?.dispatch_project))return unknown('a run start has unknown project scope');
  const x=a.main,y=b.main;
  const fingerprint=f=>f&&typeof f.file==='string'&&['dev','ino','size','mtimeNs','ctimeNs'].every(k=>/^\d+$/.test(f[k]??''))&&/^[a-f0-9]{64}$/.test(f.sha256??'');
  if(![a.hold,b.hold,x.log,y.log,x.ref,y.ref].every(fingerprint)||
      !/^[a-f0-9]{40,64}$/.test(x.head??'')||!/^[a-f0-9]{40,64}$/.test(y.head??''))return unknown('filesystem or main evidence fields incomplete');
  if(x.head!==y.head)return result('NOT MET','canonical main moved during HOLD');
  if(x.log.file!==y.log.file||x.log.dev!==y.log.dev||x.log.ino!==y.log.ino||Number(y.log.size)<Number(x.log.size)||
      y.prefix_sha256!==x.log.sha256)return unknown('main reflog continuity missing or rewritten');
  if(y.appended){
    const lines=y.appended.trimEnd().split('\n');let tip=x.head;
    for(const line of lines){const [old,next]=line.split(' ');if(old!==tip||!/^[a-f0-9]{40,64}$/.test(next))return unknown('main reflog movement chain is incomplete');tip=next;}
    if(tip!==y.head)return unknown('main reflog tail does not match final tip');
    if(lines.some(line=>{const [old,next]=line.split(' ');return old!==next;}))return result('NOT MET','main moved and was restored during HOLD');
    return unknown('main reflog changed without a proven stationary ref');
  }
  if(y.log.sha256!==x.log.sha256||!same(x.ref,y.ref))return unknown('main ref or reflog changed without complete movement history');
  const subject=proof.subjects?.find(s=>s.run===run),source=events.find(e=>e.seq===subject?.source?.seq&&e.type===subject.source.type);
  const target=source?.closeout_targets?.find(t=>t.key===subject.key&&t.run===run&&t.common===project&&t.org===org);
  const through=events.slice(0,b.record.seq),state=fold(through),r=state.runs.get(run),worker=r&&effectiveWorkerIdentity(r,state),
    start=through.find(e=>e.type==='run.started'&&e.id===run),claim=through.findLast(e=>e.type==='run.claimed'&&e.run===run&&e.seq<(source?.seq??0));
  if(source?.type!=='report.ingested'||source.run!==run||source.seq>a.record.seq||!source.sha256||
      !target?.reportCloseout||!target.cwd||target.cwd!==r?.workspace||!start||start.meta?.dispatch_project!==project||!claim||
      target.allocation?.run!==run||target.allocation?.started_seq!==start.seq||target.allocation?.claim_generation!==claim.seq||
      through.findLast(e=>e.type==='run.claimed'&&e.run===run)?.seq!==claim.seq||claim.project!==project||claim.record!==org||
      !worker||worker.identity_conflict||!worker.agent_session_id||!worker.pane||!worker.terminal_id||
      !target.panes?.some(p=>p.run===run&&p.session===worker.agent_session_id&&p.pane===worker.pane&&p.terminal===worker.terminal_id))return unknown('reported original allocation, claim or native session binding missing');
  const owns=e=>e.run===run&&e.identity===project&&e.key===subject.key&&same(e.source,subject.source);
  const evaluation=interval.find(e=>e.type==='closeout.evaluated'&&owns(e)&&e.completed&&e.reportCloseout&&
    subject.evaluations?.some(s=>s.seq===e.seq&&s.completed&&same(s.resources,e.resources)));
  if(!evaluation)return unknown('same-turn completed evaluation missing');
  const receipts=name=>[...(evaluation.resources?.[name]?.receipts??[]),...(evaluation.resources?.[name]?.receipt?[evaluation.resources[name].receipt]:[])],
    effects=name=>receipts(name).map(r=>interval.find(e=>e.type==='closeout.effect'&&owns(e)&&e.seq===r.seq&&e.effect===r.effect&&e.seq<evaluation.seq)).filter(Boolean),
    closed=effects('session').find(e=>e.outcome?.action==='closed'&&e.outcome.tab_id&&(e.outcome.sessions??[e.outcome]).some(s=>s.run===run&&(s.agent_session_id??s.session)===worker.agent_session_id)),
    removed=effects('folder').find(e=>e.outcome?.action==='worktree-removed'&&e.outcome.cwd===target.cwd&&e.outcome.branch===target.branch&&e.outcome.tip===target.head),
    preflight=interval.find(e=>e.type==='closeout.effect'&&owns(e)&&e.outcome?.action==='lane-preflight'&&e.outcome.cwd===target.cwd&&e.outcome.tip===target.head&&e.seq<(removed?.seq??0));
  // The guarded non-force removal and its preflight are the clean-folder proof;
  // mere absence, an old effect or a manual cleanup cannot satisfy this join.
  if(evaluation.resources?.session?.status!=='closed'||evaluation.resources?.folder?.status!=='removed'||!closed||!removed||!preflight)return unknown('same-turn original-session and clean-folder effect receipts missing');
  return result('MET','written HOLD, unchanged main and original session/folder release joined in one finite turn',
    {run,source:ref(source),key:subject.key,evaluation:ref(evaluation),effects:[closed,preflight,removed].map(ref),hold_sha256:holdSha256,
      window:{from:a.at,cutoff:b.at},record:{before:a.record,after:b.record},main:{before:x,after:y}});
}

export function measureHoldCloseouts({file,events,project,org,run,holdSha256,from,cutoff}){
  const observations=[],digest=[];
  for(const row of readPassJournal(file)){
    const p=row.hold_closeout;
    if(!p||p.project!==project||p.org!==org||!p.subjects?.some(s=>s.run===run)||p.before?.hold?.sha256!==holdSha256)continue;
    const start=ms(p.before.at)??ms(row.at),end=ms(p.after?.at);
    if(start!==null&&(start<ms(from)||start>ms(cutoff))||end!==null&&end>ms(cutoff))continue;
    digest.push(row);observations.push(evaluateHoldCloseout({proof:p,events,project,org,run,holdSha256}));
  }
  return{source:{file,sha256:hash(digest),selected:observations.length},observations};
}
