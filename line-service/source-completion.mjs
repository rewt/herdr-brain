// Logical completion is independent of allocation disposal. Reads here grant
// no native effect; the conditional record close still owns final admission.
import fs from 'node:fs';
import {declaredSourceRanges} from '../settle/review-range.mjs';

export function sourceCompletionProof({project,run,events,git,identify}) {
  const present=Boolean(fs.lstatSync(run.workspace,{throwIfNoEntry:false}));
  const tip=git(project.canonical,['rev-parse','HEAD']);
  if(git(project.canonical,['status','--porcelain=v1','--untracked-files=all']))
    throw Error('canonical worktree is not clean');
  let head,evidence;
  if(present){
    if(identify(run.workspace).identity!==project.identity)throw Error('foreign run workspace');
    head=git(run.workspace,['rev-parse','HEAD']);
    if(git(run.workspace,['status','--porcelain=v1','--untracked-files=all']))throw Error('source worktree is not clean');
    evidence={kind:'clean-worktree',workspace:run.workspace};
  }else{
    if(run.meta.dispatch_project!==project.identity)throw Error('original run project binding is missing/foreign');
    const landed=events.findLast(e=>e.type==='change.landed'&&e.project===project.identity&&e.run===run.id&&e.item===run.item&&
      e.landed_at&&e.producer?.ownership_generation===run.owner_generation);
    const ranges=declaredSourceRanges(run.report.artifacts??[]);
    if(landed){head=landed.head;evidence={kind:'original-landing',seq:landed.seq};}
    else if(ranges.length===1&&[ranges[0].head,ranges[0].base].every(h=>/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(h))){
      head=ranges[0].head;git(project.canonical,['merge-base','--is-ancestor',ranges[0].base,head]);
      evidence={kind:'immutable-report-range',...ranges[0]};
    }else throw Error('absent source requires an immutable landed head or full report range');
    if(events.some(e=>e.type==='change.landed'&&e.project===project.identity&&e.head===head&&(e.run!==run.id||e.item!==run.item)))
      throw Error('source landing belongs to another producer');
  }
  if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head))throw Error('source head is not immutable');
  try{git(project.canonical,['merge-base','--is-ancestor',head,tip]);}
  catch{throw Error(`reported source ${head} is not integrated at ${tip}`);}
  return{source_head:head,integrated_tip:tip,allocation:present?'present':'absent',evidence};
}

// Exact legacy errors thrown by our reads before cli('close'), with no command
// receipt. An interrupted or refused record mutation never qualifies.
export function preEffectSourceHold(entry){
  return entry?.state==='held'&&!entry.receipt&&!entry.result&&!entry.history?.length&&
    (!entry.failure||entry.failure.kind==='unknown')&&
    /^T2 source completion needs supervisor judgment: (?:source\/canonical worktree is not clean|reported source [a-f0-9]{40,64} is not integrated at [a-f0-9]{40,64})$/.test(entry.error??'');
}
