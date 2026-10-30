// Logical completion is independent of allocation disposal. Reads here grant
// no native effect; the conditional record close still owns final admission.
import fs from 'node:fs';
import {policyLocation} from '../lib/config-home.mjs';
import {readPolicyFile,validatePromote} from '../lib/config-policy.mjs';
import {enqueueSupervisor,inboxPath,readInbox} from '../supervisor/prompt-supervisor.mjs';
import {deliveredSourceProof} from '../lib/source-provenance.mjs';

export function sourceCompletionProof({project,run,org=run.meta?.dispatch_record,events,state,git,identify}) {
  const present=Boolean(fs.lstatSync(run.workspace,{throwIfNoEntry:false}));
  const tip=git(project.canonical,['rev-parse','HEAD']);
  if(git(project.canonical,['status','--porcelain=v1','--untracked-files=all']))
    throw Error('canonical worktree is not clean');
  const provenance=deliveredSourceProof({project,org,run,events,state,git,identify});
  if(['external','unknown'].includes(provenance.status))throw Object.assign(
    Error(`claimed delivered source is ${provenance.status}: ${provenance.ranges.map(r=>r.reason).filter(Boolean).join('; ')}; next owner ${run.id}`),{source_provenance:provenance});
  let head,evidence;
  if(present){
    if(identify(run.workspace).identity!==project.identity)throw Error('foreign run workspace');
    head=git(run.workspace,['rev-parse','HEAD']);
    if(git(run.workspace,['status','--porcelain=v1','--untracked-files=all']))throw Error('source worktree is not clean');
    evidence={kind:provenance.status==='none'?'no-source-claim':'guarded-delivered-range',workspace:run.workspace};
  }else{
    if(run.meta.dispatch_project!==project.identity)throw Error('original run project binding is missing/foreign');
    if(provenance.status==='none')return{source_head:null,integrated_tip:tip,allocation:'absent',evidence:{kind:'no-source-claim'},source_provenance:provenance};
    head=provenance.ranges.at(-1).head;evidence={kind:'guarded-delivered-range'};
  }
  // Check every delivered head, independently of the registered allocation.
  for(const range of provenance.ranges)try{git(project.canonical,['merge-base','--is-ancestor',range.head,tip]);}
  catch{throw Error(`reported source ${range.head} is not integrated at ${tip}`);}
  if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head))throw Error('source head is not immutable');
  try{git(project.canonical,['merge-base','--is-ancestor',head,tip]);}
  catch{throw Error(`reported source ${head} is not integrated at ${tip}`);}
  return{source_head:head,integrated_tip:tip,allocation:present?'present':'absent',evidence,source_provenance:provenance};
}

// Exact legacy errors thrown by our reads before cli('close'), with no command
// receipt. An interrupted or refused record mutation never qualifies.
export function preEffectSourceHold(entry){
  return entry?.state==='held'&&!entry.receipt&&!entry.result&&!entry.history?.length&&
    (!entry.failure||entry.failure.kind==='unknown')&&
    /^T2 source completion needs supervisor judgment: (?:source\/canonical worktree is not clean|reported source [a-f0-9]{40,64} is not integrated at [a-f0-9]{40,64})$/.test(entry.error??'');
}

// Enqueue an actual repository mismatch once through the existing role inbox.
// The inbox owner owns quiet/native delivery; this producer never inputs/replays.
export function queueSourceException({repo,org,run,proof,env=process.env,git,enqueue=enqueueSupervisor}) {
  if(proof?.status!=='external')return null;
  const id=`${run.id}:exception:source-repository:${run.report.sha256}`,file=inboxPath({org,cwd:repo}),prior=readInbox(file).find(e=>e.id===id);
  if(prior)return{id,inbox:file,state:prior.state,retained:true};
  const selected=policyLocation(repo,'promote',env,{canonical:repo});
  const policy=selected.home?readPolicyFile(selected.file,'promote'):validatePromote(JSON.parse(git(repo,['show','HEAD:.promote.json'])));
  if(!policy.to)return{id,state:'pending',reason:'recorded project supervisor binding is missing'};
  const message=`[worker-exception] run=${run.id} item=${run.item} claimed delivery repository differs from immutable dispatch repository; evidence=${org}/runs/${run.id}/report.md; held-action=covered source completion; next-owner=${run.id}; source evidence retained in line-service.source-completion-held`;
  return{...enqueue(policy.to,message,{id,org,cwd:repo,projectSupervisor:true,waitSeconds:0,lockOptions:{recover:false}}),state:'queued',delivered:false};
}
