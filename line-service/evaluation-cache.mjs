// Negative scheduling observations only. No cached value can authorize an
// effect; positive candidates always enter the existing fresh launch guards.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {roleIs} from '../lib/roles.mjs';
import {declaredSourceRanges} from '../settle/review-range.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ids=value=>[...JSON.stringify(value??null).matchAll(/\b[A-Z]+-[1-9]\d*\b/g)].map(m=>m[0]);
const schema='line-negative-evaluation/v2';

// Scheduling reads evidence files and Git/workspace identity, not checkout
// contents. In particular, ordinary linked skills are not scheduling inputs.
// Bound relevant inventories by declining to cache, never by truncating inputs.
function physicalInputs(files,workspaces,identity){
  const rows=[],seen=new Set();let remaining=4096;
  const stat=(file,identityOnly=false)=>{
    file=path.resolve(file);if(seen.has(file))return null;seen.add(file);
    if(--remaining<0)throw Error('evaluation input inventory exceeds cache bound');
    try{
      const l=fs.lstatSync(file,{bigint:true}),s=fs.statSync(file,{bigint:true});
      rows.push([file,fs.realpathSync(file),...[l,s].map(v=>(identityOnly&&v.isDirectory()?[v.dev,v.ino,v.mode]:[v.dev,v.ino,v.mode,v.size,v.mtimeNs,v.ctimeNs]).map(String))]);
      return s;
    }catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;rows.push([file,e.code]);return null;}
  };
  const tree=file=>{
    const s=stat(file);if(!s?.isDirectory())return;
    // Symlink identity/target changes are observed, but never follow a directory
    // link into an unbounded or foreign source tree.
    if(fs.lstatSync(file).isSymbolicLink())throw Error('linked tree requires fresh evaluation');
    for(const name of fs.readdirSync(file).sort())tree(path.join(file,name));
  };
  const git=dir=>{
    for(const name of ['HEAD','index','commondir','gitdir','config','config.worktree','packed-refs','shallow','info/grafts','objects/info/alternates'])stat(path.join(dir,name));
    tree(path.join(dir,'refs'));tree(path.join(dir,'reftable'));
  };
  for(const file of [...files].filter(Boolean).sort())stat(file);
  for(const workspace of [...workspaces].filter(Boolean).sort()){
    if(!stat(workspace,true)?.isDirectory())continue;
    if(path.basename(workspace)==='.git'){git(workspace);continue;}
    const marker=path.join(workspace,'.git'),s=stat(marker);
    if(s?.isDirectory())git(marker);
    else if(s?.isFile()){
      const text=fs.readFileSync(marker,'utf8').trim();
      if(!text.startsWith('gitdir: '))throw Error('unknown workspace Git marker');
      git(path.resolve(workspace,text.slice(8)));
    }
    for(const name of ['.lane/HOLD','.lane/supervisor/HOLD','.lane/supervisor/STOP'])stat(path.join(workspace,name));
  }
  // Shared refs/config can change the meaning of a source observation.
  for(const name of ['config','packed-refs','shallow','info/grafts','objects/info/alternates'])stat(path.join(identity,name));
  return rows;
}

