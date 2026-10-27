// One explicit owning-record conversion, never an automatic unhold sweep.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {loadRecord,transact} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {queuePolicy} from './priority-order.mjs';
import {itemLaunchHold} from '../lib/item-launch-hold.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';
import {readOwnedRun,requireController,assertOwner,ownerBinding} from '../lib/run-owner-guard.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {lineDirectory} from './cutoff.mjs';
import {parseArgs,isMain} from '../lib/cli-help.mjs';

export const priorityOnlyReason='Phase 0 operator queue: defer unstarted historical backlog below finishing owned work, stable Brain release, BCH adoption, rehearsal publication and Chipnet withdrawal. Preserve original priority/dependencies/history; not dropped or completed. Reconsider after Phase 0.';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reserved=i=>i.role==='human'||i.meta.reserved||i.meta.operator_reserved||['security','funds-and-chain','publish','delete-data','licensing','priorities'].includes(i.meta.category);

export function priorityMigrationPlan({state,events,attempted=[],authority}) {
  const policy=queuePolicy(state);
  if(!policy||!authority)throw Error('priority migration needs an existing standing order and its adopted authority');
  const changes=[],retained=[],unknown=new Set(attempted);
  for(const item of state.items.values()){
    if(item.closed||!item.meta.hold&&!item.meta.held)continue;
    const history=events.filter(e=>(e.id??e.item)===item.id);
    const write=history.findLast(e=>e.type==='item.updated'&&e.fields?.meta?.hold===true);
    const prior=write&&item.meta.queue_selected===true&&policy.order.includes(item.meta.queue_class)&&fold(events.filter(e=>e.seq<write.seq)).items.get(item.id);
    // Exact positive provenance, not a keyword interpretation of a hold.
    // Notes and an earlier independent hold are deliberately conservative.
    let reason;
    if(item.meta.hold!==true||item.meta.held||item.meta.hold_reason!==priorityOnlyReason||write?.fields.meta.hold_reason!==priorityOnlyReason)reason='not the exact priority-only disposition';
    else if(item.meta.queue_selected!==true||!policy.order.includes(item.meta.queue_class))reason='not explicitly selected into an on-path outcome';
    else if(item.runs.length||unknown.has(item.id))reason='existing run or saved/UNKNOWN effect';
    else if(reserved(item))reason='reserved subject';
    else if(prior?.meta.hold||prior?.meta.held||item.notes.some(n=>/\b(hold|held|STOP|reserved|UNKNOWN|refus\w*)\b/i.test(n.text)))reason='independent or ambiguous hold evidence';
    if(reason){retained.push({item:item.id,reason});continue;}
    changes.push({id:item.id,subject:hash(item),before:structuredClone(item.meta),after:{...item.meta,hold:false},hold_seq:write.seq});
  }
  const owner=state.items.get(policy.owner);
  if(policy.default==null&&policy.order.includes('stable-Brain-release'))changes.unshift({id:owner.id,subject:hash(owner),before:structuredClone(owner.meta),after:{...owner.meta,queue_default:'stable-Brain-release'}});
  return {schema:'line-priority-migration/v1',authority,policy,changes,retained};
}

export function priorityMigrationMutation({state,events,plan,restore=false,archive}) {
  if(plan.schema!=='line-priority-migration/v1'||!archive?.file||!archive.sha256)throw Error('priority disposition needs its immutable archive');
  const applied=events.filter(e=>e.type==='line.priority-holds-migrated'&&e.archive?.sha256===archive.sha256);
  const reverted=events.some(e=>e.type==='line.priority-holds-restored'&&e.archive?.sha256===archive.sha256);
  if(applied.length>1)throw Error('ambiguous priority migration history');
  if(restore&&!applied.length)throw Error('priority migration was never applied');
  if(restore&&reverted||!restore&&applied.length){return {add:[],result:{existing:true,restored:reverted}};}
  const changes=plan.changes.map(change=>{
    const item=state.items.get(change.id),before=restore?change.after:change.before;
    if(!item||hash({...item,meta:change.before})!==change.subject||JSON.stringify(item.meta)!==JSON.stringify(before))throw Error(`priority subject changed: ${change.id}; preserve the current hold/effect`);
    return {id:change.id,before,after:restore?change.before:change.after};
  });
  if(!restore&&JSON.stringify(queuePolicy(state))!==JSON.stringify(plan.policy))throw Error('standing order changed before priority migration');
  return {add:[{type:restore?'line.priority-holds-restored':'line.priority-holds-migrated',archive,authority:plan.authority,changes}],result:{changed:changes.length,restored:restore}};
}

