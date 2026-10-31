// A separate, freshly checked cleanup binding; never a late launch/session bind.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {gitProject} from './project.mjs';
import {loadEvents,transact} from './store.mjs';
import {fold} from './state.mjs';
import {effectiveWorkerIdentity,WORKER_KEYS} from './worker-identity.mjs';
import {bindCloseoutCode} from './closeout-code.mjs';
import {createRetirement} from './retire-runtime.mjs';
import {retirementHold} from './retire-hold.mjs';
import {recoverNeverStartedCloseouts} from './closeout-unsent.mjs';
import {recordedCloseoutRefusal} from './closeout-facts.mjs';
import {settleVacantCloseouts,vacantAllocation} from './closeout-vacancy.mjs';
import {bindCleanupEntry,closeoutRecordMatches,closeoutPolicy,lineServiceOwnsCleanup,
  readCloseoutEntries,publishCloseoutEvents,closeoutBindingMatches,closeoutEvaluations,
  unresolvedCloseoutEffect,observeCloseoutContent,currentCloseoutEntries,sameFileIdentity,closeoutKey} from './closeout.mjs';
import {canonical} from './retire-local.mjs';
import {declaredSourceRanges} from '../settle/review-range.mjs';

const git=(cwd,args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
const sid=a=>a.agent_session?.value??a.agent_session_id;
export const cleanupSafetyHold=reason=>/EPERM|EACCES|refus|foreign|identity|reserved|HOLD|STOP|source|binding|head|generation|preserv|claim|ownership|unsafe/i.test(reason??'');

function originalIdentity(run,events,state,{partial=false}={}){
  const end=run.report?.seq??run.abandoned?.seq;
  if(!end)return null;
  const original=fold(events.filter(e=>e.seq<=end||e.type==='run.session_bound'&&e.run===run.id)),r=original.runs.get(run.id),m=effectiveWorkerIdentity(r,original),now=effectiveWorkerIdentity(run,state);
  if(!r||r.workspace!==run.workspace||(r.owner_generation??null)!==(run.owner_generation??null)||
      (r.meta?.dispatch_attempt??null)!==(run.meta?.dispatch_attempt??null)||m.identity_conflict||now.identity_conflict||WORKER_KEYS.some(k=>
      (!partial&&!m[k])||(m[k]??null)!==(now[k]??null)))return null;
  return m;
}

export function refreshCloseouts({cwd,org,env=process.env,retirementOptions={},loadedCode,deadline=Date.now()+45000,maxTargets=8}={}){
  const project=gitProject(cwd),record=fs.realpathSync(org),code=bindCloseoutCode(project,loadedCode);
  const guard=()=>{
    code.verify();
    if(!closeoutRecordMatches(project,record,env)||!closeoutPolicy(project.canonical)||!lineServiceOwnsCleanup(project,record))throw Error('cleanup binding requires the actual current line ownership');
    const stop=path.join(record,'line-service',createHash('sha256').update(JSON.stringify(project.identity)).digest('hex').slice(0,20),'STOP');
    if(fs.existsSync(stop)||fs.existsSync(path.join(project.canonical,'.lane/supervisor/STOP'))||fs.existsSync(path.join(project.canonical,'.lane/supervisor/HOLD'))||retirementHold(project.canonical))throw Error('STOP/HOLD prevents cleanup binding');
  };
  guard();
  const pending=loadEvents(record);if(pending.tornTail)throw Error('incomplete cleanup record');
  recoverNeverStartedCloseouts({project,org:record,entries:currentCloseoutEntries(project.identity,record,pending.events),guard});
  const loaded=loadEvents(record);if(loaded.tornTail)throw Error('incomplete cleanup record');
  let events=loaded.events,state=fold(events);
  let inventory;
  const observe=()=>{
    if(inventory)return inventory;
    const adapter=createRetirement({...retirementOptions,deadline,cwd:project.canonical,org:record,env,requireRecord:true,guard});
    const snapshot=adapter.observe(undefined,{globalPanes:true});
    if(snapshot.errors.length||!snapshot.nativeInventory?.complete)throw Error(snapshot.errors[0]??'complete native inventory required for cleanup binding');
    return inventory={...snapshot,mainRef:adapter.main};
  };
  let settled=[];
  const errors=[];
  try{settled=settleVacantCloseouts({project,org:record,events,state,observe,guard,expired:()=>Date.now()>=deadline});}
  catch(error){
    if(error.code==='CLOSEOUT_CODE_CHANGED')throw error;
    guard(); // A failed observation never relaxes the live source/STOP/ownership guard.
    errors.push({stage:'vacancy',reason:error.message});
  }
  // Even an empty/failed batch may have observed concurrent record changes.
  const refreshed=loadEvents(record);if(refreshed.tornTail)throw Error('incomplete cleanup record');
  events=refreshed.events;state=fold(events);
  const entries=currentCloseoutEntries(project.identity,record,events),last=new Map(closeoutEvaluations(project.identity,record,events).map(e=>[e.key,e]));
  // Fairness orders allocations, while the newest finished run owns each
  // allocation's report/session binding. An older shared-pane report cannot.
  const allocations=new Map();
  for(const run of state.runs.values())if(run.workspace&&(run.report||run.abandoned)&&
      (!allocations.has(run.workspace)||run.started.seq>allocations.get(run.workspace).started.seq))allocations.set(run.workspace,run);
  // A deduplicated keep is not the last examination. One bounded batch fact
  // rotates unchanged holds too, without appending a keep on every refresh.
  const examined=[],examinations=new Map(),allocationKey=run=>JSON.stringify([run.id,run.workspace,run.started.seq]);
  for(const row of events)if(row.type==='closeout.refresh-examined'&&row.identity===project.identity)
    for(const target of row.targets??[])examinations.set(JSON.stringify([target.run,target.cwd,target.started_seq]),row.seq);
  const lastExamined=run=>examinations.get(allocationKey(run))??events.findLast(e=>e.type==='closeout.kept'&&e.identity===project.identity&&e.run===run.id)?.seq??0;
  const created=[],kept=[];let selected=0;
  for(const run of [...allocations.values()].sort((a,b)=>
      lastExamined(a)-lastExamined(b)||a.started.seq-b.started.seq)){
    if(Date.now()>=deadline||selected>=maxTargets)break;
    let counted=false;
    try{
      const missing=!fs.lstatSync(run.workspace,{throwIfNoEntry:false});
      if(missing&&vacantAllocation(run,events,project.identity))continue;
      const lane=missing?canonical(run.workspace):fs.realpathSync(run.workspace);
      if(lane===project.canonical)continue;
      if(missing&&(lane!==run.workspace||run.meta?.dispatch_project!==project.identity||!originalIdentity(run,events,state)))
        throw Error('absent allocation requires its original project and complete native identity');
      if([...state.runs.values()].some(r=>r.workspace===run.workspace&&!r.report&&!r.abandoned))throw Error('open/reused allocation retains cleanup target');
      const laneEntries=[...new Map([...events.flatMap(source=>(source.closeout_targets??[]).filter(t=>t.common===project.identity&&t.org===record&&t.project===project.canonical&&t.cwd===lane)
        .map(t=>({...t,source:{seq:source.seq,type:source.type}}))),...entries.filter(e=>e.org===record&&e.project===project.canonical&&e.cwd===lane)].map(e=>[e.key,e])).values()];
      const direct=laneEntries.filter(e=>e.reportCloseout===true);
      // Older report writers folded an unsequenced pending report and lost
      // valid late-bound sessions. Only an empty original report target with
      // no native/Git attempt can get a fresh, independently verified binding.
      // Preserve the original event/evaluation; never replace UNKNOWN effects.
      if(direct.some(e=>e.cleanup?.native_only)||!missing&&direct.some(e=>e.panes.length||e.source.type!=='report.ingested'))continue;
      selected++;counted=true;
      if(direct.some(e=>events.some(row=>row.identity===e.common&&row.key===e.key&&
          ['closeout.effect','closeout.command-failed','closeout.invalid'].includes(row.type)&&
          (row.type!=='closeout.effect'||row.outcome?.action!=='report-evidence'))))throw Error('original cleanup attempt remains held');
      const unchangedEmpty=e=>e.reportCloseout&&!e.panes.length&&e.allocation&&e.run===run.id&&
        e.allocation.started_seq===run.started.seq&&e.allocation.claim_generation===(run.owner_generation??null)&&
        e.allocation.dispatch===(run.meta?.dispatch_attempt??null)&&e.allocation.report_sha256===(run.report?.sha256??null)&&
        JSON.stringify(e.allocation.worker)===JSON.stringify(state.workerReceipts?.get(run.id)??null)&&
        originalIdentity(run,events,state,{partial:true});
      if(laneEntries.some(e=>unresolvedCloseoutEffect(e,events)||cleanupSafetyHold(last.get(e.key)?.reason)&&
          !(missing&&last.get(e.key)?.reason==='queued worktree absent without a preservation proof; keep')&&
          !(last.get(e.key)?.reason==='unbound allocation original worker/claim changed; keep'&&unchangedEmpty(e))))throw Error('original uncertain or refused cleanup scope remains held');
      const members=[...state.runs.values()].filter(r=>r.workspace===run.workspace&&(r.report||r.abandoned));
      if(!laneEntries.length&&events.some(e=>members.some(r=>r.id===e.run)&&
          ['closeout.effect','closeout.command-failed'].includes(e.type)&&e.outcome?.action!=='report-evidence'))
        throw Error('original unbound cleanup attempt remains held; original owner evidence required');
      if(laneEntries.some(e=>recordedCloseoutRefusal(e,events)))throw Error('original native refusal remains held');
      const target=missing?null:gitProject(lane);if(!missing&&(target.identity!==project.identity||target.checkout!==lane))throw Error('foreign cleanup worktree');
      const branches=new Set([run.meta?.lane?`lane/${run.meta.lane}`:null,...laneEntries.map(e=>e.branch)].filter(Boolean));
      if(missing&&branches.size!==1)throw Error('absent allocation original lane branch is missing or ambiguous');
      const branch=missing?[...branches][0]:git(lane,['symbolic-ref','--short','HEAD']);
      if(!/^lane\/[a-z0-9][a-z0-9-]{1,60}$/.test(branch))continue;
      const branchHead=missing?git(project.canonical,['for-each-ref','--format=%(objectname)',`refs/heads/${branch}`]):null;
      const oldHeads=new Set([...laneEntries.map(e=>e.head),...declaredSourceRanges(run.report?.artifacts??[]).map(r=>r.head)].filter(h=>/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(h)));
      if(missing&&!branchHead&&oldHeads.size!==1)throw Error('absent allocation has no immutable source anchor');
      const head=missing?(branchHead??'')||[...oldHeads][0]:git(lane,['rev-parse','HEAD']);
      for(const entry of missing?[]:direct)if(entry.head!==head||entry.branch!==branch||git(lane,['rev-parse','--absolute-git-dir'])!==entry.gitDirectory||!sameFileIdentity(lane,entry.worktreeIdentity)||
          !sameFileIdentity(entry.gitDirectory,entry.gitIdentity)||entry.branchLog&&(!sameFileIdentity(entry.branchLog.path,entry.branchLog.identity)||
          createHash('sha256').update(fs.readFileSync(entry.branchLog.path)).digest('hex')!==entry.branchLog.sha256))
        throw Error('original report cleanup source/head/generation changed');
      const content={head,branch,kind:'reported-allocation'};
      // Every pane binding comes from pre-finalization launch evidence. A
      // missing native SID is a keep, never reconstructed from a current label.
      let physicalIdentity;
      const snapshot=observe(),panes=members.map(r=>{
        const m=originalIdentity(r,events,state);
        if(!m){
          const current=originalIdentity(r,events,state,{partial:true});
          // A final allocation with no SID may still receive physical-only
          // disposition. The executor keeps real/unproven occupants; no native
          // identity is reconstructed by this refresh.
          if(current&&!current.agent_session_id)return null;
          // Some old launches saved a SID but not its terminal/pane tuple.
          // Do not reconstruct that tuple or signal the session. A single
          // unchanged finished allocation can receive physical-only cleanup
          // when a complete global census proves every known target absent.
          const inLane=cwd=>typeof cwd==='string'&&(cwd===lane||cwd.startsWith(lane+path.sep));
          if(current&&members.length===1&&
              !snapshot.nativeInventory.panes.some(p=>current.pane&&p.pane_id===current.pane||current.terminal_id&&p.terminal_id===current.terminal_id||
                inLane(p.cwd)||inLane(p.foreground_cwd)||snapshot.workspaces.some(w=>w.workspace_id===p.workspace_id&&w.worktree?.checkout_path===lane))&&
              !snapshot.agents.some(a=>current.agent&&a.name===current.agent||current.pane&&a.pane_id===current.pane||
                current.terminal_id&&a.terminal_id===current.terminal_id||sid(a)===current.agent_session_id||inLane(a.cwd))){
            physicalIdentity=Object.fromEntries(WORKER_KEYS.map(k=>[k,current[k]??null]));
            return null;
          }
          throw Error('unknown original cleanup allocation identity');
        }
        const b={run:r.id,pane:m.pane,terminal:m.terminal_id,session:m.agent_session_id,workspace:m.worker_workspace,agent:m.agent};
        const ps=snapshot.nativeInventory.panes.filter(p=>p.pane_id===b.pane||p.terminal_id===b.terminal),
          agents=snapshot.agents.filter(a=>a.name===b.agent||a.terminal_id===b.terminal||sid(a)===b.session);
        if(ps.length){
          if(!snapshot.workspaces.some(w=>w.workspace_id===b.workspace&&w.worktree?.repo_key===project.identity&&w.worktree?.checkout_path===lane&&w.worktree?.is_linked_worktree))throw Error('foreign native cleanup workspace identity');
          if(ps.length!==1||ps[0].pane_id!==b.pane||ps[0].terminal_id!==b.terminal||ps[0].workspace_id!==b.workspace||agents.length>1)throw Error('reused or moved cleanup native allocation');
          if(!agents.length){
            if(!snapshot.exits.some(e=>e.pane===b.pane&&e.occupant.terminal_id===b.terminal&&e.occupant.agent_session_id===b.session))throw Error('exited cleanup allocation has no original shell identity proof');
            b.tab=ps[0].tab_id;return b;
          }
          const a=agents[0];if(a.name!==b.agent||a.pane_id!==b.pane||a.workspace_id!==b.workspace||a.terminal_id!==b.terminal||sid(a)!==b.session||a.cwd!==lane||!['idle','done'].includes(a.agent_status??a.status))throw Error('working or mismatched cleanup native allocation');
          b.tab=ps[0].tab_id;
        }else if(agents.length)throw Error('original cleanup session moved elsewhere');
        return b;
      }).filter(Boolean);
      if(panes.length&&panes.length!==members.length)throw Error('mixed bound/unbound original cleanup allocation identity');
      const newest=panes.filter((p,i)=>!panes.slice(i+1).some(q=>q.pane===p.pane));
      guard();
      const result=transact(record,current=>{
        guard();
        if(JSON.stringify(current.slice(0,events.length))!==JSON.stringify(events)||current.slice(events.length).some(e=>e.run===run.id||e.id===run.id||e.item===run.item||e.id===run.item||e.workspace===run.workspace))throw Error('cleanup allocation record CAS changed');
        const entry=missing?{schema:'closeout-entry/v2',key:closeoutKey(lane,run.id,'ready'),common:project.identity,project:project.canonical,org:record,
          run:run.id,item:run.item,signal:'ready',cwd:lane,branch,head,reportCloseout:true,panes:[],
          allocation:{run:run.id,started_seq:run.started.seq,claim_generation:run.owner_generation??null,dispatch:run.meta?.dispatch_attempt??null,
            worker:state.workerReceipts?.get(run.id)??null,report_sha256:run.report?.sha256??null}}:
          bindCleanupEntry(project,record,current,{type:'cleanup.bound',seq:0,reportCloseout:true},run.id,run.report?'ready':'landed',head);
        if(!entry||entry.head!==head||entry.branch!==branch)throw Error('cleanup binding source changed');
        if(missing&&(fs.lstatSync(lane,{throwIfNoEntry:false})||git(project.canonical,['for-each-ref','--format=%(objectname)',`refs/heads/${branch}`])!==branchHead))
          throw Error('absent allocation path or branch changed before binding');
        const {source,...bound}=entry;
        bound.panes=newest;bound.cleanup={started_seq:run.started.seq,finished_seq:run.report?.seq??run.abandoned.seq,content,allocation:'original launch evidence verified; current native observation',
          ...(physicalIdentity?{physical_identity:physicalIdentity}:{}),
          ...(missing?{native_only:{schema:'absent-allocation-native/v1',branch,head,branch_head:branchHead,worker:Object.fromEntries(WORKER_KEYS.map(k=>[k,originalIdentity(run,events,state)[k]])),
            qualification:'Original native target only; no Git removal, preservation or historical completion is asserted.'}}:{}),
          ...(direct.length?{empty_report_sources:direct.map(e=>e.source)}:{})};
        if(current.some(e=>e.type==='cleanup.bound'&&e.closeout_targets?.some(t=>t.key===bound.key&&t.head===head)))return{add:[]};
        return{add:[{type:'cleanup.bound',common:project.identity,run:run.id,item:run.item,closeout_targets:[bound]}]};
      },{actor:'current cleanup binding',strictTail:true});
      created.push(...publishCloseoutEvents({cwd:project.canonical,org:record,env,added:result.added,start:false}).map(e=>e.key));
    }catch(error){
      // Early identity/ownership keeps are subjects too. Otherwise a refresh
      // can append one keep per historical allocation for its entire deadline,
      // starving consistent record readers despite short individual locks.
      if(!counted){selected++;counted=true;}
      const row={type:'closeout.kept',identity:project.identity,run:run.id,cwd:run.workspace,owner:run.id,disposition:'kept',reason:error.message};
      if(!events.some(e=>e.type===row.type&&e.identity===row.identity&&e.run===row.run&&e.cwd===row.cwd&&e.reason===row.reason))
        transact(record,current=>({add:current.some(e=>e.type===row.type&&e.identity===row.identity&&e.run===row.run&&e.cwd===row.cwd&&e.reason===row.reason)?[]:[row]}),{actor:'current cleanup binding'});
      kept.push({run:run.id,cwd:run.workspace,reason:error.message});
    }finally{
      if(counted)examined.push({run:run.id,cwd:run.workspace,started_seq:run.started.seq});
    }
  }
  if(examined.length)transact(record,()=>{
    guard();return{add:[{type:'closeout.refresh-examined',identity:project.identity,targets:examined}]};
  },{actor:'current cleanup examination'});
  return{created,kept,errors,selected,settled:settled.filter(e=>e.type==='closeout.vacancy-settled').map(e=>e.run)};
}
