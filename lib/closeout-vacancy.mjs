// Current allocation disposition only. Never claim a historical close, saved
// folder, command completion or claim release from today's absence.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {planTransaction} from './store.mjs';
import {effectiveWorkerIdentity,WORKER_KEYS} from './worker-identity.mjs';
import {canonical} from './retire-local.mjs';
import {unresolvedCloseoutEffect} from './closeout.mjs';
import {unresolvedGitRemoval} from './closeout-status.mjs';
import {recordedCloseoutRefusal} from './closeout-facts.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const git=(repo,args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
const inside=(a,b)=>typeof a==='string'&&(a===b||a.startsWith(b+path.sep));
export const vacantAllocation=(run,events,identity)=>events.findLast(e=>e.type==='closeout.vacancy-settled'&&
  e.identity===identity&&e.run===run.id&&e.started_seq===run.started.seq&&e.finished_seq===(run.report?.seq??run.abandoned?.seq)&&
  e.claim_generation===(run.owner_generation??null)&&e.cwd===run.workspace);

export function settleVacantCloseouts({project,org,events,state,observe,guard,expired=()=>false,maxTargets=64}){
  const targets=events.flatMap(source=>(source.closeout_targets??[]).filter(t=>t.common===project.identity&&t.org===org&&t.project===project.canonical)
    .map(t=>({...t,source:{seq:source.seq,type:source.type}})));
  const candidates=[...state.runs.values()].filter(run=>(run.report||run.abandoned)&&run.workspace&&
    !vacantAllocation(run,events,project.identity));
  if(!candidates.length||expired())return[];
  let snapshot,trees,branches;
  const rows=[];
  const keep=(run,reason)=>{
    const prior=events.findLast(e=>e.type==='closeout.vacancy-kept'&&e.identity===project.identity&&e.run===run.id);
    if(prior?.reason===reason&&prior.started_seq===run.started.seq&&prior.claim_generation===(run.owner_generation??null))return;
    rows.push({type:'closeout.vacancy-kept',identity:project.identity,run:run.id,item:run.item,cwd:run.workspace,
      started_seq:run.started.seq,claim_generation:run.owner_generation??null,reason,owner:run.id,
      continuation:{kind:'owner-evidence',owner:run.id},native_completion:false});
  };
  for(const run of candidates){
    if(expired()||rows.length>=maxTargets)break;
    try{if(fs.lstatSync(run.workspace,{throwIfNoEntry:false}))continue;}
    catch(error){keep(run,`Original allocation filesystem cannot be observed: ${error.message}`);continue;}
    const lane=run.workspace,own=targets.filter(t=>t.cwd===lane),m=effectiveWorkerIdentity(run,state);
    const bound=run.meta?.dispatch_project===project.identity||events.some(e=>e.type==='run.claimed'&&e.run===run.id&&e.project===project.identity)||own.some(t=>t.run===run.id);
    if(!bound||!path.isAbsolute(lane)||lane===project.canonical||canonical(lane)!==lane||m.identity_conflict){keep(run,'Original project/allocation/native identity is missing, foreign or changed; original owner must supply its binding.');continue;}
    if(events.some(e=>e.seq>(run.report?.seq??run.abandoned.seq)&&e.type==='run.claimed'&&e.run===run.id)){
      keep(run,'Original allocation claim changed after finality; original owner must resolve the claim.');continue;
    }
    if([...state.runs.values()].some(r=>r.id!==run.id&&!r.report&&!r.abandoned&&(inside(r.workspace,lane)||
      WORKER_KEYS.some(k=>m[k]&&m[k]===effectiveWorkerIdentity(r,state)[k])))){
      keep(run,'An open run still owns this allocation or native identity; its original owner must finalize it.');continue;
    }
    if(own.some(t=>unresolvedCloseoutEffect(t,events)||unresolvedGitRemoval(t,events)||recordedCloseoutRefusal(t,events))){
      keep(run,'Original native/Git outcome is UNKNOWN or refused; original producer completion or explicit owner evidence is required.');continue;
    }
    // An unbound original effect is also retained; there is no replacement key.
    if(events.some(e=>e.run===run.id&&['closeout.command-failed','closeout.invalid'].includes(e.type))||
        events.some(e=>e.run===run.id&&e.type==='closeout.effect'&&!own.some(t=>t.key===e.key))){
      keep(run,'Original unbound/failed effect remains owned; no replacement attempt or completion is inferred.');continue;
    }
    const names=new Set([run.meta?.lane?`lane/${run.meta.lane}`:null,...own.map(t=>t.branch)].filter(Boolean));
    if(names.size!==1){keep(run,'Original lane branch is missing or ambiguous; original owner must supply its allocation evidence.');continue;}
    const branch=[...names][0];if(!/^lane\/[a-z0-9][a-z0-9-]{1,60}$/.test(branch)){keep(run,'Original branch is not an owned lane; original owner retains disposition.');continue;}
    guard();
    snapshot??=observe();
    if(snapshot.errors.length||!snapshot.nativeInventory?.complete)throw Error('vacancy settlement requires complete native inventory');
    if(snapshot.nativeInventory.panes.some(p=>m.pane&&p.pane_id===m.pane||m.terminal_id&&p.terminal_id===m.terminal_id||
        inside(p.cwd,lane)||inside(p.foreground_cwd,lane)||snapshot.workspaces.some(w=>w.workspace_id===p.workspace_id&&w.worktree?.checkout_path===lane))||
        snapshot.agents.some(a=>m.agent&&a.name===m.agent||m.pane&&a.pane_id===m.pane||m.terminal_id&&a.terminal_id===m.terminal_id||
          m.agent_session_id&&(a.agent_session?.value??a.agent_session_id)===m.agent_session_id||inside(a.cwd,lane))){
      keep(run,'Original native target or a lane occupant remains; original owner must resolve it without reconstructing a session.');continue;
    }
    trees??=git(project.canonical,['worktree','list','--porcelain']);
    if(trees.split('\n').includes(`worktree ${lane}`)||trees.split('\n').includes(`branch refs/heads/${branch}`)){
      keep(run,'Folder is absent but its Git worktree allocation remains registered; original preservation/removal proof is required.');continue;
    }
    branches??=new Map(git(project.canonical,['for-each-ref','--format=%(refname:short)%00%(objectname)','refs/heads/lane/']).split('\n').filter(Boolean).map(row=>row.split('\0')));
    const head=branches.get(branch)??null;
    if(head){try{git(project.canonical,['merge-base','--is-ancestor',head,snapshot.mainRef??'main']);}catch(error){if(error.status===1){keep(run,'Unlanded branch remains; original owner retains its exact ref and source.');continue;}throw error;}}
    const resources={session:{status:'absent',completion:'UNKNOWN'},folder:{status:'absent',preservation:'UNKNOWN'},
      branch:head?{status:'retained',ref:branch,head,integrated:true}:{status:'absent',ref:branch},
      author_packet:{status:'original-record',report:run.report??run.abandoned}};
    rows.push({type:'closeout.vacancy-settled',identity:project.identity,run:run.id,item:run.item,cwd:lane,branch,head,
      started_seq:run.started.seq,finished_seq:run.report?.seq??run.abandoned.seq,claim_generation:run.owner_generation??null,
      source:{seq:run.report?.seq??run.abandoned.seq,type:run.report?'report.ingested':'run.abandoned'},
      binding:Object.fromEntries(WORKER_KEYS.map(k=>[k,m[k]??null])),resources,
      targets:own.map(t=>({key:t.key,run:t.run,item:t.item,source:t.source})),
      bindings:events.filter(e=>e.type==='closeout.binding-kept'&&e.identity===project.identity&&e.run===run.id).map(e=>({seq:e.seq,key:e.key,source:e.source})),native_completion:false,
      evidence:{native_complete:true,observed_at:new Date().toISOString(),folder:'lstat absent; canonical path unchanged',
        worktree:'unregistered',branch:head?'current main ancestor; ref retained':'ref absent',
        inventory_sha256:createHash('sha256').update(JSON.stringify([snapshot.nativeInventory,snapshot.agents])).digest('hex')},
      qualification:'Current allocation has nothing requiring disposal. Historical native/Git completion, claim release and folder preservation remain unproved.'});
  }
  if(!rows.length)return[];
  guard();
  return planTransaction(org,current=>{
    guard();if(!same(current,events))throw Error('vacancy observation record CAS changed; observe again');
    const add=rows.flatMap(row=>row.type==='closeout.vacancy-kept'?[row]:[row,...row.bindings.map(b=>({type:'closeout.binding-settled',identity:row.identity,run:row.run,item:row.item,
      key:b.key,source:b.source,binding_seq:b.seq,disposition:'current-vacancy',resources:row.resources,native_completion:false})),
      ...row.targets.filter(t=>!current.findLast(e=>e.type==='closeout.evaluated'&&e.identity===row.identity&&e.key===t.key&&same(e.source,t.source))?.completed)
      .map(t=>({type:'closeout.evaluated',identity:row.identity,...t,revision:current.at(-1)?.seq??0,completed:true,
        disposition:'absent',completion_kind:'current-vacancy',native_completion:false,resources:row.resources,
        vacancy:{run:row.run,started_seq:row.started_seq,finished_seq:row.finished_seq},reason:row.qualification}))]);
    return{add};
  },{actor:'current allocation vacancy settlement',replaySafe:true}).added;
}