function attemptedItems(org,identity){
  const found=new Set(),directory=path.join(org,'dispatch');
  if(fs.existsSync(directory))for(const name of fs.readdirSync(directory).filter(n=>n.endsWith('.json')&&!n.endsWith('.routes.json'))){
    const saved=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));if(saved.item)found.add(saved.item);
  }
  const journal=path.join(lineDirectory(org,identity),'effects.json');
  if(fs.existsSync(journal))for(const key of Object.keys(JSON.parse(fs.readFileSync(journal,'utf8')).actions??{}))if(key.startsWith('dispatch:'))found.add(key.split(':')[1]);
  return [...found];
}
const root=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export function applyPriorityMigration({org,run:id,file,restore=false,cwd=process.cwd(),env=process.env,call}){
  org=fs.realpathSync(org);file=path.resolve(file);
  if(!file.startsWith(path.join(org,'evidence')+path.sep)||fs.realpathSync(file)!==file||!fs.lstatSync(file).isFile())throw Error('priority archive must be a plain owning-record evidence file');
  const bytes=fs.readFileSync(file,'utf8'),plan=JSON.parse(bytes),archive={file,sha256:createHash('sha256').update(bytes).digest('hex')};
  const original=readOwnedRun(org,id);requireController(original,'brain');const claim=ownerBinding(original);
  const sourceHead=git(root,['rev-parse','HEAD']);
  return transact(org,(events,state)=>{
    const binding=nativeSender(org,{cwd,env,call}),repo=binding.project.canonical,n=binding.native;
    const run=state.runs.get(id),worker=run&&effectiveWorkerIdentity(run,state);
    assertOwner(readOwnedRun(org,id,events),claim);
    if(!run||run.abandoned||run.report||state.items.get(run.item)?.runs.at(-1)!==id||run.workspace!==binding.project.checkout||worker.identity_conflict||worker.agent!==n.name||worker.pane!==n.pane_id||worker.worker_workspace!==n.workspace_id||worker.terminal_id!==n.terminal_id||worker.agent_session_id!==n.agent_session.value||itemLaunchHold(state,run.item))throw Error('priority migration requires the current actual owning worker and claim');
    for(const f of [path.join(lineDirectory(org,binding.project.identity),'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])if(fs.existsSync(f))throw Error('STOP/HOLD prevents priority migration');
    if(git(root,['rev-parse','HEAD'])!==sourceHead||git(root,['status','--porcelain=v1'])||git(repo,['status','--porcelain=v1']))throw Error('priority migration needs clean landed source');
    git(repo,['merge-base','--is-ancestor',sourceHead,'HEAD']);
    if(!restore){
      const fresh=priorityMigrationPlan({state,events,attempted:attemptedItems(org,binding.project.identity),authority:plan.authority});
      if(hash(fresh)!==hash(plan))throw Error('priority migration plan changed; preserve the archived disposition');
    }
    const mutation=priorityMigrationMutation({state,events,plan,archive,restore});
    for(const event of mutation.add)Object.assign(event,{project:binding.project.identity,run:id,native_caller:n,ownership:claim,source:{root,head:sourceHead}});
    return protectRecordMutation({org,state,events,mutation,command:'priority-only hold disposition'});
  },{actor:original.meta.agent,strictTail:true,lockOptions:{recover:false}}).result;
}

export function priorityMigrationCommand(argv=process.argv.slice(2)){
  const {values:v}=parseArgs({args:argv,options:{org:{type:'string'},run:{type:'string'},plan:{type:'string'},apply:{type:'string'},restore:{type:'string'},authority:{type:'string'}}});
  if(!v.org||[v.plan,v.apply,v.restore].filter(Boolean).length!==1)throw Error('name --org and exactly one of --plan FILE, --apply FILE or --restore FILE');
  if(v.plan){
    const {state,events}=loadRecord(v.org),binding=nativeSender(v.org),plan=priorityMigrationPlan({state,events,attempted:attemptedItems(v.org,binding.project.identity),authority:v.authority});
    const file=path.resolve(v.plan);if(!file.startsWith(path.join(fs.realpathSync(v.org),'evidence')+path.sep))throw Error('archive plan in the owning record evidence directory');
    const fd=fs.openSync(file,'wx',0o444);try{fs.writeFileSync(fd,JSON.stringify(plan,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    console.log(JSON.stringify({file,changed:plan.changes.length,retained:plan.retained}));
  }else console.log(JSON.stringify(applyPriorityMigration({org:v.org,run:v.run,file:v.apply??v.restore,restore:Boolean(v.restore)})));
}
if(isMain(import.meta.url))priorityMigrationCommand();
