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
import {bindCleanupEntry,closeoutRecordMatches,closeoutPolicy,lineServiceOwnsCleanup,
  readCloseoutEntries,publishCloseoutEvents,closeoutBindingMatches,closeoutEvaluations,
  unresolvedCloseoutEffect,observeCloseoutContent,currentCloseoutEntries} from './closeout.mjs';

const git=(cwd,args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
const sid=a=>a.agent_session?.value??a.agent_session_id;
export const cleanupSafetyHold=reason=>/EPERM|EACCES|refus|foreign|identity|reserved|HOLD|STOP|source|binding|head|generation|preserv|claim|ownership|unsafe/i.test(reason??'');

function originalIdentity(run,events,state){
  const end=run.report?.seq??run.abandoned?.seq;
  if(!end)return null;
  const original=fold(events.filter(e=>e.seq<=end)),r=original.runs.get(run.id),m=effectiveWorkerIdentity(r,original),now=effectiveWorkerIdentity(run,state);
  if(!r||r.workspace!==run.workspace||m.identity_conflict||now.identity_conflict||WORKER_KEYS.some(k=>!m[k]||m[k]!==now[k]))return null;
  return m;
}

export function refreshCloseouts({cwd,org,env=process.env,retirementOptions={},loadedCode}={}){
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
  const events=loaded.events,state=fold(events),entries=currentCloseoutEntries(project.identity,record,events),last=new Map(closeoutEvaluations(project.identity,record,events).map(e=>[e.key,e]));
  const adapter=createRetirement({...retirementOptions,cwd:project.canonical,org:record,env,requireRecord:true,guard});
  const snapshot=adapter.observe(undefined,{globalPanes:true});
  if(snapshot.errors.length||!snapshot.nativeInventory?.complete)throw Error(snapshot.errors[0]??'complete native inventory required for cleanup binding');
  const created=[],kept=[],seen=new Set();
  for(const run of [...state.runs.values()].sort((a,b)=>b.started.seq-a.started.seq)){
    if(!run.workspace||seen.has(run.workspace)||!run.report&&!run.abandoned)continue;
    seen.add(run.workspace);
    try{
      if(!fs.existsSync(run.workspace))continue;
      const lane=fs.realpathSync(run.workspace);
      if(lane===project.canonical)continue;
      if([...state.runs.values()].some(r=>r.workspace===run.workspace&&!r.report&&!r.abandoned))throw Error('open/reused allocation retains cleanup target');
      const laneEntries=[...new Map([...events.flatMap(source=>(source.closeout_targets??[]).filter(t=>t.common===project.identity&&t.org===record&&t.project===project.canonical&&t.cwd===lane)
        .map(t=>({...t,source:{seq:source.seq,type:source.type}}))),...entries.filter(e=>e.org===record&&e.project===project.canonical&&e.cwd===lane)].map(e=>[e.key,e])).values()];
      if(laneEntries.some(e=>e.reportCloseout===true))continue;
      if(laneEntries.some(e=>unresolvedCloseoutEffect(e,events)||cleanupSafetyHold(last.get(e.key)?.reason)))throw Error('original uncertain or refused cleanup scope remains held');
      const members=[...state.runs.values()].filter(r=>r.workspace===run.workspace&&(r.report||r.abandoned));
      if(members.some(r=>/EPERM|EACCES|native.refus|native-refusal|PermissionError|shell\/native.*mismatch/i.test(JSON.stringify(r.report??{}))))throw Error('original native refusal remains held');
      const target=gitProject(lane);if(target.identity!==project.identity||target.checkout!==lane)throw Error('foreign cleanup worktree');
      const branch=git(lane,['symbolic-ref','--short','HEAD']),head=git(lane,['rev-parse','HEAD']);
      if(!/^lane\/[a-z0-9][a-z0-9-]{1,60}$/.test(branch))continue;
      const content={head,branch,kind:'reported-allocation'};
      // Every pane binding comes from pre-finalization launch evidence. A
      // missing native SID is a keep, never reconstructed from a current label.
      const panes=members.map(r=>{
        const m=originalIdentity(r,events,state);if(!m)throw Error('unknown original cleanup allocation identity');
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
      });
      const newest=panes.filter((p,i)=>!panes.slice(i+1).some(q=>q.pane===p.pane));
      guard();
      const result=transact(record,current=>{
        guard();
        if(JSON.stringify(current.slice(0,events.length))!==JSON.stringify(events)||current.slice(events.length).some(e=>e.run===run.id||e.id===run.id||e.item===run.item||e.id===run.item||e.workspace===run.workspace))throw Error('cleanup allocation record CAS changed');
        const entry=bindCleanupEntry(project,record,current,{type:'cleanup.bound',seq:0,reportCloseout:Boolean(run.report)},run.id,run.report?'ready':'landed',head);
        if(!entry||entry.head!==head||entry.branch!==branch)throw Error('cleanup binding source changed');
        const {source,...bound}=entry;
        bound.panes=newest;bound.cleanup={started_seq:run.started.seq,finished_seq:run.report?.seq??run.abandoned.seq,content,allocation:'original launch evidence verified; current native observation'};
        if(current.some(e=>e.type==='cleanup.bound'&&e.closeout_targets?.some(t=>t.key===bound.key&&t.head===head)))return{add:[]};
        return{add:[{type:'cleanup.bound',common:project.identity,run:run.id,item:run.item,closeout_targets:[bound]}]};
      },{actor:'current cleanup binding',strictTail:true});
      created.push(...publishCloseoutEvents({cwd:project.canonical,org:record,env,added:result.added,start:false}).map(e=>e.key));
    }catch(error){
      const row={type:'closeout.kept',identity:project.identity,run:run.id,cwd:run.workspace,owner:run.id,disposition:'kept',reason:error.message};
      if(!events.some(e=>e.type===row.type&&e.identity===row.identity&&e.run===row.run&&e.cwd===row.cwd&&e.reason===row.reason))
        transact(record,current=>({add:current.some(e=>e.type===row.type&&e.identity===row.identity&&e.run===row.run&&e.cwd===row.cwd&&e.reason===row.reason)?[]:[row]}),{actor:'current cleanup binding'});
      kept.push({run:run.id,cwd:run.workspace,reason:error.message});
    }
  }
  return{created,kept};
}