export function negativeEvaluationCache({store,identity,org,repo,revision,dirty=()=>{},counts={}}){
  let indexed;
  const index=snapshot=>{
    if(indexed?.events===snapshot.events)return indexed;
    const {state,events}=snapshot,revisions=new Map(),dependencies=new Map();
    const edge=(a,b)=>{if(a&&b){const set=dependencies.get(a)??new Set();set.add(b);dependencies.set(a,set);}};
    for(const e of events){
      for(const id of new Set(ids(e)))revisions.set(id,e.seq);
      // Historical removed links still participate in blocked-report recovery.
      if(e.type==='link.added')edge(e.blocked,e.blocker);
    }
    for(const item of state.items.values()){
      for(const child of ids(item.meta))edge(item.id,child);
      if(item.parent&&(roleIs(item,'REV')||roleIs(item,'HUM')))edge(item.parent,item.id);
      if(item.meta.review_source_item)edge(item.meta.review_source_item,item.id);
      if(item.meta.review_source_run)edge(item.meta.review_source_run,item.id);
    }
    for(const link of state.links)edge(link.blocked,link.blocker);
    for(const run of state.runs.values())edge(run.id,run.item);
    return indexed={events,revisions,dependencies};
  };
  const entries=()=>{
    const parent=store();
    if(parent.negative_evaluations?.schema!==schema||parent.negative_evaluations.identity!==identity||parent.negative_evaluations.org!==org||!parent.negative_evaluations.entries||typeof parent.negative_evaluations.entries!=='object'||Array.isArray(parent.negative_evaluations.entries)){
      parent.negative_evaluations={schema,identity,org,entries:{}};dirty();
    }
    return parent.negative_evaluations.entries;
  };
  const fingerprint=({snapshot,item,run,policy,extra})=>{
    try{
      const {state}=snapshot,{revisions,dependencies}=index(snapshot),related=new Set(),expand=[item,run].filter(Boolean),ancestors=new Set();
      while(expand.length){const id=expand.pop();if(related.has(id))continue;related.add(id);expand.push(...dependencies.get(id)??[]);
        const subject=state.items.get(id);if(subject)expand.push(...subject.runs);
      }
      // An ancestor's own changes invalidate its descendants, while a sibling's
      // unrelated note does not invalidate every item under a shared goal.
      for(const id of related){let parent=state.items.get(id)?.parent;while(parent&&!ancestors.has(parent)){ancestors.add(parent);parent=state.items.get(parent)?.parent;}}
      const files=new Set([path.join(repo,'.lane.json')]),workspaces=new Set(),record=[];
      const ancestorRuns=[...ancestors].flatMap(id=>state.items.get(id)?.runs??[]);
      for(const id of [...new Set([...related,...ancestors,...ancestorRuns])].sort()){
        const i=state.items.get(id),r=state.runs.get(id);record.push([id,revisions.get(id)??0,i??r??null]);
        if(!r)continue;
        files.add(r.brief_path);files.add(r.report?.file&&path.resolve(org,r.report.file));files.add(r.meta?.dispatch_journal);
        if(related.has(id)){
          workspaces.add(r.workspace);
          for(const range of declaredSourceRanges(r.report?.artifacts??[]))if(range.repository)workspaces.add(range.repository);
        }
      }
      const actions=Object.entries(store().actions??{}).filter(([key])=>key.startsWith(`dispatch:${item}:`));
      for(const [,entry]of actions){files.add(entry.result?.journal);files.add(entry.original_outcome?.journal);}
      return hash([revision,record,policy,extra,actions,physicalInputs(files,workspaces,identity)]);
    }catch{return null;} // Unknown/missing inventory is never a cache hit.
  };
  return{
    probe(stage,subject){
      const key=`${stage}:${subject.run??subject.item}`,signature=fingerprint(subject),prior=entries()[key];
      if(signature&&prior?.signature===signature&&prior?.negative===true){counts[`${stage}_skipped`]=(counts[`${stage}_skipped`]??0)+1;return{skip:true,reason:prior.reason};}
      counts[`${stage}_evaluated`]=(counts[`${stage}_evaluated`]??0)+1;
      const miss=!signature?'uncacheable':!prior?'cold':'changed';
      counts[`${stage}_${miss}`]=(counts[`${stage}_${miss}`]??0)+1;
      // Invalidate before evaluation. Exceptions and positive results leave no
      // reusable entry, even if an old cache document was stale or malformed.
      if(prior){delete entries()[key];dirty();}
      return{skip:false,retain(reason){if(!signature)return;entries()[key]={signature,negative:true,reason,observed_seq:subject.snapshot.events.at(-1)?.seq??0};dirty();}};
    }
  };
}
