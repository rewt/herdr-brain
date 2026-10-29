// The line disposes only an original, positively pre-native stopped request.
// Saved jobs stay immutable. UNKNOWN launches and Git effects never replay.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {loadEvents,planTransaction} from './store.mjs';
import {fold} from './state.mjs';
import {gitProject} from './project.mjs';
import {assertOwner,readOwnedRun} from './run-owner-guard.mjs';
import {protectRecordMutation} from './record-guard.mjs';
import {createRetirement} from './retire-runtime.mjs';
import {retirementLock} from './retire-lock.mjs';
import {lockRequest} from '../dispatch/request-lock.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {bindCloseoutCode} from './closeout-code.mjs';
import {outcomeFailure} from './uncertain-outcome.mjs';
import {effectiveWorkerIdentity} from './worker-identity.mjs';
import {nativeProcess} from '../dispatch/session-bind.mjs';
import {bindCloseoutSources,publishCloseoutEvents,retirementOwnerLock,closeoutRecordMatches,lineServiceOwnsCleanup,
  sameFileIdentity} from './closeout.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(cwd,args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
const nativeKeys=['agent','pane','worker_workspace','terminal_id','agent_session_id'];
const identity=file=>{const s=fs.lstatSync(file);return{dev:s.dev,ino:s.ino,birthtimeMs:s.birthtimeMs};};

export function stoppedAllocation(job,events,journal,hash){
  const preNative=job.native_launch_attempted===false&&!job.worker&&!job.launchProcess&&!job.sessionBinding&&!job.watcher&&
    ['start','worker'].includes(job.stage)&&['DISPATCH_INPUT_CHANGED','DISPATCH_SESSION_CAP_LOCKED'].includes(job.failure?.code)&&
    job.failure.native_launch_attempted===false&&
    (job.failure.code!=='DISPATCH_INPUT_CHANGED'||job.failure.launch_input?.journal===journal&&job.failure.launch_input?.token===job.token);
  const unprompted=job.native_launch_attempted===true&&['watch','prompt'].includes(job.stage)&&
    job.worker?.agentSessionId&&job.launchProcess?.identity&&Number.isSafeInteger(job.launchProcess.pid)&&
    !job.sessionBinding&&!job.resumeSession&&!job.resumeDeliveryProtocol&&job.failure?.native_launch_attempted===true;
  if((!preNative&&!unprompted)||job.failure?.stage!==job.stage||job.failure?.kind==='fence'||
      /EPERM|EACCES|native refusal|identity|ownership|unsafe|\bSTOP\b|\bHOLD\b/i.test(job.error??''))return null;
  const completed=events.findLast(e=>e.type==='dispatch.completed'&&e.project===job.common&&e.journal===journal&&
    e.attempt===job.token&&e.run===(job.run??null)&&Number.isInteger(e.exit_code)&&e.exit_code>0&&
    e.stage===job.stage&&e.native_launch_attempted===job.native_launch_attempted&&
    e.request_sha256===hash&&JSON.stringify(e.failure)===JSON.stringify(job.failure));
  if(!completed)return null;
  const state=fold(events),run=job.run?state.runs.get(job.run):null;
  if(job.run){
    if(!run||run.item!==job.item||run.workspace!==job.workspace||run.meta.dispatch_journal!==journal||
        run.meta.dispatch_attempt!==job.token||run.meta.dispatch_project!==job.common||run.meta.dispatch_record!==job.org||
        preNative&&(nativeKeys.some(k=>run.meta[k])||events.some(e=>(e.run===run.id||e.id===run.id)&&
          (e.type==='run.session_bound'||e.type==='run.updated'&&nativeKeys.some(k=>e.meta?.[k])))))return null;
    assertOwner(readOwnedRun(job.org,run.id,events),job.ownership);
    if(run.report||run.abandoned||state.items.get(job.item)?.runs.at(-1)!==run.id)return null;
    if(unprompted){
      const worker=effectiveWorkerIdentity(run,state),receipt=state.workerReceipts?.get(run.id),w=job.worker;
      if(worker.identity_conflict||!receipt||state.sessionBindings?.get(run.id)?.length||
          ['agent','pane','worker_workspace','terminal_id','agent_session_id'].some((k,i)=>
            !receipt[k]||receipt[k]!==[w.agentName,w.pane,w.workspaceId,w.terminalId,w.agentSessionId][i]||receipt[k]!==worker[k])||
          [...state.runs.values()].some(r=>r.id!==run.id&&(r.workspace===run.workspace||
            nativeKeys.some(k=>worker[k]&&worker[k]===effectiveWorkerIdentity(r,state)[k]))))return null;
    }
  }else if([...state.runs.values()].some(r=>r.workspace===job.workspace||r.meta?.dispatch_journal===journal))return null;
  if(unprompted&&!run)return null;
  return{source:{seq:completed.seq,type:completed.type},run,unprompted:Boolean(unprompted)};
}

