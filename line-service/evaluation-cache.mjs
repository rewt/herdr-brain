// Negative scheduling observations only. No cached value can authorize an
// effect; positive candidates always enter the existing fresh launch guards.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {roleIs} from '../lib/roles.mjs';
import {claimedCommitTokens,declaredSourceRanges} from '../settle/review-range.mjs';
import {obligationPending} from '../lib/obligations.mjs';
import {fileURLToPath} from 'node:url';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ids=value=>[...JSON.stringify(value??null).matchAll(/\b[A-Z]+-[1-9]\d*\b/g)].map(m=>m[0]);
const schema='line-negative-evaluation/v3';

// A code change in the evaluator is an input change; a new repository HEAD is
// not. Include relative module dependencies, and the integration itself, once
// per pass. Missing/unreadable implementation bytes disable reuse.
function implementationInputs(){
  const root=path.dirname(fileURLToPath(import.meta.url)),seen=new Map();
  const visit=file=>{
    file=path.resolve(file);if(seen.has(file))return;
    const bytes=fs.readFileSync(file,'utf8');seen.set(file,hash(bytes));
    for(const match of bytes.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+\.mjs)["']/g))visit(path.resolve(path.dirname(file),match[1]));
  };
  for(const file of ['evaluation-cache.mjs','phase1.mjs','priority-order.mjs','decision-policy.mjs','../lib/item-launch-hold.mjs','../lib/ordinary-admission.mjs','../lib/review-admission.mjs'])visit(path.join(root,file));
  // The pass owns the choice of when a negative may be retained.
  const integration=path.join(root,'line-service.mjs');seen.set(integration,hash(fs.readFileSync(integration,'utf8')));
  return hash([...seen].sort(([a],[b])=>a.localeCompare(b)));
}

// Keep the canonical index global and fresh for attribution, but project its
// result onto this producer's claims/ancestry. A competing claim, newly landed
// own head, changed canonical membership or prefix ambiguity changes this view.
export function sourceEvaluationInputs(index,item,run){
  const ranges=declaredSourceRanges(run.report?.artifacts??[]),tokens=[...new Set([...claimedCommitTokens(run.report?.artifacts??[]),...ranges.flatMap(r=>[r.head,r.base])])],parents=new Map(index.graphRows.map(row=>{const [h,...p]=row.split(' ');return[h,p];}));
  const selected=new Set(),visit=head=>{if(selected.has(head))return;selected.add(head);for(const p of parents.get(head)??[])visit(p);};
  for(const row of index.entries)if(row.item===item.id||row.run===run.id||tokens.some(token=>row.head.startsWith(token)))visit(row.head);
  return {cacheable:tokens.every(token=>[40,64].includes(token.length)),claims:tokens.map(token=>[token,[...index.heads,...(index.boundary?.canonical_head?[index.boundary.canonical_head]:[])].filter(head=>head.startsWith(token))]),
    entries:index.entries.filter(row=>selected.has(row.head)).sort((a,b)=>a.head.localeCompare(b.head)),
    graph:[...parents].filter(([head])=>selected.has(head)).sort(([a],[b])=>a.localeCompare(b))};
}

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
  const read=file=>{try{return fs.readFileSync(file,'utf8');}catch(e){if(['ENOENT','ENOTDIR'].includes(e.code))return null;throw e;}};
  const config=file=>{
    file=path.resolve(file);if(seen.has(file))return;seen.add(file);
    if(--remaining<0)throw Error('evaluation input inventory exceeds cache bound');
    try{
      const l=fs.lstatSync(file),s=fs.statSync(file);
      if(!s.isFile())throw Error('unknown Git configuration');
      // An atomic rewrite of an unchanged common config changes its inode and
      // timestamps without changing scheduling semantics.
      // Keep path/redirect/mode and exact bytes; read failures still decline reuse.
      rows.push([file,fs.realpathSync(file),l.mode,s.mode,hash(fs.readFileSync(file))]);
    }catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;rows.push([file,e.code]);}
  };
  const git=dir=>{
    stat(dir,true);
    for(const name of ['config','config.worktree'])config(path.join(dir,name));
    for(const name of ['commondir','gitdir','shallow','info/grafts','objects/info/alternates'])stat(path.join(dir,name));
    const commonFile=read(path.join(dir,'commondir')),common=commonFile===null?dir:path.resolve(dir,commonFile.trim());
    if(commonFile!==null&&fs.realpathSync(common)!==fs.realpathSync(identity))throw Error('foreign Git common directory requires fresh evaluation');
    if(fs.existsSync(path.join(common,'refs'))&&fs.lstatSync(path.join(common,'refs')).isSymbolicLink())throw Error('linked Git refs require fresh evaluation');
    // Resolve only this checkout's HEAD. Packing refs or advancing main or a
    // different worker branch must not change an unchanged producer's input.
    // Canonical main membership is supplied by sourceEvaluationInputs instead.
    if(path.resolve(dir)!==path.resolve(identity)){
      let value=read(path.join(dir,'HEAD')),depth=0;const refs=[];
      while(value?.startsWith('ref: ')){
        if(++depth>8)throw Error('cyclic Git HEAD');
        const ref=value.trim().slice(5);if(!/^refs\/[A-Za-z0-9/_.-]+$/.test(ref)||ref.includes('..'))throw Error('unknown Git HEAD');
        refs.push(ref);value=read(path.join(common,ref));
        if(value===null){
          const packed=read(path.join(common,'packed-refs'))??'';
          value=packed.split('\n').find(row=>row.split(' ')[1]===ref)?.split(' ')[0]??null;
        }
      }
      rows.push(['head',dir,refs,value?.trim()??null]);
    }
    if(fs.existsSync(path.join(common,'reftable')))throw Error('reftable requires fresh evaluation');
  };
  for(const file of [...files].filter(Boolean).sort())stat(file);
  for(const workspace of [...workspaces].filter(Boolean).sort()){
    if(!stat(workspace,true)?.isDirectory())continue;
    if(path.basename(workspace)==='.git'){git(workspace);continue;}
    const marker=path.join(workspace,'.git'),s=stat(marker,true);
    if(s?.isDirectory())git(marker);
    else if(s?.isFile()){
      const text=fs.readFileSync(marker,'utf8').trim();
      if(!text.startsWith('gitdir: '))throw Error('unknown workspace Git marker');
      git(path.resolve(workspace,text.slice(8)));
    }
    for(const name of ['.lane/HOLD','.lane/supervisor/HOLD','.lane/supervisor/STOP'])stat(path.join(workspace,name));
  }
  // Shared configuration and replacement objects can change Git semantics.
  // Packed ordinary refs are deliberately excluded; observe packed replacements.
  for(const name of ['config','config.worktree'])config(path.join(identity,name));
  for(const name of ['shallow','info/grafts','objects/info/alternates'])stat(path.join(identity,name));
  tree(path.join(identity,'refs/replace'));
  rows.push(['packed-replacements',(read(path.join(identity,'packed-refs'))??'').split('\n').filter(row=>row.includes(' refs/replace/')).sort()]);
  return rows;
}

