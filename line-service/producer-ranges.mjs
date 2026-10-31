// A report's separate landings are one review scope, never their envelope diff.
import {createHash} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const full=value=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value??'');
export const PRODUCER_RANGE_LIMIT=64;
export const PRODUCER_COMMIT_LIMIT=4096;
const refuse=(code,reason)=>{throw Object.assign(Error(reason),{code:`PRODUCER_RANGE_${code}`});};
const commits=(git,repo,base,head)=>git(repo,['rev-list','--reverse',`${base}..${head}`]).split('\n').filter(Boolean);
const diff=(git,repo,base,head)=>git(repo,['diff','--no-ext-diff','--no-textconv',base,head]);

export function producerRanges({git,repo,declared,dispatch,head,claims,index,item,run}){
  if(declared.length>PRODUCER_RANGE_LIMIT)refuse('LIMIT',`whole producer exceeds ${PRODUCER_RANGE_LIMIT} declared ranges; retain for bounded source selection`);
  const ranges=[],seen=new Set(),rows=new Map(index.entries.map(row=>[row.head,row]));
  for(const claim of declared){
    let base,tip,list;
    try{
      base=git(repo,['rev-parse','--verify','--end-of-options',`${claim.base}^{commit}`]);
      tip=git(repo,['rev-parse','--verify','--end-of-options',`${claim.head}^{commit}`]);
      git(repo,['merge-base','--is-ancestor',dispatch.base,base]);
      git(repo,['merge-base','--is-ancestor',base,tip]);
      git(repo,['merge-base','--is-ancestor',tip,head]);
      list=commits(git,repo,base,tip);
    }catch{refuse('INVALID','whole producer has unresolved, unlanded or contradictory declared source/base ranges');}
    if(!list.length)refuse('EMPTY','whole producer has an empty declared source range');
    if(list.length+seen.size>PRODUCER_COMMIT_LIMIT)refuse('LIMIT',`whole producer exceeds ${PRODUCER_COMMIT_LIMIT} delivered commits; retain for bounded source selection`);
    for(const commit of list){
      if(seen.has(commit))refuse('OVERLAP','whole producer declared ranges overlap; retain immutable claims without widening');
      const row=rows.get(commit);
      if(!row||row.item!==item.id||row.run!==run.id)refuse('FOREIGN','whole producer declared range includes foreign, ambiguous or noncanonical source');
      seen.add(commit);
    }
    const delta=diff(git,repo,base,tip);
    if(!delta)refuse('EMPTY','whole producer declared range has an empty delta');
    ranges.push({base,head:tip,commits:list,diff_sha256:hash(delta)});
  }
  const order=commits(git,repo,dispatch.base,head),position=new Map(order.map((h,i)=>[h,i]));
  ranges.sort((a,b)=>position.get(a.head)-position.get(b.head));
  for(let i=1;i<ranges.length;i++)try{git(repo,['merge-base','--is-ancestor',ranges[i-1].head,ranges[i].base]);}
  catch{refuse('ORDER','whole producer declared ranges are not separate ordered landings');}
  if(!seen.has(head)||claims.some(h=>h!==dispatch.base&&rows.has(h)&&!seen.has(h)))refuse('OMITTED','whole producer ranges omit delivered source; no partial review');
  const owned=order.filter(h=>seen.has(h));
  return {base:ranges[0].base,head,diff_kind:'producer-ranges/v1',diff_sha256:hash(JSON.stringify(ranges)),
    scope:{schema:'brain.producer-ranges/v1',base:ranges[0].base,ranges,commits:owned,claims:owned,unresolved:[],deferred:false}};
}

// Revalidate saved disjoint scopes without interpreting their base/head envelope
// as delivered source. Discovery separately rechecks current attribution.
export function capturedProducerRanges({git,repo,target}){
  const ranges=target.scope?.ranges;
  if(target.diff_kind!=='producer-ranges/v1'||target.scope?.schema!=='brain.producer-ranges/v1'||!Array.isArray(ranges)||ranges.length<2||ranges.length>PRODUCER_RANGE_LIMIT)refuse('CAPTURE','retained whole producer range schema/limit is UNKNOWN');
  const owned=[];
  for(const [i,range]of ranges.entries()){
    if(!full(range.base)||!full(range.head))refuse('CAPTURE','retained whole producer endpoints are UNKNOWN');
    git(repo,['merge-base','--is-ancestor',range.base,range.head]);
    if(i)git(repo,['merge-base','--is-ancestor',ranges[i-1].head,range.base]);
    const list=commits(git,repo,range.base,range.head);
    if(!list.length||owned.length+list.length>PRODUCER_COMMIT_LIMIT||list.some(h=>owned.includes(h))||!same(list,range.commits)||hash(diff(git,repo,range.base,range.head))!==range.diff_sha256)refuse('CAPTURE','retained whole producer range/diff changed or overlaps');
    owned.push(...list);
  }
  if(target.base!==ranges[0].base||target.scope.base!==target.base||target.head!==ranges.at(-1).head||!same(owned,target.scope.commits)||!same(owned,target.scope.claims)||!same(owned,target.source_group?.owned_commits)||hash(JSON.stringify(ranges))!==target.diff_sha256)refuse('CAPTURE','retained whole producer manifest/owned scope changed');
  return owned;
}
