// Post-FF bookkeeping, never a landing readiness gate or reconstructed clock.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {gitProject} from './project.mjs';
import {findOrgDir,transact} from './store.mjs';
import {fold} from './state.mjs';
import {effectiveWorkerIdentity} from './worker-identity.mjs';
import {readOwnedRun,requireController,assertOwner} from './run-owner.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {protectRecordMutation} from './record-guard.mjs';

const git=(cwd,args)=>execFileSync('git',['--no-optional-locks','-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export function recordOwnLanding({canonical,workspace,base,head,landedAt,env=process.env,call}) {
  const project=gitProject(workspace),org=findOrgDir({cwd:workspace,env});
  if(!org)return {recorded:false,reason:'owning record unavailable'};
  if(project.canonical!==canonical||project.checkout!==fs.realpathSync(workspace))throw Error('landing receipt source/project differs');
  const binding=nativeSender(org,{cwd:workspace,env,...(call?{call}:{})});
  const tuple=b=>[b.project.identity,b.project.checkout,b.org,b.native.name,b.native.pane_id,b.native.workspace_id,b.native.terminal_id,b.native.agent_session.value,b.native.cwd];
  const result=transact(org,events=>{
    const state=fold(events),native=binding.native;
    const matching=[...state.runs.values()].filter(run=>{
      const item=state.items.get(run.item),w=effectiveWorkerIdentity(run,state);
      return item?.role==='engineer'&&item.runs.at(-1)===run.id&&!run.abandoned&&run.workspace===workspace&&
        !w.identity_conflict&&w.agent===native.name&&w.pane===native.pane_id&&w.worker_workspace===native.workspace_id&&
        w.terminal_id===native.terminal_id&&w.agent_session_id===native.agent_session.value;
    });
    // A same-session continuation also matches its reported predecessor; that
    // completed run never competes with the one open current run.
    const open=matching.filter(run=>!run.report),owners=open.length===1&&matching.every(run=>run===open[0]||run.report&&run.started.seq<open[0].started.seq)?open:matching;
    if(owners.length!==1)throw Error('actual landed worker/current-run ownership is missing/ambiguous');
    const run=owners[0],owned=readOwnedRun(org,run.id),owner=requireController(owned,'brain');
    assertOwner(owned,{owner:run.owner,generation:run.owner_generation});
    const fresh=nativeSender(org,{cwd:workspace,env,...(call?{call}:{})});
    if(JSON.stringify(tuple(fresh))!==JSON.stringify(tuple(binding))||git(canonical,['rev-parse','HEAD'])!==head||git(workspace,['rev-parse','HEAD'])!==head||
      git(canonical,['status','--porcelain=v1'])||git(workspace,['status','--porcelain=v1']))throw Error('post-FF native/source CAS changed; exact landing time not recorded');
    const add=git(canonical,['rev-list','--reverse',`${base}..${head}`]).split('\n').filter(Boolean)
      .filter(commit=>!events.some(e=>e.type==='change.landed'&&e.item===run.item&&e.head===commit)).map(commit=>({
        type:'change.landed',item:run.item,run:run.id,head:commit,base:git(canonical,['rev-parse',`${commit}^1`]),project:project.identity,
        landed_at:landedAt,landing_tip:head,previous_main:base,producer:{agent:native.name,pane:native.pane_id,terminal:native.terminal_id,session:native.agent_session.value,ownership_generation:owner.generation}
      }));
    return protectRecordMutation({org,state,events,mutation:{add},command:'post-FF own landing receipt'});
  },{actor:binding.native.name,strictTail:true});
  return {recorded:true,changes:result.added.map(e=>({item:e.item,run:e.run,head:e.head,landed_at:e.landed_at}))};
}