export function negativeEvaluationCache({store,identity,org,repo,dirty=()=>{},counts={}}){
  let implementation;try{implementation=implementationInputs();}catch{implementation=null;}
  let indexed;
  const index=snapshot=>{
    if(indexed?.events===snapshot.events)return indexed;
    const {state,events}=snapshot,ownRevisions=new Map(),dependencies=new Map(),pending=new Map();
    const edge=(a,b)=>{if(a&&b){const set=dependencies.get(a)??new Set();set.add(b);dependencies.set(a,set);}};
    for(const e of events){
      // A saved diagnostic/report can mention an ancestor without changing it.
      // Do not turn another subject's recurring closeout into a subtree change.
      for(const id of [e.id,e.item,e.run,e.blocked,e.blocker,e.review_item,e.review_run,e.source_item,e.source_run])if(id)ownRevisions.set(id,e.seq);
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
    for(const row of state.obligations.values())if(obligationPending(row)){
      // Prerequisite-only reports have no landed queue debt. Other consumers
      // (intake/closeout/completion) run independently of these negative probes.
      const stage=row.kind==='review-handoff'&&row.landings.length?'source':
        ['dispatch-outcome','unsupported'].includes(row.kind)?'admission':null;
      if(stage)for(const id of [row.item,row.run].filter(Boolean)){const key=`${stage}:${id}`,rows=pending.get(key)??[];rows.push(row.id);pending.set(key,rows);}
    }
    const legacyBoundary=events.find(e=>e.type==='change.landed'&&e.project===identity&&e.source)?.seq??null;
    return indexed={events,ownRevisions,dependencies,pending,legacyBoundary};
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
      if(!implementation)throw Error('unknown evaluator implementation');
      // Abbreviations can become ambiguous through an object outside main.
      if(extra?.canonical?.cacheable===false)throw Error('abbreviated source requires fresh resolution');
      const {state}=snapshot,{ownRevisions,dependencies,legacyBoundary}=index(snapshot),related=new Set(),expand=[item,run].filter(Boolean),ancestors=new Set();
      while(expand.length){const id=expand.pop();if(related.has(id))continue;related.add(id);expand.push(...dependencies.get(id)??[]);
        const subject=state.items.get(id);if(subject)expand.push(...subject.runs);
      }
      // An ancestor's own changes invalidate its descendants, while a sibling's
      // unrelated note does not invalidate every item under a shared goal.
      for(const id of related){let parent=state.items.get(id)?.parent;while(parent&&!ancestors.has(parent)){ancestors.add(parent);parent=state.items.get(parent)?.parent;}}
      const files=new Set([path.join(repo,'.lane.json')]),workspaces=new Set(),record=[];
      const ancestorRuns=[...ancestors].flatMap(id=>state.items.get(id)?.runs??[]);
      for(const id of [...new Set([...related,...ancestors,...ancestorRuns])].sort()){
        const i=state.items.get(id),r=state.runs.get(id);record.push([id,ownRevisions.get(id)??0,i??r??null]);
        if(!r)continue;
        files.add(r.brief_path);files.add(r.report?.file&&path.resolve(org,r.report.file));files.add(r.meta?.dispatch_journal);
        if(related.has(id)){
          workspaces.add(r.workspace);
          for(const range of declaredSourceRanges(r.report?.artifacts??[]))if(range.repository)workspaces.add(range.repository);
        }
      }
      const actions=Object.entries(store().actions??{}).filter(([key])=>key.startsWith(`dispatch:${item}:`));
      for(const [,entry]of actions){files.add(entry.result?.journal);files.add(entry.original_outcome?.journal);}
      return hash([implementation,record,policy,extra,actions,legacyBoundary,physicalInputs(files,workspaces,identity)]);
    }catch{return null;} // Unknown/missing inventory is never a cache hit.
  };
  return{
    probe(stage,subject){
      const key=`${stage}:${subject.run??subject.item}`,signature=fingerprint(subject),prior=entries()[key],{pending}=index(subject.snapshot);
      const obligation=[subject.item,subject.run].some(id=>pending.has(`${stage}:${id}`));
      if(!obligation&&signature&&prior?.signature===signature&&prior?.negative===true){counts[`${stage}_skipped`]=(counts[`${stage}_skipped`]??0)+1;return{skip:true,reason:prior.reason};}
      counts[`${stage}_evaluated`]=(counts[`${stage}_evaluated`]??0)+1;
      const miss=obligation?'obligation':!signature?'uncacheable':!prior?'cold':'changed';
      counts[`${stage}_${miss}`]=(counts[`${stage}_${miss}`]??0)+1;
      // Invalidate before evaluation. Exceptions and positive results leave no
      // reusable entry, even if an old cache document was stale or malformed.
      if(prior){delete entries()[key];dirty();}
      return{skip:false,retain(reason){if(!signature)return;entries()[key]={signature,negative:true,reason,observed_seq:subject.snapshot.events.at(-1)?.seq??0};dirty();}};
    }
  };
}
