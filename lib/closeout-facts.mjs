// Effect-specific facts. Report prose is never native execution evidence.
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const ownsCloseoutFact=(entry,e)=>e.identity===entry.common&&e.key===entry.key&&same(e.source,entry.source);
const retryable=new Set(['contention','active-process','dirty-work','pre-effect-budget','pre-effect-change']);

export function closeoutCondition(entry,outcome,events,{uncertain=false}={}) {
  const reason=outcome.reason??'',failure=outcome.failure;
  let kind='owner-evidence-required',resources=['session','folder','branch'];
  if(failure?.kind==='fence')kind='native-refusal';
  else if(uncertain)kind='uncertain-invocation';
  else if(/original native refusal|EPERM|EACCES|native refusal|permission denied|operation not permitted/i.test(reason))kind='legacy-refusal';
  else if(/original native session identity missing/.test(reason))kind='missing-identity';
  else if(/STOP|HOLD|ownership|claim|source binding|generation|identity|preservation|evidence.*changed|archive.*changed/i.test(reason))kind='safety-hold';
  else if(/^locked:|locked Git metadata|worktree is locked/.test(reason))kind='contention';
  else if(/worktree is not clean|assume-unchanged|skip-worktree/.test(reason)){kind='dirty-work';resources=['folder','branch'];}
  else if(/process cwd reference |settle callback reference |watcher callback reference |another process remains|occupant .* is (working|running|busy|blocked)|open run|reference |operator focus|this tab/.test(reason))kind='active-process';
  else if(/retirement deadline reached|removal needs .*pass has/.test(reason))kind='pre-effect-budget';
  else if(/^removal preflight input changed:/.test(reason))kind='pre-effect-change';
  const original=events.find(e=>e.type==='closeout.evaluated'&&ownsCloseoutFact(entry,e)&&!e.completed&&
    (e.condition?.kind===kind||!e.condition&&e.reason===reason));
  return{schema:'closeout-condition/v1',kind,resources,reason,owner:retryable.has(kind)?'lane-closeout':entry.run,
    evidence:{source:entry.source,...(original?{evaluation:original.seq}:{}),...(failure?{failure}:{}),...(outcome.observation_error?{observation_error:outcome.observation_error}:{})},
    first_seen:original?.condition?.first_seen??original?.at??events.find(e=>e.seq===entry.source.seq)?.at,
    continuation:retryable.has(kind)?{kind:'pre-effect-observation',owner:'lane-closeout',guards:'fresh original source/allocation/native/Git/STOP/HOLD/preservation'}:
      {kind:'owner-evidence',owner:entry.run,reason:kind==='uncertain-invocation'?'original exact producer completion or admitted never-started proof required':'original owner must supply admissible evidence'},
    escalation:{owner:'project-supervisor',turns:3,age_ms:1800000,authority:'visibility only'}};
}

export function preEffectCloseout(entry,prior,events,{uncertain=false}={}) {
  if(!prior||prior.completed||uncertain)return false;
  // Historical holds remain immutable. Only named ordinary pre-effect reasons
  // can acquire a new observation, including old generic UNKNOWN labels.
  const fact=prior.condition??closeoutCondition(entry,prior,events);
  return retryable.has(fact.kind)&&fact.continuation.kind==='pre-effect-observation';
}

export function recordedCloseoutRefusal(entry,events,resource) {
  return events.find(e=>ownsCloseoutFact(entry,e)&&
    (e.type==='closeout.command-failed'&&e.failure?.kind==='fence'||
     e.type==='closeout.evaluated'&&(e.failure?.kind==='fence'||['native-refusal','legacy-refusal'].includes(e.condition?.kind)||
       !e.condition&&/original native refusal/.test(e.reason??'')))&&
    (!resource||!e.condition?.resources||e.condition.resources.includes(resource)));
}

export function closeoutResources(entry,events,condition) {
  const rows=events.filter(e=>e.type==='closeout.effect'&&ownsCloseoutFact(entry,e));
  const last=action=>rows.findLast(e=>e.outcome?.action===action),receipt=e=>e&&{seq:e.seq,effect:e.effect};
  const closed=entry.panes.length>0&&entry.panes.every(p=>rows.some(e=>e.outcome.action==='closed'&&
    (e.outcome.sessions??[e.outcome]).some(s=>s.run===(p.run??entry.run)&&s.session===p.session))||
    rows.some(e=>e.outcome.action==='shell-close-requested'&&e.outcome.panes?.some(b=>b.pane===p.pane&&b.terminal===p.terminal)&&
      rows.some(c=>c.outcome.action==='closed'&&c.outcome.tab_id===e.outcome.tab_id)));
  const absent=entry.panes.length>0&&entry.panes.every(p=>rows.some(e=>e.outcome.action==='allocation-absent'&&e.outcome.pane===p.pane&&e.outcome.terminal===p.terminal&&e.outcome.session===p.session));
  const folder=last('worktree-removed'),branch=last('branch-removed'),kept=last('branch-kept'),packet=last('report-evidence');
  const keep=resource=>({status:'kept',scope:{resource,key:entry.key,source:entry.source,run:entry.run,cwd:entry.cwd},reason:condition?.reason??'no effect receipt',owner:condition?.owner??entry.run,
    continuation:condition?.continuation??{kind:'owner-evidence',owner:entry.run},evidence:{source:entry.source},first_seen:condition?.first_seen,escalation:condition?.escalation});
  return{session:closed?{status:'closed',receipts:rows.filter(e=>e.outcome.action==='closed').map(receipt)}:
      absent?{status:'absent',receipts:rows.filter(e=>e.outcome.action==='allocation-absent').map(receipt)}:
      {...keep('session'),...(!entry.panes.length?{reason:'original native identity missing; no empty-target completion'}:{})},
    folder:folder?{status:'removed',receipt:receipt(folder)}:keep('folder'),
    branch:branch?{status:'deleted',receipt:receipt(branch)}:kept?{status:'retained',ref:entry.branch,head:entry.head,receipt:receipt(kept)}:
      {...keep('branch'),ref:entry.branch,head:entry.head},
    author_packet:packet?{status:'preserved',receipt:receipt(packet),packet:packet.outcome.packet,sha256:packet.outcome.sha256}:{status:'unproven'}};
}