function unpromptedObservation(job,adapter){
  const snapshot=adapter.observe(job.workspace,{globalPanes:true}),w=job.worker;
  if(snapshot.errors.length||!snapshot.nativeInventory?.complete)throw Error('unprompted allocation requires complete native inventory');
  const agents=snapshot.agents.filter(a=>a.name===w.agentName||a.pane_id===w.pane||a.terminal_id===w.terminalId||
    (a.agent_session?.value??a.agent_session_id)===w.agentSessionId||a.cwd===job.workspace||a.cwd?.startsWith(job.workspace+path.sep));
  const panes=snapshot.panes.filter(p=>p.pane_id===w.pane||p.terminal_id===w.terminalId);
  const a=agents[0],pane=panes[0];
  if(agents.length!==1||panes.length!==1||a.name!==w.agentName||a.pane_id!==w.pane||a.terminal_id!==w.terminalId||
      a.workspace_id!==w.workspaceId||a.cwd!==job.workspace||(a.agent_session?.value??a.agent_session_id)!==w.agentSessionId||
      !['idle','done'].includes(a.agent_status??a.status)||pane.pane_id!==w.pane||pane.terminal_id!==w.terminalId||pane.workspace_id!==w.workspaceId||
      pane.process_info?.process_tree_complete!==true)throw Error('unprompted original native occupant changed or active; keep');
  const rows=pane.process_info.process_tree_raw??pane.process_info.process_tree;
  const process=nativeProcess(a,pane.process_info,pid=>({ok:true,value:rows?.find(p=>p.pid===pid)??null}));
  if(process.pid!==job.launchProcess.pid||process.identity!==job.launchProcess.identity)
    throw Error('unprompted original native process birth changed; keep');
  return{kind:'original-unprompted-terminal',worker:w,process,session:w.agentSessionId,status:a.agent_status??a.status};
}

