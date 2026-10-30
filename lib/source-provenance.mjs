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

// Compatibility is a read-only proof over the original post-FF receipt. It
// never enriches/replays change.landed or turns old evidence into a guard.
export function legacyLandingProof({event,project,org,run,events,git,identify=gitProject,state=fold(events)}) {
  const proof={schema:'brain.legacy-landing/v1',status:'legacy-unproven',guarded:false,
    landing_seq:event.seq??null,repository:event.project??null,run:run.id,item:run.item,next_owner:run.id};
  const refuse=(code,reason)=>Object.assign(proof,{code,reason});
  if(event.source)return refuse('typed-landing','Typed landings must pass the source guard; legacy proof is inapplicable.');
  try { dispatchSourceBinding({run,events,identity:project.identity,org}); }
  catch(error){return refuse('dispatch-binding',error.message);}
  const w=effectiveWorkerIdentity(run,state),p=event.producer;
  const native=e=>e.type==='change.landed'&&e.run===run.id&&e.item===run.item&&e.project===project.identity&&
    !e.source&&e.by===w.agent&&!w.identity_conflict&&!!w.agent&&!!w.pane&&!!w.terminal_id&&!!w.agent_session_id&&
    e.producer?.agent===w.agent&&e.producer.pane===w.pane&&e.producer.terminal===w.terminal_id&&
    e.producer.session===w.agent_session_id&&e.producer.ownership_generation===run.owner_generation&&
    Number.isSafeInteger(e.seq)&&e.seq>run.owner_generation&&Number.isFinite(Date.parse(e.landed_at))&&
    Date.parse(e.at)>=Date.parse(e.landed_at);
  if(!p||!native(event))return refuse('native-receipt','Original native producer/run/claim receipt is missing or differs.');
  // The first valid typed receipt fixes the transition in this repository's
  // append-only history. Sequence and ancestry both have to predate it.
  const boundary=events.find(e=>e.type==='change.landed'&&e.project===project.identity&&e.source);
  if(!boundary||!guardedLanding({event:boundary,run:state.runs.get(boundary.run),events,state,identity:project.identity,org}))
    return refuse('guard-boundary-unavailable','The first source-guard transition is absent or cannot be validated for this repository.');
  proof.boundary_seq=boundary.seq;
  if(event.seq>=boundary.seq||Date.parse(event.landed_at)>Date.parse(boundary.landed_at))
    return refuse('post-guard-missing-source','Missing source evidence is not before the source-guard transition.');
  try {
    if(identify(project.canonical).identity!==project.identity||event.project!==run.meta.dispatch_project)
      return refuse('repository-mismatch','Native receipt common directory differs from the actual/original dispatch repository.');
  }catch{return refuse('repository-unavailable','Native receipt repository identity cannot be resolved.');}
  try {
    for(const value of [event.base,event.head,event.previous_main,event.landing_tip])
      if(!full(value)||git(project.canonical,['rev-parse','--verify','--end-of-options',`${value}^{commit}`])!==value)
        throw Error('Native receipt range is not immutable.');
    git(project.canonical,['merge-base','--is-ancestor',event.landing_tip,boundary.previous_main]);
    git(project.canonical,['merge-base','--is-ancestor',event.previous_main,event.landing_tip]);
    const commits=git(project.canonical,['rev-list',`${event.previous_main}..${event.landing_tip}`]).split('\n').filter(Boolean);
    if(!commits.includes(event.head))throw Error('Landing commit is outside its recorded promotion range.');
    const receipts=events.filter(e=>native(e)&&e.seq<boundary.seq&&e.previous_main===event.previous_main&&
      e.landing_tip===event.landing_tip&&e.landed_at===event.landed_at);
    for(const head of commits){
      const rows=receipts.filter(e=>e.head===head);
      if(rows.length!==1||rows[0].base!==git(project.canonical,['rev-parse',`${head}^1`])||
          events.some(e=>e.type==='change.landed'&&e.project===project.identity&&e.head===head&&(e.run!==run.id||e.item!==run.item)))
        throw Error('Exact native promotion range has missing, conflicting or foreign ownership evidence.');
    }
    if(receipts.length!==commits.length)throw Error('Native promotion receipt contains commits outside its exact range.');
    return Object.assign(proof,{status:'legacy-proven',code:'pre-guard-native-receipt',
      promotion:{base:event.previous_main,head:event.landing_tip},landings:receipts.map(e=>e.seq)});
  }catch(error){return refuse('landed-range',error.message);}
}

export function deliveredSourceProof({project,org,run,events,git,identify=gitProject,artifacts=run.report?.artifacts??[],state=fold(events)}) {
  const ranges=declaredSourceRanges(artifacts),tokens=claimedCommitTokens(artifacts),landings=events.filter(event=>event.type==='change.landed'&&event.run===run.id&&event.item===run.item),receipts=landings.filter(event=>event.source&&guardedLanding({event,run,events,identity:project.identity,org,state}));
  const legacy=landings.filter(event=>!event.source).map(event=>legacyLandingProof({event,project,org,run,events,git,identify,state}));
  const result={schema:'brain.delivered-source/v1',status:'none',repository:project.identity,record:org,run:run.id,item:run.item,
    claim_generation:run.owner_generation??null,ranges:[],next_owner:run.id,...(legacy.length?{legacy_landings:legacy}:{})};
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
      const kinds=new Set();
      for(const commit of commits){
        const historical=legacy.find(p=>p.status==='legacy-proven'&&landings.some(e=>e.seq===p.landing_seq&&e.head===commit));
        const receipt=receipts.find(e=>e.head===commit)??(historical&&landings.find(e=>e.seq===historical.landing_seq));
        if(!receipt||events.some(e=>e.type==='change.landed'&&e.project===project.identity&&e.head===commit&&(e.run!==run.id||e.item!==run.item)))
          throw Error('claimed delivered range lacks guarded or proven legacy dispatch/run/claim evidence');
        kinds.add(receipt.source?'guarded':'legacy-proven');
        row.landings.push(receipt.seq);
      }
      row.status='covered';row.coverage=kinds.size===1?[...kinds][0]:'mixed';
    }catch(error){row.reason=error.message;}
  }
  // Every explicit commit claim must be in the proven ranges, even when an
  // author also supplies a source/base artifact. An omitted claim stays visible.
  for(const token of tokens)if(!result.ranges.some(r=>r.head.startsWith(token))&&!ranges.some(r=>r.head===token)){
    const extra=deliveredSourceProof({project,org,run,events,git,identify,state,artifacts:[`Commit: ${token}`]});
    result.ranges.push(...extra.ranges);
  }
  result.status=result.ranges.some(r=>r.status==='external')?'external':result.ranges.every(r=>r.status==='covered')?'covered':'unknown';
  if(result.status==='covered'){
    const kinds=new Set(result.ranges.map(r=>r.coverage));result.coverage=kinds.size===1?[...kinds][0]:'mixed';
  }
  return result;
}
