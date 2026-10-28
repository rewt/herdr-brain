// Read-only census owned by the existing finite project-service wake. No native
// effects, record writes, retry authority, model observer or background loop.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {loadEvents} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';
import {readRetirementWorktrees} from '../lib/retire-runtime.mjs';
import {readLaneCwdReferences} from '../lib/lane-removal.mjs';
import {lookupProcess} from '../lib/processes.mjs';
import {plainDirectory,readPlainFile,writeFileAtomic} from '../lib/files.mjs';
import {retirementLock} from '../lib/retire-lock.mjs';
import {bundleRelease} from '../lib/releases.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),moduleFile=fileURLToPath(import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');
const loadedHash=sha(fs.readFileSync(moduleFile));
const loadedCommit=(()=>{const r=spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',timeout:10000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});return r.status===0?r.stdout.trim():bundleRelease().commit;})();
const ms=value=>Number.isFinite(Date.parse(value))?Date.parse(value):null;
const iso=value=>new Date(value).toISOString();
const inside=(child,parent)=>typeof child==='string'&&typeof parent==='string'&&(child===parent||child.startsWith(parent+path.sep));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const resourceNames=['session','folder','branch','author_packet'];
const terminal=e=>e.type==='report.ingested'||e.type==='run.abandoned'||e.type==='dispatch.completed'&&e.exit_code!==0;
export const measurementDirectory=(org,identity)=>path.join(org,'line-service',sha(JSON.stringify(identity)).slice(0,20));

// Include every terminal source in the owning record. Legacy/missing project and
// harness/dispatcher facts remain unknown buckets, never denominator filters.
export function closeoutCohort(events,project){
  const state=fold(events);
  return events.filter(terminal).map(source=>{
    const runId=source.run??(source.type==='run.abandoned'?source.id:null),run=state.runs.get(runId),
      start=events.find(e=>e.type==='run.started'&&e.id===runId),
      claim=events.findLast(e=>e.type==='run.claimed'&&e.run===runId&&e.seq<source.seq),
      binding=run?effectiveWorkerIdentity(run,state):{},
      target=source.closeout_targets?.find(t=>t.common===project.identity),
      common=source.project??start?.meta?.dispatch_project??target?.common??'unknown',
      harness=['codex','claude'].includes(run?.meta.harness)?run.meta.harness:'unknown',
      dispatch=start?.by==='line-service'?'line':/^supervisor-[a-z0-9_-]+$/.test(start?.by??'')?'supervisor':'unknown';
    return{id:sha(JSON.stringify([common,start?.seq??null,claim?.seq??null,source.seq])),run:runId??null,
      item:source.item??run?.item??null,project:common,harness,dispatch,source:{seq:source.seq,type:source.type},
      started_seq:start?.seq??null,claim_generation:claim?.seq??null,cwd:run?.workspace??target?.cwd??null,
      branch:target?.branch??null,head:target?.head??null,binding,at:source.at,
      report_sha256:source.sha256??null,outcome:source.report?.outcome??source.type,
      target_key:target?.key??null};
  });
}
const percentile=values=>{
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  return{known:sorted.length,p95_ms:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null,max_ms:sorted.at(-1)??null};
};
function summary(rows){
  const latency=Object.fromEntries(['ingest','first_disposition','session_close','folder_removal'].map(k=>[k,{...percentile(rows.map(r=>r.latency[k])),unknown:rows.filter(r=>r.latency[k]===null).length}])),
    unique=values=>new Set(values.map(v=>JSON.stringify(v))).size,
    session=r=>[r.project,r.binding.pane,r.binding.terminal_id,r.binding.agent_session_id],
    folder=r=>[r.project,r.cwd];
  return{denominator:rows.length,evidence:rows.length>0,accounted:rows.filter(r=>r.accounted).length,
    green:rows.length>0&&rows.every(r=>r.failures.length===0)&&['first_disposition','session_close'].every(k=>latency[k].p95_ms!==null&&latency[k].p95_ms<=120000),
    counts:{open_over_2h:unique(rows.filter(r=>r.open_over_2h).map(session)),
      clean_retained:unique(rows.filter(r=>r.clean_retained).map(folder)),dirty_retained:unique(rows.filter(r=>r.dirty_retained).map(folder)),
      orphan_processes:unique(rows.flatMap(r=>r.orphan_process_receipts.map(p=>[p.pid,p.identity]))),
      manual_cleanup:unique(rows.flatMap(r=>r.manual_receipts.map(e=>e.seq))),
      unexplained_disappearance:unique(rows.flatMap(r=>r.disappeared_resources.map(resource=>[r.project,r.started_seq,r.claim_generation,resource]))),
      unknown_origin:rows.filter(r=>r.unknown_origin).length},
    oldest_exception_ms:Math.max(0,...rows.filter(r=>r.failures.length).map(r=>r.age_ms??0)),latency};
}

// Pure oracle. Caller-supplied exclusions are exposed and fail; a later status,
// file mtime, absence or typed refusal cannot manufacture an effect receipt.
export function measureCloseouts({project,org,events,inventory,source,now=Date.now(),previous=null,historical=[],cohort}){
  const expected=closeoutCohort(events,project),selected=cohort??expected,failures=[];
  if(!same(expected.map(r=>r.id).sort(),selected.map(r=>r.id).sort()))failures.push('cohort-exclusion-or-substitution');
  if(!events.length||events[0].seq!==1)failures.push('record-coverage-incomplete');
  if(!source?.commit||!source.module_sha256||source.changed)failures.push('source-version-unproven');
  for(const kind of ['native','git','process'])if(inventory?.coverage?.[kind]!==true)failures.push(`${kind}-inventory-incomplete`);
  if(inventory?.errors?.length)failures.push('inventory-errors');
  const interval=previous?now-ms(previous.observed_at):null;
  if(previous&&(interval<0||interval>60000))failures.push('measurement-gap');
  if(previous&&(!same(previous.source,source)||previous.cutoff.seq>(events.at(-1)?.seq??0)))failures.push('source-or-record-window-changed');
  const rows=expected.map(row=>{
    const errors=[],scoped=e=>e.identity===project.identity&&e.run===row.run&&same(e.source,row.source)&&(!row.target_key||e.key===row.target_key),
      evaluations=events.filter(e=>e.type==='closeout.evaluated'&&scoped(e)),first=evaluations[0],last=evaluations.at(-1),
      effects=events.filter(e=>e.type==='closeout.effect'&&scoped(e)),resources=last?.resources??{},
      // Each typed status must cite an actual source/key/effect-linked receipt.
      receipts=name=>[...(resources[name]?.receipts??[]),...(resources[name]?.receipt?[resources[name].receipt]:[])].map(ref=>effects.find(e=>e.seq===ref.seq&&e.effect===ref.effect)).filter(Boolean),
      has=(name,actions)=>receipts(name).some(e=>actions.includes(e.outcome?.action)),
      sessionClosed=resources.session?.status==='closed'&&has('session',['closed']),
      folderRemoved=resources.folder?.status==='removed'&&has('folder',['worktree-removed','lane-removed']),
      branchDone=resources.branch?.status==='deleted'&&has('branch',['branch-removed'])||resources.branch?.status==='retained'&&has('branch',['branch-kept']),
      packetDone=resources.author_packet?.status==='preserved'&&has('author_packet',['report-evidence'])&&Boolean(resources.author_packet.packet&&resources.author_packet.sha256),
      accounted=Boolean(first&&resourceNames.every(name=>{
        const r=first.resources?.[name],refs=[...(r?.receipts??[]),...(r?.receipt?[r.receipt]:[])],proof=refs.map(ref=>effects.find(e=>e.seq===ref.seq&&e.effect===ref.effect&&e.seq<first.seq)).filter(Boolean);
        if(r?.status==='kept')return r.scope?.resource===name&&r.scope.run===row.run&&same(r.scope.source,row.source)&&r.scope.key===first.key&&r.scope.cwd===row.cwd&&r.reason&&r.evidence&&r.owner&&ms(r.first_seen)!==null&&r.continuation?.owner&&['pre-effect-observation','owner-evidence'].includes(r.continuation.kind)&&r.escalation?.owner;
        return proof.some(e=>({session:['closed'],folder:['worktree-removed','lane-removed'],branch:['branch-kept','branch-removed'],author_packet:['report-evidence']})[name].includes(e.outcome?.action))&&({session:['closed'],folder:['removed'],branch:['retained','deleted'],author_packet:['preserved']})[name].includes(r?.status);
      })),
      availability=events.find(e=>e.type==='report.available'&&e.run===row.run&&e.project===row.project&&e.sha256===row.report_sha256&&e.started_seq===row.started_seq&&e.claim_generation===row.claim_generation&&e.producer==='original-report-watcher'&&e.seq<row.source.seq),
      origin=ms(availability?.observed_at),ageOrigin=origin??ms(row.at),
      elapsed=at=>origin!==null&&ms(at)!==null&&ms(at)>=origin?ms(at)-origin:null,
      closedAt=receipts('session').find(e=>e.outcome.action==='closed')?.at,
      removedAt=receipts('folder').find(e=>['worktree-removed','lane-removed'].includes(e.outcome.action))?.at,
      b=row.binding,
      native=(inventory?.agents??[]).filter(a=>a.pane_id===b.pane||b.terminal_id&&a.terminal_id===b.terminal_id||b.agent_session_id&&a.agent_session?.value===b.agent_session_id),
      panes=(inventory?.panes??[]).filter(p=>p.pane_id===b.pane||b.terminal_id&&p.terminal_id===b.terminal_id),
      tree=(inventory?.worktrees??[]).find(t=>t.worktree===row.cwd),
      folder=(inventory?.folders??[]).find(t=>t.cwd===row.cwd),
      open=native.length>0||panes.length>0,folderPresent=Boolean(tree)||folder?.present===true,
      nativeKnown=inventory?.coverage?.native===true&&Boolean(b.pane&&b.terminal_id&&b.agent_session_id)&&!b.identity_conflict,
      folderKnown=inventory?.coverage?.git===true&&typeof folder?.present==='boolean'&&(!tree||typeof tree.clean==='boolean'),
      vacancy=inventory?.coverage?.native===true&&!(inventory.agents??[]).some(a=>inside(a.cwd,row.cwd))&&!(inventory.panes??[]).some(p=>inside(p.foreground_cwd,row.cwd)),
      processes=vacancy?(inventory?.processes??[]).filter(p=>inside(p.cwd,row.cwd)):[],
      manual=events.filter(e=>e.type==='closeout.manual-assistance'&&e.run===row.run&&e.project===row.project),
      unknownOrigin=Number(row.project==='unknown'||row.harness==='unknown'||row.dispatch==='unknown'),
      disappeared=Number(nativeKnown&&!open&&!sessionClosed)+Number(folderKnown&&!folderPresent&&!folderRemoved);
    if(!accounted)errors.push('allocation-not-accounted');
    if(last?.code?.code?.commit!==source?.commit)errors.push('old-or-unknown-runtime');
    if(!sessionClosed||!folderRemoved||!branchDone||!packetDone)errors.push('resource-proof-incomplete');
    if(!nativeKnown||!folderKnown)errors.push('allocation-inventory-unknown');
    if(disappeared)errors.push('unexplained-disappearance');
    if(manual.length)errors.push('manual-assistance');
    if(unknownOrigin)errors.push('unknown-origin');
    if(open||folderPresent||processes.length)errors.push('retained-resources');
    if(row.source.type==='report.ingested'&&origin===null)errors.push('availability-origin-unknown');
    const latency={ingest:elapsed(row.at),first_disposition:elapsed(first?.at),session_close:elapsed(closedAt),folder_removal:elapsed(removedAt)};
    if(Object.values(latency).some(v=>v===null))errors.push('latency-unknown');
    if(latency.first_disposition>120000||latency.session_close>300000)errors.push('latency-limit');
    // A refusal without original native evidence remains a bad metric, even if
    // prose or a structured label calls it justified. Never edit the refusal.
    const condition=last?.condition;
    if(['native-refusal','legacy-refusal'].includes(condition?.kind)&&!effects.some(e=>e.outcome?.failure?.kind==='fence'||e.outcome?.action==='native-refused'))errors.push('refusal-evidence-unproven');
    return{...row,availability:availability?{seq:availability.seq,observed_at:availability.observed_at,sha256:availability.sha256}:null,
      ingest_at:row.at,first_disposition_at:first?.at??null,session_closed_at:closedAt??null,folder_removed_at:removedAt??null,
      first_turn:first?{seq:first.seq,resources:first.resources??null}:null,resources,effect_receipts:effects,
      condition:condition??null,holds:evaluations.filter(e=>e.condition||resourceNames.some(k=>e.resources?.[k]?.status==='kept')).map(e=>({seq:e.seq,at:e.at,condition:e.condition??null,resources:e.resources??null})),
      accounted,age_ms:ageOrigin===null?null:Math.max(0,now-ageOrigin),latency,
      open_over_2h:Number(open&&ageOrigin!==null&&now-ageOrigin>7200000),clean_retained:Number(folderPresent&&tree?.clean===true),dirty_retained:Number(folderPresent&&tree?.clean===false),
      orphan_processes:processes.length,orphan_process_receipts:processes,manual_cleanup:manual.length,manual_receipts:manual,unexplained_disappearance:disappeared,disappeared_resources:[...(nativeKnown&&!open&&!sessionClosed?['session']:[]),...(folderKnown&&!folderPresent&&!folderRemoved?['folder']:[])],unknown_origin:unknownOrigin,failures:errors};
  });
  const aggregate=summary(rows),slices=[];
  for(const p of new Set([project.identity,'unknown',...rows.map(r=>r.project)]))for(const harness of ['codex','claude','unknown'])for(const dispatch of ['line','supervisor','unknown'])
    slices.push({project:p,harness,dispatch,...summary(rows.filter(r=>r.project===p&&r.harness===harness&&r.dispatch===dispatch))});
  const historicalRows=historical.map(record=>({id:record.id,cutoff:record.cutoff,source:record.source,
    members:record.members,rows:rows.filter(r=>record.members.some(m=>m.run===r.run)),excluded:record.members.filter(m=>!rows.some(r=>r.run===m.run))}));
  if(historical.some(r=>r.inventory_complete===false))failures.push('historical-inventory-incomplete');
  if(historicalRows.some(r=>r.excluded.length))failures.push('historical-cohort-unaccounted');
  if(!historical.length)failures.push('historical-inventory-missing');
  for(const k of ['first_disposition','session_close'])if(aggregate.latency[k].p95_ms>120000)failures.push(`${k}-p95`);
  if(!aggregate.evidence)failures.push('empty-cohort');
  return{schema:'closeout-measurement/v1',project:project.identity,org,observed_at:iso(now),source,
    cutoff:{seq:events.at(-1)?.seq??0,sha256:sha(JSON.stringify(events)),first_seq:events[0]?.seq??null},
    coverage:inventory?.coverage??{},interval_ms:interval,cohort:rows,exclusions:{omitted:expected.filter(r=>!selected.some(e=>e.id===r.id)).map(r=>r.id),unexpected:selected.filter(r=>!expected.some(e=>e.id===r.id)).map(r=>r.id)},
    historical:historicalRows,aggregate,slices,failures,green:!failures.length&&aggregate.green,
    release_acceptance:'UNRUN: sustained exposure, safety and final-notice delivery require coordinator evidence; this census grants no release authority'};
}

// Census uses existing read-only sources; failed source components are retained
// independently. A missing/redirected folder is not an automated removal.
export function collectCloseoutInventory({project,org,env=process.env,command=spawnSync,events,readProcesses=lookupProcess,readCwds=readLaneCwdReferences}){
  const result={coverage:{native:false,git:false,process:false},errors:[],agents:[],panes:[],worktrees:[],folders:[],processes:[]};
  const call=(exe,args)=>{const r=command(exe,args,{cwd:project.canonical,env:{...env,GIT_OPTIONAL_LOCKS:'0'},encoding:'utf8',maxBuffer:64*1024*1024,timeout:10000});if(r.error||r.status!==0)throw Error(r.stderr||r.error?.message||`exit ${r.status}`);return r.stdout;};
  try{
    const native=args=>JSON.parse(call(env.HERDR_BIN_PATH??'herdr',args)).result,array=(v,name)=>{if(!Array.isArray(v))throw Error(`incomplete ${name}`);return v;};
    result.workspaces=array(native(['workspace','list']).workspaces,'workspaces');
    result.agents=array(native(['agent','list']).agents,'agents');
    for(const ws of result.workspaces)result.panes.push(...array(native(['pane','list','--workspace',ws.workspace_id]).panes,'panes'));
    result.coverage.native=true;
  }catch(e){result.errors.push({source:'native',reason:e.message});}
  try{
    result.branches=call('git',['--git-dir',project.identity,'for-each-ref','--format=%(refname:short)%00%(objectname)','refs/heads/lane/']).trim().split('\n').filter(Boolean).map(line=>{const [branch,head]=line.split('\0');return{branch,head};});
    result.worktrees=readRetirementWorktrees(project.identity,{main:'main',command,env,sweep:true});
    result.coverage.git=!result.worktrees.some(t=>t.error);
    for(const row of closeoutCohort(events,project))if(row.cwd&&!result.folders.some(r=>r.cwd===row.cwd)){
      let present;try{const s=fs.lstatSync(row.cwd);present=s.isDirectory()&&!s.isSymbolicLink()?true:null;}catch(e){if(e.code==='ENOENT')present=false;else throw e;}
      result.folders.push({cwd:row.cwd,present});
    }
  }catch(e){result.errors.push({source:'git',reason:e.message});}
  try{
    // The existing reader uses root + path.sep; an empty root selects all absolute cwd paths.
    const refs=readCwds('',{command,env}),processes=readProcesses(undefined,{execute:command});
    if(!processes.ok)throw Error(processes.error);
    result.processes=refs.map(r=>({pid:Number(r.job),cwd:r.cwd,identity:processes.value.get(Number(r.job))?.identity??null,ppid:processes.value.get(Number(r.job))?.ppid??null}));
    result.coverage.process=result.processes.every(r=>r.identity!==null);
  }catch(e){result.errors.push({source:'process',reason:e.message});}
  return result;
}
function append(file,row){
  const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);
  try{const stat=fs.fstatSync(fd);if(!stat.isFile())throw Error('measurement journal is not regular');
    if(stat.size){const end=Buffer.alloc(1);fs.readSync(fd,end,0,1,stat.size-1);if(end[0]!==10)throw Error('incomplete measurement audit tail; preserve original bytes');}
    fs.writeFileSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
}
// Integration contract: call once AFTER each turn, outside record/native locks.
// The existing <=60s finite launchd wake calls that same turn during slow review.
// now is a function returning epoch milliseconds. Optional readers are test seams.
// Failures throw to the caller's existing diagnostic catch; never retry effects.
export function recordCloseoutTurn({project,org,env=process.env,now=()=>Date.now(),command=spawnSync,
  collect=collectCloseoutInventory,source:providedSource,historical:providedHistory}){
  const directory=plainDirectory(measurementDirectory(org,project.identity)),release=retirementLock(path.join(directory,'closeout-measurement.lock'));
  try{
    const file=path.join(directory,'closeout-measurement.json'),audit=path.join(directory,'closeout-measurements.jsonl');
    let previous=null;try{previous=JSON.parse(readPlainFile(file));if(previous.project!==project.identity||previous.org!==org)throw Error('measurement identity changed');}catch(e){if(e.code!=='ENOENT')throw e;}
    const loaded=loadEvents(org);if(loaded.tornTail)throw Error('incomplete measurement record tail');
    const git=args=>{const r=command('git',['-C',root,...args],{encoding:'utf8',env:{...env,GIT_OPTIONAL_LOCKS:'0'},timeout:10000});if(r.error||r.status!==0)throw Error('measurement source version unavailable');return r.stdout.trim();};
    const bundle=bundleRelease(),source=providedSource??{root,commit:bundle.commit??git(['rev-parse','HEAD']),module_sha256:loadedHash,loaded_commit:loadedCommit,changed:sha(fs.readFileSync(moduleFile))!==loadedHash||(!bundle.commit&&git(['rev-parse','HEAD'])!==loadedCommit)};
    const historical=providedHistory??['r1176','sol-research','claude-research'].map(id=>JSON.parse(readPlainFile(path.join(root,'docs/evidence/ENG-864',`${id}.json`))));
    const inventory=collect({project,org,env,command,events:loaded.events}),at=now(),doc=measureCloseouts({project,org,events:loaded.events,inventory,source,now:at,previous,historical});
    doc.inventory=inventory;
    // Keep the immutable census before updating its display-only latest view.
    append(audit,doc);
    writeFileAtomic(file,JSON.stringify(doc)+'\n',0o600);
    append(path.join(directory,'passes.jsonl'),{at:doc.observed_at,action:'closeout-measurement',measurement:{file,cutoff:doc.cutoff,source:doc.source,green:doc.green,counts:doc.aggregate,failures:doc.failures,oldest:doc.cohort.filter(r=>r.failures.length).sort((a,b)=>(b.age_ms??0)-(a.age_ms??0)).slice(0,10).map(r=>({run:r.run,source:r.source,age_ms:r.age_ms,failures:r.failures,condition:r.condition}))}});
    const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    return{file,cutoff:doc.cutoff,green:doc.green,counts:doc.aggregate,failures:doc.failures};
  }finally{release();}
}
