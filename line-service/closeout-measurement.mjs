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
import {appendPassJournal} from './pass-journal.mjs';
import {compactMeasurement} from './closeout-measurement-audit.mjs';
export {readCloseoutMeasurement} from './closeout-measurement-audit.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),moduleFile=fileURLToPath(import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');
const loadedHash=sha(fs.readFileSync(moduleFile));
let loadedCommit;
const ms=value=>Number.isFinite(Date.parse(value))?Date.parse(value):null;
const iso=value=>new Date(value).toISOString();
const inside=(child,parent)=>typeof child==='string'&&typeof parent==='string'&&(child===parent||child.startsWith(parent+path.sep));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const resourceNames=['session','folder','branch','author_packet'];
const terminal=e=>e.type==='report.ingested'||e.type==='run.abandoned'||e.type==='dispatch.completed'&&e.exit_code!==0;
export const measurementDirectory=(org,identity)=>path.join(org,'line-service',sha(JSON.stringify(identity)).slice(0,20));
export const historicalInventoryPaths=['r1176','sol-research','claude-research'].map(id=>`docs/evidence/ENG-864/${id}.json`);

const push=(map,key,value)=>{if(!map.has(key))map.set(key,[]);map.get(key).push(value);};
const obligationKey=(run,identity,source,key)=>JSON.stringify([run,identity,source?.seq,source?.type,key]);
function eventIndex(events){
  const index={state:fold(events),starts:new Map(),claims:new Map(),targets:new Map(),evaluations:new Map(),effects:new Map(),availability:new Map(),manual:new Map()};
  for(const e of events){
    if(e.type==='run.started')index.starts.set(e.id,e);
    if(e.type==='run.claimed')push(index.claims,e.run,e);
    for(const target of e.closeout_targets??[])push(index.targets,target.run,{target,source:{seq:e.seq,type:e.type}});
    if(e.type==='closeout.evaluated'||e.type==='closeout.effect')push(index[e.type==='closeout.effect'?'effects':'evaluations'],obligationKey(e.run,e.identity,e.source,e.key),e);
    if(e.type==='report.available')push(index.availability,e.run,e);
    if(e.type==='closeout.manual-assistance')push(index.manual,e.run,e);
  }
  return index;
}

