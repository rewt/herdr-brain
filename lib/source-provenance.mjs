// Delivery coverage comes from the guarded effect, never hash containment or a
// clean allocation. These read-only projections grant no mutation authority.
import fs from './record-observation.mjs';
import {gitProject} from './project.mjs';
import {fold} from './state.mjs';
import {effectiveWorkerIdentity} from './worker-identity.mjs';
import {claimedCommitTokens,declaredSourceRanges} from '../settle/review-range.mjs';

const full = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? '');
export function dispatchSourceBinding({run,events,identity,org,workspace=run.workspace}) {
  const start=events.find(e=>e.type==='run.started'&&e.id===run.id),m=start?.meta,claim=events.find(e=>e.type==='run.claimed'&&e.seq===run.owner_generation&&e.run===run.id);
  if(!m?.dispatch_project||!m.dispatch_record||!m.dispatch_attempt||!m.dispatch_journal)
    throw Error('original dispatch source binding is missing');
  if(m.dispatch_project!==identity||m.dispatch_record!==org||start.workspace!==workspace||run.workspace!==workspace||
      ['dispatch_project','dispatch_record','dispatch_attempt','dispatch_journal'].some(k=>run.meta?.[k]!==m[k])||
      claim?.project!==identity||claim.record!==org||!run.owner||run.owner.legacy||run.owner.controller!=='brain')
    throw Error('original dispatch repository/record/run/claim differs from delivered source');
  return {schema:'brain.dispatch-source/v1',repository:identity,record:org,workspace,run:run.id,item:run.item,
    dispatch_seq:start.seq,attempt:m.dispatch_attempt,journal:m.dispatch_journal,claim_generation:run.owner_generation};
}

export function guardedLanding({event,run,events,identity,org,state}) {
  try {
    const binding=dispatchSourceBinding({run,events,identity,org}),s=event.source,p=event.producer,w=effectiveWorkerIdentity(run,state);
    return event.type==='change.landed'&&event.project===identity&&event.run===run.id&&event.item===run.item&&
      !!event.landed_at&&full(event.head)&&full(event.base)&&full(s?.base)&&full(s?.head)&&
      Object.entries(binding).every(([k,v])=>s?.[k]===v)&&s.base===event.previous_main&&s.head===event.landing_tip&&
      !w.identity_conflict&&!!w.agent&&!!w.pane&&!!w.terminal_id&&!!w.agent_session_id&&
      p?.agent===w.agent&&p.pane===w.pane&&p.terminal===w.terminal_id&&p.session===w.agent_session_id&&p.ownership_generation===run.owner_generation;
  } catch { return false; }
}

export function deliveredSourceProof({project,org,run,events,git,identify=gitProject,artifacts=run.report?.artifacts??[],state=fold(events)}) {
  const ranges=declaredSourceRanges(artifacts),tokens=claimedCommitTokens(artifacts),landings=events.filter(event=>event.type==='change.landed'&&event.run===run.id&&event.item===run.item),receipts=landings.filter(event=>event.source&&guardedLanding({event,run,events,identity:project.identity,org,state}));
  const result={schema:'brain.delivered-source/v1',status:'none',repository:project.identity,record:org,run:run.id,item:run.item,
    claim_generation:run.owner_generation??null,ranges:[],next_owner:run.id};
  if(!ranges.length&&!tokens.length&&!landings.length)return result;
  let bindingError;
  try { dispatchSourceBinding({run,events,identity:project.identity,org}); } catch(error) { bindingError=error.message; }
  const claims=ranges.length?ranges:tokens.length?tokens.map(head=>({head})):landings.map(e=>({head:e.head,base:e.base}));
  for(const claim of claims){
    const row={...claim,status:'unknown',landings:[]};result.ranges.push(row);
    if(claim.repository){
      try{
        const repository=fs.realpathSync(claim.repository),identity=repository===project.identity?repository:identify(repository).identity;
        if(identity!==project.identity){row.status='external';row.reason='declared repository differs from dispatch repository';continue;}
      }catch{row.reason='declared source repository is unavailable';continue;}
    }
    if(bindingError){row.reason=bindingError;continue;}
    try{
      const head=git(project.canonical,['rev-parse','--verify','--end-of-options',`${claim.head}^{commit}`]),base=claim.base?
        git(project.canonical,['rev-parse','--verify','--end-of-options',`${claim.base}^{commit}`]):git(project.canonical,['rev-parse',`${head}^1`]);
      row.head=head;row.base=base;
      if(!full(head)||!full(base))throw Error('delivered range is not immutable');
      git(project.canonical,['merge-base','--is-ancestor',base,head]);
      const commits=git(project.canonical,['rev-list',`${base}..${head}`]).split('\n').filter(Boolean);
      if(!commits.length)throw Error('claimed delivered range is empty');
      for(const commit of commits){
        const receipt=receipts.find(e=>e.head===commit);
        if(!receipt||events.some(e=>e.type==='change.landed'&&e.project===project.identity&&e.head===commit&&(e.run!==run.id||e.item!==run.item)))
          throw Error('claimed delivered range lacks guarded dispatch/run/claim evidence');
        row.landings.push(receipt.seq);
      }
      row.status='covered';
    }catch(error){row.reason=error.message;}
  }
  // Every explicit commit claim must be in the proven ranges, even when an
  // author also supplies a source/base artifact. An omitted claim stays visible.
  for(const token of tokens)if(!result.ranges.some(r=>r.head.startsWith(token))&&!ranges.some(r=>r.head===token)){
    const extra=deliveredSourceProof({project,org,run,events,git,identify,state,artifacts:[`Commit: ${token}`]});
    result.ranges.push(...extra.ranges);
  }
  result.status=result.ranges.some(r=>r.status==='external')?'external':result.ranges.every(r=>r.status==='covered')?'covered':'unknown';
  return result;
}