export function disposeStoppedAllocations({cwd,org,env=process.env,retirementOptions={},loadedCode,
  deadline=Date.now()+180000,maxTargets=1}={}){
  const project=gitProject(cwd),code=bindCloseoutCode(project,loadedCode),directory=path.join(org,'dispatch');
  const ownerGuard=()=>{
    code.verify();
    if(!closeoutRecordMatches(project,org,env)||!lineServiceOwnsCleanup(project,org))throw Error('stopped allocation requires current line ownership');
    for(const file of [path.join(project.canonical,'.lane/supervisor/STOP'),path.join(project.canonical,'.lane/supervisor/HOLD'),
      path.join(org,'line-service',sha(JSON.stringify(project.identity)).slice(0,20),'STOP')])
      if(fs.existsSync(file))throw Error('STOP/HOLD prevents stopped allocation disposal');
  };
  ownerGuard();
  const results=[];
  if(!fs.existsSync(directory))return{results};
  const observed=loadEvents(org).events,
    attempts=new Map(observed.filter(e=>e.type==='closeout.allocation-attempted'&&e.identity===project.identity).map(e=>[e.journal,e.seq])),histories=new Map();
  for(const event of observed.filter(e=>e.type==='closeout.allocation-effect'&&e.identity===project.identity)){
    const rows=histories.get(event.journal)??[];rows.push(event);histories.set(event.journal,rows);
  }
  for(const name of fs.readdirSync(directory).filter(n=>n.endsWith('.json')).sort((a,b)=>
      (attempts.get(path.join(directory,a))??0)-(attempts.get(path.join(directory,b))??0)||a.localeCompare(b))){
    if(Date.now()>=deadline||results.length>=maxTargets)break;
    const journal=path.join(directory,name);
    let release,owner,admitted;
    try{
      if(!fs.lstatSync(journal).isFile()||fs.realpathSync(journal)!==journal)continue;
      const bytes=fs.readFileSync(journal),job=JSON.parse(bytes),hash=sha(bytes);
      const key=sha(JSON.stringify([project.identity,journal,hash,'stopped-allocation'])),
        history=(histories.get(journal)??[]).filter(e=>e.key===key),
        saved=history.findLast(e=>e.outcome.action==='lane-preflight')?.outcome;
      if(job.common!==project.identity||job.repo!==project.canonical||job.org!==org||name!==`${job.token}.json`||
          !/^[a-z0-9][a-z0-9-]{1,60}$/.test(job.lane??'')||
          !job.workspace||!fs.existsSync(job.workspace)&&!saved||history.some(e=>e.outcome.action==='lane-removed')||
          observed.some(e=>e.type==='closeout.allocation-kept'&&e.identity===project.identity&&e.key===key&&
            (e.failure?.kind==='fence'||/EPERM|EACCES|native refusal|operation not permitted|permission denied/i.test(e.reason??'')))||
          !stoppedAllocation(job,loadEvents(org).events,journal,hash))continue;
      admitted={key,identity:project.identity,journal,request_sha256:hash,item:job.item};
      planTransaction(org,()=>({add:[{type:'closeout.allocation-attempted',...admitted}]}),{actor:'line stopped allocation',strictTail:true});
      release=lockRequest(journal);
      owner=retirementLock(retirementOwnerLock(project.identity),{deadline});
      const exists=fs.existsSync(job.workspace),target=exists?gitProject(job.workspace):null,branch=`lane/${job.lane}`,
        head=exists?git(job.workspace,['rev-parse','HEAD']):saved.tip;
      if(exists&&(target.identity!==project.identity||target.checkout!==job.workspace||target.checkout===project.canonical||
          git(job.workspace,['symbolic-ref','--short','HEAD'])!==branch)||head!==job.base||
          !exists&&(saved.cwd!==job.workspace||saved.branch!==branch||!saved.evidence))throw Error('stopped allocation source identity changed');
      const treeIdentity=exists?identity(job.workspace):saved.worktreeIdentity,
        gitDir=exists?git(job.workspace,['rev-parse','--absolute-git-dir']):null,gitIdentity=exists?identity(gitDir):null,
        log=path.join(project.identity,'logs/refs/heads',branch),logIdentity=saved?.branchGeneration.identity??identity(log),
        logHash=saved?.branchGeneration.sha256??sha(fs.readFileSync(log));
      const original=stoppedAllocation(job,loadEvents(org).events,journal,hash);
      const guard=()=>{
        ownerGuard();
        if(fs.readFileSync(journal+'.lock','utf8')!==String(process.pid)||!fs.readFileSync(journal).equals(bytes))throw Error('stopped allocation request CAS changed');
        const loaded=loadEvents(org);if(loaded.tornTail)throw Error('incomplete stopped allocation record');
        if(!stoppedAllocation(job,loaded.events,journal,hash))throw Error('stopped allocation original claim/finality changed');
        if(loaded.events.some(e=>e.type==='closeout.effect'&&e.outcome?.cwd===job.workspace)||
            loaded.events.some(e=>e.type==='closeout.command-failed'&&e.run===job.run&&job.run))throw Error('original allocation effect remains held');
        if(fs.existsSync(job.workspace)&&(!exists||!sameFileIdentity(job.workspace,treeIdentity)||!sameFileIdentity(gitDir,gitIdentity)||
            git(job.workspace,['rev-parse','HEAD'])!==head||gitProject(job.workspace).identity!==project.identity))throw Error('stopped allocation worktree generation changed');
        if(fs.existsSync(log)&&(!sameFileIdentity(log,logIdentity)||sha(fs.readFileSync(log))!==logHash))throw Error('stopped allocation branch generation changed');
      };
      guard();
      if(original.run){
        const adapter=original.unprompted&&createRetirement({...retirementOptions,cwd,org,env,deadline,requireRecord:true,guard});
        const result=planTransaction(org,(events,state)=>{
          guard();
          const native=adapter&&unpromptedObservation(job,adapter);
          if(native&&git(job.workspace,['status','--porcelain=v1','--untracked-files=all']))throw Error('unprompted allocation has unsaved work; keep');
          guard();
          const add=[{type:'dispatch.allocation-finalized',project:project.identity,journal,request_sha256:hash,
            run:job.run,item:job.item,source:original.source,disposition:native?'NOT_PROMPTED':'NOT_STARTED',native_completion:false,
            ...(native?{proof:native}:{})},
          {type:'run.abandoned',id:job.run,note:native?'Original dispatch stopped before prompt delivery; original idle worker and process verified by the line.':
            'Original dispatch stopped before native launch; clean allocation released by the line.',
            producer:{journal,attempt:job.token,request_sha256:hash},authorization:{kind:native?'positive-unprompted-stopped-allocation':'positive-pre-native-stopped-allocation',source:original.source,
              ...(native?{proof:native}:{})}}];
          return bindCloseoutSources({cwd,org,events,mutation:protectRecordMutation({org,events,state,command:'stopped allocation disposition',mutation:{add}})});
        },{actor:'line stopped allocation',strictTail:true});
        publishCloseoutEvents({cwd,org,env,added:result.added,start:false});
        results.push({journal,run:job.run,disposition:original.unprompted?'NOT_PROMPTED':'NOT_STARTED',source:original.source});
        continue;
      }
      const prior=loadEvents(org).events.filter(e=>e.type==='closeout.allocation-effect'&&e.key===key);
      if(prior.some(e=>e.outcome.action==='lane-removed'))continue;
      if(prior.some(e=>e.outcome.action==='git-removal-started'&&!prior.some(end=>end.outcome.action==='git-removal-finished'&&
          end.seq>e.seq&&Number.isSafeInteger(end.outcome.exit_status)&&end.outcome.exit_status>=0&&!end.outcome.code&&
          ['attempt','operation','cwd','branch','tip','evidence','branchGeneration'].every(k=>JSON.stringify(end.outcome[k])===JSON.stringify(e.outcome[k])))))
        throw Error('original stopped allocation Git outcome UNKNOWN; keep');
      const adapter=createRetirement({...retirementOptions,cwd,org,env,deadline,requireRecord:true,guard,
        lockRemoval:()=>acquireLock(path.join(project.identity,'lane-promote.lock')),
        log:row=>{
          retirementOptions.log?.(row);
          if(!['lane-preflight','lane-evidence-discarded','git-removal-started','git-removal-finished','worktree-removed','branch-removed','lane-removed',
            'workspace-close-requested','closed'].includes(row.action))return;
          planTransaction(org,()=>({add:[{type:'closeout.allocation-effect',key,identity:project.identity,journal,request_sha256:hash,
            item:job.item,source:original.source,outcome:row}]}),{actor:'line stopped allocation',strictTail:true});
        }});
      const removed=exists?adapter.removeLane({lane:job.workspace,branch,expectedTip:head,gitOnly:true}):adapter.resumeLaneRemoval(saved);
      results.push({journal,disposition:'removed',pending:removed.pending,source:original.source});
    }catch(error){
      if(error.code==='CLOSEOUT_CODE_CHANGED')throw error;
      if(admitted)planTransaction(org,events=>({add:events.some(e=>e.type==='closeout.allocation-kept'&&e.key===admitted.key&&e.reason===error.message)?[]:
        [{type:'closeout.allocation-kept',...admitted,reason:error.message,failure:outcomeFailure(error),disposition:'kept'}]}),{actor:'line stopped allocation',strictTail:true});
      results.push({journal,disposition:'kept',reason:error.message});
    }finally{try{owner?.();}finally{release?.release();}}
  }
  return{results};
}