// Include every terminal source in the owning record. Legacy/missing project and
// harness/dispatcher facts remain unknown buckets, never denominator filters.
export function closeoutCohort(events,project,index=eventIndex(events)){
  const {state}=index;
  return events.filter(terminal).map(source=>{
    const runId=source.run??(source.type==='run.abandoned'?source.id:null),run=state.runs.get(runId),
      start=index.starts.get(runId),
      claim=index.claims.get(runId)?.findLast(e=>e.seq<source.seq),
      binding=run?effectiveWorkerIdentity(run,state):{},
      candidates=(index.targets.get(runId)??[]).filter(({target:t,source:s})=>t.common===project.identity&&
        (!t.org||!start?.meta?.dispatch_record||t.org===start.meta.dispatch_record)&&
        (!t.project||t.project===project.canonical)&&(!run?.workspace||t.cwd===run.workspace)&&
        (!start||s.seq>=start.seq)&&(!t.allocation||t.allocation.run===runId&&t.allocation.started_seq===start?.seq&&t.allocation.claim_generation===(claim?.seq??null))),
      target=candidates.find(t=>t.source.seq===source.seq)?.target??candidates[0]?.target,
      common=source.project??start?.meta?.dispatch_project??target?.common??'unknown',
      harness=['codex','claude'].includes(run?.meta.harness)?run.meta.harness:'unknown',
      dispatch=start?.by==='line-service'?'line':/^supervisor-[a-z0-9_-]+$/.test(start?.by??'')?'supervisor':'unknown';
    return{id:sha(JSON.stringify([common,start?.seq??null,claim?.seq??null,source.seq])),run:runId??null,
      item:source.item??run?.item??null,project:common,harness,dispatch,source:{seq:source.seq,type:source.type},
      started_seq:start?.seq??null,claim_generation:claim?.seq??null,cwd:run?.workspace??target?.cwd??null,
      branch:target?.branch??null,head:target?.head??null,binding,at:source.at,
      report_sha256:source.sha256??null,outcome:source.report?.outcome??source.type,
      target_key:target?.key??null,obligations:candidates.filter(c=>c.target.common===common).map(c=>({...c.source,key:c.target.key,org:c.target.org,cwd:c.target.cwd}))};
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
function sliced(rows,project){
  const groups=new Map();for(const row of rows)push(groups,JSON.stringify([row.project,row.harness,row.dispatch]),row);
  const result=[];
  for(const p of new Set([project.identity,'unknown',...rows.map(r=>r.project)]))for(const harness of ['codex','claude','unknown'])for(const dispatch of ['line','supervisor','unknown'])
    result.push({project:p,harness,dispatch,...summary(groups.get(JSON.stringify([p,harness,dispatch]))??[])});
  return result;
}

// Pure oracle. Caller-supplied exclusions are exposed and fail; a later status,
// file mtime, absence or typed refusal cannot manufacture an effect receipt.
export function measureCloseouts({project,org,events,inventory,source,now=Date.now(),previous=null,historical=[],cohort,window=null,index=eventIndex(events),expected=closeoutCohort(events,project,index)}){
  const selected=cohort??expected,failures=[],expectedIds=new Set(expected.map(r=>r.id)),selectedIds=new Set(selected.map(r=>r.id));
  const windowValid=window&&typeof window.id==='string'&&window.id.length>0&&Number.isSafeInteger(window.after_seq)&&window.after_seq>=0&&ms(window.activated_at)!==null&&window.commit===source?.commit;
  if(window&&!windowValid)failures.push('measurement-window-invalid');
  if(!same(expected.map(r=>r.id).sort(),selected.map(r=>r.id).sort()))failures.push('cohort-exclusion-or-substitution');
  if(!events.length||events[0].seq>(windowValid?window.after_seq+1:1)||events.some((e,i)=>i&&e.seq!==events[i-1].seq+1))failures.push('record-coverage-incomplete');
  if(!source?.commit||!source.module_sha256||source.changed)failures.push('source-version-unproven');
  for(const kind of ['native','git','process'])if(inventory?.coverage?.[kind]!==true)failures.push(`${kind}-inventory-incomplete`);
  if(inventory?.errors?.length)failures.push('inventory-errors');
  const interval=previous?now-ms(previous.observed_at):null;
  if(previous&&(interval<0||interval>60000))failures.push('measurement-gap');
  if(previous&&(!same(previous.source,source)||previous.cutoff.seq>(events.at(-1)?.seq??0)))failures.push('source-or-record-window-changed');
  if(previous&&!same(previous.window_declaration??null,window))failures.push('measurement-window-changed');
  const trees=new Map((inventory?.worktrees??[]).map(t=>[t.worktree,t])),folders=new Map((inventory?.folders??[]).map(t=>[t.cwd,t])),branches=new Map((inventory?.branches??[]).map(t=>[t.branch.replace(/^refs\/heads\//,''),t]));
  const rows=expected.map(row=>{
    const errors=[],keys=new Set(row.obligations.filter(o=>(!o.org||o.org===org)&&o.cwd===row.cwd&&row.project===project.identity).map(o=>obligationKey(row.run,row.project,o,o.key))),
      evaluations=[...keys].flatMap(k=>index.evaluations.get(k)??[]).sort((a,b)=>a.seq-b.seq),first=evaluations[0],last=evaluations.at(-1),
      effects=[...keys].flatMap(k=>index.effects.get(k)??[]).sort((a,b)=>a.seq-b.seq),effectBySeq=new Map(effects.map(e=>[e.seq,e])),resources=last?.resources??{},
      proof=(ref,evaluation)=>{const e=effectBySeq.get(ref.seq);return e&&e.effect===ref.effect&&e.seq<evaluation.seq&&e.key===evaluation.key&&same(e.source,evaluation.source)?e:null;},
      // Each typed status must cite an actual source/key/effect-linked receipt.
      receipts=name=>[...(resources[name]?.receipts??[]),...(resources[name]?.receipt?[resources[name].receipt]:[])].map(ref=>proof(ref,last)).filter(Boolean),
      has=(name,actions)=>receipts(name).some(e=>actions.includes(e.outcome?.action)),
      sessionClosed=resources.session?.status==='closed'&&has('session',['closed']),
      folderRemoved=resources.folder?.status==='removed'&&has('folder',['worktree-removed','lane-removed']),
      liveBranch=row.branch?branches.get(row.branch.replace(/^refs\/heads\//,'')):null,
      branchReceipt=resources.branch?.status==='deleted'&&has('branch',['branch-removed'])||resources.branch?.status==='retained'&&has('branch',['branch-kept']),
      branchDone=branchReceipt&&Array.isArray(inventory?.branches)&&Boolean(row.branch)&&
        (resources.branch.status==='deleted'?!liveBranch:Boolean(liveBranch&&liveBranch.head===row.head)),
      packetDone=resources.author_packet?.status==='preserved'&&has('author_packet',['report-evidence'])&&Boolean(resources.author_packet.packet&&resources.author_packet.sha256),
      accounted=Boolean(first&&resourceNames.every(name=>{
        const r=first.resources?.[name],refs=[...(r?.receipts??[]),...(r?.receipt?[r.receipt]:[])],receipts=refs.map(ref=>proof(ref,first)).filter(Boolean);
        if(r?.status==='kept')return r.scope?.resource===name&&r.scope.run===row.run&&same(r.scope.source,first.source)&&r.scope.key===first.key&&r.scope.cwd===row.cwd&&r.reason&&r.evidence&&r.owner&&ms(r.first_seen)!==null&&r.continuation?.owner&&['pre-effect-observation','owner-evidence'].includes(r.continuation.kind)&&r.escalation?.owner;
        return receipts.some(e=>({session:['closed'],folder:['worktree-removed','lane-removed'],branch:['branch-kept','branch-removed'],author_packet:['report-evidence']})[name].includes(e.outcome?.action))&&({session:['closed'],folder:['removed'],branch:['retained','deleted'],author_packet:['preserved']})[name].includes(r?.status);
      })),
      availability=index.availability.get(row.run)?.find(e=>e.project===row.project&&e.sha256===row.report_sha256&&e.started_seq===row.started_seq&&e.claim_generation===row.claim_generation&&e.producer==='original-report-watcher'&&e.seq<row.source.seq),
      origin=row.source.type==='report.ingested'?ms(availability?.observed_at):ms(row.at),ageOrigin=origin??ms(row.at),
      elapsed=at=>origin!==null&&ms(at)!==null&&ms(at)>=origin?ms(at)-origin:null,
      closedAt=receipts('session').find(e=>e.outcome.action==='closed')?.at,
      removedAt=receipts('folder').find(e=>['worktree-removed','lane-removed'].includes(e.outcome.action))?.at,
      b=row.binding,
      native=(inventory?.agents??[]).filter(a=>b.pane&&a.pane_id===b.pane||b.terminal_id&&a.terminal_id===b.terminal_id||b.agent_session_id&&a.agent_session?.value===b.agent_session_id),
      panes=(inventory?.panes??[]).filter(p=>b.pane&&p.pane_id===b.pane||b.terminal_id&&p.terminal_id===b.terminal_id),
      tree=trees.get(row.cwd),folder=folders.get(row.cwd),
      open=native.length>0||panes.length>0,folderPresent=Boolean(tree)||folder?.present===true,
      nativeKnown=inventory?.coverage?.native===true&&Boolean(b.pane&&b.terminal_id&&b.agent_session_id)&&!b.identity_conflict,
      folderKnown=inventory?.coverage?.git===true&&typeof folder?.present==='boolean'&&(!tree||typeof tree.clean==='boolean'),
      vacancy=inventory?.coverage?.native===true&&!(inventory.agents??[]).some(a=>inside(a.cwd,row.cwd))&&!(inventory.panes??[]).some(p=>inside(p.foreground_cwd,row.cwd)),
      processes=vacancy?(inventory?.processes??[]).filter(p=>inside(p.cwd,row.cwd)):[],
      manual=(index.manual.get(row.run)??[]).filter(e=>e.project===row.project),
      unknownOrigin=Number(row.project==='unknown'||row.harness==='unknown'||row.dispatch==='unknown'),
      disappeared=Number(nativeKnown&&!open&&!sessionClosed)+Number(folderKnown&&!folderPresent&&!folderRemoved);
    if(!accounted)errors.push('allocation-not-accounted');
    if(last?.code?.code?.commit!==source?.commit)errors.push('old-or-unknown-runtime');
    if(!sessionClosed||!folderRemoved||!branchDone||!packetDone)errors.push('resource-proof-incomplete');
    if(!branchDone)errors.push('branch-inventory-unproven');
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
  const aggregate=summary(rows),slices=sliced(rows,project);
  const rowsByRun=new Map();for(const row of rows)push(rowsByRun,row.run,row);
  const historicalRows=historical.map(record=>{
    const selected=[...new Set(record.members.map(m=>m.run))].flatMap(run=>rowsByRun.get(run)??[]),excluded=record.members.filter(m=>!rowsByRun.has(m.run)),errors=[];
    if(record.availability==='missing')errors.push('historical-inventory-missing');
    if(record.inventory_complete===false)errors.push('historical-inventory-incomplete');
    if(excluded.length)errors.push('historical-cohort-unaccounted');
    return{id:record.id,cutoff:record.cutoff,source:record.source,file:record.file??null,
      availability:record.availability??'present',inventory_complete:record.inventory_complete??null,
      members:record.members,rows:selected,excluded,failures:errors,green:!errors.length&&summary(selected).green};
  });
  const historicalFailures=[];
  if(historical.some(r=>r.inventory_complete===false))historicalFailures.push('historical-inventory-incomplete');
  if(historicalRows.some(r=>r.excluded.length))historicalFailures.push('historical-cohort-unaccounted');
  if(!historical.length||historicalRows.some(r=>r.availability==='missing'))historicalFailures.push('historical-inventory-missing');
  const active=windowValid?rows.filter(r=>r.source.seq>window.after_seq):rows,legacy=windowValid?rows.filter(r=>r.source.seq<=window.after_seq):[];
  if(windowValid&&(window.after_seq>(events.at(-1)?.seq??0)||ms(window.activated_at)>now||active.some(r=>ms(r.at)===null||ms(r.at)<ms(window.activated_at))))failures.push('measurement-window-boundary-inconsistent');
  const activeSummary=summary(active);
  if(!windowValid)failures.push(...historicalFailures);
  for(const k of ['first_disposition','session_close'])if(activeSummary.latency[k].p95_ms>120000)failures.push(`${k}-p95`);
  if(!activeSummary.evidence)failures.push('empty-cohort');
  const windowGreen=!failures.length&&activeSummary.green;
  // Historical proof gaps cannot poison a declared new runtime window, but
  // retained legacy resources still fail the global absolute-zero gate.
  const absoluteGreen=['open_over_2h','clean_retained','orphan_processes'].every(k=>aggregate.counts[k]===0);
  if(!absoluteGreen)failures.push('absolute-retained-resources');
  return{schema:'closeout-measurement/v1',project:project.identity,org,observed_at:iso(now),source,
    cutoff:{seq:events.at(-1)?.seq??0,sha256:sha(JSON.stringify(events)),first_seq:events[0]?.seq??null},
    coverage:inventory?.coverage??{},interval_ms:interval,cohort:rows,exclusions:{omitted:expected.filter(r=>!selectedIds.has(r.id)).map(r=>r.id),unexpected:selected.filter(r=>!expectedIds.has(r.id)).map(r=>r.id)},
    window_declaration:window,window:windowValid?{...window,...activeSummary,slices:sliced(active,project),green:windowGreen}:null,
    legacy:{...summary(legacy),row_ids:legacy.map(r=>r.id)},historical_failures:historicalFailures,historical_green:historicalFailures.length===0&&historicalRows.every(r=>r.green),
    historical:historicalRows,aggregate,slices,failures,green:windowGreen&&absoluteGreen,
    release_acceptance:'UNRUN: sustained exposure, safety and final-notice delivery require coordinator evidence; this census grants no release authority'};
}

// Census uses existing read-only sources; failed source components are retained
// independently. A missing/redirected folder is not an automated removal.
export function collectCloseoutInventory({project,org,env=process.env,command=spawnSync,events,cohort,readProcesses=lookupProcess,readCwds=readLaneCwdReferences}){
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
    const seen=new Set();for(const row of cohort??closeoutCohort(events,project))if(row.cwd&&!seen.has(row.cwd)){
      seen.add(row.cwd);
      let present;try{const s=fs.lstatSync(row.cwd);present=s.isDirectory()&&!s.isSymbolicLink()?true:null;}catch(e){if(e.code==='ENOENT')present=false;else throw e;}
      result.folders.push({cwd:row.cwd,present});
    }
  }catch(e){result.errors.push({source:'git',reason:e.message});}
  try{
    // The existing reader uses root + path.sep; an empty root selects all absolute cwd paths.
    const refs=readCwds('',{command,env}),processes=readProcesses(undefined,{execute:command});
    if(!processes.ok)throw Error(processes.error);
    result.vanished_pids=refs.filter(r=>!processes.value.has(Number(r.job))).map(r=>Number(r.job));
    result.processes=refs.filter(r=>processes.value.has(Number(r.job))).map(r=>({pid:Number(r.job),cwd:r.cwd,identity:processes.value.get(Number(r.job))?.identity??null,ppid:processes.value.get(Number(r.job))?.ppid??null}));
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
// Historical inventories ship as evidence assets. Older/incomplete payloads
// Missing files keep their named cohort explicitly unknown/non-green; malformed,
// redirected or unreadable evidence retains the ordinary diagnostic failure.
function readHistoricalInventories(){
  return historicalInventoryPaths.map(relative=>{
    const file=path.join(root,relative),id=path.basename(relative,'.json');
    try{return{...JSON.parse(readPlainFile(file)),file,availability:'present'};}
    catch(e){if(e.code!=='ENOENT')throw e;return{id,file,availability:'missing',inventory_complete:false,cutoff:null,source:[],members:[]};}
  });
}
// Integration contract: call once AFTER each turn, outside record/native locks.
// The existing <=60s finite launchd wake calls that same turn during slow review.
// now is a function returning epoch milliseconds. Optional readers are test seams.
// Failures throw to the caller's existing diagnostic catch; never retry effects.
export function recordCloseoutTurn({project,org,env=process.env,now=()=>Date.now(),command=spawnSync,
  collect=collectCloseoutInventory,source:providedSource,historical:providedHistory,window:providedWindow}){
  const directory=plainDirectory(measurementDirectory(org,project.identity)),release=retirementLock(path.join(directory,'closeout-measurement.lock'));
  try{
    const file=path.join(directory,'closeout-measurement.json'),audit=path.join(directory,'closeout-measurements.jsonl');
    let previous=null;try{previous=JSON.parse(readPlainFile(file));if(previous.project!==project.identity||previous.org!==org)throw Error('measurement identity changed');}catch(e){if(e.code!=='ENOENT')throw e;}
    const loaded=loadEvents(org);if(loaded.tornTail)throw Error('incomplete measurement record tail');
    const git=args=>{const r=command('git',['-C',root,...args],{encoding:'utf8',env:{...env,GIT_OPTIONAL_LOCKS:'0'},timeout:10000});if(r.error||r.status!==0)throw Error('measurement source version unavailable');return r.stdout.trim();};
    let source=providedSource;
    if(!source){
      const bundle=bundleRelease(),commit=bundle.commit??git(['rev-parse','HEAD']);
      loadedCommit??=commit;
      source={root,commit,module_sha256:loadedHash,loaded_commit:loadedCommit,changed:sha(fs.readFileSync(moduleFile))!==loadedHash||commit!==loadedCommit};
    }
    const historical=providedHistory??readHistoricalInventories();
    let window=providedWindow;
    if(window===undefined)try{window=JSON.parse(readPlainFile(path.join(directory,'closeout-measurement-window.json')));}catch(e){if(e.code!=='ENOENT')throw e;window=null;}
    const index=eventIndex(loaded.events),cohort=closeoutCohort(loaded.events,project,index);
    const inventory=collect({project,org,env,command,events:loaded.events,cohort}),at=now(),doc=measureCloseouts({project,org,events:loaded.events,inventory,source,now:at,previous,historical,window,index,expected:cohort});
    doc.inventory=inventory;
    // Keep the immutable census before updating its display-only latest view.
    const frame=compactMeasurement(directory,doc);
    append(audit,frame);
    writeFileAtomic(file,JSON.stringify(frame)+'\n',0o600);
    appendPassJournal(path.join(directory,'passes.jsonl'),{at:doc.observed_at,action:'closeout-measurement',measurement:{file,cutoff:doc.cutoff,source:doc.source,green:doc.green,counts:doc.aggregate,failures:doc.failures,oldest:doc.cohort.filter(r=>r.failures.length).sort((a,b)=>(b.age_ms??0)-(a.age_ms??0)).slice(0,10).map(r=>({run:r.run,source:r.source,age_ms:r.age_ms,failures:r.failures,condition:r.condition}))}});
    const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    return{file,cutoff:doc.cutoff,green:doc.green,counts:doc.aggregate,failures:doc.failures};
  }finally{release();}
}
